import {redactWarehousePricing} from '../../../../lib/permissions';
import {env} from 'cloudflare:workers';
import {requireWriteUser} from '../../../../lib/auth';
import {GoodsFlowError,assertGoodsBalance,materializeGoods} from '../../../../lib/goods-flow';
import {parseGoodsProductSpec,goodsProductVolume} from '../../../../lib/goods-product-spec';
import {goodsFinish,goodsGuard,goodsIdempotency,goodsOperation,goodsResponseError,goodsStateUpdate,loadGoodsContext} from '../../../../lib/goods-store';

/** Change the product specification for future receipts, preserving every historic cost lot. */
export async function POST(request:Request){
 const auth=await requireWriteUser(request,'product.manage');if(auth.error)return auth.error;
 try{
  const body=await request.json() as Record<string,unknown>,idem=await goodsIdempotency(body.requestId,body);if(idem.replayed)return Response.json(redactWarehousePricing(idem.replayed,auth.user!));
  if(body.confirmAll!==true)throw new GoodsFlowError('请确认：修改该产品体积/尺寸会影响今后的入库，历史批次与已生成费用保持原值',400);
  let productSpec;try{productSpec=parseGoodsProductSpec(body.productSpec,true)}catch(e){throw new GoodsFlowError(e instanceof Error?e.message:'产品体积/尺寸无效',400)}
  const context=await loadGoodsContext(),choice=context.choices.find(c=>c.key===body.key);
  if(!choice||body.expectedRevision!==context.stored.revision)throw new GoodsFlowError('货物资料已变化，请刷新核对后保存');
  if(choice.review)throw new GoodsFlowError(choice.reason);
  const expected=body.members as {id:number;version:number}[];
  if(!Array.isArray(expected)||expected.length!==choice.members.length||new Set(expected.map(r=>r?.id)).size!==expected.length||choice.members.some(r=>!expected.some(x=>x?.id===r.id&&x.version===r.version)))throw new GoodsFlowError('该产品的库位已变化，请刷新核对后保存体积/尺寸');
  const stamp=new Date().toISOString(),beforeCategory=choice.categoryId?context.state.categories.find(c=>c.id===choice.categoryId)!:null,category=beforeCategory?structuredClone(beforeCategory):materializeGoods(choice,stamp);
  assertGoodsBalance(category,context.rows);category.productSpec=productSpec;
  const state={categories:[...context.state.categories.filter(c=>c.id!==category.id),category]},result={ok:true,previousKey:choice.key,key:`category:${category.id}`,categoryId:category.id,productSpec,revision:context.stored.revision+1,stockIds:category.stockIds};
  const summary=`${category.product}｜客户 ${category.customerName}｜修改产品体积/尺寸｜${productSpec.billingMode==='box'?'每箱':'每件'} ${goodsProductVolume(productSpec)} m³｜仅今后入库沿用，原库位、历史计价批次与费用保留`;
  await env.DB.batch([goodsGuard(context,idem.id,{rows:context.rows,highId:Math.max(0,...context.rows.map(r=>r.id)),association:true}),goodsStateUpdate(state),env.DB.prepare('INSERT INTO audit_logs(user_id,user_name,action,entity_type,entity_id,operation_id,summary,before_snapshot,after_snapshot,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').bind(auth.user!.id,auth.user!.displayName,'库存修改','货物',category.product,idem.id,summary,JSON.stringify({schema:'goods-operation-v1',operationId:idem.id,rows:[],productSpec:choice.productSpec}),JSON.stringify({schema:'goods-operation-v1',operationId:idem.id,rows:[],productSpec}),stamp),goodsOperation({id:idem.id,kind:'spec',categoryId:category.id,fingerprint:idem.fingerprint,beforeCategory,afterCategory:category,beforeRows:[],afterRows:[],settlementIds:[],result,stamp}),goodsFinish(idem.id)]);
  return Response.json(redactWarehousePricing(result,auth.user!));
 }catch(e){return goodsResponseError(e)}
}
