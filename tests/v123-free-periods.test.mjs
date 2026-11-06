import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {warehouseApiHarness} from './helpers/warehouse-api-harness.mjs';

async function domain(){assert.ok(existsSync('lib/storage-free-periods.ts'),'free-period domain must exist');return import('../lib/storage-free-periods.ts');}
const row=(overrides={})=>({id:'stock:1',kind:'stock',customerName:'客户A',productName:'手机',sku:'SKU-A',locationCode:'A1',layer:1,inboundDate:'2026-10-01',...overrides});
const settingsRows=(freeDays=30)=>[{key:'pricing_defaults',value:JSON.stringify({defaultFreeDays:freeDays,defaultRatePerM3Day:.7})}];
function fixture(){const h=warehouseApiHarness();h.seedUser(1,null,'admin','boss');h.seedUser(2,['pricing.manage'],'admin');h.seedUser(3,['pricing.manage'],'employee');h.setting('pricing_defaults',{defaultFreeDays:30,defaultRatePerM3Day:.7});return h;}
const tables=['stocks','settings','carton_receipts','carton_operations','goods_flow_state','goods_operations','storage_fee_settlements','audit_logs','sessions','users'];
const snapshot=h=>JSON.stringify(tables.map(t=>[t,h.sqlite.prepare(`SELECT * FROM ${t}`).all()]));
const call=(h,query='asOf=2026-10-24',token='test-token-1')=>h.call(`pricing/free-periods?${query}`,'GET',undefined,token);

test('customer layer deadlines use oldest remaining batch until emptied, preserve physical dates and ignore search narrowing',async()=>{
 const d=await domain(),old=row({inboundDate:'2026-09-01'}),fresh=row({id:'stock:2',inboundDate:'2026-10-20',sku:'NEW'}),other=row({id:'stock:3',customerName:'客户B',inboundDate:'2026-10-20'}),occupants=[old,fresh,other],before=structuredClone(occupants);
 const r=d.buildStorageFreePeriods({occupants,settingsRows:settingsRows(),asOf:'2026-10-24',q:'NEW'});
 assert.equal(r.rows.length,1);assert.equal(r.rows[0].inboundDate,'2026-10-20');assert.equal(r.rows[0].billingInboundDate,'2026-09-01');assert.equal(r.rows[0].chargeStartDate,'2026-10-01');assert.equal(r.rows[0].status,'expired');assert.deepEqual(occupants,before);
 const emptied=d.buildStorageFreePeriods({occupants:[fresh,other],settingsRows:settingsRows(),asOf:'2026-10-24'});
 assert.ok(emptied.rows.every(r=>r.billingInboundDate==='2026-10-20'&&r.status==='free'));
 const uncertain=d.buildStorageFreePeriods({occupants,settingsRows:settingsRows(),asOf:'2026-10-24',arrivalReviewIds:[old.id]});
 assert.equal(uncertain.rows.find(r=>r.id===fresh.id).status,'review');assert.equal(uncertain.rows.find(r=>r.id===fresh.id).chargeStartDate,null);assert.equal(uncertain.rows.find(r=>r.id===other.id).status,'free');
});

test('independent customer layers distinguish today, expired, seven days and eight days',async()=>{
 const d=await domain(),result=d.buildStorageFreePeriods({occupants:[row(),row({id:'2',layer:2,inboundDate:'2026-10-02'}),row({id:'3',layer:3,inboundDate:'2026-09-24'}),row({id:'4',layer:4,inboundDate:'2026-09-23'})],settingsRows:settingsRows(),asOf:'2026-10-24'});
 assert.equal(result.nearDays,7);assert.equal(result.rows.length,4);
 const byId=new Map(result.rows.map(r=>[r.id,r]));
 assert.deepEqual([byId.get('stock:1').status,byId.get('stock:1').daysRemaining,byId.get('stock:1').freeUntilDate,byId.get('stock:1').chargeStartDate],['near',7,'2026-10-30','2026-10-31']);
 assert.equal(byId.get('2').status,'free');assert.equal(byId.get('2').daysRemaining,8);
 assert.deepEqual([byId.get('3').status,byId.get('3').daysRemaining,byId.get('3').daysOverdue],['expired',0,0]);
 assert.deepEqual([byId.get('4').status,byId.get('4').daysRemaining,byId.get('4').daysOverdue],['expired',0,1]);
 assert.deepEqual(result.summary,{expiredCount:2,nearCount:1,reviewCount:0});
});

test('customer overrides including zero take precedence over configured default and ignore stock batch fees',async()=>{
 const d=await domain(),s=[...settingsRows(12),{key:'pricing_customer_override:客户A',value:JSON.stringify({customerName:'客户A',freeDays:0})}];
 const r=d.buildStorageFreePeriods({occupants:[row({freeDays:999,palletCount:0,itemVolumeM3:999}),row({id:'b',customerName:'客户B',freeDays:1})],settingsRows:s,asOf:'2026-10-01'});
 const a=r.rows.find(x=>x.customerName==='客户A'),b=r.rows.find(x=>x.customerName==='客户B');
 assert.equal(a.freeDays,0);assert.equal(a.freeUntilDate,null);assert.equal(a.chargeStartDate,'2026-10-01');assert.equal(a.status,'expired');assert.equal(a.daysOverdue,0);
 assert.equal(b.freeDays,12);assert.equal(b.chargeStartDate,'2026-10-13');
});

test('calendar-day arithmetic handles leap day, DST and month/year edges without local clock drift',async()=>{
 const d=await domain();
 for(const [inboundDate,freeDays,asOf,start,remaining] of [['2024-02-28',2,'2024-02-29','2024-03-01',1],['2026-03-07',2,'2026-03-08','2026-03-09',1],['2026-10-31',2,'2026-11-01','2026-11-02',1],['2025-12-31',1,'2026-01-01','2026-01-01',0]]){
  const [r]=d.buildStorageFreePeriods({occupants:[row({inboundDate})],settingsRows:settingsRows(freeDays),asOf}).rows;assert.equal(r.chargeStartDate,start);assert.equal(r.daysRemaining,remaining);
 }
});

test('unknown owner or invalid actual date stays pending; malformed configured free days never silently become zero',async()=>{
 const d=await domain();
 const rows=d.buildStorageFreePeriods({occupants:[row({customerName:''}),row({id:'bad-date',inboundDate:'2026-02-30'}),row({id:'unknown',inboundDate:''})],settingsRows:settingsRows(),asOf:'2026-10-24'}).rows;
 assert.equal(rows.length,3);assert.ok(rows.every(r=>r.status==='review'&&r.daysRemaining===null&&r.daysOverdue===null));
 assert.equal(rows.find(r=>r.id==='bad-date').chargeStartDate,null);
 const bad=d.buildStorageFreePeriods({occupants:[row()],settingsRows:[{key:'pricing_defaults',value:'{"defaultFreeDays":"wrong"}'}],asOf:'2026-10-24'}).rows[0];assert.equal(bad.status,'review');assert.equal(bad.freeDays,null);
 for(const asOf of ['2026-02-30','2026-1-01','0000-01-01','2026-10-24T00:00:00Z'])assert.throws(()=>d.buildStorageFreePeriods({occupants:[],settingsRows:[],asOf}));
 for(const nearDays of [-1,1.2,NaN,Infinity,36501,'7'])assert.throws(()=>d.buildStorageFreePeriods({occupants:[],settingsRows:[],asOf:'2026-10-24',nearDays}));
});

test('customer selection search and status filter preserve per-record details and meaningful counts',async()=>{
 const d=await domain(),occupants=[row(),row({id:'2',customerName:'客户B',sku:'SECOND'}),row({id:'3',layer:2,inboundDate:'2026-10-02'})];
 const r=d.buildStorageFreePeriods({occupants,settingsRows:settingsRows(),asOf:'2026-10-24',customers:['客户A'],q:'sku-a',status:'near'});
 assert.equal(r.rows.length,1);assert.equal(r.rows[0].customerName,'客户A');assert.deepEqual(r.customers,['客户A','客户B']);
 assert.equal(d.buildStorageFreePeriods({occupants,settingsRows:settingsRows(),asOf:'2026-10-24',nearDays:0}).rows.filter(r=>r.status==='near').length,0);
});

test('free period API is boss-only and forbids caching for anonymous/admin/employee and invalid queries',async()=>{
 assert.ok(existsSync('app/api/pricing/free-periods/route.ts'),'free-period API must exist');const h=fixture();try{
  const route=h.load('app/api/pricing/free-periods/route.ts');assert.equal(route.POST,undefined);assert.equal(route.PATCH,undefined);
  for(const [token,status] of [['invalid',401],['test-token-2',403],['test-token-3',403]]){const r=await route.GET(new Request('http://local.test/api/pricing/free-periods',{headers:{cookie:`wms_session=${token}`}}));assert.equal(r.status,status);assert.equal(r.headers.get('cache-control'),'no-store');}
  for(const q of ['asOf=2026-02-30','asOf=','nearDays=','nearDays=-1','nearDays=7.5','nearDays=36501','nearDays=abc','asOf=2026-10-24&asOf=2026-10-25','status=wrong','q='+('a'.repeat(201)),'unknown=1'])assert.equal((await call(h,q)).status,400,q);
  const response=await route.GET(new Request('http://local.test/api/pricing/free-periods?asOf=2026-10-24',{headers:{cookie:'wms_session=test-token-1'}}));assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
 }finally{h.sqlite.close();}
});

test('API reads only positive actual stocks and effective carton placement dates, aliases and clients without any state write',async()=>{
 assert.ok(existsSync('app/api/pricing/free-periods/route.ts'),'free-period API must exist');const h=fixture();try{
  const old=h.stock('旧A1',1,999),fresh=h.stock('A1',1,0),empty=h.stock('A2');
  h.sqlite.prepare("UPDATE stocks SET customer_name='客户A',inbound_date='2026-10-01',free_days=999,sku='SKU-A' WHERE id=?").run(old);
  h.sqlite.prepare("UPDATE stocks SET customer_name='客户A',inbound_date='2026-10-02',free_days=1 WHERE id=?").run(fresh);
  h.sqlite.prepare('UPDATE stocks SET total_quantity=0,total_boxes=0 WHERE id=?').run(empty);
  h.setting('warehouse_location_aliases',{'旧A1':'A1'});h.setting('pricing_customer_override:箱客户',{customerName:'箱客户',freeDays:4});
  h.sqlite.prepare("INSERT INTO carton_receipts(id,inbound_order,original_order,order_history,customer_name,inbound_date,placements,note,version,created_by,created_at,updated_by,updated_at) VALUES ('c','IB','IB','[]','旧客户','2026-01-01',?,'',0,1,'now',1,'now')").run(JSON.stringify([{key:'p',locationCode:'旧A1',layerCount:2,boxes:4,palletCount:99,marker:'',details:{product:'当前箱名',sku:'BOX',customerName:'箱客户',inboundDate:'2026-10-20'}},{key:'e',locationCode:'A2',layerCount:1,boxes:0,marker:''}]));
  const before=snapshot(h),r=await call(h);assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(snapshot(h),before);
  assert.deepEqual(Object.keys(r.data).sort(),['asOf','customers','nearDays','rows','summary']);assert.equal(r.data.rows.length,3);
  assert.ok(r.data.rows.every(x=>x.locationCode==='A1'));const box=r.data.rows.find(x=>x.kind==='carton');assert.equal(box.customerName,'箱客户');assert.equal(box.productName,'当前箱名');assert.equal(box.inboundDate,'2026-10-20');assert.equal(box.chargeStartDate,'2026-10-24');assert.equal(box.status,'expired');
  assert.equal(r.data.rows.find(x=>x.id===`stock:${fresh}`).status,'near');assert.equal(r.data.rows.find(x=>x.id===`stock:${fresh}`).inboundDate,'2026-10-02');assert.equal(r.data.rows.find(x=>x.id===`stock:${fresh}`).billingInboundDate,'2026-10-01');assert.equal(r.data.rows.find(x=>x.id===`stock:${old}`).status,'near');
  h.sqlite.prepare("UPDATE stocks SET location_code='B3',layer_count=3 WHERE id=?").run(old);const moved=await call(h);assert.equal(moved.data.rows.find(x=>x.id===`stock:${old}`).chargeStartDate,'2026-10-31');
 }finally{h.sqlite.close();}
});

test('default asOf uses the New York calendar and empty API results remain well formed',async()=>{
 assert.ok(existsSync('app/api/pricing/free-periods/route.ts'),'free-period API must exist');const h=fixture();try{
  const r=await call(h,'');const expected=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());assert.equal(r.data.asOf,expected);assert.deepEqual(r.data.rows,[]);assert.deepEqual(r.data.summary,{expiredCount:0,nearCount:0,reviewCount:0});assert.equal(r.data.nearDays,7);
 }finally{h.sqlite.close();}
});

test('legacy numeric customer free-day strings follow existing profiles while invalid overrides remain pending',async()=>{
 const d=await domain();
 for(const value of ['30.0',' 30 ']){
  const result=d.buildStorageFreePeriods({occupants:[row()],settingsRows:[...settingsRows(0),{key:'pricing_customer_override:客户A',value:JSON.stringify({customerName:'客户A',freeDays:value})}],asOf:'2026-10-24'});
  assert.equal(result.rows[0].freeDays,30);assert.equal(result.rows[0].status,'near');
 }
 const invalid=d.buildStorageFreePeriods({occupants:[row()],settingsRows:[...settingsRows(0),{key:'pricing_customer_override:客户A',value:'{"freeDays":"wrong"}'}],asOf:'2026-10-24'});
 assert.equal(invalid.rows[0].status,'review');assert.equal(invalid.rows[0].freeDays,null);
});

test('an unresolved physical arrival clears the customer layer eligibility deadlines while independent layers remain valid',async()=>{
 const d=await domain(),r=d.buildStorageFreePeriods({occupants:[row({inboundDate:'2026-09-01'}),row({id:'stock:2',layer:2,inboundDate:'2026-09-01'}),row({id:'stock:3',layer:3,inboundDate:'2026-10-20'})],settingsRows:settingsRows(),asOf:'2026-10-24',arrivalReviewIds:['stock:1']});
 const affected=r.rows.find(x=>x.id==='stock:1');assert.equal(affected.status,'review');
 assert.deepEqual([affected.freeUntilDate,affected.chargeStartDate,affected.daysRemaining,affected.daysOverdue],[null,null,null,null]);
 assert.ok(affected.reviewReasons.some(reason=>reason.includes('实际到仓批次')&&reason.includes('免租日期待核对')));
 assert.equal(r.rows.find(x=>x.id==='stock:2').status,'expired');assert.equal(r.rows.find(x=>x.id==='stock:3').status,'free');
 assert.deepEqual(r.summary,{expiredCount:1,nearCount:0,reviewCount:1});
});

test('active correction increases with another arrival date require review while restored and same-date corrections do not',async()=>{
 const d=await domain();assert.equal(typeof d.deriveFreePeriodArrivalReviewIds,'function');
 const occupants=[1,2,3,4,5].map(id=>row({id:`stock:${id}`,inboundDate:'2026-09-01'}));
 const op=(id,before,after,effectiveDate='2026-10-20',restoredAt=null)=>({kind:'correction',beforeRows:JSON.stringify([{id,totalQuantity:before[0],totalBoxes:before[1]}]),afterRows:JSON.stringify([{id,totalQuantity:after[0],totalBoxes:after[1]}]),result:JSON.stringify({effectiveDate}),restoredAt});
 const operations=[op(1,[10,1],[20,1]),op(2,[10,1],[10,3]),op(3,[10,1],[20,1],'2026-10-20','2026-10-21T12:00:00.000Z'),op(4,[10,1],[20,1],'2026-09-01'),op(5,[10,1],[5,1]),op(99,[10,1],[20,1]),{...op(5,[10,1],[20,1]),kind:'inbound'}];
 assert.deepEqual(d.deriveFreePeriodArrivalReviewIds(occupants,operations),['stock:1','stock:2']);
});

test('API conservatively reviews mixed arrivals from physical correction evidence only and ignores recorded restoration',async()=>{
 const h=fixture();try{
  const affected=h.stock(),unchanged=h.stock(),fresh=h.stock(),restored=h.stock();
  h.sqlite.prepare("UPDATE stocks SET customer_name='同客户',inbound_date='2026-09-01'").run();h.sqlite.prepare("UPDATE stocks SET inbound_date='2026-10-20',layer_count=2 WHERE id=?").run(fresh);h.sqlite.prepare('UPDATE stocks SET layer_count=3 WHERE id=?').run(unchanged);h.sqlite.prepare('UPDATE stocks SET layer_count=4 WHERE id=?').run(restored);
  const insert=h.sqlite.prepare("INSERT INTO goods_operations(id,kind,category_id,fingerprint,before_category,after_category,before_rows,after_rows,result,created_at,restored_at) VALUES (?,'correction','legacy','{}',NULL,'{}',?,?,?,'2026-10-20T12:00:00.000Z',?)");
  for(const [id,restoredAt]of [[affected,null],[restored,'2026-10-21T12:00:00.000Z']])insert.run(`correction:${id}`,JSON.stringify([{id,totalQuantity:5,totalBoxes:2,inboundDate:'2026-09-01'}]),JSON.stringify([{id,totalQuantity:10,totalBoxes:2,inboundDate:'2026-09-01'}]),JSON.stringify({inventoryQuantityCorrection:true,effectiveDate:'2026-10-20',closedAllocations:[]}),restoredAt);
  h.setting('pricing_layer_storage_v1',{malformed:true});
  const before=snapshot(h),r=await call(h);assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(snapshot(h),before);
  const byId=new Map(r.data.rows.map(row=>[row.id,row]));assert.equal(byId.get(`stock:${affected}`).status,'review');assert.equal(byId.get(`stock:${affected}`).chargeStartDate,null);
  assert.equal(byId.get(`stock:${unchanged}`).status,'expired');assert.equal(byId.get(`stock:${fresh}`).status,'free');assert.equal(byId.get(`stock:${restored}`).status,'expired');
 }finally{h.sqlite.close();}
});

const camel=row=>Object.fromEntries(Object.entries(row).map(([key,value])=>[key.replace(/_([a-z])/g,(_,char)=>char.toUpperCase()),value]));
function checkpoint(h,stocks=[],cartons=[]){h.sqlite.prepare("INSERT OR REPLACE INTO layer_storage_checkpoints(id,captured_at,value,audit_high_id) VALUES (1,'2026-10-01T16:00:00.000Z',?,0)").run(JSON.stringify({schemaVersion:1,stocks,cartons}));}
test('API follows an increased physical arrival through a split into a new active stock ID even when query asOf precedes the change',async()=>{
 const h=fixture();try{
  const source=h.stock('A1'),moved=h.stock('B1'),other=h.stock('C1');h.sqlite.exec("UPDATE stocks SET total_boxes=0,customer_name='客户A',inbound_date='2026-09-01'");
  const original=camel(h.sqlite.prepare('SELECT * FROM stocks WHERE id=?').get(source)),unaffected=camel(h.sqlite.prepare('SELECT * FROM stocks WHERE id=?').get(other));checkpoint(h,[original,unaffected]);
  const up={...original,totalQuantity:12},empty={...up,totalQuantity:0},destination={...up,id:moved,locationCode:'B1'};
  h.sqlite.prepare('UPDATE stocks SET total_quantity=0 WHERE id=?').run(source);h.sqlite.prepare('UPDATE stocks SET total_quantity=12 WHERE id=?').run(moved);
  h.sqlite.prepare("INSERT INTO goods_operations(id,kind,category_id,fingerprint,after_category,before_rows,after_rows,result,created_at) VALUES ('arrival-up','correction','legacy','{}','{}',?,?,?,'2026-10-04T16:00:00.000Z')").run(JSON.stringify([original]),JSON.stringify([up]),JSON.stringify({effectiveDate:'2026-10-04'}));
  h.sqlite.prepare("INSERT INTO audit_logs(user_id,user_name,action,entity_type,entity_id,operation_id,summary,before_snapshot,after_snapshot,created_at) VALUES (1,'boss','移库','库位','A1','arrival-split','split',?,?,'2026-10-05T16:00:00.000Z')").run(JSON.stringify({kind:'stock-transfer',snapshotVersion:1,rows:[up]}),JSON.stringify({kind:'stock-transfer',snapshotVersion:1,rows:[empty,destination]}));
  h.setting('pricing_layer_storage_v1',{broken:true});const before=snapshot(h),response=await call(h,'asOf=2026-10-02');assert.equal(response.status,200,JSON.stringify(response.data));assert.equal(snapshot(h),before);
  const projected=response.data.rows.find(row=>row.id===`stock:${moved}`);assert.equal(projected.status,'review');assert.equal(projected.chargeStartDate,null);assert.equal(projected.daysOverdue,null);
  assert.equal(response.data.rows.find(row=>row.id===`stock:${other}`).status,'expired');assert.equal(response.data.rows.some(row=>row.id===`stock:${source}`),false);
 }finally{h.sqlite.close();}
});

test('API uses physical carton correction and movement lineage without marking unrelated placements pending',async()=>{
 const h=fixture();try{
  const placement=(key,boxes,locationCode='A1')=>({key,locationCode,layerCount:1,boxes,marker:'',details:{customerName:'客户A',inboundDate:'2026-09-01'}});
  const before={id:'carton-lineage',inboundOrder:'IB',customerName:'客户A',inboundDate:'2026-09-01',placements:JSON.stringify([placement('p1',3),placement('p2',8,'A2')]),note:''};
  const increased={...before,placements:JSON.stringify([placement('p1',5),placement('p2',8,'A2')])},moved={...before,placements:JSON.stringify([placement('p1',2),placement('p2',8,'A2'),placement('p3',3,'B1')])};checkpoint(h,[],[before]);
  h.sqlite.prepare("INSERT INTO carton_receipts(id,inbound_order,original_order,order_history,customer_name,inbound_date,placements,note,version,created_by,created_at,updated_by,updated_at) VALUES ('carton-lineage','IB','IB','[]','客户A','2026-09-01',?,'',2,1,'2026-09-01',1,'2026-10-05')").run(moved.placements);
  const insert=h.sqlite.prepare("INSERT INTO carton_operations(id,receipt_id,kind,fingerprint,before_snapshot,after_snapshot,result,user_id,created_at) VALUES (?,'carton-lineage',?,'{}',?,?,'{}',1,?)");
  insert.run('carton-up','correction',JSON.stringify(before),JSON.stringify(increased),'2026-10-04T16:00:00.000Z');insert.run('carton-move','move',JSON.stringify(increased),JSON.stringify(moved),'2026-10-05T16:00:00.000Z');
  const beforeState=snapshot(h),response=await call(h,'asOf=2026-10-02');assert.equal(response.status,200,JSON.stringify(response.data));assert.equal(snapshot(h),beforeState);
  const byId=new Map(response.data.rows.map(row=>[row.id,row]));for(const key of ['p1','p3']){assert.equal(byId.get(`carton:carton-lineage:${key}`).status,'review');assert.equal(byId.get(`carton:carton-lineage:${key}`).chargeStartDate,null);}
  assert.equal(byId.get('carton:carton-lineage:p2').status,'expired');
 }finally{h.sqlite.close();}
});

test('free-period physical sources and settings are captured together in one transactional read snapshot',async()=>{
 const h=fixture();try{
  const id=h.stock();h.sqlite.prepare("UPDATE stocks SET inbound_date='2026-10-01',customer_name='客户A' WHERE id=?").run(id);
  let batches=0;const batch=h.adapter.batch.bind(h.adapter);h.adapter.batch=async statements=>{batches++;return batch(statements);};
  h.adapter.beforeBatch=()=>{h.setting('pricing_defaults',{defaultFreeDays:7,defaultRatePerM3Day:.7});};
  const response=await call(h);assert.equal(response.status,200,JSON.stringify(response.data));assert.equal(batches,1);assert.equal(response.data.rows[0].freeDays,7);assert.equal(response.data.rows[0].chargeStartDate,'2026-10-08');
 }finally{h.sqlite.close();}
});
