import {compressLegacyBackup} from '../../../lib/backup-storage-cleanup';
import {beginBackupExport,advanceBackupExport} from '../../../lib/backup-export-job';
import {claimBackupJob,BACKUP_VERIFIED_MARKER} from '../../../lib/backup-job';
import {backupSnapshotStream} from '../../../lib/backup-snapshot-stream';
import {ensureLayerStorageCheckpoint} from '../../../lib/layer-storage-checkpoint';
import {isLayerStoragePricing,STORAGE_PRICING_BASIS_KEY} from '../../../lib/storage-pricing-basis';
import {WAREHOUSE_CORE_RESTORE_LOCK_KEY,warehouseCoreBusy,claimWarehouseCoreRestore,releaseWarehouseCoreRestore,assertWarehouseSnapshotReady,WAREHOUSE_HISTORY_IMPORT_KEY,createWarehouseHistoryImport,validateBackupGoodsOperation,readWarehouseHistoryImport,finishWarehouseHistoryCore,importWarehouseHistoryChunk,WarehouseHistoryImportError} from '../../../lib/warehouse-history-import';
import {warehouseTodayDate} from '../../../lib/warehouse-time';
import {backupRetention,listBackupObjects,putVerifiedBackup,pruneBackups} from '../../../lib/backup-retention';
import { hasPermission, ALL_PERMISSIONS } from "../../../lib/permissions";
import { loadLocationAliases } from "../../../lib/location-alias-store";
import { upgradeBackupLocationNames } from "../../../lib/location-aliases";
import { env } from "cloudflare:workers";
import { asc,lt,and,sql,eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { auditLogs,pricingCatalogItems,settings,stocks,storageFeeSettlements,users,goodsFlowState,goodsOperations,workOrders,workOrderEvents,workOrderFiles,cartonReceipts,cartonOperations,layerStorageCheckpoints } from "../../../db/schema";
import { requireUser } from "../../../lib/auth";
import { catalogIdentity } from "../../../lib/pricing";
import { parseGoodsState,assertGoodsBalance,type GoodsStock } from "../../../lib/goods-flow";
import {assertStockInventoryUnit} from "../../../lib/inventory-unit";
import {parseBoxReviews,BOX_REVIEW_KEY} from "../../../lib/box-inventory-review";
import {validateWorkorderBackup} from "../../../lib/workorder-backup";
import {validateCartonBackup} from "../../../lib/carton-backup";
import {remapSnapshotLocations} from "../../../lib/location-aliases";
import {remapCartonRowSnapshot} from '../../../lib/carton-location';
import {validateWmsBackup} from '../../../lib/wms-backup';
import {resolveLocationAlias} from '../../../lib/location-aliases';
import {LAYER_PRICING_KEY,parseLayerPricingConfig} from '../../../lib/layer-storage';
import {validateLayerStorageCheckpointBackup,remapLayerStorageCheckpoint,CAPTURE_LAYER_STORAGE_CHECKPOINT_SQL} from '../../../lib/layer-storage-checkpoint';
import {parseLocationAliases,LOCATION_ALIASES_KEY} from '../../../lib/location-aliases';

type BackupRow=Record<string,string|number|null|undefined>;
type Backup={version:number;createdAt:string;stocks:BackupRow[];settings:BackupRow[];users:BackupRow[];auditLogs:BackupRow[];pricingCatalogItems?:BackupRow[];storageFeeSettlements?:BackupRow[];goodsFlowState?:BackupRow[];goodsOperations?:BackupRow[];workOrders?:BackupRow[];workOrderEvents?:BackupRow[];workOrderFiles?:BackupRow[];cartonReceipts?:BackupRow[];cartonOperations?:BackupRow[];wmsMoveRequests?:BackupRow[];wmsCounts?:BackupRow[];wmsCountRequests?:BackupRow[];layerStorageCheckpoints?:BackupRow[]};
const restoredSettlementStatus=(data:Backup,row:BackupRow)=>data.version>=4&&["pending","settled","cancelled"].includes(String(row.settlementStatus))?String(row.settlementStatus):"settled";
const weeklyBackupKey='backups/weekly-latest.json.gz';

async function snapshot(kind="manual",createdBy="系统自动",weekly?:{week:string;previous:R2Object|null}){
 const job=await claimBackupJob();let failed=true;
 const createdAt=new Date().toISOString(),key=weekly?weeklyBackupKey:`backups/${kind}-${createdAt.replace(/[:.]/g,"-")}-${crypto.randomUUID()}.json.gz`;
 try{
  await ensureLayerStorageCheckpoint();const copy=await backupSnapshotStream(createdAt);
  const onlyIf=weekly?(weekly.previous?{etagMatches:weekly.previous.etag}:{etagDoesNotMatch:'*'}):undefined;
  const saved=await putVerifiedBackup(key,copy.stream,{httpMetadata:{contentType:"application/gzip"},customMetadata:{createdAt,kind,createdBy,...(weekly?{week:weekly.week}:{})},onlyIf});
  if(saved===false&&weekly&&((await env.BACKUPS.head(key))?.customMetadata?.week??'')<weekly.week)throw new Error('每周备份正在更新，请稍后重试');
  if(kind==='manual')await env.BACKUPS.put(BACKUP_VERIFIED_MARKER,JSON.stringify({createdAt,key}));
  failed=false;
 }finally{await job.release(failed).catch((error:unknown)=>console.error('backup lease release failed',error));}
 return key;
}
async function batch(stmts:D1PreparedStatement[]){for(let i=0;i<stmts.length;i+=80)await env.DB.batch(stmts.slice(i,i+80))}
async function batchRows<T>(rows:readonly T[],prepare:(row:T)=>D1PreparedStatement,size=80){for(let i=0;i<rows.length;i+=size)await env.DB.batch(rows.slice(i,i+size).map(prepare));}
async function restore(data:Backup,warehouseOnly=false){
 if(![1,2,3,4,5,6,7,8,9].includes(data.version)||!Array.isArray(data.stocks)||!Array.isArray(data.settings)||!Array.isArray(data.users)||!Array.isArray(data.auditLogs)||(data.version>=2&&(!Array.isArray(data.pricingCatalogItems)||!Array.isArray(data.storageFeeSettlements)))||(data.version>=5&&(!Array.isArray(data.goodsFlowState)||!Array.isArray(data.goodsOperations))))throw new Error("备份文件格式不正确");
 if(data.version>=9)validateLayerStorageCheckpointBackup(data);
 if(data.version>=8)validateWmsBackup(data);
 if(data.version>=7)validateCartonBackup(data);
 if(data.version>=6)validateWorkorderBackup(data);
 if(data.version>=5){
  if(data.goodsFlowState!.length!==1||data.goodsFlowState![0].id!==1||!Number.isSafeInteger(data.goodsFlowState![0].revision)||Number(data.goodsFlowState![0].revision)<0||typeof data.goodsFlowState![0].value!=="string")throw new Error("备份缺少完整的货物计价批次");
  const state=parseGoodsState(data.goodsFlowState![0].value);for(const category of state.categories)assertGoodsBalance(category,data.stocks as unknown as GoodsStock[]);
  for(const operation of data.goodsOperations!)validateBackupGoodsOperation(operation);
 }
 for(const row of data.stocks){assertStockInventoryUnit(row);if(row.inventoryReviewDecision!==undefined&&(typeof row.inventoryReviewDecision!=="string"||!["","confirm","retain"].includes(row.inventoryReviewDecision)))throw new Error("库存单位备份格式不正确");}
 for(const row of data.settings)if(row.key===BOX_REVIEW_KEY)parseBoxReviews(String(row.value));
 const layerSettings=data.settings.filter(row=>row.key===LAYER_PRICING_KEY);
 if(layerSettings.length>1)throw new Error('备份托层计价配置重复');
 for(const row of layerSettings){if(typeof row.value!=='string')throw new Error('备份托层计价配置格式不正确');parseLayerPricingConfig(row.value);}
 const runtimeDb=getDb(),[basisRow]=await runtimeDb.select().from(settings).where(eq(settings.key,STORAGE_PRICING_BASIS_KEY)).limit(1),layerPricing=await isLayerStoragePricing(runtimeDb);
 const locationAliases=warehouseOnly?parseLocationAliases(String(data.settings.find(row=>row.key===LOCATION_ALIASES_KEY)?.value??'{}')):await loadLocationAliases();data=upgradeBackupLocationNames(data,locationAliases,{inPlace:true}) as Backup;
 data.settings=data.settings.filter(row=>row.key!==STORAGE_PRICING_BASIS_KEY);
 if(layerPricing)data.settings.push({key:STORAGE_PRICING_BASIS_KEY,value:'layer',updatedAt:new Date().toISOString()});
 else if(basisRow)data.settings.push(basisRow);
 const checkpointAliases=parseLocationAliases(String(data.settings.find(row=>row.key===LOCATION_ALIASES_KEY)?.value??'{}'));
 if(data.version>=9)data.layerStorageCheckpoints=validateLayerStorageCheckpointBackup(data).map(row=>remapLayerStorageCheckpoint(row,checkpointAliases));
 // Historical captured quantities and exact replay responses remain unchanged.
 data.wmsCounts=data.wmsCounts?.map(row=>({...row,location:resolveLocationAlias(String(row.location),locationAliases)}));
 data.cartonReceipts=data.cartonReceipts?.map(row=>({...row,placements:remapSnapshotLocations(String(row.placements),locationAliases)}));
 data.cartonOperations=data.cartonOperations?.map(row=>({...row,beforeSnapshot:remapCartonRowSnapshot(row.beforeSnapshot as string|null,locationAliases),afterSnapshot:remapCartonRowSnapshot(row.afterSnapshot as string|null,locationAliases),result:remapSnapshotLocations(row.result as string,locationAliases)}));
 data.auditLogs=data.auditLogs.map(row=>['箱件收货','箱件原操作'].includes(String(row.entityType))?{...row,beforeSnapshot:remapCartonRowSnapshot(row.beforeSnapshot as string|null,locationAliases),afterSnapshot:remapCartonRowSnapshot(row.afterSnapshot as string|null,locationAliases)}:row);
 await env.DB.batch([env.DB.prepare('DELETE FROM layer_storage_checkpoints'),env.DB.prepare('DELETE FROM wms_count_guards'),env.DB.prepare('DELETE FROM wms_count_requests'),env.DB.prepare('DELETE FROM wms_counts'),env.DB.prepare('DELETE FROM wms_move_requests'),env.DB.prepare('DELETE FROM carton_transaction_guards'),env.DB.prepare('DELETE FROM carton_operations'),env.DB.prepare('DELETE FROM carton_receipts')]);
 await env.DB.batch([...(warehouseOnly?[]:[env.DB.prepare("DELETE FROM sessions")]),env.DB.prepare("DELETE FROM work_order_events"),env.DB.prepare("DELETE FROM work_order_files"),env.DB.prepare("DELETE FROM work_orders"),env.DB.prepare("DELETE FROM goods_transaction_guards"),env.DB.prepare("DELETE FROM goods_operations"),env.DB.prepare("DELETE FROM goods_flow_state"),env.DB.prepare("DELETE FROM storage_fee_settlements"),env.DB.prepare("DELETE FROM pricing_catalog_items"),env.DB.prepare("DELETE FROM audit_logs"),env.DB.prepare("DELETE FROM stocks"),env.DB.prepare("DELETE FROM settings WHERE key<>?").bind(WAREHOUSE_CORE_RESTORE_LOCK_KEY),...(warehouseOnly?[]:[env.DB.prepare("DELETE FROM users")])]);
 await batchRows(data.stocks,x=>env.DB.prepare("INSERT INTO stocks (id,location_code,inbound_date,product,sku,fnsku,barcode,inbound_order,total_quantity,total_boxes,customer_name,pallet_count,pallet_label,layer_count,inbound_source,billing_mode,item_volume_m3,box_volume_m3,storage_rate_usd,free_days,catalog_item_id,note,updated_by,updated_at,version,product_prefix,product_condition,inventory_unit,inventory_review_decision) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(x.id,x.locationCode,x.inboundDate,x.product,x.sku??"",x.fnsku??"",x.barcode,x.inboundOrder,x.totalQuantity,x.totalBoxes,x.customerName,x.palletCount,x.palletLabel||String(x.palletCount??""),x.layerCount,x.inboundSource||"domestic",x.billingMode||"item",Number(x.itemVolumeM3||0),Number(x.boxVolumeM3||0),Number(x.storageRateUsd??0.7),Number(x.freeDays||0),x.catalogItemId||null,x.note,x.updatedBy,x.updatedAt,Number(x.version||0),String(x.productPrefix??""),String(x.productCondition??""),String(x.inventoryUnit??"item"),String(x.inventoryReviewDecision??"")));
 await batchRows(data.settings,x=>env.DB.prepare("INSERT INTO settings (key,value,updated_at) VALUES (?,?,?)").bind(x.key,x.value,x.updatedAt));
 if(!warehouseOnly)await batchRows(data.users,x=>env.DB.prepare("INSERT INTO users (id,username,display_name,role,password_hash,password_salt,active,must_change,created_at,permissions,permission_version) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind(x.id,x.username,x.displayName,x.role,x.passwordHash,x.passwordSalt,x.active,x.mustChange,x.createdAt,x.permissions??null,x.permissionVersion??0));
 await batchRows(data.auditLogs,x=>env.DB.prepare("INSERT INTO audit_logs (id,user_id,user_name,action,entity_type,entity_id,operation_id,summary,before_snapshot,after_snapshot,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind(x.id,x.userId,x.userName,x.action,x.entityType,x.entityId,x.operationId||null,x.summary,x.beforeSnapshot??null,x.afterSnapshot??null,x.createdAt));
 if(data.version>=2){
  await batchRows((data.pricingCatalogItems||[]),x=>env.DB.prepare("INSERT INTO pricing_catalog_items (id,identity_key,partner_name,customer_name,product,sku,fnsku,barcode,default_billing_mode,item_length_cm,item_width_cm,item_height_cm,item_volume_m3,box_length_cm,box_width_cm,box_height_cm,box_volume_m3,rate_usd_m3_day,free_days,active,updated_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(x.id,x.identityKey||catalogIdentity({product:String(x.product||""),sku:String(x.sku||""),fnsku:String(x.fnsku||""),barcode:String(x.barcode||""),customerName:String(x.customerName||""),partnerName:String(x.partnerName||"")}),x.partnerName,x.customerName,x.product,x.sku,x.fnsku??"",x.barcode,x.defaultBillingMode,x.itemLengthCm,x.itemWidthCm,x.itemHeightCm,x.itemVolumeM3,x.boxLengthCm,x.boxWidthCm,x.boxHeightCm,x.boxVolumeM3,x.rateUsdM3Day,x.freeDays,x.active,x.updatedBy,x.createdAt,x.updatedAt));
  await batchRows((data.storageFeeSettlements||[]),x=>env.DB.prepare("INSERT INTO storage_fee_settlements (id,stock_id,operation_id,catalog_item_id,location_code,inbound_source,billing_mode,product,sku,fnsku,barcode,inbound_order,customer_name,inbound_date,outbound_at,quantity,boxes,item_volume_m3,box_volume_m3,rate_usd_m3_day,free_days,storage_days,billable_days,total_volume_m3,fee_usd,settlement_status,settled_at,settled_by,version,previous_inbound_source,previous_billing_mode,previous_item_volume_m3,previous_box_volume_m3,previous_storage_rate_usd,previous_free_days,previous_catalog_item_id,stock_updated_at_before,stock_updated_at_after,operated_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(x.id,x.stockId,x.operationId||null,x.catalogItemId||null,x.locationCode,x.inboundSource,x.billingMode,x.product,x.sku??"",x.fnsku??"",x.barcode,x.inboundOrder,x.customerName,x.inboundDate,x.outboundAt,x.quantity,x.boxes,x.itemVolumeM3,x.boxVolumeM3,x.rateUsdM3Day,x.freeDays,x.storageDays,x.billableDays,x.totalVolumeM3,x.feeUsd,restoredSettlementStatus(data,x),data.version>=4?x.settledAt??null:x.createdAt??x.outboundAt,data.version>=4?x.settledBy??null:x.operatedBy,Number(x.version||0),x.previousInboundSource||null,x.previousBillingMode||null,x.previousItemVolumeM3??null,x.previousBoxVolumeM3??null,x.previousStorageRateUsd??null,x.previousFreeDays??null,x.previousCatalogItemId??null,x.stockUpdatedAtBefore||null,x.stockUpdatedAtAfter||null,x.operatedBy,x.createdAt));
 }
 const flow=data.version>=5?data.goodsFlowState!:[{id:1,revision:0,value:'{"categories":[]}'}];
 await batchRows(flow,x=>env.DB.prepare("INSERT INTO goods_flow_state(id,revision,value) VALUES (?,?,?)").bind(x.id,x.revision,x.value));
 await batchRows((data.version>=5?data.goodsOperations!:[]),x=>env.DB.prepare("INSERT INTO goods_operations(id,kind,category_id,fingerprint,before_category,after_category,before_rows,after_rows,settlement_ids,result,created_at,restored_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").bind(x.id,x.kind,x.categoryId,x.fingerprint,x.beforeCategory??null,x.afterCategory,x.beforeRows,x.afterRows,x.settlementIds,x.result,x.createdAt,x.restoredAt??null),20);
 if(data.version>=6){
  await batchRows(data.workOrders!,x=>env.DB.prepare("INSERT INTO work_orders(id,number,kind,title,customer_name,employee_body,payload,file_ids,status,assigned_to,version,created_by,created_at,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(x.id,x.number,x.kind,x.title,x.customerName,x.employeeBody,x.payload,x.fileIds,x.status,x.assignedTo,x.version,x.createdBy,x.createdAt,x.updatedBy,x.updatedAt));
  await batchRows(data.workOrderEvents!,x=>env.DB.prepare("INSERT INTO work_order_events(id,order_id,action,user_id,user_name,summary,mutation_id,request_hash,result,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(x.id,x.orderId,x.action,x.userId,x.userName,x.summary,x.mutationId,x.requestHash,x.result,x.createdAt));
  await batchRows(data.workOrderFiles!,x=>env.DB.prepare("INSERT INTO work_order_files(id,order_id,object_key,name,mime,size,hash,visibility,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(x.id,x.orderId,x.objectKey,x.name,x.mime,x.size,x.hash,x.visibility,x.createdBy,x.createdAt));
 }
 if(data.version>=7){
  await batchRows(data.cartonReceipts!,x=>env.DB.prepare('INSERT INTO carton_receipts(id,inbound_order,original_order,order_history,customer_name,inbound_date,placements,note,version,created_by,created_at,updated_by,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(x.id,x.inboundOrder,x.originalOrder,x.orderHistory,x.customerName,x.inboundDate,x.placements,x.note,x.version,x.createdBy,x.createdAt,x.updatedBy,x.updatedAt));
  await batchRows(data.cartonOperations!,x=>env.DB.prepare('INSERT INTO carton_operations(id,receipt_id,kind,fingerprint,before_snapshot,after_snapshot,result,user_id,created_at,restored_at) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(x.id,x.receiptId,x.kind,x.fingerprint,x.beforeSnapshot,x.afterSnapshot,x.result,x.userId,x.createdAt,x.restoredAt));
 }
 if(data.version>=8){
  await batchRows(data.wmsMoveRequests!,x=>env.DB.prepare('INSERT INTO wms_move_requests(request_id,actor_id,fingerprint,operation_id,response_json,response_status,created_at) VALUES(?,?,?,?,?,?,?)').bind(x.requestId,x.actorId,x.fingerprint,x.operationId,x.responseJson,x.responseStatus,x.createdAt));
  await batchRows(data.wmsCounts!,x=>env.DB.prepare('INSERT INTO wms_counts(id,number,location,blind,status,version,source,observations,conclusion,created_by,created_name,created_at,updated_at,reviewed_by,reviewed_name,reviewed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(x.id,x.number,x.location,x.blind,x.status,x.version,x.source,x.observations,x.conclusion,x.createdBy,x.createdName,x.createdAt,x.updatedAt,x.reviewedBy,x.reviewedName,x.reviewedAt));
  await batchRows(data.wmsCountRequests!,x=>env.DB.prepare('INSERT INTO wms_count_requests(id,actor_id,fingerprint,response,created_at) VALUES(?,?,?,?,?)').bind(x.id,x.actorId,x.fingerprint,x.response,x.createdAt));
 }
 if(data.version>=9)await batchRows(data.layerStorageCheckpoints!,row=>env.DB.prepare('INSERT INTO layer_storage_checkpoints(id,captured_at,value,audit_high_id) VALUES(?,?,?,?)').bind(row.id,row.capturedAt,row.value,row.auditHighId));
 else await env.DB.batch([env.DB.prepare(CAPTURE_LAYER_STORAGE_CHECKPOINT_SQL)]);
}
const protectedPhysicalAuditSql="audit_logs.action IN ('入库','出库','移库','库存修改','删除','恢复','箱件收货','箱件出库','箱件认领改单','箱件删除','撤销箱件操作') AND EXISTS(SELECT 1 FROM layer_storage_checkpoints cp WHERE cp.id=1 AND cp.captured_at<=audit_logs.created_at)";
async function archiveOldLogs(){
 const job=await claimBackupJob();try{
 const cutoff=new Date(Date.now()-365*86400000).toISOString(),db=getDb(),rows=await db.select().from(auditLogs).where(and(lt(auditLogs.createdAt,cutoff),sql.raw('NOT ('+protectedPhysicalAuditSql+')'),sql.raw("COALESCE(length(CAST(user_name AS BLOB)),0)+COALESCE(length(CAST(action AS BLOB)),0)+COALESCE(length(CAST(entity_type AS BLOB)),0)+COALESCE(length(CAST(entity_id AS BLOB)),0)+COALESCE(length(CAST(operation_id AS BLOB)),0)+COALESCE(length(CAST(summary AS BLOB)),0)+COALESCE(length(CAST(before_snapshot AS BLOB)),0)+COALESCE(length(CAST(after_snapshot AS BLOB)),0)+COALESCE(length(CAST(created_at AS BLOB)),0)<=32768"))).orderBy(asc(auditLogs.id)).limit(50);
 if(!rows.length)return 0;
 const createdAt=new Date().toISOString(),key=`archives/audit-${warehouseTodayDate(new Date(rows[0].createdAt))}-to-${warehouseTodayDate(new Date(rows[rows.length-1].createdAt))}-${createdAt.replace(/[:.]/g,"-")}.json.gz`;
 await putVerifiedBackup(key,JSON.stringify({version:1,createdAt,cutoff,recordCount:rows.length,auditLogs:rows}),{httpMetadata:{contentType:"application/json"},customMetadata:{createdAt,kind:"archive",createdBy:"系统自动",recordCount:String(rows.length)}});
 await batch(rows.map(x=>env.DB.prepare("DELETE FROM audit_logs WHERE id = ? AND NOT ("+protectedPhysicalAuditSql+")").bind(x.id)));return rows.length;
 }finally{await job.release();}
}

export async function GET(req:Request){
 const a=await requireUser(req,"backup.manage");if(a.error)return a.error;const key=new URL(req.url).searchParams.get("download");
 if(key){
  if(!key.startsWith("backups/")&&!key.startsWith("archives/"))return Response.json({error:"无效文件"},{status:400});
  const object=await env.BACKUPS.get(key);
  if(!object)return Response.json({error:"文件不存在"},{status:404});
  const compressed=key.endsWith('.json.gz'),compact=new URL(req.url).searchParams.get('compressed')==='1';
  const input=typeof object.body==='string'?new Blob([object.body]).stream():object.body;
  const body=compact?(compressed?input:input.pipeThrough(new CompressionStream('gzip'))):(compressed?input.pipeThrough(new DecompressionStream('gzip')):input);
  const filename=key.split('/').pop()!.replace(/\.json\.gz$/,'.json')+(compact?'.gz':'');
  return new Response(body,{headers:{"Content-Type":compact?"application/gzip":"application/json","Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff","Content-Disposition":`attachment; filename="${filename}"`}});
 }
 const [backups,archives]=await Promise.all([listBackupObjects("backups/"),listBackupObjects("archives/")]),objects=[...backups,...archives].sort((x,y)=>new Date(y.customMetadata?.createdAt||y.uploaded).getTime()-new Date(x.customMetadata?.createdAt||x.uploaded).getTime());
 const objectKeys=new Set(objects.map(x=>x.key)),storage={totalBytes:objects.reduce((n,x)=>n+x.size,0),objectCount:objects.length,uncompressedCount:objects.filter(x=>x.key.endsWith('.json')&&x.size>=1024).length,compressionSavedBytes:objects.reduce((n,x)=>n+(x.customMetadata?.compressedFrom&&!objectKeys.has(x.customMetadata.compressedFrom)?Math.max(0,Number(x.customMetadata.uncompressedSize||0)-x.size):0),0)};
 return Response.json({storage,warehouseImportAvailable:true,warehouseCoreBusy:await warehouseCoreBusy(),warehouseHistory:true?await readWarehouseHistoryImport():null,backups:objects.map(x=>({key:x.key,size:x.size,uploaded:x.customMetadata?.createdAt||x.uploaded,kind:x.customMetadata?.kind||(x.key.startsWith("archives/")?"archive":"backup"),createdBy:x.customMetadata?.createdBy||"未记录",recordCount:Number(x.customMetadata?.recordCount||0),uncompressedSize:Number(x.customMetadata?.uncompressedSize||0)})),retention:backupRetention});
}
export async function POST(req:Request){
 const a=await requireUser(req,"backup.manage");if(a.error)return a.error;try{const raw=await req.text();if(new TextEncoder().encode(raw).length>4*1024*1024)throw new WarehouseHistoryImportError('历史分段请求超过4MB');const body=JSON.parse(raw) as Record<string,unknown>,{action}=body;
 if(action==='storage-cleanup'){if(!ALL_PERMISSIONS.every(p=>hasPermission(a.user!,p)))return Response.json({error:'清理备份需要老板权限'},{status:403});return Response.json({ok:true,...await compressLegacyBackup(body.key)});}
 if(action==='warehouse-history'){
  if(!ALL_PERMISSIONS.every(p=>hasPermission(a.user!,p)))return Response.json({error:'历史分段同步需要全部操作权限'},{status:403});
  return Response.json({ok:true,history:await importWarehouseHistoryChunk(body)});
 }
 if(action==='backup-step'){
  await assertWarehouseSnapshotReady();const result=await advanceBackupExport(String(body.jobId??''));
  if(result.pending)return Response.json(result);
  let pruned=0,warning='';try{pruned=await pruneBackups(result.key)}catch{warning='备份已保存，旧备份清理未完成，将在下次重试'}return Response.json({...result,pruned,warning});
 }
 if(action==='auto'&&!await env.BACKUPS.head('maintenance/legacy-cleanup-v149-complete.json')&&ALL_PERMISSIONS.every(p=>hasPermission(a.user!,p))){
  const skipObject=await env.BACKUPS.get('maintenance/legacy-cleanup-v149-skips.json'),skips:string[]=skipObject?JSON.parse(await skipObject.text()):[];
  const objects=[...await listBackupObjects('backups/'),...await listBackupObjects('archives/')],candidate=objects.filter(x=>x.key.endsWith('.json')&&x.size>=1024&&!skips.includes(x.key)).sort((a,b)=>b.size-a.size)[0];
  if(candidate){const cleanup=await compressLegacyBackup(candidate.key);return Response.json({ok:true,paused:true,cleanup,cleanupNext:true});}
  await env.BACKUPS.put('maintenance/legacy-cleanup-v149-complete.json',JSON.stringify({completedAt:new Date().toISOString()}));
 }
 if(action==='auto'&&!await env.BACKUPS.head(BACKUP_VERIFIED_MARKER))return Response.json({ok:true,paused:true,archived:0,pruned:0});
 await assertWarehouseSnapshotReady();
 if(action==="auto"){
  const today=warehouseTodayDate(),marker=`maintenance/new-york-${today}.json`;
  const monday=new Date(`${today}T00:00:00Z`);
  monday.setUTCDate(monday.getUTCDate()-(monday.getUTCDay()+6)%7);
  const week=monday.toISOString().slice(0,10),previous=await env.BACKUPS.head(weeklyBackupKey);
  if((previous?.customMetadata?.week??'')<week)return Response.json(await beginBackupExport('weekly','系统自动',{week,previous}));
  let archived=0,pruned=0;if(!await env.BACKUPS.head(marker)){pruned=await pruneBackups();archived=await archiveOldLogs();await env.BACKUPS.put(marker,JSON.stringify({completedAt:new Date().toISOString(),archived,pruned}))}
  return Response.json({ok:true,archived,pruned});
 }
 return Response.json(await beginBackupExport('manual',a.user!.displayName));
 }catch(e){return Response.json({error:e&&typeof e==="object"&&"message" in e?String(e.message):"备份保存失败"},{status:e instanceof WarehouseHistoryImportError?e.status:e instanceof SyntaxError?400:500})}
}
export async function PUT(req:Request){
 const a=await requireUser(req,"backup.manage");if(a.error)return a.error;if(!ALL_PERMISSIONS.every(p=>hasPermission(a.user!,p)))return Response.json({error:"整库恢复会覆盖账号与所有业务数据，需要全部操作权限"},{status:403});const form=await req.formData(),confirm=form.get("confirm");let file=form.get("file");if(!(file instanceof File)||confirm!=="恢复备份")return Response.json({error:"请选择备份并输入确认文字"},{status:400});const mode=form.get('warehouseOnly');if(mode!==null&&mode!=='1')return Response.json({error:'同步方式无效'},{status:400});const warehouseOnly=mode==='1';if(file.size>50*1024*1024)return Response.json({error:"备份文件超过 50MB，请联系管理员协助恢复"},{status:400});
 let coreLock:string|null=null;try{let raw=await file.text();form.delete("file");file=null;const data=JSON.parse(raw) as Backup;raw="";const importId=form.get('historyImportId'),expected=form.get('historyExpected');let history=null;
  if(importId!==null||expected!==null){if(!warehouseOnly||typeof expected!=='string'||!/^[1-9]\d*$/.test(expected))throw new Error('分段历史导入参数无效');history=createWarehouseHistoryImport(importId,Number(expected),data.createdAt);if(data.version<5||(data.goodsOperations!==undefined&&(!Array.isArray(data.goodsOperations)||data.goodsOperations.length)))throw new Error('核心备份不能包含待分段导入的货物历史');data.goodsOperations=[];const auditExpected=form.get('historyAuditExpected');if(auditExpected!==null){const count=Number(auditExpected);if(typeof auditExpected!=='string'||!/^\d+$/.test(auditExpected)||!Number.isSafeInteger(count)||count<1||count>history.total||data.auditLogs.length)throw new Error('审计历史分段参数无效');history.auditTotal=count;history.auditReceived=0;}}
  if(Array.isArray(data.settings))data.settings=data.settings.filter(row=>row.key!==WAREHOUSE_HISTORY_IMPORT_KEY&&row.key!==WAREHOUSE_CORE_RESTORE_LOCK_KEY);
  if(history){history.counts={stocks:data.stocks.length,cartonReceipts:data.cartonReceipts?.length??0,catalog:data.pricingCatalogItems?.length??0,settlements:data.storageFeeSettlements?.length??0,auditLogs:data.auditLogs.length};data.settings.push({key:WAREHOUSE_HISTORY_IMPORT_KEY,value:JSON.stringify(history),updatedAt:new Date().toISOString()});}
  coreLock=await claimWarehouseCoreRestore();const protection=await snapshot("before-restore",a.user!.displayName);await restore(data,warehouseOnly);if(history)history=await finishWarehouseHistoryCore(history);try{await pruneBackups(protection)}catch{/* restored data is successful even if old backup cleanup needs retry */}return Response.json({ok:true,protectionKey:protection,warehouseOnly,sourceCreatedAt:data.createdAt,...(history?{history}:{}),counts:{stocks:data.stocks.length,cartonReceipts:data.cartonReceipts?.length??0,catalog:data.pricingCatalogItems?.length??0,settlements:data.storageFeeSettlements?.length??0,auditLogs:data.auditLogs.length}})}catch(e){return Response.json({error:e instanceof Error?e.message:"恢复失败"},{status:e instanceof WarehouseHistoryImportError?e.status:400})}finally{if(coreLock)await releaseWarehouseCoreRestore(coreLock);}
}
