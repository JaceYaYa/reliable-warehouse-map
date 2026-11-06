import {stockProductDetails} from './stock-product.ts';
import {palletLabel} from './pallet.ts';
import {locationCodeKey} from './location-code.ts';
type Row={id?:number|string;locationCode:string;layerCount?:number;layer?:number;customerName:string;product?:string;productName?:string;productPrefix?:string;productCondition?:string;sku?:string;palletCount?:number;palletManual?:boolean;palletRawCount?:number;palletLabel?:string;palletRawLabel?:string;totalQuantity?:number;totalBoxes?:number};
const clean=(v:unknown)=>String(v??'').normalize('NFKC').trim().replace(/\s+/g,' ').toLowerCase();
const parse=(v:unknown)=>{try{return typeof v==='string'?JSON.parse(v):v;}catch{return null}};
export const palletManualKey=(id:number|string)=>'pallet_manual:stock:'+id;
/** Default pallet shares are a projection, never a rewrite of inbound dates or source records. */
export function automaticPalletRows<T extends Row>(rows:readonly T[],settings:readonly {key:string;value:string}[]=[],audits:readonly Record<string,unknown>[]=[]):Array<T&{palletCount:number;palletLabel:string;palletAutomatic:boolean;palletRawCount:number;palletRawLabel:string}>{
 const automatic=new Set<string>(),manual=new Set<string>();for(const setting of settings)if(setting.key.startsWith('pallet_manual:stock:')){const value=parse(setting.value);if(value===true)manual.add(setting.key.slice('pallet_manual:stock:'.length));if(value===false)automatic.add(setting.key.slice('pallet_manual:stock:'.length));}
 // A real numeric edit proves a manual choice even when its final value is one.
 for(const audit of audits){if(audit.action!=='库存修改')continue;const b=parse(audit.beforeValue??audit.before_value),a=parse(audit.afterValue??audit.after_value);if(a&&b&&typeof a==='object'&&typeof b==='object'){const before=b as Record<string,unknown>,after=a as Record<string,unknown>;if(after.id!==undefined&&typeof before.palletCount==='number'&&typeof after.palletCount==='number'&&before.palletCount!==after.palletCount)manual.add(String(after.id));}}
 const modes=rows.map(row=>{const present=(row.totalQuantity??1)>0||(row.totalBoxes??0)>0,count=row.palletCount;return{present,manual:row.palletManual===true||!automatic.has(String(row.id))&&row.palletManual!==false&&(manual.has(String(row.id))||typeof count==='number'&&count!==1),key:JSON.stringify([locationCodeKey(row.locationCode),row.layerCount??row.layer??1,clean(row.customerName),clean(stockProductDetails({product:String(row.product??row.productName??''),productPrefix:row.productPrefix,productCondition:row.productCondition}).name)])};});
 const sizes=new Map<string,number>();modes.forEach(m=>{if(m.present)sizes.set(m.key,(sizes.get(m.key)??0)+1)});
 return rows.map((row,i)=>{const mode=modes[i],count=!mode.present?0:mode.manual?(row.palletCount??1):1/(sizes.get(mode.key)??1);return {...row,palletRawLabel:row.palletRawLabel??row.palletLabel??palletLabel(row.palletCount??1),palletRawCount:row.palletRawCount??row.palletCount??1,palletCount:count,palletLabel:palletLabel(count),palletAutomatic:mode.present&&!mode.manual};});
}

