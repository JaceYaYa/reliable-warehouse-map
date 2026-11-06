import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {warehouseApiHarness} from './helpers/warehouse-api-harness.mjs';

const product='吸尘器145PLUS',customer='独立计价测试商家',sku='145PLUS-US',outboundDate='2026-10-12';
const refs=c=>c.members.map(r=>({id:r.id,version:r.version}));
const physical=h=>h.sqlite.prepare('SELECT * FROM stocks ORDER BY id').all();
const state=h=>JSON.parse(h.sqlite.prepare('SELECT value FROM goods_flow_state WHERE id=1').get().value);
const settlements=h=>h.sqlite.prepare('SELECT * FROM storage_fee_settlements ORDER BY id').all();
async function context(h){const r=await h.call('goods');assert.equal(r.status,200,JSON.stringify(r.data));return r.data;}
function seed(h,code,date,quantity,patch={}){
 const id=h.stock(code);
 h.sqlite.prepare("UPDATE stocks SET product=?,customer_name=?,sku=?,barcode=?,inbound_date=?,total_quantity=?,total_boxes=0,inventory_unit='item',inbound_source='return',billing_mode='item',item_volume_m3=.01,storage_rate_usd=.5,free_days=10,pallet_count=0,pallet_label='0' WHERE id=?").run(patch.product??product,patch.customer??customer,patch.sku??sku,'BC-'+code,date,quantity,id);
 return id;
}
function setup(){const h=warehouseApiHarness();h.seedUser(1,null,'admin','boss');h.setting('warehouse_zones',[{id:'NEW_A',title:'A区',codes:['A33','C28','D1']}]);const early=seed(h,'A33','2026-08-25',193),late=seed(h,'C28','2026-09-10',288);return{h,early,late};}
async function dispatch(h,late,quantity,date=outboundDate){const c=await context(h),choice=c.choices.find(x=>x.members.some(r=>r.id===late));return h.call('goods/outbound','POST',{requestId:randomUUID(),expectedRevision:c.revision,key:choice.key,members:refs(choice),quantity,boxes:0,outboundDate:date,selected:[{id:late,version:choice.members.find(r=>r.id===late).version,quantity,boxes:0}]});}
const handDays=(start,end)=>(Date.parse(end+'T00:00:00Z')-Date.parse(start+'T00:00:00Z'))/86400000;
const handFee=(quantity,date)=>Math.round(quantity*.01*.5*Math.max(0,handDays(date,outboundDate)-10)*100)/100;

test('晚库位实际出100件只改晚库位，计价FIFO扣早193件批次，并以所选出库日计算费用；撤销同时恢复',async()=>{
 const{h,early,late}=setup();try{
  const before=physical(h),r=await dispatch(h,late,100);assert.equal(r.status,200,JSON.stringify(r.data));
  assert.equal(physical(h).find(x=>x.id===early).total_quantity,193);assert.equal(physical(h).find(x=>x.id===late).total_quantity,188);
  const lots=state(h).categories[0].lots;assert.equal(lots.find(l=>l.stockId===early).quantity,93);assert.equal(lots.find(l=>l.stockId===late).quantity,288);
  assert.deepEqual(r.data.stocks.map(x=>[x.id,x.totalQuantity]),[[late,188]]);
  assert.deepEqual(r.data.billingAllocations.map(x=>[x.stockId,x.inboundDate,x.quantity]),[[early,'2026-08-25',100]]);
  const fee=settlements(h)[0];assert.equal(fee.location_code,'A33');assert.equal(fee.inbound_date,'2026-08-25');assert.equal(fee.outbound_at.slice(0,10),outboundDate);assert.equal(fee.storage_days,48);assert.equal(fee.billable_days,38);assert.equal(fee.fee_usd,handFee(100,'2026-08-25'));assert.equal(fee.fee_usd,19);
  const log=h.sqlite.prepare('SELECT * FROM audit_logs WHERE operation_id=?').get(fee.operation_id.split(':cost:')[0]);assert.match(log.summary,/实物库位 C28/);assert.match(log.summary,/计价先进先出批次 2026-08-25/);assert.deepEqual(JSON.parse(log.before_snapshot).rows.map(x=>x.id),[late]);
  const restore=await h.call('movements','POST',{id:log.id});assert.equal(restore.status,200,JSON.stringify(restore.data));
  for(const row of physical(h)){const old=before.find(x=>x.id===row.id);for(const field of ['total_quantity','total_boxes','inbound_date','location_code','sku','item_volume_m3','storage_rate_usd','free_days'])assert.equal(row[field],old[field]);}
  assert.equal(state(h).categories.length,0);assert.equal(settlements(h).length,0);
 }finally{h.sqlite.close();}
});

test('仅从晚库位出250件跨两原批次拆价，193早批加57晚批，历史截止日完整恢复计价库存',async()=>{
 const{h,early,late}=setup();try{
  const r=await dispatch(h,late,250);assert.equal(r.status,200,JSON.stringify(r.data));
  assert.deepEqual(physical(h).map(x=>[x.id,x.total_quantity]),[[early,193],[late,38]]);
  assert.deepEqual(state(h).categories[0].lots.map(l=>[l.stockId,l.quantity]),[[early,0],[late,231]]);
  assert.deepEqual(r.data.billingAllocations.map(a=>[a.stockId,a.inboundDate,a.quantity]),[[early,'2026-08-25',193],[late,'2026-09-10',57]]);
  const fees=settlements(h);assert.deepEqual(fees.map(s=>[s.inbound_date,s.quantity,s.storage_days,s.billable_days,s.fee_usd]),[['2026-08-25',193,48,38,36.67],['2026-09-10',57,32,22,6.27]]);
  assert.equal(Number(fees.reduce((n,s)=>n+s.fee_usd,0).toFixed(2)),42.94);assert.equal(fees[0].fee_usd,handFee(193,'2026-08-25'));assert.equal(fees[1].fee_usd,handFee(57,'2026-09-10'));
  const report=await h.call('pricing/report?asOf=2026-10-01');assert.equal(report.status,200);assert.equal(report.data.rows.reduce((n,x)=>n+x.quantity,0),481);
  const after=await h.call('pricing/report?asOf=2026-10-13&inventoryStatus=in_stock');assert.equal(after.status,200);assert.equal(after.data.rows.reduce((n,x)=>n+x.quantity,0),231);assert.deepEqual(after.data.rows.map(x=>[x.inboundDate,x.quantity]),[['2026-09-10',231]]);
  const log=h.sqlite.prepare("SELECT id FROM audit_logs WHERE action='出库'").get();assert.equal((await h.call('movements','POST',{id:log.id})).status,200);assert.deepEqual(physical(h).map(x=>x.total_quantity),[193,288]);assert.equal(settlements(h).length,0);
 }finally{h.sqlite.close();}
});

test('更改产品现行体积及SKU后原批次日期/参数和既有账单保留，下一次仍按早批计费',async()=>{
 const{h,early,late}=setup();try{
  assert.equal((await dispatch(h,late,100)).status,200);const previousFees=settlements(h),originalLots=state(h).categories[0].lots;
  let c=await context(h),p=c.choices[0];assert.equal((await h.call('goods/spec','POST',{requestId:randomUUID(),expectedRevision:c.revision,key:p.key,members:refs(p),productSpec:{billingMode:'item',itemVolumeM3:.9},confirmAll:true})).status,200);
  c=await context(h);p=c.choices[0];assert.equal((await h.call('goods/sku','POST',{requestId:randomUUID(),expectedRevision:c.revision,key:p.key,members:refs(p),sku:'145PLUS-NEW',confirmAll:true})).status,200);
  const nextLots=state(h).categories[0].lots;assert.deepEqual(nextLots.map(l=>[l.id,l.stockId,l.quantity,l.snapshot.inboundDate,l.snapshot.itemVolumeM3,l.snapshot.storageRateUsd,l.snapshot.freeDays]),originalLots.map(l=>[l.id,l.stockId,l.quantity,l.snapshot.inboundDate,l.snapshot.itemVolumeM3,l.snapshot.storageRateUsd,l.snapshot.freeDays]));assert.ok(nextLots.every(l=>l.snapshot.sku==='145PLUS-NEW'));
  assert.deepEqual(settlements(h),previousFees);
  const r=await dispatch(h,late,20);assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.data.billingAllocations[0].stockId,early);const latest=settlements(h).at(-1);assert.equal(latest.inbound_date,'2026-08-25');assert.equal(latest.item_volume_m3,.01);assert.equal(latest.sku,'145PLUS-NEW');assert.equal(latest.fee_usd,3.8);assert.equal(previousFees[0].sku,sku);
 }finally{h.sqlite.close();}
});

test('同SKU可容纳名称/标记差异，同产品不同客户隔离；同名冲突SKU不得自动混合出库',async()=>{
 {const{h,early,late}=setup();try{
  h.sqlite.prepare('UPDATE stocks SET product=?,product_prefix=? WHERE id=?').run('145PLUS 吸尘器','B',late);
  const other=seed(h,'D1','2026-08-01',500,{customer:'另一商家'}),c=await context(h),p=c.choices.find(x=>x.members.some(r=>r.id===early));assert.equal(p.members.length,2);assert.ok(p.members.some(x=>x.id===late));assert.ok(!p.members.some(x=>x.id===other));
  const r=await dispatch(h,late,100);assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.data.billingAllocations[0].stockId,early);assert.equal(physical(h).find(x=>x.id===other).total_quantity,500);
 }finally{h.sqlite.close();}}
 {const{h,early,late}=setup();try{
  h.sqlite.prepare('UPDATE stocks SET sku=? WHERE id=?').run('DIFFERENT-SKU',late);const c=await context(h);assert.equal(c.choices.length,2);assert.ok(c.choices.every(x=>x.members.length===1&&x.review));const before=physical(h);assert.equal((await dispatch(h,late,100)).status,409);assert.deepEqual(physical(h),before);assert.equal(settlements(h).length,0);
 }finally{h.sqlite.close();}}
});

test('出库日期早于实际晚库位入库日，即使早批可计费也拒绝，实物/成本均无写入',async()=>{
 const{h,early,late}=setup();try{const before=physical(h),r=await dispatch(h,late,10,'2026-09-01');assert.equal(r.status,400,JSON.stringify(r.data));assert.match(r.data.error,/实物入库或计价批次日期/);assert.deepEqual(physical(h),before);assert.equal(state(h).categories.length,0);assert.equal(settlements(h).length,0);}finally{h.sqlite.close();}
});

test('未建类别的原始A33/C28带旧空SKU已出库快照，后续同SKU自动FIFO不被历史组影响且仓储报告不重复计费',async()=>{
 for(const historicalAnchor of ['current','removed']){const{h,early,late}=setup();try{
  h.sqlite.prepare('UPDATE stocks SET sku=? WHERE id IN (?,?)').run('LT-145PLUS-01',early,late);
  const historicalId=historicalAnchor==='current'?early:9999;
  h.sqlite.prepare("INSERT INTO storage_fee_settlements(stock_id,operation_id,location_code,product,sku,customer_name,inbound_date,outbound_at,quantity,boxes,item_volume_m3,rate_usd_m3_day,free_days,storage_days,billable_days,total_volume_m3,fee_usd,settlement_status,created_at) VALUES (?,'legacy-empty-sku','旧A33',?,'',?,'2026-08-25','2026-09-01T23:59:59.000Z',40,0,.01,.5,0,7,7,.4,1.4,'settled','2026-09-01T23:59:59.000Z')").run(historicalId,product,customer);
  const oldFee=settlements(h)[0];assert.equal(state(h).categories.length,0);
  const c=await context(h);assert.equal(c.choices.length,1);assert.equal(c.choices[0].sku,'LT-145PLUS-01');assert.equal(c.choices[0].quantity,481);assert.equal(c.choices[0].review,false);
  const reportBefore=await h.call('pricing/report?asOf=2026-10-12');assert.equal(reportBefore.status,200);
  assert.deepEqual(reportBefore.data.inStockItems.map(x=>[x.stockId,x.inboundDate,x.quantity]),[[early,'2026-08-25',193],[late,'2026-09-10',288]]);
  assert.equal(reportBefore.data.summary.openFeeUsd,68.35);assert.equal(reportBefore.data.summary.totalFeeUsd,69.75);
  const r=await dispatch(h,late,100);assert.equal(r.status,200,JSON.stringify(r.data));assert.deepEqual(physical(h).map(x=>x.total_quantity),[193,188]);
  assert.deepEqual(state(h).categories[0].lots.map(l=>[l.stockId,l.quantity]),[[early,93],[late,288]]);
  assert.equal(r.data.billingAllocations[0].stockId,early);assert.equal(r.data.billingAllocations[0].inboundDate,'2026-08-25');assert.deepEqual(settlements(h)[0],oldFee);
  const reportAfter=await h.call('pricing/report?asOf=2026-10-12');assert.equal(reportAfter.status,200);
  assert.equal(reportAfter.data.inStockItems.length,2);assert.equal(new Set(reportAfter.data.inStockItems.map(x=>x.key)).size,2);
  assert.deepEqual(reportAfter.data.inStockItems.map(x=>[x.stockId,x.inboundDate,x.quantity]),[[early,'2026-08-25',93],[late,'2026-09-10',288]]);
  assert.equal(reportAfter.data.inStockItems.reduce((n,x)=>n+x.quantity,0),381);assert.equal(reportAfter.data.summary.openFeeUsd,49.35);assert.equal(reportAfter.data.summary.pendingFeeUsd,19);assert.equal(reportAfter.data.summary.settledFeeUsd,1.4);assert.equal(reportAfter.data.summary.totalFeeUsd,69.75);
  const historicRow=reportAfter.data.outboundItems.find(x=>x.settlementId===oldFee.id);assert.equal(historicRow.sku,'');assert.equal(historicRow.inboundDate,'2026-08-25');assert.equal(historicRow.quantity,40);
  const groups=h.load('lib/pricing-product-groups.ts').groupPricingProducts(reportAfter.data.rows);
  assert.equal(groups.length,historicalAnchor==='current'?1:2);
  if(historicalAnchor==='removed'){assert.equal(historicRow.currentProductKey,undefined);const oldGroup=groups.find(g=>g.rows.some(x=>x.settlementId===oldFee.id));assert.equal(oldGroup.sku,'');assert.equal(oldGroup.inStockQuantity,0);const liveGroup=groups.find(g=>g.inStockQuantity);assert.equal(liveGroup.sku,'LT-145PLUS-01');assert.equal(liveGroup.inStockQuantity,381);}
 }finally{h.sqlite.close();}}
});

test('新出库结算使用客户当前费率与90天免租，历史已确认账单/原库存参数不变，重试及撤销完整',async()=>{
 const{h,early,late}=setup();try{
  h.sqlite.prepare('UPDATE stocks SET storage_rate_usd=.7,free_days=0').run();
  h.sqlite.prepare("INSERT INTO storage_fee_settlements(stock_id,operation_id,location_code,product,sku,customer_name,inbound_date,outbound_at,quantity,item_volume_m3,rate_usd_m3_day,free_days,storage_days,billable_days,total_volume_m3,fee_usd,settlement_status,created_at) VALUES (?,'old-confirmed','A33',?,?,?,'2026-08-25','2026-09-01T23:59:59.000Z',40,.01,.7,0,7,7,.4,1.96,'settled','2026-09-01T23:59:59.000Z')").run(early,product,sku,customer);
  const old=settlements(h)[0],before=physical(h);h.setting('pricing_customer_override:'+customer,{customerName:customer,ratePerM3Day:.5,freeDays:90});
  const c=await context(h),choice=c.choices[0],body={requestId:randomUUID(),expectedRevision:c.revision,key:choice.key,members:refs(choice),quantity:1,boxes:0,outboundDate,selected:[{id:late,version:choice.members.find(r=>r.id===late).version,quantity:1,boxes:0}]};
  const r=await h.call('goods/outbound','POST',body);assert.equal(r.status,200,JSON.stringify(r.data));
  assert.equal(physical(h).find(s=>s.id===early).total_quantity,193);assert.equal(physical(h).find(s=>s.id===late).total_quantity,287);
  assert.deepEqual(state(h).categories[0].lots.map(l=>l.quantity),[192,288]);assert.ok(physical(h).every(s=>s.storage_rate_usd===.7&&s.free_days===0));assert.ok(state(h).categories[0].lots.every(l=>l.snapshot.storageRateUsd===.7&&l.snapshot.freeDays===0));
  const added=settlements(h).at(-1);assert.equal(added.rate_usd_m3_day,.5);assert.equal(added.free_days,90);assert.equal(added.billable_days,0);assert.equal(added.fee_usd,0);assert.equal(added.previous_storage_rate_usd,.7);assert.equal(added.previous_free_days,0);assert.equal(added.inbound_date,'2026-08-25');assert.equal(added.outbound_at.slice(0,10),outboundDate);assert.deepEqual(settlements(h)[0],old);
  const report=await h.call('pricing/report?asOf=2026-10-12&fromMonth=2026-10&toMonth=2026-10');assert.equal(report.status,200);const pending=report.data.pendingItems.find(s=>s.settlementId===added.id);assert.equal(pending.ratePerM3Day,.5);assert.equal(pending.freeDays,90);assert.equal(pending.feeUsd,0);assert.equal(pending.periodFeeUsd,0);
  h.setting('pricing_customer_override:'+customer,{customerName:customer,ratePerM3Day:3,freeDays:0});assert.deepEqual((await h.call('goods/outbound','POST',body)).data,r.data);assert.deepEqual(settlements(h).at(-1),added);
  const log=h.sqlite.prepare('SELECT id FROM audit_logs WHERE operation_id=?').get(body.requestId);assert.equal((await h.call('movements','POST',{id:log.id})).status,200);assert.deepEqual(settlements(h),[old]);assert.equal(state(h).categories.length,0);assert.deepEqual(physical(h).map(s=>[s.id,s.total_quantity,s.storage_rate_usd,s.free_days]),before.map(s=>[s.id,s.total_quantity,s.storage_rate_usd,s.free_days]));
 }finally{h.sqlite.close();}
});

test('客户费率/免租可分别覆盖，未覆盖部分保持原批次参数，其他客户规则不能串用',async()=>{
 for(const [rate,days,expectedRate,expectedDays,fee] of [[.2,null,.2,10,7.6],[null,90,.5,90,0],[0,0,0,0,0]]){const{h,late}=setup();try{
  h.setting('pricing_customer_override:'+customer,{customerName:customer,ratePerM3Day:rate,freeDays:days});h.setting('pricing_customer_override:另一商家',{customerName:'另一商家',ratePerM3Day:9,freeDays:0});const r=await dispatch(h,late,100);assert.equal(r.status,200,JSON.stringify(r.data));const s=settlements(h)[0];assert.equal(s.rate_usd_m3_day,expectedRate);assert.equal(s.free_days,expectedDays);assert.equal(s.fee_usd,fee);
 }finally{h.sqlite.close();}}
});

test('出库读取客户规则后并发修改或插入规则，整批拒绝且库存/费用不部分写入',async()=>{
 for(const existing of [true,false]){const{h,late}=setup();try{
  if(existing)h.setting('pricing_customer_override:'+customer,{customerName:customer,ratePerM3Day:.5,freeDays:90});
  const prepare=h.adapter.prepare;let armed=true;h.adapter.prepare=sql=>{if(armed&&sql.startsWith('INSERT INTO goods_transaction_guards')){armed=false;h.adapter.beforeBatch=()=>h.setting('pricing_customer_override:'+customer,{customerName:customer,ratePerM3Day:3,freeDays:0});}return prepare(sql);};
  const before=physical(h),r=await dispatch(h,late,1);assert.equal(r.status,409,JSON.stringify(r.data));assert.deepEqual(physical(h),before);assert.equal(settlements(h).length,0);assert.equal(state(h).categories.length,0);assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM goods_operations').get().n,0);
 }finally{h.sqlite.close();}}
});

test('整张出库单的多个同产品行都使用当前客户规则，并保留先后FIFO扣减',async()=>{
 const{h,early,late}=setup();try{
  h.setting('pricing_customer_override:'+customer,{customerName:customer,ratePerM3Day:.5,freeDays:90});const c=await context(h),p=c.choices[0],line=quantity=>({key:p.key,members:refs(p),quantity,boxes:0,selected:[{id:late,version:p.members.find(s=>s.id===late).version,quantity,boxes:0}]});
  const r=await h.call('goods/document','POST',{requestId:randomUUID(),mode:'outbound',expectedRevision:c.revision,outboundDate,lines:[line(100),line(110)]});assert.equal(r.status,200,JSON.stringify(r.data));assert.deepEqual(physical(h).map(s=>s.total_quantity),[193,78]);assert.deepEqual(state(h).categories[0].lots.map(l=>l.quantity),[0,271]);assert.deepEqual(settlements(h).map(s=>[s.stock_id,s.quantity,s.rate_usd_m3_day,s.free_days,s.fee_usd]),[[early,100,.5,90,0],[early,93,.5,90,0],[late,17,.5,90,0]]);
 }finally{h.sqlite.close();}
});
