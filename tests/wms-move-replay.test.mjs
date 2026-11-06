import {redactWarehousePricing} from '../lib/permissions.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {existsSync,readFileSync} from 'node:fs';
import {warehouseApiHarness} from './helpers/warehouse-api-harness.mjs';

const rows=h=>h.sqlite.prepare('SELECT * FROM stocks ORDER BY id').all();
const logs=h=>h.sqlite.prepare("SELECT * FROM audit_logs WHERE action='移库' ORDER BY id").all();
const goods=h=>h.sqlite.prepare('SELECT * FROM goods_flow_state').all();
function setup(){
 const h=warehouseApiHarness();
 if(!h.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name='wms_move_requests'").get()&&existsSync('drizzle/0022_wms_move_requests.sql'))h.sqlite.exec(readFileSync('drizzle/0022_wms_move_requests.sql','utf8'));
 h.seedUser(1,null,'admin','mover');h.seedUser(2,null,'admin','other');h.seedUser(3,[],'employee','viewer');
 h.setting('warehouse_zones',[{id:'A',title:'A区',codes:['A1','A2','A3']}]);
 const id=h.stock('A1',1,0);h.sqlite.prepare("UPDATE stocks SET customer_name='商家',sku='SKU-1',fnsku='FN-1',barcode='BC-1',product_condition='good',product_prefix='标记',item_volume_m3=.2,storage_rate_usd=.5,free_days=10 WHERE id=?").run(id);
 return {h,payload:{id,expectedVersion:0,targetLocation:'A2',mode:'all',targetLayerCount:2,requestId:randomUUID()}};
}
const move=(h,payload,token)=>h.call('stocks/move','POST',payload,token);
for(const mode of ['all','partial'])test(`${mode}: lost response retry returns original result and moves/audits only once`,async()=>{
 const{h,payload}=setup();try{
  if(mode==='partial')Object.assign(payload,{mode,quantity:4,boxes:1,sourceRemainingLayerCount:1});
  const first=await move(h,payload);assert.equal(first.status,200,JSON.stringify(first.data));
  const after=rows(h),afterGoods=goods(h),afterLogs=logs(h);
  // Simulate loss by discarding the first response before submitting the unchanged intent.
  const replay=await move(h,payload);assert.deepEqual(replay,first);
  assert.deepEqual(rows(h),after);assert.deepEqual(goods(h),afterGoods);assert.deepEqual(logs(h),afterLogs);assert.equal(afterLogs.length,1);
  assert.equal(after.reduce((n,r)=>n+r.total_quantity,0),10);assert.equal(after.reduce((n,r)=>n+r.total_boxes,0),2);
  assert.equal(first.data.destination.fnsku,'FN-1');assert.equal(first.data.destination.productCondition,'good');assert.equal(first.data.destination.itemVolumeM3,.2);
  const saved=h.sqlite.prepare('SELECT * FROM wms_move_requests').all();assert.equal(saved.length,1);assert.deepEqual(redactWarehousePricing(JSON.parse(saved[0].response_json),{role:'admin'}),first.data);assert.equal(JSON.parse(saved[0].response_json).destination.storageRateUsd,.5);h.sqlite.prepare("UPDATE users SET username='boss' WHERE id=1").run();assert.deepEqual((await move(h,payload)).data,JSON.parse(saved[0].response_json));assert.equal(saved[0].actor_id,1);
 }finally{h.sqlite.close();}
});
test('persisted response survives later stock movement and changed target capacity',async()=>{
 const{h,payload}=setup();try{
  const first=await move(h,payload);assert.equal(first.status,200);
  const later=await move(h,{...payload,requestId:randomUUID(),expectedVersion:1,targetLocation:'A3',targetLayerCount:4});assert.equal(later.status,200);
  const physical=rows(h),ledger=goods(h);h.setting('warehouse_zones',[]);
  assert.deepEqual(await move(h,payload),first);assert.deepEqual(rows(h),physical);assert.deepEqual(goods(h),ledger);assert.equal(logs(h).length,2);
 }finally{h.sqlite.close();}
});
test('request identifier is bound to actor and normalized parameters; permission checked before replay',async()=>{
 const{h,payload}=setup();try{
  const first=await move(h,payload);assert.equal(first.status,200);const after=rows(h);
  assert.deepEqual(await move(h,{...payload,id:String(payload.id),expectedVersion:'0',targetLocation:' a2 ',targetLayerCount:'2'}),first);
  for(const patch of [{targetLocation:'A3'},{mode:'partial',quantity:1},{targetLayerCount:1},{expectedVersion:1}])assert.equal((await move(h,{...payload,...patch})).status,409);
  assert.equal((await move(h,payload,'test-token-2')).status,409);assert.equal((await move(h,payload,'test-token-3')).status,403);
  assert.deepEqual(rows(h),after);assert.equal(logs(h).length,1);
 }finally{h.sqlite.close();}
});
test('malformed exact request identifiers reject before writing; legacy clients still work',async()=>{
 const{h,payload}=setup();try{
  const before=rows(h);
  for(const id of ['',null,10,' '+randomUUID(),randomUUID().replaceAll('-',''),'x'.repeat(36)])assert.equal((await move(h,{...payload,requestId:id})).status,400);
  assert.deepEqual(rows(h),before);assert.equal(logs(h).length,0);
  const{requestId,...legacy}=payload;assert.equal((await move(h,legacy)).status,200);assert.equal(logs(h).length,1);
 }finally{h.sqlite.close();}
});
for(const mode of ['all','partial'])test(`${mode}: same request concurrent readers yield one stock move and one original outcome`,async()=>{
 const{h,payload}=setup();try{
  if(mode==='partial')Object.assign(payload,{mode,quantity:4,boxes:1,sourceRemainingLayerCount:1});
  const native=h.adapter.batch.bind(h.adapter);let release,arrived=0;
  // Serialize SQLite batches like D1, while forcing both requests to finish their reads before the mutation batch.
  let queue=Promise.resolve();const barrier=new Promise(r=>release=r);
  h.adapter.batch=async queries=>{
   const isMove=queries.some(q=>q.moveMarker); // Prepared statements below annotate only ledger claim SQL.
   if(isMove){arrived++;if(arrived===2)release();await barrier;}
   const run=queue.then(()=>native(queries));queue=run.catch(()=>{});return run;
  };
  const prepare=h.adapter.prepare.bind(h.adapter);h.adapter.prepare=sql=>{const q=prepare(sql);const bind=q.bind; q.bind=(...args)=>{const bound=bind(...args);if(/INSERT INTO wms_move_requests/.test(sql))bound.moveMarker=true;return bound;};return q;};
  const result=await Promise.all([move(h,payload),move(h,payload)]);
  assert.equal(result[0].status,200,JSON.stringify(result));assert.deepEqual(result[1],result[0]);assert.equal(logs(h).length,1);assert.equal(rows(h)[0].version,1);assert.equal(rows(h).reduce((n,r)=>n+r.total_quantity,0),10);assert.equal(rows(h).length,mode==='partial'?2:1);
 }finally{h.sqlite.close();}
});
for(const mode of ['all','partial'])test(`${mode}: managed category preserves physical totals and independent cost lots on replay`,async()=>{
 const{h,payload}=setup();try{
  const c=(await h.call('goods')).data,choice=c.choices[0];
  // Establish independent pricing through the real outbound workflow, with an already different physical balance.
  const out=await h.call('goods/outbound','POST',{requestId:randomUUID(),expectedRevision:c.revision,key:choice.key,members:choice.members.map(r=>({id:r.id,version:r.version})),quantity:1,boxes:0,selected:[{id:payload.id,version:0}]});assert.equal(out.status,200,JSON.stringify(out.data));
  payload.expectedVersion=1;if(mode==='partial')Object.assign(payload,{mode,quantity:3,boxes:1,sourceRemainingLayerCount:1});
  const beforeLots=JSON.parse(goods(h)[0].value).categories[0].lots,fees=h.sqlite.prepare('SELECT * FROM storage_fee_settlements').all();
  const first=await move(h,payload);assert.equal(first.status,200,JSON.stringify(first.data));
  const afterState=goods(h),afterRows=rows(h),category=JSON.parse(afterState[0].value).categories[0];
  assert.equal(afterRows.reduce((n,r)=>n+r.total_quantity,0),9);assert.equal(afterRows.reduce((n,r)=>n+r.total_boxes,0),2);
  assert.deepEqual(category.lots.map(l=>[l.id,l.stockId,l.quantity,l.boxes,l.snapshot.inboundDate,l.snapshot.itemVolumeM3,l.snapshot.storageRateUsd,l.snapshot.freeDays]),beforeLots.map(l=>[l.id,l.stockId,l.quantity,l.boxes,l.snapshot.inboundDate,l.snapshot.itemVolumeM3,l.snapshot.storageRateUsd,l.snapshot.freeDays]));
  if(mode==='partial'){assert.deepEqual(category.lots,beforeLots);assert.ok(category.stockIds.includes(first.data.destination.id));}
  assert.deepEqual(await move(h,payload),first);assert.deepEqual(goods(h),afterState);assert.deepEqual(rows(h),afterRows);assert.equal(logs(h).length,1);assert.deepEqual(h.sqlite.prepare('SELECT * FROM storage_fee_settlements').all(),fees);
 }finally{h.sqlite.close();}
});
for(const scenario of [
 {cap:2,existing:[1],target:2,want:{layers:[1,2],occupied:2,inRange:2,remaining:0,unlimited:false,over:false,full:true,state:'full'}},
 {cap:2,existing:[1,3,3],target:4,want:{layers:[1,3,4],occupied:3,inRange:1,remaining:1,unlimited:false,over:true,full:false,state:'over'}},
 {cap:0,existing:[1],target:4,want:{layers:[1,4],occupied:2,inRange:0,remaining:null,unlimited:true,over:false,full:false,state:'unlimited'}},
])test(`atomic response captures exact capacity ${scenario.want.state} including distinct sorted shelf numbers`,async()=>{
 const{h,payload}=setup();try{
  h.setting('warehouse_zones',[{id:'A',title:'A区',codes:['A1','A2'],layout:{A2:{capacityLayers:scenario.cap}}}]);
  for(const layer of scenario.existing)h.stock('A2',layer,0);payload.targetLayerCount=scenario.target;
  const first=await move(h,payload);assert.equal(first.status,200,JSON.stringify(first.data));assert.deepEqual(first.data.capacity,scenario.want);
  assert.equal(first.data.warning,scenario.want.over?'目标库位存在超出 2 层的货物，已允许移动':null);
  assert.deepEqual(await move(h,payload),first);
 }finally{h.sqlite.close();}
});
for(const mode of ['all','partial'])test(`${mode}: version race rolls back stock, audit, goods state and request success; same intent can succeed after transient guard race`,async()=>{
 const{h,payload}=setup();try{
  if(mode==='partial')Object.assign(payload,{mode,quantity:4,boxes:1,sourceRemainingLayerCount:1});
  const original=h.adapter.batch.bind(h.adapter),before=rows(h),beforeGoods=goods(h);let injected=false;
  h.adapter.batch=async q=>{if(!injected&&q.some(x=>x.moveMarker)){injected=true;h.sqlite.prepare('UPDATE stocks SET version=1 WHERE id=?').run(payload.id);}return original(q);};
  const prepare=h.adapter.prepare.bind(h.adapter);h.adapter.prepare=sql=>{const q=prepare(sql),bind=q.bind;q.bind=(...args)=>{const bound=bind(...args);if(/INSERT INTO wms_move_requests/.test(sql))bound.moveMarker=true;return bound;};return q;};
  const result=await move(h,payload);assert.equal(result.status,409);assert.equal(logs(h).length,0);assert.deepEqual(goods(h),beforeGoods);assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM wms_move_requests').get().n,0);
  h.sqlite.prepare('UPDATE stocks SET version=0 WHERE id=?').run(payload.id);assert.deepEqual(rows(h),before);
  assert.equal((await move(h,payload)).status,200);assert.equal(logs(h).length,1);
 }finally{h.sqlite.close();}
});
test('source physical location race fails final ledger guard and rolls back goods state with no success response',async()=>{
 const{h,payload}=setup();try{
  const beforeGoods=goods(h),original=h.adapter.batch.bind(h.adapter);let changed=false;
  const prepare=h.adapter.prepare.bind(h.adapter);h.adapter.prepare=sql=>{const q=prepare(sql),bind=q.bind;q.bind=(...args)=>{const bound=bind(...args);if(sql.startsWith('INSERT INTO wms_move_requests'))bound.moveMarker=true;return bound;};return q;};
  h.adapter.batch=async q=>{if(!changed&&q.some(x=>x.moveMarker)){changed=true;h.sqlite.prepare("UPDATE stocks SET location_code='A3' WHERE id=?").run(payload.id);}return original(q);};
  const result=await move(h,payload);assert.equal(result.status,409,JSON.stringify(result.data));assert.deepEqual(goods(h),beforeGoods);assert.equal(rows(h)[0].location_code,'A3');assert.equal(rows(h)[0].version,0);assert.equal(logs(h).length,0);assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM wms_move_requests').get().n,0);
 }finally{h.sqlite.close();}
});
test('concurrent retry reading source after winner commit replays instead of stale version conflict',async()=>{
 const{h,payload}=setup();try{
  let reads=0,release,releaseReaders;const committed=new Promise(r=>release=r),bothRead=new Promise(r=>releaseReaders=r),prepare=h.adapter.prepare.bind(h.adapter);
  h.adapter.prepare=sql=>{const q=prepare(sql),bind=q.bind;q.bind=(...args)=>{const bound=bind(...args);if(sql.startsWith('SELECT actor_id,fingerprint')){const first=bound.first;bound.first=async()=>{const result=await first();const order=++reads;if(order===1&&!result)await bothRead;if(order===2&&!result){releaseReaders();await committed;}return result;};}return bound;};return q;};
  const winner=move(h,payload).then(r=>{release();return r;});const retry=move(h,payload);
  const result=await Promise.all([winner,retry]);assert.equal(result[0].status,200);assert.deepEqual(result[1],result[0]);assert.equal(logs(h).length,1);
 }finally{h.sqlite.close();}
});
