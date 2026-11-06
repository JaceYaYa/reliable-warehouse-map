import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import {warehouseApiHarness}from './helpers/warehouse-api-harness.mjs';
import {sheetRows,dateText,billRows,detailRows}from './helpers/billing-workbook.mjs';
const row=(key,start,end,extra={})=>({key,customerName:'甲',locationCode:'A1',layer:1,products:['产品甲'],skus:['SKU-A'],recordIds:['stock:'+key],inboundDate:'2026-01-01',chargeStartDate:'2026-01-01',freeDays:0,palletCount:1,volumeM3:2,sharedVolumeM3:2,ratePerM3Day:.5,startDate:start,endDateExclusive:end,storageDays:1,billableDays:1,feeUsd:1,status:'verified',section:'in_stock',reviewReasons:[],evidenceIds:[],calculationBasis:'history',...extra});
function build(rows){const h=warehouseApiHarness();try{return h.load('lib/layer-storage-workbook.ts').buildLayerStorageWorkbook({asOf:'2026-10-30',rows,period:{fromDate:'2026-09-01',toDate:'2026-09-30',fromMonth:'2026-09',toMonth:'2026-09'},coverage:{currentOccupancyPeriods:[]}});}finally{h.sqlite.close();}}
function facts(w){const rows=sheetRows(w,'库位汇总'),headers=rows.find(r=>r[0]==='库位'),data=rows.find(r=>r[0]==='A1');return Object.fromEntries(headers.map((key,i)=>[key,data[i]]));}
test('V138 short location bill includes typed arrival/charge dates and cubic metres without changing fees',()=>{
 const w=build([row('a','2026-09-01','2026-09-03',{storageDays:2,billableDays:2,feeUsd:2})]),f=facts(w);
 assert.equal(dateText(f['最早入库日期']),'2026-01-01');assert.equal(dateText(f['最早计费日期']),'2026-09-01');assert.equal(dateText(f['最晚计费日期']),'2026-09-02');assert.equal(f['占用体积（m³）'],2);assert.equal(f['合计（USD）'],2);
 const reopened=XLSX.read(XLSX.write(w,{type:'array',bookType:'xlsx'}),{type:'array'});assert.equal(dateText(facts(reopened)['最早计费日期']),'2026-09-01');assert.equal(billRows(w)[0].fee,2);assert.equal(detailRows(w)[0].fee,2);
});
test('V138 volume sums concurrent batches and layers, not repeated historical intervals',()=>{
 const a=row('a','2026-09-01','2026-09-03',{storageDays:2,billableDays:2,feeUsd:2}),b=row('b','2026-09-01','2026-09-03',{layer:2,storageDays:2,billableDays:2,feeUsd:2});
 assert.equal(facts(build([a,b]))['占用体积（m³）'],4);
 assert.equal(facts(build([a,{...a,key:'next',startDate:'2026-09-03',endDateExclusive:'2026-09-05'}]))['占用体积（m³）'],2);
});
test('V138 changing charge volume is a range, not an invented single volume',()=>{
 const w=build([row('a','2026-09-01','2026-09-02'),row('b','2026-09-02','2026-09-03',{palletCount:.5,sharedVolumeM3:1,feeUsd:.5})]);assert.equal(facts(w)['占用体积（m³）'],'1～2');assert.equal(facts(w)['合计（USD）'],1.5);
});
test('V138 free records have no charge dates but retain their occupied volume',()=>{
 const f=facts(build([row('free','2026-09-01','2026-09-03',{inboundDate:'2026-09-01',chargeStartDate:'2026-12-01',freeDays:90,storageDays:2,billableDays:0,feeUsd:0})]));assert.equal(dateText(f['最早入库日期']),'2026-09-01');assert.equal(f['最早计费日期'],'本期未计费');assert.equal(f['最晚计费日期'],'本期未计费');assert.equal(f['占用体积（m³）'],2);assert.equal(f['合计（USD）'],0);
});
