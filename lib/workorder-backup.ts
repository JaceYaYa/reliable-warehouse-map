import { WORKORDER_KINDS, WORKORDER_STATUSES } from './workorders/model';
type Row=Record<string,unknown>;
export function validateWorkorderBackup(data:{workOrders?:unknown;workOrderEvents?:unknown;workOrderFiles?:unknown}){
 const lists=[data.workOrders,data.workOrderEvents,data.workOrderFiles];
 if(lists.some(rows=>!Array.isArray(rows)))throw new Error("备份缺少工单、操作记录或附件索引");
 const [orders,events,files]=lists as Row[][];
 const strings=(row:Row,keys:readonly string[])=>keys.every(k=>typeof row[k]==="string");
 const integer=(row:Row,k:string,min=0)=>Number.isSafeInteger(row[k])&&Number(row[k])>=min;
 const unique=(rows:Row[],k:string)=>new Set(rows.map(r=>r[k])).size===rows.length;
 const json=(value:unknown)=>{if(typeof value!=="string")throw new Error("工单备份资料格式不正确");return JSON.parse(value);};
 if([orders,events,files].some(rows=>rows.some(row=>!row||typeof row!=="object"||Array.isArray(row)||typeof row.id!=="string"||!row.id)||!unique(rows,'id'))||!unique(orders,'number')||!unique(events,'mutationId'))throw new Error("工单备份编号缺失或重复");
 for(const row of orders){
  if(!strings(row,['number','kind','title','customerName','employeeBody','payload','fileIds','status','assignedTo','createdAt','updatedAt'])||!Object.hasOwn(WORKORDER_KINDS,String(row.kind))||!Object.hasOwn(WORKORDER_STATUSES,String(row.status))||!integer(row,'version')||!integer(row,'createdBy',1)||!integer(row,'updatedBy',1))throw new Error("工单备份格式不正确");
  const payload=json(row.payload),ids=json(row.fileIds);if(!payload||typeof payload!=="object"||Array.isArray(payload)||!Array.isArray(ids)||ids.some(id=>typeof id!=="string")||new Set(ids).size!==ids.length||ids.some(id=>!files.some(f=>f.id===id&&f.orderId===row.id)))throw new Error("工单资料或附件索引不完整");
 }
 for(const row of events){if(!strings(row,['orderId','action','userName','summary','mutationId','requestHash','result','createdAt'])||!row.mutationId||!integer(row,'userId',1)||!orders.some(o=>o.id===row.orderId))throw new Error("工单操作记录格式不正确");json(row.result);}
 for(const row of files)if(!strings(row,['orderId','objectKey','name','mime','hash','visibility','createdAt'])||!String(row.objectKey).startsWith('workorders/')||!['source','employee'].includes(String(row.visibility))||!integer(row,'size')||!integer(row,'createdBy',1))throw new Error("工单附件索引格式不正确");
}
