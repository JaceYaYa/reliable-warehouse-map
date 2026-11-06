import {billRows,detailRows} from './helpers/billing-workbook.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {warehouseApiHarness} from './helpers/warehouse-api-harness.mjs';
import * as XLSX from 'xlsx';
function fixture(occupants){
 const h=warehouseApiHarness(),d=h.load('lib/layer-storage.ts'),config=d.emptyLayerPricingConfig();
 const issue={code:'history-before-checkpoint',message:'旧记录不完整',startDate:'2026-09-01',endDateExclusive:'2026-09-20'};
 return {h,input:{settings:{ok:true,config,zones:[],aliases:{},locations:['A1'],occupied:d.groupLayerOccupancy(occupants,config,[])},settingsRows:[],history:{intervals:[{startDate:'2026-09-01',endDateExclusive:'2026-09-20',occupants:[],issues:[issue],evidenceIds:[]},{startDate:'2026-09-20',endDateExclusive:'2026-10-01',occupants,issues:[],evidenceIds:['checkpoint:1']}],issues:[issue],coverageStart:'2026-09-20',checkpointAt:'2026-09-19T16:00:00Z'},confirmedSettlements:[],fromMonth:'2026-09',toMonth:'2026-09',asOf:'2026-10-26'}};
}
const occ=(id,customerName='甲',inboundDate='2026-08-01')=>({id:'stock:'+id,kind:'stock',locationCode:'A1',layer:1,customerName,inboundDate,productName:'货物'+id,sku:'SKU'+id});
function run(f){try{return f.h.load('lib/layer-storage-report.ts').buildLayerStorageReport(f.input);}finally{f.h.sqlite.close();}}
test('missing history uses current occupied layers while proven intervals keep their own occupancy',()=>{
 const f=fixture([occ(1)]);f.input.history.intervals[1].occupants=[];const before=JSON.stringify(f.input),r=run(f);
 assert.equal(r.totals.complete,true);assert.equal(r.totals.verifiedFeeUsd,26.6);assert.equal(r.pending.length,0);
 assert.equal(r.rows[0].calculationBasis,'current-occupancy');assert.equal(r.coverage.currentOccupancyPeriods.length,1);assert.equal(JSON.stringify(f.input),before);
});
test('backfill starts at each current inbound date and retains independent arrival batches',()=>{
 const f=fixture([occ(1,'甲','2026-09-10'),occ(2,'甲','2026-09-15')]);
 f.input.settingsRows=[{key:'pricing_customer_override:甲',value:JSON.stringify({customerName:'甲',ratePerM3Day:.5,freeDays:0})}];
 f.input.history.intervals[1].occupants=[];const r=run(f);
 assert.equal(r.totals.complete,true);assert.equal(r.totals.verifiedFeeUsd,15);assert.ok(r.rows.every(x=>x.startDate>='2026-09-10'&&['2026-09-10','2026-09-15'].includes(x.inboundDate)));
});
test('unclaimed goods never invalidate the full layer volume of known customers or require shares',()=>{
 const r=run(fixture([occ(1),occ(2,'乙'),occ(3,'')]));
 for(const name of ['甲','乙']){const rows=r.rows.filter(x=>x.customerName===name);assert.ok(rows.length);assert.ok(rows.every(x=>x.percent===100&&x.sharedVolumeM3===2&&x.feeUsd!==null));}
 assert.equal(r.totals.verifiedFeeUsd,84);assert.ok(r.rows.filter(x=>!x.customerName).every(x=>x.feeUsd===null));
 assert.ok(r.rows.every(x=>!x.reviewReasons.some(s=>/分摊|比例/.test(s))));
});
test('current-basis backfill preserves invalid-date safety and recomputes unpaid confirmed periods',()=>{
 const bad=run(fixture([occ(1,'甲','2026-02-30')]));assert.ok(bad.rows.every(x=>x.feeUsd===null));
 const f=fixture([occ(1)]);f.input.confirmedSettlements=[{id:1,customerName:'甲',inboundDate:'2026-08-01',outboundAt:'2026-09-05T16:00:00Z',settlementStatus:'settled',feeUsd:10}];
 const r=run(f);assert.equal(r.confirmedHistory.feeUsd,10);assert.equal(r.totals.verifiedFeeUsd,42);assert.ok(r.rows.every(x=>x.feeUsd!==null));
});
test('quantity correction cohort warnings do not override recorded oldest layer dates',()=>{
 const f=fixture([occ(1),occ(2,'甲','2026-09-15')]);f.input.history.issues.push({code:'arrival-cohort-unknown',message:'数量修正批次不明确',startDate:'2026-09-01',endDateExclusive:'2026-10-01',recordIds:['stock:1']});f.input.history.currentArrivalReviewIds=['stock:1'];
 const r=run(f);assert.equal(r.totals.complete,true);assert.equal(r.totals.verifiedFeeUsd,64.4);assert.equal(r.current.pendingCount,0);assert.equal(r.current.rows[0].inboundDate,'2026-08-01');
});
test('a scoped correction warning cannot erase another customer reliable historical layer',()=>{
 const f=fixture([occ(1)]),past={...occ(2,'乙'),locationCode:'B1'};f.input.history.issues=[];f.input.history.intervals=[{startDate:'2026-09-01',endDateExclusive:'2026-10-01',occupants:[occ(1),past],issues:[],evidenceIds:['checkpoint:1']}];f.input.history.issues=[{code:'arrival-cohort-unknown',message:'数量修正批次不明确',startDate:'2026-09-01',endDateExclusive:'2026-10-01',recordIds:['stock:1'],locationCode:'A1',layer:1}];
 const r=run(f);assert.equal(r.totals.verifiedFeeUsd,84);assert.equal(r.rows.find(x=>x.customerName==='乙').feeUsd,42);
});
test('export has exactly layer detail and customer totals sheets with matching full-layer amounts',async()=>{
 const h=warehouseApiHarness({layerPricing:true});try{
 h.seedUser(1,null,'admin','boss');h.stock('A1');h.stock('A1');h.sqlite.prepare("UPDATE stocks SET customer_name='客户甲',inbound_date='2026-08-01'").run();h.setting('pricing_defaults',{defaultRatePerM3Day:.5,defaultFreeDays:0});
 const response=await h.load('app/api/pricing/layers/export/route.ts').GET(new Request('http://local.test/api/pricing/layers/export?fromMonth=2026-09&toMonth=2026-09&asOf=2026-10-01',{headers:{cookie:'wms_session=test-token-1'}}));assert.equal(response.status,200);
 const w=XLSX.read(await response.arrayBuffer(),{type:'array'});assert.deepEqual(w.SheetNames,['客户账单','库位汇总','核对明细']);
 const detail=detailRows(w),summary=billRows(w);
 const customer=summary.find(r=>r.customer==='客户甲');assert.equal(customer.fee,30);assert.ok(detail.every(r=>r.volume===2&&r.rate===.5));
 assert.equal(detail.filter(r=>r.customer==='客户甲').reduce((n,r)=>n+r.fee,0),30);assert.ok(detail.every(r=>r.customer!=='客户甲'||r.location==='A1／第1层'));
 }finally{h.sqlite.close();}
});
test('layer expiry query uses recorded earliest layer date after a quantity correction',async()=>{
 const h=warehouseApiHarness({layerPricing:true});try{h.seedUser(1,null,'admin','boss');const id=h.stock();h.sqlite.prepare("UPDATE stocks SET customer_name='甲',inbound_date='2026-08-01'").run();h.sqlite.prepare("INSERT INTO goods_operations(id,kind,category_id,fingerprint,after_category,before_rows,after_rows,result,created_at) VALUES ('corr','correction','x','{}','{}',?,?,?,'2026-10-20T12:00:00Z')").run(JSON.stringify([{id,totalQuantity:1,totalBoxes:0}]),JSON.stringify([{id,totalQuantity:2,totalBoxes:0}]),JSON.stringify({effectiveDate:'2026-10-20'}));
 const r=await h.call('pricing/free-periods?asOf=2026-10-24');assert.equal(r.status,200);assert.equal(r.data.rows[0].billingInboundDate,'2026-08-01');assert.equal(r.data.rows[0].status,'expired');
 }finally{h.sqlite.close();}
});
test('UI/export cents reconcile exactly and customer names containing wildcard characters stay isolated',()=>{
 const f=fixture([occ(1,'A*'),{...occ(2,'A*'),locationCode:'A2'},occ(3,'ABC')]);f.input.history.issues=[];f.input.history.intervals=[{startDate:'2026-09-01',endDateExclusive:'2026-09-02',occupants:f.input.settings.occupied.flatMap(g=>g.occupants),issues:[],evidenceIds:[]},{startDate:'2026-09-02',endDateExclusive:'2026-10-01',occupants:[],issues:[],evidenceIds:[]}];f.input.settingsRows=[{key:'pricing_defaults',value:JSON.stringify({defaultRatePerM3Day:.003,defaultFreeDays:0})}];
 try{const r=f.h.load('lib/layer-storage-report.ts').buildLayerStorageReport(f.input),w=f.h.load('lib/layer-storage-workbook.ts').buildLayerStorageWorkbook(r),detail=detailRows(w),summary=billRows(w);assert.equal(detail.filter(x=>x.customer==='A*').reduce((n,x)=>n+x.fee,0),.01);assert.equal(summary.find(x=>x.customer==='A*').fee,.01);assert.ok(!Object.values(w.Sheets['客户账单']).some(cell=>/SUMIF/.test(cell?.f??'')));
 }finally{f.h.sqlite.close();}
});
test('current-occupancy migration periods never read large operation history tables',async()=>{
 const h=warehouseApiHarness({layerPricing:true});try{h.seedUser(1,null,'admin','boss');h.stock();h.sqlite.prepare("UPDATE stocks SET customer_name='甲',inbound_date='2026-08-01'").run();h.sqlite.prepare("UPDATE layer_storage_checkpoints SET captured_at='2026-10-27T04:00:00Z' WHERE id=1").run();
 const prepare=h.adapter.prepare;h.adapter.prepare=sql=>{if(/from\s+"audit_logs"/i.test(sql)){assert.match(sql,/action='(?:出库|移库)'/);assert.doesNotMatch(sql,/select\s+\*/i);if(sql.includes("action='移库'"))assert.match(sql,/stock-transfer/);}if(/from\s+"(?:goods_operations|carton_operations)"/i.test(sql)){assert.match(sql,/where.*kind/i);assert.doesNotMatch(sql,/before_category|after_category/i);}return prepare(sql);};
 const r=await h.call('pricing/layers/report?customer=甲&fromMonth=2026-09&toMonth=2026-09&asOf=2026-10-01');assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.data.totals.verifiedFeeUsd,42);
 }finally{h.sqlite.close();}
});
