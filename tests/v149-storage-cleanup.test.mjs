import test from 'node:test';
import assert from 'node:assert/strict';
import {gunzipSync,gzipSync} from 'node:zlib';
import {warehouseApiHarness} from './helpers/warehouse-api-harness.mjs';
import {memoryR2} from './helpers/r2-memory.mjs';

test('cleanup deletes only the original raw backup after exact compressed roundtrip verification',async()=>{
 const bucket=memoryR2(),h=warehouseApiHarness({BACKUPS:bucket});try{
  h.seedUser(1,null,'admin','boss');const key='backups/daily-ny-2026-11-03.json',text=JSON.stringify({history:'旧记录\0😀'.repeat(5000)});
  await bucket.put(key,text,{customMetadata:{kind:'daily',createdAt:'2026-11-03T04:00:00Z'}});const result=await h.call('backups','POST',{action:'storage-cleanup',key});
  assert.equal(result.status,200,JSON.stringify(result.data));assert.equal(result.data.verified,true);assert.ok(result.data.freedBytes>0);assert.equal(bucket.objects.has(key),false);assert.equal(gunzipSync(Buffer.from(bucket.objects.get(key+'.gz'))).toString(),text);
  const listed=await h.call('backups');assert.equal(listed.data.backups[0].uploaded,'2026-11-03T04:00:00Z');
 }finally{h.sqlite.close()}
});

test('different compressed content and non-backup keys never remove the original or attachments',async()=>{
 const bucket=memoryR2(),h=warehouseApiHarness({BACKUPS:bucket});try{
  h.seedUser(1,null,'admin','boss');const key='backups/manual-keep.json',text='原始内容'.repeat(1000);await bucket.put(key,text);await bucket.put(key+'.gz',gzipSync('different'));await bucket.put('workorders/keep','attachment');
  assert.equal((await h.call('backups','POST',{action:'storage-cleanup',key:'workorders/keep'})).status,400);const result=await h.call('backups','POST',{action:'storage-cleanup',key});assert.equal(result.status,500);assert.equal(bucket.objects.get(key),text);assert.equal(bucket.objects.get('workorders/keep'),'attachment');
 }finally{h.sqlite.close()}
});

test('only one backup or cleanup job can hold the R2 lease across independent callers',async()=>{
 const bucket=memoryR2(),h=warehouseApiHarness({BACKUPS:bucket});try{
  const {claimBackupJob}=h.load('lib/backup-job.ts'),first=await claimBackupJob();await assert.rejects(claimBackupJob(),/正在/);await first.release();const next=await claimBackupJob();await next.release(true);await assert.rejects(claimBackupJob(),/30秒/);
 }finally{h.sqlite.close()}
});

test('migration removes only the obsolete backup copy and all source mutations advance the read fence',()=>{
 const h=warehouseApiHarness();try{
  assert.equal(h.sqlite.prepare("SELECT count(*) n FROM sqlite_master WHERE name='warehouse_backup_rows'").get().n,0);
  const revision=()=>h.sqlite.prepare('SELECT revision FROM warehouse_backup_revision WHERE id=1').get()?.revision??0;
  const before=revision();h.stock('A1');const inserted=revision();assert.ok(inserted>before);h.sqlite.exec("UPDATE stocks SET note='修改'");assert.ok(revision()>inserted);const updated=revision();h.sqlite.exec('DELETE FROM stocks');assert.ok(revision()>updated);
  const triggers=h.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'warehouse_backup_%'").all();assert.equal(triggers.length,51);
 }finally{h.sqlite.close()}
});

test('automatic cleanup skips an incompressible original instead of selecting it forever',async()=>{
 const bucket=memoryR2(),h=warehouseApiHarness({BACKUPS:bucket});try{
  h.seedUser(1,null,'admin','boss');let seed=12345;const bytes=Uint8Array.from({length:4096},()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;});assert.ok(gzipSync(bytes).length>=bytes.length);
  const key='backups/manual-random.json';await bucket.put(key,bytes);const first=await h.call('backups','POST',{action:'auto'});assert.equal(first.status,200,JSON.stringify(first.data));assert.equal(first.data.cleanup.skipped,true);const second=await h.call('backups','POST',{action:'auto'});assert.equal(second.status,200);assert.equal(second.data.cleanupNext,undefined);assert.ok(bucket.objects.has(key));assert.ok(!bucket.objects.has(key+'.gz'));
 }finally{h.sqlite.close()}
});
