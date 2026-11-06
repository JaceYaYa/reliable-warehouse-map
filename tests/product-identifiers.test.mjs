import {readBackupJson} from './helpers/r2-memory.mjs';
import {memoryR2} from './helpers/r2-memory.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import * as XLSX from 'xlsx';
import {warehouseApiHarness} from './helpers/warehouse-api-harness.mjs';
import {parseInboundMessage,applyMessageReference} from '../lib/inbound-message.ts';
import {searchWarehouseRecords} from '../lib/warehouse-search.ts';
const receipt=(patch={})=>({locationCode:'A1',inboundDate:'2026-09-01',product:'救援器',customerName:'客户甲',sku:'000-SKU',fnsku:'X00FNSKU',barcode:'000123',totalQuantity:10,totalBoxes:2,layerCount:1,inboundSource:'return',billingMode:'item',itemVolumeM3:0.01,storageRateUsd:0.7,freeDays:0,...patch});
const ids=row=>[row.sku,row.fnsku,row.barcode];
const authHeaders={cookie:'wms_session=test-token-1'};
const dbRow=(h,id)=>h.sqlite.prepare('SELECT * FROM stocks WHERE id=?').get(id);
async function add(h,patch={}){const r=await h.call('stocks','POST',receipt(patch));assert.equal(r.status,200,JSON.stringify(r.data));return r.data.stock;}
test('identifier migration keeps existing inventory, catalog and barcode data unchanged',()=>{
 const db=new DatabaseSync(':memory:');try{
  for(const e of JSON.parse(readFileSync('drizzle/meta/_journal.json','utf8')).entries.filter(e=>e.idx<14))db.exec(readFileSync(`drizzle/${e.tag}.sql`,'utf8'));
  db.exec("INSERT INTO stocks(location_code,inbound_date,product,barcode,total_quantity,updated_at) VALUES ('A1','2026-09-01','原货物','000123',27,'original')");
  const before=db.prepare('SELECT * FROM stocks').get();db.exec(readFileSync('drizzle/0014_stock_product_identifiers.sql','utf8'));
  const {sku,fnsku,...after}=db.prepare('SELECT * FROM stocks').get();assert.equal(sku,'');assert.equal(fnsku,'');assert.deepEqual(after,{...before});
 }finally{db.close()}
});
test('stock writes keep independent textual identifiers and support explicit clearing without changing pricing',async()=>{
 const h=warehouseApiHarness();try{h.seedUser(1,null,'admin','boss');const row=await add(h);assert.deepEqual(ids(row),['000-SKU','X00FNSKU','000123']);
  let r=await h.call('stocks','POST',{id:row.id,sku:''});assert.equal(r.status,409);const ctx=(await h.call('goods')).data,c=ctx.choices.find(c=>c.members.some(m=>m.id===row.id));r=await h.call('goods/identity','POST',{requestId:crypto.randomUUID(),expectedRevision:ctx.revision,stockId:row.id,version:0,sourceKey:c.key,members:c.members.map(m=>({id:m.id,version:m.version})),scope:'all',identity:{product:c.product,customerName:c.customerName,sku:''},confirmed:true});assert.equal(r.status,200,JSON.stringify(r.data));r=await h.call('stocks');r.data.stock=r.data.stocks.find(s=>s.id===row.id);assert.deepEqual(ids(r.data.stock),['','X00FNSKU','000123']);assert.equal(r.data.stock.storageRateUsd,0.7);
  r=await h.call('stocks','POST',{id:row.id,fnsku:'FNSKU-2'});assert.equal(r.status,200);assert.deepEqual(ids(r.data.stock),['','FNSKU-2','000123']);
  const snapshot=JSON.parse(h.sqlite.prepare("SELECT after_snapshot FROM audit_logs WHERE action='库存修改' ORDER BY id DESC LIMIT 1").get().after_snapshot);assert.equal(snapshot.fnsku,'FNSKU-2');
 }finally{h.sqlite.close()}
});
test('partial move, move undo, outbound and outbound undo retain SKU and FNSKU',async()=>{
 const h=warehouseApiHarness();try{h.seedUser(1,null,'admin','boss');h.setting('warehouse_zones',[{id:'NEW_A',title:'A区',codes:['A1','A2'],locationCodesVersion:1,layoutVersion:8,layout:{},features:[]}]);const row=await add(h);
  let r=await h.call('stocks/move','POST',{id:row.id,expectedVersion:0,targetLocation:'A2',mode:'partial',quantity:3,boxes:1,targetLayerCount:2,sourceRemainingLayerCount:1});assert.equal(r.status,200,JSON.stringify(r.data));
  for(const stock of h.sqlite.prepare('SELECT * FROM stocks').all())assert.deepEqual(ids(stock),ids(row));
  let log=h.sqlite.prepare("SELECT id,after_snapshot FROM audit_logs WHERE action='移库' ORDER BY id DESC LIMIT 1").get();for(const stock of JSON.parse(log.after_snapshot).rows)assert.deepEqual(ids(stock),ids(row));
  r=await h.call('movements','POST',{id:log.id});assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(h.sqlite.prepare('SELECT count(*) n FROM stocks').get().n,1);assert.deepEqual(ids(dbRow(h,row.id)),ids(row));
  r=await h.call('stocks','PATCH',{id:row.id,quantity:4,boxes:1,outboundAt:'2026-09-10'});assert.equal(r.status,200,JSON.stringify(r.data));assert.deepEqual(ids(r.data.settlement),ids(row));
  log=h.sqlite.prepare("SELECT id FROM audit_logs WHERE action='出库' ORDER BY id DESC LIMIT 1").get();r=await h.call('movements','POST',{id:log.id});assert.equal(r.status,200,JSON.stringify(r.data));assert.deepEqual(ids(dbRow(h,row.id)),ids(row));assert.equal(dbRow(h,row.id).total_quantity,10);
 }finally{h.sqlite.close()}
});
test('catalog identifiers fill new receipts and incompatible SKUs cannot bind through the same barcode',async()=>{
 const h=warehouseApiHarness();try{h.seedUser(1,null,'admin','boss');let r=await h.call('pricing/catalog','POST',{product:'救援器',customerName:'客户甲',sku:'CAT-1',fnsku:'FNSKU-CAT',barcode:'000123'});assert.equal(r.status,200);const catalog=r.data.item;
  const row=await add(h,{catalogItemId:catalog.id,sku:undefined,fnsku:undefined});assert.deepEqual(ids(row),['CAT-1','FNSKU-CAT','000123']);
  const other=await add(h,{sku:'OTHER'});r=await h.call('stocks','POST',{id:other.id,catalogItemId:catalog.id});assert.equal(r.status,409);assert.equal(dbRow(h,other.id).catalog_item_id,null);
  r=await h.call('pricing/catalog?q=FNSKU-CAT');assert.equal(r.data.items.length,1);
 }finally{h.sqlite.close()}
});
test('monthly Excel keeps SKU product and barcode columns without duplicate FNSKU and preserves text codes and pricing formulas',async()=>{
 const h=warehouseApiHarness();try{h.seedUser(1,null,'admin','boss');const row=await add(h,{sku:'0000123'});let r=await h.call('stocks','PATCH',{id:row.id,quantity:3,boxes:1,outboundAt:'2026-09-10'});assert.equal(r.status,200);h.sqlite.exec("UPDATE storage_fee_settlements SET settlement_status='settled'");
  r=await h.call('pricing/report?fromMonth=2026-09&toMonth=2026-09&customer='+encodeURIComponent('客户甲'));assert.equal(r.status,200);for(const item of [...r.data.inStockItems,...r.data.outboundItems]){assert.deepEqual(ids(item),['0000123','X00FNSKU','000123'])}
  const endpoint=h.load(resolve('app/api/pricing/report/export/route.ts'));const response=await endpoint.GET(new Request('http://local.test/api/pricing/report/export?fromMonth=2026-09&toMonth=2026-09&customer='+encodeURIComponent('客户甲'),{headers:authHeaders}));assert.equal(response.status,200);
  const wb=XLSX.read(await response.arrayBuffer(),{type:'array',cellFormula:true});const sheet=wb.Sheets['客户账单明细'],data=XLSX.utils.sheet_to_json(sheet,{header:1});const header=data[4];const start=header.indexOf('SKU');assert.deepEqual(header.slice(start,start+3),['SKU','产品名称','条形码']);assert.equal(data[5][start],'0000123');assert.equal(sheet[XLSX.utils.encode_cell({r:5,c:start})].t,'s');assert.equal(data[5][start+2],'000123');assert.equal(header.includes('FNSKU'),false);
  const totalVolume=XLSX.utils.encode_cell({r:5,c:header.indexOf('总体积m³')});assert.ok(sheet[totalVolume].f);assert.equal(data.length,8);assert.equal(data.at(-1)[0],'合计');
 }finally{h.sqlite.close()}
});
test('new and legacy backups round-trip independent identifiers without inventing FNSKU from barcodes',async()=>{
 const objects=new Map(),bucket=memoryR2(objects);const h=warehouseApiHarness({BACKUPS:bucket});try{h.seedUser(1,null,'admin','boss');await add(h);await h.call('pricing/catalog','POST',{product:'目录',sku:'CAT',fnsku:'F-CAT',barcode:'BC'});await h.call('stocks','PATCH',{id:1,quantity:2,boxes:1,outboundAt:'2026-09-10'});
  const r=await h.call('backups','POST',{});const backup=readBackupJson(objects.get(r.data.key));const session=h.sqlite.prepare('SELECT * FROM sessions').get();
  const restore=async data=>{const form=new FormData();form.set('file',new File([JSON.stringify(data)],'backup.json',{type:'application/json'}));form.set('confirm','恢复备份');const response=await h.load(resolve('app/api/backups/route.ts')).PUT(new Request('http://local.test/api/backups',{method:'PUT',headers:authHeaders,body:form}));assert.equal(response.status,200,await response.text())};
  await restore(backup);assert.deepEqual(ids(h.sqlite.prepare('SELECT * FROM stocks').get()),['000-SKU','X00FNSKU','000123']);assert.equal(h.sqlite.prepare('SELECT fnsku FROM storage_fee_settlements').get().fnsku,'X00FNSKU');assert.equal(h.sqlite.prepare('SELECT fnsku FROM pricing_catalog_items').get().fnsku,'F-CAT');
  h.sqlite.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)').run(session.token_hash,session.user_id,session.expires_at,session.created_at);
  for(const x of [...backup.stocks,...backup.storageFeeSettlements]){delete x.sku;delete x.fnsku}for(const x of backup.pricingCatalogItems)delete x.fnsku;await restore(backup);assert.deepEqual(ids(h.sqlite.prepare('SELECT * FROM stocks').get()),['','','000123']);
 }finally{h.sqlite.close()}
});
test('message parsing keeps barcode and SKU while batch import distinguishes different SKUs',async()=>{
 const parsed=parseInboundMessage('产品：救援器\nSKU: 000-SKU\nFNSKU: X00FNSKU\n条码: 000123\n10件 2箱\n位于：A1一层',{locations:['A1'],stocks:[],inboundDate:'2026-09-01'});assert.equal(parsed.items.length,1);assert.deepEqual(ids(parsed.items[0].draft),['000-SKU','','000123']);
 assert.equal(searchWarehouseRecords([receipt()], 'X00FNSKU').length,1);assert.equal(searchWarehouseRecords([receipt()], '000-SKU').length,1);
 const h=warehouseApiHarness();try{h.seedUser(1,null,'admin','boss');for(const sku of ['FIRST','SECOND']){const r=await h.call('stocks/import','POST',{records:[receipt({sku})]});assert.equal(r.status,200)}assert.equal(h.sqlite.prepare('SELECT count(*) n FROM stocks').get().n,2);}finally{h.sqlite.close()}
});
test('changing a message reference changes inherited identifiers while preserving explicitly supplied codes',()=>{
 const options={locations:['A1'],stocks:[],inboundDate:'2026-09-01'};
 const item=parseInboundMessage('产品：救援器\n10件2箱\n位于：A1一层',options).items[0];
 const first=applyMessageReference(item,receipt({sku:'FIRST',fnsku:'F-FIRST'}));
 const second=applyMessageReference(first,receipt({sku:'SECOND',fnsku:'F-SECOND'}));assert.equal(second.draft.sku,'SECOND');assert.equal(second.draft.fnsku,'');
 const explicit=parseInboundMessage('SKU: ONLY-SKU\nFNSKU: F-EXPLICIT\n条码: 000999\n10件2箱\n位于：A1一层',options).items[0];assert.ok(explicit);assert.equal(explicit.draft.product,'ONLY-SKU');assert.deepEqual(ids(applyMessageReference(explicit,receipt()).draft),['ONLY-SKU','','000999']);
});

test('FNSKU messages and imports use product barcode, and explicit barcode wins conflicts',async()=>{
 const options={locations:['A1'],stocks:[],inboundDate:'2026-09-01'};
 for(const text of ['产品：救援器\nFNSKU: X00001\n10件\n位于：A1一层','产品：救援器\n10件\nFNSKU: X00001\n位于：A1一层']){
  const item=parseInboundMessage(text,options).items[0];assert.equal(item.draft.barcode,'X00001');assert.equal(item.draft.fnsku,'');
 }
 for(const lines of ['FNSKU: X00001\n条码: 000123','条码: 000123\nFNSKU: X00001']){
  const item=parseInboundMessage('产品：救援器\n'+lines+'\n10件\n位于：A1一层',options).items[0];assert.equal(item.draft.barcode,'000123');assert.ok(item.warnings.some(x=>x.includes('不一致')));
 }
 const {normalizeCatalogInput}=await import('../lib/pricing.ts');const {prepareCatalogRow}=await import('../lib/pricing-workbook.ts');
 assert.equal(normalizeCatalogInput({SKU:'SKU1',FNSKU:'000XYZ'}).barcode,'000XYZ');
 assert.equal(normalizeCatalogInput({barcode:'000123',FNSKU:'000XYZ'}).barcode,'000123');
 const omp=prepareCatalogRow({'Product Name/产品名称':'货物','SKU':'SKU1','FNSKU':'000XYZ','OMS Length/OMS长':1},0.7);assert.equal(omp.barcode,'000XYZ');
 const h=warehouseApiHarness();try{h.seedUser(1,null,'admin','boss');let r=await h.call('stocks/import','POST',{records:[receipt({barcode:undefined,fnsku:'X00001'})]});assert.equal(r.status,200);const row=dbRow(h,1);assert.equal(row.barcode,'X00001');assert.equal(row.fnsku,'');
  r=await h.call('stocks/import','POST',{records:[receipt({barcode:'X00001',fnsku:undefined})]});assert.equal(r.status,200);assert.equal(r.data.imported,0);assert.equal(h.sqlite.prepare('SELECT count(*) n FROM stocks').get().n,1);
 }finally{h.sqlite.close()}
});
