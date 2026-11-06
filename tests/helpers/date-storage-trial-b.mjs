import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import * as XLSX from 'xlsx';
import {warehouseApiHarness} from './warehouse-api-harness.mjs';

export const TRIAL_B_TODAY='2026-10-06';
const resultSet=()=>({scope:'Isolated local API handlers; billing date fixed to 2026-10-06; no online inventory writes',today:TRIAL_B_TODAY,scenarios:[],warnings:[]});
const refs=c=>c.members.map(r=>({id:r.id,version:r.version}));
const choice=async(h,product)=>{const ctx=(await h.call('goods')).data;return {ctx,c:ctx.choices.find(c=>c.product===product)}};
const fresh=()=>{const h=warehouseApiHarness();h.load(resolve('lib/pricing.ts')).chinaTodayDate=()=>TRIAL_B_TODAY;h.seedUser(1,null,'admin','Trial-B');h.setting('warehouse_zones',[{id:'A',title:'A区',codes:['A1','A2','A3','B1','B2']}]);h.setting('pricing_defaults',{defaultRatePerM3Day:.8,defaultFreeDays:3});return h;};
async function create(h,product,mode='item',volume=.02){const r=await h.call('goods','POST',{requestId:crypto.randomUUID(),expectedRevision:(await h.call('goods')).data.revision,product,customerName:'试算B商家',sku:`B-${product}`,productSpec:{billingMode:mode,[mode==='box'?'boxVolumeM3':'itemVolumeM3']:volume}});assert.equal(r.status,200,JSON.stringify(r.data));}
async function inbound(h,product,date,code,quantity,boxes=0,unit='item'){const {ctx,c}=await choice(h,product);const r=await h.call('goods/document','POST',{requestId:crypto.randomUUID(),expectedRevision:ctx.revision,mode:'inbound',receipt:{inboundDate:date},lines:[{key:c.key,members:refs(c),inventoryUnit:unit,quantity,boxes,receipt:{inboundSource:'return',inboundOrder:`B-${date}-${code}`,requirePlacementDetails:true,barcodes:[]},placements:[{locationCode:code,layerCount:1,quantity,boxes,productCondition:'good',productPrefix:'试算B',barcodes:[],note:`批次 ${date}`}]}]});assert.equal(r.status,200,JSON.stringify(r.data));return r;}
async function outbound(h,product,date,selections){const {ctx,c}=await choice(h,product);const selected=selections.map(([code,quantity,boxes])=>{const row=c.members.find(r=>r.locationCode===code);return{id:row.id,version:row.version,quantity,boxes}});return h.call('goods/document','POST',{requestId:crypto.randomUUID(),expectedRevision:ctx.revision,mode:'outbound',outboundDate:date,lines:[{key:c.key,members:refs(c),quantity:selected.reduce((n,r)=>n+r.quantity,0),boxes:selected.reduce((n,r)=>n+r.boxes,0),selected}]});}
async function exportRows(h,query){const route=h.load(resolve('app/api/pricing/report/export/route.ts'));const r=await route.GET(new Request(`http://local.test/api/pricing/report/export?${query}`,{headers:{cookie:'wms_session=test-token-1'}}));assert.equal(r.status,200);const workbook=XLSX.read(new Uint8Array(await r.arrayBuffer()),{type:'array'});return {sheets:workbook.SheetNames,rows:workbook.SheetNames.map(n=>({name:n,data:XLSX.utils.sheet_to_json(workbook.Sheets[n],{header:1})}))};}

export async function runItemTrialB(){
const results=resultSet();
const h=fresh();
try{
  await create(h,'按件双批次');await inbound(h,'按件双批次','2026-09-25','A1',30);await inbound(h,'按件双批次','2026-09-29','A2',20);
  const out=await outbound(h,'按件双批次','2026-10-03',[['A2',20,0],['A1',15,0]]);assert.equal(out.status,200,JSON.stringify(out.data));
  const fees=h.sqlite.prepare('SELECT inbound_date,outbound_at,quantity,boxes,storage_days,billable_days,fee_usd,created_at FROM storage_fee_settlements ORDER BY inbound_date').all();
  assert.deepEqual(fees.map(r=>[r.inbound_date,r.quantity,r.storage_days,r.billable_days,r.fee_usd]),[['2026-09-25',30,8,5,2.4],['2026-09-29',5,4,1,.08]]);
  assert.ok(fees.every(r=>r.outbound_at.startsWith('2026-10-03')&&!r.created_at.startsWith('2026-10-03')));
  const report=(await h.call('pricing/report?asOf=2026-10-06')).data;
  assert.equal(report.summary.pendingFeeUsd,2.48);assert.equal(report.summary.openFeeUsd,.96);assert.equal(report.summary.totalFeeUsd,3.44);
  assert.deepEqual(report.rows.filter(r=>r.inventoryStatus==='in_stock').map(r=>[r.inboundDate,r.quantity,r.storageDays,r.billableDays,r.feeUsd]),[['2026-09-29',15,7,4,.96]]);
  const sep=(await h.call('pricing/report?fromMonth=2026-09&toMonth=2026-09')).data;assert.equal(sep.summary.totalPeriodFeeUsd,1.44);
  const oct=(await h.call('pricing/report?fromMonth=2026-10&toMonth=2026-10')).data;assert.equal(oct.summary.totalPeriodFeeUsd,2);
  const joined=(await h.call('pricing/report?fromMonth=2026-09&toMonth=2026-10')).data;assert.equal(joined.summary.totalPeriodFeeUsd,3.44);
  const x=await exportRows(h,'fromMonth=2026-09&toMonth=2026-10&customer=%E8%AF%95%E7%AE%97B%E5%95%86%E5%AE%B6');
  const exportedOut=x.rows.flatMap(s=>s.data).filter(r=>r.includes('已出库'));
  assert.ok(exportedOut.some(r=>r.includes('2026-10-03')));
  results.scenarios.push({name:'双批次按件/物理库位与计价FIFO分离',inputs:{product:'按件双批次',rate:.8,freeDays:3,itemVolumeM3:.02,batches:[{date:'2026-09-25',location:'A1',quantity:30},{date:'2026-09-29',location:'A2',quantity:20}],outbound:{date:'2026-10-03',physical:[{location:'A2',quantity:20},{location:'A1',quantity:15}]}},expected:{outboundFee:2.48,remainingFeeAsOf1006:.96,total:3.44,september:1.44,october:2},actual:{fees,summary:report.summary,rows:report.rows,monthly:{september:sep.summary.totalPeriodFeeUsd,october:oct.summary.totalPeriodFeeUsd},export:x},passed:true});
  const historical=(await h.call('pricing/report?asOf=2026-10-02')).data;
  // Independent daily inventory expectation: 30 older pieces for 4 billable days + 20 newer pieces for 0.
  const historicalExpected=30*.02*.8*4;
  if(historical.summary.totalFeeUsd!==historicalExpected)results.warnings.push({name:'历史asOf未恢复尚未出库数量',query:'pricing/report?asOf=2026-10-02',expected:historicalExpected,actual:historical.summary.totalFeeUsd,rows:historical.rows,reason:'Current remaining lots are used; outbound settlements with outboundDate > asOf are excluded. AsOf is a recalculation cutoff of current balances, not a historical inventory reconstruction.'});
  const monthAsOf=(await h.call('pricing/report?fromMonth=2026-10&toMonth=2026-10&asOf=2026-10-02')).data;
  if(monthAsOf.summary.totalPeriodFeeUsd!==.48)results.warnings.push({name:'月度查询asOf不决定计算截止',query:'pricing/report?fromMonth=2026-10&toMonth=2026-10&asOf=2026-10-02',expected:.48,actual:monthAsOf.summary.totalPeriodFeeUsd,summary:monthAsOf.summary,reason:'Monthly period resolves today rather than asOf, yet summary still labels asOf 2026-10-02.'});
}finally{h.sqlite.close();}

return results;
}
export async function runBoxTrialB(){
const results=resultSet();
const b=fresh();
try{
  await create(b,'按箱双批次','box',.25);await inbound(b,'按箱双批次','2026-09-27','B1',0,8,'box');await inbound(b,'按箱双批次','2026-09-30','B2',0,6,'box');
  const out=await outbound(b,'按箱双批次','2026-10-04',[['B2',0,6],['B1',0,4]]);assert.equal(out.status,200,JSON.stringify(out.data));
  const fees=b.sqlite.prepare('SELECT inbound_date,quantity,boxes,storage_days,billable_days,fee_usd FROM storage_fee_settlements ORDER BY inbound_date').all();
  assert.deepEqual(fees.map(r=>[r.inbound_date,r.quantity,r.boxes,r.storage_days,r.billable_days,r.fee_usd]),[['2026-09-27',0,8,7,4,6.4],['2026-09-30',0,2,4,1,.4]]);
  const report=(await b.call('pricing/report?asOf=2026-10-06')).data;assert.equal(report.summary.openFeeUsd,2.4);assert.equal(report.summary.pendingFeeUsd,6.8);assert.equal(report.summary.totalFeeUsd,9.2);
  const sep=(await b.call('pricing/report?fromMonth=2026-09&toMonth=2026-09')).data;assert.equal(sep.summary.totalPeriodFeeUsd,1.6);
  const oct=(await b.call('pricing/report?fromMonth=2026-10&toMonth=2026-10')).data;assert.equal(oct.summary.totalPeriodFeeUsd,7.6);
  const historical=(await b.call('pricing/report?asOf=2026-10-02')).data;
  assert.equal(historical.rows.reduce((n,r)=>n+r.boxes,0),14);
  assert.equal(historical.summary.totalFeeUsd,3.2);
  assert.ok(historical.rows.every(r=>r.quantity===0&&r.inventoryStatus==='in_stock'));
  const cutOct=(await b.call('pricing/report?fromMonth=2026-10&toMonth=2026-10&asOf=2026-10-02')).data;
  assert.equal(cutOct.summary.totalPeriodFeeUsd,1.6);
  results.scenarios.push({name:'按箱不同批次和部分出库',inputs:{product:'按箱双批次',rate:.8,freeDays:3,boxVolumeM3:.25,batches:[{date:'2026-09-27',location:'B1',boxes:8},{date:'2026-09-30',location:'B2',boxes:6}],outbound:{date:'2026-10-04',physical:[{location:'B2',boxes:6},{location:'B1',boxes:4}]}},expected:{outboundFee:6.8,remainingFeeAsOf1006:2.4,total:9.2,september:1.6,october:7.6},actual:{fees,rows:report.rows,summary:report.summary},passed:true});
}finally{b.sqlite.close();}

return results;
}
export async function runBoundaryTrialB(){
const results=resultSet();
const edge=fresh();
try{
  await create(edge,'免租边界');await inbound(edge,'免租边界','2026-09-28','A3',10);
  const out1=await outbound(edge,'免租边界','2026-10-01',[['A3',5,0]]);assert.equal(out1.status,200);
  const out2=await outbound(edge,'免租边界','2026-10-02',[['A3',5,0]]);assert.equal(out2.status,200);
  const fees=edge.sqlite.prepare('SELECT outbound_at,storage_days,billable_days,quantity,fee_usd FROM storage_fee_settlements ORDER BY id').all();assert.deepEqual(fees.map(r=>[r.outbound_at.slice(0,10),r.storage_days,r.billable_days,r.quantity,r.fee_usd]),[['2026-10-01',3,0,5,0],['2026-10-02',4,1,5,.08]]);
  const fee=edge.sqlite.prepare('SELECT * FROM storage_fee_settlements ORDER BY id DESC').get();
  const updated=await edge.call('pricing/settlements','PATCH',{id:fee.id,version:fee.version,ratePerM3Day:.8,freeDays:3,outboundDate:'2026-10-03'});assert.equal(updated.status,200,JSON.stringify(updated.data));
  const revised=edge.sqlite.prepare('SELECT outbound_at,storage_days,billable_days,fee_usd FROM storage_fee_settlements WHERE id=?').get(fee.id);assert.equal(revised.fee_usd,.16);assert.equal(revised.billable_days,2);
  results.scenarios.push({name:'免租第3天/第4天与待结算改出库日期',inputs:{inbound:'2026-09-28',volume:.02,quantity:10,rate:.8,freeDays:3},expected:{firstFiveAt1001:0,nextFiveAt1002:.08,revisedFiveAt1003:.16},actual:{fees,revised},passed:true});
}finally{edge.sqlite.close();}
return results;
}
export async function runAtomicDateTrialB(){
const results=resultSet();
const h=fresh();
try{
  await create(h,'按件双批次');await inbound(h,'按件双批次','2026-09-25','A1',30);await inbound(h,'按件双批次','2026-09-29','A2',20);
  assert.equal((await outbound(h,'按件双批次','2026-10-03',[['A2',20,0],['A1',15,0]])).status,200);
  const badBefore=JSON.stringify(h.sqlite.prepare('SELECT * FROM stocks').all());const bad=await outbound(h,'按件双批次','2026-09-28',[['A1',1,0]]);assert.equal(bad.status,400);assert.equal(JSON.stringify(h.sqlite.prepare('SELECT * FROM stocks').all()),badBefore);
  results.scenarios.push({name:'剩余计价批次晚于出库日时原子拒绝',date:'2026-09-28',actual:bad,passed:true});
}finally{h.sqlite.close();}
return results;
}

export async function runHistoricalProjectionReviewB(){
  const h=fresh();
  try{
    await create(h,'历史复查B');
    await inbound(h,'历史复查B','2026-09-25','A1',30);
    await inbound(h,'历史复查B','2026-09-29','A2',20);
    assert.equal((await outbound(h,'历史复查B','2026-10-03',[['A2',20,0],['A1',15,0]])).status,200);
    const snapshot=()=>JSON.stringify({stocks:h.sqlite.prepare('SELECT * FROM stocks ORDER BY id').all(),fees:h.sqlite.prepare('SELECT * FROM storage_fee_settlements ORDER BY id').all(),flow:h.sqlite.prepare('SELECT * FROM goods_flow_state').all(),ops:h.sqlite.prepare('SELECT * FROM goods_operations ORDER BY id').all()});
    const before=snapshot();
    const query=async q=>{const r=await h.call(`pricing/report?${q}`);assert.equal(r.status,200,JSON.stringify(r.data));return r.data;};
    const early=await query('asOf=2026-09-24');assert.equal(early.rows.length,0);
    const inboundDay=await query('asOf=2026-09-25');assert.equal(inboundDay.rows.reduce((n,r)=>n+r.quantity,0),30);assert.equal(inboundDay.summary.totalFeeUsd,0);
    const history=await query('asOf=2026-10-02');assert.equal(history.rows.reduce((n,r)=>n+r.quantity,0),50);assert.equal(history.summary.totalFeeUsd,1.92);assert.ok(history.rows.every(r=>r.inventoryStatus==='in_stock'&&r.endDate==='2026-10-02'&&r.settlementId===null&&r.settlementStatus===null));
    const inStock=await query('asOf=2026-10-02&inventoryStatus=in_stock');assert.equal(inStock.rows.reduce((n,r)=>n+r.quantity,0),50);assert.equal(inStock.summary.openFeeUsd,1.92);
    const noOut=await query('asOf=2026-10-02&inventoryStatus=outbound');assert.equal(noOut.rows.length,0);
    const exactDate=await query('asOf=2026-10-03');assert.equal(exactDate.summary.pendingFeeUsd,2.48);assert.equal(exactDate.summary.openFeeUsd,.24);assert.equal(exactDate.summary.totalFeeUsd,2.72);assert.equal(exactDate.summary.outboundRows,2);
    const sep=await query('fromMonth=2026-09&toMonth=2026-09&asOf=2026-10-02');assert.equal(sep.summary.totalPeriodFeeUsd,1.44);
    const oct=await query('fromMonth=2026-10&toMonth=2026-10&asOf=2026-10-02');assert.equal(oct.summary.totalPeriodFeeUsd,.48);assert.equal(oct.summary.periodEndExclusive,'2026-10-02');
    const both=await query('fromMonth=2026-09&toMonth=2026-10&asOf=2026-10-02');assert.equal(both.summary.totalPeriodFeeUsd,1.92);
    const futureMonth=await query('fromMonth=2026-10&toMonth=2026-10&asOf=2026-09-24');assert.equal(futureMonth.summary.totalPeriodFeeUsd,0);
    assert.equal(snapshot(),before,'Read-only historical report must not change stock, original documents, dates or settlement amounts');
    const fee=h.sqlite.prepare('SELECT * FROM storage_fee_settlements ORDER BY id').get();
    const confirmed=await h.call('pricing/settlements','POST',{id:fee.id,version:fee.version,ratePerM3Day:.8,freeDays:3,outboundDate:'2026-10-03',feeUsd:12.34});assert.equal(confirmed.status,200,JSON.stringify(confirmed.data));
    const afterConfirm=snapshot();
    const confirmedHistory=await query('asOf=2026-10-02');assert.equal(confirmedHistory.summary.totalFeeUsd,1.92);
    assert.equal(snapshot(),afterConfirm,'Projection must not overwrite manually confirmed fee 12.34');
    assert.equal(h.sqlite.prepare('SELECT fee_usd FROM storage_fee_settlements WHERE id=?').get(fee.id).fee_usd,12.34);
    const cancelled=await h.call('pricing/settlements','DELETE',{id:fee.id,version:confirmed.data.item.version});assert.equal(cancelled.status,200,JSON.stringify(cancelled.data));
    const afterCancel=snapshot();
    const currentCancelled=await query('asOf=2026-10-06');assert.equal(currentCancelled.summary.totalFeeUsd,1.04);
    const pastCancelled=await query('asOf=2026-10-02');assert.equal(pastCancelled.summary.totalFeeUsd,0);assert.equal(pastCancelled.rows.reduce((n,r)=>n+r.quantity,0),20);
    assert.equal(snapshot(),afterCancel);
    const restored=await h.call('pricing/settlements','PUT',{id:fee.id,version:cancelled.data.item.version});assert.equal(restored.status,200,JSON.stringify(restored.data));
    const restoredHistory=await query('asOf=2026-10-02');assert.equal(restoredHistory.summary.totalFeeUsd,1.92);assert.equal(restoredHistory.rows.reduce((n,r)=>n+r.quantity,0),50);
    const currentRestored=await query('asOf=2026-10-06');assert.equal(currentRestored.summary.totalFeeUsd,13.38);
    return {passed:true,historyTotal:history.summary.totalFeeUsd,historyCount:50,octoberCutoff:oct.summary.totalPeriodFeeUsd,originalOverridePreserved:12.34,cancelledActiveCurrentTotal:currentCancelled.summary.totalFeeUsd,restoredCurrentTotal:currentRestored.summary.totalFeeUsd,scope:'Historical billing projection; cancelled pricing is excluded without restoring physical inventory'};
  }finally{h.sqlite.close();}
}
