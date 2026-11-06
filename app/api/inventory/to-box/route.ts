import {env} from 'cloudflare:workers';
import {requireWriteUser} from '../../../../lib/auth';
import {GoodsFlowError,goodsChoices,parseGoodsState,assertGoodsBalance,type GoodsStock} from '../../../../lib/goods-flow';
import {goodsGuard,goodsFinish,goodsIdempotency,goodsOperation,goodsStateUpdate,goodsResponseError,loadGoodsContext} from '../../../../lib/goods-store';
import {parseAssociationState} from '../../../../lib/inventory-associations';
import {planProductIdentity,validateIdentityMembers} from '../../../../lib/goods-identity';
import {assertStockInventoryUnit} from '../../../../lib/inventory-unit';
const publicResult=(r:Record<string,unknown>)=>{const {beforeAssociationValue,afterAssociationValue,...result}=r;return result;};
export async function POST(request:Request){
 const auth=await requireWriteUser(request,'stock.convert');if(auth.error)return auth.error;
 try{
  const body=await request.json();if(body.scope==='warehouse'&&auth.user!.role!=='admin'&&auth.user!.username.trim().toLowerCase()!=='boss')return Response.json({error:'全仓库存分类转换由有转换权限的老板或管理员操作'},{status:403});
  const idem=await goodsIdempotency(body.requestId,{...body,actorId:auth.user!.id});if(idem.replayed)return Response.json(publicResult(idem.replayed));
  if(body.confirmed!==true||!['one','all','warehouse'].includes(body.scope))throw new GoodsFlowError('请核对并确认转换范围',400);
  const context=await loadGoodsContext(),source=context.choices.find(c=>c.key===body.sourceKey),selected=context.rows.find(r=>r.id===body.stockId);
  if(!source||!selected||!source.members.some(r=>r.id===selected.id)||context.stored.revision!==body.expectedRevision)throw new GoodsFlowError('库位或产品资料已变化，请刷新核对');if(body.scope!=='warehouse')validateIdentityMembers(source,body.members);
  const eligible=(r:GoodsStock)=>r.inventoryUnit!=='box'&&r.totalQuantity===0&&r.totalBoxes>0;
  if(!eligible(selected))throw new GoodsFlowError('只有0件且有箱数的产品库存可以转换；不会清零实际件数',400);
  const beforeRows=(body.scope==='warehouse'?context.rows.filter(eligible):body.scope==='one'?[selected]:source.members.filter(eligible)),ids=new Set(beforeRows.map(r=>r.id));
  if(body.scope==='warehouse'){const refs=body.members;if(!Array.isArray(refs)||refs.length!==beforeRows.length||new Set(refs.map(r=>r?.id)).size!==refs.length||beforeRows.some(r=>!refs.some(x=>x?.id===r.id&&x.version===r.version)))throw new GoodsFlowError('待转换的库存已变化，请刷新后重新核对');}
  if(beforeRows.length>1000)throw new GoodsFlowError('本次最多转换1000条库位记录',400);
  let state=structuredClone(context.state),rows=context.rows;const targetCategories=new Map<string,string>();
  for(const old of beforeRows){
   const current=rows.find(r=>r.id===old.id)!;
   const category=state.categories.find(c=>c.stockIds.includes(old.id));const originalCategory=context.state.categories.find(c=>c.stockIds.includes(old.id))?.id??String(old.id);const targetCategoryId=targetCategories.get(originalCategory);
   if(category){
    const choices=goodsChoices(rows,parseAssociationState(context.associationValue),state),currentSource=choices.find(c=>c.categoryId===category.id)!,target=targetCategoryId?choices.find(c=>c.categoryId===targetCategoryId):undefined;
    const plan=planProductIdentity(state,rows,currentSource,target,{product:currentSource.product,sku:currentSource.sku,customerName:currentSource.customerName},old.id,'one',new Date().toISOString(),auth.user!.displayName,{classificationOnly:true});
    state=plan.state;const convertedCategoryId=state.categories.find(c=>c.stockIds.includes(old.id))!.id;targetCategories.set(originalCategory,convertedCategoryId);
    // Remaining boxes move with their own price/date snapshots, without moving any item quantity.
    for(const lot of state.categories.find(c=>c.id===convertedCategoryId)!.lots){lot.snapshot={...lot.snapshot,inventoryUnit:'box',inventoryReviewDecision:'confirm',totalQuantity:0};assertStockInventoryUnit(lot.snapshot);}
   }
   rows=rows.map(r=>r.id===old.id?{...current,inventoryUnit:'box',inventoryReviewDecision:'confirm'}:r);
  }
  const stamp=new Date().toISOString(),afterRows=beforeRows.map(r=>({...r,inventoryUnit:'box',inventoryReviewDecision:'confirm',updatedAt:stamp,updatedBy:auth.user!.displayName,version:r.version+1}));
  rows=context.rows.map(r=>afterRows.find(a=>a.id===r.id)??r);state=parseGoodsState(JSON.stringify(state));for(const c of state.categories)assertGoodsBalance(c,rows);
  let association=context.associationValue;
  if(association){const a=parseAssociationState(association);for(const link of a.associations)link.members=link.members.filter(m=>!ids.has(m.stockId));a.associations=a.associations.filter(l=>l.members.length);a.revision++;association=JSON.stringify(a);}
  const result={ok:true,stocks:afterRows,stockIds:afterRows.map(r=>r.id),scope:body.scope,count:afterRows.length,inventoryTypeConversion:true};
  await env.DB.batch([goodsGuard(context,idem.id,{rows:context.rows,highId:Math.max(0,...context.rows.map(r=>r.id)),association:true}),...afterRows.map(r=>env.DB.prepare('UPDATE stocks SET inventory_unit=?,inventory_review_decision=?,updated_at=?,updated_by=?,version=? WHERE id=?').bind('box','confirm',stamp,auth.user!.displayName,r.version,r.id)),...(association!==context.associationValue?[env.DB.prepare("UPDATE settings SET value=?,updated_at=? WHERE key='inventory_associations_v1'").bind(association,stamp)]:[]),goodsStateUpdate(state),goodsOperation({id:idem.id,kind:'identity',categoryId:source.categoryId??String(selected.id),fingerprint:idem.fingerprint,beforeCategory:context.state,afterCategory:state,beforeRows,afterRows,settlementIds:[],result:{...result,beforeAssociationValue:context.associationValue,afterAssociationValue:association},stamp}),env.DB.prepare('INSERT INTO audit_logs(user_id,user_name,action,entity_type,entity_id,operation_id,summary,before_snapshot,after_snapshot,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(auth.user!.id,auth.user!.displayName,'库存修改','货物',selected.locationCode,idem.id,`转换为箱库存｜${source.product}｜${afterRows.length}条库位记录｜${afterRows.reduce((n,r)=>n+r.totalBoxes,0)}箱｜原商家、日期、库位、条码与计价参数保留`,JSON.stringify({schema:'goods-operation-v1',rows:beforeRows}),JSON.stringify({schema:'goods-operation-v1',rows:afterRows}),stamp),goodsFinish(idem.id)]);
  return Response.json(result);
 }catch(e){return goodsResponseError(e)}
}
