import {readBackupJson} from './helpers/r2-memory.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {warehouseApiHarness} from './helpers/warehouse-api-harness.mjs';
import {memoryR2} from './helpers/r2-memory.mjs';

const source={id:'stock:1',kind:'stock',locationCode:'A1',layer:1,customerName:'甲',inboundDate:'2026-08-01',productName:'货',sku:'S',physicalQuantity:100,physicalBoxes:0};
function report(current,intervals,shipments=[],toDate='2026-09-09'){
 const h=warehouseApiHarness({layerPricing:true});
 try{
  const d=h.load('lib/layer-storage.ts'),config=d.emptyLayerPricingConfig();
  return h.load('lib/layer-storage-report.ts').buildLayerStorageReport({settings:{config,zones:[],aliases:{},occupied:d.groupLayerOccupancy(current,config,[])},settingsRows:[{key:'pricing_defaults',value:JSON.stringify({defaultRatePerM3Day:1,defaultFreeDays:0})}],history:{intervals,issues:[],coverageStart:null,checkpointAt:null},confirmedSettlements:[],outboundHistory:shipments,fromDate:'2026-09-01',toDate,asOf:'2026-10-01'});
 }finally{h.sqlite.close();}
}
const manualShipment={key:'goods:o:1',physicalId:'stock:1',billingFactsManual:true,customerName:'甲',originalCustomerName:'甲',originalInboundDate:'2026-08-01',originalOutboundDate:'2026-09-20',locationCode:'A2',layer:1,inboundDate:'2026-08-01',outboundDate:'2026-09-20',quantity:40,boxes:0,product:'货',sku:'S'};
test('V132 independent review: missing historical pallets are filled once before manual source partition',()=>{
 const r=report([{...source,physicalQuantity:60,palletCount:.6}],[{startDate:'2026-09-01',endDateExclusive:'2026-09-10',occupants:[source],issues:[],evidenceIds:['checkpoint']}],[manualShipment]);
 assert.equal(r.totals.verifiedFeeUsd,10.8);
 assert.ok(Math.abs(r.rows.reduce((n,row)=>n+row.palletCount,0)-.6)<1e-10);
 assert.ok(r.rows.every(row=>row.estimatedPallets));
});
test('V132 independent review: current volume summary equals its batch pallet volumes',()=>{
 const r=report([{...source,palletCount:.25}],[]);
 assert.equal(r.current.volumeM3,r.current.rows.reduce((n,row)=>n+row.sharedVolumeM3,0));
 assert.equal(r.current.volumeM3,.5);
});
test('V132 independent review: manual date extension retains inferred source pallet portion',()=>{
 const original={...source,palletCount:1},current={...source,physicalQuantity:60,palletCount:.6};
 const r=report([current],[{startDate:'2026-09-01',endDateExclusive:'2026-09-10',occupants:[original],issues:[],evidenceIds:['checkpoint']},{startDate:'2026-09-10',endDateExclusive:'2026-10-01',occupants:[current],issues:[],evidenceIds:['outbound']}],[{...manualShipment,originalOutboundDate:'2026-09-10'}],'2026-09-19');
 assert.equal(r.totals.verifiedFeeUsd,38);
 assert.ok(r.rows.filter(row=>row.locationCode==='A2').every(row=>row.palletCount===.4));
});
test('V132 independent review: same-day split and outbound derive manual pallet fraction from the preceding parent snapshot',()=>{
 const h=warehouseApiHarness();
 try{
  const rows=h.load('lib/layer-pallet-portions.ts').stableManualPallets([{...manualShipment,physicalId:'stock:2',originalOutboundDate:'2026-09-10'}],[{startDate:'2026-09-01',endDateExclusive:'2026-09-10',occupants:[{...source,palletCount:1}]}],[{...source,physicalQuantity:60,palletCount:.6}],{},undefined,[{childId:'stock:2',parentId:'stock:1',day:'2026-09-10'}]);
  assert.equal(rows[0].palletCount,.4);
 }finally{h.sqlite.close();}
});
test('V132 independent review: partial staging explicit zero pallets cannot create billable pallets',async()=>{
 const h=warehouseApiHarness({layerPricing:true});
 try{
  h.seedUser(1,null,'admin','boss');
  h.setting('warehouse_zones',[{id:'A',title:'A区',codes:['A1','B1','待出库'],locationCodesVersion:1}]);
  h.setting('pricing_layer_storage_v1',{schemaVersion:1,revision:0,locations:{A1:{defaultVolumeM3:1,layers:{}},B1:{defaultVolumeM3:3,layers:{}},'待出库':{defaultVolumeM3:.1,layers:{}}}});
  h.setting('pricing_defaults',{defaultRatePerM3Day:.5,defaultFreeDays:0});
  const ids=[h.stock('A1'),h.stock('B1')];
  h.sqlite.exec("UPDATE stocks SET product='货物',customer_name='甲',sku='SAME',inbound_date='2026-07-01',total_quantity=10,total_boxes=0");
  const context=(await h.call('goods')).data,choice=context.choices.find(c=>c.members.some(r=>r.id===ids[0]));
  const staged=await h.call('goods/staging','POST',{requestId:crypto.randomUUID(),expectedRevision:context.revision,targetLocation:'待出库',targetLayerCount:1,lines:[{lineId:'order1',key:choice.key,outboundOrder:'OUT1',quantity:8,boxes:0,selected:ids.map(id=>({id,version:0,quantity:4,boxes:0,pallets:0}))}]});
  assert.equal(staged.status,200,JSON.stringify(staged.data));
  const r=await h.call('pricing/layers/report?customer=甲');
  assert.equal(r.status,200,JSON.stringify(r.data));
  assert.equal(r.data.current.volumeM3,4);
  assert.equal(r.data.current.dailyFeeUsd,2);
  assert.ok(r.data.current.rows.filter(row=>row.physicalLocations.some(p=>p.staged)).every(row=>row.palletCount===0));
  const log=h.sqlite.prepare("SELECT id FROM audit_logs WHERE entity_type='待出库' ORDER BY id DESC").get();
  assert.equal((await h.call('movements','POST',{id:log.id})).status,200);
  const restored=await h.call('pricing/layers/report?customer=甲');
  assert.equal(restored.data.current.volumeM3,4);
 }finally{h.sqlite.close();}
});
test('V132 independent review: partial stock shipment retains untouched automatic peer half without writing its raw row',async()=>{
 const h=warehouseApiHarness({layerPricing:true});
 try{
  h.seedUser(1,null,'admin','boss');h.setting('warehouse_zones',[{id:'A',title:'A',codes:['A1','A2']}]);
  const ids=[h.stock(),h.stock()];h.sqlite.exec("UPDATE stocks SET customer_name='甲',sku='X'");
  const peer=h.sqlite.prepare('SELECT * FROM stocks WHERE id=?').get(ids[1]),list=(await h.call('goods')).data,c=list.choices[0];
  const r=await h.call('goods/outbound','POST',{requestId:crypto.randomUUID(),key:c.key,expectedRevision:list.revision,members:c.members.map(row=>({id:row.id,version:row.version})),quantity:2,boxes:0,outboundDate:'2026-10-01',selected:[{id:ids[0],version:0,quantity:2,boxes:0,pallets:.25}]});
  assert.equal(r.status,200,JSON.stringify(r.data));
  const rows=(await h.call('stocks')).data.stocks;
  assert.equal(rows.find(row=>row.id===ids[0]).palletCount,.25);
  assert.equal(rows.find(row=>row.id===ids[1]).palletCount,.5);
  assert.deepEqual(h.sqlite.prepare('SELECT * FROM stocks WHERE id=?').get(ids[1]),peer);
  const report=(await h.call('pricing/layers/report?customer=甲')).data;
  assert.equal(report.current.volumeM3,1.5);
 }finally{h.sqlite.close();}
});
test('V132 independent review: partial carton shipment retains untouched automatic peer half without writing its raw receipt',async()=>{
 const h=warehouseApiHarness({layerPricing:true});
 try{
  h.seedUser(1,null,'admin','boss');h.setting('warehouse_zones',[{id:'A',title:'A',codes:['A1','A2']}]);
  const ids=[crypto.randomUUID(),crypto.randomUUID()];
  for(const id of ids)assert.equal((await h.call('cartons','POST',{requestId:id,inboundOrder:'同名货',inboundDate:'2026-09-01',customerName:'甲',placements:[{key:'p',locationCode:'A1',layerCount:1,boxes:10}]})).status,200);
  const peer=h.sqlite.prepare('SELECT * FROM carton_receipts WHERE id=?').get(ids[1]);
  const r=await h.call('cartons/outbound','POST',{requestId:crypto.randomUUID(),id:ids[0],expectedVersion:0,outboundDate:'2026-10-01',picks:[{key:'p',boxes:2,pallets:.25}]});
  assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.data.pallets,.25);
  const rows=(await h.call('cartons')).data.receipts;
  assert.equal(rows.find(row=>row.id===ids[0]).placements[0].palletCount,.25);
  assert.equal(rows.find(row=>row.id===ids[1]).placements[0].palletCount,.5);
  assert.deepEqual(h.sqlite.prepare('SELECT * FROM carton_receipts WHERE id=?').get(ids[1]),peer);
  const report=(await h.call('pricing/layers/report?customer=甲')).data;
  assert.equal(report.current.volumeM3,1.5);
 }finally{h.sqlite.close();}
});
async function cartonFixture(extra={}){
 const h=warehouseApiHarness({layerPricing:true,...extra});h.seedUser(1,null,'admin','boss');
 h.setting('warehouse_zones',[{id:'A',title:'A',codes:['A1','A2']}]);
 const ids=[crypto.randomUUID(),crypto.randomUUID()];
 for(const id of ids)assert.equal((await h.call('cartons','POST',{requestId:id,inboundOrder:'同款',customerName:'甲',inboundDate:'2026-09-01',placements:[{key:'p',locationCode:'A1',layerCount:1,boxes:10}]})).status,200);
 return {h,ids};
}
test('V132 independent review: cross-receipt carton document keeps original shares, replay and exact raw child restores',async()=>{
 const {h,ids}=await cartonFixture();
 try{
  const raw=()=>h.sqlite.prepare('SELECT id,placements FROM carton_receipts ORDER BY id').all(),before=raw(),c=(await h.call('goods')).data;
  const payload={requestId:crypto.randomUUID(),mode:'outbound',expectedRevision:c.revision,outboundDate:'2026-10-01',lines:ids.map(receiptId=>({kind:'carton',receiptId,expectedVersion:0,quantity:0,boxes:2,customerName:'甲',picks:[{key:'p',boxes:2,pallets:.25}]}))};
  const r=await h.call('goods/document','POST',payload);
  assert.equal(r.status,200,JSON.stringify(r.data));assert.deepEqual(r.data.lines.map(line=>line.pallets),[.25,.25]);
  assert.deepEqual((await h.call('goods/document','POST',payload)).data,r.data);
  for(const line of r.data.lines){const undo=await h.call('cartons/restore','POST',{requestId:crypto.randomUUID(),operationId:line.operationId,expectedVersion:1});assert.equal(undo.status,200,JSON.stringify(undo.data));}
  assert.deepEqual(raw(),before);
 }finally{h.sqlite.close();}
});
test('V132 independent review: carton document rejects an unselected automatic peer change before any write',async()=>{
 const {h,ids}=await cartonFixture();
 try{
  const before=h.sqlite.prepare('SELECT * FROM carton_receipts WHERE id=?').get(ids[0]),c=(await h.call('goods')).data;
  const logs=h.sqlite.prepare('SELECT count(*) n FROM audit_logs').get().n;
  const prepare=h.adapter.prepare;
  h.adapter.prepare=sql=>{if(sql.startsWith('INSERT INTO carton_transaction_guards'))h.adapter.beforeBatch=()=>h.sqlite.prepare('UPDATE carton_receipts SET customer_name=? WHERE id=?').run('peer changed',ids[1]);return prepare(sql);};
  const r=await h.call('goods/document','POST',{requestId:crypto.randomUUID(),mode:'outbound',expectedRevision:c.revision,outboundDate:'2026-10-01',lines:[{kind:'carton',receiptId:ids[0],expectedVersion:0,quantity:0,boxes:2,customerName:'甲',picks:[{key:'p',boxes:2,pallets:.25}]}]});
  assert.equal(r.status,409,JSON.stringify(r.data));
  assert.deepEqual(h.sqlite.prepare('SELECT * FROM carton_receipts WHERE id=?').get(ids[0]),before);
  assert.equal(h.sqlite.prepare('SELECT count(*) n FROM audit_logs').get().n,logs);
 }finally{h.sqlite.close();}
});
test('V132 independent review: effective carton backup restores exact raw ledgers and retains automatic undo',async()=>{
 const objects=new Map(),{h,ids}=await cartonFixture({BACKUPS:memoryR2(objects)});
 try{
  const operationId=crypto.randomUUID();
  assert.equal((await h.call('cartons/outbound','POST',{requestId:operationId,id:ids[0],expectedVersion:0,outboundDate:'2026-10-01',picks:[{key:'p',boxes:2,pallets:.25}]})).status,200);
  const snapshot=()=>JSON.stringify(['carton_receipts','carton_operations'].map(table=>h.sqlite.prepare(`SELECT * FROM ${table} ORDER BY id`).all())),before=snapshot();
  const saved=await h.call('backups','POST',{});assert.equal(saved.status,200,JSON.stringify(saved.data));
  const data=readBackupJson(objects.get(saved.data.key)),form=new FormData();form.append('file',new File([JSON.stringify(data)],'backup.json'));form.append('confirm','恢复备份');
  h.sqlite.exec("UPDATE carton_receipts SET placements='[]'");
  const restored=await h.load('app/api/backups/route.ts').PUT(new Request('http://local.test/api/backups',{method:'PUT',headers:{cookie:'wms_session=test-token-1'},body:form}));
  assert.equal(restored.status,200,await restored.text());assert.equal(snapshot(),before);
  h.sqlite.prepare("INSERT OR IGNORE INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,1,'2099-01-01','now')").run(createHash('sha256').update('test-token-1').digest('hex'));
  const undo=await h.call('cartons/restore','POST',{requestId:crypto.randomUUID(),operationId,expectedVersion:1});
  assert.equal(undo.status,200,JSON.stringify(undo.data));assert.deepEqual((await h.call('cartons')).data.receipts.map(row=>row.placements[0].palletCount),[.5,.5]);
 }finally{h.sqlite.close();}
});
test('V132 independent review: real partial move audit freezes allocated pallet portions for prospective history',async()=>{
 const h=warehouseApiHarness({layerPricing:true});
 try{
  h.seedUser(1,null,'admin','boss');h.setting('warehouse_zones',[{id:'A',title:'A',codes:['A1','A2']}]);h.setting('pricing_defaults',{defaultRatePerM3Day:.5,defaultFreeDays:0});
  const id=h.stock();h.sqlite.exec("UPDATE stocks SET customer_name='甲'");
  const stocks=await h.load('db/index.ts').getDb().select().from(h.load('db/schema.ts').stocks);
  h.sqlite.prepare('UPDATE layer_storage_checkpoints SET captured_at=?,value=?,audit_high_id=0 WHERE id=1').run('2026-08-31T12:00:00Z',JSON.stringify({schemaVersion:1,stocks,cartons:[]}));
  const moved=await h.call('stocks/move','POST',{id,expectedVersion:0,targetLocation:'A2',mode:'partial',quantity:5,boxes:1,pallets:.5,sourceRemainingLayerCount:1,targetLayerCount:1});
  assert.equal(moved.status,200,JSON.stringify(moved.data));
  h.sqlite.exec("UPDATE audit_logs SET created_at='2026-09-06T12:00:00Z' WHERE action='移库'");
  const rows=JSON.parse(h.sqlite.prepare("SELECT after_snapshot FROM audit_logs WHERE action='移库'").get().after_snapshot).rows;
  assert.ok(rows.every(row=>row.palletCount===.5&&row.palletManual===true&&row.palletAutomatic!==true),'physical split must record fixed half pallets, independent of the source automatic mode');
  const report=(await h.call('pricing/layers/report?fromMonth=2026-09&toMonth=2026-09&asOf=2026-10-01')).data;
  assert.equal(report.totals.verifiedFeeUsd,30,'5 days at one pallet + 25 days at two half pallets, each 2m3 * $.5/day');
 }finally{h.sqlite.close();}
});
