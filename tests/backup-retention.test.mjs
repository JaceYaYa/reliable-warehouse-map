import {readBackupJson} from './helpers/r2-memory.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {warehouseApiHarness} from './helpers/warehouse-api-harness.mjs';
import {memoryR2} from './helpers/r2-memory.mjs';
test('manual save verifies persisted content and keeps newest 100 manual backups after paginated listing',async()=>{
 const r2=memoryR2(),h=warehouseApiHarness({BACKUPS:r2});h.seedUser(1,null,'admin','boss');
 try {for(let i=0;i<1205;i++)await r2.put(`backups/manual-2020-${String(i).padStart(4,'0')}.json`,'{}');await r2.put('archives/keep.json','{}');await r2.put('backups/before-restore-keep.json','{}');
 const result=await h.call('backups','POST',{action:'create'});assert.equal(result.status,200);assert.equal(result.data.verified,true);assert.ok(readBackupJson(r2.objects.get(result.data.key)).stocks);assert.equal([...r2.objects.keys()].filter(k=>k.startsWith('backups/manual-')).length,100);assert.ok(r2.objects.has('archives/keep.json'));assert.ok(r2.objects.has('backups/before-restore-keep.json'));const listed=await h.call('backups');assert.equal(listed.data.backups[0].key,result.data.key);assert.equal(listed.data.retention.manual,100);
 }finally{h.sqlite.close()}
});
test('failed or unreadable save never claims success or deletes earlier backup',async()=>{
 const r2=memoryR2();await r2.put('backups/manual-old.json','old');const put=r2.put;r2.put=async(key,...args)=>key.startsWith('backups/')?null:put(key,...args);const h=warehouseApiHarness({BACKUPS:r2});h.seedUser(1,null,'admin','boss');
 try{const r=await h.call('backups','POST',{action:'create'});assert.equal(r.status,500);assert.match(r.data.error,/未能核验/);assert.ok(r2.objects.has('backups/manual-old.json'));}finally{h.sqlite.close()}
});
