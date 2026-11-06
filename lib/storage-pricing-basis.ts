import {eq} from 'drizzle-orm';
import {getDb} from '../db';
import {settings} from '../db/schema';
import {GoodsFlowError} from './goods-flow';
export const STORAGE_PRICING_BASIS_KEY='storage_pricing_basis';
/** FORMAL V128 defaults to the owner-approved layer basis; explicit legacy is read-compatible. */
export function layerStoragePricingFromValue(raw:string|undefined):boolean{
 if(raw===undefined)return true;
 let value:unknown=raw;try{value=JSON.parse(raw);}catch{/* raw layer/legacy values are intentional */}
 if(value==='layer')return true;
 if(value==='legacy')return false;
 throw new GoodsFlowError('仓储计价口径配置无效，请先核对；本次未写入',409);
}
export async function isLayerStoragePricing(db:ReturnType<typeof getDb>=getDb()):Promise<boolean>{const [row]=await db.select({value:settings.value}).from(settings).where(eq(settings.key,STORAGE_PRICING_BASIS_KEY)).limit(1);return layerStoragePricingFromValue(row?.value);}
