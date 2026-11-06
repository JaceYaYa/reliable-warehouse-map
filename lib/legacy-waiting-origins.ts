import type {StagingLayerPricing,StagingLayerPricingOrigin,StagingLayerPricingHistoryOrigin} from './staging-layer-pricing.ts';
import {resolveLocationAlias,type LocationAliases} from './location-aliases.ts';
import {locationCodeKey} from './location-code.ts';

type Row=Record<string,unknown>;
/** Read every physical move, including onward moves needed to terminate a waiting binding.
 * The caller selects compact columns only; goods/undo category blobs are never selected. */
export const LEGACY_WAITING_MOVE_AUDIT_PREDICATE=`audit_logs.action='移库'
 AND audit_logs.before_snapshot IS NOT NULL AND audit_logs.after_snapshot IS NOT NULL
 AND (json_extract(CASE WHEN json_valid(audit_logs.before_snapshot) THEN audit_logs.before_snapshot ELSE '{}' END,'$.kind')='stock-transfer'
 OR json_type(CASE WHEN json_valid(audit_logs.before_snapshot) THEN audit_logs.before_snapshot ELSE '{}' END,'$.id')='integer')
 AND NOT EXISTS(SELECT 1 FROM audit_logs waiting_undo WHERE waiting_undo.action='恢复' AND waiting_undo.entity_id=CAST(audit_logs.id AS TEXT))`;
const object=(v:unknown):v is Row=>!!v&&typeof v==='object'&&!Array.isArray(v);
const positive=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0;
const count=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
const date=(v:unknown):v is string=>typeof v==='string'&&Number.isFinite(Date.parse(v));
const get=(r:Row,camel:string,snake:string)=>r[camel]??r[snake];
const parse=(raw:unknown):unknown=>typeof raw==='string'?JSON.parse(raw):raw;
const identity=['product','sku','customerName','inboundDate','fnsku','barcode','inboundOrder','inventoryUnit','inventoryReviewDecision','productPrefix','productCondition','inboundSource','billingMode','note','catalogItemId','itemVolumeM3','boxVolumeM3','storageRateUsd','freeDays'];
const sameIdentity=(a:Row,b:Row)=>identity.every(key=>a[key]===b[key]);
function stock(v:unknown):v is Row{return object(v)&&positive(v.id)&&typeof v.locationCode==='string'&&!!v.locationCode.trim()&&positive(v.layerCount)&&count(v.totalQuantity)&&count(v.totalBoxes)&&typeof v.product==='string'&&typeof v.customerName==='string'&&typeof v.inboundDate==='string'&&(v.palletCount===undefined||typeof v.palletCount==='number'&&Number.isFinite(v.palletCount)&&v.palletCount>=0);}
function snapshot(raw:unknown){const v=parse(raw);if(!object(v))throw Error('snapshot');if(v.kind==='stock-transfer'){if(v.snapshotVersion!==1||!['all','partial'].includes(String(v.mode))||typeof v.operationId!=='string'||!v.operationId||!Array.isArray(v.rows)||!v.rows.length||v.rows.length>2||!v.rows.every(stock))throw Error('envelope');return {rows:v.rows as Row[],envelope:v};}if(!stock(v))throw Error('stock');return{rows:[v],envelope:null};}
type Move={id:number;stamp:string;operationId:string;before:Row;after:Row[];valid:boolean};
/** Automatic recovery uses ID-preserving full moves and conservative split snapshots only.
 * Explicit unresolved staging metadata always wins over legacy recovery. No database writes. */
export function extendWaitingPricing(pricing:StagingLayerPricing,audits:readonly Row[],aliases:LocationAliases={}):StagingLayerPricing{
 const canonical=(v:unknown)=>typeof v==='string'?locationCodeKey(resolveLocationAlias(v,aliases)):'';
 const waiting=(v:unknown)=>canonical(v)===canonical('待出库');
 const matches=(o:StagingLayerPricingOrigin,r:Row)=>canonical(o.target?.locationCode??o.targetLocationCode)===canonical(r.locationCode)&&(o.target?.layer??o.targetLayer)===r.layerCount;
 const blocked=new Set(pricing.unresolvedStockIds),unresolved=new Set(pricing.unresolvedStockIds);
 const restored=new Set(audits.filter(a=>a.action==='恢复').map(a=>String(get(a,'entityId','entity_id'))));
 const moves:Move[]=[];
 for(const audit of audits){
  if(audit.action!=='移库'||restored.has(String(audit.id))||get(audit,'restoredAt','restored_at'))continue;
  const stamp=get(audit,'createdAt','created_at');if(!date(stamp)||!positive(Number(audit.id)))continue;
  let before:ReturnType<typeof snapshot>,after:ReturnType<typeof snapshot>;
  try{before=snapshot(get(audit,'beforeSnapshot','before_snapshot'));after=snapshot(get(audit,'afterSnapshot','after_snapshot'));}catch{continue;}
  if(before.rows.length!==1)continue;
  const source=before.rows[0],envelope=before.envelope,other=after.envelope;
  let valid=true;
  const declared=get(audit,'operationId','operation_id');
  if(Boolean(envelope)!==Boolean(other))valid=false;
  if(envelope&&other&&(envelope.operationId!==other.operationId||declared&&declared!==envelope.operationId||envelope.mode!==other.mode||canonical(envelope.sourceLocation)!==canonical(other.sourceLocation)||canonical(envelope.targetLocation)!==canonical(other.targetLocation)||canonical(envelope.sourceLocation)!==canonical(source.locationCode)))valid=false;
  const remaining=after.rows.find(r=>r.id===source.id),dest=after.rows.filter(r=>r.id!==source.id);
  if(after.rows.length===1){
   const target=after.rows[0];
   if(target.id!==source.id||!sameIdentity(source,target)||target.totalQuantity!==source.totalQuantity||target.totalBoxes!==source.totalBoxes||target.palletCount!==source.palletCount||envelope&&envelope.mode!=='all')valid=false;
  }else if(!envelope||envelope.mode!=='partial'||!remaining||dest.length!==1||!sameIdentity(source,remaining)||canonical(remaining.locationCode)!==canonical(source.locationCode)||!sameIdentity(source,dest[0])||Number(remaining.totalQuantity)+Number(dest[0].totalQuantity)!==source.totalQuantity||Number(remaining.totalBoxes)+Number(dest[0].totalBoxes)!==source.totalBoxes||!(Number(dest[0].totalQuantity)>0||Number(dest[0].totalBoxes)>0)||!(Number(remaining.totalQuantity)>0||Number(remaining.totalBoxes)>0)||(source.palletCount!==undefined&&(!Number.isFinite(remaining.palletCount)||!Number.isFinite(dest[0].palletCount)||Math.abs(Number(remaining.palletCount)+Number(dest[0].palletCount)-Number(source.palletCount))>1e-8)))valid=false;
  const target=after.rows.length===1?after.rows[0]:dest[0];
  if(envelope&&target&&canonical(envelope.targetLocation)!==canonical(target.locationCode))valid=false;
  moves.push({id:Number(audit.id),stamp,operationId:typeof declared==='string'&&declared?declared:`legacy-move:${audit.id}`,before:source,after:after.rows,valid});
 }
 const active=new Map<number,StagingLayerPricingHistoryOrigin>(),history:StagingLayerPricingHistoryOrigin[]=[],witnesses=new Map<number,Row>();
 const close=(id:number,stamp:string)=>{const old=active.get(id);if(old){old.endedAt=stamp;active.delete(id);}witnesses.delete(id);};
 const add=(origin:StagingLayerPricingOrigin,witness?:Row)=>{if(blocked.has(origin.stockId))return;close(origin.stockId,origin.stagedAt);const entry={...origin,...(origin.target?{target:{...origin.target}}:{}),endedAt:null};history.push(entry);active.set(origin.stockId,entry);if(witness)witnesses.set(origin.stockId,witness);unresolved.delete(origin.stockId);};
 const events=[...moves.map(move=>({stamp:move.stamp,order:move.id,move,origin:null as StagingLayerPricingOrigin|null})),...pricing.origins.map(origin=>({stamp:origin.stagedAt,order:Number.MAX_SAFE_INTEGER,move:null as Move|null,origin}))].sort((a,b)=>Date.parse(a.stamp)-Date.parse(b.stamp)||a.order-b.order);
 for(const event of events){
  if(event.origin){
   const origin=event.origin;
   if(blocked.has(origin.stockId))continue;
   if(waiting(origin.locationCode)){
    const parent=active.get(origin.sourceStockId);
    if(!parent||canonical(parent.target?.locationCode??parent.targetLocationCode)!==canonical(origin.locationCode)||(parent.target?.layer??parent.targetLayer)!==origin.layer){unresolved.add(origin.stockId);continue;}
    const witness=witnesses.get(origin.sourceStockId);
    add({...origin,locationCode:parent.locationCode,layer:parent.layer},witness?{...witness,id:origin.stockId,locationCode:origin.targetLocationCode,layerCount:origin.targetLayer}:undefined);
   }else add(origin);
   continue;
  }
  const move=event.move!;const source=move.before,parent=active.get(Number(source.id));
  const witness=witnesses.get(Number(source.id));
  const inherited=parent&&matches(parent,source)&&(!witness||sameIdentity(witness,source))?parent:undefined;
  if(!move.valid){for(const r of [source,...move.after]){close(Number(r.id),move.stamp);if(waiting(r.locationCode))unresolved.add(Number(r.id));}continue;}
  const sourceWaiting=waiting(source.locationCode),basis=sourceWaiting?inherited:undefined;
  // A snapshot at another location proves a prior binding is no longer active.
  close(Number(source.id),move.stamp);
  for(const target of move.after){
   const id=Number(target.id);
   if(!waiting(target.locationCode)){unresolved.delete(id);continue;}
   if(sourceWaiting&&!basis){close(id,move.stamp);unresolved.add(id);continue;}
   if(target.id===source.id&&move.after.length===2&&!sourceWaiting)continue;
   add({stockId:id,sourceStockId:Number(source.id),locationCode:basis?.locationCode??String(source.locationCode),layer:basis?.layer??Number(source.layerCount),targetLocationCode:String(target.locationCode),targetLayer:Number(target.layerCount),target:{locationCode:String(target.locationCode),layer:Number(target.layerCount)},stagedAt:move.stamp,operationId:move.operationId},target);
  }
 }
 return {origins:[...active.values()].map(({endedAt:_,...origin})=>origin).filter(o=>!unresolved.has(o.stockId)),unresolvedStockIds:[...unresolved].sort((a,b)=>a-b),originHistory:history};
}
