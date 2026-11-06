import {warehouseTodayDate} from '../../../lib/warehouse-time';
import {env} from "cloudflare:workers";
import {requireUser} from "../../../lib/auth";
import {hasPermission} from "../../../lib/permissions";
import {recordDateBoundary} from "../../../lib/record-filters";
import {WORKORDER_KINDS,WORKORDER_STATUSES,WorkorderError,boundedText,validateWorkPayload,workorderRisks,workorderUuid,type WorkorderKind} from "../../../lib/workorders/model";
import {checkWorkInventory,finishWorkGuard,requestHash,validateWorkFiles,validateWorkExecutionFiles,visibleWorkorder,workEvent,workGuard,workReplay,workSourceFingerprint,workFilesGuard,workorderResponseError,requireWorkWriteUser,validateWorkAssignee,type WorkorderRow} from "../../../lib/workorders/store";
export async function GET(request:Request){
 const auth=await requireUser(request,"workorders.view");if(auth.error)return auth.error;
 try{const p=new URL(request.url).searchParams,manage=hasPermission(auth.user!,"workorders.manage"),where:string[]=[manage?"1=1":"status IN ('ready','in_progress','completed','cancelled')"],values:(string|number)[]=[];
 for(const key of ['q','status','kind','customer','operator','from','to'])if((p.get(key)||'').length>500)throw new WorkorderError("筛选内容过长",400);
 const q=p.get('q')?.trim()||'',status=p.get('status')||'',kind=p.get('kind')||'',customer=p.get('customer')||'',operator=p.get('operator')||'',from=p.get('from')||'',to=p.get('to')||'';
 if(status&&!Object.hasOwn(WORKORDER_STATUSES,status)||kind&&!Object.hasOwn(WORKORDER_KINDS,kind))throw new WorkorderError("筛选状态或类别无效",400);if(from&&to&&from>to)throw new WorkorderError("开始日期不能晚于结束日期",400);
 if(customer&&!manage)throw new WorkorderError("无内部客户信息权限",403);
 if(q){where.push(`(instr(lower(title),lower(?))>0 OR instr(lower(number),lower(?))>0 OR instr(lower(employee_body),lower(?))>0${manage?' OR instr(lower(customer_name),lower(?))>0':''})`);values.push(q,q,q,...(manage?[q]:[]));}
 for(const [column,value]of [['status',status],['kind',kind],['customer_name',customer],['assigned_to',operator]])if(value){where.push(`${column}=?`);values.push(value);}
 let start,end;try{start=recordDateBoundary(from);end=recordDateBoundary(to,true);}catch(e){throw new WorkorderError(e instanceof Error?e.message:'日期无效',400);}if(start){where.push('julianday(created_at)>=julianday(?)');values.push(start);}if(end){where.push('julianday(created_at)<julianday(?)');values.push(end);}
 const page=Math.max(1,Math.floor(Number(p.get('page'))||1)),pageSize=Math.min(100,Math.max(1,Math.floor(Number(p.get('pageSize'))||30))),filter=where.join(' AND '),[rows,count]=await env.DB.batch([env.DB.prepare(`SELECT * FROM work_orders WHERE ${filter} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`).bind(...values,pageSize,(page-1)*pageSize),env.DB.prepare(`SELECT COUNT(*) total FROM work_orders WHERE ${filter}`).bind(...values)]);
 const orders=await Promise.all((rows.results as WorkorderRow[]).map(row=>visibleWorkorder(row,auth.user!)));return Response.json({orders,pagination:{page,pageSize,total:(count.results[0] as {total:number}).total},permissions:{manage,execute:hasPermission(auth.user!,'workorders.execute')}},{headers:{'cache-control':'private,no-store'}});
 }catch(e){return workorderResponseError(e);}
}
export async function POST(request:Request){const auth=await requireWorkWriteUser(request,'workorders.manage');if(auth.error)return auth.error;try{
 const body=await request.json() as Record<string,unknown>,mutationId=workorderUuid(body.mutationId),id=workorderUuid(body.id,'工单编号'),hash=await requestHash(body),replay=await workReplay(mutationId,hash,auth.user!.id);if(replay)return Response.json(replay);
 const title=boundedText(body.title,'标题',1000,true),employeeBody=boundedText(body.employeeBody,'员工正文',20000,true),customer=boundedText(body.customerName??'','内部客户',500),assigned=boundedText(body.assignedTo??'','安排员工',200),kind=String(body.kind) as WorkorderKind;if(!Object.hasOwn(WORKORDER_KINDS,kind))throw new WorkorderError('工单类别无效',400);
 if(body.status!==undefined&&body.status!=='draft'&&body.status!=='ready')throw new WorkorderError('创建时只能保存草稿或下达',400);
 await validateWorkAssignee(assigned);
 const payload=validateWorkPayload(body.payload),status=body.status==='ready'?'ready':'draft',risk=workorderRisks(payload,kind);if(status==='ready'&&(!payload.reviewed||risk.held||risk.unresolved.length||risk.issues.length))throw new WorkorderError('资料仍待核对，或存在暂停/来源冲突/数量问题，请先完善再下达',400);
 const files=await validateWorkFiles(id,body.fileIds??[]),inventory=status==='ready'?await checkWorkInventory(payload):{condition:'1=1',values:[]};if(status==='ready')validateWorkExecutionFiles(payload,employeeBody,files);
 payload.sourceFingerprint=await workSourceFingerprint(payload,files);
 const stamp=new Date().toISOString(),number=`WO-${warehouseTodayDate(new Date(stamp)).replaceAll('-','')}-${id.slice(0,8).toUpperCase()}`,result={ok:true,id,number,version:0,status},fileGuard=workFilesGuard(files);
 await env.DB.batch([workGuard(mutationId,`NOT EXISTS(SELECT 1 FROM work_orders WHERE id=?) AND (?='' OR NOT EXISTS(SELECT 1 FROM work_orders WHERE json_extract(payload,'$.sourceFingerprint')=?)) AND ${inventory.condition} AND ${fileGuard.condition}`,[id,payload.sourceFingerprint,payload.sourceFingerprint,...inventory.values,...fileGuard.values]),env.DB.prepare('INSERT INTO work_orders(id,number,kind,title,customer_name,employee_body,payload,file_ids,status,assigned_to,version,created_by,created_at,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,0,?,?,?,?)').bind(id,number,kind,title,customer,employeeBody,JSON.stringify(payload),JSON.stringify(files.map(f=>f.id)),status,assigned,auth.user!.id,stamp,auth.user!.id,stamp),workEvent({id:mutationId,orderId:id,action:status==='ready'?'下达':'保存草稿',user:auth.user!,summary:title,hash,result,stamp,after:{id,number,kind,title,customer_name:customer,employee_body:employeeBody,payload:JSON.stringify(payload),file_ids:JSON.stringify(files.map(f=>f.id)),status,assigned_to:assigned,version:0,created_by:auth.user!.id,created_at:stamp,updated_by:auth.user!.id,updated_at:stamp}}),finishWorkGuard(mutationId)]);return Response.json(result);
 }catch(e){return workorderResponseError(e);}}

