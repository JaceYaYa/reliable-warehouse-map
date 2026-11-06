import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {warehouseApiHarness} from './warehouse-api-harness.mjs';

// In-memory database only. Calls the actual authenticated route handlers and pricing implementation.
export async function runDateStorageTrialA(){
 const h=warehouseApiHarness();h.seedUser(1,null,'admin','试算A');
 h.setting('warehouse_zones',[{id:'NEW_A',title:'试算区',codes:['A1','B3','C1']}]);
 const context=async()=>{const r=await h.call('goods');assert.equal(r.status,200);return r.data};
 const refs=c=>c.members.map(r=>({id:r.id,version:r.version}));
 const apiCalls=[];
 async function call(path,body){const r=await h.call(path,'POST',body);apiCalls.push({path,body,response:r});assert.equal(r.status,200,JSON.stringify(r.data));return r.data}
 async function create(product,customerName,sku,productSpec){const c=await context();return call('goods',{requestId:crypto.randomUUID(),expectedRevision:c.revision,product,customerName,sku,productSpec});}
 async function inbound(product,date,code,quantity,boxes,unit='item'){
  const c=await context(),choice=c.choices.find(x=>x.product===product);
  return call('goods/document',{requestId:crypto.randomUUID(),expectedRevision:c.revision,mode:'inbound',receipt:{inboundDate:date},lines:[{key:choice.key,members:refs(choice),inventoryUnit:unit,quantity,boxes,receipt:{inboundSource:'return',requirePlacementDetails:true,inboundOrder:`TRIAL-${date}-${code}`},placements:[{locationCode:code,layerCount:1,quantity,boxes,productCondition:'good',barcodes:[],productPrefix:'试算A'}]}]});
 }
 async function outbound(product,date,selections){
  const c=await context(),choice=c.choices.find(x=>x.product===product);
  return call('goods/document',{requestId:crypto.randomUUID(),expectedRevision:c.revision,mode:'outbound',outboundDate:date,lines:[{key:choice.key,members:refs(choice),quantity:selections.reduce((n,s)=>n+s.quantity,0),boxes:selections.reduce((n,s)=>n+s.boxes,0),selected:selections.map(s=>{const member=choice.members.find(m=>m.locationCode===s.code);return{id:member.id,version:member.version,quantity:s.quantity,boxes:s.boxes}})}]});
 }
 const simplify=rows=>rows.map(r=>({customer:r.customerName,product:r.productName,status:r.inventoryStatus,inboundDate:r.inboundDate,endDate:r.endDate,quantity:r.quantity,boxes:r.boxes,days:r.periodBillableDays,fee:r.periodFeeUsd}));
 try{
  h.setting('pricing_defaults',{defaultRatePerM3Day:.7,defaultFreeDays:2});
  await create('日期试算A-件','模拟商家A','TRIAL-A-ITEM',{billingMode:'item',itemVolumeM3:.01});
  await inbound('日期试算A-件','2026-09-01','A1',100,0);
  await inbound('日期试算A-件','2026-09-10','B3',60,0);
  await outbound('日期试算A-件','2026-09-20',[{code:'B3',quantity:60,boxes:0},{code:'A1',quantity:60,boxes:0}]);
  const firstFees=h.sqlite.prepare('SELECT inbound_date,outbound_at,quantity,storage_days,billable_days,fee_usd FROM storage_fee_settlements ORDER BY id').all();
  assert.deepEqual(firstFees.map(r=>[r.inbound_date,r.outbound_at,r.quantity,r.storage_days,r.billable_days,r.fee_usd]),[['2026-09-01','2026-09-20T23:59:59.000Z',100,19,17,11.9],['2026-09-10','2026-09-20T23:59:59.000Z',20,10,8,1.12]]);
  const physicalAfterFirst=h.sqlite.prepare('SELECT location_code,inbound_date,total_quantity FROM stocks ORDER BY id').all();
  assert.deepEqual(physicalAfterFirst.map(r=>[r.location_code,r.inbound_date,r.total_quantity]),[['A1','2026-09-01',40],['B3','2026-09-10',0]]);
  const septemberBefore=(await h.call('pricing/report?fromMonth=2026-09&toMonth=2026-09')).data;
  assert.equal(Number(septemberBefore.rows.reduce((n,r)=>n+r.periodFeeUsd,0).toFixed(6)),18.34);
  await outbound('日期试算A-件','2026-10-01',[{code:'A1',quantity:15,boxes:0}]);
  const secondFee=h.sqlite.prepare('SELECT inbound_date,outbound_at,quantity,storage_days,billable_days,fee_usd FROM storage_fee_settlements ORDER BY id DESC LIMIT 1').get();
  assert.deepEqual([secondFee.inbound_date,secondFee.outbound_at,secondFee.quantity,secondFee.storage_days,secondFee.billable_days,secondFee.fee_usd],['2026-09-10','2026-10-01T23:59:59.000Z',15,21,19,1.995]);
  const septemberAfter=(await h.call('pricing/report?fromMonth=2026-09&toMonth=2026-09')).data;
  assert.equal(Number(septemberAfter.rows.reduce((n,r)=>n+r.periodFeeUsd,0).toFixed(6)),18.34);
  h.setting('pricing_defaults',{defaultRatePerM3Day:.4,defaultFreeDays:3});
  await create('日期试算A-箱','模拟商家B','TRIAL-A-BOX',{billingMode:'box',boxVolumeM3:.25});
  await inbound('日期试算A-箱','2026-09-15','C1',0,10,'box');
  await outbound('日期试算A-箱','2026-09-21',[{code:'C1',quantity:0,boxes:4}]);
  const boxFee=h.sqlite.prepare('SELECT inbound_date,outbound_at,quantity,boxes,storage_days,billable_days,fee_usd FROM storage_fee_settlements ORDER BY id DESC LIMIT 1').get();
  assert.deepEqual([boxFee.inbound_date,boxFee.outbound_at,boxFee.quantity,boxFee.boxes,boxFee.storage_days,boxFee.billable_days,boxFee.fee_usd],['2026-09-15','2026-09-21T23:59:59.000Z',0,4,6,3,1.2]);
  const september=(await h.call('pricing/report?fromMonth=2026-09&toMonth=2026-09')).data;
  assert.equal(Number(september.rows.reduce((n,r)=>n+r.periodFeeUsd,0).toFixed(6)),27.34);
  const october=(await h.call('pricing/report?fromMonth=2026-10&toMonth=2026-10')).data;
  const pricing=h.load(resolve('lib/pricing.ts'));
  const boundaries=[
   {inboundDate:'2026-09-01',endDate:'2026-09-01',freeDays:0,expectedDays:0,expectedFee:0},
   {inboundDate:'2026-09-01',endDate:'2026-09-02',freeDays:0,expectedDays:1,expectedFee:.007},
   {inboundDate:'2026-09-01',endDate:'2026-09-03',freeDays:2,expectedDays:0,expectedFee:0},
   {inboundDate:'2026-09-01',endDate:'2026-09-04',freeDays:2,expectedDays:1,expectedFee:.007},
  ].map(c=>{const actual=pricing.calculateStorageFee({...c,quantity:1,itemVolumeM3:.01,rateUsdM3Day:.7});assert.equal(actual.billableDays,c.expectedDays);assert.equal(actual.feeUsd,c.expectedFee);return{...c,actual}});
  const atSeptember20=(await h.call('pricing/report?asOf=2026-09-20')).data;
  const historyCurrentStock=atSeptember20.rows.filter(r=>r.inventoryStatus==='in_stock');
  assert.equal(historyCurrentStock.reduce((n,r)=>n+r.quantity,0),40);
  const audit=h.sqlite.prepare("SELECT action,summary,created_at FROM audit_logs WHERE action IN ('入库','出库') ORDER BY id").all();
  assert.ok(audit.some(r=>r.summary.includes('出库日期 2026-09-20')));
  const report={scope:'本地内存数据库、真实路由函数；没有在线写库存',apiCalls,firstFees,secondFee,boxFee,physicalAfterFirst,physicalFinal:h.sqlite.prepare('SELECT location_code,inbound_date,total_quantity,total_boxes FROM stocks ORDER BY id').all(),septemberBefore:simplify(septemberBefore.rows),septemberAfter:simplify(septemberAfter.rows),september:simplify(september.rows),septemberTotal:27.34,october:simplify(october.rows),boundaries,audit,legacyHistoricalAsOf:{asOf:'2026-09-20',rows:simplify(atSeptember20.rows),currentStockQuantity:historyCurrentStock.reduce((n,r)=>n+r.quantity,0),expectedHistoricalRemainingItemQuantity:40,note:'已修复：10/1出库后回看9/20，成本在库40件而非当前25件；9/21出4箱前的9/20回看仍在库10箱。实际库存和已保存出库费用未被回看操作修改。'}};
  return report;
 }finally{h.sqlite.close()}
}

