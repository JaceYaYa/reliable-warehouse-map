import {readBackupJson} from './helpers/r2-memory.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {warehouseApiHarness} from './helpers/warehouse-api-harness.mjs';
import {memoryR2} from './helpers/r2-memory.mjs';
const tables=['stocks','audit_logs','goods_flow_state','wms_move_requests','wms_counts','wms_count_requests','wms_count_guards'];
const state=h=>JSON.stringify(tables.map(t=>h.sqlite.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()));
const login=h=>h.sqlite.prepare("INSERT OR IGNORE INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,1,'2099-01-01','now')").run(createHash('sha256').update('test-token-1').digest('hex'));
async function restore(h,data){const f=new FormData();f.set('file',new File([JSON.stringify(data)],'backup.json'));f.set('confirm','恢复备份');return h.load('app/api/backups/route.ts').PUT(new Request('http://local.test/api/backups',{method:'PUT',headers:{cookie:'wms_session=test-token-1'},body:f}));}
async function setup(){
 const objects=new Map(),h=warehouseApiHarness({BACKUPS:memoryR2(objects)});h.seedUser(1,null,'admin','boss');h.setting('warehouse_zones',[{id:'A',title:'A',codes:['A1','A2']}]);const id=h.stock('A1',1,0);
 h.sqlite.prepare("UPDATE stocks SET customer_name='备份客户',sku='BACKUP-SKU',pallet_label='0' WHERE id=?").run(id);
 const movePayload={requestId:randomUUID(),id,expectedVersion:0,mode:'all',targetLocation:'A2',targetLayerCount:2};const moved=await h.call('stocks/move','POST',movePayload);assert.equal(moved.status,200,JSON.stringify(moved.data));
 const actor={id:1,displayName:'backup-boss',role:'admin'},counter=h.load('lib/wms-counts.ts'),countPayload={requestId:randomUUID(),action:'create',location:'A2',blind:true},counted=await counter.changeCount(countPayload,actor);
 const backup=await h.call('backups','POST',{});assert.equal(backup.status,200,JSON.stringify(backup.data));const data=readBackupJson(objects.get(backup.data.key));
 return{h,objects,data,movePayload,moved,countPayload,counted,actor,counter};
}
test('V8 snapshot/restore replaces WMS reports and exact move/count replay ledgers, without surviving later records',async()=>{
 const{h,data,movePayload,moved,countPayload,counted,actor,counter}=await setup();try{
  assert.equal(data.version,9);assert.equal(data.wmsMoveRequests.length,1);assert.equal(data.wmsCounts.length,1);assert.equal(data.wmsCountRequests.length,1);assert.equal(data.wmsCountGuards,undefined);
  const before=state(h);await counter.changeCount({requestId:randomUUID(),action:'create',location:'A2',blind:false},actor);
  h.sqlite.exec("UPDATE stocks SET note='later'; INSERT INTO wms_count_guards VALUES ('transient',1)");
  const r=await restore(h,data);assert.equal(r.status,200,await r.text());assert.equal(state(h),before);login(h);
  assert.deepEqual(await h.call('stocks/move','POST',movePayload),moved);assert.equal(JSON.stringify(await counter.changeCount(countPayload,actor)),JSON.stringify(counted));assert.equal(state(h),before);
 }finally{h.sqlite.close();}
});
test('older V7 snapshot explicitly clears all WMS reports, replay ledgers and transient guards',async()=>{
 const{h,data}=await setup();try{
  const old={...data,version:7};delete old.wmsMoveRequests;delete old.wmsCounts;delete old.wmsCountRequests;
  h.sqlite.exec("INSERT INTO wms_count_guards VALUES ('leftover',1)");
  const r=await restore(h,old);assert.equal(r.status,200,await r.text());
  for(const table of tables.filter(t=>t.startsWith('wms_')))assert.equal(h.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0,table);
  assert.equal(h.sqlite.prepare('SELECT location_code FROM stocks').get().location_code,'A2');
 }finally{h.sqlite.close();}
});
test('invalid V8 WMS schema, identity, JSON and quantities reject before any business deletion',async()=>{
 const{h,data}=await setup();try{
  const before=state(h),mutations=[
   d=>delete d.wmsMoveRequests,d=>delete d.wmsCounts,d=>delete d.wmsCountRequests,
   d=>d.wmsMoveRequests.push({...d.wmsMoveRequests[0]}),d=>d.wmsCounts.push({...d.wmsCounts[0]}),d=>d.wmsCountRequests.push({...d.wmsCountRequests[0]}),
   d=>d.wmsMoveRequests[0].actorId=-1,d=>d.wmsMoveRequests[0].responseJson=null,d=>d.wmsMoveRequests[0].responseStatus=409,d=>d.wmsMoveRequests[0].fingerprint='{',
   d=>d.wmsCounts[0].status='adjusted',d=>d.wmsCounts[0].source='{',d=>d.wmsCounts[0].observations='{}',d=>d.wmsCounts[0].blind=5,
   d=>{const source=JSON.parse(d.wmsCounts[0].source);source.rows[0].boxes=-1;d.wmsCounts[0].source=JSON.stringify(source);},
   d=>d.wmsCountRequests[0].response='{}',d=>d.wmsCountRequests[0].fingerprint=JSON.stringify({requestId:randomUUID(),action:'create'}),
  ];
  for(const mutation of mutations){const invalid=structuredClone(data);mutation(invalid);const r=await restore(h,invalid);assert.equal(r.status,400,await r.text());assert.equal(state(h),before);}
 }finally{h.sqlite.close();}
});
test('historical actor identifiers survive staff deletion without inventing an account',async()=>{
 const{h,data}=await setup();try{
  data.wmsMoveRequests[0].actorId=42;data.wmsCounts[0].createdBy=42;data.wmsCountRequests[0].actorId=42;
  const r=await restore(h,data);assert.equal(r.status,200,await r.text());
  assert.equal(h.sqlite.prepare('SELECT actor_id FROM wms_move_requests').get().actor_id,42);assert.equal(h.sqlite.prepare('SELECT created_by FROM wms_counts').get().created_by,42);assert.equal(h.sqlite.prepare('SELECT 1 FROM users WHERE id=42').get(),undefined);
 }finally{h.sqlite.close();}
});
test('reviewed count preserves captured facts, differences and conclusion through restore without adjusting stock',async()=>{
 const{h,objects,counted,actor,counter}=await setup();try{
  const physical=h.sqlite.prepare('SELECT * FROM stocks').all(),id=counted.report.id;
  await counter.changeCount({requestId:randomUUID(),action:'submit',id,expectedVersion:0,observations:[{key:'stock:1',pieces:8,boxes:1}]},actor);
  const review=await counter.changeCount({requestId:randomUUID(),action:'review',id,expectedVersion:1,conclusion:'差异待人工核对，无库存调整'},actor);assert.equal(review.report.rows[0].pieceDifference,-2);assert.equal(review.report.rows[0].boxDifference,-1);
  const saved=await h.call('backups','POST',{}),data=readBackupJson(objects.get(saved.data.key)),before=state(h);
  h.sqlite.exec("UPDATE wms_counts SET conclusion='later',status='cancelled'");const r=await restore(h,data);assert.equal(r.status,200,await r.text());assert.equal(state(h),before);assert.deepEqual(h.sqlite.prepare('SELECT * FROM stocks').all(),physical);
  const record=h.sqlite.prepare('SELECT * FROM wms_counts').get();assert.equal(record.status,'reviewed');assert.equal(record.reviewed_by,1);assert.equal(record.conclusion,'差异待人工核对，无库存调整');assert.deepEqual(JSON.parse(record.observations),[{key:'stock:1',pieces:8,boxes:1}]);
 }finally{h.sqlite.close();}
});
