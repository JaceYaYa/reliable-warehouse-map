import {and,count,desc,notInArray,sql} from "drizzle-orm";
import {getDb} from "../../../db";
import {auditLogs} from "../../../db/schema";
import {requireUser} from "../../../lib/auth";
import {readRecordFilters} from "../../../lib/record-filters";
import {auditFilterOptions,auditRecordConditions,auditLocationCondition} from "../../../lib/audit-record-filters";
import {goodsCreateUndoStates} from "../../../lib/goods-create-undo";
import {adminSettingUndoStates} from "../../../lib/admin-setting-undo";
import {hasPermission} from "../../../lib/permissions";
import {cartonUndoStates} from '../../../lib/carton-store';
export async function GET(req:Request){
 const auth=await requireUser(req,"audit.view");if(auth.error)return auth.error;
 const params=new URL(req.url).searchParams;let f;try{f=readRecordFilters(params);}catch(e){return Response.json({error:e instanceof Error?e.message:"筛选无效"},{status:400});}
 const page=Math.max(1,Math.floor(Number(params.get("page"))||1)),pageSize=Math.max(1,Math.min(100,Math.floor(Number(params.get("pageSize"))||50))),scope=notInArray(auditLogs.action,["入库","出库","移库","库存修改"]);
 const reverted=sql`(${auditLogs.action} LIKE '撤销%' OR ${auditLogs.action}='恢复' OR EXISTS(SELECT 1 FROM audit_logs undo WHERE (undo.action LIKE '撤销%' OR undo.action='恢复') AND undo.entity_type IN ('管理记录','原记录') AND undo.entity_id=CAST(${auditLogs.id} AS TEXT)) OR EXISTS(SELECT 1 FROM carton_operations co WHERE co.id=${auditLogs.operationId} AND co.restored_at IS NOT NULL))`;
 const filter=and(scope,auditRecordConditions(f),await auditLocationCondition(f.location),f.status==='restored'?reverted:f.status==='active'?sql`NOT ${reverted}`:undefined),db=getDb();
 const [logs,[{total}],filterOptions]=await Promise.all([db.select().from(auditLogs).where(filter).orderBy(desc(auditLogs.id)).limit(pageSize).offset((page-1)*pageSize),db.select({total:count()}).from(auditLogs).where(filter),auditFilterOptions(db,scope)]);
 const [goodsStates,settingStates,cartonStates]=await Promise.all([goodsCreateUndoStates(logs),adminSettingUndoStates(logs),cartonUndoStates(logs,auth.user!)]);
 const visibleLogs=logs.map(log=>{const state=cartonStates.get(log.id)??goodsStates.get(log.id)??settingStates.get(log.id),permitted=cartonStates.has(log.id)?true:goodsStates.has(log.id)?hasPermission(auth.user!,"stock.restore")&&(hasPermission(auth.user!,"stock.inbound")||hasPermission(auth.user!,"product.manage")):hasPermission(auth.user!,"pricing.manage");return{...log,canRestore:!!state?.canRestore&&permitted,restoreReason:state?permitted?state.restoreReason:"无撤销权限":log.action.startsWith('撤销')?"撤销痕迹保留":log.action==='修改密码'?"密码变更不能撤销":['删除','恢复'].includes(log.action)?"请到出入库记录处理":"此记录未保存可恢复的原值"};});
 return Response.json({logs:visibleLogs,filterOptions,pagination:{page,pageSize,total,totalPages:Math.max(1,Math.ceil(total/pageSize))}},{headers:{"cache-control":"private, no-store"}});
}
