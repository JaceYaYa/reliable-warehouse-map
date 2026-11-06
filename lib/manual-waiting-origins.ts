import {deriveStagingLayerPricing,type StagingLayerPricing,type StagingLayerPricingOperation} from './staging-layer-pricing';
import {extendWaitingPricing} from './legacy-waiting-origins';
import {resolveLocationAlias,type LocationAliases} from './location-aliases';
import {locationCodeKey} from './location-code';
import {warehouseDayBoundary} from './warehouse-time';
import {merchantAliases,resolveMerchantName} from './merchant-identity';
export const WAITING_MANUAL_ORIGIN_PREFIX='waiting_billing_origin_v1:';
export type ManualWaitingOrigin={schemaVersion:1;stockId:number;locationCode:string;layer:number;physicalLocationCode:string;physicalLayer:number;effectiveFrom:string;assignedAt:string;assignedBy:string;stockVersion:number;stockUpdatedAt:string;identity:string};
type Row=Record<string,unknown>;
export const waitingStockIdentity=(s:Row)=>JSON.stringify(['inboundDate','product','sku','fnsku','barcode','inboundOrder','customerName'].map(k=>s[k]??''));
export function readManualWaitingOrigins(settings:readonly {key:string;value:string}[]):ManualWaitingOrigin[]{return settings.filter(r=>r.key.startsWith(WAITING_MANUAL_ORIGIN_PREFIX)).flatMap(r=>{try{const p=JSON.parse(r.value);return p.schemaVersion===1&&Number.isSafeInteger(p.stockId)&&p.stockId>0&&r.key===WAITING_MANUAL_ORIGIN_PREFIX+p.stockId&&typeof p.locationCode==='string'&&p.locationCode.trim()&&Number.isSafeInteger(p.layer)&&p.layer>0&&typeof p.physicalLocationCode==='string'&&Number.isSafeInteger(p.physicalLayer)&&p.physicalLayer>0&&/^\d{4}-\d{2}-\d{2}$/.test(p.effectiveFrom)&&typeof p.identity==='string'&&Number.isFinite(Date.parse(p.assignedAt))?[p as ManualWaitingOrigin]:[];}catch{return[];}});}
/** Manual corrections are explicit billing choices, never reconstructed physical history. */
export function waitingPricingFromEvidence(operations:readonly StagingLayerPricingOperation[],audits:readonly Row[],settings:readonly {key:string;value:string}[],stocks:readonly Row[],aliases:LocationAliases={},outboundEvidence:readonly Row[]=[]):StagingLayerPricing{
 const owners=merchantAliases(settings);
 // Canonicalize proven global ownership aliases in transient snapshots only.
 // This keeps immutable audit documents intact while allowing a later move by
 // the merged owner to continue the exact same stock's waiting lineage.
 const normalizeSnapshot=(raw:unknown)=>{if(typeof raw!=='string'||!Object.keys(owners).length)return raw;try{const value=JSON.parse(raw);if(!value||typeof value!=='object'||Array.isArray(value))return raw;const remap=(row:Row)=>typeof row.customerName==='string'?{...row,customerName:resolveMerchantName(row.customerName,owners)}:row;if(value.kind==='stock-transfer'&&Array.isArray(value.rows))return JSON.stringify({...value,rows:value.rows.map((r:Row)=>remap(r))});if(Number.isSafeInteger(value.id))return JSON.stringify(remap(value));return raw;}catch{return raw;}};
 const normalized=audits.map(a=>({...a,...('beforeSnapshot' in a?{beforeSnapshot:normalizeSnapshot(a.beforeSnapshot)}:{before_snapshot:normalizeSnapshot(a.before_snapshot)}),...('afterSnapshot' in a?{afterSnapshot:normalizeSnapshot(a.afterSnapshot)}:{after_snapshot:normalizeSnapshot(a.after_snapshot)})}));
 const base=deriveStagingLayerPricing(operations),pricing=extendWaitingPricing(base,normalized,aliases),blocked=new Set(base.unresolvedStockIds),canonical=(c:string)=>locationCodeKey(resolveLocationAlias(c,aliases));
 const history=[...(pricing.originHistory??[])],origins=[...pricing.origins],resolved=new Set<number>();
 const compatible=(s:Row,identity:string)=>{try{const saved=JSON.parse(identity),current=JSON.parse(waitingStockIdentity(s));saved[6]=resolveMerchantName(saved[6],owners);current[6]=resolveMerchantName(current[6],owners);return JSON.stringify(saved)===JSON.stringify(current);}catch{return false;}};
 const parse=(v:unknown):unknown=>{try{return typeof v==='string'?JSON.parse(v):v;}catch{return undefined;}};
 const rows=(v:unknown):Row[]=>{const p=parse(v);if(Array.isArray(p))return p.filter(r=>r&&typeof r==='object');if(p&&typeof p==='object'){const r=p as Row;return Array.isArray(r.rows)?r.rows as Row[]:Number.isSafeInteger(r.id)?[r]:[];}return[];};
 for(const manual of readManualWaitingOrigins(settings)){
  if(blocked.has(manual.stockId))continue;
  // Documentary proof covering the assignment instant takes priority over the
  // manual choice. Later re-entry may create a new automatic window while the
  // earlier manual interval remains explicitly identifiable as manual.
  if(history.some(o=>o.stockId===manual.stockId&&o.stagedAt<=manual.assignedAt&&(!o.endedAt||o.endedAt> manual.assignedAt)))continue;
  const stock=stocks.find(s=>s.id===manual.stockId);
  let endedAt:string|null=null;
  for(const event of [...audits,...outboundEvidence]){
   if(event.restoredAt||event.restored_at)continue;
   const before=rows(event.beforeSnapshot??event.before_snapshot??event.beforeRows),after=rows(event.afterSnapshot??event.after_snapshot??event.afterRows),source=before.find(s=>s.id===manual.stockId);
   if(!source||!compatible(source,manual.identity)||canonical(String(source.locationCode))!==canonical(manual.physicalLocationCode))continue;
   const remaining=after.find(s=>s.id===manual.stockId),stamp=event.createdAt??event.created_at??remaining?.updatedAt;
   if(typeof stamp!=='string'||!Number.isFinite(Date.parse(stamp))||Date.parse(stamp)<Date.parse(manual.assignedAt))continue;
   const outbound=event.action==='出库'||event.kind==='outbound'||typeof event.beforeRows==='string';
   let end:string|null=null;
   if(outbound){
    if(!(Number(source.totalQuantity)>0||Number(source.totalBoxes)>0))continue;
    if(remaining&&(Number(remaining.totalQuantity)>0||Number(remaining.totalBoxes)>0))continue;
    const result=parse(event.result) as Row|undefined,date=result?.outboundDate??source.physicalOutboundDate;
    end=typeof date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(date)?warehouseDayBoundary(date)!:stamp;
   }else if(event.action==='移库'&&remaining&&canonical(String(remaining.locationCode))!==canonical(manual.physicalLocationCode))end=stamp;
   if(end&&(!endedAt||Date.parse(end)<Date.parse(endedAt)))endedAt=end;
  }
  const current=stock&&(Number(stock.totalQuantity)>0||Number(stock.totalBoxes)>0)&&compatible(stock,manual.identity)&&canonical(String(stock.locationCode))===canonical(manual.physicalLocationCode)&&canonical(String(stock.locationCode))===canonical('待出库');
  if(!endedAt&&!current)continue;
  const stagedAt=warehouseDayBoundary(manual.effectiveFrom)!;
  if(endedAt&&Date.parse(endedAt)<=Date.parse(stagedAt))continue;
  const origin={stockId:manual.stockId,sourceStockId:manual.stockId,locationCode:manual.locationCode,layer:manual.layer,targetLocationCode:manual.physicalLocationCode,targetLayer:current?Number(stock.layerCount):manual.physicalLayer,stagedAt,operationId:'manual-waiting-origin:'+manual.stockId,provenance:'manual' as const,manualAssignedAt:manual.assignedAt};
  history.push({...origin,endedAt});
  if(!endedAt&&!origins.some(o=>o.stockId===manual.stockId)){origins.push(origin);resolved.add(manual.stockId);}
 }
 return{origins,originHistory:history,unresolvedStockIds:pricing.unresolvedStockIds.filter(id=>!resolved.has(id))};
}
