import test from 'node:test';
import assert from 'node:assert/strict';
import {warehouseApiHarness} from './helpers/warehouse-api-harness.mjs';

function fixture({archive='旧商家',owner='现商家',conflict=false,quantity=10}={}){
 const h=warehouseApiHarness({layerPricing:true});h.seedUser(1,null,'admin','boss');
 h.setting('pricing_defaults',{defaultRatePerM3Day:.5,defaultFreeDays:0});
 const b={id:99,locationCode:'A1',layerCount:1,customerName:owner,product:'同一出库货物',sku:'S',inboundDate:'2026-09-01',totalQuantity:10,totalBoxes:2};
 h.sqlite.prepare("INSERT INTO audit_logs(id,user_id,user_name,action,entity_type,entity_id,operation_id,summary,before_snapshot,after_snapshot,created_at) VALUES(10,1,'老板','出库','库存','99','exact-op','实物出库',?,?,'2026-09-11T12:00:00Z')").run(JSON.stringify(b),JSON.stringify({...b,totalQuantity:0,totalBoxes:0}));
 h.sqlite.prepare("INSERT INTO storage_fee_settlements(id,operation_id,stock_id,location_code,product,customer_name,inbound_date,outbound_at,quantity,boxes,settlement_status,fee_usd,version,created_at,settled_at) VALUES(1,'exact-op',99,'A1','同一出库货物',?,'2026-09-01','2026-09-11',?,2,'settled',99,1,'old','confirmed')").run(archive,quantity);
 if(conflict)h.setting('outbound_history_customer:audit:10','{');
 return h;
}
const path=customer=>'pricing/layers/report?fromDate=2026-09-01&toDate=2026-09-30&asOf=2026-10-01&customer='+encodeURIComponent(customer);

test('proven reowned shipment hides obsolete archive and customer entry, without changing either ledger or fees',async()=>{
 const h=fixture();try{
  const before=JSON.stringify(h.sqlite.prepare('SELECT * FROM storage_fee_settlements').all());
  const old=await h.call(path('旧商家')),dest=await h.call(path('现商家')),directory=await h.call('pricing/customers');
  assert.equal(old.status,200);assert.equal(dest.status,200);
  assert.equal(old.data.confirmedHistory.count,0);assert.equal(dest.data.sections.shipped.feeUsd,10);
  assert.equal(dest.data.outboundHistory.length,1);assert.ok(!directory.data.customers.includes('旧商家'));
  assert.ok(directory.data.customers.includes('现商家'));
  assert.equal(JSON.stringify(h.sqlite.prepare('SELECT * FROM storage_fee_settlements').all()),before);
 }finally{h.sqlite.close();}
});

test('unchanged owner, quantities mismatch and damaged correction preserve archive',async()=>{
 for(const options of [{owner:'旧商家'},{quantity:9},{conflict:true}]){
  const h=fixture(options);try{const r=await h.call(path('旧商家'));assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.data.confirmedHistory.count,1,JSON.stringify(options));assert.ok((await h.call('pricing/customers')).data.customers.includes('旧商家'));}finally{h.sqlite.close();}
 }
});

test('same product and dates without matching operation identity do not hide an archive',async()=>{
 const h=fixture();try{h.sqlite.exec("UPDATE storage_fee_settlements SET operation_id='unrelated-op'");const r=await h.call(path('旧商家'));assert.equal(r.data.confirmedHistory.count,1);}finally{h.sqlite.close();}
});

test('unlinked human-confirmed archive remains selectable even if its quantities are zero',async()=>{
 const h=fixture();try{h.sqlite.exec("UPDATE storage_fee_settlements SET operation_id='unrelated',quantity=0,boxes=0");const r=await h.call(path('旧商家'));assert.equal(r.data.confirmedHistory.count,1);assert.ok((await h.call('pricing/customers')).data.customers.includes('旧商家'));}finally{h.sqlite.close();}
});

test('a proven global alias hides stale archive while target fees remain independently recalculated',async()=>{
 const h=fixture({owner:'旧商家'});try{h.setting('merchant_aliases_v1',{schemaVersion:1,aliases:{旧商家:'现商家'}});const r=await h.call(path('现商家'));assert.equal(r.data.confirmedHistory.count,0);assert.equal(r.data.sections.shipped.feeUsd,10);}finally{h.sqlite.close();}
});

test('explicit per-record merchant correction hides only its exactly linked archive',async()=>{
 const h=fixture({owner:'旧商家'});try{
  const record=(await h.load('lib/outbound-history-store.ts').readCorrectedOutboundHistory()).records[0];
  h.setting('outbound_history_customer:'+record.key,{schemaVersion:1,key:record.key,customerName:'现商家',version:1,sourceRevision:record.sourceRevision});
  const old=await h.call(path('旧商家')),dest=await h.call(path('现商家'));
  assert.equal(old.data.confirmedHistory.count,0);assert.equal(dest.data.sections.shipped.feeUsd,10);
  assert.equal(h.sqlite.prepare('SELECT customer_name FROM storage_fee_settlements').get().customer_name,'旧商家');
 }finally{h.sqlite.close();}
});

test('ambiguous sources and incomplete destination dates or layer never silently hide archives',async()=>{
 const h=fixture();try{
  const history=await h.load('lib/outbound-history-store.ts').readCorrectedOutboundHistory(),bill={id:1,stockId:99,operationId:'exact-op',customerName:'旧商家',inboundDate:'2026-09-01',outboundAt:'2026-09-11',quantity:10,boxes:2},record=history.records[0];
  const check=h.load('lib/legacy-bill-migrations.ts').migratedLegacyBillIds;
  assert.equal(check([bill],[record,{...record,key:'goods:exact-op:99'}],[record],[{id:10,operationId:'exact-op'}],{}).size,0);
  for(const patch of [{layer:null},{inboundDate:null},{outboundDate:null},{billingDetailsConflict:'原资料冲突'}])assert.equal(check([bill],[record],[{...record,...patch}],[{id:10,operationId:'exact-op'}],{}).size,0);
 }finally{h.sqlite.close();}
});
