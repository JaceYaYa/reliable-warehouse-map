import {GoodsFlowError,type GoodsStock,type GoodsState} from './goods-flow';
import {stockProductDetails} from './stock-product';

const identity=(value:string)=>value.normalize('NFKC').trim().toLowerCase().replace(/\s+/g,' ');
export function parseGoodsSku(value:unknown){
 if(typeof value!=='string'||value.length>500||/[\u0000-\u001f\u007f]/.test(value))throw new GoodsFlowError('SKU 必须是 500 字以内的文字，不能包含换行或控制字符',400);
 return value.trim();
}
/** SKU belongs to a customer product, rather than one receipt or location. */
export function assertGoodsSkuAvailable(rows:readonly GoodsStock[],state:GoodsState,target:{id?:string;product:string;customerName:string;stockIds:readonly number[]},sku:string){
 const owner=identity(target.customerName),name=identity(target.product),next=identity(sku),mine=new Set(target.stockIds);
 const inactiveIds=new Set(state.categories.filter(c=>c.archived).flatMap(c=>c.stockIds));
 const conflicts=(other:{sku:string;product:string;customerName:string})=>identity(other.customerName)===owner&&(next?identity(other.sku)===next:identity(other.product)===name);
 if(rows.some(r=>!mine.has(r.id)&&!inactiveIds.has(r.id)&&conflicts({...r,product:stockProductDetails(r).name}))||state.categories.some(c=>!c.archived&&c.id!==target.id&&conflicts(c)))throw new GoodsFlowError(next?'这个客户的其他产品已经使用该 SKU，请核对后再修改':'清空 SKU 会与这个客户的同名产品混合，请保留不同的 SKU');
}
