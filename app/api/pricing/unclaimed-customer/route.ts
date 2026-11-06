import {eq} from 'drizzle-orm';
import {getDb} from '../../../../db';
import {stocks,cartonReceipts} from '../../../../db/schema';
import {requireUser} from '../../../../lib/auth';
import {GoodsFlowError} from '../../../../lib/goods-flow';
import {cartonBody,cartonView,updateCartonDetails,cartonResponseError} from '../../../../lib/carton-store';
import {cartonPlacementDetails} from '../../../../lib/box-stock-details';
import {PUT as assignStockCustomer} from '../../stocks/route';

const headers={'cache-control':'no-store'};
const error=(message:string,status=400)=>Response.json({error:message},{status,headers});
/** Assign only the still-unclaimed physical target through its existing audited write path. */
export async function PATCH(request:Request){
 const auth=await requireUser(request,'pricing.manage');if(auth.error){auth.error.headers.set('cache-control','no-store');return auth.error;}
 try{
  const body=cartonBody(await request.json());
  if(Object.keys(body).some(key=>!['id','customerName','expectedVersion'].includes(key)))return error('认领请求包含不允许修改的字段');
  const id=body.id,customerName=typeof body.customerName==='string'?body.customerName.trim():'';
  if(typeof id!=='string'||!customerName||customerName.length>200||/[\u0000-\u001f\u007f]/u.test(customerName))return error('请选择待认领货物并填写有效客户名称（最多200字）');
  if(body.expectedVersion!==undefined&&(!Number.isSafeInteger(body.expectedVersion)||(body.expectedVersion as number)<0))return error('库存版本无效，请刷新');
  const db=getDb(),stock=/^stock:([1-9]\d*)$/.exec(id),carton=/^carton:([^:]+):(.+)$/.exec(id);
  if(stock){
   const stockId=Number(stock[1]);if(!Number.isSafeInteger(stockId))return error('库存记录标识无效');
   const [before]=await db.select().from(stocks).where(eq(stocks.id,stockId));
   if(!before)return error('货物已不存在，请刷新',404);
   if(before.customerName.trim()||!(before.totalQuantity>0||before.totalBoxes>0))return error('货物已认领或已无库存，请刷新核对',409);
   if(body.expectedVersion!==undefined&&body.expectedVersion!==before.version)return error('库存已有变化，请刷新核对',409);
   const forwarded=Object.fromEntries(request.headers.entries());delete forwarded['content-length'];forwarded['content-type']='application/json';
   const response=await assignStockCustomer(new Request(request.url,{method:'PUT',headers:forwarded,body:JSON.stringify({id:stockId,version:before.version,customerName})}));
   if(!response.ok){response.headers.set('cache-control','no-store');return response;}
   return Response.json({ok:true,...await response.json()},{headers});
  }
  if(carton){
   const [before]=await db.select().from(cartonReceipts).where(eq(cartonReceipts.id,carton[1]));
   if(!before)return error('箱库存已不存在，请刷新',404);
   const receipt=cartonView(before),placement=receipt.placements.find(item=>item.key===carton[2]);
   if(!placement)return error('箱库存分配已不存在，请刷新',404);
   const detail=cartonPlacementDetails(receipt,placement);
   if(detail.customerName.trim()||placement.boxes<=0)return error('箱库存已认领或已无库存，请刷新核对',409);
   if(body.expectedVersion!==undefined&&body.expectedVersion!==before.version)return error('箱库存已有变化，请刷新核对',409);
   // The identity updater normalizes text; never silently normalize other legacy identity fields here.
   if(detail.product!==detail.product.trim()||detail.sku!==detail.sku.trim())return error('产品名称或SKU含待核对的旧格式，请先核对产品资料后认领',409);
   const result=await updateCartonDetails({requestId:crypto.randomUUID(),id:before.id,expectedVersion:before.version,placementKey:placement.key,identity:{product:detail.product,sku:detail.sku,customerName}},auth.user!);
   return Response.json(result,{headers});
  }
  return error('库存记录标识无效');
 }catch(cause){
  if(cause instanceof GoodsFlowError){const response=cartonResponseError(cause);response.headers.set('cache-control','no-store');return response;}
  return error('客户认领失败，请刷新后核对');
 }
}
