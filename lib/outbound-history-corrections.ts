import type {OutboundHistoryRecord} from './outbound-history';
import type {LayerOccupant} from './layer-storage';
import type {LayerHistoryIssue,LayerHistoryLineage} from './layer-storage-history';
import {validFreePeriodDate} from './storage-free-periods';
import type {StagingLayerPricing} from './staging-layer-pricing';
import {warehouseTodayDate} from './warehouse-time';

export const OUTBOUND_CUSTOMER_PREFIX='outbound_history_customer:';
export type OutboundCorrection={schemaVersion:1;key:string;customerName:string;version:number;sourceRevision:string};
type Setting={key:string;value:string};
export function outboundCorrections(rows:readonly Setting[]){
 return rows.filter(r=>r.key.startsWith(OUTBOUND_CUSTOMER_PREFIX)).map(r=>{
  const v=JSON.parse(r.value) as OutboundCorrection;
  if(v.schemaVersion!==1||r.key!==OUTBOUND_CUSTOMER_PREFIX+v.key||!v.customerName?.trim()||!Number.isSafeInteger(v.version)||v.version<1||typeof v.sourceRevision!=='string')throw Error('历史出货商家修正资料损坏');return v;
 });
}
export function applyOutboundCorrections(records:OutboundHistoryRecord[],rows:readonly Setting[],override?:OutboundCorrection){
 return records.map(record=>{
  const sourceRevision=JSON.stringify(record),setting=rows.find(r=>r.key===OUTBOUND_CUSTOMER_PREFIX+record.key);let c:OutboundCorrection|undefined,conflict='';
  try{c=override?.key===record.key?override:setting?outboundCorrections([setting])[0]:undefined;if(c&&c.sourceRevision!==sourceRevision){const before=JSON.parse(c.sourceRevision),after={...record};delete before.locationCode;delete (after as Partial<OutboundHistoryRecord>).locationCode;if(JSON.stringify(before)!==JSON.stringify(after))conflict='历史出货原记录已有变化，旧商家修正未应用；请重新填写计费资料';}}
  catch{conflict='历史商家修正资料损坏，旧修正未应用；请重新填写计费资料';}
  if(conflict)return {...record,originalCustomerName:record.customerName,sourceRevision,revision:JSON.stringify([sourceRevision,c??setting?.value,conflict]),correctionVersion:c?.version??0,customerCorrectionConflict:true,billingDetailsConflict:conflict,originalInboundDate:record.inboundDate,originalOutboundDate:record.outboundDate,originalLocationCode:record.locationCode,originalLayer:record.layer,inboundDate:null,outboundDate:null,layer:null};
  return {...record,originalCustomerName:record.customerName,customerName:c?.customerName??record.customerName,sourceRevision,revision:JSON.stringify([sourceRevision,c??null]),correctionVersion:c?.version??0};
 });
}
type Lineage={physicalId:string;until:string};
function ancestors(id:string,pricing:StagingLayerPricing,lineage:readonly LayerHistoryLineage[]=[]):Lineage[]{
 const chain:Lineage[]=[],seen=new Set([id]);let next=id,until='9999-12-31';
 for(let depth=0;depth<100;depth++){const origin=[...pricing.origins,...(pricing.originHistory??[])].find(o=>'stock:'+o.stockId===next),ordinary=lineage.find(e=>e.childId===next);if(!origin&&!ordinary)break;next=origin?'stock:'+origin.sourceStockId:ordinary!.parentId;if(seen.has(next))break;seen.add(next);until=[until,origin?warehouseTodayDate(new Date(origin.stagedAt)):ordinary!.day].sort()[0];chain.push({physicalId:next,until});}return chain;
}
export function ownsHistoricalSource(r:OutboundHistoryRecord,o:LayerOccupant,start:string,pricing:StagingLayerPricing,lineage:readonly LayerHistoryLineage[]=[]){return r.physicalId===o.id||!!r.physicalId&&ancestors(r.physicalId,pricing,lineage).some(a=>a.physicalId===o.id&&start<a.until);}
export function historicalLifetimeOccupants(records:readonly OutboundHistoryRecord[],start:string,end:string){
 return records.filter(r=>!r.key.startsWith('current-owner:')&&validFreePeriodDate(r.inboundDate)&&validFreePeriodDate(r.outboundDate)&&r.inboundDate<=start&&r.outboundDate>=end&&r.outboundDate>r.inboundDate&&r.layer&&r.locationCode).map(r=>({id:r.billingFactsManual?'billing-outbound:'+r.key:'shipment:'+r.key,sourcePhysicalId:r.physicalId,kind:r.key.startsWith('carton:')?'carton':'stock',locationCode:r.locationCode,layer:r.layer!,customerName:r.customerName,inboundDate:r.inboundDate!,productName:r.product,sku:r.sku,physicalQuantity:r.quantity,physicalBoxes:r.boxes,palletCount:r.palletCount,estimatedPallets:r.estimatedPallets,billingSection:r.key.startsWith('current-owner:')?'in_stock':'shipped'} as LayerOccupant));
}
/** Only missing-history periods use source lifetimes; verified locations stay authoritative. */
export function correctedVerifiedOccupants(occupants:readonly LayerOccupant[],records:readonly OutboundHistoryRecord[],current:readonly LayerOccupant[],start:string,end:string,pricing:StagingLayerPricing={origins:[],unresolvedStockIds:[]},lineage:readonly LayerHistoryLineage[]=[]){
 return occupants.flatMap(o=>{
  const matching=records.filter(r=>ownsHistoricalSource(r,o,start,pricing,lineage)&&r.inboundDate===o.inboundDate&&(r.billingOriginalCustomerName??r.originalCustomerName)===o.customerName&&r.inboundDate<=start&&!!r.outboundDate&&r.outboundDate>=end);
  if(!matching.some(r=>r.customerName!==(r.billingOriginalCustomerName??r.originalCustomerName)))return[o];
  const owners=new Set(matching.map(r=>r.customerName)),assignedPieces=matching.reduce((n,r)=>n+r.quantity,0),assignedBoxes=matching.reduce((n,r)=>n+r.boxes,0);
  if((o.physicalQuantity??0)>assignedPieces||(o.physicalBoxes??0)>assignedBoxes||current.some(c=>(c.id===o.id||ancestors(c.id,pricing,lineage).some(a=>a.physicalId===o.id))&&c.inboundDate===o.inboundDate&&c.customerName===o.customerName))owners.add(o.customerName);
  const total=o.palletCount??current.find(c=>c.id===o.id)?.palletCount??1;
  const moved=matching.filter(r=>r.customerName!==o.customerName),amount=(r:OutboundHistoryRecord)=>r.palletCount??((o.physicalQuantity??0)>0?total*r.quantity/o.physicalQuantity!:(o.physicalBoxes??0)>0?total*r.boxes/o.physicalBoxes!:total);
  let left=total;
  const portions=[...owners].filter(name=>name!==o.customerName).map(customerName=>{const owned=moved.filter(r=>r.customerName===customerName),palletCount=Math.min(left,owned.reduce((n,r)=>n+amount(r),0));left=Math.max(0,left-palletCount);return{...o,customerName,palletCount,physicalQuantity:owned.reduce((n,r)=>n+r.quantity,0),physicalBoxes:owned.reduce((n,r)=>n+r.boxes,0),estimatedPallets:o.estimatedPallets??o.palletCount===undefined};});
  if(owners.has(o.customerName))portions.push({...o,palletCount:left,estimatedPallets:o.estimatedPallets??o.palletCount===undefined,physicalQuantity:Math.max(0,(o.physicalQuantity??0)-moved.reduce((n,r)=>n+r.quantity,0)),physicalBoxes:Math.max(0,(o.physicalBoxes??0)-moved.reduce((n,r)=>n+r.boxes,0))});
  return portions;
 });
}
export function historicalLifetimeIssues(records:readonly OutboundHistoryRecord[],start:string,end:string):LayerHistoryIssue[]{
 return records.filter(r=>(!r.inboundDate||r.inboundDate<end)&&(!r.outboundDate||r.outboundDate>start)&&(!r.layer||!r.locationCode||!validFreePeriodDate(r.inboundDate)||!validFreePeriodDate(r.outboundDate)||r.outboundDate<r.inboundDate)).map(r=>({code:'outbound-history-incomplete',message:`历史出货「${r.product}」缺少有效库位层或入出库日期，未计入费用`,startDate:start,endDateExclusive:end,customerName:r.customerName,...(r.locationCode?{locationCode:r.locationCode}:{}),...(r.layer?{layer:r.layer}:{})}));
}
