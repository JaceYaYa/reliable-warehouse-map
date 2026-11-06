import {redactWarehousePricing} from '../../../../lib/permissions';
import {env} from 'cloudflare:workers';
import {requireWriteUser} from '../../../../lib/auth';
import {GoodsFlowError,assertGoodsBalance,materializeGoods} from '../../../../lib/goods-flow';
import {goodsFinish,goodsGuard,goodsIdempotency,goodsOperation,goodsResponseError,goodsStateUpdate,loadGoodsContext} from '../../../../lib/goods-store';
import {assertGoodsSkuAvailable,parseGoodsSku} from '../../../../lib/goods-sku';
import {inventoryIdentity,parseAssociationState} from '../../../../lib/inventory-associations';

export async function POST(request:Request){
 const auth=await requireWriteUser(request,'product.manage');if(auth.error)return auth.error;
 try{
  const body=await request.json() as Record<string,unknown>,idem=await goodsIdempotency(body.requestId,body);if(idem.replayed){const {beforeAssociationValue:_,afterAssociationValue:__,...replayed}=idem.replayed;return Response.json(redactWarehousePricing(replayed,auth.user!))}
  if(body.confirmAll!==true)throw new GoodsFlowError('请确认：该产品所有库位的 SKU 都会一起修改',400);
  const sku=parseGoodsSku(body.sku),context=await loadGoodsContext(),choice=context.choices.find(c=>c.key===body.key);
  if(!choice||body.expectedRevision!==context.stored.revision)throw new GoodsFlowError('货物列表已变化，请刷新核对');
  if(choice.review)throw new GoodsFlowError(choice.reason);
  const expected=body.members as {id:number;version:number}[];
  if(!Array.isArray(expected)||expected.length!==choice.members.length||new Set(expected.map(r=>r?.id)).size!==expected.length||choice.members.some(r=>!expected.some(x=>x?.id===r.id&&x.version===r.version)))throw new GoodsFlowError('该产品的库位已变化，请刷新核对后修改 SKU');
  const stamp=new Date().toISOString(),beforeCategory=choice.categoryId?context.state.categories.find(c=>c.id===choice.categoryId)!:null,category=beforeCategory?structuredClone(beforeCategory):materializeGoods(choice,stamp);
  assertGoodsBalance(category,context.rows);assertGoodsSkuAvailable(context.rows,context.state,category,sku);
  const afterRows=choice.members.map(r=>({...r,sku,updatedBy:auth.user!.displayName,updatedAt:stamp,version:r.version+1}));
  category.sku=sku;for(const lot of category.lots)lot.snapshot={...lot.snapshot,sku};
  const state={categories:[...context.state.categories.filter(c=>c.id!==category.id),category]};
  const associations=context.associationValue?parseAssociationState(context.associationValue):null;let afterAssociationValue:string|null=context.associationValue;
  if(associations){let changed=false;for(const association of associations.associations)for(const member of association.members){const row=afterRows.find(r=>r.id===member.stockId);if(row){member.identity=inventoryIdentity(row);changed=true}}if(changed){associations.revision++;afterAssociationValue=JSON.stringify(associations)}}
  const result={ok:true,key:`category:${category.id}`,categoryId:category.id,sku,stockIds:category.stockIds,beforeAssociationValue:context.associationValue,afterAssociationValue};
  const queries=afterRows.map(r=>env.DB.prepare('UPDATE stocks SET sku=?,updated_at=?,updated_by=?,version=? WHERE id=?').bind(r.sku,r.updatedAt,r.updatedBy,r.version,r.id));
  if(afterAssociationValue!==context.associationValue)queries.push(env.DB.prepare("UPDATE settings SET value=?,updated_at=? WHERE key='inventory_associations_v1'").bind(afterAssociationValue,stamp));
  const summary=`${category.product}｜客户 ${category.customerName}｜统一修改所有 ${afterRows.length} 条库位 SKU｜${choice.sku||'未填写'} → ${sku||'未填写'}｜库存数量、日期与条码保留`;
  await env.DB.batch([goodsGuard(context,idem.id,{rows:context.rows,highId:Math.max(0,...context.rows.map(r=>r.id)),association:true}),...queries,goodsStateUpdate(state),env.DB.prepare('INSERT INTO audit_logs(user_id,user_name,action,entity_type,entity_id,operation_id,summary,before_snapshot,after_snapshot,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').bind(auth.user!.id,auth.user!.displayName,'库存修改','货物',category.product,idem.id,summary,JSON.stringify({schema:'goods-operation-v1',operationId:idem.id,rows:choice.members}),JSON.stringify({schema:'goods-operation-v1',operationId:idem.id,rows:afterRows}),stamp),goodsOperation({id:idem.id,kind:'sku',categoryId:category.id,fingerprint:idem.fingerprint,beforeCategory,afterCategory:category,beforeRows:choice.members,afterRows,settlementIds:[],result,stamp}),goodsFinish(idem.id)]);
  // Association snapshots remain internal to the operation record.
  return Response.json(redactWarehousePricing({ok:true,key:result.key,categoryId:result.categoryId,sku,stockIds:result.stockIds},auth.user!));
 }catch(e){return goodsResponseError(e)}
}
