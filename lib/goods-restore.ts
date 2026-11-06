import {rawCartonRow} from './carton-pallets';
import { env } from "cloudflare:workers";
import { eq,inArray } from "drizzle-orm";
import { getDb } from "../db";
import { goodsOperations,storageFeeSettlements } from "../db/schema";
import { GoodsFlowError,type GoodsCategory,type GoodsStock } from "./goods-flow";
import { goodsPalletModeWrites,goodsFinish,goodsGuard,goodsResponseError,goodsStateUpdate,goodsStockInsert,loadGoodsContext } from "./goods-store";
import { loadLocationAliases } from "./location-alias-store";
import { remapSnapshotLocations } from "./location-aliases";
import {assertGoodsSkuAvailable} from './goods-sku';
import {restoreGoodsIdentityOperation} from './goods-identity-restore';
import {type PermissionUser} from './permissions';
import {assertGoodsRestorePermission} from './goods-operation-permissions';
import {cartonReceipts} from '../db/schema';
import {cartonGuard,cartonView} from './carton-store';
import {remapCartonRowSnapshot} from './carton-location';
import {stockProductDetails} from './stock-product';
import {restoreGoodsStagingOperation} from './goods-staging-restore';

const palletProjectionFields=new Set(['palletManual','palletAutomatic','palletRawCount','palletRawLabel']);
const sameStock=(actual:GoodsStock|undefined,expected:GoodsStock)=>!!actual&&Object.entries(expected).every(([key,value])=>{
  // Automatic shares may regroup without a physical write; undo checks their original stored values.
  if(palletProjectionFields.has(key))return true;
  if(key==='palletCount')return (actual.palletRawCount??actual.palletCount)===(expected.palletRawCount??value);
  if(key==='palletLabel')return (actual.palletRawLabel??actual.palletLabel)===(expected.palletRawLabel??value);
  return actual[key as keyof GoodsStock]===value;
});


/** A later line's real undo can restore an earlier line's data with newer metadata. */
async function documentUndoRowsMatch(op:typeof goodsOperations.$inferSelect,expected:GoodsStock[],current:(GoodsStock|undefined)[],remap:<T>(raw:string)=>T){
  const documentId=(JSON.parse(op.result) as {documentId?:string}).documentId;
  if(op.kind!=='outbound'||!documentId||current.some(r=>!r))return false;
  const db=getDb(),[document]=await db.select().from(goodsOperations).where(eq(goodsOperations.id,documentId));
  if(!document||document.kind!=='document')return false;
  const result=JSON.parse(document.result) as {mode?:string;operationIds?:string[]},ids=result.operationIds;
  if(result.mode!=='outbound'||!Array.isArray(ids)||ids.some(id=>typeof id!=='string')||new Set(ids).size!==ids.length)return false;
  const index=ids.indexOf(op.id);if(index<0)return false;
  const laterIds=ids.slice(index+1);if(!laterIds.length)return false;
  const later=await db.select().from(goodsOperations).where(inArray(goodsOperations.id,laterIds));
  if(later.length!==laterIds.length)return false;
  const successors=laterIds.map(id=>later.find(row=>row.id===id)!).filter(row=>row.categoryId===op.categoryId);
  let category=remap<GoodsCategory>(op.afterCategory);
  for(const successor of successors){
    if(successor.kind!=='outbound'||!successor.restoredAt||(JSON.parse(successor.result) as {documentId?:string}).documentId!==documentId||!successor.beforeCategory||JSON.stringify(remap<GoodsCategory>(successor.beforeCategory))!==JSON.stringify(category))return false;
    category=remap<GoodsCategory>(successor.afterCategory);
  }
  for(const [rowIndex,row] of expected.entries()){
    if(sameStock(current[rowIndex],row))continue;
    // The first later write to this row must start at the exact original image.
    const successor=successors.find(next=>remap<GoodsStock[]>(next.beforeRows).some(r=>r.id===row.id));
    if(!successor||!sameStock(remap<GoodsStock[]>(successor.beforeRows).find(r=>r.id===row.id),row))return false;
    const audit=await env.DB.prepare("SELECT undo.before_snapshot,undo.after_snapshot,undo.created_at,undo.user_name FROM audit_logs source JOIN audit_logs undo ON undo.operation_id=('restore:audit:'||source.id) AND undo.action='恢复' AND undo.entity_id=CAST(source.id AS TEXT) WHERE source.operation_id=? AND source.action='出库'").bind(successor.id).first<{before_snapshot:string;after_snapshot:string;created_at:string;user_name:string}>();
    if(!audit||audit.created_at!==successor.restoredAt)return false;
    const before=remap<{schema:string;rows:GoodsStock[]}>(audit.before_snapshot),after=remap<{schema:string;rows:GoodsStock[]}>(audit.after_snapshot);
    if(before.schema!=='goods-operation-v1'||after.schema!=='goods-operation-v1'||!Array.isArray(before.rows)||!Array.isArray(after.rows))return false;
    const undoBefore=before.rows.find(r=>r.id===row.id),undoAfter=after.rows.find(r=>r.id===row.id);
    if(!undoBefore||!undoAfter||!sameStock(current[rowIndex],undoAfter)||undoAfter.version!==undoBefore.version+1||undoAfter.updatedAt!==audit.created_at||undoAfter.updatedBy!==audit.user_name||!sameStock({...undoAfter,version:row.version,updatedAt:row.updatedAt,updatedBy:row.updatedBy},row))return false;
  }
  return true;
}

/** Return null for legacy records; otherwise restore all physical and FIFO changes atomically. */
export async function restoreGoodsOperation(log:{id:number;operationId:string|null;action:string},user:PermissionUser&{id:number;displayName:string}){
  if(!log.operationId)return null;const db=getDb(),[op]=await db.select().from(goodsOperations).where(eq(goodsOperations.id,log.operationId));if(!op)return null;
  try{
    if(JSON.parse(op.fingerprint).merchantChangeId)throw new GoodsFlowError('这是商家整批调整的一部分，请在“商家合并／批量更换”中撤销整次调整',409);
    assertGoodsRestorePermission(op,user);
    if(op.kind==='staging')return restoreGoodsStagingOperation(op,log,user);
    if(op.kind==='identity'||op.kind==='correction')return restoreGoodsIdentityOperation(op,log,user);
    if(op.restoredAt)throw new GoodsFlowError("该货物操作已经撤销");if(!["inbound","outbound","sku","spec","convert"].includes(op.kind))throw new GoodsFlowError("该货物操作不能从出入库记录撤销",400);
    const aliases=await loadLocationAliases(),remap=<T,>(raw:string)=>JSON.parse(remapSnapshotLocations(raw,aliases)??raw) as T;
    const context=await loadGoodsContext(),storedCurrent=context.state.categories.find(c=>c.id===op.categoryId),currentCategory=storedCurrent?remap<GoodsCategory>(JSON.stringify(storedCurrent)):undefined,afterCategory=remap<GoodsCategory>(op.afterCategory),beforeCategory=op.beforeCategory?remap<GoodsCategory>(op.beforeCategory):null;
    if(JSON.stringify(currentCategory)!==JSON.stringify(afterCategory))throw new GoodsFlowError("该货物在原操作后已有入出库或资料变化，不能直接恢复，请核对后处理");
    const beforeRows=remap<GoodsStock[]>(op.beforeRows),afterRows=remap<GoodsStock[]>(op.afterRows),currentRows=afterRows.map(r=>context.rows.find(x=>x.id===r.id));
    if(currentRows.some((r,i)=>!sameStock(r,afterRows[i]))&&!await documentUndoRowsMatch(op,afterRows,currentRows,remap))throw new GoodsFlowError("原操作后的库位记录已发生变化，不能直接恢复");
    const skuResult=op.kind==='sku'?JSON.parse(op.result) as {beforeAssociationValue:string|null;afterAssociationValue:string|null}:null;
    if(skuResult){
      if(context.associationValue!==skuResult.afterAssociationValue)throw new GoodsFlowError('SKU 修改后人工关联已变化，不能直接恢复');
      // A manually linked product can have several original SKUs, including blank members.
      // Check every identity being restored; checking only the category summary can miss a collision.
      const originals=[...beforeRows.map(r=>({sku:r.sku,product:stockProductDetails(r).name,customerName:r.customerName})),...(beforeCategory?[beforeCategory]:[])];
      for(const original of originals)assertGoodsSkuAvailable(context.rows,context.state,{id:op.categoryId,product:original.product,customerName:original.customerName,stockIds:afterCategory.stockIds},original.sku);
    }
    const operationIds=JSON.parse(op.settlementIds) as string[],settlements=operationIds.length?await db.select().from(storageFeeSettlements).where(inArray(storageFeeSettlements.operationId,operationIds)):[];
    if(settlements.length!==operationIds.length||settlements.some(s=>s.inboundSource==="return"&&!['pending','cancelled'].includes(s.settlementStatus)))throw new GoodsFlowError("原出库费用已确认或记录不完整，不能直接恢复库存，请先核对账单");
    const stamp=new Date().toISOString(),id=`restore:audit:${log.id}`,restored=beforeRows.map(r=>({...r,updatedBy:user.displayName,updatedAt:stamp,version:currentRows.find(a=>a?.id===r.id)!.version+1})),state={categories:context.state.categories.filter(c=>c.id!==op.categoryId)};
    if(beforeCategory)state.categories.push(beforeCategory);
    const settlementGuard=env.DB.prepare("INSERT INTO goods_transaction_guards(id,valid) VALUES (?,CASE WHEN NOT EXISTS(SELECT 1 FROM json_each(?) j LEFT JOIN storage_fee_settlements s ON s.id=json_extract(j.value,'$.id') WHERE s.id IS NULL OR s.version<>json_extract(j.value,'$.version') OR s.settlement_status<>json_extract(j.value,'$.status')) THEN 1 ELSE 0 END)").bind(`${id}:fees`,JSON.stringify(settlements.map(s=>({id:s.id,version:s.version,status:s.settlementStatus}))));
    const conversion=op.kind==='convert'?(JSON.parse(op.result) as {cartonConversion:{before:typeof cartonReceipts.$inferSelect;after:typeof cartonReceipts.$inferSelect}}).cartonConversion:null;
    const cartonUpdates=[];
    if(conversion){
      conversion.before=JSON.parse(remapCartonRowSnapshot(JSON.stringify(conversion.before),aliases)!);conversion.after=JSON.parse(remapCartonRowSnapshot(JSON.stringify(conversion.after),aliases)!);
      const [current]=await db.select().from(cartonReceipts).where(eq(cartonReceipts.id,conversion.after.id));
      if(!current||JSON.stringify(current)!==JSON.stringify(conversion.after))throw new GoodsFlowError('原箱库存已有后续变更，不能撤销转换',409);
      conversion.before=rawCartonRow(conversion.before);
      const originalPlacements=JSON.parse(conversion.before.placements) as {locationCode:string;boxes:number}[];
      for(const placement of originalPlacements.filter(p=>p.boxes>0)){const row=afterRows.find(r=>r.locationCode===placement.locationCode);if(!row)throw new GoodsFlowError('原库位已变化，请先核对后再撤销转换',409);}
      const cartonRestored={...current,placements:conversion.before.placements,version:current.version+1,updatedBy:user.id,updatedAt:stamp},cartonRestoreId=crypto.randomUUID();
      cartonUpdates.push(cartonGuard(id,current),env.DB.prepare('INSERT INTO carton_operations(id,receipt_id,kind,fingerprint,before_snapshot,after_snapshot,result,user_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(cartonRestoreId,current.id,'restore',JSON.stringify({requestId:cartonRestoreId,operationId:op.id}),JSON.stringify(current),JSON.stringify(cartonRestored),JSON.stringify({ok:true,operationId:cartonRestoreId,receipt:cartonView(cartonRestored)}),user.id,stamp),env.DB.prepare('UPDATE carton_receipts SET placements=?,version=?,updated_by=?,updated_at=? WHERE id=?').bind(conversion.before.placements,current.version+1,user.id,stamp,current.id),env.DB.prepare('UPDATE carton_operations SET restored_at=? WHERE id=? AND restored_at IS NULL').bind(stamp,op.id),env.DB.prepare('DELETE FROM carton_transaction_guards WHERE id=?').bind(id));
    }
    const documentId=(JSON.parse(op.result) as {documentId?:string}).documentId;
    const documentUpdates=documentId?[env.DB.prepare("UPDATE goods_operations SET restored_at=? WHERE id=? AND kind='document'").bind(stamp,documentId)]:[];
    const deletes=afterRows.map(r=>env.DB.prepare("DELETE FROM stocks WHERE id=?").bind(r.id));
    const associationRestore=skuResult&&skuResult.beforeAssociationValue!==skuResult.afterAssociationValue?[env.DB.prepare("UPDATE settings SET value=?,updated_at=? WHERE key='inventory_associations_v1'").bind(skuResult.beforeAssociationValue,stamp)]:[];
    await env.DB.batch([goodsGuard(context,id,skuResult?{rows:context.rows,highId:Math.max(0,...context.rows.map(r=>r.id)),association:true}:{rows:currentRows as GoodsStock[]}),settlementGuard,env.DB.prepare("INSERT INTO goods_transaction_guards(id,valid) VALUES (?,CASE WHEN EXISTS(SELECT 1 FROM goods_operations WHERE id=? AND restored_at IS NULL) THEN 1 ELSE 0 END)").bind(`${id}:operation`,op.id),...deletes,...restored.map(goodsStockInsert),...goodsPalletModeWrites(restored),env.DB.prepare("DELETE FROM storage_fee_settlements WHERE operation_id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(operationIds)),goodsStateUpdate(state),...associationRestore,...documentUpdates,...cartonUpdates,env.DB.prepare("UPDATE goods_operations SET restored_at=? WHERE id=?").bind(stamp,op.id),env.DB.prepare("INSERT INTO audit_logs(user_id,user_name,action,entity_type,entity_id,operation_id,summary,before_snapshot,after_snapshot,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(user.id,user.displayName,"恢复","原记录",String(log.id),id,`恢复原记录 ${log.id}｜${op.kind==='sku'?'产品 SKU':op.kind==='spec'?'产品尺寸资料':op.kind==='convert'?'箱转产品':`货物${op.kind==='inbound'?'入库':'出库'}`}精确回退｜${afterCategory.product}｜${op.kind==='spec'?'产品规格恢复，原库位和计价批次保持原值':'实物库存与计价批次一并恢复'}`,JSON.stringify({schema:"goods-operation-v1",rows:currentRows}),JSON.stringify({schema:"goods-operation-v1",rows:restored}),stamp),goodsFinish(`${id}:fees`),goodsFinish(`${id}:operation`),goodsFinish(id)]);
    return Response.json({ok:true});
  }catch(e){return goodsResponseError(e);}
}
