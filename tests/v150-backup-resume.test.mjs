import test from 'node:test';
import assert from 'node:assert/strict';
import {warehouseApiHarness} from './helpers/warehouse-api-harness.mjs';
import {memoryR2,readBackupJson} from './helpers/r2-memory.mjs';

test('backup progresses in bounded requests, resumes without duplicates, and publishes only a complete file',async()=>{
 const bucket=memoryR2(),h=warehouseApiHarness({BACKUPS:bucket});try{
  h.seedUser(1,null,'admin','boss');h.stock('A1',2,.5);
  const insert=h.sqlite.prepare("INSERT INTO audit_logs(user_id,user_name,action,entity_type,summary,before_snapshot,created_at) VALUES(1,'老板','修改','库存',?,?,'2026-11-01')");
  const text='\ufeff中😀\0'+ '历史'.repeat(30000);for(let i=0;i<90;i++)insert.run('记录'+i,text);
  const jobs=h.load('lib/backup-export-job.ts');let result=await jobs.beginBackupExport('manual','老板');
  assert.equal(result.pending,true);const id=result.backupJob.id;
  assert.equal((await jobs.beginBackupExport('manual','老板')).backupJob.id,id);
  let queries=0,steps=0;const prepare=h.adapter.prepare.bind(h.adapter);h.adapter.prepare=sql=>{if(/WITH candidates AS MATERIALIZED/.test(sql))queries++;return prepare(sql)};
  while(result.pending){const before=queries;assert.equal([...bucket.objects.keys()].filter(k=>k.startsWith('backups/')).length,0);result=await jobs.advanceBackupExport(id);assert.ok(queries-before<=4);assert.ok(++steps<100);}
  assert.ok(steps>5);assert.equal(result.verified,true);
  const decoded=readBackupJson(bucket.objects.get(result.key));assert.equal(decoded.auditLogs.length,90);assert.equal(new Set(decoded.auditLogs.map(x=>x.id)).size,90);assert.ok(decoded.auditLogs.every(x=>x.beforeSnapshot===text));assert.equal(decoded.stocks[0].palletCount,.5);
  assert.equal([...bucket.objects.keys()].filter(k=>/\/part-/.test(k)).length,0);
  assert.equal((await jobs.advanceBackupExport(id)).key,result.key);
 }finally{h.sqlite.close()}
});

test('source change between requests aborts, cleans temporary parts, and leaves previous backup untouched',async()=>{
 const bucket=memoryR2(),h=warehouseApiHarness({BACKUPS:bucket});try{
  h.seedUser(1,null,'admin','boss');h.stock('A1');await bucket.put('backups/previous.json','previous');
  const jobs=h.load('lib/backup-export-job.ts'),start=await jobs.beginBackupExport('manual','老板');
  await jobs.advanceBackupExport(start.backupJob.id);h.sqlite.exec("UPDATE stocks SET product='changed'");
  await assert.rejects(jobs.advanceBackupExport(start.backupJob.id),/变化/);
  assert.equal(bucket.objects.get('backups/previous.json'),'previous');assert.equal([...bucket.objects.keys()].filter(k=>k.startsWith('backups/')).length,1);assert.equal([...bucket.objects.keys()].filter(k=>/\/part-/.test(k)).length,0);
 }finally{h.sqlite.close()}
});

test('manual HTTP request returns progress instead of holding a connection for the full export',async()=>{
 const bucket=memoryR2(),h=warehouseApiHarness({BACKUPS:bucket});try{
  h.seedUser(1,null,'admin','boss');h.stock('A1');let reads=0;const prepare=h.adapter.prepare.bind(h.adapter);h.adapter.prepare=sql=>{if(/WITH candidates AS MATERIALIZED/.test(sql))reads++;return prepare(sql)};
  let result=await h.call('backups','POST',{action:'create'},undefined,{drain:false});assert.equal(result.data.pending,true);assert.equal(reads,0);
  const id=result.data.backupJob.id;
  while(result.data.pending){const start=reads;result=await h.call('backups','POST',{action:'backup-step',jobId:id},undefined,{drain:false});assert.equal(result.status,200,JSON.stringify(result.data));assert.ok(reads-start<=4);}
  assert.equal(result.data.verified,true);assert.ok(bucket.objects.has(result.data.key));
 }finally{h.sqlite.close()}
});
