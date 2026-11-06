import {remapCartonRowSnapshot} from './carton-location';
import {env} from 'cloudflare:workers';
import {validateStagingOperation} from './goods-staging';
import {validateCorrectionOperation} from './goods-correction';
import {LOCATION_ALIASES_KEY,parseLocationAliases,remapSnapshotLocations} from './location-aliases';

export const WAREHOUSE_HISTORY_IMPORT_KEY='warehouse_history_import_v1';
export const WAREHOUSE_CORE_RESTORE_LOCK_KEY='warehouse_core_restore_lock_v1';
type Operation=Record<string,string|number|null|undefined>;
type Receipt={index:number;hash:string;received:number;nextIndex:number;status:'history'|'complete'};
export type WarehouseHistoryImportCounts={stocks:number;cartonReceipts:number;catalog:number;settlements:number;auditLogs:number};
export type WarehouseHistoryImport={id:string;sourceCreatedAt:string;total:number;received:number;nextIndex:number;receipts:Receipt[];status:'preparing'|'history'|'complete';counts?:WarehouseHistoryImportCounts;auditTotal?:number;auditReceived?:number};
export class WarehouseHistoryImportError extends Error{constructor(message:string,public status=400){super(message);}}
const fail=(message:string,status=400):never=>{throw new WarehouseHistoryImportError(message,status);};
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
export async function warehouseCoreBusy(){return !!await env.DB.prepare('SELECT value FROM settings WHERE key=?').bind(WAREHOUSE_CORE_RESTORE_LOCK_KEY).first();}
export async function claimWarehouseCoreRestore(){
 const token=crypto.randomUUID();
 try{await env.DB.prepare('INSERT INTO settings(key,value,updated_at) VALUES(?,?,?)').bind(WAREHOUSE_CORE_RESTORE_LOCK_KEY,token,new Date().toISOString()).run();}catch{fail('核心数据正在恢复，请等待当前恢复完成后刷新核对',409);}
 return token;
}
export async function releaseWarehouseCoreRestore(token:string){await env.DB.prepare('DELETE FROM settings WHERE key=? AND value=?').bind(WAREHOUSE_CORE_RESTORE_LOCK_KEY,token).run();}
export async function assertWarehouseSnapshotReady(){
 const metadata=await readWarehouseHistoryImport();
 if(await warehouseCoreBusy()||metadata&&metadata.status!=='complete')fail('仓储数据同步尚未完成，暂不能创建普通备份，请等待并核对导入进度',409);
}
export function createWarehouseHistoryImport(id:unknown,total:unknown,sourceCreatedAt:string):WarehouseHistoryImport{
 if(!uuid(id)||typeof total!=='number'||!Number.isSafeInteger(total)||total<1)fail('分段历史导入标识或总数无效');
 return{id,sourceCreatedAt,total,received:0,nextIndex:0,receipts:[],status:'preparing'};
}
function validateOperation(operation:Operation){
 if(!operation||typeof operation!=='object'||Array.isArray(operation)||typeof operation.id!=='string'||!operation.id||!['create','inbound','outbound','document','sku','spec','identity','convert','correction','staging'].includes(String(operation.kind)))fail('备份货物操作记录格式不正确');
 for(const key of ['categoryId','fingerprint','createdAt','afterCategory','beforeRows','afterRows','settlementIds','result'])if(typeof operation[key]!=='string')fail('备份货物操作记录不完整');
 for(const key of ['afterCategory','beforeRows','afterRows','settlementIds','result'])JSON.parse(operation[key] as string);
 if(operation.beforeCategory!==null&&operation.beforeCategory!==undefined){if(typeof operation.beforeCategory!=='string')fail('备份货物操作记录格式不正确');if(operation.beforeCategory)JSON.parse(operation.beforeCategory);}
 if(operation.restoredAt!==null&&operation.restoredAt!==undefined&&typeof operation.restoredAt!=='string')fail('备份货物操作记录格式不正确');
 if(operation.kind==='staging')validateStagingOperation(operation as {id:string;result:string;beforeRows:string;afterRows:string;beforeCategory:string|null;afterCategory:string});
 if(operation.kind==='correction')validateCorrectionOperation(operation as {result:string;beforeRows:string;afterRows:string;beforeCategory:string|null;afterCategory:string});
}
export function validateBackupGoodsOperation(operation:Operation){
 try{validateOperation(operation);}catch(error){if(error instanceof WarehouseHistoryImportError)throw error;fail(error instanceof Error?error.message:'备份货物操作记录格式不正确');}
}
function validateAudit(row:Operation){
 // Migration 0025 writes legitimate system audits with actor 0. Preserve that
 // identity rather than rejecting it or attributing it to a real employee.
 if(!row||typeof row!=='object'||Array.isArray(row)||!Number.isSafeInteger(row.id)||Number(row.id)<1||!Number.isSafeInteger(row.userId)||Number(row.userId)<0)fail('备份审计记录编号不正确');
 for(const key of ['userName','action','entityType','entityId','summary','createdAt'])if(typeof row[key]!=='string')fail('备份审计记录不完整');
 for(const key of ['operationId','beforeSnapshot','afterSnapshot'])if(row[key]!==null&&row[key]!==undefined&&typeof row[key]!=='string')fail('备份审计记录格式不正确');
}
async function stored(){return await env.DB.prepare('SELECT value FROM settings WHERE key=?').bind(WAREHOUSE_HISTORY_IMPORT_KEY).first<{value:string}>();}
export async function readWarehouseHistoryImport():Promise<WarehouseHistoryImport|null>{
 const row=await stored();if(!row)return null;
 try{const value=JSON.parse(row.value) as WarehouseHistoryImport;if(!uuid(value.id)||!['preparing','history','complete'].includes(value.status)||!Number.isSafeInteger(value.total)||value.total<1||!Number.isSafeInteger(value.received)||value.received<0||value.received>value.total||!Number.isSafeInteger(value.nextIndex)||value.nextIndex<0||!Array.isArray(value.receipts))return null;return value;}catch{return null;}
}
export async function finishWarehouseHistoryCore(metadata:WarehouseHistoryImport){
 const next:WarehouseHistoryImport={...metadata,status:'history'},raw=JSON.stringify(metadata),nextRaw=JSON.stringify(next),guard='history-core:'+crypto.randomUUID();
 await env.DB.batch([env.DB.prepare('INSERT INTO goods_transaction_guards(id,valid) VALUES(?,CASE WHEN EXISTS(SELECT 1 FROM settings WHERE key=? AND value=?) AND (SELECT COUNT(*) FROM goods_operations)=0 THEN 1 ELSE 0 END)').bind(guard,WAREHOUSE_HISTORY_IMPORT_KEY,raw),env.DB.prepare('UPDATE settings SET value=?,updated_at=? WHERE key=?').bind(nextRaw,new Date().toISOString(),WAREHOUSE_HISTORY_IMPORT_KEY),env.DB.prepare('DELETE FROM goods_transaction_guards WHERE id=?').bind(guard)]);
 return next;
}
export async function importWarehouseHistoryChunk(body:Record<string,unknown>){
 if(await warehouseCoreBusy())fail('核心数据正在恢复，请等待完成后继续历史导入',409);
 if(!uuid(body.importId)||!Number.isSafeInteger(body.index)||(body.index as number)<0)fail('历史分段顺序或标识无效',409);
 if(!Array.isArray(body.rows)||!body.rows.length||body.rows.length>20)fail('每段历史须包含1至20条记录');
 const row=await stored(),metadata=await readWarehouseHistoryImport();
 if(!row||!metadata||metadata.id!==body.importId||metadata.status==='preparing')fail('导入批次已变化或核心数据尚未完成，请刷新核对',409);
 const rows=body.rows as Operation[],auditRows:Operation[]=[],goodsRows:Operation[]=[];
 for(const operation of rows){if(operation&&typeof operation==='object'&&'warehouseAuditRow' in operation){if(!metadata.auditTotal)fail('当前导入不接受分段审计记录');const audit=operation.warehouseAuditRow as unknown as Operation;validateAudit(audit);auditRows.push(audit);}else{validateBackupGoodsOperation(operation);goodsRows.push(operation);}}
 const auditReceived=(metadata.auditReceived??0)+auditRows.length;

 const bytes=new TextEncoder().encode(JSON.stringify(rows)),hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('');
 const index=body.index as number,receipt=metadata.receipts.find(item=>item.index===index);
 if(receipt){if(receipt.hash!==hash)fail('已导入分段内容发生变化',409);return {...metadata,received:receipt.received,nextIndex:receipt.nextIndex,status:receipt.status,receipts:metadata.receipts.slice(0,index+1)};}
 if(metadata.status!=='history'||index!==metadata.nextIndex||metadata.received+rows.length>metadata.total)fail('历史分段顺序或数量不匹配',409);
 if(auditReceived>(metadata.auditTotal??0)||metadata.received+rows.length-auditReceived>metadata.total-(metadata.auditTotal??0))fail('历史类型或数量不匹配',409);
 const aliasesRow=await env.DB.prepare('SELECT value FROM settings WHERE key=?').bind(LOCATION_ALIASES_KEY).first<{value:string}>(),aliases=parseLocationAliases(aliasesRow?.value);
 const received=metadata.received+rows.length,status=received===metadata.total?'complete':'history',next:WarehouseHistoryImport={...metadata,...(metadata.auditTotal?{auditReceived}:{}),received,nextIndex:index+1,status,receipts:[...metadata.receipts,{index,hash,received,nextIndex:index+1,status}]},guard='history-chunk:'+crypto.randomUUID();
 const statements=[env.DB.prepare('INSERT INTO goods_transaction_guards(id,valid) VALUES(?,CASE WHEN EXISTS(SELECT 1 FROM settings WHERE key=? AND value=?) AND (SELECT value FROM settings WHERE key=?) IS ? AND NOT EXISTS(SELECT 1 FROM settings WHERE key=?) THEN 1 ELSE 0 END)').bind(guard,WAREHOUSE_HISTORY_IMPORT_KEY,row.value,LOCATION_ALIASES_KEY,aliasesRow?.value??null,WAREHOUSE_CORE_RESTORE_LOCK_KEY)];
 for(const operation of goodsRows){const projected={...operation};for(const key of ['beforeCategory','afterCategory','beforeRows','afterRows','result'])projected[key]=remapSnapshotLocations(operation[key] as string|null|undefined,aliases);statements.push(env.DB.prepare('INSERT INTO goods_operations(id,kind,category_id,fingerprint,before_category,after_category,before_rows,after_rows,settlement_ids,result,created_at,restored_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').bind(projected.id,projected.kind,projected.categoryId,projected.fingerprint,projected.beforeCategory??null,projected.afterCategory,projected.beforeRows,projected.afterRows,projected.settlementIds,projected.result,projected.createdAt,projected.restoredAt??null));}
 for(const audit of auditRows){const remap=['箱件收货','箱件原操作'].includes(String(audit.entityType))?remapCartonRowSnapshot:remapSnapshotLocations;statements.push(env.DB.prepare('INSERT INTO audit_logs(id,user_id,user_name,action,entity_type,entity_id,operation_id,summary,before_snapshot,after_snapshot,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').bind(audit.id,audit.userId,audit.userName,audit.action,audit.entityType,audit.entityId,audit.operationId??null,audit.summary,remap(audit.beforeSnapshot as string|null,aliases)??null,remap(audit.afterSnapshot as string|null,aliases)??null,audit.createdAt));}
 if(status==='complete')statements.push(env.DB.prepare('UPDATE goods_transaction_guards SET valid=CASE WHEN (SELECT COUNT(*) FROM goods_operations)=? AND (?=0 OR (SELECT COUNT(*) FROM audit_logs)=?) THEN 1 ELSE 0 END WHERE id=?').bind(metadata.total-(metadata.auditTotal??0),metadata.auditTotal??0,metadata.auditTotal??0,guard));
 statements.push(env.DB.prepare('UPDATE settings SET value=?,updated_at=? WHERE key=?').bind(JSON.stringify(next),new Date().toISOString(),WAREHOUSE_HISTORY_IMPORT_KEY),env.DB.prepare('DELETE FROM goods_transaction_guards WHERE id=?').bind(guard));
 try{await env.DB.batch(statements);}catch{fail('历史数据或导入进度刚刚变化，本段未写入，请刷新重试',409);}
 return next;
}
