import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import * as XLSX from 'xlsx';
import {warehouseApiHarness} from './helpers/warehouse-api-harness.mjs';

async function fixture() {
  const h=warehouseApiHarness();h.seedUser(1,null,'admin','boss');
  h.setting('pricing_customer_override:QT',{customerName:'QT',ratePerM3Day:0.5,freeDays:10});
  async function stock(product,customerName='QT') {
    const r=await h.call('stocks','POST',{locationCode:'A1',inboundDate:'2026-07-01',product,sku:product,barcode:'000123',customerName,totalQuantity:10,totalBoxes:2,layerCount:1,inboundSource:'return',billingMode:'item',itemVolumeM3:0.1,storageRateUsd:2,freeDays:5});
    assert.equal(r.status,200);return r.data.stock;
  }
  await stock('在库');
  for(const [product,date,status] of [['待确认','2026-07-11','pending'],['已确认','2026-07-21','settled'],['已取消','2026-07-16','cancelled']]) {
    const row=await stock(product);const r=await h.call('stocks','PATCH',{id:row.id,quantity:10,boxes:2,outboundAt:date});assert.equal(r.status,200);
    h.sqlite.prepare('UPDATE storage_fee_settlements SET settlement_status=? WHERE id=?').run(status,r.data.settlement.id);
  }
  await stock('其他客户','OTHER');
  return h;
}
async function download(h,query='fromMonth=2026-07&toMonth=2026-07&customer=QT',token='test-token-1') {
  const response=await h.load(resolve('app/api/pricing/report/export/route.ts')).GET(new Request('http://local.test/api/pricing/report/export?'+query,{headers:{cookie:'wms_session='+token}}));
  return {status:response.status,workbook:response.ok?XLSX.read(await response.arrayBuffer(),{type:'array',cellFormula:true}):null};
}
const values=sheet=>XLSX.utils.sheet_to_json(sheet,{header:1});
const snapshot=h=>JSON.stringify({stocks:h.sqlite.prepare('SELECT * FROM stocks').all(),settlements:h.sqlite.prepare('SELECT * FROM storage_fee_settlements').all()});

test('monthly workbook adds three unconfirmed sheets with correct fees and keeps formal charges separate',async()=>{
  const h=await fixture();try {
    const before=snapshot(h);const {status,workbook:w}=await download(h);assert.equal(status,200);
    assert.deepEqual(w.SheetNames,['客户账单明细','汇总','在库仓储费','已出库仓储费','汇总（未确认）','出库（未确认）','在库（未确认）']);
    const outbound=values(w.Sheets['出库（未确认）']),stock=values(w.Sheets['在库（未确认）']);
    const header=outbound[0],column=name=>header.indexOf(name),value=(rows,name)=>rows[1][column(name)];
    assert.equal(outbound.length,3);assert.equal(stock.length,3);
    assert.equal(value(outbound,'产品名称'),'待确认');assert.equal(value(stock,'产品名称'),'在库');
    assert.equal(value(outbound,'计价状态'),'未确认');assert.equal(value(stock,'计价状态'),'未确认');
    assert.equal(value(outbound,'账期仓储费USD'),10);assert.equal(value(stock,'账期仓储费USD'),10.5);
    assert.equal(value(outbound,'费率USD/m³/天'),2);assert.equal(value(stock,'费率USD/m³/天'),0.5);
    assert.equal(value(outbound,'免租天数'),5);assert.equal(value(stock,'免租天数'),10);
    assert.equal(value(outbound,'条形码'),'000123');
    const feeCol=XLSX.utils.encode_col(column('账期仓储费USD'));
    for(const name of ['出库（未确认）','在库（未确认）']){
      const sheet=w.Sheets[name];assert.match(sheet[feeCol+'2'].f,/IF\(.+ROUND\(.+\*.+\*.+,6\),0\)/);
      assert.equal(sheet[feeCol+'3'].f,`SUM(${feeCol}2:${feeCol}2)`);
    }
    const summary=w.Sheets['汇总（未确认）'];assert.equal(summary.D5.v,10.5);assert.equal(summary.D6.v,10);assert.equal(summary.D7.v,20.5);
    assert.equal(summary.D5.f,`SUM('在库（未确认）'!${feeCol}2:${feeCol}2)`);
    assert.equal(summary.D6.f,`SUM('出库（未确认）'!${feeCol}2:${feeCol}2)`);assert.equal(summary.D7.f,'SUM(D5:D6)');
    const formal=values(w.Sheets['客户账单明细']);assert.deepEqual(formal.slice(5,-1).map(row=>row[column('产品名称')]).sort(),['在库','已确认'].sort());
    assert.equal(formal.at(-1)[column('账期仓储费USD')],40.5);
    assert.equal(snapshot(h),before,'export must not confirm or alter inventory/settlements');
  } finally {h.sqlite.close();}
});

test('pending-only export works, inventory filters are respected, and empty ranges have no invalid formulas',async()=>{
  const h=await fixture();try {
    for(const scope of ['in_stock','outbound']){
      const {status,workbook:w}=await download(h,'fromMonth=2026-07&toMonth=2026-07&customer=QT&inventoryStatus='+scope+(scope==='outbound'?'&settlementStatus=pending':''));assert.equal(status,200);
      const empty=scope==='outbound'?'在库（未确认）':'出库（未确认）';assert.equal(values(w.Sheets[empty]).length,1);
      assert.equal(w.Sheets['汇总（未确认）'][scope==='outbound'?'D5':'D6'].f,'0');
      if(scope==='outbound'){assert.equal(values(w.Sheets['客户账单明细']).length,5);assert.equal(w.Sheets['汇总（未确认）'].D7.v,10);}
      assert.doesNotMatch(JSON.stringify(w),/#REF!|#DIV\/0!/);
    }
    assert.equal((await download(h,'fromMonth=2026-07&toMonth=2026-07&customer=MISSING')).status,400);
    assert.equal((await download(h,'fromMonth=2026-07&toMonth=2026-07')).status,400);
  }finally{h.sqlite.close();}
});

test('legacy exports stay confirmed-only and unconfirmed sheets require pricing permission',async()=>{
  const h=await fixture();try {
    const {status,workbook:w}=await download(h,'asOf=2026-07-31&customer=QT');assert.equal(status,200);assert.ok(!w.SheetNames.some(x=>x.includes('未确认')));
    h.seedUser(2,[]);assert.equal((await download(h,undefined,'test-token-2')).status,403);
  }finally{h.sqlite.close();}
});

test('multi-customer invoices preserve individual prices and exact names without duplicate charges',async()=>{
  const h=await fixture();try {
    h.setting('pricing_customer_override:X2X',{customerName:'X2X',ratePerM3Day:1,freeDays:0});
    for(const customerName of ['X2X','xzx','XZX']) {
      const r=await h.call('stocks','POST',{locationCode:'A1',inboundDate:'2026-07-01',product:'同款',sku:'SAME',customerName,totalQuantity:10,totalBoxes:2,layerCount:1,inboundSource:'return',billingMode:'item',itemVolumeM3:0.1,storageRateUsd:2,freeDays:5});assert.equal(r.status,200);
    }
    const before=snapshot(h);
    const query='fromMonth=2026-07&toMonth=2026-07&customer=QT&customer=X2X&customer=xzx&customer=QT&customer=';
    const {status,workbook:w}=await download(h,query);assert.equal(status,200);
    const rows=values(w.Sheets['在库（未确认）']);const col=name=>rows[0].indexOf(name);
    const names=rows.slice(1,-1).map(r=>r[col('客户')]);
    assert.deepEqual(names.sort(),['QT','X2X','xzx'].sort());
    assert.equal(w.Sheets['汇总（未确认）'].D5.v,93.5);
    assert.equal(w.Sheets['汇总（未确认）'].D6.v,10);
    assert.equal(w.Sheets['汇总（未确认）'].D7.v,103.5);
    const reportResponse=await h.load(resolve('app/api/pricing/report/route.ts')).GET(new Request('http://local.test/api/pricing/report?'+query+'&customerPricing=1',{headers:{cookie:'wms_session=test-token-1'}}));
    assert.equal(reportResponse.status,200);const report=await reportResponse.json();
    assert.deepEqual([...new Set(report.inStockItems.map(r=>r.customerName))].sort(),['QT','X2X','xzx'].sort());
    assert.equal(snapshot(h),before);
  }finally{h.sqlite.close();}
});

test('pricing customer correction updates only the selected live stock with version and permission guards',async()=>{
 const h=await fixture();try {
  const row=h.sqlite.prepare("SELECT * FROM stocks WHERE customer_name='QT'").get();
  const historical=JSON.stringify(h.sqlite.prepare('SELECT * FROM storage_fee_settlements').all());
  const res=await h.call('stocks','PUT',{id:row.id,version:row.version,customerName:'XZX',totalQuantity:999});assert.equal(res.status,200);
  assert.equal(res.data.stock.customerName,'XZX');assert.equal(res.data.stock.totalQuantity,row.total_quantity);assert.equal(res.data.stock.version,row.version+1);
  assert.equal(JSON.stringify(h.sqlite.prepare('SELECT * FROM storage_fee_settlements').all()),historical);
  const report=await h.call('pricing/report?fromMonth=2026-07&toMonth=2026-07&customer=XZX');assert.equal(report.data.inStockItems.length,1);
  const logs=h.sqlite.prepare("SELECT * FROM audit_logs WHERE summary LIKE '%客户 QT→XZX%'").all();assert.equal(logs.length,1);
  assert.equal(JSON.parse(logs[0].before_snapshot).customerName,'QT');assert.equal(JSON.parse(logs[0].after_snapshot).customerName,'XZX');
  assert.equal((await h.call('stocks','PUT',{id:row.id,version:row.version,customerName:'STALE'})).status,409);
  assert.equal((await h.call('stocks','PUT',{id:row.id,version:row.version+1,customerName:' '})).status,400);
  h.seedUser(3,['pricing.manage']);h.seedUser(4,['stock.edit']);
  for(const token of ['test-token-3','test-token-4'])assert.equal((await h.call('stocks','PUT',{id:row.id,version:row.version+1,customerName:'DENIED'},token)).status,403);
  h.adapter.beforeBatch=()=>h.sqlite.prepare('UPDATE stocks SET version=version+1 WHERE id=?').run(row.id);
  assert.equal((await h.call('stocks','PUT',{id:row.id,version:row.version+1,customerName:'RACE'})).status,409);
  assert.equal(h.sqlite.prepare("SELECT count(*) AS n FROM audit_logs WHERE summary LIKE '%RACE%'").get().n,0);
  assert.equal(h.sqlite.prepare('SELECT customer_name FROM stocks WHERE id=?').get(row.id).customer_name,'XZX');
  h.sqlite.prepare('DELETE FROM stocks WHERE id=?').run(row.id);
  assert.equal((await h.call('stocks','PUT',{id:row.id,version:row.version+2,customerName:'GONE'})).status,404);
 }finally{h.sqlite.close();}
});

test('outbound customer correction supports pending and confirmed records without changing prices or live stock',async()=>{
 const h=await fixture();try {
  const stockBefore=JSON.stringify(h.sqlite.prepare('SELECT * FROM stocks').all());
  const rows=h.sqlite.prepare("SELECT * FROM storage_fee_settlements WHERE settlement_status IN ('pending','settled')").all();
  h.setting('pricing_customer_override:NEW',{customerName:'NEW',ratePerM3Day:99,freeDays:999});
  for(const row of rows){
   const r=await h.call('pricing/settlements/customer','PUT',{id:row.id,version:row.version,customerName:'NEW',feeUsd:0,quantity:999});assert.equal(r.status,200);
   const saved=h.sqlite.prepare('SELECT * FROM storage_fee_settlements WHERE id=?').get(row.id);
   assert.deepEqual({...saved,customer_name:row.customer_name,version:row.version},{...row});
   assert.equal(saved.customer_name,'NEW');assert.equal(saved.version,row.version+1);
   assert.equal((await h.call('pricing/settlements/customer','PUT',{id:row.id,version:row.version,customerName:'STALE'})).status,409);
  }
  assert.equal(JSON.stringify(h.sqlite.prepare('SELECT * FROM stocks').all()),stockBefore);
  const {workbook:w}=await download(h,'fromMonth=2026-07&toMonth=2026-07&customer=NEW');
  assert.equal(w.Sheets['汇总（未确认）'].D6.v,10);
  const formal=values(w.Sheets['客户账单明细']);assert.equal(formal.at(-1)[formal[4].indexOf('账期仓储费USD')],30);
  assert.equal(h.sqlite.prepare("SELECT count(*) AS n FROM audit_logs WHERE action='修改出库客户'").get().n,2);
  const cancelled=h.sqlite.prepare("SELECT * FROM storage_fee_settlements WHERE settlement_status='cancelled'").get();
  assert.equal((await h.call('pricing/settlements/customer','PUT',{id:cancelled.id,version:cancelled.version,customerName:'NEW'})).status,409);
  h.seedUser(7,['stock.edit']);assert.equal((await h.call('pricing/settlements/customer','PUT',{id:rows[0].id,version:rows[0].version+1,customerName:'NO'},'test-token-7')).status,403);
  assert.equal((await h.call('pricing/settlements/customer','PUT',{id:rows[0].id,version:rows[0].version+1,customerName:' '})).status,400);
  h.adapter.beforeBatch=()=>h.sqlite.prepare('UPDATE storage_fee_settlements SET version=version+1 WHERE id=?').run(rows[0].id);
  assert.equal((await h.call('pricing/settlements/customer','PUT',{id:rows[0].id,version:rows[0].version+1,customerName:'RACE'})).status,409);
  assert.equal(h.sqlite.prepare("SELECT count(*) AS n FROM audit_logs WHERE action='修改出库客户'").get().n,2);
 }finally{h.sqlite.close();}
});

test('billing details show inbound order and exact note from current stock or its outbound snapshot',async()=>{
 const h=warehouseApiHarness();h.seedUser(1,null,'admin','boss');try {
  const created=await h.call('stocks','POST',{locationCode:'A1',inboundDate:'2026-07-01',product:'备注测试',inboundOrder:'000IB-123',note:'首行\n第二行 <原样>',customerName:'QT',totalQuantity:10,totalBoxes:2,layerCount:1,inboundSource:'return',billingMode:'item',itemVolumeM3:0.1});assert.equal(created.status,200);
  await h.call('stocks','PATCH',{id:created.data.stock.id,quantity:2,boxes:1,outboundAt:'2026-07-11'});
  await h.call('stocks','POST',{id:created.data.stock.id,note:'当前新备注',inboundOrder:'000IB-456'});
  const report=await h.call('pricing/report?fromMonth=2026-07&toMonth=2026-07');
  assert.equal(report.data.inStockItems[0].note,'当前新备注');assert.equal(report.data.inStockItems[0].inboundOrder,'000IB-456');
  assert.equal(report.data.outboundItems[0].note,'首行\n第二行 <原样>');assert.equal(report.data.outboundItems[0].inboundOrder,'000IB-123');
  h.sqlite.prepare("UPDATE audit_logs SET before_snapshot='broken' WHERE action='出库'").run();
  const legacy=await h.call('pricing/report?fromMonth=2026-07&toMonth=2026-07');assert.equal(legacy.status,200);assert.equal(legacy.data.outboundItems[0].note,'');
 }finally{h.sqlite.close();}
});
