import {readBackupJson} from './helpers/r2-memory.mjs';
import {memoryR2} from './helpers/r2-memory.mjs';
import {gunzipSync} from 'node:zlib';
import test from 'node:test';import assert from 'node:assert/strict';import {warehouseApiHarness} from './helpers/warehouse-api-harness.mjs';
test('仓库日期按纽约本地日，夏令时和冬令时不按固定偏移',()=>{const h=warehouseApiHarness();try{const {warehouseTodayDate}=h.load('lib/warehouse-time.ts');assert.equal(warehouseTodayDate(new Date('2026-07-01T03:59:59Z')),'2026-06-30');assert.equal(warehouseTodayDate(new Date('2026-07-01T04:00:00Z')),'2026-07-01');assert.equal(warehouseTodayDate(new Date('2026-01-01T04:59:59Z')),'2025-12-31');assert.equal(warehouseTodayDate(new Date('2026-01-01T05:00:00Z')),'2026-01-01');}finally{h.sqlite.close()}});
test('记录纽约一天的边界自动DST：春23小时，秋25小时',()=>{const h=warehouseApiHarness();try{const {recordDateBoundary}=h.load('lib/record-filters.ts');assert.equal(recordDateBoundary('2026-03-08'),'2026-03-08T05:00:00.000Z');assert.equal(recordDateBoundary('2026-03-08',true),'2026-03-09T04:00:00.000Z');assert.equal(recordDateBoundary('2026-11-01'),'2026-11-01T04:00:00.000Z');assert.equal(recordDateBoundary('2026-11-01',true),'2026-11-02T05:00:00.000Z');assert.equal(recordDateBoundary('2026-10-06'),'2026-10-06T04:00:00.000Z');}finally{h.sqlite.close()}});
test('仓储计算默认截止为纽约当天，按日期差计天不因DST差一小时变更历史日数',()=>{const h=warehouseApiHarness();try{const {chinaTodayDate,calculateStorageFee}=h.load('lib/pricing.ts');assert.equal(chinaTodayDate(new Date('2026-10-07T02:00:00Z')),'2026-10-06');assert.equal(calculateStorageFee({inboundDate:'2026-03-07',endDate:'2026-03-09',billingMode:'item',quantity:1,itemVolumeM3:1,rateUsdM3Day:1,freeDays:0}).storageDays,2);}finally{h.sqlite.close()}});

test('纽约每周只更新一份压缩自动备份，下载为完整 JSON，可恢复且兼容旧文件',async()=>{
 const objects=new Map(),h=warehouseApiHarness({BACKUPS:memoryR2(objects)});
 try{
  h.seedUser(1,null,'admin','boss');
  h.stock('A1');
  h.sqlite.prepare("INSERT INTO audit_logs(user_id,user_name,action,entity_type,entity_id,summary,created_at) VALUES(1,'旧仓管','入库','库位','A1','旧操作','2024-01-02T03:00:00Z')").run();
  const day=h.load('lib/warehouse-time.ts').warehouseTodayDate();
  const weekly='backups/weekly-latest.json.gz';
  const legacy='backups/daily-ny-2020-01-01.json';
  objects.set(legacy,'{"version":9}');
  await h.call('backups','POST',{action:'create'});
  const result=await h.call('backups','POST',{action:'auto'});
  assert.equal(result.status,200,JSON.stringify(result.data));
  assert.equal(result.data.archived,1);
  assert.equal(h.sqlite.prepare('SELECT count(*) n FROM audit_logs').get().n,0);
  const download=key=>h.load('app/api/backups/route.ts').GET(new Request(`http://local.test/api/backups?download=${encodeURIComponent(key)}`,{headers:{cookie:'wms_session=test-token-1'}}));
  for(const key of [weekly]){
   assert.ok(objects.has(key),`压缩备份缺失 ${key}`);
   const stored=Buffer.from(objects.get(key)),expected=gunzipSync(stored).toString('utf8');
   assert.ok(stored.length<Buffer.byteLength(expected));
   const response=await download(key);
   assert.equal(response.status,200);
   assert.match(response.headers.get('Content-Disposition'),/\.json"$/);
   assert.equal(await response.text(),expected);
   assert.equal(JSON.parse(expected).stocks[0].locationCode,'A1');
  }
  assert.equal(await (await download(legacy)).text(),'{"version":9}');
  assert.ok(objects.has(`maintenance/new-york-${day}.json`));
  const archive=[...objects.keys()].find(key=>key.startsWith('archives/audit-'));
  assert.match(archive,/audit-2024-01-01-to-2024-01-01-/);
  assert.equal(readBackupJson(objects.get(archive)).recordCount,1);
  const original=objects.get(weekly);
  assert.equal((await h.call('backups','POST',{action:'auto'})).status,200);
  assert.equal(objects.get(weekly),original);

  const file=new File([await (await download(weekly)).text()],'weekly.json',{type:'application/json'});
  h.sqlite.exec("UPDATE stocks SET total_quantity=1");
  const form=new FormData();
  form.append('file',file);
  form.append('confirm','恢复备份');
  const restored=await h.load('app/api/backups/route.ts').PUT(new Request('http://local.test/api/backups',{method:'PUT',headers:{cookie:'wms_session=test-token-1'},body:form}));
  assert.equal(restored.status,200,await restored.text());
  assert.equal(h.sqlite.prepare('SELECT total_quantity FROM stocks').get().total_quantity,10);
 }finally{h.sqlite.close();}
});

test('新一周替换上一份前先校验，写入失败时上一份仍可用',async()=>{
 const bucket=memoryR2(),key='backups/weekly-latest.json.gz';
 const put=bucket.put;
 let fail=true;
 bucket.put=(name,value,options)=>fail&&name===key?Promise.reject(new Error('模拟写入失败')):put(name,value,options);
 const h=warehouseApiHarness({BACKUPS:bucket});
 try{
  h.seedUser(1,null,'admin','boss');
  await put('maintenance/backup-v149-verified.json','{}');
  await put(key,'old',{customMetadata:{week:'2000-01-03',kind:'weekly'}});
  assert.equal((await h.call('backups','POST',{action:'auto'})).status,500);
  assert.equal(bucket.objects.get(key),'old');
  fail=false;
  const lease=JSON.parse(await (await bucket.get('maintenance/backup-job-v149.json')).text());assert.equal(lease.status,'cooldown');
  await put('maintenance/backup-job-v149.json',JSON.stringify({...lease,expiresAt:0}));
  assert.equal((await h.call('backups','POST',{action:'auto'})).status,200);
  assert.equal(JSON.parse(gunzipSync(Buffer.from(bucket.objects.get(key)))).version,9);
  assert.deepEqual([...bucket.objects.keys()].filter(key=>key.startsWith('backups/')),[key]);
 }finally{h.sqlite.close();}
});
