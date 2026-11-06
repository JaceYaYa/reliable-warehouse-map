import type {LayerOccupant} from './layer-storage';
import {warehouseTodayDate} from './warehouse-time.ts';
import {locationCodeKey} from './location-code.ts';
import {resolveLocationAlias,type LocationAliases} from './location-aliases.ts';

export type StagingLayerPricingOperation={id:string;kind?:string;fingerprint:string;beforeRows:string;afterRows:string;result:string;createdAt:string;restoredAt:string|null};
export type StagingLayerPricingOrigin={stockId:number;sourceStockId:number;locationCode:string;layer:number;targetLocationCode:string;targetLayer:number;target?:{locationCode:string;layer:number};stagedAt:string;operationId:string};
export type StagingLayerPricingHistoryOrigin=StagingLayerPricingOrigin&{endedAt:string|null};
export type StagingLayerPricing={origins:StagingLayerPricingOrigin[];unresolvedStockIds:number[];originHistory?:StagingLayerPricingHistoryOrigin[]};
type Row=Record<string,unknown>;
const bad=():never=>{throw Error('待出库原计费层证据不完整');};
const record=(raw:unknown):Row=>{if(!raw||typeof raw!=='object'||Array.isArray(raw))bad();return raw as Row;};
const integer=(raw:unknown,min=0):raw is number=>typeof raw==='number'&&Number.isSafeInteger(raw)&&raw>=min;
const code=(raw:unknown):raw is string=>typeof raw==='string'&&!!raw.trim()&&!/[\u0000-\u001f\u007f]/u.test(raw);
const layer=(raw:unknown):raw is number=>integer(raw,1)&&raw<=10000;
const stamp=(raw:unknown):raw is string=>typeof raw==='string'&&Number.isFinite(Date.parse(raw));
const sameCode=(a:unknown,b:unknown)=>code(a)&&code(b)&&locationCodeKey(a)===locationCodeKey(b);
function rows(raw:string){const value=JSON.parse(raw);if(!Array.isArray(value)||!value.length)bad();const mapped=new Map<number,Row>();for(const item of value){const row=record(item);if(!integer(row.id,1)||mapped.has(row.id)||!code(row.locationCode)||!layer(row.layerCount)||!integer(row.totalQuantity)||!integer(row.totalBoxes))bad();mapped.set(row.id as number,row);}return mapped;}
const identityFields=['product','sku','customerName','inboundDate','fnsku','barcode','inboundOrder','inventoryUnit','productPrefix','productCondition','inboundSource','billingMode','note'];
function proof(origins:StagingLayerPricingOrigin[],before:Map<number,Row>,after:Map<number,Row>,result:Row,operationId:string){
 if(!Array.isArray(result.tasks)||!result.tasks.length||!origins.length||origins.length>100)bad();
 const expected=new Map<number,Row>();for(const raw of result.tasks){const task=record(raw);if(!Array.isArray(task.stockIds)||!task.stockIds.length||!stamp(task.stagedAt))bad();for(const id of task.stockIds as unknown[]){if(!integer(id,1)||expected.has(id))bad();expected.set(id as number,task);}}
 if(origins.length!==expected.size)bad();
 const seen=new Set<number>(),allocated=new Map<number,{quantity:number;boxes:number}>();
 for(const origin of origins){
  const source=before.get(origin.sourceStockId),target=after.get(origin.stockId),task=expected.get(origin.stockId);
  if(!source||!target||!task||seen.has(origin.stockId)||before.has(origin.stockId)||origin.operationId!==operationId||origin.stagedAt!==task.stagedAt||!sameCode(origin.locationCode,source.locationCode)||origin.layer!==source.layerCount||!sameCode(origin.target?.locationCode??origin.targetLocationCode,target.locationCode)||(origin.target?.layer??origin.targetLayer)!==target.layerCount||!(Number(target.totalQuantity)>0||Number(target.totalBoxes)>0))bad();
  if(identityFields.some(key=>target[key]!==source[key]))bad();
  seen.add(origin.stockId);const count=allocated.get(origin.sourceStockId)??{quantity:0,boxes:0};count.quantity+=Number(target.totalQuantity);count.boxes+=Number(target.totalBoxes);allocated.set(origin.sourceStockId,count);
 }
 for(const [id,source]of before){const remaining=after.get(id),count=allocated.get(id);if(!remaining||!count||!sameCode(remaining.locationCode,source.locationCode)||remaining.layerCount!==source.layerCount||identityFields.some(key=>remaining[key]!==source[key])||remaining.totalQuantity!==Number(source.totalQuantity)-count.quantity||remaining.totalBoxes!==Number(source.totalBoxes)-count.boxes)bad();}
 if([...after.keys()].some(id=>!before.has(id)&&!seen.has(id)))bad();
 return origins;
}
/** Optional new metadata is strict; old saved staging operations remain supported independently. */
export function validateStagingLayerPricingOrigins(resultRaw:unknown,beforeRows:string,afterRows:string,operationId:string):StagingLayerPricingOrigin[]{
 const result=record(resultRaw);if(!Object.hasOwn(result,'layerPricingOrigins'))return [];
 if(!Array.isArray(result.layerPricingOrigins))bad();
 const origins=result.layerPricingOrigins.map(raw=>{
  const item=record(raw),allowed=['stockId','sourceStockId','locationCode','layer','targetLocationCode','targetLayer','target','stagedAt','operationId'];
  if(Object.keys(item).some(key=>!allowed.includes(key))||!integer(item.stockId,1)||!integer(item.sourceStockId,1)||!code(item.locationCode)||!layer(item.layer)||!code(item.targetLocationCode)||!layer(item.targetLayer)||!stamp(item.stagedAt)||typeof item.operationId!=='string'||!item.operationId)bad();
  if(item.target!==undefined){const target=record(item.target);if(Object.keys(target).length!==2||!code(target.locationCode)||!layer(target.layer)||target.layer!==item.targetLayer)bad();}
  // Nested locationCode follows existing backup/location-name migration; normalize the flat API view.
  return {...item,targetLocationCode:item.target?(item.target as Row).locationCode:item.targetLocationCode} as StagingLayerPricingOrigin;
 });
 return proof(origins,rows(beforeRows),rows(afterRows),result,operationId);
}
function recover(op:StagingLayerPricingOperation,result:Row){
 const before=rows(op.beforeRows),after=rows(op.afterRows),fingerprint=record(JSON.parse(op.fingerprint));
 if(!Array.isArray(fingerprint.lines)||!Array.isArray(result.tasks)||fingerprint.lines.length!==result.tasks.length)bad();
 const origins:StagingLayerPricingOrigin[]=[],lineIds=new Set<string>();
 for(const raw of fingerprint.lines){
  const line=record(raw);if(typeof line.lineId!=='string'||!line.lineId||lineIds.has(line.lineId)||!Array.isArray(line.selected)||!line.selected.length)bad();lineIds.add(line.lineId);
  const tasks=(result.tasks as unknown[]).map(record).filter(task=>task.lineId===line.lineId);if(tasks.length!==1)bad();const task=tasks[0];if(!Array.isArray(task.stockIds)||task.stockIds.length!==line.selected.length||!stamp(task.stagedAt))bad();
  const selectedIds=new Set<number>();let quantity=0,boxes=0;
  for(let index=0;index<line.selected.length;index++){
   const selected=record(line.selected[index]),source=before.get(selected.id as number),target=after.get(task.stockIds[index] as number);
   if(!integer(selected.id,1)||selectedIds.has(selected.id as number)||!source||!target||selected.quantity!==target.totalQuantity||selected.boxes!==target.totalBoxes||selected.version!==source.version)bad();
   selectedIds.add(selected.id as number);quantity+=Number(target.totalQuantity);boxes+=Number(target.totalBoxes);
   origins.push({stockId:target.id as number,sourceStockId:selected.id as number,locationCode:source.locationCode as string,layer:source.layerCount as number,targetLocationCode:target.locationCode as string,targetLayer:target.layerCount as number,target:{locationCode:target.locationCode as string,layer:target.layerCount as number},stagedAt:task.stagedAt as string,operationId:op.id});
  }
  if(line.quantity!==quantity||line.boxes!==boxes||task.quantity!==quantity||task.boxes!==boxes)bad();
 }
 return proof(origins,before,after,result,op.id);
}
/** Only exact source/target evidence grants a billing origin; product similarity is never a fallback. */
export function deriveStagingLayerPricing(operations:readonly StagingLayerPricingOperation[]):StagingLayerPricing{
 const origins=new Map<number,StagingLayerPricingOrigin>(),unresolved=new Set<number>();
 for(const op of operations){
  if(op.kind!==undefined&&op.kind!=='staging'||op.restoredAt!==null&&op.restoredAt!==undefined)continue;
  const known=new Set<number>();let result:Row|undefined;
  try{result=record(JSON.parse(op.result));if(Array.isArray(result.tasks))for(const raw of result.tasks){const task=record(raw);if(Array.isArray(task.stockIds))for(const id of task.stockIds)if(integer(id,1))known.add(id);}}catch{/* Other physical snapshots can still identify the affected target IDs. */}
  try{const before=rows(op.beforeRows),after=rows(op.afterRows);for(const id of after.keys())if(!before.has(id))known.add(id);}catch{/* Missing snapshots cannot prove an origin. */}
  try{
   if(!result||result.staging!==true||result.operationId!==op.id)bad();
   const resolved=Object.hasOwn(result,'layerPricingOrigins')?validateStagingLayerPricingOrigins(result,op.beforeRows,op.afterRows,op.id):recover(op,result);
   for(const origin of resolved){const previous=origins.get(origin.stockId);if(previous&&JSON.stringify(previous)!==JSON.stringify(origin))unresolved.add(origin.stockId);else origins.set(origin.stockId,origin);}
  }catch{for(const id of known)unresolved.add(id);}
 }
 return{origins:[...origins.values()].filter(origin=>!unresolved.has(origin.stockId)),unresolvedStockIds:[...unresolved].sort((a,b)=>a-b)};
}
export function projectStagingLayerOccupants(occupants:readonly LayerOccupant[],pricing:StagingLayerPricing,aliases:LocationAliases={},asOf?:string):LayerOccupant[]{
 const day=asOf&&/^\d{4}-\d{2}-\d{2}$/.test(asOf)?asOf:null;
 const effective=(stamp:string)=>day?warehouseTodayDate(new Date(stamp)):new Date(stamp).toISOString();
 const at=asOf?(day??new Date(asOf).toISOString()):undefined;
 const candidates=at&&pricing.originHistory?pricing.originHistory.filter(origin=>effective(origin.stagedAt)<=at&&(!origin.endedAt||effective(origin.endedAt)>at)):pricing.origins;
 const origins=new Map(candidates.map(origin=>[origin.stockId,origin])),unresolved=new Set(pricing.unresolvedStockIds);
 const canonical=(value:string)=>locationCodeKey(resolveLocationAlias(value,aliases));
 return occupants.map(occupant=>{
  const match=occupant.kind==='stock'?/^stock:([1-9]\d*)$/.exec(occupant.id):null,id=match?Number(match[1]):0,origin=origins.get(id);
  if(unresolved.has(id))return {...occupant,stagingPricingReview:'待出库原计费层证据不完整，请核对'};
  if(!origin||canonical(origin.target?.locationCode??origin.targetLocationCode)!==canonical(occupant.physicalLocationCode??occupant.locationCode)||(origin.target?.layer??origin.targetLayer)!==(occupant.physicalLayer??occupant.layer)){
   const legacyWaiting=occupant.kind==='stock'&&locationCodeKey(resolveLocationAlias(occupant.locationCode,aliases))===locationCodeKey(resolveLocationAlias('待出库',aliases));
   return legacyWaiting?{...occupant,stagingPricingReview:'待出库原计费层证据不完整，请核对'}:{...occupant};
  }
  return {...occupant,physicalLocationCode:occupant.physicalLocationCode??occupant.locationCode,physicalLayer:occupant.physicalLayer??occupant.layer,locationCode:locationCodeKey(resolveLocationAlias(origin.locationCode,aliases)),layer:origin.layer};
 });
}
