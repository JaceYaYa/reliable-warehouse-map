import test from 'node:test';
import assert from 'node:assert/strict';
import {gunzipSync} from 'node:zlib';
import {warehouseApiHarness} from './helpers/warehouse-api-harness.mjs';
import {memoryR2} from './helpers/r2-memory.mjs';

test('complete backup survives bounded D1 responses with no temporary database writes',async()=>{
 const bucket=memoryR2(),h=warehouseApiHarness({BACKUPS:bucket});
 try{
  h.seedUser(1,null,'admin','boss');h.stock('A1');
  const insert=h.sqlite.prepare("INSERT INTO audit_logs(user_id,user_name,action,entity_type,summary,before_snapshot,created_at) VALUES(1,'老板','修改','库存',?,?,'2026-11-01')");
  for(let i=0;i<160;i++)insert.run('历史'+i,'撤销原文'.repeat(2500));
  const original=h.sqlite.prepare('SELECT before_snapshot FROM audit_logs ORDER BY id').all();

  const batch=h.adapter.batch.bind(h.adapter);h.adapter.batch=async queries=>{
   const result=await batch(queries);
   assert.ok(Buffer.byteLength(JSON.stringify(result))<1_500_000,'D1 batch result must stay below the response cap');
   return result;
  };
  const result=await h.call('backups','POST',{action:'create'});
  assert.equal(result.status,200,JSON.stringify(result.data));assert.match(result.data.key,/\.json\.gz$/);
  const data=JSON.parse(gunzipSync(Buffer.from(bucket.objects.get(result.data.key))));
  assert.equal(data.auditLogs.length,160);assert.deepEqual(data.auditLogs.map(r=>r.beforeSnapshot),original.map(r=>r.before_snapshot));
  assert.equal(data.stocks[0].locationCode,'A1');assert.equal(data.users[0].displayName,'boss');
  assert.equal(h.sqlite.prepare('SELECT location_code FROM stocks').get().location_code,'A1');
  assert.ok(Buffer.from(bucket.objects.get(result.data.key)).length<JSON.stringify(data).length/10);
  assert.equal(h.sqlite.prepare("SELECT count(*) n FROM sqlite_master WHERE name='warehouse_backup_rows'").get().n,0);
 }finally{h.sqlite.close()}
});

test('old uncompressed and new compressed files both download as compact gzip and deny staff',async()=>{
 const bucket=memoryR2(),h=warehouseApiHarness({BACKUPS:bucket});
 try{h.seedUser(1,null,'admin','boss');h.seedUser(2,null,'employee','staff');
  const text=JSON.stringify({version:9,message:'原文'.repeat(5000)});await bucket.put('backups/manual-old.json',text);
  const route=h.load('app/api/backups/route.ts');
  const r=await route.GET(new Request('http://local.test/api/backups?download=backups%2Fmanual-old.json&compressed=1',{headers:{cookie:'wms_session=test-token-1'}}));
  assert.equal(r.status,200);assert.match(r.headers.get('Content-Disposition'),/\.json.gz/);assert.equal(gunzipSync(Buffer.from(await r.arrayBuffer())).toString(),text);
  const saved=await h.call('backups','POST',{action:'create'});
  const gz=await route.GET(new Request('http://local.test/api/backups?download='+encodeURIComponent(saved.data.key)+'&compressed=1',{headers:{cookie:'wms_session=test-token-1'}}));
  assert.deepEqual(Buffer.from(await gz.arrayBuffer()),Buffer.from(bucket.objects.get(saved.data.key)));
  const denied=await h.call('backups?download=backups%2Fmanual-old.json&compressed=1','GET',undefined,'test-token-2');assert.equal(denied.status,403);
 }finally{h.sqlite.close()}
});

test('backup failure cleans its temporary copy without altering business data or the earlier backup',async()=>{
 const bucket=memoryR2(),h=warehouseApiHarness({BACKUPS:bucket});
 try{h.seedUser(1,null,'admin','boss');h.stock('A1');await bucket.put('backups/manual-old.json','old');const before=h.sqlite.prepare('SELECT * FROM stocks').all();
  bucket.put=async()=>{throw new Error('storage unavailable')};const result=await h.call('backups','POST',{action:'create'});
  assert.equal(result.status,500);assert.equal(bucket.objects.get('backups/manual-old.json'),'old');assert.deepEqual(h.sqlite.prepare('SELECT * FROM stocks').all(),before);
  assert.equal(h.sqlite.prepare("SELECT count(*) n FROM sqlite_master WHERE name='warehouse_backup_rows'").get().n,0);
 }finally{h.sqlite.close()}
});

test('browser reads both compressed and old JSON files losslessly before segmented warehouse import',async()=>{
 const h=warehouseApiHarness();try{
  const {readBackupFile}=h.load('lib/backup-file-client.ts');
  const {gzipSync}=await import('node:zlib');
  const text=JSON.stringify({version:9,createdAt:'2026-11-06',goodsOperations:[{beforeCategory:'保留所有撤销原文'}]});
  for(const file of [new File([text],'old.json'),new File([gzipSync(text)],'new.json.gz')]){
   const result=await readBackupFile(file);assert.equal(result.text,text);assert.equal(await result.file.text(),text);assert.deepEqual(JSON.parse(JSON.stringify(result.source)),JSON.parse(text));
  }
  await assert.rejects(readBackupFile(new File(['broken'],'bad.json.gz')),/压缩/);
 }finally{h.sqlite.close()}
});

test('a complete snapshot over 60MB exports without a single oversized result and all rows read back',async()=>{
 const bucket=memoryR2(),h=warehouseApiHarness({BACKUPS:bucket});try{
  h.seedUser(1,null,'admin','boss');h.stock('A1');
  const value='历史快照'.repeat(35_000),insert=h.sqlite.prepare("INSERT INTO audit_logs(user_id,user_name,action,entity_type,summary,before_snapshot,created_at) VALUES(1,'老板','修改','库存',?,?,'2026-11-01')");
  for(let i=0;i<160;i++)insert.run('第'+i,value);
  const result=await h.call('backups','POST',{action:'create'});assert.equal(result.status,200,JSON.stringify(result.data));
  const raw=gunzipSync(Buffer.from(bucket.objects.get(result.data.key)));assert.ok(raw.length>60*1024*1024);
  const data=JSON.parse(raw);assert.equal(data.auditLogs.length,160);assert.ok(data.auditLogs.every(r=>r.beforeSnapshot===value));assert.equal(data.auditLogs[159].summary,'第159');
  const {prepareWarehouseHistoryBackup,warehouseNeedsHistoryChunks}=h.load('lib/warehouse-history-chunks.ts');assert.ok(warehouseNeedsHistoryChunks(data));
  const target=warehouseApiHarness({BACKUPS:memoryR2()});try{
   target.seedUser(1,null,'admin','xmcxmc');target.stock('A2');
   const id=crypto.randomUUID(),prepared=prepareWarehouseHistoryBackup(data,id);assert.ok(JSON.stringify(prepared.core).length<50*1024*1024);assert.equal(prepared.core.auditLogs.length,0);
   const form=new FormData();form.append('file',new File([JSON.stringify(prepared.core)],'core.json'));form.append('confirm','恢复备份');form.append('warehouseOnly','1');form.append('historyImportId',id);form.append('historyExpected',String(prepared.chunks.flat().length));form.append('historyAuditExpected',String(prepared.core.warehouseAuditExpected));
   const restored=await target.load('app/api/backups/route.ts').PUT(new Request('http://local.test/api/backups',{method:'PUT',headers:{cookie:'wms_session=test-token-1'},body:form}));assert.equal(restored.status,200,await restored.clone().text());
   for(const [index,rows]of prepared.chunks.entries()){
    const received=await target.call('backups','POST',{action:'warehouse-history',importId:id,index,rows});assert.equal(received.status,200,JSON.stringify(received.data));
    const retry=await target.call('backups','POST',{action:'warehouse-history',importId:id,index,rows});assert.equal(retry.status,200,JSON.stringify(retry.data));
   }
   assert.equal(target.sqlite.prepare('SELECT count(*) n FROM audit_logs').get().n,160);assert.equal(target.sqlite.prepare('SELECT before_snapshot FROM audit_logs WHERE id=160').get().before_snapshot,value);assert.equal(target.sqlite.prepare('SELECT username FROM users').get().username,'xmcxmc');assert.equal(target.sqlite.prepare('SELECT location_code FROM stocks').get().location_code,'A1');
  }finally{target.sqlite.close()}
 }finally{h.sqlite.close()}
});

test('SQL fragments preserve near-limit escaped values and never generate a 32-argument JSON function',async()=>{
 const bucket=memoryR2(),h=warehouseApiHarness({BACKUPS:bucket});try{
  h.seedUser(1,null,'admin','boss');h.stock('A1');const value='"'.repeat(1_100_000);h.sqlite.prepare("INSERT INTO settings(key,value,updated_at) VALUES('escaped_large_value',?,'now')").run(value);
  h.sqlite.function('json_object',{varargs:true},(...args)=>{assert.ok(args.length<=32,'D1 JSON function argument limit');return JSON.stringify(Object.fromEntries(Array.from({length:args.length/2},(_,i)=>[args[i*2],args[i*2+1]])));});
  const mixed='\ufeff'+'仓'.repeat(5500)+'😀\0after';h.sqlite.prepare("INSERT INTO settings(key,value,updated_at) VALUES('nul_and_utf8',?,'now')").run(mixed);
  const result=await h.call('backups','POST',{action:'create'});assert.equal(result.status,200,JSON.stringify(result.data));const data=JSON.parse(gunzipSync(Buffer.from(bucket.objects.get(result.data.key))));assert.equal(data.settings.find(r=>r.key==='escaped_large_value').value,value);assert.equal(data.settings.find(r=>r.key==='nul_and_utf8').value,mixed);
 }finally{h.sqlite.close()}
});
