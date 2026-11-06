import type{LayerStorageReportRow,StorageReportSections,UncalculableStorageRecord}from'./layer-storage-report-types';
import type{OutboundHistoryRecord}from'./outbound-history';
import type{LayerOccupant}from'./layer-storage';
import{validFreePeriodDate}from'./storage-free-periods';
import{layerDisplayFees}from'./layer-fee-rounding';

/** The two financial sections share one cent allocation; omitted data is never a free shipment. */
export function storageReportSections(rows:LayerStorageReportRow[],shipments:readonly OutboundHistoryRecord[],current:readonly LayerOccupant[],period:{periodStart:string;periodEndExclusive:string}):StorageReportSections{
 const amounts=layerDisplayFees(rows),uncalculable=new Map<string,UncalculableStorageRecord>();
 const add=(r:UncalculableStorageRecord)=>{const old=uncalculable.get(r.key);uncalculable.set(r.key,old?{...old,reasons:[...new Set([...old.reasons,...r.reasons])],startDate:old.startDate<r.startDate?old.startDate:r.startDate,endDateExclusive:old.endDateExclusive>r.endDateExclusive?old.endDateExclusive:r.endDateExclusive}:r);};
 for(const c of current){const reasons:string[]=[];if(!validFreePeriodDate(c.inboundDate))reasons.push('缺少有效入库日期');if(!c.customerName.trim())reasons.push('缺少商家，请选择归属客户');if(reasons.length)add({key:'current:'+c.id,kind:'current',recordId:c.id,customerName:c.customerName,product:c.productName,sku:c.sku,locationCode:c.locationCode,layer:c.layer,inboundDate:c.inboundDate||null,outboundDate:null,reasons,startDate:period.periodStart,endDateExclusive:period.periodEndExclusive});}
 for(const r of shipments){
  if(r.key.startsWith('current-owner:')||validFreePeriodDate(r.inboundDate)&&r.inboundDate>=period.periodEndExclusive||validFreePeriodDate(r.outboundDate)&&r.outboundDate<=period.periodStart)continue;
  const reasons:string[]=[];if(r.billingDetailsConflict)reasons.push(r.billingDetailsConflict);if(!r.customerName.trim())reasons.push('缺少商家，请选择归属客户');if(!r.locationCode.trim())reasons.push('缺少计费库位');if(!r.layer||!Number.isSafeInteger(r.layer)||r.layer<1)reasons.push('缺少有效计费层数');if(!validFreePeriodDate(r.inboundDate))reasons.push('缺少有效入库日期');if(!validFreePeriodDate(r.outboundDate))reasons.push('缺少有效出库日期');if(r.inboundDate&&r.outboundDate&&r.inboundDate>r.outboundDate)reasons.push('出库日期早于入库日期');
  if(reasons.length)add({key:'outbound:'+r.key,kind:'outbound',historyKey:r.key,customerName:r.customerName,product:r.product,sku:r.sku,locationCode:r.locationCode,layer:r.layer,inboundDate:r.inboundDate,outboundDate:r.outboundDate,reasons,startDate:period.periodStart,endDateExclusive:period.periodEndExclusive});
 }
 for(const row of rows.filter(r=>r.feeUsd===null)){
  const record=current.find(c=>row.recordIds?.includes(c.id)&&c.customerName===row.customerName),shipment=shipments.find(r=>!r.key.startsWith('current-owner:')&&r.customerName===row.customerName&&(row.recordIds?.includes(r.physicalId??'')||row.recordIds?.includes('billing-outbound:'+r.key))&&r.inboundDate===row.inboundDate&&!!r.outboundDate&&r.outboundDate>=row.endDateExclusive);
  const kind=row.section==='in_stock'?'current':shipment?'outbound':'history';
  add({key:kind==='outbound'?'outbound:'+shipment!.key:kind+':'+(record?.id??JSON.stringify([row.customerName,row.locationCode,row.layer])),kind,...(record?{recordId:record.id}:{}),...(shipment?{historyKey:shipment.key}:{}),customerName:row.customerName,product:record?.productName??shipment?.product??row.products.join('、'),sku:record?.sku??shipment?.sku??row.skus.join('、'),locationCode:record?.locationCode??row.locationCode,layer:record?.layer??row.layer,inboundDate:record?.inboundDate??row.inboundDate,outboundDate:shipment?.outboundDate??null,reasons:[...row.reviewReasons],startDate:row.startDate,endDateExclusive:row.endDateExclusive});
 }
 const section=(name:'in_stock'|'shipped')=>{const own=rows.filter(r=>(r.section??'in_stock')===name&&r.feeUsd!==null);return{rows:own,feeUsd:Number(own.reduce((n,r)=>n+(amounts.get(r.key)??0),0).toFixed(2))};};
 return{inStock:section('in_stock'),shipped:section('shipped'),uncalculable:[...uncalculable.values()]};
}
