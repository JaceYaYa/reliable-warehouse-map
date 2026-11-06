import {requireUser} from '../../../../lib/auth';
import {isLayerStoragePricing} from '../../../../lib/storage-pricing-basis';
import {parseLayerReportQuery,readLayerStorageReport} from '../../../../lib/layer-storage-report-store';
import {OUTBOUND_CUSTOMER_PREFIX,type OutboundCorrection} from '../../../../lib/outbound-history-corrections';
import {OUTBOUND_PREVIEW_GUARD_SQL,outboundPreviewGuard} from '../../../../lib/outbound-history-store';
import {ensureLayerStorageCheckpoint} from '../../../../lib/layer-storage-checkpoint';
import {getDb} from '../../../../db';
const headers={'cache-control':'private, no-store'};
const fail=(error:string,status=400)=>Response.json({error},{status,headers});
const hash=async(value:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),v=>v.toString(16).padStart(2,'0')).join('');
async function handle(request:Request,save:boolean){
 const auth=await requireUser(request,'pricing.manage');if(auth.error)return auth.error;
 try{
  if(!await isLayerStoragePricing())return fail('请使用托层仓储计价后修改历史出货商家',409);
  const body=await request.json();if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['key','expectedRevision','customerName','fromDate','toDate','fromMonth','toMonth','asOf','previewToken'].includes(k)))return fail('修改信息包含未知字段');
  const customerName=typeof body.customerName==='string'?body.customerName.trim():'';
  if(!customerName||customerName.length>200||/[\u0000-\u001f\u007f]/u.test(customerName)||typeof body.key!=='string'||body.key.length>500||typeof body.expectedRevision!=='string'||body.expectedRevision.length>20000)return fail('请选择历史记录并填写有效商家');
  const params=new URL(request.url).searchParams;for(const k of['fromDate','toDate','fromMonth','toMonth','asOf'])if(body[k]!==undefined){if(typeof body[k]!=='string')return fail('查询日期无效');params.set(k,body[k]);}
  const query=parseLayerReportQuery(params);
  await ensureLayerStorageCheckpoint();const guard=await outboundPreviewGuard();
  const before=await readLayerStorageReport(query),record=before.outboundHistory?.find(r=>r.key===body.key);
  if(!record)return fail('这条出货记录已撤销或不存在，请刷新核对',409);
  if(record.revision!==body.expectedRevision)return fail('这条历史记录已有变化，请刷新后重新修改',409);
  const correction:OutboundCorrection={schemaVersion:1,key:record.key,customerName,version:(record.correctionVersion??0)+1,sourceRevision:record.sourceRevision!};
  const after=await readLayerStorageReport(query,correction);
  if(guard!==await outboundPreviewGuard())return fail('库存、费率或账单已有变化，请重新预览',409);
  const previewToken=await hash(JSON.stringify([guard,record.revision,customerName,query]));
  const affected=[...new Set([record.customerName,customerName])];
  const totals=(report:typeof before)=>affected.map(customerName=>({customerName,...(report.totals.customerTotals.find(c=>c.customerName===customerName)??{feeUsd:0,pendingCount:0})}));
  const result={record,customerName,period:before.period,before:totals(before),after:totals(after),previewToken,confirmedArchivePreserved:true,recalculatesConfirmed:true};
  if(!save)return Response.json(result,{headers});
  if(body.previewToken!==previewToken)return fail('预览已过期，请重新预览费用变化再保存',409);
  if(customerName===record.customerName)return Response.json({...result,saved:true},{headers});
  const db=getDb(),id=crypto.randomUUID(),stamp=new Date().toISOString(),key=OUTBOUND_CUSTOMER_PREFIX+record.key,value=JSON.stringify(correction);
  const previous=await db.$client.prepare('SELECT value,updated_at AS updatedAt FROM settings WHERE key=?').bind(key).first<{value:string;updatedAt:string}>();
  // Guard, overlay and audit are one atomic D1 batch. No physical source or bill
  // is ever updated. A concurrent stock/restore/rate/owner change aborts all writes.
  await db.$client.batch([
   db.$client.prepare(`INSERT INTO goods_transaction_guards(id,valid) VALUES (?,CASE WHEN (${OUTBOUND_PREVIEW_GUARD_SQL})=? THEN 1 ELSE 0 END)`).bind(id,guard),
   db.$client.prepare('INSERT INTO settings(key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').bind(key,value,stamp),
   db.$client.prepare('INSERT INTO audit_logs(user_id,user_name,action,entity_type,entity_id,operation_id,summary,before_snapshot,after_snapshot,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').bind(auth.user!.id,auth.user!.displayName,'修改历史出货商家','历史出货',record.key,'outbound-owner:'+id,`${record.product}｜商家 ${record.customerName||'未认领'} → ${customerName}｜所选区间费用按目标客户规则重算（含旧确认记录）；原始归档不变，确认不代表已收款`,JSON.stringify({record,setting:previous??null}),JSON.stringify({record:{...record,customerName},setting:{key,value,updatedAt:stamp},preview:result}),stamp),
   db.$client.prepare('DELETE FROM goods_transaction_guards WHERE id=?').bind(id),
  ]);
  return Response.json({...result,saved:true},{headers});
 }catch{return fail('记录或计价资料已有变化，未保存；请刷新后重新预览',409);}
}
export async function POST(request:Request){return handle(request,false);}
export async function PUT(request:Request){return handle(request,true);}
