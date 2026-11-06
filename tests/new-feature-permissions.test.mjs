import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {warehouseApiHarness} from './helpers/warehouse-api-harness.mjs';
import {effectivePermissions,canOperateStock} from '../lib/permissions.ts';

const setup=()=>{const h=warehouseApiHarness();h.seedUser(1,null,'admin','boss');h.setting('warehouse_zones',[{id:'A',title:'A区',codes:['A1','A2']}]);return h;};
const refs=c=>c.members.map(r=>({id:r.id,version:r.version}));
const seed=(h,product='原产品',quantity=10,boxes=2,unit='item')=>{const id=h.stock();h.sqlite.prepare("UPDATE stocks SET product=?,customer_name='商家',sku=?,total_quantity=?,total_boxes=?,inventory_unit=? WHERE id=?").run(product,product,quantity,boxes,unit,id);return id;};
const context=async(h,id)=>{const d=(await h.call('goods')).data;return{d,c:d.choices.find(c=>c.members.some(r=>r.id===id))};};
const toBox=async(h,id,scope='one')=>{const {d,c}=await context(h,id);return{requestId:randomUUID(),confirmed:true,stockId:id,scope,sourceKey:c.key,expectedRevision:d.revision,members:refs(c)};};
const product=async(h,id,action='edit')=>{const d=(await h.call('goods/products')).data,c=d.products.find(c=>c.members.some(r=>r.id===id));return{requestId:randomUUID(),confirmed:true,key:c.key,expectedRevision:d.revision,members:refs(c),action,...(action==='edit'?{identity:{product:'更新产品',customerName:'商家',sku:'新SKU'}}:{})};};
const latestLog=h=>h.sqlite.prepare("SELECT id FROM audit_logs ORDER BY id DESC LIMIT 1").get().id;
const setRole=(h,id,role)=>h.sqlite.prepare('UPDATE users SET role=?,permission_version=permission_version+1 WHERE id=?').run(role,id);

test('fixed admin profile includes warehouse operations while employee grants cannot expose writes',async()=>{const h=setup();try{
 for(const permission of ['stock.convert','product.manage','product.archive']){assert.ok(!effectivePermissions({role:'employee'}).includes(permission));assert.ok(effectivePermissions({role:'admin'}).includes(permission));assert.deepEqual(effectivePermissions({role:'admin',permissions:[permission]}),effectivePermissions({role:'admin'}));assert.equal(canOperateStock({role:'employee',permissions:[permission]}),false);}
 h.seedUser(2,['stock.convert']);const auth=h.load('lib/auth.ts'),req=new Request('http://local.test',{headers:{cookie:'wms_session=test-token-2'}});assert.equal((await auth.requireWriteUser(req)).error.status,403);
}finally{h.sqlite.close();}});

test('admin stock conversion succeeds; employee cannot convert or undo and role downgrade blocks replay',async()=>{const h=setup();try{
 const id=seed(h,'箱待转换',0);h.seedUser(2,['stock.edit','stock.inbound','stock.restore']);h.seedUser(3,['stock.convert','stock.restore'],'admin');const body=await toBox(h,id);
 assert.equal((await h.call('inventory/to-box','POST',body,'test-token-2')).status,403);let r=await h.call('inventory/to-box','POST',body,'test-token-3');assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.data.stocks[0].inventoryUnit,'box');const log=latestLog(h);
 assert.equal((await h.call('movements','POST',{id:log},'test-token-2')).status,403);setRole(h,3,'employee');assert.equal((await h.call('inventory/to-box','POST',body,'test-token-3')).status,403);assert.equal((await h.call('movements','POST',{id:log},'test-token-3')).status,403);setRole(h,3,'admin');assert.equal((await h.call('movements','POST',{id:log},'test-token-3')).status,200);
}finally{h.sqlite.close();}});

test('warehouse-wide conversion and historical review follow fixed admin versus employee roles',async()=>{const h=setup();try{
 const id=seed(h,'待核对箱',0);h.seedUser(2,['stock.convert']);h.seedUser(3,['stock.edit'],'admin');h.seedUser(4,['stock.convert'],'admin');const body=await toBox(h,id,'warehouse');
 assert.equal((await h.call('inventory/to-box','POST',body,'test-token-2')).status,403);
 let review=(await h.call('inventory/box-review', 'GET',undefined,'test-token-3')).data;assert.equal(review.canApprove,true);assert.equal(review.canConvert,true);review=(await h.call('inventory/box-review','GET',undefined,'test-token-2')).data;assert.equal(review.canApprove,false);assert.equal(review.canConvert,false);
 const p={requestId:randomUUID(),revision:review.state.revision,action:'confirm',stockId:id,version:0};assert.equal((await h.call('inventory/box-review','POST',p,'test-token-2')).status,403);assert.equal((await h.call('inventory/box-review','POST',p,'test-token-4')).status,200);
}finally{h.sqlite.close();}});

test('admin box conversion preserves costs; employee cannot convert or create its product target',async()=>{const h=setup();try{
 const id=seed(h,'箱',0,3,'box'),target=seed(h,'目标');h.seedUser(2,['stock.convert','stock.restore'],'admin');h.seedUser(3,['stock.edit','stock.inbound']);const {d,c}=await context(h,id),t=d.choices.find(c=>c.members.some(r=>r.id===target)),body={requestId:randomUUID(),confirmed:true,stockId:id,expectedVersion:0,sourceKey:c.key,expectedRevision:d.revision,members:refs(c),quantity:15,targetKey:t.key,targetMembers:refs(t)};
 assert.equal((await h.call('inventory/to-product','POST',body,'test-token-3')).status,403);const create={...body,requestId:randomUUID(),targetKey:undefined,targetMembers:undefined,createTarget:true,identity:{product:'新产品',customerName:'商家',sku:'NEW'}};assert.equal((await h.call('inventory/to-product','POST',create,'test-token-3')).status,403);
 let r=await h.call('inventory/to-product','POST',body,'test-token-2');assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.data.stocks[0].totalQuantity,15);assert.equal((await h.call('movements','POST',{id:latestLog(h)},'test-token-2')).status,200);
}finally{h.sqlite.close();}});

test('admin edits product identity, SKU and legacy specs; employee and downgraded session cannot replay',async()=>{const h=setup();try{
 const id=seed(h);h.seedUser(2,['stock.edit','stock.restore']);h.seedUser(3,['product.manage','stock.restore'],'admin');let p=await product(h,id);
 assert.equal((await h.call('goods/products','POST',p,'test-token-2')).status,403);let r=await h.call('goods/products','POST',p,'test-token-3');assert.equal(r.status,200,JSON.stringify(r.data));const log=latestLog(h);assert.equal((await h.call('movements','POST',{id:log},'test-token-2')).status,403);setRole(h,3,'employee');assert.equal((await h.call('goods/products','POST',p,'test-token-3')).status,403);setRole(h,3,'admin');assert.equal((await h.call('movements','POST',{id:log},'test-token-3')).status,200);
 for(const path of ['sku','spec','identity']){const {d,c}=await context(h,id),base={requestId:randomUUID(),confirmed:true,confirmAll:true,expectedRevision:d.revision,key:c.key,members:refs(c)},body=path==='sku'?{...base,sku:'REVISED'}:path==='spec'?{...base,productSpec:{billingMode:'item',itemVolumeM3:.02}}:{...base,stockId:id,version:c.members.find(r=>r.id===id).version,sourceKey:c.key,scope:'all',confirmed:true,identity:{product:'身份更新',customerName:'商家',sku:c.sku}};assert.equal((await h.call('goods/'+path,'POST',body,'test-token-2')).status,403);r=await h.call('goods/'+path,'POST',body,'test-token-3');assert.equal(r.status,200,path+JSON.stringify(r.data));assert.equal((await h.call('movements','POST',{id:latestLog(h)},'test-token-3')).status,200,path+' undo');}
}finally{h.sqlite.close();}});

test('admin archives and restores empty products; employee cannot and role downgrade blocks replay',async()=>{const h=setup();try{
 const id=seed(h,'无库存',0,0);h.seedUser(2,['stock.edit','stock.delete','stock.restore']);h.seedUser(3,['product.archive','stock.restore'],'admin');h.seedUser(4,['product.manage']);let p=await product(h,id,'archive');for(const token of ['test-token-2','test-token-4'])assert.equal((await h.call('goods/products','POST',p,token)).status,403);
 let r=await h.call('goods/products','POST',p,'test-token-3');assert.equal(r.status,200,JSON.stringify(r.data));const log=latestLog(h);assert.equal((await h.call('movements','POST',{id:log},'test-token-2')).status,403);setRole(h,3,'employee');assert.equal((await h.call('goods/products','POST',p,'test-token-3')).status,403);setRole(h,3,'admin');assert.equal((await h.call('movements','POST',{id:log},'test-token-3')).status,200);
 p=await product(h,id,'archive');assert.equal((await h.call('goods/products','POST',p,'test-token-3')).status,200);p=await product(h,id,'restore');assert.equal((await h.call('goods/products','POST',p,'test-token-3')).status,200);
}finally{h.sqlite.close();}});

test('admin product creation works; employee and downgraded sessions cannot reuse creation requests',async()=>{const h=setup();try{
 h.seedUser(2,['product.manage'],'admin');h.seedUser(3,['stock.convert']);h.seedUser(4,['stock.inbound'],'admin');let d=(await h.call('goods')).data,p={requestId:randomUUID(),expectedRevision:d.revision,product:'新产品',customerName:'商家',sku:'NEW',productSpec:{billingMode:'item',itemVolumeM3:.02}};assert.equal((await h.call('goods','POST',p,'test-token-3')).status,403);let r=await h.call('goods','POST',p,'test-token-2');assert.equal(r.status,200,JSON.stringify(r.data));setRole(h,2,'employee');assert.equal((await h.call('goods','POST',p,'test-token-2')).status,403);d=(await h.call('goods')).data;p={...p,requestId:randomUUID(),expectedRevision:d.revision,product:'入库创建',sku:'RECEIVE'};assert.equal((await h.call('goods','POST',p,'test-token-4')).status,200);
}finally{h.sqlite.close();}});

test('admin carton conversion and undo preserve stock; employee grants cannot bypass replay',async()=>{const h=setup();try{
 h.seedUser(2,['stock.convert','stock.restore'],'admin');h.seedUser(3,['stock.edit','stock.inbound','stock.restore']);const receive=await h.call('cartons','POST',{requestId:randomUUID(),inboundOrder:'普通箱单',inboundDate:'2026-09-25',placements:[{key:'one',locationCode:'A1',layerCount:1,boxes:3}]});assert.equal(receive.status,200,JSON.stringify(receive.data));
 const id=seed(h,'转换目标'),{d,c}=await context(h,id),p={requestId:randomUUID(),id:receive.data.receipt.id,expectedVersion:0,key:c.key,expectedRevision:d.revision,members:refs(c),inboundSource:'domestic',placements:[{key:'one',quantity:12,productCondition:'good',barcodes:[]}]};
 assert.equal((await h.call('cartons/convert','POST',p,'test-token-3')).status,403);let r=await h.call('cartons/convert','POST',p,'test-token-2');assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.data.stocks[0].totalQuantity,12);assert.equal((await h.call('cartons/convert','POST',p,'test-token-3')).status,403);assert.equal((await h.call('movements','POST',{id:latestLog(h)},'test-token-3')).status,403);assert.equal((await h.call('movements','POST',{id:latestLog(h)},'test-token-2')).status,200);
}finally{h.sqlite.close();}});

test('employee cannot edit managed products; admin retains local annotations and updates product identity',async()=>{const h=setup();try{
 const id=seed(h),{c}=await context(h,id),cat=h.load('lib/goods-flow.ts').materializeGoods(c,'2026-09-01T00:00:00Z');h.sqlite.prepare('UPDATE goods_flow_state SET value=?').run(JSON.stringify({categories:[cat]}));h.seedUser(2,['stock.edit']);h.seedUser(3,['stock.edit','product.manage'],'admin');
 const p={id,expectedVersion:0,product:'试图修改主资料'};assert.equal((await h.call('inventory/records','PATCH',p,'test-token-2')).status,403);assert.equal((await h.call('stocks','POST',{id,version:0,product:p.product},'test-token-2')).status,403);assert.equal((await h.call('inventory/records/batch','PATCH',{records:[{id,expectedVersion:0}],product:p.product},'test-token-2')).status,403);
 const note=await h.call('inventory/records','PATCH',{id,expectedVersion:0,note:'独立备注',productPrefix:'左侧'},'test-token-3');assert.equal(note.status,200,JSON.stringify(note.data));assert.equal((await h.call('inventory/records','PATCH',{...p,expectedVersion:1},'test-token-3')).status,200);
}finally{h.sqlite.close();}});

test('admin-created product undo is accurately reported; employee cannot read management audit or undo',async()=>{const h=setup();try{
 h.seedUser(2,['product.manage','audit.view','stock.restore'],'admin');h.seedUser(3,['product.manage','audit.view']);const d=(await h.call('goods')).data,p={requestId:randomUUID(),expectedRevision:d.revision,product:'仅产品资料',customerName:'商家',sku:'CORE',productSpec:{billingMode:'item',itemVolumeM3:.02}};assert.equal((await h.call('goods','POST',p,'test-token-2')).status,200);const log=latestLog(h);
 assert.equal((await h.call('audit','GET',undefined,'test-token-2')).data.logs.find(r=>r.id===log).canRestore,true);assert.equal((await h.call('audit','GET',undefined,'test-token-3')).status,403);assert.equal((await h.call('audit/restore','POST',{id:log},'test-token-3')).status,403);assert.equal((await h.call('audit/restore','POST',{id:log},'test-token-2')).status,200);
}finally{h.sqlite.close();}});
