import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import {warehouseApiHarness}from './helpers/warehouse-api-harness.mjs';
import {billRows,detailRows,dateText,sheetRows}from './helpers/billing-workbook.mjs';
const row=(key,start,end,extra={})=>({key,customerName:'甲',locationCode:'A1',layer:1,products:['产品甲'],skus:['SKU-A'],recordIds:['stock:'+key],inboundDate:'2026-01-01',chargeStartDate:'2026-01-01',freeDays:0,palletCount:1,volumeM3:2,sharedVolumeM3:2,ratePerM3Day:.5,startDate:start,endDateExclusive:end,storageDays:1,billableDays:1,feeUsd:1,status:'verified',section:'in_stock',reviewReasons:[],evidenceIds:[],calculationBasis:'history',...extra});
const report=rows=>({basis:'layer',asOf:'2026-10-30',rows,period:{fromDate:'2026-08-01',toDate:'2026-10-29',fromMonth:'2026-08',toMonth:'2026-10',periodStart:'2026-08-01',periodEndExclusive:'2026-10-30'},coverage:{currentOccupancyPeriods:[]},sections:{inStock:{rows:rows.filter(r=>r.section==='in_stock')},shipped:{rows:rows.filter(r=>r.section==='shipped')},uncalculable:[]}});
function build(source){const h=warehouseApiHarness();try{return h.load('lib/layer-storage-workbook.ts').buildLayerStorageWorkbook(source);}finally{h.sqlite.close();}}
test('V137 exports three plain visible sheets with one location summary row per merchant',()=>{
 const w=build(report([row('one','2026-09-01','2026-09-02'),row('two','2026-09-01','2026-09-02',{layer:2}),row('zero','2026-09-01','2026-09-02',{locationCode:'A2',feeUsd:0})]));
 assert.deepEqual(Array.from(w.SheetNames),['客户账单','库位汇总','核对明细']);const locations=sheetRows(w,'库位汇总').filter(r=>typeof r[1]==='number');assert.equal(locations.length,2);assert.deepEqual(locations[0].slice(0,5),['A1',2,2,0,2]);assert.equal(locations[1][4],0);
 for(const sheet of Object.values(w.Sheets)){assert.ok(!sheet['!rows']?.some(r=>r.hidden||r.level));assert.equal(sheet['!outline'],undefined);}
 const bytes=XLSX.write(w,{type:'array',bookType:'xlsx'}),reopened=XLSX.read(bytes,{type:'array',cellStyles:true});assert.equal(detailRows(reopened).length,3);assert.equal(dateText(detailRows(reopened)[0].arrival),'2026-01-01');
});
test('V137 splits cross-month batch for linked monthly totals while monthly bill and location fees stay exact',()=>{
 const w=build(report([row('a','2026-08-30','2026-09-03',{storageDays:4,billableDays:4,feeUsd:4})])),d=detailRows(w);
 assert.deepEqual(d.map(r=>[dateText(r.start),dateText(r.end),r.days,r.fee]),[['2026-08-30','2026-08-31',2,2],['2026-09-01','2026-09-02',2,2]]);
 const reopened=XLSX.read(XLSX.write(w,{type:'array',bookType:'xlsx'}),{type:'array'});
 assert.match(reopened.Sheets['客户账单'].B9.f,/SUMIFS.*核对明细/);
 assert.match(reopened.Sheets['库位汇总'].C6.f,/SUMIFS.*核对明细/);
 assert.match(reopened.Sheets['核对明细'].C7.f,/ROUND/);
 assert.deepEqual(billRows(w).map(r=>[r.month,r.fee]),[['2026-08',2],['2026-09',2],['2026-10',0]]);assert.equal(sheetRows(w,'库位汇总').find(r=>r[0]==='A1')[4],4);
});
test('V137 verification preserves independent arrivals, gaps and pallet/volume/rate/status changes',()=>{
 const a=row('a','2026-08-31','2026-09-01',{recordIds:['stock:1']});
 for(const change of [{recordIds:['stock:2']},{inboundDate:'2026-02-01'},{palletCount:.5},{volumeM3:1},{ratePerM3Day:.7},{section:'shipped'},{startDate:'2026-09-02',endDateExclusive:'2026-09-03'}]){
  const b={...a,key:'b',startDate:'2026-09-01',endDateExclusive:'2026-09-02',...change},w=build(report([a,b]));assert.equal(detailRows(w).length,2,JSON.stringify(change));assert.equal(billRows(w).reduce((n,r)=>n+r.fee,0),2);const location=sheetRows(w,'库位汇总').find(r=>r[0]==='A1');assert.equal(location[4],2);assert.equal(location[2]+location[3],2);
 }
});
test('V137 free records remain verifiable without inflating the short location bill',()=>{
 const w=build(report([row('a','2026-08-30','2026-09-03',{inboundDate:'2026-08-01',chargeStartDate:'2026-08-31',freeDays:30,storageDays:4,billableDays:3,feeUsd:3})])),d=detailRows(w);
 assert.equal(d.length,3);assert.equal(d.find(r=>r.days===0).fee,0);assert.equal(d.reduce((n,r)=>n+r.days,0),3);assert.equal(billRows(w).reduce((n,r)=>n+r.fee,0),3);const rows=sheetRows(w,'库位汇总');assert.equal(rows.filter(r=>r[0]==='A1').length,1);assert.equal(rows.find(r=>r[0]==='A1')[4],3);
});
