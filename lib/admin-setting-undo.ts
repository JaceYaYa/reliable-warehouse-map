import {env} from "cloudflare:workers";
import {eq,inArray} from "drizzle-orm";
import {getDb} from "../db";
import {auditLogs,settings} from "../db/schema";
import {hasPermission,type PermissionUser} from "./permissions";
import {PRICING_DEFAULTS_KEY} from "./pricing";
import {CUSTOMER_PRICING_KEY_PREFIX} from "./customer-pricing";
import {GoodsFlowError} from "./goods-flow";
import {LAYER_PRICING_KEY,emptyLayerPricingConfig,parseLayerPricingConfig} from './layer-storage';
type Row={key:string;value:string;updatedAt:string};
type Snapshot={schema:"admin-setting-v1";key:string;row:Row|null};
const supported=(key:string)=>key===PRICING_DEFAULTS_KEY||key===LAYER_PRICING_KEY||key.startsWith(CUSTOMER_PRICING_KEY_PREFIX);
const supportedAction=(action:string)=>['修改默认仓储计价','修改客户仓储计价','清除客户仓储计价','修改托层仓储计价'].includes(action);
const validAction=(key:string,action:string)=>supportedAction(action)&&(key===LAYER_PRICING_KEY)===(action==='修改托层仓储计价');
const validLayerRow=(key:string,row:Row|null)=>{if(key===LAYER_PRICING_KEY&&row)parseLayerPricingConfig(row.value);};
const snapshot=(raw:string|null):Snapshot|null=>{try{const s=JSON.parse(raw||'null');if(s?.schema!=='admin-setting-v1'||typeof s.key!=='string'||!supported(s.key)||!(s.row===null||typeof s.row?.value==='string'&&typeof s.row?.updatedAt==='string'&&s.row.key===s.key))return null;validLayerRow(s.key,s.row);return s;}catch{return null;}};
const guard=(id:string,key:string,row:Row|null)=>row?env.DB.prepare("INSERT INTO goods_transaction_guards(id,valid) VALUES (?,CASE WHEN EXISTS(SELECT 1 FROM settings WHERE key=? AND value=? AND updated_at=?) THEN 1 ELSE 0 END)").bind(id,key,row.value,row.updatedAt):env.DB.prepare("INSERT INTO goods_transaction_guards(id,valid) VALUES (?,CASE WHEN NOT EXISTS(SELECT 1 FROM settings WHERE key=?) THEN 1 ELSE 0 END)").bind(id,key);
const write=(key:string,row:Row|null)=>row?env.DB.prepare("INSERT INTO settings(key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").bind(key,row.value,row.updatedAt):env.DB.prepare("DELETE FROM settings WHERE key=?").bind(key);
type SettingAudit=Pick<typeof auditLogs.$inferSelect,'id'|'action'|'entityId'|'beforeSnapshot'|'afterSnapshot'>;
// A single bound fingerprint guards both original changes and undo links, without
// generating one SQL binding per historical event.
const layerHistorySql="SELECT COALESCE(json_group_array(json_object('id',id,'action',action,'entityId',entity_id,'beforeSnapshot',before_snapshot,'afterSnapshot',after_snapshot)), '[]') AS value FROM (SELECT id,action,entity_id,before_snapshot,after_snapshot FROM audit_logs WHERE action IN ('修改托层仓储计价','撤销管理设置') ORDER BY id)";
async function layerHistory(){const row=await env.DB.prepare(layerHistorySql).first<{value:string}>();const raw=row?.value??'[]';return {raw,logs:JSON.parse(raw) as SettingAudit[]};}
const sameRow=(a:Row|null,b:Row|null)=>a===null||b===null?a===b:a.key===b.key&&a.value===b.value&&a.updatedAt===b.updatedAt;
const layerValues=(row:Row|null)=>{const config=row?parseLayerPricingConfig(row.value):emptyLayerPricingConfig();return JSON.stringify({schemaVersion:config.schemaVersion,locations:config.locations});};
function layerUndoAvailable(log:SettingAudit,current:Row|null,history:SettingAudit[]){
 const events=history.filter(event=>{const before=snapshot(event.beforeSnapshot),after=snapshot(event.afterSnapshot);return before?.key===LAYER_PRICING_KEY&&after?.key===LAYER_PRICING_KEY;}),undone=new Set(history.filter(event=>event.action==='撤销管理设置').map(event=>event.entityId));
 const active=events.filter(event=>event.action==='修改托层仓储计价'&&!undone.has(String(event.id))).at(-1),latest=events.at(-1),after=snapshot(log.afterSnapshot);
 return active?.id===log.id&&!!latest&&!!after&&sameRow(current,snapshot(latest.afterSnapshot)!.row)&&layerValues(current)===layerValues(after.row);
}
export async function saveAuditedPricingSetting(user:{id:number;displayName:string},input:{key:string;value:string|null;action:string;entityType:string;entityId:string;summary:string;stamp:string;expectedRow:Row|null;expectedSettings?:Array<{key:string;row:Row|null}>}){
 if(!supported(input.key)||!validAction(input.key,input.action))throw new Error('Unsupported pricing setting');const before=input.expectedRow,after=input.value===null?null:{key:input.key,value:input.value,updatedAt:input.stamp},id=crypto.randomUUID();validLayerRow(input.key,before);validLayerRow(input.key,after);
 const expected=input.expectedSettings??[],guardIds=[id,...expected.map((_,index)=>`${id}:${index}`)];
 await env.DB.batch([guard(id,input.key,before??null),...expected.map((entry,index)=>guard(guardIds[index+1],entry.key,entry.row)),write(input.key,after),env.DB.prepare("INSERT INTO audit_logs(user_id,user_name,action,entity_type,entity_id,operation_id,summary,before_snapshot,after_snapshot,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(user.id,user.displayName,input.action,input.entityType,input.entityId,`setting-change:${id}`,input.summary,JSON.stringify({schema:'admin-setting-v1',key:input.key,row:before??null}),JSON.stringify({schema:'admin-setting-v1',key:input.key,row:after}),input.stamp),...guardIds.map(guardId=>env.DB.prepare("DELETE FROM goods_transaction_guards WHERE id=?").bind(guardId))]);
}
async function settingUndoContext(logs:readonly (typeof auditLogs.$inferSelect)[]){
 const candidates=logs.flatMap(log=>{const before=snapshot(log.beforeSnapshot),after=snapshot(log.afterSnapshot);return before&&after&&validAction(after.key,log.action)&&before.key===after.key?[{log,before,after}]:[]}),states=new Map<number,{canRestore:boolean;restoreReason:string}>();
 if(!candidates.length)return {states,rows:[] as Row[],history:null as Awaited<ReturnType<typeof layerHistory>>|null};
 const db=getDb(),[rows,undos,history]=await Promise.all([db.select().from(settings).where(inArray(settings.key,candidates.map(c=>c.after.key))),db.select({entityId:auditLogs.entityId}).from(auditLogs).where(eq(auditLogs.action,'撤销管理设置')),candidates.some(c=>c.after.key===LAYER_PRICING_KEY)?layerHistory():Promise.resolve(null)]);
 for(const c of candidates){const current=rows.find(r=>r.key===c.after.key)??null,reverted=undos.some(u=>u.entityId===String(c.log.id)),same=c.after.key===LAYER_PRICING_KEY?layerUndoAvailable(c.log,current,history!.logs):sameRow(current,c.after.row);states.set(c.log.id,{canRestore:!reverted&&same,restoreReason:reverted?'已撤销':same?'可撤销':'设置已有后续变化，请先撤销后续修改'});}
 return {states,rows,history};
}
export async function adminSettingUndoStates(logs:readonly (typeof auditLogs.$inferSelect)[]){return (await settingUndoContext(logs)).states;}
export async function restoreAdminSettingAudit(log:typeof auditLogs.$inferSelect,user:{id:number;displayName:string}&PermissionUser){
 const before=snapshot(log.beforeSnapshot),after=snapshot(log.afterSnapshot);if(!before||!after||!validAction(after.key,log.action))return null;
 if(!hasPermission(user,'pricing.manage'))return Response.json({error:'没有计价设置修改权限'},{status:403});
 if(before.key!==after.key)throw new GoodsFlowError('原管理记录不完整',400);const context=await settingUndoContext([log]),available=context.states.get(log.id);if(!available?.canRestore)throw new GoodsFlowError(available?.restoreReason||'该记录无法撤销');
 const id=`restore:setting:${log.id}`,stamp=new Date().toISOString();
 const layer=after.key===LAYER_PRICING_KEY,current=layer?context.rows.find(row=>row.key===LAYER_PRICING_KEY)??null:after.row;
 let restored=before.row;
 if(layer){
  const currentConfig=parseLayerPricingConfig(current!.value),prior=before.row?parseLayerPricingConfig(before.row.value):emptyLayerPricingConfig();
  if(currentConfig.revision>=Number.MAX_SAFE_INTEGER)throw new GoodsFlowError('配置版本已达上限，请联系管理员',400);
  restored={key:LAYER_PRICING_KEY,value:JSON.stringify({...prior,revision:currentConfig.revision+1}),updatedAt:stamp};
 }
 const beforeAudit=layer?JSON.stringify({schema:'admin-setting-v1',key:after.key,row:current}):log.afterSnapshot,afterAudit=layer?JSON.stringify({schema:'admin-setting-v1',key:before.key,row:restored}):log.beforeSnapshot;
 const historyGuards=layer?[env.DB.prepare(`INSERT INTO goods_transaction_guards(id,valid) VALUES (?,CASE WHEN (${layerHistorySql})=? THEN 1 ELSE 0 END)`).bind(`${id}:history`,context.history!.raw)]:[];
 await env.DB.batch([guard(id,after.key,current),...historyGuards,env.DB.prepare("INSERT INTO goods_transaction_guards(id,valid) VALUES (?,CASE WHEN EXISTS(SELECT 1 FROM audit_logs WHERE id=? AND operation_id=? AND before_snapshot=? AND after_snapshot=?) AND NOT EXISTS(SELECT 1 FROM audit_logs WHERE action='撤销管理设置' AND entity_id=?) THEN 1 ELSE 0 END)").bind(`${id}:source`,log.id,log.operationId,log.beforeSnapshot,log.afterSnapshot,String(log.id)),write(before.key,restored),env.DB.prepare("INSERT INTO audit_logs(user_id,user_name,action,entity_type,entity_id,operation_id,summary,before_snapshot,after_snapshot,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(user.id,user.displayName,'撤销管理设置','管理记录',String(log.id),id,`撤销原记录 ${log.id}｜${log.action}｜${log.entityId}`,beforeAudit,afterAudit,stamp),env.DB.prepare("DELETE FROM goods_transaction_guards WHERE id IN (?,?,?)").bind(id,`${id}:source`,`${id}:history`)]);
 return Response.json({ok:true,restoredAuditId:log.id});
}
