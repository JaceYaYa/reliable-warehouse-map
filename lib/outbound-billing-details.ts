import type {OutboundHistoryRecord} from './outbound-history';
import {validFreePeriodDate} from './storage-free-periods';
import type {LayerOccupant} from './layer-storage';
import type {LayerHistoryLineage} from './layer-storage-history';
import type {StagingLayerPricing} from './staging-layer-pricing';
import {ownsHistoricalSource} from './outbound-history-corrections';
import {LOCATION_ALIASES_KEY,parseLocationAliases,resolveLocationAlias,type LocationAliases} from './location-aliases';
import {locationCodeKey} from './location-code';

export const OUTBOUND_BILLING_DETAILS_PREFIX='outbound_history_billing_v1:';
export type OutboundBillingDetails={schemaVersion:1;key:string;sourceRevision:string;version:number;customerName:string;locationCode:string;layer:number;inboundDate:string;outboundDate:string};
type Setting={key:string;value:string};
function sameSourceBeforeRename(oldRevision:string,currentRevision:string,aliases:LocationAliases){
 try{const old=JSON.parse(oldRevision),current=JSON.parse(currentRevision);if(!old||!current||Array.isArray(old)||Array.isArray(current)||typeof old.locationCode!=='string'||typeof current.locationCode!=='string'||old.locationCode===current.locationCode)return false;
  if(locationCodeKey(resolveLocationAlias(old.locationCode,aliases))!==locationCodeKey(current.locationCode)||resolveLocationAlias(old.locationCode,aliases)===old.locationCode)return false;
  const oldFacts={...old},currentFacts={...current};delete oldFacts.locationCode;delete currentFacts.locationCode;return JSON.stringify(oldFacts)===JSON.stringify(currentFacts);
 }catch{return false;}
}
function valid(value:OutboundBillingDetails){return value.schemaVersion===1&&typeof value.key==='string'&&typeof value.sourceRevision==='string'&&!!value.sourceRevision&&Number.isSafeInteger(value.version)&&value.version>0&&typeof value.customerName==='string'&&!!value.customerName.trim()&&value.customerName.length<=200&&!/[\u0000-\u001f\u007f]/u.test(value.customerName)&&typeof value.locationCode==='string'&&!!value.locationCode.trim()&&Number.isSafeInteger(value.layer)&&value.layer>0&&value.layer<=10000&&validFreePeriodDate(value.inboundDate)&&validFreePeriodDate(value.outboundDate)&&value.inboundDate<=value.outboundDate;}
/** Financial projection only. The immutable documentary source revision is never rebased here. */
export function applyOutboundBillingDetails(records:OutboundHistoryRecord[],settingsRows:readonly Setting[],override?:OutboundBillingDetails):OutboundHistoryRecord[]{
 const aliases=parseLocationAliases(settingsRows.find(r=>r.key===LOCATION_ALIASES_KEY)?.value);
 return records.map(record=>{
  const setting=settingsRows.find(r=>r.key===OUTBOUND_BILLING_DETAILS_PREFIX+record.key);let details:OutboundBillingDetails|undefined,conflict=record.customerCorrectionConflict?(record.billingDetailsConflict||'原始出入库记录已有变化，请核对商家并重新保存计费资料'):'';
  if(override?.key===record.key)details=override;
  else if(setting){try{details=JSON.parse(setting.value) as OutboundBillingDetails;}catch{conflict='计费资料已损坏，请重新填写并预览保存';}}
  if(!details&&!setting)return record;
  if(!details||!valid(details)||details.key!==record.key)conflict='计费资料已损坏，请重新填写并预览保存';
  if(details&&!conflict&&(!record.sourceRevision||details.sourceRevision!==record.sourceRevision&&!sameSourceBeforeRename(details.sourceRevision,record.sourceRevision,aliases)))conflict='原始出入库记录已有变化，原计费修正未应用；请核对后重新填写并预览保存';
  const originals={originalInboundDate:record.originalInboundDate!==undefined?record.originalInboundDate:record.inboundDate,originalOutboundDate:record.originalOutboundDate!==undefined?record.originalOutboundDate:record.outboundDate,originalLocationCode:record.originalLocationCode??record.locationCode,originalLayer:record.originalLayer!==undefined?record.originalLayer:record.layer};
  const metadata={...originals,billingDetailsVersion:Number.isSafeInteger(details?.version)&&details!.version>0?details!.version:0,revision:JSON.stringify([record.revision??record.sourceRevision??null,details??setting?.value,conflict||null])};
  if(conflict)return {...record,...metadata,billingFactsManual:false,billingDetailsConflict:conflict,layer:null,inboundDate:null,outboundDate:null};
  return {...record,...metadata,locationCode:resolveLocationAlias(details!.locationCode,aliases),layer:details!.layer,inboundDate:details!.inboundDate,outboundDate:details!.outboundDate,billingFactsManual:true,billingDetailsConflict:undefined};
 });
}

/** Replace shipped portions only in the financial projection of verified history.
 * Current stock and unrelated/future outbound portions retain their physical basis. */
export function projectOutboundBillingFacts(occupants:readonly LayerOccupant[],records:readonly OutboundHistoryRecord[],current:readonly LayerOccupant[],start:string,end:string,pricing:StagingLayerPricing={origins:[],unresolvedStockIds:[]},lineage:readonly LayerHistoryLineage[]=[]):LayerOccupant[]{
 const managed=records.filter(r=>r.billingFactsManual||r.billingDetailsConflict);
 if(!managed.length)return [...occupants];
 const sourceArrival=(r:OutboundHistoryRecord)=>r.originalInboundDate!==undefined?r.originalInboundDate:r.inboundDate;
 const sourceOutbound=(r:OutboundHistoryRecord)=>r.originalOutboundDate!==undefined?r.originalOutboundDate:r.outboundDate;
 const matchesSource=(r:OutboundHistoryRecord,o:LayerOccupant)=>{const arrival=sourceArrival(r),outbound=sourceOutbound(r);return ownsHistoricalSource(r,o,start,pricing,lineage)&&(!arrival||arrival===o.inboundDate)&&(!arrival||arrival<=start)&&(!outbound||outbound>=end);};
 const portionPallets=(r:OutboundHistoryRecord,o:LayerOccupant)=>r.palletCount??(o.palletCount===undefined?undefined:(o.physicalQuantity??0)>0?o.palletCount*Math.min(1,r.quantity/o.physicalQuantity!):(o.physicalBoxes??0)>0?o.palletCount*Math.min(1,r.boxes/o.physicalBoxes!):undefined);
 const retained=occupants.flatMap(o=>{
  const assigned=managed.filter(r=>matchesSource(r,o)&&[r.customerName,r.billingOriginalCustomerName,r.originalCustomerName].includes(o.customerName));
  if(!assigned.length)return [o];
  const assignedPallets=assigned.reduce((n,r)=>n+(portionPallets(r,o)??0),0);
  const quantity=assigned.reduce((n,r)=>n+r.quantity,0),boxes=assigned.reduce((n,r)=>n+r.boxes,0),remainingQuantity=o.physicalQuantity===undefined?undefined:Math.max(0,o.physicalQuantity-quantity),remainingBoxes=o.physicalBoxes===undefined?undefined:Math.max(0,o.physicalBoxes-boxes);
  const currentRemainder=current.some(c=>c.customerName===o.customerName&&c.inboundDate===o.inboundDate&&ownsHistoricalSource({physicalId:c.id} as OutboundHistoryRecord,o,start,pricing,lineage));
  const otherShipment=records.some(r=>!managed.includes(r)&&r.customerName===o.customerName&&matchesSource(r,o));
  if(currentRemainder||otherShipment||(remainingQuantity??0)>0||(remainingBoxes??0)>0)return [{...o,...(o.palletCount!==undefined?{palletCount:Math.max(0,o.palletCount-assignedPallets)}:{}),...(remainingQuantity!==undefined?{physicalQuantity:remainingQuantity}:{}),...(remainingBoxes!==undefined?{physicalBoxes:remainingBoxes}:{})}];
  return [];
 });
 const corrected=managed.filter(r=>r.billingFactsManual&&!r.billingDetailsConflict&&r.customerName.trim()&&r.locationCode&&r.layer&&validFreePeriodDate(r.inboundDate)&&validFreePeriodDate(r.outboundDate)&&r.inboundDate<=start&&r.outboundDate>=end&&r.inboundDate<r.outboundDate).map(r=>({id:'billing-outbound:'+r.key,sourcePhysicalId:r.physicalId,kind:r.key.startsWith('carton:')?'carton':'stock',locationCode:r.locationCode,layer:r.layer!,customerName:r.customerName,inboundDate:r.inboundDate!,productName:r.product,sku:r.sku,physicalQuantity:r.quantity,physicalBoxes:r.boxes,palletCount:r.palletCount??(()=>{const o=occupants.find(o=>matchesSource(r,o));return o?portionPallets(r,o):undefined;})(),estimatedPallets:r.estimatedPallets,billingSection:'shipped'} satisfies LayerOccupant));
 return [...retained,...corrected];
}
