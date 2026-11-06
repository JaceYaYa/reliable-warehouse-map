import {automaticPalletRows} from './automatic-pallets';
import {cartonPalletCount,type CartonPlacement,type CartonReceipt} from './carton-flow';
import {cartonPlacementDetails} from './box-stock-details';
type Row={id:string;placements:string;customerName:string;inboundOrder:string;inboundDate:string;palletRawPlacements?:string};
type Operation={restoredAt?:string|null;kind:string;beforeSnapshot:string|null;afterSnapshot:string|null};
export type CartonPalletProjection={hadCount:boolean;count?:number;hadManual:boolean;manual?:boolean;projectedCount:number;projectedManual:boolean};
const peers=new WeakMap<object,readonly Row[]>();
const parsed=(value:string|null)=>{try{return value?JSON.parse(value):null}catch{return null}};
/** All receipts are one read snapshot. SKU never divides a named product's automatic pallet. */
export function projectCartonRows<T extends Row>(rows:readonly T[],operations:readonly Operation[]=[]):T[]{
 const manual=new Set<string>();
 for(const op of operations){if(op.restoredAt||!['details','correction'].includes(op.kind))continue;const before=parsed(op.beforeSnapshot),after=parsed(op.afterSnapshot);if(!before||!after)continue;const old=parsed(before.placements),next=parsed(after.placements);if(!Array.isArray(old)||!Array.isArray(next))continue;for(const p of next){const previous=old.find(x=>x.key===p.key);if(previous&&!previous.palletProjection&&typeof previous.palletCount==='number'&&typeof p.palletCount==='number'&&previous.palletCount!==p.palletCount)manual.add(after.id+':'+p.key);}}
 const flat=rows.flatMap(row=>{const placements=JSON.parse(row.placements) as CartonPlacement[];return placements.map(p=>{const d=cartonPlacementDetails({...row,placements} as unknown as CartonReceipt,p);return{id:row.id+':'+p.key,locationCode:p.locationCode,layerCount:d.layerCount,customerName:d.customerName,product:d.product,palletCount:cartonPalletCount(p),palletManual:p.palletManual??(manual.has(row.id+':'+p.key)?true:undefined),totalQuantity:0,totalBoxes:p.boxes};});});
 const projected=new Map(automaticPalletRows(flat).map(p=>[p.id,p]));
 return rows.map(row=>{let changed=false;const placements=(JSON.parse(row.placements) as CartonPlacement[]).map(p=>{const value=projected.get(row.id+':'+p.key)!;if(p.palletCount===value.palletCount&&!(p.palletManual===undefined&&manual.has(row.id+':'+p.key)))return p;changed=true;return{...p,palletCount:value.palletCount,palletManual:!value.palletAutomatic,palletAutomatic:value.palletAutomatic,palletProjection:{hadCount:Object.hasOwn(p,'palletCount'),count:p.palletCount,hadManual:Object.hasOwn(p,'palletManual'),manual:p.palletManual,projectedCount:value.palletCount,projectedManual:!value.palletAutomatic}};});const result=changed?{...row,placements:JSON.stringify(placements),palletRawPlacements:row.placements}:{...row};peers.set(result,rows);return result;});
}
function restoreValues(p:CartonPlacement){const {palletProjection:meta,palletAutomatic,...next}=p;void palletAutomatic;if(meta){if(meta.hadCount)next.palletCount=meta.count;else delete next.palletCount;if(meta.hadManual)next.palletManual=meta.manual;else delete next.palletManual;}return next;}
/** Recreate exact pre-read pallet fields for optimistic guards and undo. */
export function rawCartonRow<T extends Row>(row:T):T{const{palletRawPlacements,...raw}=row;return{...raw,placements:palletRawPlacements??row.placements} as T;}
/** Untouched automatic values retain their stored default; physical changes explicitly freeze their count. */
export function persistedCartonRow<T extends Row>(row:T):T{const{palletRawPlacements,...base}=row;void palletRawPlacements;return{...base,placements:JSON.stringify((JSON.parse(row.placements) as CartonPlacement[]).map(p=>{const meta=p.palletProjection;if(meta&&p.palletCount===meta.projectedCount&&p.palletManual===meta.projectedManual)return restoreValues(p);const{palletProjection,palletAutomatic,...next}=p;void palletProjection;void palletAutomatic;return next;}))} as T;}
export function fixedCartonPlacement(p:CartonPlacement,count:number):CartonPlacement{const{palletProjection,palletAutomatic,...next}=p;void palletProjection;void palletAutomatic;return{...next,palletCount:count,...(count===0&&p.boxes===0?{}:{palletManual:true})};}
export const cartonProjectionPeers=(row:Row)=>peers.get(row);
export function withCartonProjectionPeers<T extends Row>(row:T,rawPeers:readonly Row[]):T{peers.set(row,rawPeers);return row;}
export function projectCartonReceipts<T extends CartonReceipt>(receipts:readonly T[],operations:readonly Operation[]=[]):T[]{const normalized=projectCartonRows(receipts.map(r=>({...r,placements:JSON.stringify(r.placements)})),operations);return normalized.map(row=>({...row,placements:JSON.parse(row.placements)}));}
