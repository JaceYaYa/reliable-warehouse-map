import {env} from 'cloudflare:workers';
import {GoodsFlowError,assertGoodsBalance,planGoodsOutbound} from './goods-flow';
import {validateCorrectionOperation} from './goods-correction';
import {goodsFinish,goodsGuard,goodsIdempotency,goodsOperation,goodsStateUpdate,goodsStockUpdate,loadGoodsContext} from './goods-store';
import {warehouseTodayDate} from './warehouse-time';
const publicDiscardResult=(result:Record<string,unknown>)=>({ok:true,deletedId:result.deletedId,inventoryDeletion:true,effectiveDate:result.effectiveDate});

/** Managed stock IDs anchor cost history. Discard closes quantities without deleting those anchors or making an outbound bill. */
export async function discardManagedGoods(input:{id:number;expectedVersion:number;requestId?:unknown},user:{id:number;displayName:string}){
 const context=await loadGoodsContext(),category=context.state.categories.find(c=>c.stockIds.includes(input.id));
 if(!category)return null;
 const idem=await goodsIdempotency(input.requestId??crypto.randomUUID(),{inventoryDeletion:true,stockId:input.id,expectedVersion:input.expectedVersion,actorId:user.id});
 if(idem.replayed)return Response.json(publicDiscardResult(idem.replayed));
 const before=context.rows.find(r=>r.id===input.id);
 if(!before)throw new GoodsFlowError('货物不存在或已经被删除',404);
 if(before.version!==input.expectedVersion)throw new GoodsFlowError('该库存刚刚被其他账号修改，请刷新后重试');
 assertGoodsBalance(category,context.rows);
 if(!before.totalQuantity&&!before.totalBoxes)return Response.json({ok:true,deletedId:before.id,inventoryDeletion:true,alreadyDeleted:true});
 const stamp=new Date().toISOString(),effectiveDate=warehouseTodayDate(new Date(stamp));
 // Reuse quantity/FIFO accounting only. Discard deliberately performs no settlement or missing-volume checks.
 const plan=planGoodsOutbound(category,context.rows,[{id:before.id,version:before.version,quantity:before.totalQuantity,boxes:before.totalBoxes}],before.totalQuantity,before.totalBoxes,stamp,user.displayName);
 const closedAllocations=plan.allocations.map(a=>({lotId:a.lot.id,quantity:a.quantity,boxes:a.boxes,snapshot:{...a.lot.snapshot},effectiveDate}));
 const next={categories:context.state.categories.map(c=>c.id===category.id?plan.category:c)};
 const result={ok:true,deletedId:before.id,inventoryDeletion:true,inventoryQuantityCorrection:true,effectiveDate,stocks:plan.after,closedAllocations,beforeAssociationValue:context.associationValue,afterAssociationValue:context.associationValue};
 validateCorrectionOperation({result:JSON.stringify(result),beforeRows:JSON.stringify([before]),afterRows:JSON.stringify(plan.after),beforeCategory:JSON.stringify(context.state),afterCategory:JSON.stringify(next)});
 const summary=`${category.product}｜删除货物｜原库存 ${before.totalQuantity}件/${before.totalBoxes}箱｜库存与计价数量截至 ${effectiveDate}｜保留产品资料和原计价历史｜不计入出入库`;
 await env.DB.batch([
  goodsGuard(context,idem.id,{rows:context.rows,highId:Math.max(0,...context.rows.map(r=>r.id)),association:true}),
  ...plan.after.map(goodsStockUpdate),
  env.DB.prepare('INSERT INTO audit_logs(user_id,user_name,action,entity_type,entity_id,operation_id,summary,before_snapshot,after_snapshot,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').bind(user.id,user.displayName,'删除','库位',before.locationCode,idem.id,summary,JSON.stringify({schema:'goods-operation-v1',operationId:idem.id,rows:[before]}),JSON.stringify({schema:'goods-operation-v1',operationId:idem.id,rows:plan.after}),stamp),
  goodsOperation({id:idem.id,kind:'correction',categoryId:category.id,fingerprint:idem.fingerprint,beforeCategory:context.state,afterCategory:next,beforeRows:[before],afterRows:plan.after,settlementIds:[],result,stamp}),
  goodsStateUpdate(next),goodsFinish(idem.id),
 ]);
 return Response.json(publicDiscardResult(result));
}
