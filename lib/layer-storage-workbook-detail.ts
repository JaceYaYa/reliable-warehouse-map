import * as XLSX from 'xlsx';
import type {LayerStorageReportRow}from './layer-storage-report-types';
export type BillRow=LayerStorageReportRow & {month:string;feeCents:number};
const DAY=86400000;
const stamp=(date:string)=>Date.parse(date+'T00:00:00Z');
const excelDate=(date:string)=>stamp(date)/DAY+25569;
const finalDay=(date:string)=>new Date(stamp(date)-DAY).toISOString().slice(0,10);
const sum=(rows:readonly BillRow[])=>rows.reduce((n,row)=>n+row.feeCents,0);

/** A presentation merge only: keep monthly cent allocations in the source report. */
function continuousRows(source:readonly BillRow[]){
 const rows:BillRow[]=[],previous=new Map<string,BillRow>();
 for(const original of [...source].sort((a,b)=>a.startDate.localeCompare(b.startDate))){
  const signature=JSON.stringify([original.customerName,original.month,original.locationCode,original.layer,original.recordIds??[],original.products,original.skus,original.inboundDate,original.freeDays,original.chargeStartDate,original.palletCount,original.volumeM3,original.sharedVolumeM3,original.ratePerM3Day,original.section??'in_stock',original.calculationBasis,original.estimatedPallets,original.reviewReasons,original.billableDays>0]);
  const last=previous.get(signature);
  if(last&&last.endDateExclusive===original.startDate){
   last.endDateExclusive=original.endDateExclusive;last.storageDays+=original.storageDays;last.billableDays+=original.billableDays;last.feeCents+=original.feeCents;
   last.physicalLocations=[...new Map([...(last.physicalLocations??[]),...(original.physicalLocations??[])].map(p=>[JSON.stringify(p),p])).values()];
  }else{const row={...original,physicalLocations:[...(original.physicalLocations??[])]};rows.push(row);previous.set(signature,row);}
 }
 return rows;
}
function stagingNote(row:BillRow){
 const positions=[...new Map((row.physicalLocations??[]).filter(p=>p.staged).map(p=>[JSON.stringify([p.locationCode,p.layer]),p])).values()];
 return positions.length?`实物位于${positions.map(p=>`${p.locationCode} 第${p.layer}层`).join('、')}；沿用原层计价至实际出库`:'';
}

/** Charge bounds and concurrent occupied volume, never a sum across historical days. */
function locationFacts(rows:readonly BillRow[]){
 const arrivals=rows.map(row=>row.inboundDate).filter((date):date is string=>!!date&&Number.isFinite(stamp(date))).sort();
 const charged=rows.filter(row=>row.billableDays>0&&row.startDate<row.endDateExclusive);
 const start=charged.map(row=>row.startDate).sort()[0],end=charged.map(row=>row.endDateExclusive).sort().at(-1);
 const events=new Map<string,number>();let invalidVolume=false;
 for(const row of rows){
  const volume=row.sharedVolumeM3??(row.palletCount===undefined?row.volumeM3:row.palletCount*row.volumeM3);
  if(!Number.isFinite(volume)||volume<0){invalidVolume=true;continue;}
  events.set(row.startDate,(events.get(row.startDate)??0)+volume);events.set(row.endDateExclusive,(events.get(row.endDateExclusive)??0)-volume);
 }
 const dates=[...events.keys()].sort(),volumes:number[]=[];let active=0;
 dates.forEach((date,index)=>{active=Number((active+events.get(date)!).toFixed(8));if(index<dates.length-1&&active>0)volumes.push(active);});
 const low=volumes.length?Math.min(...volumes):0,high=volumes.length?Math.max(...volumes):0;
 return [arrivals.length?excelDate(arrivals[0]):'待核对',start?excelDate(start):'本期未计费',end?excelDate(finalDay(end)):'本期未计费',invalidVolume?'待核对':low===high?low:`${Number(low.toFixed(4))}～${Number(high.toFixed(4))}`];
}

/** A short location statement and separate complete verification page. */
export function buildLayerWorkbookDetail(source:readonly BillRow[],customers:readonly string[],period:string){
 const rows=continuousRows(source);
 const summaryData:unknown[][]=[['库位费用汇总'],['账期',period],['日期为本期计费起止范围；体积变化时显示范围，各时段见核对明细。']];
 const detailData:unknown[][]=[['仓储费核对明细'],['账期',period],['托数 × 每托体积 × 每日单价 × 计费天数。不同到仓批次分别计算免租。计价依据变化时分行，分币调整用于对齐网站账单。'],[],['库位／层','产品／SKU','仓储费（USD）','时段开始','时段结束','托数','每托体积（m³/托）','计费天数','日单价（$/m³/天）','原入库日期','计费量（m³·天）','状态','备注','免租后起算日','计费体积修正（m³）','分币调整（USD）','归属月份','库存类别','库位']];
 const summaryMerges=[{s:{r:0,c:0},e:{r:0,c:8}},{s:{r:1,c:1},e:{r:1,c:8}},{s:{r:2,c:0},e:{r:2,c:8}}];
 const detailMerges=[{s:{r:0,c:0},e:{r:0,c:15}},{s:{r:1,c:1},e:{r:1,c:4}},{s:{r:2,c:0},e:{r:2,c:15}}];
 const summaryTotals:Array<{row:number;first:number;last:number}>=[],detailTotals:Array<{row:number;first:number;last:number}>=[],leafRows:number[]=[],locationRows:number[]=[];
 const detailRanges=new Map<string,{first:number;last:number}>();
 const locationFormulas:Array<{row:number;customer:string}>=[];
 for(const customer of customers){
  const own=rows.filter(row=>row.customerName===customer);if(!own.length)continue;
  summaryData.push(['客户',customer||'待认领']);summaryMerges.push({s:{r:summaryData.length-1,c:1},e:{r:summaryData.length-1,c:8}});
  summaryData.push(['库位','涉及层数','在库仓储费（USD）','已出库仓储费（USD）','合计（USD）','最早入库日期','最早计费日期','最晚计费日期','占用体积（m³）']);const summaryFirst=summaryData.length+1;
  const locations=[...new Set(own.map(row=>row.locationCode))].map(code=>({code,rows:own.filter(row=>row.locationCode===code)})).sort((a,b)=>sum(b.rows)-sum(a.rows)||a.code.localeCompare(b.code,'zh-CN',{numeric:true}));
  for(const location of locations){summaryData.push([location.code,new Set(location.rows.map(row=>row.layer)).size,sum(location.rows.filter(row=>row.section!=='shipped'))/100,sum(location.rows.filter(row=>row.section==='shipped'))/100,sum(location.rows)/100,...locationFacts(location.rows)]);locationRows.push(summaryData.length);locationFormulas.push({row:summaryData.length,customer});}
  const summaryLast=summaryData.length;summaryData.push(['客户合计',null,sum(own.filter(row=>row.section!=='shipped'))/100,sum(own.filter(row=>row.section==='shipped'))/100,sum(own)/100]);summaryTotals.push({row:summaryData.length,first:summaryFirst,last:summaryLast});summaryData.push([]);
  detailData.push([`客户：${customer||'待认领'}`]);detailMerges.push({s:{r:detailData.length-1,c:0},e:{r:detailData.length-1,c:2}});const detailFirst=detailData.length+1;
  for(const row of own.sort((a,b)=>a.locationCode.localeCompare(b.locationCode,'zh-CN',{numeric:true})||b.layer-a.layer||(a.inboundDate??'').localeCompare(b.inboundDate??'')||a.startDate.localeCompare(b.startDate))){
   const volume=row.sharedVolumeM3??(row.palletCount===undefined?row.volumeM3:row.palletCount*row.volumeM3);
   detailData.push([`${row.locationCode}／第${row.layer}层`,[...(row.products??[]),...(row.skus??[])].filter(Boolean).join(' / ')||'无',row.feeCents/100,excelDate(row.startDate),excelDate(finalDay(row.endDateExclusive)),row.palletCount??'待核对',row.volumeM3,row.billableDays,row.ratePerM3Day??'待核对',row.inboundDate?excelDate(row.inboundDate):'待核对',Number((volume*row.billableDays).toFixed(8)),(row.section==='shipped'?'已出库':'在库')+(row.billableDays===0?'（免租）':row.feeCents===0?'（本期0元）':''),[row.calculationBasis==='current-occupancy'?'历史托数按当前记录估算':row.calculationBasis==='history'?'按历史占层记录':'',row.estimatedPallets?'历史托数估算':'',stagingNote(row),...row.reviewReasons].filter(Boolean).join('；'),excelDate(row.chargeStartDate??(row.billableDays>0?row.startDate:row.endDateExclusive)),row.palletCount===undefined||Math.abs(volume-row.palletCount*row.volumeM3)>1e-10?volume:null,(row.feeCents-Math.round(Number((volume*row.billableDays).toFixed(8))*(row.ratePerM3Day??0)*100))/100,row.month,row.section==='shipped'?'shipped':'in_stock',row.locationCode]);leafRows.push(detailData.length);
  }
  const detailLast=detailData.length;detailRanges.set(customer,{first:detailFirst,last:detailLast});detailData.push(['客户合计',null,sum(own)/100]);detailTotals.push({row:detailData.length,first:detailFirst,last:detailLast});detailData.push([]);
 }
 if(!rows.length){summaryData.push(['所选区间没有可计算的库位费用。']);detailData.push(['所选区间没有可计算的仓储费明细。']);}
 const summary=XLSX.utils.aoa_to_sheet(summaryData),detail=XLSX.utils.aoa_to_sheet(detailData),currency='"$"#,##0.00';
 for(const row of locationRows){for(const col of ['C','D','E'])summary[col+row].z=currency;for(const col of ['F','G','H'])if(summary[col+row]?.t==='n')summary[col+row].z='yyyy-mm-dd';if(summary['I'+row]?.t==='n')summary['I'+row].z='0.00##';}
 for(const total of summaryTotals)for(const col of ['C','D','E'])summary[col+total.row]={t:'n',v:summary[col+total.row].v,f:`SUM(${col}${total.first}:${col}${total.last})`,z:currency};
 for(const total of detailTotals)detail['C'+total.row]={t:'n',v:detail['C'+total.row].v,f:`SUM(C${total.first}:C${total.last})`,z:currency};
 for(const row of leafRows){
  detail['H'+row].f=`MAX(0,E${row}-MAX(D${row},N${row})+1)`;
  detail['K'+row].f=`ROUND(IF(ISNUMBER(O${row}),O${row},F${row}*G${row})*H${row},8)`;
  detail['C'+row].f=`ROUND(ROUND(K${row}*I${row},2)+P${row},2)`;
  detail['N'+row].z='yyyy-mm-dd';
  detail['P'+row].z=currency;
  detail['C'+row].z=currency;for(const col of ['F','G','K'])if(detail[col+row]?.t==='n')detail[col+row].z='0.00##';if(detail['I'+row]?.t==='n')detail['I'+row].z='"$"0.00##';for(const col of ['D','E','J'])if(detail[col+row]?.t==='n')detail[col+row].z='yyyy-mm-dd';}
 summary['!merges']=summaryMerges;summary['!cols']=[{wch:15},{wch:11},{wch:23},{wch:25},{wch:20},{wch:15},{wch:15},{wch:15},{wch:20}];summary['!rows']=summaryData.map(()=>({hpt:23}));
 detail['!merges']=detailMerges;detail['!rows']=detailData.map((_,index)=>({hpt:index===4?32:23}));detail['!cols']=[{wch:20},{wch:42},{wch:20},{wch:14},{wch:14},{wch:10},{wch:19},{wch:12},{wch:21},{wch:14},{wch:20},{wch:19},{wch:48},{wch:17},{wch:23},{wch:20}];
 for(const {row,customer} of locationFormulas){
  const {first,last}=detailRanges.get(customer)!;
  for(const [col,section] of [['C','in_stock'],['D','shipped']]){
   summary[col+row].f=`ROUND(SUMIFS('核对明细'!C${first}:C${last},'核对明细'!R${first}:R${last},"${section}",'核对明细'!S${first}:S${last},"="&SUBSTITUTE(SUBSTITUTE(SUBSTITUTE(A${row},"~","~~"),"*","~*"),"?","~?")),2)`;
  }
  summary['E'+row].f=`SUM(C${row}:D${row})`;
 }
 detail['!cols'].push({wch:12},{wch:12},{wch:15});
 return {summary,detail,detailRanges};
}
