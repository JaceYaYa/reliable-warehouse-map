import assert from 'node:assert/strict';
import test from 'node:test';
import {warehouseApiHarness} from './helpers/warehouse-api-harness.mjs';

const fresh=()=>{const h=warehouseApiHarness();h.seedUser(1,null,'admin','boss');h.seedUser(2,['audit.view'],'admin');h.seedUser(3,['pricing.manage']);return h;};
const logs=h=>h.sqlite.prepare('SELECT * FROM audit_logs ORDER BY id').all();
const settings=h=>h.sqlite.prepare('SELECT * FROM settings ORDER BY key').all();
const latest=h=>logs(h).at(-1).id;
const patch=async(h,body)=>{const r=await h.call('pricing/settings','PATCH',body);assert.equal(r.status,200,JSON.stringify(r.data));return latest(h);};
const customer=async(h,rate,free)=>{const r=await h.call('pricing/customer-settings','PATCH',{customerName:'客户A',ratePerM3Day:rate,freeDays:free});assert.equal(r.status,200,JSON.stringify(r.data));return latest(h);};
const visible=async h=>(await h.call('audit')).data.logs;

test('默认计价按修改顺序撤销，旧设置精确恢复，原日志保留且重复撤销拒绝',async()=>{
 const h=fresh();try{
  h.setting('pricing_defaults',{defaultRatePerM3Day:.7,defaultFreeDays:15});const original=JSON.stringify(settings(h));const sid=h.stock();const stockBefore=h.sqlite.prepare('SELECT * FROM stocks WHERE id=?').get(sid);
  const a=await patch(h,{defaultRatePerM3Day:.5}),stateA=JSON.stringify(settings(h)),b=await patch(h,{defaultFreeDays:90});
  let v=await visible(h);assert.equal(v.find(l=>l.id===a).canRestore,false);assert.match(v.find(l=>l.id===a).restoreReason,/后续/);assert.equal(v.find(l=>l.id===b).canRestore,true);
  assert.equal((await h.call('audit/restore','POST',{id:a})).status,409);assert.equal((await h.call('audit/restore','POST',{id:b})).status,200);assert.equal(JSON.stringify(settings(h)),stateA);
  assert.equal((await visible(h)).find(l=>l.id===a).canRestore,true);assert.equal((await h.call('audit/restore','POST',{id:a})).status,200);assert.equal(JSON.stringify(settings(h)),original);
  assert.equal((await h.call('audit/restore','POST',{id:a})).status,409);assert.equal(logs(h).length,4);assert.equal(logs(h).at(-1).entity_id,String(a));assert.equal(logs(h).at(-1).action,'撤销管理设置');
  assert.deepEqual(h.sqlite.prepare('SELECT * FROM stocks WHERE id=?').get(sid),stockBefore);assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM goods_transaction_guards').get().n,0);
 }finally{h.sqlite.close()}
});

test('客户规则新增、修改、清除均支持撤销；缺省规则恢复为空，不猜旧费用',async()=>{
 const h=fresh();try{
  const original=JSON.stringify(settings(h)),a=await customer(h,.3,20),stateA=JSON.stringify(settings(h)),b=await customer(h,.4,30),stateB=JSON.stringify(settings(h)),c=await customer(h,null,null);
  assert.equal(JSON.stringify(settings(h)),original);assert.equal((await h.call('audit/restore','POST',{id:c})).status,200);assert.equal(JSON.stringify(settings(h)),stateB);
  assert.equal((await h.call('audit/restore','POST',{id:b})).status,200);assert.equal(JSON.stringify(settings(h)),stateA);
  assert.equal((await h.call('audit/restore','POST',{id:a})).status,200);assert.equal(JSON.stringify(settings(h)),original);
  for(const l of logs(h).slice(0,3)){assert.equal(JSON.parse(l.before_snapshot).schema,'admin-setting-v1');assert.equal(JSON.parse(l.after_snapshot).schema,'admin-setting-v1');}
 }finally{h.sqlite.close()}
});

test('设置撤销须同时有管理记录和计价权限，旧无快照记录仅查看',async()=>{
 const h=fresh();try{
  const a=await patch(h,{defaultRatePerM3Day:.6}),before=JSON.stringify(settings(h));
  assert.equal((await h.call('audit/restore','POST',{id:a},'test-token-2')).status,403);assert.equal((await h.call('audit/restore','POST',{id:a},'test-token-3')).status,403);assert.equal(JSON.stringify(settings(h)),before);
  assert.equal((await h.call('audit','GET',undefined,'test-token-2')).data.logs[0].canRestore,false);
  const old=Number(h.sqlite.prepare("INSERT INTO audit_logs(user_id,user_name,action,entity_type,entity_id,summary,created_at) VALUES(1,'boss','修改客户仓储计价','客户计价设置','客户A','旧版','2026-10-02')").run().lastInsertRowid);
  const entry=(await visible(h)).find(l=>l.id===old);assert.equal(entry.canRestore,false);assert.match(entry.restoreReason,/未保存/);assert.equal((await h.call('audit/restore','POST',{id:old})).status,400);assert.equal(JSON.stringify(settings(h)),before);
 }finally{h.sqlite.close()}
});

test('设置保存和撤销在并发变化时整体回滚，不新增审计也不留下临时锁',async()=>{
 for(const phase of ['save','restore']){
  const h=fresh();try{
   h.setting('pricing_defaults',{defaultRatePerM3Day:.7,defaultFreeDays:0});const a=await patch(h,{defaultRatePerM3Day:.6}),auditCount=logs(h).length;
   h.adapter.beforeBatch=()=>h.sqlite.prepare("UPDATE settings SET value='concurrent',updated_at='newer' WHERE key='pricing_defaults'").run();
   const r=phase==='save'?await h.call('pricing/settings','PATCH',{defaultRatePerM3Day:.3}):await h.call('audit/restore','POST',{id:a});assert.equal(r.status,409,JSON.stringify(r.data));
   assert.equal(settings(h)[0].value,'concurrent');assert.equal(logs(h).length,auditCount);assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM goods_transaction_guards').get().n,0);
  }finally{h.sqlite.close()}
 }
});

test('删除原审计快照期间撤销拒绝，设置保持不变',async()=>{
 const h=fresh();try{
  const a=await patch(h,{defaultRatePerM3Day:.6}),before=JSON.stringify(settings(h));h.adapter.beforeBatch=()=>h.sqlite.prepare('DELETE FROM audit_logs WHERE id=?').run(a);
  const r=await h.call('audit/restore','POST',{id:a});assert.equal(r.status,409);assert.equal(JSON.stringify(settings(h)),before);assert.equal(logs(h).length,0);
 }finally{h.sqlite.close()}
});
