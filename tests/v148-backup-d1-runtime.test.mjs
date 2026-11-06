import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {warehouseApiHarness} from './helpers/warehouse-api-harness.mjs';
import {memoryR2,readBackupJson} from './helpers/r2-memory.mjs';
const require=createRequire(import.meta.url);
const {Miniflare}=createRequire(require.resolve('wrangler/package.json'))('miniflare');

test('complete backup SQL executes in the actual Workers D1 runtime with its production SQL limits',async()=>{
 const runtime=new Miniflare({modules:true,script:'export default {fetch(){return new Response("test")}}',compatibilityDate:'2026-05-15',d1Databases:{DB:'backup-d1-runtime-test'}});
 let h;
 try{
  const db=await runtime.getD1Database('DB'),bucket=memoryR2();h=warehouseApiHarness({DB:db,BACKUPS:bucket});
  for(const {sql}of h.sqlite.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY name").all())await db.prepare(sql).run();
  for(const {sql}of h.sqlite.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'warehouse_backup_%'").all())await db.prepare(sql).run();
  h.stock('A1',2,.5);
  const row=h.sqlite.prepare('SELECT * FROM stocks').get(),columns=Object.keys(row);
  await db.prepare(`INSERT INTO stocks(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).bind(...Object.values(row)).run();
  const text='\ufeff'+('中😀'.repeat(18000))+'\0after';
  await db.prepare("INSERT INTO settings(key,value,updated_at) VALUES('unicode_fixture',?,'now')").bind(text).run();
  const history='历史快照'.repeat(35_000);
  for(let start=0;start<160;start+=10)await db.batch(Array.from({length:10},(_,i)=>db.prepare("INSERT INTO audit_logs(user_id,user_name,action,entity_type,summary,before_snapshot,created_at) VALUES(1,'老板','修改','库存',?,?,'2026-11-01')").bind('第'+(start+i),history)));
  const copy=await h.load('lib/backup-snapshot-stream.ts').backupSnapshotStream('2026-11-06T04:00:00Z');
  try{
   const result=JSON.parse(await new Response(copy.stream).text());
   assert.equal(result.stocks[0].locationCode,'A1');assert.equal(result.stocks[0].layerCount,2);assert.equal(result.stocks[0].palletCount,.5);assert.equal(result.stocks[0].catalogItemId,null);
   assert.equal(result.settings.find(r=>r.key==='unicode_fixture').value,text);
   assert.equal(result.storageFeeSettlements.length,0);
   assert.equal(result.auditLogs.length,160);assert.ok(result.auditLogs.every(r=>r.beforeSnapshot===history));
   assert.ok(Buffer.byteLength(JSON.stringify(result))>60*1024*1024);
  }finally{await copy.cleanup();}
  const jobs=h.load('lib/backup-export-job.ts');let progress=await jobs.beginBackupExport('manual','老板'),steps=0;
  while(progress.pending){progress=await jobs.advanceBackupExport(progress.backupJob.id);assert.ok(++steps<250);}
  assert.ok(steps>10);assert.equal(progress.verified,true);
  const exported=readBackupJson(bucket.objects.get(progress.key));assert.equal(exported.auditLogs.length,160);assert.ok(exported.auditLogs.every(r=>r.beforeSnapshot===history));assert.equal(exported.settings.find(r=>r.key==='unicode_fixture').value,text);
 }finally{h?.sqlite.close();await runtime.dispose();}
});
