import type {OutboundHistoryRecord} from './outbound-history';
import type {LayerOccupant} from './layer-storage';
import type {LayerHistoryLineage} from './layer-storage-history';
export const MERCHANT_ALIASES_KEY='merchant_aliases_v1';
export const MERCHANT_PHYSICAL_KEY='merchant_physical_owners_v1';
export type MerchantAliases=Record<string,string>;
export type MerchantPhysicalOwner={inboundDate:string;originalCustomerName:string;customerName:string};
export type MerchantPhysicalOwners=Record<string,MerchantPhysicalOwner>;
type Setting={key:string;value:string};
export function merchantAliases(rows:readonly Setting[]):MerchantAliases{
 const raw=rows.find(r=>r.key===MERCHANT_ALIASES_KEY)?.value;if(!raw)return{};const parsed=JSON.parse(raw);if(parsed.schemaVersion!==1||!parsed.aliases||typeof parsed.aliases!=='object'||Array.isArray(parsed.aliases))throw Error('商家合并资料无效');
 const aliases=Object.fromEntries(Object.entries(parsed.aliases).map(([from,to])=>{if(!from.trim()||typeof to!=='string'||!to.trim())throw Error('商家合并资料无效');return[from,to];}));for(const key of Object.keys(aliases))resolveMerchantName(key,aliases);return aliases;
}
export function resolveMerchantName(name:string,aliases:MerchantAliases){let next=name.trim();const seen=new Set<string>();for(let n=0;Object.hasOwn(aliases,next);n++){if(n>1000||seen.has(next))throw Error('商家合并存在循环');seen.add(next);next=aliases[next].trim();}return next;}
export function mergedMerchantAliases(current:MerchantAliases,sources:readonly string[],target:string){const to=resolveMerchantName(target,current),next={...current};for(const source of sources){const from=resolveMerchantName(source,current);if(from&&from!==to)Object.defineProperty(next,from,{value:to,enumerable:true,writable:true,configurable:true});}for(const key of Object.keys(next))next[key]=resolveMerchantName(next[key],next);return next;}
export function merchantPhysicalOwners(rows:readonly Setting[]):MerchantPhysicalOwners{const raw=rows.find(r=>r.key===MERCHANT_PHYSICAL_KEY)?.value;if(!raw)return{};const p=JSON.parse(raw);if(p.schemaVersion!==1||!p.records||typeof p.records!=='object'||Array.isArray(p.records))throw Error('货物商家更换资料无效');return p.records;}
/** Financial identity changes do not move a physical cohort. Keep its documentary
 * owner stable while the separate quantity claims choose the bill's owner. */
export function merchantHistoryCustomerNames(owners:MerchantPhysicalOwners,aliases:MerchantAliases,goods:readonly Record<string,unknown>[],cartons:readonly Record<string,unknown>[]){
 const names=new Map<string,Set<string>>(),edges=new Map<string,Array<[string,string]>>(),key=(id:string,date:string)=>JSON.stringify([id,date]),canonical=(name:string)=>resolveMerchantName(name,aliases);
 for(const[id,owner]of Object.entries(owners)){
  if(!owner||typeof owner.inboundDate!=='string'||typeof owner.originalCustomerName!=='string'||typeof owner.customerName!=='string')throw Error('货物商家更换资料无效');
  names.set(key(id,owner.inboundDate),new Set([canonical(owner.originalCustomerName),canonical(owner.customerName)]));
 }
 const parse=(value:unknown)=>typeof value==='string'?JSON.parse(value):value;
 const add=(id:string,b:Record<string,unknown>,a:Record<string,unknown>)=>{
  if(typeof b.customerName!=='string'||typeof a.customerName!=='string'||typeof b.inboundDate!=='string'||b.inboundDate!==a.inboundDate)return;
  if(['locationCode','layerCount','product','sku','totalQuantity','totalBoxes'].some(field=>b[field]!==a[field]))return;
  const k=key(id,b.inboundDate);if(!names.has(k))return;const list=edges.get(k)??[];list.push([canonical(b.customerName),canonical(a.customerName)]);edges.set(k,list);
 };
 for(const op of [...goods,...cartons]){
  try{
   const fingerprint=parse(op.fingerprint),result=parse(op.result);
   if(!fingerprint||typeof fingerprint.merchantChangeId!=='string'||!fingerprint.merchantChangeId||result?.merchantChangeId!==fingerprint.merchantChangeId)continue;
   if(op.kind==='identity'){
    const before=parse(op.beforeRows),after=parse(op.afterRows);if(!Array.isArray(before)||!Array.isArray(after))continue;
    for(const b of before){const a=after.find(a=>a?.id===b?.id);if(b&&a)add('stock:'+b.id,b,a);}
   }else if(op.kind==='details'){
    const before=parse(op.beforeSnapshot),after=parse(op.afterSnapshot);if(!before||!after||before.id!==after.id)continue;
    const bs=parse(before.placements),as=parse(after.placements);if(!Array.isArray(bs)||!Array.isArray(as))continue;
    const detail=(receipt:Record<string,unknown>,p:Record<string,any>)=>({locationCode:p.locationCode,layerCount:p.layerCount,product:p.details?.product??p.product?.name??receipt.inboundOrder,sku:p.details?.sku??p.product?.sku??'',customerName:p.details?.customerName??receipt.customerName,inboundDate:p.details?.inboundDate??receipt.inboundDate,totalQuantity:0,totalBoxes:p.boxes});
    for(const b of bs){const a=as.find(a=>a?.key===b?.key);if(b&&a)add('carton:'+before.id+':'+b.key,detail(before,b),detail(after,a));}
   }
  }catch{/* Invalid operation evidence remains the physical history reader's concern. */}
 }
 for(const[k,list]of edges){const connected=names.get(k)!;let changed=true;while(changed){changed=false;for(const[a,b]of list)if(connected.has(a)||connected.has(b)){if(!connected.has(a)||!connected.has(b))changed=true;connected.add(a);connected.add(b);}}}
 return names;
}
function physicalOwner(id:string,inboundDate:string|null,customerName:string,owners:MerchantPhysicalOwners,aliases:MerchantAliases,lineage:readonly LayerHistoryLineage[]){
 const seen=new Set<string>();let next=id;
 for(let n=0;n<100&&!seen.has(next);n++){
  seen.add(next);const own=owners[next];
  if(own)return own.inboundDate===inboundDate&&resolveMerchantName(own.customerName,aliases)===resolveMerchantName(customerName,aliases)?own:undefined;
  const parents=lineage.filter(e=>e.childId===next);if(parents.length!==1)return undefined;next=parents[0].parentId;
 }
 return undefined;
}
export function merchantOutboundHistory(records:readonly OutboundHistoryRecord[],rows:readonly Setting[],lineage:readonly LayerHistoryLineage[]=[]){const aliases=merchantAliases(rows),owners=merchantPhysicalOwners(rows);return records.map(record=>{const owner=record.physicalId?physicalOwner(record.physicalId,record.inboundDate,record.customerName,owners,aliases,lineage):undefined,customerName=resolveMerchantName(record.customerName,aliases),original=record.originalCustomerName??record.customerName;return {...record,customerName,billingOriginalCustomerName:resolveMerchantName(owner?owner.originalCustomerName:original,aliases)};});}
/** Current selected portions retain their original cohort for historical ownership.
 * Quantity evidence splits owners only; fees always remain whole-layer fees. */
export function merchantCurrentClaims(occupants:readonly LayerOccupant[],rows:readonly Setting[],asOf:string,lineage:readonly LayerHistoryLineage[]=[]):OutboundHistoryRecord[]{const owners=merchantPhysicalOwners(rows),aliases=merchantAliases(rows),end=new Date(Date.parse(asOf+'T00:00:00Z')+86400000).toISOString().slice(0,10);return occupants.flatMap(o=>{const owner=physicalOwner(o.id,o.inboundDate,o.customerName,owners,aliases,lineage);if(!owner)return[];return[{key:'current-owner:'+o.id,sourceLabel:'在库货物商家更换',customerName:resolveMerchantName(o.customerName,aliases),originalCustomerName:resolveMerchantName(owner.originalCustomerName,aliases),billingOriginalCustomerName:resolveMerchantName(owner.originalCustomerName,aliases),physicalId:o.id,product:o.productName,sku:o.sku,locationCode:o.locationCode,layer:o.layer,inboundDate:o.inboundDate,outboundDate:end,quantity:o.physicalQuantity??0,boxes:o.physicalBoxes??0,palletCount:o.palletCount,estimatedPallets:o.estimatedPallets,order:''}];});}
