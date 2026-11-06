import test from 'node:test';
import assert from 'node:assert/strict';
import {warehouseApiHarness} from './helpers/warehouse-api-harness.mjs';
import {memoryR2,readBackupJson} from './helpers/r2-memory.mjs';

test('complete backup reads bounded source pages without writing any temporary database copy',async()=>{
 const bucket=memoryR2(),h=warehouseApiHarness({BACKUPS:bucket});try{
  h.seedUser(1,null,'admin','boss');h.stock('A1');
  const prepare=h.adapter.prepare.bind(h.adapter);h.adapter.prepare=sql=>{assert.doesNotMatch(sql,/INSERT INTO warehouse_backup_rows|WITH RECURSIVE base/i);return prepare(sql);};
  const result=await h.call('backups','POST',{action:'create'});assert.equal(result.status,200,JSON.stringify(result.data));assert.equal(readBackupJson(bucket.objects.get(result.data.key)).stocks[0].locationCode,'A1');
 }finally{h.sqlite.close()}
});

test('concurrent source changes reject mixed backup data without publishing a file',async()=>{
 const bucket=memoryR2(),h=warehouseApiHarness({BACKUPS:bucket});try{
  h.seedUser(1,null,'admin','boss');h.stock('A1');
  const prepare=h.adapter.prepare.bind(h.adapter);let changed=false;
  h.adapter.prepare=sql=>{const wrap=q=>({...q,bind:(...v)=>wrap(q.bind(...v)),all:async()=>{const result=await q.all();if(!changed&&/FROM "stocks"/.test(sql)){changed=true;h.sqlite.exec("UPDATE stocks SET product='并发修改'");}return result;}});return wrap(prepare(sql));};
  const result=await h.call('backups','POST',{action:'create'});assert.equal(result.status,409,JSON.stringify(result.data));assert.match(result.data.error,/变化/);assert.equal([...bucket.objects.keys()].filter(k=>k.startsWith('backups/')).length,0);
 }finally{h.sqlite.close()}
});

test('opening backups does not launch a large automatic job before a successful manual verification',async()=>{
 const bucket=memoryR2(),h=warehouseApiHarness({BACKUPS:bucket});try{h.seedUser(1,null,'admin','boss');const result=await h.call('backups','POST',{action:'auto'});assert.equal(result.status,200);assert.equal(result.data.paused,true);assert.equal([...bucket.objects.keys()].filter(k=>k.startsWith('backups/')).length,0);}finally{h.sqlite.close()}
});

test('many small historical rows use fewer than 100 source queries instead of one query per 32 rows',async()=>{
 const bucket=memoryR2(),h=warehouseApiHarness({BACKUPS:bucket});try{
  h.seedUser(1,null,'admin','boss');const insert=h.sqlite.prepare("INSERT INTO audit_logs(user_id,user_name,action,entity_type,summary,created_at) VALUES(1,'老板','修改','库存',?,'2026-11-01')");h.sqlite.exec('BEGIN');for(let i=0;i<10000;i++)insert.run('记录'+i);h.sqlite.exec('COMMIT');
  let reads=0;const prepare=h.adapter.prepare.bind(h.adapter);h.adapter.prepare=sql=>{if(/WITH page AS MATERIALIZED|WITH candidates AS MATERIALIZED/.test(sql))reads++;return prepare(sql);};const result=await h.call('backups','POST',{action:'create'});assert.equal(result.status,200,JSON.stringify(result.data));assert.ok(reads<100,`source queries ${reads}`);assert.equal(readBackupJson(bucket.objects.get(result.data.key)).auditLogs.length,10000);
 }finally{h.sqlite.close()}
});
