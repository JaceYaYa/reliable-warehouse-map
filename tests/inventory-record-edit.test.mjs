import {memoryR2} from './helpers/r2-memory.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {warehouseApiHarness} from './helpers/warehouse-api-harness.mjs';
import {createHash} from 'node:crypto';
const plain=x=>JSON.parse(JSON.stringify(x));
const row=(id,patch={})=>({id,version:0,product:'#1-2 黑色充电款加热饭盒',customerName:'天华',locationCode:'旧A41',inboundDate:'2026-05-15',totalQuantity:10,totalBoxes:2,layerCount:1,...patch});
function setup(){const h=warehouseApiHarness();h.seedUser(1,null,'admin','boss');h.seedUser(2,[]);return h}

test('number ranges associate by product body while colours, models and customers stay separate',()=>{
 const h=setup();try{const {groupInventory,filterInventory}=h.load('lib/inventory-groups.ts');const input=['#1-2','#3-4','#5-9','#11-12'].map((p,i)=>row(i+1,{product:p+' 黑色充电款加热饭盒',inboundDate:`2026-05-${15+i}`}));const before=structuredClone(input),g=groupInventory(input);
 assert.equal(g.length,1);assert.equal(g[0].quantity,40);assert.equal(g[0].boxes,8);assert.equal(g[0].members.length,4);assert.equal(g[0].product,'黑色充电款加热饭盒');assert.deepEqual(plain(g[0].members.map(m=>m.prefix)),['#1-2','#3-4','#5-9','#11-12']);assert.deepEqual(input,before);assert.equal(filterInventory(g,'product','','#11-12').length,1);
 assert.equal(groupInventory([...input,row(5,{product:'白色充电款加热饭盒'}),row(6,{customerName:'其他客户'}),row(7,{product:'iPhone 17 Pro Max'}),row(8,{product:'iPhone 16 Pro Max'})]).length,5);
 }finally{h.sqlite.close()}
});
test('separate marks and condition keep the product grouped and damage quantity visible',()=>{
 const h=setup();try{const {groupInventory}=h.load('lib/inventory-groups.ts'),lib=h.load('lib/stock-product.ts');const g=groupInventory([row(1),row(2,{product:'黑色充电款加热饭盒',productPrefix:'#3-4 · 右侧',productCondition:'damaged',totalQuantity:3})]);assert.equal(g.length,1);assert.equal(g[0].damagedQuantity,3);assert.equal(lib.stockProductLabel(g[0].members[1].stock),'（残次品 · #3-4 · 右侧）黑色充电款加热饭盒');assert.equal(lib.stockProductDetails({product:'C0944-US-黑色超声波清洁仪'}).prefix,'');assert.equal(lib.stockProductDetails({product:'（有卡）iPhone 17'}).name,'(有卡)iPhone 17');
 const associations=h.load('lib/inventory-associations.ts'),old=row(1);const state={revision:1,associations:[{id:'old',product:'饭盒',customer:'天华',members:[{stockId:1,identity:JSON.stringify(['天华',old.product,'',''])},{stockId:2,identity:associations.inventoryIdentity(row(2,{product:'饭盒另一个名称'}))}]}]};const saved={...old,product:'黑色充电款加热饭盒',productPrefix:'#8-9',productCondition:'good'};assert.equal(associations.associatedInventory([saved,row(2,{product:'饭盒另一个名称'})],state).length,1);
 }finally{h.sqlite.close()}
});
test('inline edit persists annotations and only changed information, retaining all billing and batch data',async()=>{
 const h=setup();try{const id=h.stock();h.sqlite.prepare("UPDATE stocks SET product='#11-12 黑色充电款加热饭盒',sku='OLD',barcode='00123',customer_name='天华',inbound_source='return',item_volume_m3=0,storage_rate_usd=0.5,free_days=90,note='旧备注',fnsku='legacy' WHERE id=?").run(id);const original=(await h.call('stocks')).data.stocks[0],{recordDraft,recordPatch}=h.load('lib/inventory-record-edit.ts'),draft=recordDraft(original);assert.equal(draft.product,'黑色充电款加热饭盒');assert.equal(draft.productPrefix,'#11-12');draft.note='多行\n新备注';draft.productCondition='damaged';const patch=recordPatch(original,draft).patch;
 const r=await h.call('inventory/records','PATCH',patch);assert.equal(r.status,200,JSON.stringify(r.data));const stock=r.data.stock;assert.equal(stock.product,draft.product);assert.equal(stock.productPrefix,'#11-12');assert.equal(stock.productCondition,'damaged');assert.equal(stock.note,draft.note);assert.equal(stock.sku,'OLD');assert.equal(stock.version,1);
 for(const key of ['id','locationCode','inboundDate','barcode','totalQuantity','totalBoxes','palletCount','fnsku','catalogItemId','itemVolumeM3','boxVolumeM3','storageRateUsd','freeDays'])assert.equal(stock[key],original[key],key);
 assert.equal(h.sqlite.prepare('SELECT count(*) n FROM storage_fee_settlements').get().n,0);const audit=h.sqlite.prepare('SELECT * FROM audit_logs').get();assert.equal(audit.action,'库存修改');assert.equal(JSON.parse(audit.after_snapshot).productCondition,'damaged');assert.equal((await h.call('stocks')).data.stocks[0].note,draft.note);
 }finally{h.sqlite.close()}
});
test('invalid edits, stale versions and changes arriving during a save cannot overwrite stock or add audits',async()=>{
 const h=setup();try{const id=h.stock(),base={id,expectedVersion:0};assert.equal((await h.call('inventory/records','PATCH',{...base,note:'x'},'test-token-2')).status,403);
 for(const patch of [{locationCode:'B1'},{storageRateUsd:1},{totalBoxes:''},{totalQuantity:-1},{layerCount:1.5},{inboundDate:'2026-02-30'},{productCondition:'other'},{product:''}])assert.equal((await h.call('inventory/records','PATCH',{...base,...patch})).status,400,JSON.stringify(patch));
 assert.equal((await h.call('inventory/records','PATCH',{...base,expectedVersion:1,note:'stale'})).status,409);
 h.adapter.beforeBatch=()=>h.sqlite.exec('UPDATE stocks SET total_quantity=8,version=1 WHERE id=1');assert.equal((await h.call('inventory/records','PATCH',{...base,note:'race'})).status,409);assert.equal(h.sqlite.prepare('SELECT total_quantity n FROM stocks').get().n,8);assert.equal(h.sqlite.prepare('SELECT count(*) n FROM audit_logs').get().n,0);
 }finally{h.sqlite.close()}
});
test('annotations save in normal receipt forms, clear explicitly, and survive move and undo',async()=>{
 const h=setup();try{h.setting('warehouse_zones',[{id:'NEW_A',title:'A区',codes:['A1','A2'],locationCodesVersion:1,layoutVersion:8,layout:{},features:[]}]);let r=await h.call('stocks','POST',{locationCode:'A1',product:'#11-12 黑色充电款加热饭盒',customerName:'天华',inboundDate:'2026-09-01',totalQuantity:10,totalBoxes:2,inboundSource:'domestic'});assert.equal(r.status,200,JSON.stringify(r.data));let stock=r.data.stock;assert.equal(stock.productPrefix,'#11-12');assert.equal(stock.product,'黑色充电款加热饭盒');
 r=await h.call('stocks','POST',{id:stock.id,productPrefix:'左侧 · #20',productCondition:'damaged'});assert.equal(r.status,200);stock=r.data.stock;
 r=await h.call('stocks/move','POST',{id:stock.id,expectedVersion:stock.version,targetLocation:'A2',mode:'partial',quantity:3,boxes:1,targetLayerCount:2,sourceRemainingLayerCount:1});assert.equal(r.status,200,JSON.stringify(r.data));for(const s of (await h.call('stocks')).data.stocks){assert.equal(s.productPrefix,'左侧 · #20');assert.equal(s.productCondition,'damaged')}
 const log=h.sqlite.prepare("SELECT id FROM audit_logs WHERE action='移库' ORDER BY id DESC LIMIT 1").get();r=await h.call('movements','POST',{id:log.id});assert.equal(r.status,200,JSON.stringify(r.data));stock=(await h.call('stocks')).data.stocks[0];assert.equal(stock.totalQuantity,10);assert.equal(stock.productPrefix,'左侧 · #20');
 r=await h.call('inventory/records','PATCH',{id:stock.id,expectedVersion:stock.version,product:stock.product,productPrefix:'',productCondition:''});assert.equal(r.status,200);assert.equal(r.data.stock.productPrefix,'');assert.equal(r.data.stock.productCondition,'');
 }finally{h.sqlite.close()}
});
test('annotated stock backs up and restores without losing marks; old backup rows remain accepted',async()=>{
 const files=new Map(),r2=memoryR2(files),h=warehouseApiHarness({BACKUPS:r2});try{h.seedUser(1,null,'admin','boss');const id=h.stock();h.sqlite.prepare("UPDATE stocks SET product_prefix='#11-12',product_condition='damaged' WHERE id=?").run(id);const key=(await h.call('backups','POST',{})).data.key,data=JSON.parse(files.get(key)),route=h.load('app/api/backups/route.ts');
 const restore=async snapshot=>{const form=new FormData();form.set('file',new File([JSON.stringify(snapshot)],'backup.json',{type:'application/json'}));form.set('confirm','恢复备份');return route.PUT(new Request('http://local.test/api/backups',{method:'PUT',headers:{cookie:'wms_session=test-token-1'},body:form}))};
 let response=await restore(data);assert.equal(response.status,200,await response.text());assert.equal(h.sqlite.prepare('SELECT product_prefix p,product_condition c FROM stocks').get().p,'#11-12');assert.equal(h.sqlite.prepare('SELECT product_condition c FROM stocks').get().c,'damaged');
 h.sqlite.prepare("INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES (?,1,'2099-01-01','now')").run(createHash('sha256').update('test-token-1').digest('hex'));const old=structuredClone(data);for(const s of old.stocks){delete s.productPrefix;delete s.productCondition}const form=new FormData();form.set('file',new File([JSON.stringify(old)],'old.json'));form.set('confirm','恢复备份');response=await route.PUT(new Request('http://local.test/api/backups',{method:'PUT',headers:{cookie:'wms_session=test-token-1'},body:form}));assert.equal(response.status,200,await response.text());assert.equal(h.sqlite.prepare('SELECT product_prefix p FROM stocks').get().p,'');
 }finally{h.sqlite.close()}
});

test('customer multi-selection filters existing groups without merging customers or dropping quantities',()=>{
 const h=setup();try{const {groupInventory,filterInventory}=h.load('lib/inventory-groups.ts'),g=groupInventory([row(1,{customerName:'天华'}),row(2,{customerName:'TH'}),row(3,{customerName:'其他客户'}),row(4,{customerName:''})]);const visible=filterInventory(g,'product',['天华','TH'],'');assert.equal(visible.length,2);assert.equal(visible.reduce((n,g)=>n+g.quantity,0),20);assert.equal(filterInventory(g,'product',['__missing__','TH'],'').length,2);assert.equal(filterInventory(g,'product',[],'').length,4);
 }finally{h.sqlite.close()}
});
test('batch product/customer correction preserves separate annotations and supports undo per original row',async()=>{
 const h=setup();try{const ids=[h.stock('A1'),h.stock('A2')];h.sqlite.exec("UPDATE stocks SET product='#1-2 原商品',customer_name='客户旧名',inbound_source='return',item_volume_m3=0 WHERE id=1; UPDATE stocks SET product='残次品：#3-4 原商品',customer_name='客户简称' WHERE id=2");const before=(await h.call('stocks')).data.stocks;const records=before.map(s=>({id:s.id,expectedVersion:s.version}));const r=await h.call('inventory/records/batch','PATCH',{records,customerName:'统一客户',product:'统一商品'});assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.data.stocks.length,2);
 for(const s of r.data.stocks){const original=before.find(b=>b.id===s.id);assert.equal(s.product,'统一商品');assert.equal(s.customerName,'统一客户');for(const key of ['totalQuantity','totalBoxes','inboundDate','locationCode','storageRateUsd','itemVolumeM3'])assert.equal(s[key],original[key]);assert.equal(s.version,1)}
 assert.equal(r.data.stocks.find(s=>s.id===1).productPrefix,'#1-2');assert.equal(r.data.stocks.find(s=>s.id===2).productPrefix,'#3-4');assert.equal(r.data.stocks.find(s=>s.id===2).productCondition,'damaged');assert.equal(h.sqlite.prepare('SELECT count(*) n FROM audit_logs').get().n,2);assert.equal(h.sqlite.prepare('SELECT count(*) n FROM storage_fee_settlements').get().n,0);
 const log=h.sqlite.prepare("SELECT id FROM audit_logs WHERE entity_id='A2'").get();const undo=await h.call('movements','POST',{id:log.id});assert.equal(undo.status,200,JSON.stringify(undo.data));assert.equal(h.sqlite.prepare('SELECT product p FROM stocks WHERE id=2').get().p,'残次品：#3-4 原商品');assert.equal(h.sqlite.prepare('SELECT product p FROM stocks WHERE id=1').get().p,'统一商品');
 }finally{h.sqlite.close()}
});
test('batch validation and all-row version guard prevent partial writes, including over 100 selected rows',async()=>{
 const h=setup();try{for(let i=0;i<120;i++)h.stock(`A${i+1}`);const records=(await h.call('stocks')).data.stocks.map(s=>({id:s.id,expectedVersion:s.version})),body={records,customerName:'新客户'};
 assert.equal((await h.call('inventory/records/batch','PATCH',body,'test-token-2')).status,403);assert.equal((await h.call('inventory/records/batch','PATCH',{...body,locationCode:'B1'})).status,400);assert.equal((await h.call('inventory/records/batch','PATCH',{records,product:''})).status,400);assert.equal((await h.call('inventory/records/batch','PATCH',{...body,records:[records[0],records[0]]})).status,400);
 h.adapter.beforeBatch=()=>h.sqlite.exec('UPDATE stocks SET version=1,total_quantity=8 WHERE id=1');assert.equal((await h.call('inventory/records/batch','PATCH',body)).status,409);assert.equal(h.sqlite.prepare("SELECT count(*) n FROM stocks WHERE customer_name='新客户'").get().n,0);assert.equal(h.sqlite.prepare('SELECT count(*) n FROM audit_logs').get().n,0);
 body.records.find(r=>r.id===1).expectedVersion=1;const r=await h.call('inventory/records/batch','PATCH',body);assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(h.sqlite.prepare("SELECT count(*) n FROM stocks WHERE customer_name='新客户'").get().n,120);assert.equal(h.sqlite.prepare('SELECT count(*) n FROM audit_logs').get().n,120);
 }finally{h.sqlite.close()}
});

test('renaming a catalog-bound product/customer keeps its pricing snapshot and cannot be reverted by a later location save',async()=>{
 const h=setup();try{const catalog=await h.call('pricing/catalog','POST',{product:'原商品',customerName:'天华',sku:'SKU-A',barcode:'X001',itemVolumeM3:0.01,rateUsdM3Day:0.5,freeDays:90});assert.equal(catalog.status,200,JSON.stringify(catalog.data));const r=await h.call('stocks','POST',{locationCode:'A1',product:'原商品',customerName:'天华',inboundDate:'2026-09-01',totalQuantity:10,totalBoxes:2,inboundSource:'return',catalogItemId:catalog.data.item.id});assert.equal(r.status,200,JSON.stringify(r.data));const before=r.data.stock;
 const edited=await h.call('inventory/records','PATCH',{id:before.id,expectedVersion:before.version,product:'新商品',customerName:'统一客户'});assert.equal(edited.status,200,JSON.stringify(edited.data));assert.equal(edited.data.stock.catalogItemId,null);for(const key of ['itemVolumeM3','storageRateUsd','freeDays'])assert.equal(edited.data.stock[key],before[key]);const saved=await h.call('stocks','POST',{...edited.data.stock,note:'后续编辑'});assert.equal(saved.status,200,JSON.stringify(saved.data));assert.equal(saved.data.stock.product,'新商品');assert.equal(saved.data.stock.customerName,'统一客户');
 }finally{h.sqlite.close()}
});
