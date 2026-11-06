import {goodsPalletModeWrites} from '../../../lib/goods-store';
import {warehouseTodayDate} from '../../../lib/warehouse-time';
import {cartonUndoStates,restoreCartonAudit} from '../../../lib/carton-store';
import {readRecordFilters} from "../../../lib/record-filters";
import {auditFilterOptions,auditRecordConditions,auditLocationCondition} from "../../../lib/audit-record-filters";
import { goodsInventoryWritePlan } from "../../../lib/goods-inventory-guard";
import { restoreGoodsOperation } from "../../../lib/goods-restore";
import {assertGoodsRestorePermission} from '../../../lib/goods-operation-permissions';
import { GoodsFlowError } from "../../../lib/goods-flow";
import {assertStockInventoryUnit} from '../../../lib/inventory-unit';
import { goodsResponseError } from "../../../lib/goods-store";
import { loadLocationAliases } from "../../../lib/location-alias-store";
import { isLocationRenameConflict, resolveLocationAlias, remapSnapshotLocations } from "../../../lib/location-aliases";
import { env } from "cloudflare:workers";
import { and,count,desc,eq,inArray,or,sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { getDb } from "../../../db";
import { auditLogs,stocks,storageFeeSettlements,goodsOperations,settings } from "../../../db/schema";
import {stockStoredImage} from '../../../lib/stock-pallets';
import { requireUser, requireWriteUser } from "../../../lib/auth";
import { redactMovementSnapshotPricing } from "../../../lib/movement-display";
import { palletLabel,parsePalletValue } from "../../../lib/pallet";
import { hasPermission, type Permission } from "../../../lib/permissions";
import { createSyncReader } from "../../../lib/warehouse-sync-read";
import { makeTransferEnvelope,matchesStockSnapshot,parseTransferEnvelope } from "../../../lib/stock-transfer";

const batchTuple=(queries:BatchItem<"sqlite">[])=>queries as [BatchItem<"sqlite">,...BatchItem<"sqlite">[]];
type StockRow=import('../../../lib/stock-transfer').StockRow;
type SettlementRow=typeof storageFeeSettlements.$inferSelect;

const restorableSettlementCondition=(row:SettlementRow)=>and(
  eq(storageFeeSettlements.id,row.id),
  eq(storageFeeSettlements.version,row.version),
  row.inboundSource==="return"
    ? inArray(storageFeeSettlements.settlementStatus,["pending","cancelled"])
    : eq(storageFeeSettlements.settlementStatus,row.settlementStatus),
);
const guardedRestoreAuditUserId=(row:SettlementRow|undefined,userId:number)=>row
  ? sql<number>`CASE WHEN NOT EXISTS (
      SELECT 1 FROM ${storageFeeSettlements} WHERE ${storageFeeSettlements.id} = ${row.id}
    ) THEN ${userId} ELSE NULL END`
  : userId;
const drizzleBatchHasRow=(result:unknown)=>Array.isArray(result)&&result.length>0;

const snapshotFields=(row:StockRow)=>({
  id:row.id,locationCode:row.locationCode,inboundDate:row.inboundDate,product:row.product,productPrefix:row.productPrefix??"",productCondition:row.productCondition??"",inventoryUnit:row.inventoryUnit??"item",inventoryReviewDecision:row.inventoryReviewDecision??"",sku:row.sku??"",fnsku:row.fnsku??"",barcode:row.barcode,
  inboundOrder:row.inboundOrder,totalQuantity:row.totalQuantity,totalBoxes:row.totalBoxes,customerName:row.customerName,
  palletCount:row.palletCount,palletLabel:row.palletLabel,layerCount:row.layerCount,inboundSource:row.inboundSource,
  billingMode:row.billingMode,itemVolumeM3:row.itemVolumeM3,boxVolumeM3:row.boxVolumeM3,
  storageRateUsd:row.storageRateUsd,freeDays:row.freeDays,catalogItemId:row.catalogItemId,note:row.note,
  updatedBy:row.updatedBy,updatedAt:row.updatedAt,version:row.version,
});
const serializeSnapshot=(row:StockRow|null)=>JSON.stringify(row? snapshotFields(row):null);
const parseSnapshot=(raw:string|null):StockRow|null|undefined=>{
  if(raw===null)return undefined;
  try{
    const value=JSON.parse(raw) as Partial<StockRow>|null;
    if(value===null)return null;
    if(!value||typeof value!=="object")return undefined;
    const stringKeys=["locationCode","inboundDate","product","barcode","inboundOrder","customerName","palletLabel","inboundSource","billingMode","note","updatedBy","updatedAt"] as const;
    const numberKeys=["id","totalQuantity","totalBoxes","palletCount","layerCount","itemVolumeM3","boxVolumeM3","storageRateUsd","freeDays","version"] as const;
    const integerKeys=["id","totalQuantity","totalBoxes","layerCount","freeDays","version"] as const;
    if((value.sku!==undefined&&typeof value.sku!=="string")||(value.fnsku!==undefined&&typeof value.fnsku!=="string"))return undefined;
    if(!stringKeys.every(key=>typeof value[key]==="string")||!numberKeys.every(key=>typeof value[key]==="number"&&Number.isFinite(value[key]))||!integerKeys.every(key=>Number.isInteger(value[key]))||(value.catalogItemId!==null&&!Number.isInteger(value.catalogItemId)))return undefined;
    return value as StockRow;
  }catch{return undefined;}
};
const sameNumber=(left:number,right:number)=>Number.isFinite(left)&&Number.isFinite(right)&&Math.abs(left-right)<1e-9;
const matchesSnapshot=(current:StockRow,expected:StockRow)=>{
  const left=snapshotFields(stockStoredImage(current)),right=snapshotFields(stockStoredImage(expected));
  return (Object.keys(left) as (keyof typeof left)[]).every(key=>{
    const a=left[key],b=right[key];
    return typeof a==="number"&&typeof b==="number"?sameNumber(a,b):a===b;
  });
};
const restoreValues=(snapshot:StockRow,userName:string,stamp:string,version:number)=>({
  locationCode:snapshot.locationCode,inboundDate:snapshot.inboundDate,product:snapshot.product,productPrefix:snapshot.productPrefix??"",productCondition:snapshot.productCondition??"",inventoryUnit:snapshot.inventoryUnit??"item",inventoryReviewDecision:snapshot.inventoryReviewDecision??"",sku:snapshot.sku??"",fnsku:snapshot.fnsku??"",barcode:snapshot.barcode,
  inboundOrder:snapshot.inboundOrder,totalQuantity:snapshot.totalQuantity,totalBoxes:snapshot.totalBoxes,
  customerName:snapshot.customerName,palletCount:snapshot.palletAutomatic?snapshot.palletRawCount??1:snapshot.palletCount,palletLabel:snapshot.palletAutomatic?snapshot.palletRawLabel??snapshot.palletLabel:snapshot.palletLabel,
  layerCount:snapshot.layerCount,inboundSource:snapshot.inboundSource,billingMode:snapshot.billingMode,
  itemVolumeM3:snapshot.itemVolumeM3,boxVolumeM3:snapshot.boxVolumeM3,storageRateUsd:snapshot.storageRateUsd,
  freeDays:snapshot.freeDays,catalogItemId:snapshot.catalogItemId,note:snapshot.note,
  updatedBy:userName,updatedAt:stamp,version,
});
const restoreOperationId=(auditId:number)=>`restore:audit:${auditId}`;
const isRestoreDuplicate=(error:unknown)=>/audit_logs_operation_id_idx|audit_logs\.operation_id|UNIQUE constraint failed/i.test(String(error));
const hasBatchRow=(result:unknown)=>!!(result&&typeof result==="object"&&Array.isArray((result as {results?:unknown[]}).results)&&(result as {results:unknown[]}).results[0]);
const restoreSql=(extra="")=>`UPDATE stocks SET
  location_code=?,inbound_date=?,product=?,product_prefix=?,product_condition=?,sku=?,fnsku=?,barcode=?,inbound_order=?,total_quantity=?,total_boxes=?,customer_name=?,
  pallet_count=?,pallet_label=?,layer_count=?,inbound_source=?,billing_mode=?,item_volume_m3=?,box_volume_m3=?,
  storage_rate_usd=?,free_days=?,catalog_item_id=?,note=?,updated_by=?,updated_at=?,version=?,inventory_unit=?,inventory_review_decision=?
  WHERE id=? AND version=? AND updated_at=? AND location_code=? ${extra}
  RETURNING id`;
const restoreBindings=(snapshot:StockRow,userName:string,stamp:string,version:number):(string|number|null)[]=>[
  snapshot.locationCode,snapshot.inboundDate,snapshot.product,snapshot.productPrefix??"",snapshot.productCondition??"",snapshot.sku??"",snapshot.fnsku??"",snapshot.barcode,snapshot.inboundOrder,
  snapshot.totalQuantity,snapshot.totalBoxes,snapshot.customerName,(snapshot.palletAutomatic?snapshot.palletRawCount??1:snapshot.palletCount),(snapshot.palletAutomatic?snapshot.palletRawLabel??snapshot.palletLabel:snapshot.palletLabel),
  snapshot.layerCount,snapshot.inboundSource,snapshot.billingMode,snapshot.itemVolumeM3,snapshot.boxVolumeM3,
  snapshot.storageRateUsd,snapshot.freeDays,snapshot.catalogItemId,snapshot.note,userName,stamp,version,snapshot.inventoryUnit??"item",snapshot.inventoryReviewDecision??"",
];

async function restoreTransferLog(log:typeof auditLogs.$inferSelect,user:{id:number;displayName:string}){
  const beforeEnvelope=parseTransferEnvelope(log.beforeSnapshot),afterEnvelope=parseTransferEnvelope(log.afterSnapshot);
  if(!beforeEnvelope||!afterEnvelope||beforeEnvelope.operationId!==afterEnvelope.operationId||beforeEnvelope.mode!==afterEnvelope.mode||beforeEnvelope.sourceLocation!==afterEnvelope.sourceLocation||beforeEnvelope.targetLocation!==afterEnvelope.targetLocation){
    return Response.json({error:"该移库记录的恢复快照不完整，请联系管理员"},{status:409});
  }
  if(beforeEnvelope.rows.length!==1)return Response.json({error:"该移库记录的原始快照不完整，请联系管理员"},{status:409});
  const original=beforeEnvelope.rows[0],operationId=restoreOperationId(log.id),stamp=new Date().toISOString(),db=getDb();
  const rows=await db.select().from(stocks).where(inArray(stocks.id,afterEnvelope.rows.map(row=>row.id)));
  const currentById=new Map(rows.map(row=>[row.id,row]));
  if(afterEnvelope.rows.some(expected=>{const current=currentById.get(expected.id);return !current||!matchesStockSnapshot(current,expected)})){
    return Response.json({error:"移库后的货物已经发生变化，不能直接恢复"},{status:409});
  }
  const sourceExpected=afterEnvelope.rows.find(row=>row.id===original.id);
  if(!sourceExpected)return Response.json({error:"该移库记录的来源快照不完整，请联系管理员"},{status:409});
  const sourceCurrent=currentById.get(sourceExpected.id)!;
  const restoredSource={...original,...restoreValues(original,user.displayName,stamp,sourceCurrent.version+1)} satisfies StockRow;
  const restoreBefore=makeTransferEnvelope({operationId,mode:afterEnvelope.mode,sourceLocation:afterEnvelope.sourceLocation,targetLocation:afterEnvelope.targetLocation,rows:afterEnvelope.rows});
  const restoreAfter=makeTransferEnvelope({operationId,mode:afterEnvelope.mode,sourceLocation:afterEnvelope.sourceLocation,targetLocation:afterEnvelope.targetLocation,rows:[restoredSource]});
  const summary=`恢复原记录 ${log.id}｜移库精确回退｜${original.product}｜${afterEnvelope.targetLocation} → ${afterEnvelope.sourceLocation}｜数量 ${original.totalQuantity-sourceExpected.totalQuantity>=0?"+":""}${original.totalQuantity-sourceExpected.totalQuantity}｜箱数 ${original.totalBoxes-sourceExpected.totalBoxes>=0?"+":""}${original.totalBoxes-sourceExpected.totalBoxes}｜托盘 ${palletLabel(original.palletCount-sourceExpected.palletCount)}`;

  if(afterEnvelope.mode==="all"){
    if(afterEnvelope.rows.length!==1||sourceExpected.locationCode!==afterEnvelope.targetLocation){
      return Response.json({error:"该整批移库记录的快照不完整，请联系管理员"},{status:409});
    }
    const goods=await goodsInventoryWritePlan([{before:sourceCurrent,after:restoredSource}],"move");
    const results=await env.DB.batch([
      ...goods.guard,
      env.DB.prepare(restoreSql()).bind(
        ...restoreBindings(original,user.displayName,stamp,sourceCurrent.version+1),
        sourceCurrent.id,sourceCurrent.version,sourceCurrent.updatedAt,sourceCurrent.locationCode,
      ),
      env.DB.prepare(`INSERT INTO audit_logs
        (user_id,user_name,action,entity_type,entity_id,operation_id,summary,before_snapshot,after_snapshot,created_at)
        SELECT ?,?,?,?,?,?,?,?,?,?
        FROM stocks WHERE id=? AND version=? AND updated_at=? AND location_code=?
        RETURNING id`).bind(
        user.id,user.displayName,"恢复","原记录",String(log.id),operationId,summary,
        JSON.stringify(restoreBefore),JSON.stringify(restoreAfter),stamp,
        restoredSource.id,restoredSource.version,stamp,restoredSource.locationCode,
      ),
      ...goodsPalletModeWrites([restoredSource]),...goods.afterQueries,
    ]);
    if(!hasBatchRow(results[goods.guard.length])||!hasBatchRow(results[goods.guard.length+1]))return Response.json({error:"移库后的货物刚刚发生变化，不能直接恢复"},{status:409});
    return Response.json({ok:true});
  }

  if(afterEnvelope.mode!=="partial"||afterEnvelope.rows.length!==2){
    return Response.json({error:"该部分移库记录的快照不完整，请联系管理员"},{status:409});
  }
  const destinationExpected=afterEnvelope.rows.find(row=>row.id!==original.id);
  if(!destinationExpected||destinationExpected.locationCode!==afterEnvelope.targetLocation||sourceExpected.locationCode!==afterEnvelope.sourceLocation){
    return Response.json({error:"该部分移库记录的目标快照不完整，请联系管理员"},{status:409});
  }
  const destinationCurrent=currentById.get(destinationExpected.id)!;
  const goods=await goodsInventoryWritePlan([{before:sourceCurrent,after:restoredSource},{before:destinationCurrent,after:null}],"move");
  const results=await env.DB.batch([
    ...goods.guard,
    env.DB.prepare(restoreSql(`AND EXISTS (
      SELECT 1 FROM stocks WHERE id=? AND version=? AND updated_at=? AND location_code=?
    )`)).bind(
      ...restoreBindings(original,user.displayName,stamp,sourceCurrent.version+1),
      sourceCurrent.id,sourceCurrent.version,sourceCurrent.updatedAt,sourceCurrent.locationCode,
      destinationCurrent.id,destinationCurrent.version,destinationCurrent.updatedAt,destinationCurrent.locationCode,
    ),
    env.DB.prepare(`DELETE FROM stocks
      WHERE id=? AND version=? AND updated_at=? AND location_code=?
        AND EXISTS (SELECT 1 FROM stocks WHERE id=? AND version=? AND updated_at=? AND location_code=?)
      RETURNING id`).bind(
      destinationCurrent.id,destinationCurrent.version,destinationCurrent.updatedAt,destinationCurrent.locationCode,
      restoredSource.id,restoredSource.version,stamp,restoredSource.locationCode,
    ),
    env.DB.prepare(`INSERT INTO audit_logs
      (user_id,user_name,action,entity_type,entity_id,operation_id,summary,before_snapshot,after_snapshot,created_at)
      SELECT ?,?,?,?,?,?,?,?,?,?
      FROM stocks
      WHERE id=? AND version=? AND updated_at=? AND location_code=?
        AND NOT EXISTS (SELECT 1 FROM stocks WHERE id=?)
      RETURNING id`).bind(
      user.id,user.displayName,"恢复","原记录",String(log.id),operationId,summary,
      JSON.stringify(restoreBefore),JSON.stringify(restoreAfter),stamp,
      restoredSource.id,restoredSource.version,stamp,restoredSource.locationCode,destinationCurrent.id,
    ),
    ...goodsPalletModeWrites([restoredSource]),...goods.afterQueries,
  ]);
  if(!hasBatchRow(results[goods.guard.length])||!hasBatchRow(results[goods.guard.length+1])||!hasBatchRow(results[goods.guard.length+2]))return Response.json({error:"移库后的货物刚刚发生变化，不能直接恢复"},{status:409});
  return Response.json({ok:true});
}

export async function GET(req:Request){
  const a=await requireUser(req,"records.view");if(a.error)return a.error;
  if(new URL(req.url).searchParams.get("latest")==="1"){
    const reader=createSyncReader(env.DB);
    return Response.json(await reader.recent(a.user!),{headers:{"Cache-Control":"private, no-store"}});
  }
  const params=new URL(req.url).searchParams;let f;try{f=readRecordFilters(params);}catch(e){return Response.json({error:e instanceof Error?e.message:'筛选无效'},{status:400});}
  const location=f.location,page=Math.max(1,Math.floor(Number(params.get("page"))||1)),pageSize=Math.max(1,Math.min(100,Math.floor(Number(params.get("pageSize")||params.get("limit"))||50))),operationsOnly=params.get("operationsOnly")==="1",types=inArray(auditLogs.action,operationsOnly?["入库","出库","移库","箱件收货","箱件出库"]:["入库","出库","移库","库存修改","删除","恢复","箱件收货","箱件出库","箱件认领改单","箱件删除","撤销箱件操作"]);
  const locationFilter=await auditLocationCondition(location);
  const reverted=sql`(${auditLogs.action} IN ('恢复','撤销箱件操作') OR EXISTS(SELECT 1 FROM carton_operations co WHERE co.id=${auditLogs.operationId} AND co.restored_at IS NOT NULL) OR EXISTS(SELECT 1 FROM audit_logs undo WHERE undo.action='恢复' AND undo.entity_id=CAST(${auditLogs.id} AS TEXT)))`;
  const filter=and(types,locationFilter,auditRecordConditions(f),f.status==='restored'?reverted:f.status==='active'?sql`NOT ${reverted}`:undefined);
  const db=getDb(),logs=await db.select().from(auditLogs).where(filter).orderBy(desc(auditLogs.id)).limit(pageSize).offset((page-1)*pageSize),visibleLogs=hasPermission(a.user!,"pricing.manage")?logs:logs.map(log=>({...log,beforeSnapshot:redactMovementSnapshotPricing(log.beforeSnapshot),afterSnapshot:redactMovementSnapshotPricing(log.afterSnapshot)})),[{total}]=await db.select({total:count()}).from(auditLogs).where(filter),originalIds=logs.filter(x=>x.action!=="恢复").map(x=>String(x.id));
  const restored=originalIds.length?await db.select({entityId:auditLogs.entityId}).from(auditLogs).where(and(eq(auditLogs.action,"恢复"),inArray(auditLogs.entityId,originalIds))):[];
  const filterOptions=await auditFilterOptions(db,types);
  const cartonStates=await cartonUndoStates(logs,a.user!);
  const operationIds=logs.map(log=>log.operationId).filter((id):id is string=>!!id),operations=operationIds.length?await db.select().from(goodsOperations).where(inArray(goodsOperations.id,operationIds)):[];
  const goodsRestoreStates=new Map<number,{canRestore:boolean;restoreReason:string}>();for(const log of logs){const op=operations.find(op=>op.id===log.operationId);if(!op)continue;try{assertGoodsRestorePermission(op,a.user!);goodsRestoreStates.set(log.id,{canRestore:!op.restoredAt,restoreReason:op.restoredAt?'已撤销':''});}catch{goodsRestoreStates.set(log.id,{canRestore:false,restoreReason:'无撤销权限'});}}
  return Response.json({logs:visibleLogs.map(log=>({...log,...goodsRestoreStates.get(log.id),...cartonStates.get(log.id)})),filterOptions,restoredIds:restored.map(x=>Number(x.entityId)).filter(Boolean),canRestore:hasPermission(a.user!,"stock.restore"),canRestoreDeletedStocks:hasPermission(a.user!,"stock.delete"),pagination:{page,pageSize,total,totalPages:Math.max(1,Math.ceil(total/pageSize))}},{headers:{"cache-control":"private, no-store"}});
}

export async function POST(req:Request){
  try {
  const a=await requireWriteUser(req,"stock.restore");if(a.error)return a.error;
  const {id}=await req.json() as {id:number};
  const db=getDb(),[storedLog]=await db.select().from(auditLogs).where(eq(auditLogs.id,Number(id)));
  if(storedLog?.entityType==="箱件收货")return await restoreCartonAudit(storedLog,a.user!)??Response.json({error:"该箱件记录不能恢复"},{status:400});
  const aliases=await loadLocationAliases();
  const log=storedLog?{...storedLog,entityId:resolveLocationAlias(storedLog.entityId,aliases),beforeSnapshot:remapSnapshotLocations(storedLog.beforeSnapshot,aliases)??null,afterSnapshot:remapSnapshotLocations(storedLog.afterSnapshot,aliases)??null}:undefined;
  if(!log||!["入库","出库","移库","库存修改","删除"].includes(log.action))return Response.json({error:"该记录不能恢复"},{status:400});
  const actionPermission:Record<string,Permission>={"入库":"stock.inbound","出库":"stock.outbound","移库":"stock.move","库存修改":"stock.edit","删除":"stock.delete"};
  const [goodsOperation]=log.operationId?await db.select().from(goodsOperations).where(eq(goodsOperations.id,log.operationId)):[];
  if(goodsOperation)assertGoodsRestorePermission(goodsOperation,a.user!);
  else if(actionPermission[log.action]&&!hasPermission(a.user!,actionPermission[log.action]))return Response.json({error:"没有撤销该操作的权限"},{status:403});
  if(log.action==="删除"&&!hasPermission(a.user!,"stock.delete"))return Response.json({error:"没有恢复已删除货物的权限"},{status:403});
  const operationId=restoreOperationId(log.id),[done]=await db.select().from(auditLogs).where(or(and(eq(auditLogs.action,"恢复"),eq(auditLogs.entityId,String(log.id))),eq(auditLogs.operationId,operationId)));
  if(done)return Response.json({error:"该记录已经恢复过"},{status:409});
  const goodsRestored=await restoreGoodsOperation(log,a.user!);if(goodsRestored)return goodsRestored;
  if(log.action==="移库"){
    try{return await restoreTransferLog(log,a.user!);}catch(error){if(isRestoreDuplicate(error))return Response.json({error:"该记录已经恢复过"},{status:409});throw error;}
  }
  const [operationSettlement]=log.action==="出库"&&log.operationId
    ? await db.select().from(storageFeeSettlements).where(eq(storageFeeSettlements.operationId,log.operationId)).limit(1)
    : [];
  if(operationSettlement?.inboundSource==="return"&&!["pending","cancelled"].includes(operationSettlement.settlementStatus))return Response.json({error:"该退货出库费用已经结算，不能恢复库存；如需冲销请先联系管理员处理账单"},{status:409});
  const hasSnapshotEnvelope=log.beforeSnapshot!==null||log.afterSnapshot!==null;
  if(hasSnapshotEnvelope){
    const before=parseSnapshot(log.beforeSnapshot),after=parseSnapshot(log.afterSnapshot);
    if(before===undefined||after===undefined||(!before&&!after))return Response.json({error:"该记录的恢复快照不完整，请联系管理员"},{status:409});
    if(before&&after&&before.id!==after.id)return Response.json({error:"该记录的恢复快照不一致，请联系管理员"},{status:409});
    const stockId=(after||before)!.id,[current]=await db.select().from(stocks).where(eq(stocks.id,stockId)).limit(1);
    if(after===null){
      if(current)return Response.json({error:"该库存在原操作后又发生了变化，不能直接恢复"},{status:409});
    }else if(!current||!matchesSnapshot(current,after))return Response.json({error:"该库存在原操作后又发生了变化，不能直接恢复"},{status:409});
    const stamp=new Date().toISOString(),queries:BatchItem<"sqlite">[]=[],restoreBefore=current||null;
    let restored:StockRow|null=null;
    if(before===null){
      queries.push(db.delete(stocks).where(and(eq(stocks.id,current!.id),eq(stocks.version,current!.version))));
    }else if(current){
      restored={...before,...restoreValues(before,a.user!.displayName,stamp,current.version+1)};
      queries.push(db.update(stocks).set(restoreValues(before,a.user!.displayName,stamp,current.version+1)).where(and(eq(stocks.id,current.id),eq(stocks.version,current.version))));
    }else{
      restored={...before,...restoreValues(before,a.user!.displayName,stamp,before.version+1)};
      queries.push(db.insert(stocks).values({id:before.id,...restoreValues(before,a.user!.displayName,stamp,before.version+1)}));
    }
    const settlementDeleteIndex=operationSettlement
      ? queries.push(db.delete(storageFeeSettlements).where(restorableSettlementCondition(operationSettlement)).returning({id:storageFeeSettlements.id}))-1
      : -1;
    const previousQty=after?.totalQuantity||0,previousBoxes=after?.totalBoxes||0,previousPallets=after?.palletCount||0,nextQty=before?.totalQuantity||0,nextBoxes=before?.totalBoxes||0,nextPallets=before?.palletCount||0,product=before?.product||after?.product||"恢复货物";
    queries.push(db.insert(auditLogs).values({userId:guardedRestoreAuditUserId(operationSettlement,a.user!.id),userName:a.user!.displayName,action:"恢复",entityType:"原记录",entityId:String(log.id),operationId,
      summary:`恢复原记录 ${log.id}｜${log.action}精确回退｜${product}｜库位 ${before?.locationCode||after?.locationCode||log.entityId}｜数量 ${nextQty-previousQty>=0?"+":""}${nextQty-previousQty}｜箱数 ${nextBoxes-previousBoxes>=0?"+":""}${nextBoxes-previousBoxes}｜托盘 ${nextPallets-previousPallets>=0?"+":""}${palletLabel(nextPallets-previousPallets)}`,
      beforeSnapshot:serializeSnapshot(restoreBefore),afterSnapshot:serializeSnapshot(restored),createdAt:stamp}));
    const goods=await goodsInventoryWritePlan([{before:restoreBefore,after:restored}],restored?"edit":"delete",{user:a.user!});
    if(restored?.palletManual!==undefined)queries.push(db.insert(settings).values({key:'pallet_manual:stock:'+restored.id,value:JSON.stringify(restored.palletManual),updatedAt:stamp}).onConflictDoUpdate({target:settings.key,set:{value:JSON.stringify(restored.palletManual),updatedAt:stamp}}));
    try{
      const results=await db.batch(batchTuple([...goods.drizzleGuard,...queries,...goods.drizzleAfterQueries]));
      if(settlementDeleteIndex>=0&&!drizzleBatchHasRow(results[goods.drizzleGuard.length+settlementDeleteIndex]))return Response.json({error:"出库计价状态刚刚发生变化，不能恢复库存，请刷新后重试"},{status:409});
    }catch(error){if(isRestoreDuplicate(error))return Response.json({error:"该记录已经恢复过"},{status:409});if(/NOT NULL constraint failed: audit_logs\.user_id/i.test(String(error)))return Response.json({error:"出库计价状态刚刚发生变化，不能恢复库存，请刷新后重试"},{status:409});throw error;}
    return Response.json({ok:true});
  }
  const parts=log.summary.split("｜"),product=parts[0]?.trim()||"恢复货物",order=(parts.find(x=>x.trim().startsWith("单号"))||"").replace(/^单号\s*/,"").trim(),qty=Number((log.summary.match(/数量\s*([+-]?\d+)/)||[])[1]||0),boxes=Number((log.summary.match(/箱数\s*([+-]?\d+)/)||[])[1]||0),pallets=parsePalletValue((log.summary.match(/托盘\s*([+-]?\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?)/)||[])[1]||0);
  if(!qty&&!boxes&&!pallets)return Response.json({error:"旧记录缺少可恢复的数量"},{status:400});
  const candidates=await db.select().from(stocks).where(eq(stocks.locationCode,log.entityId));
  const reverseQty=-qty,reverseBoxes=-boxes,reversePallets=-pallets;
  const exactSettlement=operationSettlement;
  const feeCandidates=log.action==="出库"&&!exactSettlement?await db.select().from(storageFeeSettlements).where(eq(storageFeeSettlements.locationCode,log.entityId)).orderBy(desc(storageFeeSettlements.id)):[];
  const legacySettlement=feeCandidates.find(x=>x.product===product&&(order==="—"||!order||x.inboundOrder===order)&&x.quantity===reverseQty&&x.boxes===reverseBoxes)||feeCandidates.find(x=>x.product===product&&x.quantity===reverseQty&&x.boxes===reverseBoxes);
  const feeSettlement=exactSettlement||legacySettlement;
  if(feeSettlement?.inboundSource==="return"&&!["pending","cancelled"].includes(feeSettlement.settlementStatus))return Response.json({error:"该退货出库费用已经结算，不能恢复库存；如需冲销请先联系管理员处理账单"},{status:409});
  const [exactCurrent]=exactSettlement?await db.select().from(stocks).where(eq(stocks.id,exactSettlement.stockId)).limit(1):[];
  const current=exactSettlement?exactCurrent:(candidates.find(x=>x.product===product&&(order==="—"||!order||x.inboundOrder===order))||candidates.find(x=>x.product===product));
  const stamp=new Date().toISOString(),queries:BatchItem<"sqlite">[]=[];
  const goods=await goodsInventoryWritePlan([{before:current??null,after:null}],"outbound");
  if(current){
    const nextQty=current.totalQuantity+reverseQty,nextBoxes=current.totalBoxes+reverseBoxes,nextPallets=current.palletCount+reversePallets;
    assertStockInventoryUnit({...current,totalQuantity:nextQty});
    if(nextQty<0||nextBoxes<0||nextPallets<0)return Response.json({error:"当前库存不足，无法恢复这条入库记录"},{status:400});
    if(nextQty===0&&nextBoxes===0&&nextPallets===0)queries.push(db.delete(stocks).where(and(eq(stocks.id,current.id),eq(stocks.version,current.version))));
    else{
      const restoreSnapshot=!!feeSettlement?.stockUpdatedAtAfter&&current.updatedAt===feeSettlement.stockUpdatedAtAfter&&feeSettlement.previousInboundSource!==null&&feeSettlement.previousBillingMode!==null;
      queries.push(db.update(stocks).set({totalQuantity:nextQty,totalBoxes:nextBoxes,palletCount:nextPallets,palletLabel:palletLabel(nextPallets),
       ...(restoreSnapshot?{inboundSource:feeSettlement!.previousInboundSource!,billingMode:feeSettlement!.previousBillingMode!,itemVolumeM3:feeSettlement!.previousItemVolumeM3??0,boxVolumeM3:feeSettlement!.previousBoxVolumeM3??0,storageRateUsd:feeSettlement!.previousStorageRateUsd??0.7,freeDays:feeSettlement!.previousFreeDays??0,catalogItemId:feeSettlement!.previousCatalogItemId??null}:{}),
       updatedBy:a.user!.displayName,updatedAt:stamp,version:current.version+1}).where(and(eq(stocks.id,current.id),eq(stocks.version,current.version))));
    }
  }else{
    if(reverseQty<0||reverseBoxes<0)return Response.json({error:"对应货物已不存在，无法恢复这条入库记录"},{status:400});
    const hasPreviousSnapshot=feeSettlement?.previousInboundSource!==null&&feeSettlement?.previousInboundSource!==undefined&&feeSettlement?.previousBillingMode!==null&&feeSettlement?.previousBillingMode!==undefined;
    queries.push(db.insert(stocks).values({locationCode:resolveLocationAlias(feeSettlement?.locationCode||log.entityId,aliases),inboundDate:feeSettlement?.inboundDate||warehouseTodayDate(new Date(log.createdAt)),product:feeSettlement?.product||product,sku:feeSettlement?.sku||"",fnsku:feeSettlement?.fnsku||"",barcode:feeSettlement?.barcode||"",inboundOrder:feeSettlement?.inboundOrder||(order==="—"?"":order),totalQuantity:reverseQty,totalBoxes:reverseBoxes,customerName:feeSettlement?.customerName||"",palletCount:Math.max(0,reversePallets),palletLabel:palletLabel(Math.max(0,reversePallets)),layerCount:1,
     inboundSource:hasPreviousSnapshot?feeSettlement!.previousInboundSource!:feeSettlement?.inboundSource||"domestic",billingMode:hasPreviousSnapshot?feeSettlement!.previousBillingMode!:feeSettlement?.billingMode||"item",
     itemVolumeM3:hasPreviousSnapshot?feeSettlement!.previousItemVolumeM3??0:feeSettlement?.itemVolumeM3||0,boxVolumeM3:hasPreviousSnapshot?feeSettlement!.previousBoxVolumeM3??0:feeSettlement?.boxVolumeM3||0,
     storageRateUsd:hasPreviousSnapshot?feeSettlement!.previousStorageRateUsd??0.7:feeSettlement?.rateUsdM3Day||0.7,freeDays:hasPreviousSnapshot?feeSettlement!.previousFreeDays??0:feeSettlement?.freeDays||0,
     catalogItemId:hasPreviousSnapshot?feeSettlement!.previousCatalogItemId??null:feeSettlement?.catalogItemId||null,note:`由记录 #${log.id} 恢复`,updatedBy:a.user!.displayName,updatedAt:stamp,version:0}));
  }
  const settlementDeleteIndex=feeSettlement
    ? queries.push(db.delete(storageFeeSettlements).where(restorableSettlementCondition(feeSettlement)).returning({id:storageFeeSettlements.id}))-1
    : -1;
  queries.push(db.insert(auditLogs).values({userId:guardedRestoreAuditUserId(feeSettlement,a.user!.id),userName:a.user!.displayName,action:"恢复",entityType:"原记录",entityId:String(log.id),operationId,summary:`恢复原记录 ${log.id}｜${log.action}反向处理｜${product}｜库位 ${log.entityId}｜数量 ${reverseQty>=0?"+":""}${reverseQty}｜箱数 ${reverseBoxes>=0?"+":""}${reverseBoxes}｜托盘 ${reversePallets>=0?"+":""}${palletLabel(reversePallets)}`,createdAt:stamp}));
  try{
    const results=await db.batch(batchTuple([...goods.drizzleGuard,...queries,...goods.drizzleAfterQueries]));
    if(settlementDeleteIndex>=0&&!drizzleBatchHasRow(results[goods.drizzleGuard.length+settlementDeleteIndex]))return Response.json({error:"出库计价状态刚刚发生变化，不能恢复库存，请刷新后重试"},{status:409});
  }catch(error){if(isRestoreDuplicate(error))return Response.json({error:"该记录已经恢复过"},{status:409});if(/NOT NULL constraint failed: audit_logs\.user_id/i.test(String(error)))return Response.json({error:"出库计价状态刚刚发生变化，不能恢复库存，请刷新后重试"},{status:409});throw error;}
  return Response.json({ok:true});

  } catch (error) { if(error instanceof GoodsFlowError||/goods_transaction_guards|CHECK constraint failed: valid/.test(String(error)))return goodsResponseError(error); if (isLocationRenameConflict(error)) return Response.json({ error: "库位名称已更新或库存刚有变化，请刷新重试" }, { status: 409 }); throw error; }
}
