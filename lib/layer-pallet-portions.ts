import type {LayerOccupant} from './layer-storage';
import type {OutboundHistoryRecord} from './outbound-history';
import type {LayerHistoryLineage} from './layer-storage-history';
import type {StagingLayerPricing} from './staging-layer-pricing';
import {ownsHistoricalSource} from './outbound-history-corrections';

/** Partition a proven physical snapshot once, by source portions rather than layer/customer. */
export function partitionHistoricalPallets(occupants:readonly LayerOccupant[],shipments:readonly OutboundHistoryRecord[],current:readonly LayerOccupant[],start:string,end:string,pricing:StagingLayerPricing={origins:[],unresolvedStockIds:[]},lineage:readonly LayerHistoryLineage[]=[]):LayerOccupant[]{
 return occupants.flatMap(o=>{
  if(o.billingSection)return[o];
  const live=current.filter(c=>c.customerName===o.customerName&&c.inboundDate===o.inboundDate&&ownsHistoricalSource({physicalId:c.id} as OutboundHistoryRecord,o,start,pricing,lineage));
  const total=o.palletCount??live.find(c=>c.id===o.id)?.palletCount??1,estimated=o.estimatedPallets??o.palletCount===undefined;
  const assigned=shipments.filter(r=>!r.billingFactsManual&&!r.billingDetailsConflict&&!r.key.startsWith('current-owner:')&&r.customerName===o.customerName&&r.inboundDate===o.inboundDate&&!!r.outboundDate&&r.outboundDate>=end&&ownsHistoricalSource(r,o,start,pricing,lineage));
  let remaining=total;
  const portions=assigned.map(r=>{
   // Explicit zero is documentary evidence: do not infer pallets from pieces.
   const inferred=(o.physicalQuantity??0)>0?total*r.quantity/o.physicalQuantity!:(o.physicalBoxes??0)>0?total*r.boxes/o.physicalBoxes!:live.length?0:total;
   const count=Math.min(remaining,r.palletCount??inferred);remaining=Math.max(0,remaining-count);
   return {...o,id:'shipment:'+r.key,sourcePhysicalId:o.id,palletCount:count,estimatedPallets:estimated||r.palletCount===undefined,billingSection:'shipped' as const};
  });
  if(remaining>0||!portions.length)portions.push({...o,palletCount:remaining,estimatedPallets:estimated,billingSection:live.length?'in_stock':'shipped'} as typeof portions[number]);
  return portions;
 });
}

/** Freeze a legacy manual shipment estimate once, before per-day projection. */
export function stableManualPallets(records:readonly OutboundHistoryRecord[],intervals:readonly {startDate:string;endDateExclusive:string;occupants:LayerOccupant[]}[],current:readonly LayerOccupant[],fallback:Record<string,number>={},pricing:StagingLayerPricing={origins:[],unresolvedStockIds:[]},lineage:readonly LayerHistoryLineage[]=[]):OutboundHistoryRecord[]{
 return records.map(r=>{if(!r.billingFactsManual||r.palletCount!==undefined)return r;
 const out=r.originalOutboundDate??r.outboundDate,arrival=r.originalInboundDate??r.inboundDate;if(!out)return r;
 const matches=(o:LayerOccupant,day=out)=>ownsHistoricalSource(r,o,day,pricing,lineage)&&(!arrival||o.inboundDate===arrival);
 const candidates=intervals.filter(i=>i.startDate<out&&i.endDateExclusive>=out).flatMap(i=>i.occupants.filter(o=>matches(o,i.startDate)));const source=candidates.find(o=>o.id===r.physicalId)??candidates[0],live=current.find(o=>matches(o));
 const count=source?.palletCount??live?.palletCount??fallback[r.physicalId??'']??1;
 let ratio=1;if(source&&(source.physicalQuantity??0)>0)ratio=Math.min(1,r.quantity/source.physicalQuantity!);else if(source&&(source.physicalBoxes??0)>0)ratio=Math.min(1,r.boxes/source.physicalBoxes!);else if(live&&(live.physicalQuantity??0)+r.quantity>0)ratio=r.quantity/((live.physicalQuantity??0)+r.quantity);else if(live&&(live.physicalBoxes??0)+r.boxes>0)ratio=r.boxes/((live.physicalBoxes??0)+r.boxes);
 return {...r,palletCount:count*ratio,estimatedPallets:true};});
}
