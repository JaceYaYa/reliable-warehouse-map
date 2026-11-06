import {env} from 'cloudflare:workers';
import {asc,gt} from 'drizzle-orm';
import {getDb} from '../db';
import {auditLogs,goodsOperations} from '../db/schema';
import {GoodsFlowError,type GoodsState,type GoodsStock} from './goods-flow';
import {goodsPalletModeWrites,goodsFinish,goodsGuard,goodsResponseError,goodsStockInsert,goodsStateUpdate,loadGoodsContext} from './goods-store';
import {loadLocationAliases} from './location-alias-store';
import {remapSnapshotLocations} from './location-aliases';
import {assertGoodsRestorePermission} from './goods-operation-permissions';
import type {PermissionUser} from './permissions';
import {validateStagingOperation} from './goods-staging';
const same=(a:GoodsStock|undefined,b:GoodsStock)=>!!a&&Object.entries(b).every(([k,v])=>{
 if(['palletManual','palletAutomatic','palletRawCount','palletRawLabel'].includes(k))return true;
 if(k==='palletCount')return(a.palletRawCount??a.palletCount)===(b.palletRawCount??v);
 if(k==='palletLabel')return(a.palletRawLabel??a.palletLabel)===(b.palletRawLabel??v);
 return a[k as keyof GoodsStock]===v;
});
const businessSame=(a:GoodsStock,b:GoodsStock)=>same({...a,version:b.version,updatedAt:b.updatedAt,updatedBy:b.updatedBy},b);
// Outbound and its undo append the affected category. Its position is not inventory state;
// all category fields, lot order and snapshots must still match exactly.
const stateImage=(state:GoodsState)=>JSON.stringify({...state,categories:[...state.categories].sort((a,b)=>a.id.localeCompare(b.id))});
/** Replay only signed-by-the-application outbound/restore audit edges. Metadata is never ignored without that chain. */
async function restoredOutboundRowsMatch(expected:GoodsStock[],current:GoodsStock[],stageAuditId:number,remap:<T>(s:string)=>T){
 const db=getDb(),[audits,operations]=await db.batch([db.select().from(auditLogs).where(gt(auditLogs.id,stageAuditId)).orderBy(asc(auditLogs.id)),db.select().from(goodsOperations)]);
 const images=new Map(expected.map(r=>[r.id,r])),byOperation=new Map(operations.map(o=>[o.id,o]));
 const decode=(raw:string|null)=>{if(!raw)return[];const v=remap<{schema?:string;rows?:GoodsStock[];id?:number}>(raw);return v.schema==='goods-operation-v1'&&Array.isArray(v.rows)?v.rows:[];};
 for(const audit of audits){
  const before=decode(audit.beforeSnapshot),after=decode(audit.afterSnapshot),affected=[...new Set([...before,...after].map(s=>s.id))].filter(id=>images.has(id));if(!affected.length)continue;
  if(audit.action==='出库'){
   const op=audit.operationId?byOperation.get(audit.operationId):undefined;
   if(!op||op.kind!=='outbound'||!op.restoredAt||op.createdAt!==audit.createdAt||JSON.stringify(remap(op.beforeRows))!==JSON.stringify(before)||JSON.stringify(remap(op.afterRows))!==JSON.stringify(after))return false;
  }else if(audit.action==='恢复'){
   const source=audits.find(a=>String(a.id)===audit.entityId&&a.action==='出库'),op=source?.operationId?byOperation.get(source.operationId):undefined;
   if(!source||!op||op.kind!=='outbound'||op.restoredAt!==audit.createdAt||audit.operationId!==`restore:audit:${source.id}`)return false;
   const original=remap<GoodsStock[]>(op.beforeRows);
   for(const id of affected){const b=before.find(r=>r.id===id),a=after.find(r=>r.id===id),o=original.find(r=>r.id===id);if(!b||!a||!o||a.version!==b.version+1||a.updatedAt!==audit.createdAt||a.updatedBy!==audit.userName||!businessSame(a,o))return false;}
  }else return false;
  for(const id of affected){const b=before.find(r=>r.id===id),a=after.find(r=>r.id===id);if(!b||!a||!same(images.get(id),b))return false;images.set(id,a);}
 }
 return current.every(r=>same(images.get(r.id),r));
}
export async function restoreGoodsStagingOperation(op:typeof goodsOperations.$inferSelect,log:{id:number},user:PermissionUser&{id:number;displayName:string}){try{
 assertGoodsRestorePermission(op,user);if(op.restoredAt)throw new GoodsFlowError('这次移库待出库已撤销');validateStagingOperation(op);
 const aliases=await loadLocationAliases(),remap=<T,>(raw:string)=>JSON.parse(remapSnapshotLocations(raw,aliases)??raw) as T;
 const beforeState=remap<GoodsState>(op.beforeCategory!),afterState=remap<GoodsState>(op.afterCategory),before=remap<GoodsStock[]>(op.beforeRows),after=remap<GoodsStock[]>(op.afterRows),context=await loadGoodsContext(),result=JSON.parse(op.result);
 if(context.associationValue!==result.associationValue)throw new GoodsFlowError('备货后的产品关联已有变化，请先核对后再撤销');
 if(stateImage(context.state)!==stateImage(afterState))throw new GoodsFlowError('移库待出库后已有其他库存或计价变化，请先核对并撤销后续操作');
 const current=after.map(s=>context.rows.find(r=>r.id===s.id));if(current.some(r=>!r))throw new GoodsFlowError('备货记录已删除或移动，不能直接撤销');
 if(!after.every((s,i)=>same(current[i],s))&&!await restoredOutboundRowsMatch(after,current as GoodsStock[],log.id,remap))throw new GoodsFlowError('备货后已有编辑、有效出库或无法验证的变化，不能直接撤销');
 const stamp=new Date().toISOString(),id=`restore:audit:${log.id}`,restored=before.map(r=>({...r,version:context.rows.find(s=>s.id===r.id)!.version+1,updatedAt:stamp,updatedBy:user.displayName}));
 await env.DB.batch([goodsGuard(context,id,{rows:context.rows,highId:Math.max(0,...context.rows.map(r=>r.id)),association:true}),env.DB.prepare('INSERT INTO goods_transaction_guards(id,valid) VALUES (?,CASE WHEN EXISTS(SELECT 1 FROM goods_operations WHERE id=? AND restored_at IS NULL AND result=?) THEN 1 ELSE 0 END)').bind(id+':staging',op.id,op.result),...after.map(s=>env.DB.prepare('DELETE FROM stocks WHERE id=?').bind(s.id)),...restored.map(goodsStockInsert),...goodsPalletModeWrites(restored),goodsStateUpdate(beforeState),env.DB.prepare('UPDATE goods_operations SET restored_at=? WHERE id=?').bind(stamp,op.id),env.DB.prepare('INSERT INTO audit_logs(user_id,user_name,action,entity_type,entity_id,operation_id,summary,before_snapshot,after_snapshot,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').bind(user.id,user.displayName,'恢复','原记录',String(log.id),id,`撤销原记录 ${log.id}｜移库待出库恢复｜原库位数量与原计价批次恢复，不改历史费用`,JSON.stringify({schema:'goods-operation-v1',rows:current}),JSON.stringify({schema:'goods-operation-v1',rows:restored}),stamp),goodsFinish(id+':staging'),goodsFinish(id)]);
 return Response.json({ok:true});
}catch(e){return goodsResponseError(e);}}
