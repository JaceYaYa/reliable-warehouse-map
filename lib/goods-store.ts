import {loadStockPalletMetadata,projectStockPallets} from './stock-pallets';
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { goodsFlowState, settings, stocks } from "../db/schema";
import {assertStockInventoryUnit} from "./inventory-unit";
import { emptyAssociationState, INVENTORY_ASSOCIATIONS_KEY, parseAssociationState } from "./inventory-associations";
import { GoodsFlowError, goodsChoices, parseGoodsState, type GoodsState, type GoodsStock } from "./goods-flow";

export async function loadGoodsContext() {
  const db=getDb();const [rows,stateRows,associationRows]=await db.batch([db.select().from(stocks),db.select().from(goodsFlowState),db.select().from(settings).where(eq(settings.key,INVENTORY_ASSOCIATIONS_KEY))]);
  const stored=(stateRows as (typeof goodsFlowState.$inferSelect)[])[0];if(!stored)throw new GoodsFlowError("货物批次数据尚未初始化，请联系管理员",500);
  const associations=(associationRows as {value:string}[])[0];
  const palletMetadata=await loadStockPalletMetadata(db.$client);
  const state=parseGoodsState(stored.value),allRows=projectStockPallets(rows as GoodsStock[],palletMetadata) as GoodsStock[];
  return {state,stored,palletMetadata,rows:allRows,choices:goodsChoices(allRows,associations?parseAssociationState(associations.value):emptyAssociationState(),state),associationValue:associations?.value??null};
}
export function goodsResponseError(error:unknown){if(error instanceof GoodsFlowError)return Response.json({error:error.message},{status:error.status});let cause=error;for(let depth=0;cause&&depth<8;depth++){if(/goods_transaction_guards\.valid|CHECK constraint failed|goods_operations\.id|audit_logs\.operation_id|UNIQUE constraint failed/i.test(String(cause)))return Response.json({error:"库存或计价批次刚刚发生变化，本次操作未写入；填写仍保留，请刷新核对后重试"},{status:409});cause=typeof cause==='object'&&cause!==null&&'cause' in cause?cause.cause:null;}if(error instanceof SyntaxError)return Response.json({error:"提交格式不正确"},{status:400});console.error("[goods] 操作失败",error);return Response.json({error:"货物操作失败，请稍后重试；填写仍保留"},{status:500});}
type Context=Awaited<ReturnType<typeof loadGoodsContext>>;
/** A CHECK constraint turns every failed precondition into a rollback of the entire D1 batch. */
export function goodsGuard(context:Context,id:string,options:{rows?:readonly GoodsStock[];highId?:number;association?:boolean;expectedPalletSettings?:Array<{key:string;value:string;updatedAt?:string}>}={}){
  const checks=["EXISTS(SELECT 1 FROM goods_flow_state WHERE id=1 AND revision=? AND value=?)"],binds:(string|number|null)[]=[context.stored.revision,context.stored.value];
  const palletSettings=options.expectedPalletSettings??context.palletMetadata.settings;
  checks.push("(SELECT COUNT(*) FROM settings WHERE key LIKE 'pallet_manual:stock:%')=? AND NOT EXISTS(SELECT 1 FROM json_each(?) j LEFT JOIN settings s ON s.key=json_extract(j.value,'$.key') WHERE s.key IS NULL OR s.value IS NOT json_extract(j.value,'$.value') OR s.updated_at IS NOT json_extract(j.value,'$.updatedAt'))");binds.push(palletSettings.length,JSON.stringify(palletSettings));
  if(options.rows?.length){checks.push("NOT EXISTS(SELECT 1 FROM json_each(?) j LEFT JOIN stocks s ON s.id=json_extract(j.value,'$.id') WHERE s.id IS NULL OR s.version<>json_extract(j.value,'$.version') OR s.updated_at<>json_extract(j.value,'$.updatedAt'))");binds.push(JSON.stringify(options.rows.map(r=>({id:r.id,version:r.version,updatedAt:r.updatedAt}))));}
  if(options.highId!==undefined){checks.push("(SELECT COALESCE(MAX(id),0) FROM stocks)=?");binds.push(options.highId);}
  if(options.association){checks.push("COALESCE((SELECT value FROM settings WHERE key=?),'')=?");binds.push(INVENTORY_ASSOCIATIONS_KEY,context.associationValue??"");}
  return env.DB.prepare(`INSERT INTO goods_transaction_guards(id,valid) VALUES (?,CASE WHEN ${checks.join(" AND ")} THEN 1 ELSE 0 END)`).bind(id,...binds);
}
export const goodsFinish=(id:string)=>env.DB.prepare("DELETE FROM goods_transaction_guards WHERE id=?").bind(id);
export function goodsStateUpdate(state:GoodsState){return env.DB.prepare("UPDATE goods_flow_state SET value=?,revision=revision+1 WHERE id=1").bind(JSON.stringify(state));}
export function goodsStockInsert(row:GoodsStock){assertStockInventoryUnit(row);return env.DB.prepare(`INSERT INTO stocks (id,location_code,inbound_date,product,product_prefix,product_condition,sku,fnsku,barcode,inbound_order,total_quantity,total_boxes,customer_name,pallet_count,pallet_label,layer_count,inbound_source,billing_mode,item_volume_m3,box_volume_m3,storage_rate_usd,free_days,catalog_item_id,note,updated_by,updated_at,version,inventory_unit,inventory_review_decision) VALUES (${Array.from({length:29},()=>"?").join(",")})`).bind(row.id,row.locationCode,row.inboundDate,row.product,row.productPrefix,row.productCondition,row.sku,row.fnsku,row.barcode,row.inboundOrder,row.totalQuantity,row.totalBoxes,row.customerName,(row.palletAutomatic?row.palletRawCount??1:row.palletCount),(row.palletAutomatic?row.palletRawLabel??row.palletLabel:row.palletLabel),row.layerCount,row.inboundSource,row.billingMode,row.itemVolumeM3,row.boxVolumeM3,row.storageRateUsd,row.freeDays,row.catalogItemId,row.note,row.updatedBy,row.updatedAt,row.version,row.inventoryUnit??"item",row.inventoryReviewDecision??"");}
export function goodsStockUpdate(row:GoodsStock){return env.DB.prepare("UPDATE stocks SET total_quantity=?,total_boxes=?,pallet_count=?,pallet_label=?,updated_at=?,updated_by=?,version=? WHERE id=?").bind(row.totalQuantity,row.totalBoxes,(row.palletAutomatic?row.palletRawCount??1:row.palletCount),(row.palletAutomatic?row.palletRawLabel??row.palletLabel:row.palletLabel),row.updatedAt,row.updatedBy,row.version,row.id);}
export function goodsAudit(user:{id:number;displayName:string},id:string,kind:"inbound"|"outbound"|"create"|"convert",product:string,summary:string,before:readonly GoodsStock[],after:readonly GoodsStock[],stamp:string){
  const action=kind==="outbound"?"出库":kind==="inbound"?"入库":kind==="convert"?"库存修改":"货物类别新增",entity=kind==="create"?"货物":"库位";
  return env.DB.prepare("INSERT INTO audit_logs(user_id,user_name,action,entity_type,entity_id,operation_id,summary,before_snapshot,after_snapshot,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(user.id,user.displayName,action,entity,[...new Set([...before,...after].map(r=>r.locationCode))].join("、")||product,id,summary,JSON.stringify({schema:"goods-operation-v1",operationId:id,rows:before}),JSON.stringify({schema:"goods-operation-v1",operationId:id,rows:after}),stamp);
}
export function goodsOperation(input:{id:string;kind:string;categoryId:string;fingerprint:string;beforeCategory:unknown;afterCategory:unknown;beforeRows:readonly GoodsStock[];afterRows:readonly GoodsStock[];settlementIds:string[];result:unknown;stamp:string}){
  return env.DB.prepare("INSERT INTO goods_operations(id,kind,category_id,fingerprint,before_category,after_category,before_rows,after_rows,settlement_ids,result,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind(input.id,input.kind,input.categoryId,input.fingerprint,input.beforeCategory?JSON.stringify(input.beforeCategory):null,JSON.stringify(input.afterCategory),JSON.stringify(input.beforeRows),JSON.stringify(input.afterRows),JSON.stringify(input.settlementIds),JSON.stringify(input.result),input.stamp);
}
export async function goodsIdempotency(id:unknown,body:unknown){
  if(typeof id!=="string"||!/^[-\da-f]{36}$/i.test(id))throw new GoodsFlowError("请求编号无效，请重新打开表单",400);
  const fingerprint=JSON.stringify(body),row=await env.DB.prepare("SELECT fingerprint,result,restored_at FROM goods_operations WHERE id=?").bind(id).first<{fingerprint:string;result:string;restored_at:string|null}>();
  if(row){if(row.fingerprint!==fingerprint)throw new GoodsFlowError("该请求编号已用于另一项操作，请刷新表单重试");if(row.restored_at)throw new GoodsFlowError("该操作已撤销，请重新填写提交");return {id,fingerprint,replayed:JSON.parse(row.result)};}return {id,fingerprint,replayed:null};
}

/** Persist mode beside the guarded operation, including undo of an earlier manual change. */
export const goodsPalletModeWrites=(rows:readonly GoodsStock[])=>rows.filter(row=>row.palletManual!==undefined).map(row=>env.DB.prepare('INSERT INTO settings(key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').bind('pallet_manual:stock:'+row.id,JSON.stringify(row.palletManual),row.updatedAt));
