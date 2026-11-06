import assert from 'node:assert/strict';
import test from 'node:test';
import {resolve} from 'node:path';
import {warehouseApiHarness} from './helpers/warehouse-api-harness.mjs';

const fresh=()=>{
 const h=warehouseApiHarness();
 h.seedUser(1,['audit.view','stock.inbound','stock.restore'],'admin');
 h.seedUser(2,['audit.view']);h.seedUser(3,['stock.inbound']);h.seedUser(4,[]);
 h.setting('warehouse_zones',[{id:'NEW_A',title:'A区',codes:['A1','B3']}]);
 return h;
};
const rawState=h=>h.sqlite.prepare('SELECT * FROM goods_flow_state WHERE id=1').get();
const state=h=>JSON.parse(rawState(h).value);
const audits=h=>h.sqlite.prepare('SELECT * FROM audit_logs ORDER BY id').all();
const createLogs=h=>audits(h).filter(row=>row.action==='货物类别新增').map(row=>({id:row.id,action:row.action,operationId:row.operation_id}));
const undoStates=h=>h.load(resolve('lib/goods-create-undo.ts')).goodsCreateUndoStates(createLogs(h));
async function create(h,product='饭盒'){
 const body={requestId:crypto.randomUUID(),expectedRevision:rawState(h).revision,product,customerName:'客户A',sku:'SKU-'+product,barcode:'X-'+product,productSpec:{billingMode:'item',itemLengthCm:20,itemWidthCm:10,itemHeightCm:5}};
 const r=await h.call('goods','POST',body);assert.equal(r.status,200,JSON.stringify(r.data));
 const log=createLogs(h).find(row=>row.operationId===body.requestId);
 return{body,result:r.data,log};
}

test('管理记录撤销空货物类别：保留原日志和operation，记录撤销人、快照、时间，重放不重复',async()=>{
 const h=fresh();try{
  const a=await create(h),b=await create(h,'台灯');assert.equal((await undoStates(h)).get(a.log.id).canRestore,true);
  const revision=rawState(h).revision,result=await h.call('audit/restore','POST',{id:a.log.id});assert.equal(result.status,200,JSON.stringify(result.data));
  assert.equal(result.data.restoredAuditId,a.log.id);assert.deepEqual(state(h).categories.map(c=>c.id),[b.result.categoryId]);assert.equal(rawState(h).revision,revision+1);
  const op=h.sqlite.prepare('SELECT * FROM goods_operations WHERE id=?').get(a.body.requestId);assert.ok(op.restored_at);assert.equal(op.after_category.includes('饭盒'),true);
  assert.equal(audits(h).length,3);const undo=audits(h)[2];assert.equal(undo.user_id,1);assert.equal(undo.action,'撤销货物类别新增');assert.equal(undo.entity_id,String(a.log.id));assert.equal(undo.operation_id,`restore:audit:${a.log.id}`);
  assert.equal(JSON.parse(undo.before_snapshot).category.id,a.result.categoryId);assert.equal(JSON.parse(undo.after_snapshot).category,null);assert.equal(undo.created_at,op.restored_at);
  const before=JSON.stringify(rawState(h));assert.equal((await h.call('audit/restore','POST',{id:a.log.id})).status,409);assert.equal(JSON.stringify(rawState(h)),before);assert.equal(audits(h).length,3);
  assert.equal((await h.call('goods','POST',a.body)).status,409);assert.match((await undoStates(h)).get(a.log.id).restoreReason,/已经撤销/);assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM goods_transaction_guards').get().n,0);
 }finally{h.sqlite.close()}
});

test('管理员可撤销空类别；未登录与持旧授权的员工不能写数据',async()=>{
 const h=fresh();try{
  const a=await create(h),before=JSON.stringify(rawState(h));
  for(const [token,status] of [['missing-token',401],['test-token-2',403],['test-token-3',403],['test-token-4',403]]){const r=await h.call('audit/restore','POST',{id:a.log.id},token);assert.equal(r.status,status);assert.equal(JSON.stringify(rawState(h)),before);}
  h.seedUser(5,['audit.view','stock.inbound','stock.restore'],'admin');assert.equal((await h.call('audit/restore','POST',{id:a.log.id},'test-token-5')).status,200);assert.equal(audits(h)[1].user_id,5);
 }finally{h.sqlite.close()}
});

test('旧版本无productSpec类别与新尺寸类别都可以撤销；对象字段顺序不影响一致性',async()=>{
 for(const legacy of [true,false]){
  const h=fresh();try{
   const a=await create(h),current=state(h),category=current.categories[0];if(legacy)delete category.productSpec;
   h.sqlite.prepare('UPDATE goods_flow_state SET value=? WHERE id=1').run(JSON.stringify(current));
   const reordered=Object.fromEntries(Object.entries(category).reverse());h.sqlite.prepare('UPDATE goods_operations SET after_category=? WHERE id=?').run(JSON.stringify(reordered),a.body.requestId);
   assert.equal((await undoStates(h)).get(a.log.id).canRestore,true);assert.equal((await h.call('audit/restore','POST',{id:a.log.id})).status,200);assert.equal(state(h).categories.length,0);
  }finally{h.sqlite.close()}
 }
});

test('真实入库后类别不可撤销，即使入库已撤回也保留使用历史并拒绝删类别',async()=>{
 const h=fresh();try{
  const a=await create(h),inbound=await h.call('goods/inbound','POST',{requestId:crypto.randomUUID(),expectedRevision:rawState(h).revision,key:a.result.key,members:[],receipt:{inboundDate:'2026-09-01',inboundSource:'domestic',billingMode:'item',itemVolumeM3:.001,boxVolumeM3:0,storageRateUsd:.5,freeDays:0,sku:a.body.sku,barcode:a.body.barcode},placements:[{locationCode:'A1',layerCount:1,quantity:3,boxes:1}]});
  assert.equal(inbound.status,200,JSON.stringify(inbound.data));const original=JSON.stringify(rawState(h));assert.match((await undoStates(h)).get(a.log.id).restoreReason,/入库|出库/);
  assert.equal((await h.call('audit/restore','POST',{id:a.log.id})).status,409);assert.equal(JSON.stringify(rawState(h)),original);assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM stocks').get().n,1);
  const stockLog=audits(h).find(row=>row.action==='入库');const restored=await h.call('movements','POST',{id:stockLog.id});assert.equal(restored.status,200,JSON.stringify(restored.data));assert.equal(state(h).categories[0].stockIds.length,0);
  const after=JSON.stringify(rawState(h));assert.equal((await h.call('audit/restore','POST',{id:a.log.id})).status,409);assert.equal(JSON.stringify(rawState(h)),after);assert.match((await undoStates(h)).get(a.log.id).restoreReason,/后续操作/);
 }finally{h.sqlite.close()}
});

test('空类别的名称、客户、尺寸或任何源快照字段变动后拒绝撤销',async()=>{
 for(const mutate of [c=>c.product='已修改名称',c=>c.customerName='新客户',c=>c.productSpec.itemLengthCm=30,c=>c.confirmed=true]){
  const h=fresh();try{const a=await create(h),s=state(h);mutate(s.categories[0]);h.sqlite.prepare('UPDATE goods_flow_state SET value=?,revision=revision+1 WHERE id=1').run(JSON.stringify(s));const before=JSON.stringify(rawState(h));const r=await h.call('audit/restore','POST',{id:a.log.id});assert.equal(r.status,409,JSON.stringify(r.data));assert.match(r.data.error,/资料已发生变化/);assert.equal(JSON.stringify(rawState(h)),before);assert.equal(audits(h).length,1);}finally{h.sqlite.close()}
 }
});

test('页内多个新增记录的撤销状态只用一批两条查询，包含无operation和其他动作的处理',async()=>{
 const h=fresh();try{
  const a=await create(h),b=await create(h,'台灯'),s=state(h);s.categories[1].product='已改台灯';h.sqlite.prepare('UPDATE goods_flow_state SET value=? WHERE id=1').run(JSON.stringify(s));
  const helper=h.load(resolve('lib/goods-create-undo.ts')),original=h.adapter.batch;let calls=0,queries=0;h.adapter.batch=async list=>{calls++;queries+=list.length;return original(list)};
  const result=await helper.goodsCreateUndoStates([a.log,b.log,{id:999,action:'货物类别新增',operationId:null},{id:1000,action:'账号新增',operationId:null}]);
  assert.equal(calls,1);assert.equal(queries,2);assert.equal(result.size,3);assert.equal(result.get(a.log.id).canRestore,true);assert.match(result.get(b.log.id).restoreReason,/资料已发生变化/);assert.equal(result.get(999).canRestore,false);
  assert.equal((await helper.goodsCreateUndoStates([{id:1000,action:'账号新增',operationId:null}])).size,0);assert.equal(calls,1);
 }finally{h.sqlite.close()}
});

test('真实SQLite事务捕获revision、类别、源operation、源审计及后续入库竞争，撤销整笔回滚',async()=>{
 const mutations=[
  (h)=>h.sqlite.exec('UPDATE goods_flow_state SET revision=revision+1 WHERE id=1'),
  (h)=>{const s=state(h);s.categories[0].product='并发更名';h.sqlite.prepare('UPDATE goods_flow_state SET value=? WHERE id=1').run(JSON.stringify(s));},
  (h,a)=>h.sqlite.prepare("UPDATE goods_operations SET fingerprint='并发改动' WHERE id=?").run(a.body.requestId),
  (h,a)=>h.sqlite.prepare("UPDATE goods_operations SET restored_at='already-restored' WHERE id=?").run(a.body.requestId),
  (h,a)=>h.sqlite.prepare("UPDATE audit_logs SET summary='并发更改原管理记录' WHERE id=?").run(a.log.id),
  (h,a)=>h.sqlite.prepare("INSERT INTO goods_operations(id,kind,category_id,fingerprint,before_category,after_category,before_rows,after_rows,settlement_ids,result,created_at) SELECT ?,'inbound',category_id,fingerprint,before_category,after_category,before_rows,after_rows,settlement_ids,result,created_at FROM goods_operations WHERE id=?").run(crypto.randomUUID(),a.body.requestId),
 ];
 for(const mutate of mutations){const h=fresh();try{
  const a=await create(h),original=h.adapter.batch;let calls=0;h.adapter.batch=async list=>{if(++calls===2)mutate(h,a);return original(list)};
  const r=await h.call('audit/restore','POST',{id:a.log.id});assert.equal(r.status,409,JSON.stringify(r.data));assert.equal(state(h).categories.length,1);assert.equal(audits(h).filter(row=>row.action==='撤销货物类别新增').length,0);assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM goods_transaction_guards').get().n,0);
 }finally{h.sqlite.close()}}
});

test('无效编号、缺失记录、其他动作及损坏来源不给撤销入口且不写入',async()=>{
 const h=fresh();try{
  const a=await create(h);for(const id of [null,0,-1,1.5,'bad'])assert.equal((await h.call('audit/restore','POST',{id})).status,400);
  assert.equal((await h.call('audit/restore','POST',null)).status,400);assert.equal((await h.call('audit/restore','POST',{id:9999})).status,404);
  const other=Number(h.sqlite.prepare("INSERT INTO audit_logs(user_id,user_name,action,entity_type,summary,created_at) VALUES (1,'user1','账号新增','账号','新增','now')").run().lastInsertRowid);assert.equal((await h.call('audit/restore','POST',{id:other})).status,400);
  h.sqlite.prepare("UPDATE goods_operations SET before_rows='not-json' WHERE id=?").run(a.body.requestId);assert.equal((await undoStates(h)).get(a.log.id).canRestore,false);assert.equal((await h.call('audit/restore','POST',{id:a.log.id})).status,409);assert.equal(state(h).categories.length,1);assert.equal(audits(h).length,2);
 }finally{h.sqlite.close()}
});
