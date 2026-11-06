import {redactWarehousePricing} from '../../../../lib/permissions';
import {env} from 'cloudflare:workers';
import {requireUser,requireWriteUser} from '../../../../lib/auth';
import {getDb} from '../../../../db';
import {goodsOperations,storageFeeSettlements} from '../../../../db/schema';
import {GoodsFlowError,goodsInteger} from '../../../../lib/goods-flow';
import {correctionCategory,planGoodsCorrection,validateCorrectionOperation} from '../../../../lib/goods-correction';
import {correctionProductPricing} from '../../../../lib/goods-correction-pricing';
import {goodsIdempotency,loadGoodsContext,goodsGuard,goodsStateUpdate,goodsFinish,goodsResponseError,goodsStockUpdate,goodsAudit,goodsOperation} from '../../../../lib/goods-store';
export async function GET(request:Request){const auth=await requireUser(request);if(auth.error)return auth.error;try{
 const stockId=goodsInteger(new URL(request.url).searchParams.get('stockId'),'货物编号',1),context=await loadGoodsContext(),choice=context.choices.find(c=>c.members.some(r=>r.id===stockId));if(!choice)throw new GoodsFlowError('找不到这条货物',404);
 const category=correctionCategory(choice,context.state.categories.find(c=>c.id===choice.categoryId),new Date().toISOString());
 const [operations,settlements]=await getDb().batch([getDb().select().from(goodsOperations),getDb().select().from(storageFeeSettlements)]);
 const selected=choice.members.find(r=>r.id===stockId)!;
 const dates:{date:string;kind:string;label:string;locationCode:string}[]=[{date:selected.inboundDate,kind:'inbound',locationCode:selected.locationCode,label:`入库 ${selected.inboundDate}`}];
 const managedSettlements=new Set<string>();
 // A shared product/category is not evidence that this physical row took part.
 for(const op of operations){if(op.restoredAt)continue;try{const result=JSON.parse(op.result),before=JSON.parse(op.beforeRows),after=JSON.parse(op.afterRows);if(op.kind==='outbound')for(const allocation of result.billingAllocations??[])if(typeof allocation.operationId==='string')managedSettlements.add(allocation.operationId);if(![...before,...after].some(r=>r.id===stockId))continue;const locationCode=selected.locationCode;if(op.kind==='outbound'&&result.outboundDate)dates.push({date:result.outboundDate,kind:'outbound',locationCode,label:`出库 ${result.outboundDate}`});if(op.kind==='correction'&&result.effectiveDate)dates.push({date:result.effectiveDate,kind:'correction',locationCode,label:`数据修正 ${result.effectiveDate}`});if(op.kind==='inbound'||op.kind==='convert')for(const r of after.filter(r=>r.id===stockId))dates.push({date:r.inboundDate,kind:'inbound',locationCode,label:`入库 ${r.inboundDate}`});}catch{}}
 for(const s of settlements)if(s.settlementStatus!=='cancelled'&&!managedSettlements.has(s.operationId??'')&&s.stockId===stockId)dates.push({date:s.outboundAt.slice(0,10),kind:'outbound',locationCode:selected.locationCode,label:`出库 ${s.outboundAt.slice(0,10)}`});
 return Response.json(redactWarehousePricing({revision:context.stored.revision,stock:choice.members.find(r=>r.id===stockId),members:choice.members.map(r=>({id:r.id,version:r.version})),lots:category.lots.map(l=>({id:l.id,date:l.snapshot.inboundDate,quantity:l.quantity,boxes:l.boxes,billingMode:l.snapshot.billingMode,locationCode:l.snapshot.locationCode,stockId:l.stockId})),dates:dates.filter((d,i,a)=>/^\d{4}-\d{2}-\d{2}$/.test(d.date)&&a.findIndex(x=>x.date===d.date&&x.kind===d.kind&&x.locationCode===d.locationCode)===i).sort((a,b)=>b.date.localeCompare(a.date))},auth.user!));
}catch(e){return goodsResponseError(e)}}
export async function POST(request:Request){const auth=await requireWriteUser(request,'stock.edit');if(auth.error)return auth.error;try{
 const body=await request.json(),idem=await goodsIdempotency(body.requestId,{...body,actorId:auth.user!.id});if(idem.replayed)return Response.json(redactWarehousePricing(idem.replayed,auth.user!));
 if(body.pricingSource!==undefined&&body.pricingSource!=='product')throw new GoodsFlowError('库存修正计价方式无效，请刷新页面',400);
 const context=await loadGoodsContext(),stockId=goodsInteger(body.stockId,'货物编号',1),choice=context.choices.find(c=>c.members.some(r=>r.id===stockId));if(!choice||context.stored.revision!==body.expectedRevision)throw new GoodsFlowError('库存已变化，请刷新核对，填写仍保留');
 if(!Array.isArray(body.members)||body.members.length!==choice.members.length||choice.members.some(r=>!body.members.some((x:{id:number;version:number})=>x.id===r.id&&x.version===r.version)))throw new GoodsFlowError('这项货物已被修改，请刷新核对');
 const current=choice.members.find(row=>row.id===stockId)!;
 const pricing=body.pricingSource==='product'&&(Number(body.newQuantity)>current.totalQuantity||Number(body.newBoxes)>current.totalBoxes)?await correctionProductPricing(choice,current):null;
 const stamp=new Date().toISOString(),category=correctionCategory(choice,context.state.categories.find(c=>c.id===choice.categoryId),stamp),plan=planGoodsCorrection(category,context.rows,body,stamp,auth.user!.displayName,pricing?.pricing);
 const state={categories:[...context.state.categories.filter(c=>c.id!==category.id),plan.category]},result={ok:true,inventoryQuantityCorrection:true,effectiveDate:plan.date,stocks:[plan.after],closedAllocations:plan.closed,beforeAssociationValue:context.associationValue,afterAssociationValue:context.associationValue};
 validateCorrectionOperation({result:JSON.stringify(result),beforeRows:JSON.stringify([plan.before]),afterRows:JSON.stringify([plan.after])});
 await env.DB.batch([goodsGuard(context,idem.id,{rows:choice.members,association:true}),...(pricing?[pricing.guard(`${idem.id}:pricing`)]:[]),goodsStockUpdate(plan.after),goodsAudit(auth.user!,idem.id,'convert',category.product,`${category.product}｜库存数据修正｜生效日期 ${plan.date}｜${plan.before.totalQuantity}→${plan.after.totalQuantity}件｜${plan.before.totalBoxes}→${plan.after.totalBoxes}箱｜数量差额 ${plan.dq}件 / ${plan.db}箱｜不是实际入库或出库｜${String(body.reason??'').slice(0,1000)}`,[plan.before],[plan.after],stamp),goodsOperation({id:idem.id,kind:'correction',categoryId:category.id,fingerprint:idem.fingerprint,beforeCategory:context.state,afterCategory:state,beforeRows:[plan.before],afterRows:[plan.after],settlementIds:[],result,stamp}),goodsStateUpdate(state),...(pricing?[goodsFinish(`${idem.id}:pricing`)]:[]),goodsFinish(idem.id)]);return Response.json(redactWarehousePricing(result,auth.user!));
}catch(e){return goodsResponseError(e)}}
