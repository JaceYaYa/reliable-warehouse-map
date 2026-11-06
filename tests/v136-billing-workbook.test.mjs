import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import {warehouseApiHarness} from './helpers/warehouse-api-harness.mjs';
import {billRows,detailRows,dateText,sheetRows} from './helpers/billing-workbook.mjs';
const row=(key,start,end,extra={})=>({key,customerName:'甲',locationCode:'A1',layer:1,products:['产品甲'],skus:['SKU-A'],recordIds:['stock:'+key],inboundDate:'2026-01-01',chargeStartDate:'2026-01-01',freeDays:0,palletCount:.5,volumeM3:2,sharedVolumeM3:1,ratePerM3Day:.5,startDate:start,endDateExclusive:end,storageDays:1,billableDays:1,feeUsd:.5,status:'verified',section:'in_stock',reviewReasons:[],evidenceIds:[],calculationBasis:'history',...extra});
const report=rows=>({basis:'layer',asOf:'2026-10-30',rows,period:{fromDate:'2026-08-01',toDate:'2026-10-29',fromMonth:'2026-08',toMonth:'2026-10',periodStart:'2026-08-01',periodEndExclusive:'2026-10-30'},coverage:{currentOccupancyPeriods:[]},sections:{inStock:{rows:rows.filter(r=>r.section==='in_stock'&&r.feeUsd!==null)},shipped:{rows:rows.filter(r=>r.section==='shipped'&&r.feeUsd!==null)},uncalculable:[]}});
function build(source){const h=warehouseApiHarness();try{return h.load('lib/layer-storage-workbook.ts').buildLayerStorageWorkbook(source);}finally{h.sqlite.close();}}
test('black-and-white export opens with customer monthly bill first and complete expandable detail',()=>{
 const source=report([row('a','2026-08-01','2026-08-03',{storageDays:2,billableDays:2,feeUsd:1})]),before=JSON.stringify(source),w=build(source);
 assert.deepEqual(Array.from(w.SheetNames),['客户账单','库位汇总','核对明细']);assert.equal(JSON.stringify(source),before);
 assert.equal(billRows(w).find(r=>r.month==='2026-08').fee,1);assert.equal(detailRows(w).length,1);
 assert.ok(!w.Sheets['客户账单']['!rows']?.some(r=>r?.hidden));assert.ok(!w.Sheets['核对明细']['!rows']?.some(r=>r?.hidden));
 const reopened=XLSX.read(XLSX.write(w,{type:'array',bookType:'xlsx'}),{type:'array'});
 assert.equal(detailRows(reopened)[0].fee,1);assert.equal(billRows(reopened).find(r=>r.month==='2026-08').fee,1);
 assert.equal(dateText(detailRows(reopened)[0].arrival),'2026-01-01');
 assert.ok(sheetRows(w,'客户账单').flat().includes('2026-08-01 至 2026-10-29'));
});
test('V136 cross-month free clocks split into real monthly charges with exact page cents',()=>{
 const w=build(report([row('a','2026-08-30','2026-09-03',{inboundDate:'2026-08-01',freeDays:30,chargeStartDate:'2026-08-31',storageDays:4,billableDays:3,feeUsd:1.5}),row('out','2026-09-01','2026-09-03',{section:'shipped',storageDays:2,billableDays:2,feeUsd:1})]));
 assert.deepEqual(billRows(w).map(r=>[r.month,r.stock,r.shipped,r.fee]),[['2026-08',.5,0,.5],['2026-09',1,1,2],['2026-10',0,0,0]]);
 const paid=detailRows(w).filter(r=>r.fee>0);assert.deepEqual(paid.map(r=>dateText(r.start)).sort(),['2026-08-31','2026-09-01','2026-09-01']);assert.equal(paid.reduce((n,r)=>n+r.fee,0),2.5);
 assert.ok(detailRows(w).some(r=>r.status.includes('免租')&&r.fee===0));
});
test('V136 preserves allocated cents across month split and isolates wildcard merchant names',()=>{
 const w=build(report([row('tiny','2026-08-31','2026-09-02',{customerName:'A*',storageDays:2,billableDays:2,feeUsd:.01,displayFeeUsd:.01}),row('other','2026-08-31','2026-09-01',{customerName:'ABC',feeUsd:1,displayFeeUsd:1})]));
 assert.equal(billRows(w).filter(r=>r.customer==='A*').reduce((n,r)=>n+r.fee,0),.01);assert.equal(billRows(w).filter(r=>r.customer==='ABC').reduce((n,r)=>n+r.fee,0),1);
 assert.equal(detailRows(w).filter(r=>r.customer==='A*').reduce((n,r)=>n+r.fee,0),.01);
});
test('V136 merges unchanged same-batch segments but keeps moves and separate free clocks identifiable',()=>{
 const a=row('a','2026-09-01','2026-09-03',{recordIds:['stock:1'],storageDays:2,billableDays:2,feeUsd:1}),b={...a,key:'b',startDate:'2026-09-03',endDateExclusive:'2026-09-05'},move={...a,key:'move',startDate:'2026-09-05',endDateExclusive:'2026-09-07',locationCode:'D1',volumeM3:1,feeUsd:.5,physicalLocations:[{locationCode:'待出库',layer:1,staged:true}]};
 const w=build(report([a,b,move])),d=detailRows(w).filter(r=>r.fee>0);assert.equal(d.length,2);assert.equal(d.find(r=>r.location==='A1／第1层').days,4);assert.match(d.find(r=>r.location==='D1／第1层').notes,/沿用原层计价/);
});
test('V136 unknown fees are disclosed without exporting them as zero or inventing a rate',()=>{
 const source=report([row('free','2026-09-01','2026-09-02',{chargeStartDate:'2026-12-01',billableDays:0,feeUsd:0}),row('unknown','2026-09-01','2026-09-02',{status:'review',feeUsd:null})]);source.sections.uncalculable=[{customerName:'甲',key:'unknown'}];const w=build(source);
 assert.ok(sheetRows(w,'客户账单').flat().some(v=>/1.*金额未知/.test(String(v))));assert.ok(!detailRows(w).some(r=>String(r.product).includes('unknown')));assert.equal(detailRows(w).length,1);
});
