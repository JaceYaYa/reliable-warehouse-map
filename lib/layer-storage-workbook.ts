import * as XLSX from 'xlsx';
import type {LayerStorageReport,LayerStorageReportRow} from './layer-storage-report-types';
import {layerDisplayFees} from './layer-fee-rounding';
import {buildLayerWorkbookDetail,type BillRow} from './layer-storage-workbook-detail';

const DAY=86400000;
const iso=(value:number)=>new Date(value).toISOString().slice(0,10);
const stamp=(value:string)=>Date.parse(value+'T00:00:00Z');
const finalDay=(exclusive:string)=>iso(stamp(exclusive)-DAY);
const nextMonth=(day:string)=>iso(Date.UTC(Number(day.slice(0,4)),Number(day.slice(5,7)),1));
const days=(start:string,end:string)=>Math.max(0,Math.round((stamp(end)-stamp(start))/DAY));
const money=(cents:number)=>cents/100;
type MonthTotal={stock:number;shipped:number};
const centsSum=(rows:BillRow[])=>rows.reduce((sum,row)=>sum+row.feeCents,0);

/** Divide existing allocated cents; presentation never creates or discards money. */
function allocateCents(total:number,weights:number[]){
 const sum=weights.reduce((a,b)=>a+b,0);
 if(!sum)return weights.map(()=>0);
 const raw=weights.map(weight=>total*weight/sum),allocated=raw.map(value=>Math.floor(value+1e-9));
 let remaining=total-allocated.reduce((a,b)=>a+b,0);
 const order=raw.map((value,index)=>({index,remainder:value-allocated[index]})).sort((a,b)=>b.remainder-a.remainder||a.index-b.index);
 for(const {index}of order)if(remaining>0){allocated[index]++;remaining--;}
 return allocated;
}

function monthlyRows(report:LayerStorageReport){
 const allocated=layerDisplayFees(report.rows);
 const financial=report.sections?[...report.sections.inStock.rows,...report.sections.shipped.rows]:report.rows.filter(row=>row.status==='verified'&&row.feeUsd!==null);
 const pieces:BillRow[]=[];
 for(const source of financial){
  const total=Math.round((allocated.get(source.key)??source.feeUsd??0)*100);
  let charge=source.chargeStartDate;
  if(!charge&&source.inboundDate&&source.freeDays!==null)charge=iso(stamp(source.inboundDate)+source.freeDays*DAY);
  if(!charge)charge=iso(stamp(source.endDateExclusive)-source.billableDays*DAY);
  const own:BillRow[]=[];
  for(let start=source.startDate;start<source.endDateExclusive;){
   const end=nextMonth(start)<source.endDateExclusive?nextMonth(start):source.endDateExclusive;
   const add=(from:string,to:string,billable:boolean)=>{if(from<to)own.push({...source,chargeStartDate:charge,month:from.slice(0,7),startDate:from,endDateExclusive:to,storageDays:days(from,to),billableDays:billable?days(from,to):0,feeCents:0,skus:[...(source.skus??[])],products:[...(source.products??[])],reviewReasons:[...source.reviewReasons],physicalLocations:[...(source.physicalLocations??[])]});};
   if(start<charge)add(start,charge<end?charge:end,false);
   if(end>charge)add(start>charge?start:charge,end,true);
   start=end;
  }
  if(total>0&&!own.some(row=>row.billableDays>0))throw Error('费用与计费日期不一致，请核对报告');
  const cents=allocateCents(total,own.map(row=>row.billableDays));
  own.forEach((row,index)=>pieces.push({...row,feeCents:cents[index]}));
 }
 const merged:BillRow[]=[],lastByFacts=new Map<string,BillRow>();
 for(const row of pieces.sort((a,b)=>a.startDate.localeCompare(b.startDate))){
  const facts=JSON.stringify([row.customerName,row.month,row.section??'in_stock',row.locationCode,row.layer,row.recordIds??[],row.products,row.skus,row.inboundDate,row.freeDays,row.palletCount,row.volumeM3,row.sharedVolumeM3,row.ratePerM3Day,row.calculationBasis,row.billableDays>0]);
  const last=lastByFacts.get(facts);
  if(last&&last.endDateExclusive===row.startDate){
   last.endDateExclusive=row.endDateExclusive;last.storageDays+=row.storageDays;last.billableDays+=row.billableDays;last.feeCents+=row.feeCents;
   last.physicalLocations=[...new Map([...(last.physicalLocations??[]),...(row.physicalLocations??[])].map(position=>[JSON.stringify(position),position])).values()];
  }else{merged.push(row);lastByFacts.set(facts,row);}
 }
 return merged;
}

/** Customer monthly invoice first, auditable charge intervals second. Plain black/white Excel defaults. */
export function buildLayerStorageWorkbook(report:LayerStorageReport){
 const workbook=XLSX.utils.book_new(),rows=monthlyRows(report);
 const unknown=report.sections?.uncalculable??report.rows.filter(row=>row.feeUsd===null);
 const customers=[...new Set([...rows.map(row=>row.customerName),...unknown.map(row=>row.customerName??'')])].sort((a,b)=>a.localeCompare(b,'zh-CN'));
 const from=report.period.fromDate??report.period.fromMonth+'-01';
 const to=report.period.toDate??finalDay(nextMonth(report.period.toMonth+'-01'));
 const period=from+' 至 '+to;
 const months:string[]=[];for(let month=from.slice(0,7);month<=to.slice(0,7);month=nextMonth(month+'-01').slice(0,7))months.push(month);
 const {summary:locations,detail,detailRanges}=buildLayerWorkbookDetail(rows,customers,period);
 const totals=new Map<string,MonthTotal>();
 const key=(customer:string,month:string)=>JSON.stringify([customer,month]);
 for(const customer of customers)for(const month of months){
  const own=rows.filter(row=>row.customerName===customer&&row.month===month);
  totals.set(key(customer,month),{stock:centsSum(own.filter(row=>row.section!=='shipped')),shipped:centsSum(own.filter(row=>row.section==='shipped'))});
 }
 const setFormula=(sheet:XLSX.WorkSheet,address:string,value:number,formula:string)=>{sheet[address]={t:'n',v:value,f:formula,z:'"$"#,##0.00'};};
 const billData:unknown[][]=[['仓储费对账单'],['账期',period],['出账日期',report.asOf??'见账期','币种','USD'],[]];
 const billMerges:Array<{s:{r:number;c:number};e:{r:number;c:number}}>=[{s:{r:0,c:0},e:{r:0,c:3}},{s:{r:1,c:1},e:{r:1,c:3}}];
 const formulas:Array<{row:number;column:string;value:number;formula:string}>=[];
 for(const customer of customers){
  const own=rows.filter(row=>row.customerName===customer),rates=[...new Set(own.map(row=>row.ratePerM3Day))],freeDays=[...new Set(own.map(row=>row.freeDays))];
  billData.push(['客户',customer||'待认领']);billMerges.push({s:{r:billData.length-1,c:1},e:{r:billData.length-1,c:3}});
  billData.push(['每日单价（$/m³/天）',rates.length===1?rates[0]??'待核对':'按明细','免租天数',freeDays.length===1?freeDays[0]??'待核对':'按各批次']);
  billData.push(['本期仓储费（USD）',null,null,money(centsSum(own))]);const headline=billData.length;
  billData.push(['月份','在库货物仓储费（USD）','已出库货物仓储费（USD）','本月合计（USD）']);
  const first=billData.length+1;
  for(const month of months){
   const total=totals.get(key(customer,month))!;billData.push([month,money(total.stock),money(total.shipped),money(total.stock+total.shipped)]);const row=billData.length;
   const range=detailRanges.get(customer);
   for(const [column,section,cents] of [['B','in_stock',total.stock],['C','shipped',total.shipped]] as const){
    const formula=range?`ROUND(SUMIFS('核对明细'!C${range.first}:C${range.last},'核对明细'!Q${range.first}:Q${range.last},A${row},'核对明细'!R${range.first}:R${range.last},"${section}"),2)`:'0';
    formulas.push({row,column,value:money(cents),formula});
   }
   formulas.push({row,column:'D',value:money(total.stock+total.shipped),formula:`SUM(B${row}:C${row})`});
  }
  const last=billData.length;billData.push(['账期合计',money(centsSum(own.filter(row=>row.section!=='shipped'))),money(centsSum(own.filter(row=>row.section==='shipped'))),money(centsSum(own))]);
  for(const [column,value]of [['B',billData.at(-1)![1]],['C',billData.at(-1)![2]],['D',billData.at(-1)![3]]]as const)formulas.push({row:billData.length,column,value:value as number,formula:`SUM(${column}${first}:${column}${last})`});
  formulas.push({row:headline,column:'D',value:money(centsSum(own)),formula:'D'+billData.length});
  const count=unknown.filter(row=>row.customerName===customer).length;
  if(count){billData.push([`另有 ${count} 项资料不全，金额未知，未计入本账单。请在网站“不能计算”板块补充。`]);billMerges.push({s:{r:billData.length-1,c:0},e:{r:billData.length-1,c:3}});}
  billData.push([]);
 }
 if(!customers.length)billData.push(['所选区间没有可计算的仓储费。']);
 billData.push(['已出库费用是货物出库前的仓储费，不是出库操作费。']);billMerges.push({s:{r:billData.length-1,c:0},e:{r:billData.length-1,c:3}});
 billData.push(['各批次分别计算免租。移库按所在层每托体积计算，待出库继续沿用原层计价。']);billMerges.push({s:{r:billData.length-1,c:0},e:{r:billData.length-1,c:3}});
 if(report.coverage.currentOccupancyPeriods?.length){billData.push(['历史缺失时段按当前记录托数估算，缺少托数按1托估算。']);billMerges.push({s:{r:billData.length-1,c:0},e:{r:billData.length-1,c:3}});}
 const bill=XLSX.utils.aoa_to_sheet(billData);bill['!merges']=billMerges;
 for(const formula of formulas)setFormula(bill,formula.column+formula.row,formula.value,formula.formula);
 for(let row=1;row<=billData.length;row++)if(/^\d{4}-\d{2}$/.test(String(billData[row-1][0])))for(const col of ['B','C'])bill[col+row].z='"$"#,##0.00';
 bill['!cols']=[{wch:26},{wch:29},{wch:29},{wch:25}];bill['!rows']=billData.map(()=>({hpt:25}));
 for(const sheet of [bill,locations,detail])sheet['!margins']={left:.25,right:.25,top:.4,bottom:.4,header:.2,footer:.2};
 XLSX.utils.book_append_sheet(workbook,bill,'客户账单');XLSX.utils.book_append_sheet(workbook,locations,'库位汇总');XLSX.utils.book_append_sheet(workbook,detail,'核对明细');
 return workbook;
}
