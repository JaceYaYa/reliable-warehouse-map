import {memoryR2} from './helpers/r2-memory.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {warehouseApiHarness} from './helpers/warehouse-api-harness.mjs';
const fresh=(extra={})=>{const h=warehouseApiHarness(extra);h.seedUser(1,null,'admin','boss');h.seedUser(2,[]);h.setting('warehouse_zones',[{id:'NEW_A',title:'A区',codes:['A1','A2','B3']}]);for(const [name,code,date,quantity] of [['饭盒','A1','2026-06-01',60],['饭盒','B3','2026-08-01',40],['台灯','A2','2026-07-01',20]]){const id=h.stock(code);h.sqlite.prepare("UPDATE stocks SET product=?,customer_name='客户A',inbound_date=?,total_quantity=?,total_boxes=2,inbound_source='return',item_volume_m3=.1 WHERE id=?").run(name,date,quantity,id);}return h;};
const ctx=async h=>(await h.call('goods')).data;
const refs=c=>c.members.map(r=>({id:r.id,version:r.version}));
const all=h=>JSON.stringify(h.sqlite.prepare('SELECT * FROM stocks ORDER BY id').all());
const counts=h=>h.sqlite.prepare('SELECT (SELECT COUNT(*) FROM goods_operations) operations,(SELECT COUNT(*) FROM audit_logs) logs,(SELECT COUNT(*) FROM storage_fee_settlements) fees').get();
const receipt={inboundSource:'return',billingMode:'item',itemVolumeM3:.1,boxVolumeM3:0,storageRateUsd:.5,freeDays:0,sku:'',barcode:'',productPrefix:'本次',productCondition:'good'};
function payload(c,mode){return{requestId:crypto.randomUUID(),expectedRevision:c.revision,customerName:'客户A',mode,receipt:{inboundDate:'2026-09-01',inboundOrder:'IB-DOC',note:'整单到货'},lines:c.choices.map(choice=>({key:choice.key,members:refs(choice),quantity:mode==='inbound'?5:choice.product==='饭盒'?80:10,boxes:0,...(mode==='inbound'?{receipt,placements:[{locationCode:'A1',layerCount:1,quantity:3,boxes:0},{locationCode:'B3',layerCount:2,quantity:2,boxes:0,productPrefix:'右侧',productCondition:'damaged'}]}:{selected:choice.members.map((r,i)=>({id:r.id,version:r.version,quantity:choice.product==='饭盒'?(i===0?50:30):10,boxes:0}))})}))};}
const mixed=()=>{const h=fresh();h.sqlite.prepare("UPDATE stocks SET customer_name='客户B' WHERE product='台灯'").run();return h;};
const mixedPayload=(c,mode)=>{const p=payload(c,mode);delete p.customerName;return p;};
const categories=h=>JSON.parse(h.sqlite.prepare('SELECT value FROM goods_flow_state').get().value).categories;

test('每库位条码独立覆盖且空数组不继承，正残与标记独立不污染旧库位及其他客户',async()=>{
 const h=mixed();try{h.sqlite.exec("UPDATE stocks SET fnsku='OLD-FN',barcode='OLD-BC',sku='CORE' WHERE customer_name='客户A'");const p=mixedPayload(await ctx(h),'inbound');p.lines.forEach(l=>{l.receipt={...receipt,barcodes:['SHARED'],requirePlacementDetails:true};l.placements[0]={...l.placements[0],barcodes:[' LOC-A ','UPC','loc-a'],productCondition:'good',productPrefix:'左边 #1'};l.placements[1]={...l.placements[1],barcodes:[],productCondition:'damaged',productPrefix:''}});const r=await h.call('goods/document','POST',p);assert.equal(r.status,200,JSON.stringify(r.data));const added=h.sqlite.prepare('SELECT barcode,fnsku,sku,product_prefix,product_condition FROM stocks WHERE id>3 ORDER BY id').all();assert.deepEqual(added.map(s=>[s.barcode,s.fnsku,s.sku,s.product_prefix,s.product_condition]),[['LOC-A / UPC','','CORE','左边 #1','good'],['','','CORE','','damaged'],['LOC-A / UPC','','','左边 #1','good'],['','','','','damaged']]);assert.ok(h.sqlite.prepare("SELECT * FROM stocks WHERE id<=3 AND customer_name='客户A'").all().every(s=>s.fnsku==='OLD-FN'&&s.barcode==='OLD-BC'));assert.ok(categories(h).every(c=>!c.barcode.includes('LOC-A')&&!c.barcode.includes('UPC')));assert.ok((await ctx(h)).choices.every(c=>c.barcode.includes('LOC-A / UPC')));
 }finally{h.sqlite.close()}
});

test('最后一个库位未选正残、条码格式无效时整单原子拒绝；旧客户端无严格开关兼容',async()=>{
 for(const change of [p=>p.productCondition='',p=>delete p.productCondition,p=>p.barcodes=['X'.repeat(501)],p=>p.barcodes=Array.from({length:21},(_,i)=>`X${i}`),p=>p.barcodes=['a / b']]){const h=mixed();try{const p=mixedPayload(await ctx(h),'inbound');p.lines.forEach(l=>{l.receipt={...receipt,requirePlacementDetails:true};l.placements.forEach(p=>p.productCondition='good')});change(p.lines[1].placements[1]);const before=all(h),r=await h.call('goods/document','POST',p);assert.equal(r.status,400,JSON.stringify(r.data));assert.equal(all(h),before);assert.equal(categories(h).length,0);assert.deepEqual({...counts(h)},{operations:0,logs:0,fees:0})}finally{h.sqlite.close()}}
});

test('自选出库日统一用于混合客户整单、费用和历史，操作时间仍为实际时间且重放保持原结果',async()=>{
 const h=mixed();try{
  const before=all(h),p=mixedPayload(await ctx(h),'outbound');p.outboundDate='2026-09-10';p.lines[0].outboundDate='2026-09-30';
  const r=await h.call('goods/document','POST',p);assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.data.outboundDate,'2026-09-10');assert.ok(r.data.lines.every(l=>l.outboundDate==='2026-09-10'));
  const fees=h.sqlite.prepare('SELECT inbound_date,outbound_at,storage_days,fee_usd,created_at FROM storage_fee_settlements ORDER BY inbound_date').all();assert.deepEqual(fees.map(f=>[f.inbound_date,f.outbound_at,f.storage_days,f.fee_usd]),[['2026-06-01','2026-09-10T23:59:59.000Z',101,424.2],['2026-07-01','2026-09-10T23:59:59.000Z',71,49.7],['2026-08-01','2026-09-10T23:59:59.000Z',40,56]]);
  assert.ok(fees.every(f=>f.created_at.slice(0,10)!=='2026-09-10'));assert.ok(h.sqlite.prepare("SELECT summary FROM audit_logs WHERE action='出库'").all().every(l=>l.summary.includes('出库日期 2026-09-10')));
  assert.ok(h.sqlite.prepare('SELECT updated_at FROM stocks').all().every(s=>s.updated_at.slice(0,10)!=='2026-09-10'));assert.deepEqual((await h.call('goods/document','POST',p)).data,r.data);
  for(const log of h.sqlite.prepare("SELECT id FROM audit_logs WHERE action='出库'").all())assert.equal((await h.call('movements','POST',{id:log.id})).status,200);
  assert.deepEqual(JSON.parse(all(h)).map(s=>[s.id,s.total_quantity,s.total_boxes,s.inbound_date]),JSON.parse(before).map(s=>[s.id,s.total_quantity,s.total_boxes,s.inbound_date]));assert.equal(counts(h).fees,0);assert.equal((await h.call('goods/document','POST',p)).status,409);
 }finally{h.sqlite.close()}
});

test('混合客户整单出库日期无效或早于任一实物与成本批次时原子拒绝',async()=>{
 for(const date of ['2026-02-30','2026-9-10','2099-01-01','2026-06-30',null,'']){const h=mixed();try{const p=mixedPayload(await ctx(h),'outbound');p.outboundDate=date;const before=all(h),r=await h.call('goods/document','POST',p);assert.equal(r.status,400,JSON.stringify({date,...r}));assert.equal(all(h),before);assert.deepEqual({...counts(h)},{operations:0,logs:0,fees:0});assert.equal(h.sqlite.prepare('SELECT revision FROM goods_flow_state').get().revision,0);}finally{h.sqlite.close()}}
});

test('仅成本批次晚于自选出库日也拒绝，实物显示日期不能绕过计价日期',async()=>{
 const h=fresh();try{const p=payload(await ctx(h),'outbound');p.outboundDate='2026-09-10';assert.equal((await h.call('goods/document','POST',p)).status,200);h.sqlite.exec("UPDATE stocks SET inbound_date='2026-05-01'");const q=payload(await ctx(h),'outbound');q.lines=q.lines.filter(l=>l.quantity===10);q.lines[0].quantity=1;q.lines[0].selected[0].quantity=1;q.outboundDate='2026-06-30';const before=all(h),beforeCounts=counts(h);assert.equal((await h.call('goods/document','POST',q)).status,400);assert.equal(all(h),before);assert.deepEqual(counts(h),beforeCounts);}finally{h.sqlite.close()}
});

test('末客户日期或入库条码无效时整单前客户计划也不写入',async()=>{
 for(const mode of ['outbound','inbound']){const h=mixed();try{
  if(mode==='outbound')h.sqlite.exec("UPDATE stocks SET inbound_date='2026-09-02' WHERE customer_name='客户B'");
  const p=mixedPayload(await ctx(h),mode);if(mode==='outbound')p.outboundDate='2026-09-01';else p.lines[1].receipt={...receipt,barcodes:['X'.repeat(501)]};
  const before=all(h),r=await h.call('goods/document','POST',p);assert.equal(r.status,400,JSON.stringify(r.data));assert.match(r.data.error,/台灯/);assert.equal(all(h),before);assert.deepEqual({...counts(h)},{operations:0,logs:0,fees:0});assert.equal(h.sqlite.prepare('SELECT revision FROM goods_flow_state').get().revision,0);
 }finally{h.sqlite.close()}}
});
test('多客户入库从货物推导归属，逐行单号备注优先、日期统一、历史和撤销保持原客户',async()=>{
 const h=mixed();try{
  const p=mixedPayload(await ctx(h),'inbound');p.lines[0].receipt={...receipt,inboundDate:'2026-08-31',inboundOrder:'IB-A',note:'客户A备注'};p.lines[1].customerName='客户B';
  const r=await h.call('goods/document','POST',p);assert.equal(r.status,200,JSON.stringify(r.data));
  assert.deepEqual(r.data.customerNames,['客户A','客户B']);assert.equal(r.data.customerName,undefined);assert.deepEqual(r.data.lines.map(l=>l.customerName),['客户A','客户B']);
  const added=h.sqlite.prepare('SELECT customer_name,inbound_order,note,inbound_date,total_quantity FROM stocks WHERE id>3 ORDER BY id').all();
  assert.deepEqual(added.map(s=>[s.customer_name,s.inbound_order,s.note,s.inbound_date,s.total_quantity]),[['客户A','IB-A','客户A备注','2026-09-01',3],['客户A','IB-A','客户A备注','2026-09-01',2],['客户B','IB-DOC','整单到货','2026-09-01',3],['客户B','IB-DOC','整单到货','2026-09-01',2]]);
  assert.deepEqual(categories(h).map(c=>[c.customerName,c.lots.reduce((n,l)=>n+l.quantity,0)]),[['客户A',105],['客户B',25]]);
  const history=await h.call('movements?operationsOnly=1');assert.equal(history.status,200);
  for(const [i,name] of ['客户A','客户B'].entries()){
   const log=history.data.logs.find(l=>l.operationId===r.data.operationIds[i]);assert.ok(log.summary.includes(`客户 ${name}`));
   assert.ok(JSON.parse(log.afterSnapshot).rows.every(row=>row.customerName===name));
   const op=h.sqlite.prepare('SELECT result,after_category FROM goods_operations WHERE id=?').get(r.data.operationIds[i]);assert.equal(JSON.parse(op.result).customerName,name);assert.equal(JSON.parse(op.after_category).customerName,name);
  }
  const before=all(h),beforeCounts=counts(h);const replay=await h.call('goods/document','POST',p);assert.equal(replay.status,200);assert.deepEqual(replay.data,r.data);assert.equal(all(h),before);assert.deepEqual(counts(h),beforeCounts);
  const logB=history.data.logs.find(l=>l.operationId===r.data.operationIds[1]);assert.equal((await h.call('movements','POST',{id:logB.id})).status,200);
  assert.deepEqual(h.sqlite.prepare('SELECT customer_name,SUM(total_quantity) quantity FROM stocks GROUP BY customer_name ORDER BY customer_name').all().map(s=>[s.customer_name,s.quantity]),[['客户A',105],['客户B',20]]);
  assert.equal((await h.call('goods/document','POST',p)).status,409);
  const logA=history.data.logs.find(l=>l.operationId===r.data.operationIds[0]);assert.equal((await h.call('movements','POST',{id:logA.id})).status,200);
  assert.deepEqual(h.sqlite.prepare('SELECT customer_name,total_quantity FROM stocks ORDER BY id').all().map(s=>[s.customer_name,s.total_quantity]),[['客户A',60],['客户A',40],['客户B',20]]);
  assert.equal(categories(h).length,0);
 }finally{h.sqlite.close()}
});
test('多客户出库各自扣货和先进先出计价，重放不重复扣货，逐项撤销不影响另一客户',async()=>{
 const h=mixed();try{
  const p=mixedPayload(await ctx(h),'outbound'),r=await h.call('goods/document','POST',p);assert.equal(r.status,200,JSON.stringify(r.data));
  assert.deepEqual(r.data.customerNames,['客户A','客户B']);assert.deepEqual(r.data.lines.map(l=>l.customerName),['客户A','客户B']);assert.equal(r.data.customerName,undefined);
  assert.deepEqual(h.sqlite.prepare('SELECT customer_name,total_quantity FROM stocks ORDER BY id').all().map(s=>[s.customer_name,s.total_quantity]),[['客户A',10],['客户A',10],['客户B',10]]);
  assert.deepEqual(h.sqlite.prepare('SELECT customer_name,inbound_date,quantity FROM storage_fee_settlements ORDER BY id').all().map(s=>[s.customer_name,s.inbound_date,s.quantity]),[['客户A','2026-06-01',60],['客户A','2026-08-01',20],['客户B','2026-07-01',10]]);
  assert.deepEqual(categories(h).map(c=>[c.customerName,c.lots.reduce((n,l)=>n+l.quantity,0)]),[['客户A',20],['客户B',10]]);
  const before=all(h),beforeCounts=counts(h);assert.deepEqual((await h.call('goods/document','POST',p)).data,r.data);assert.equal(all(h),before);assert.deepEqual(counts(h),beforeCounts);
  const history=await h.call('movements?operationsOnly=1');assert.equal(history.status,200);
  for(const [i,name] of ['客户A','客户B'].entries()){
   const log=history.data.logs.find(l=>l.operationId===r.data.operationIds[i]);assert.ok(log.summary.includes(`客户 ${name}`));assert.ok(JSON.parse(log.beforeSnapshot).rows.every(row=>row.customerName===name));assert.ok(JSON.parse(log.afterSnapshot).rows.every(row=>row.customerName===name));
   assert.equal((await h.call('movements','POST',{id:log.id})).status,200);
   if(i===0){assert.deepEqual(h.sqlite.prepare('SELECT total_quantity FROM stocks ORDER BY id').all().map(s=>s.total_quantity),[60,40,10]);assert.deepEqual(h.sqlite.prepare('SELECT customer_name,quantity FROM storage_fee_settlements').all().map(s=>[s.customer_name,s.quantity]),[['客户B',10]]);assert.deepEqual(categories(h).map(c=>[c.customerName,c.lots.reduce((n,l)=>n+l.quantity,0)]),[['客户B',10]]);}
  }
  assert.deepEqual(h.sqlite.prepare('SELECT customer_name,total_quantity FROM stocks ORDER BY id').all().map(s=>[s.customer_name,s.total_quantity]),[['客户A',60],['客户A',40],['客户B',20]]);assert.equal(counts(h).fees,0);assert.equal(categories(h).length,0);assert.equal((await h.call('goods/document','POST',p)).status,409);
 }finally{h.sqlite.close()}
});
test('多客户末行无效时已准备的前行、状态、计价和历史都不写入',async()=>{
 for(const mode of ['inbound','outbound']){const h=mixed();try{
  const p=mixedPayload(await ctx(h),mode),before=all(h);if(mode==='inbound')p.lines[1].placements[1].locationCode='不存在';else p.lines[1].selected[0].quantity=999;
  const r=await h.call('goods/document','POST',p);assert.equal(r.status,400,JSON.stringify(r.data));assert.ok(r.data.error.includes('台灯'));assert.equal(all(h),before);assert.deepEqual({...counts(h)},{operations:0,logs:0,fees:0});assert.equal(categories(h).length,0);assert.equal(h.sqlite.prepare('SELECT revision FROM goods_flow_state').get().revision,0);
 }finally{h.sqlite.close()}}
});
test('逐行显式客户必须等于所选货物客户，旧整单客户约束继续拒绝跨客户',async()=>{
 for(const mode of ['inbound','outbound']){const h=mixed();try{
  const c=await ctx(h),before=all(h);
  for(const change of [p=>p.lines[1].customerName='客户A',p=>p.lines[1].customerName='',p=>p.lines[1].customerName=42,p=>p.customerName='客户A',p=>p.customerName=42]){
   const p=mixedPayload(c,mode);change(p);const r=await h.call('goods/document','POST',p);assert.equal(r.status,400,JSON.stringify(r.data));assert.equal(all(h),before);assert.deepEqual({...counts(h)},{operations:0,logs:0,fees:0});
  }
 }finally{h.sqlite.close()}}
});
test('省略或空整单客户的单客户请求仍返回客户标量，空逐行备注明确覆盖公共备注',async()=>{
 for(const customerName of [undefined,'  ']){const h=fresh();try{
  const p=payload(await ctx(h),'inbound');if(customerName===undefined)delete p.customerName;else p.customerName=customerName;
  p.lines[0].receipt={...receipt,inboundOrder:'',note:''};const r=await h.call('goods/document','POST',p);assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.data.customerName,'客户A');assert.deepEqual(r.data.customerNames,['客户A']);assert.ok(r.data.lines.every(l=>l.customerName==='客户A'));
  assert.deepEqual(h.sqlite.prepare('SELECT inbound_order,note FROM stocks WHERE id>3 ORDER BY id').all().map(s=>[s.inbound_order,s.note]),[['',''],['',''],['IB-DOC','整单到货'],['IB-DOC','整单到货']]);
 }finally{h.sqlite.close()}}
});
test('多客户请求仍要求写权限和原版本，1至25行边界和并发guard保护整单',async()=>{
 for(const mode of ['inbound','outbound']){const h=mixed();try{
  const c=await ctx(h),before=all(h);
  for(const change of [p=>p.expectedRevision++,p=>p.lines[1].members[0].version++,p=>{if(mode==='outbound'){p.lines[1].lineId='duplicate-line';p.lines.push({...p.lines[1]});}else p.lines.push(p.lines[1]);},p=>p.lines=[],p=>p.lines=Array.from({length:26},()=>p.lines[0])]){
   const p=mixedPayload(c,mode);change(p);assert.ok([400,409].includes((await h.call('goods/document','POST',p)).status));assert.equal(all(h),before);assert.deepEqual({...counts(h)},{operations:0,logs:0,fees:0});
  }
  assert.equal((await h.call('goods/document','POST',mixedPayload(c,mode),'test-token-2')).status,403);assert.equal((await h.call('goods/document','POST',mixedPayload(c,mode),'missing-token')).status,401);
  h.adapter.beforeBatch=()=>h.sqlite.prepare('UPDATE stocks SET version=version+1 WHERE id=3').run();assert.equal((await h.call('goods/document','POST',mixedPayload(c,mode))).status,409);
  assert.deepEqual(h.sqlite.prepare('SELECT customer_name,total_quantity FROM stocks ORDER BY id').all().map(s=>[s.customer_name,s.total_quantity]),[['客户A',60],['客户A',40],['客户B',20]]);assert.deepEqual({...counts(h)},{operations:0,logs:0,fees:0});assert.equal(categories(h).length,0);assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM goods_transaction_guards').get().n,0);
 }finally{h.sqlite.close()}}
 for(const n of [1,25]){const h=fresh();try{
  if(n===25)for(let i=0;i<23;i++){const id=h.stock('A1');h.sqlite.prepare("UPDATE stocks SET product=?,customer_name=?,item_volume_m3=.1 WHERE id=?").run(`额外产品${i}`,i%2?'客户A':'客户B',id);}
  const p=mixedPayload(await ctx(h),'inbound');if(n===1)p.lines=p.lines.slice(0,1);
  assert.equal(p.lines.length,n);const r=await h.call('goods/document','POST',p);assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.data.lines.length,n);assert.equal(counts(h).operations,n+1);assert.equal(counts(h).logs,n);
 }finally{h.sqlite.close()}}
});
test('整单多货物入库：唯一库存ID、公共资料、独立品相和标记，重复请求只写一次',async()=>{const h=fresh();try{const p=payload(await ctx(h),'inbound'),r=await h.call('goods/document','POST',p);assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.data.lines.length,2);assert.match(r.data.documentNumber,/^IN-/);assert.equal(new Set(r.data.lines.flatMap(l=>l.stocks.map(s=>s.id))).size,4);const added=h.sqlite.prepare('SELECT * FROM stocks WHERE id>3 ORDER BY id').all();assert.equal(added.length,4);assert.ok(added.every(s=>s.inbound_order==='IB-DOC'&&s.note==='整单到货'&&s.inbound_date==='2026-09-01'));assert.deepEqual(added.map(s=>[s.product_prefix,s.product_condition]),[['本次','good'],['右侧','damaged'],['本次','good'],['右侧','damaged']]);const before=all(h);assert.equal((await h.call('goods/document','POST',p)).status,200);assert.equal(all(h),before);assert.equal(counts(h).operations,3);assert.equal(counts(h).logs,2);assert.equal(h.sqlite.prepare('SELECT revision FROM goods_flow_state').get().revision,1);assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM goods_transaction_guards').get().n,0);}finally{h.sqlite.close()}});
test('整单出库精确按各库位数量扣减，计价独立最早批次；逐项撤销后请求不能重放',async()=>{const h=fresh();try{const p=payload(await ctx(h),'outbound'),r=await h.call('goods/document','POST',p);assert.equal(r.status,200,JSON.stringify(r.data));assert.match(r.data.documentNumber,/^OUT-/);assert.deepEqual(h.sqlite.prepare('SELECT total_quantity FROM stocks ORDER BY id').all().map(s=>s.total_quantity),[10,10,10]);const l=r.data.lines.find(l=>l.billingAllocations.length===2);assert.deepEqual(l.billingAllocations.map(a=>[a.inboundDate,a.quantity]),[['2026-06-01',60],['2026-08-01',20]]);const reports=await h.call('pricing/report');assert.equal(reports.status,200);assert.equal(reports.data.rows.reduce((n,r)=>n+r.quantity,0),120);const log=h.sqlite.prepare("SELECT * FROM audit_logs WHERE summary LIKE '%饭盒%' AND action='出库'").get();const restored=await h.call('movements','POST',{id:log.id});assert.equal(restored.status,200,JSON.stringify(restored.data));assert.deepEqual(h.sqlite.prepare('SELECT total_quantity FROM stocks ORDER BY id').all().map(s=>s.total_quantity),[60,40,10]);assert.equal((await h.call('goods/document','POST',p)).status,409);}finally{h.sqlite.close()}});
test('最后一项资料、分配或SKU无效，整单不留下任何库存、费用、操作记录',async()=>{for(const mode of ['inbound','outbound']){const h=fresh();try{const c=await ctx(h),before=all(h),p=payload(c,mode);if(mode==='inbound')p.lines[1].placements[1].locationCode='不存在';else p.lines[1].selected[0].quantity=999;const r=await h.call('goods/document','POST',p);assert.equal(r.status,400,JSON.stringify(r.data));assert.equal(all(h),before);assert.equal(counts(h).operations,0);assert.equal(counts(h).logs,0);assert.equal(counts(h).fees,0);assert.equal(h.sqlite.prepare('SELECT revision FROM goods_flow_state').get().revision,0);}finally{h.sqlite.close()}}});
test('分配总数、重复货物、跨客户、版本和权限必须全部通过',async()=>{const h=fresh();try{const c=await ctx(h),before=all(h);for(const change of [p=>p.lines[0].quantity++,p=>p.lines.push(p.lines[0]),p=>p.customerName='其他客户',p=>p.lines[0].members[0].version++]){const p=payload(c,'inbound');change(p);const r=await h.call('goods/document','POST',p);assert.ok([400,409].includes(r.status),JSON.stringify(r));assert.equal(all(h),before);}assert.equal((await h.call('goods/document','POST',payload(c,'inbound'),'test-token-2')).status,403);}finally{h.sqlite.close()}});
test('整单guard捕获任一货物的并发变化，所有计划一起回滚',async()=>{const h=fresh();try{const p=payload(await ctx(h),'outbound');h.adapter.beforeBatch=()=>h.sqlite.prepare('UPDATE stocks SET version=version+1 WHERE id=3').run();const r=await h.call('goods/document','POST',p);assert.equal(r.status,409,JSON.stringify(r));assert.deepEqual(h.sqlite.prepare('SELECT total_quantity FROM stocks ORDER BY id').all().map(s=>s.total_quantity),[60,40,20]);assert.equal(counts(h).operations,0);assert.equal(counts(h).fees,0);}finally{h.sqlite.close()}});

test('整单记录完整备份恢复后仍可逐项撤销，原整单请求不会重复写入',async()=>{
 const files=new Map(),h=fresh({BACKUPS:memoryR2(files)});
 try{
  h.sqlite.exec("UPDATE stocks SET pallet_label='1'");const p=payload(await ctx(h),'inbound');assert.equal((await h.call('goods/document','POST',p)).status,200);const expected=all(h),savedResult=await h.call('backups','POST',{});assert.equal(savedResult.status,200);const saved=JSON.parse(files.get(savedResult.data.key));assert.equal(saved.goodsOperations.length,3);assert.equal(saved.goodsOperations.filter(o=>o.kind==='document').length,1);
  h.sqlite.exec('DELETE FROM stocks; DELETE FROM goods_operations; DELETE FROM goods_flow_state;');
  const form=new FormData();form.set('file',new File([JSON.stringify(saved)],'backup.json'));form.set('confirm','恢复备份');const restored=await h.load('app/api/backups/route.ts').PUT(new Request('http://local.test/api/backups',{method:'PUT',headers:{cookie:'wms_session=test-token-1'},body:form}));assert.equal(restored.status,200,await restored.text());assert.deepEqual(JSON.parse(all(h)),JSON.parse(expected));
  h.sqlite.prepare("INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES (?,1,'2099-01-01','now')").run(createHash('sha256').update('test-token-1').digest('hex'));
  const id=h.sqlite.prepare("SELECT id FROM audit_logs WHERE action='入库' ORDER BY id LIMIT 1").get().id;const undo=await h.call('movements','POST',{id});assert.equal(undo.status,200,JSON.stringify(undo.data));assert.equal((await h.call('goods/document','POST',p)).status,409);assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM stocks').get().n,5);
 }finally{h.sqlite.close()}
});

test('整单无效数量、半填分配、请求编号复用和未登录均拒绝',async()=>{
 const h=fresh();try{const c=await ctx(h),before=all(h);for(const change of [p=>p.lines[0].quantity=-1,p=>p.lines[0].quantity=1.5,p=>delete p.lines[0].selected[0].boxes,p=>p.lines[0].selected[0].quantity=0,p=>p.lines[0].selected[0].id=999]){const p=payload(c,'outbound');change(p);assert.ok([400,409].includes((await h.call('goods/document','POST',p)).status));assert.equal(all(h),before);}assert.equal((await h.call('goods/document','POST',payload(c,'inbound'),'missing-token')).status,401);const p=payload(c,'inbound');assert.equal((await h.call('goods/document','POST',p)).status,200);p.receipt.note='编号复用';assert.equal((await h.call('goods/document','POST',p)).status,409);}finally{h.sqlite.close()}
});
