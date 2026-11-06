import assert from 'node:assert/strict';
import test from 'node:test';
import {warehouseApiHarness} from './helpers/warehouse-api-harness.mjs';

function fresh(){
 const h=warehouseApiHarness();h.seedUser(1,null,'admin','日期回算复核');
 h.setting('warehouse_zones',[{id:'NEW_A',title:'模拟区',codes:['A1']}]);
 const id=h.stock('A1');
 h.sqlite.prepare("UPDATE stocks SET product='截止日试算',customer_name='模拟商家',sku='ASOF-001',inbound_date='2026-09-01',total_quantity=10,total_boxes=0,inbound_source='return',billing_mode='item',item_volume_m3=.1,storage_rate_usd=.5,free_days=0 WHERE id=?").run(id);
 return{h,id};
}
const sum=(rows,key)=>Number(rows.reduce((n,r)=>n+r[key],0).toFixed(6));

test('历史截止日还原随后出库数量：9/20出4件后回看9/10仍有10件、费用4.5',async()=>{
 const {h,id}=fresh();try{
  const context=(await h.call('goods')).data,choice=context.choices[0];
  const shipment=await h.call('goods/outbound','POST',{requestId:crypto.randomUUID(),expectedRevision:context.revision,key:choice.key,members:choice.members.map(r=>({id:r.id,version:r.version})),quantity:4,boxes:0,outboundDate:'2026-09-20',selected:[{id,version:0,quantity:4,boxes:0}]});
  assert.equal(shipment.status,200,JSON.stringify(shipment.data));
  assert.equal(h.sqlite.prepare('SELECT total_quantity FROM stocks WHERE id=?').get(id).total_quantity,6);
  const report=await h.call('pricing/report?asOf=2026-09-10&inventoryStatus=in_stock');
  assert.equal(report.status,200,JSON.stringify(report.data));
  assert.equal(sum(report.data.rows,'quantity'),10,'截止日之后出库的4件仍属于当时在库，不能用当前6件替代');
  assert.equal(sum(report.data.rows,'feeUsd'),4.5,'10件 × .1m³ × 9天 × $.5，实际出库在截止日以后');
  const all=await h.call('pricing/report?asOf=2026-09-10');
  assert.equal(sum(all.data.rows,'feeUsd'),4.5,'所有状态视图不能遗漏或重复收取截止日后的出库批次');
  const outboundOnly=await h.call('pricing/report?asOf=2026-09-10&inventoryStatus=outbound');
  assert.equal(outboundOnly.data.rows.length,0,'当时尚未出库的货物不能出现在历史已出库筛选中');
  const monthly=await h.call('pricing/report?asOf=2026-09-10&fromMonth=2026-09&toMonth=2026-09&inventoryStatus=in_stock');
  assert.equal(sum(monthly.data.rows,'quantity'),10);
  assert.equal(sum(monthly.data.rows,'periodFeeUsd'),4.5);
  const futureId=h.stock('A1');h.sqlite.prepare("UPDATE stocks SET product='以后才入库',inbound_date='2026-09-15',total_quantity=100 WHERE id=?").run(futureId);
  const excludingFuture=await h.call('pricing/report?asOf=2026-09-10&inventoryStatus=in_stock');
  assert.equal(sum(excludingFuture.data.rows,'quantity'),10,'截止日之后才入库的商品不能提前算在库');
  const settled=h.sqlite.prepare('SELECT outbound_at,quantity,fee_usd FROM storage_fee_settlements').get();
  assert.deepEqual([settled.outbound_at,settled.quantity,settled.fee_usd],['2026-09-20T23:59:59.000Z',4,3.8],'回看历史日期不能重写已保存出库费用');
  h.sqlite.prepare("UPDATE storage_fee_settlements SET settlement_status='settled',settled_at='2026-10-01',settled_by='测试确认人'").run();
  const confirmed=await h.call('pricing/report?asOf=2026-09-10&inventoryStatus=in_stock');
  assert.equal(sum(confirmed.data.rows,'quantity'),10,'即使现已确认结算，实际出库日之前仍是当时在库');
  assert.ok(confirmed.data.rows.every(r=>r.settlementStatus===null&&r.settledAt===null));
  assert.equal(h.sqlite.prepare('SELECT fee_usd FROM storage_fee_settlements').get().fee_usd,3.8);
 }finally{h.sqlite.close()}
});

test('月度账单显式asOf限制计算截止日：9月查至9/10只算9天、费用4.5',async()=>{
 const {h}=fresh();try{
  const report=await h.call('pricing/report?fromMonth=2026-09&toMonth=2026-09&asOf=2026-09-10');
  assert.equal(report.status,200,JSON.stringify(report.data));
  assert.equal(report.data.summary.asOf,'2026-09-10');
  assert.equal(report.data.summary.periodEndExclusive,'2026-09-10','月度账单不能显示截止9/10却实际算到9/30');
  assert.equal(sum(report.data.rows,'periodFeeUsd'),4.5);
  assert.ok(report.data.rows.every(r=>r.periodBillableDays===9));
  const future=await h.call('pricing/report?asOf=2026-08-31&fromMonth=2026-09&toMonth=2026-09');
  assert.equal(future.status,200);
  assert.equal(sum(future.data.rows,'periodFeeUsd'),0,'截止日早于账期起点不能产生未来仓储费');
 }finally{h.sqlite.close()}
});
