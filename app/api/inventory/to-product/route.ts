import {env} from 'cloudflare:workers';
import {requireWriteUser} from '../../../../lib/auth';
import {hasPermission} from '../../../../lib/permissions';
import {GoodsFlowError,assertGoodsBalance,goodsInteger,materializeGoods,parseGoodsState,type GoodsChoice} from '../../../../lib/goods-flow';
import {goodsAudit,goodsFinish,goodsGuard,goodsIdempotency,goodsOperation,goodsResponseError,goodsStateUpdate,loadGoodsContext} from '../../../../lib/goods-store';
import {identityText,parseProductIdentity,planProductIdentity,validateIdentityMembers} from '../../../../lib/goods-identity';
import {parseAssociationState} from '../../../../lib/inventory-associations';
import {parseGoodsProductSpec} from '../../../../lib/goods-product-spec';
const publicResult=(r:Record<string,unknown>)=>{const {beforeAssociationValue,afterAssociationValue,...result}=r;return result;};
/** Convert only the selected physical stock. Existing boxes remain their original dated cost lots. */
export async function POST(request:Request){
 const auth=await requireWriteUser(request,'stock.convert');if(auth.error)return auth.error;
 try{
  const body=await request.json();if(body.createTarget===true&&!hasPermission(auth.user!,'product.manage'))return Response.json({error:'没有创建或修改产品资料的权限，请选择已有产品'},{status:403});
  const idem=await goodsIdempotency(body.requestId,{...body,actorId:auth.user!.id});if(idem.replayed)return Response.json(publicResult(idem.replayed));
  if(body.confirmed!==true)throw new GoodsFlowError('请核对并确认转换资料',400);
  for(const k of ['inboundDate','locationCode','layerCount','boxes','inventoryUnit','billingMode','storageRateUsd','freeDays'])if(body[k]!==undefined)throw new GoodsFlowError('转换时保留原日期、库位、层数、箱数与计价参数',400);
  const quantity=goodsInteger(body.quantity,'实际产品件数',1),context=await loadGoodsContext(),selected=context.rows.find(r=>r.id===body.stockId),source=context.choices.find(c=>c.key===body.sourceKey);
  if(!selected||!source||!source.members.some(r=>r.id===selected.id)||context.stored.revision!==body.expectedRevision||selected.version!==body.expectedVersion)throw new GoodsFlowError('库位或产品资料已变化，请刷新核对');
  validateIdentityMembers(source,body.members);
  if(selected.inventoryUnit!=='box'||selected.totalQuantity!==0||selected.totalBoxes<=0)throw new GoodsFlowError('只有仍有箱数的箱库存可以转换，请填写实际产品件数',400);
  let target:GoodsChoice|undefined;
  if(body.targetKey!==undefined){target=context.choices.find(c=>c.key===body.targetKey);if(!target||target.key===source.key||target.members.some(r=>r.inventoryUnit==='box')||target.archived)throw new GoodsFlowError('请选择已有产品库存，箱库存不能作为转换目标',400);validateIdentityMembers(target,body.targetMembers);if(target.review||!target.customerName.trim())throw new GoodsFlowError('目标产品资料仍需核对，请先完善商家和产品关联',400);}
  else if(body.createTarget!==true)throw new GoodsFlowError('请选择已有产品，或确认创建新产品',400);
  const identity=target?{product:target.product,customerName:target.customerName,sku:target.sku}:parseProductIdentity(body.identity);
  if(!target&&context.choices.some(c=>c.key!==source.key&&!c.members.some(r=>r.inventoryUnit==='box')&&identityText(c.customerName)===identityText(identity.customerName)&&(identity.sku?identityText(c.sku)===identityText(identity.sku):identityText(c.product)===identityText(identity.product))))throw new GoodsFlowError('已有同商家、同SKU或同名的产品，请选择已有产品',400);
  let productSpec;if(body.productSpec!==undefined){if(target)throw new GoodsFlowError('已有产品的尺寸通过产品资料修改，转换不覆盖历史计价',400);try{productSpec=parseGoodsProductSpec(body.productSpec);}catch(e){throw new GoodsFlowError(e instanceof Error?e.message:'产品尺寸无效',400);}}
  const stamp=new Date().toISOString(),initial=structuredClone(context.state);
  // An unclaimed legacy box group is materialized without inventing its merchant.
  let managedSource=source;if(!source.categoryId){const category=materializeGoods(source,stamp,{allowPendingIdentity:true});initial.categories.push(category);managedSource={...source,key:`category:${category.id}`,categoryId:category.id};}
  const plan=planProductIdentity(initial,context.rows,managedSource,target,identity,selected.id,'one',stamp,auth.user!.displayName),after={...plan.afterRows[0],totalQuantity:quantity,inventoryUnit:'item',inventoryReviewDecision:''},rows=context.rows.map(r=>r.id===selected.id?after:r),category=plan.state.categories.find(c=>c.stockIds.includes(selected.id))!;
  if(productSpec)category.productSpec=productSpec;
  // Do not spread pieces over dated box lots by an invented per-box ratio.
  // Original remaining box lots keep their quantities, dates and pricing parameters;
  // actual pieces get a separate lot with this physical record's original snapshot.
  const previousLotIds=new Set(context.state.categories.flatMap(c=>c.lots.map(l=>l.id)));
  const movedLots=category.lots.filter(l=>l.stockId===selected.id&&!previousLotIds.has(l.id));
  for(const lot of movedLots)lot.snapshot={...lot.snapshot,inventoryUnit:'item',inventoryReviewDecision:''};
  category.lots.push({id:crypto.randomUUID(),stockId:selected.id,quantity,boxes:0,snapshot:{...after,totalBoxes:0}});
  const state=parseGoodsState(JSON.stringify(plan.state));for(const c of state.categories)assertGoodsBalance(c,rows);
  let association=context.associationValue;if(association){const a=parseAssociationState(association);for(const link of a.associations)link.members=link.members.filter(m=>m.stockId!==selected.id);a.associations=a.associations.filter(l=>l.members.length);a.revision++;association=JSON.stringify(a);}
  const result={ok:true,stocks:[after],stockIds:[selected.id],key:`category:${category.id}`,categoryId:category.id,inventoryTypeConversion:true,inventoryToProduct:true,pricingReview:after.inboundSource==='return'&&(after.billingMode==='box'?after.boxVolumeM3<=0:after.itemVolumeM3<=0)};
  await env.DB.batch([goodsGuard(context,idem.id,{rows:context.rows,highId:Math.max(0,...context.rows.map(r=>r.id)),association:true}),env.DB.prepare('UPDATE stocks SET product=?,product_prefix=?,product_condition=?,customer_name=?,sku=?,catalog_item_id=?,total_quantity=?,inventory_unit=?,inventory_review_decision=?,updated_at=?,updated_by=?,version=? WHERE id=?').bind(after.product,after.productPrefix,after.productCondition,after.customerName,after.sku,after.catalogItemId,quantity,'item','',stamp,auth.user!.displayName,after.version,after.id),...(association!==context.associationValue?[env.DB.prepare("UPDATE settings SET value=?,updated_at=? WHERE key='inventory_associations_v1'").bind(association,stamp)]:[]),goodsStateUpdate(state),goodsOperation({id:idem.id,kind:'identity',categoryId:category.id,fingerprint:idem.fingerprint,beforeCategory:context.state,afterCategory:state,beforeRows:[selected],afterRows:[after],settlementIds:[],result:{...result,beforeAssociationValue:context.associationValue,afterAssociationValue:association},stamp}),goodsAudit(auth.user!,idem.id,'convert',identity.product,`箱库存转换为产品库存｜${identity.product}｜实际${quantity}件／${selected.totalBoxes}箱｜原入库日期 ${selected.inboundDate}、库位、品相、标记和计价参数保留`,[selected],[after],stamp),goodsFinish(idem.id)]);
  return Response.json(result);
 }catch(e){return goodsResponseError(e)}
}
