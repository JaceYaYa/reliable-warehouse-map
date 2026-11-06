import {getDb} from '../db';
import {settings} from '../db/schema';
import {GoodsFlowError} from './goods-flow';
import {OUTBOUND_PREVIEW_GUARD_SQL,outboundPreviewGuard,readCorrectedOutboundHistory} from './outbound-history-store';
import {OUTBOUND_CUSTOMER_PREFIX,type OutboundCorrection} from './outbound-history-corrections';
import {OUTBOUND_BILLING_DETAILS_PREFIX,type OutboundBillingDetails} from './outbound-billing-details';
import {layerPricingSettingsFromRows} from './layer-storage-store';
import {parseLayerReportQuery,readLayerStorageReport} from './layer-storage-report-store';
import {ensureLayerStorageCheckpoint} from './layer-storage-checkpoint';
import {validFreePeriodDate} from './storage-free-periods';
import {warehouseTodayDate} from './warehouse-time';
import {merchantOutboundHistory,merchantAliases,resolveMerchantName} from './merchant-identity';
type Body=Record<string,unknown>;
type User={id:number;displayName:string};
const hash=async(value:unknown)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value)))),v=>v.toString(16).padStart(2,'0')).join('');
async function context(key:string){
 const [history,settingRows]=await Promise.all([readCorrectedOutboundHistory(),getDb().select().from(settings)]),record=merchantOutboundHistory(history.records,settingRows).find(r=>r.key===key);
 if(!record)throw new GoodsFlowError('这条出货记录已撤销或不存在，请刷新核对',409);
 const locations=layerPricingSettingsFromRows({settings:settingRows,stocks:[],cartons:[]}).locations;
 return {record,settingRows,locations};
}
export async function outboundBillingDetailsContext(key:string){
 if(!key||key.length>500)throw new GoodsFlowError('请选择有效历史出货记录',400);
 const c=await context(key);return {record:c.record,revision:c.record.revision,locations:c.locations};
}
async function prepare(body:Body,user:User){
 if(Object.keys(body).some(k=>!['key','expectedRevision','customerName','locationCode','layer','inboundDate','outboundDate','fromDate','toDate','fromMonth','toMonth','asOf','previewToken'].includes(k)))throw new GoodsFlowError('修改信息包含未知字段',400);
 const customerName=typeof body.customerName==='string'?body.customerName.trim():'';
 if(typeof body.key!=='string'||!body.key||body.key.length>500||typeof body.expectedRevision!=='string'||body.expectedRevision.length>100000||!customerName||customerName.length>200||/[\u0000-\u001f\u007f]/u.test(customerName)||typeof body.locationCode!=='string'||!Number.isSafeInteger(body.layer)||Number(body.layer)<1||Number(body.layer)>10000||!validFreePeriodDate(body.inboundDate)||!validFreePeriodDate(body.outboundDate)||body.inboundDate>body.outboundDate||body.outboundDate>warehouseTodayDate())throw new GoodsFlowError('请填写有效客户、库位、正整数层及入出库日期；出库日期不得早于入库或晚于今天',400);
 const params=new URL('http://local/').searchParams;for(const key of ['fromDate','toDate','fromMonth','toMonth','asOf'])if(body[key]!==undefined){if(typeof body[key]!=='string')throw new GoodsFlowError('查询日期无效',400);params.set(key,body[key]);}
 let query;try{query=parseLayerReportQuery(params);}catch(e){throw new GoodsFlowError(e instanceof Error?e.message:'查询日期无效',400);}
 await ensureLayerStorageCheckpoint();const guard=await outboundPreviewGuard(),c=await context(body.key),{record}=c;
 if(body.expectedRevision!==record.revision)throw new GoodsFlowError('历史记录或计费资料已有变化，请关闭后重新打开并预览',409);
 if(!record.sourceRevision)throw new GoodsFlowError('原始记录校验信息不完整，请刷新核对',409);
 if(!c.locations.includes(body.locationCode))throw new GoodsFlowError('请选择现有有效库位，不能填写未知库位',400);
 const targetCustomer=resolveMerchantName(customerName,merchantAliases(c.settingRows));
 const changedCustomer=targetCustomer!==record.customerName||!!record.customerCorrectionConflict;
 const correction:OutboundCorrection={schemaVersion:1,key:record.key,customerName:targetCustomer,sourceRevision:record.sourceRevision,version:(record.correctionVersion??0)+(changedCustomer?1:0)};
 const details:OutboundBillingDetails={schemaVersion:1,key:record.key,sourceRevision:record.sourceRevision,version:(record.billingDetailsVersion??0)+1,customerName:targetCustomer,locationCode:body.locationCode,layer:Number(body.layer),inboundDate:body.inboundDate,outboundDate:body.outboundDate};
 const stamp=new Date().toISOString();
 const writes=[{key:OUTBOUND_BILLING_DETAILS_PREFIX+record.key,value:JSON.stringify(details),updatedAt:stamp},...(changedCustomer?[{key:OUTBOUND_CUSTOMER_PREFIX+record.key,value:JSON.stringify(correction),updatedAt:stamp}]:[])];
 const simulation=c.settingRows.filter(r=>!writes.some(w=>w.key===r.key)).concat(writes);
 const before=await readLayerStorageReport(query),after=await readLayerStorageReport(query,undefined,{settings:simulation});
 if(guard!==await outboundPreviewGuard())throw new GoodsFlowError('库存、历史记录、费率或归档账单已有变化，请重新预览',409);
 const affected=[...new Set([record.customerName,targetCustomer])],totals=(r:typeof before)=>affected.map(customerName=>{const total=r.totals.customerTotals.find(t=>t.customerName===customerName);return {customerName,feeUsd:total?.feeUsd??0,pendingCount:total?.pendingCount??0};});
 const previewToken=await hash([guard,record.revision,details,changedCustomer?correction:null,query,user.id]);
 const preview={previewToken,before:totals(before),after:totals(after),notices:['计费资料，原始出入库记录不变','只修正这条历史出货的计费客户、库位层和占用日期；实际库存、原始数量及归档账单保持原样','历史确认不代表已收款；所选账期内可计算占用统一按当前托层规则重算']};
 return {c,guard,writes,details,preview};
}
export async function previewOutboundBillingDetails(body:Body,user:User){return (await prepare(body,user)).preview;}
export async function saveOutboundBillingDetails(body:Body,user:User){
 const p=await prepare(body,user);if(body.previewToken!==p.preview.previewToken)throw new GoodsFlowError('预览已过期，请重新预览费用变化后保存',409);
 const db=getDb().$client,id=crypto.randomUUID(),stamp=new Date().toISOString();
 try{await db.batch([
  db.prepare(`INSERT INTO goods_transaction_guards(id,valid) VALUES (?,CASE WHEN (${OUTBOUND_PREVIEW_GUARD_SQL})=? THEN 1 ELSE 0 END)`).bind(id,p.guard),
  ...p.writes.map(w=>db.prepare('INSERT INTO settings(key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').bind(w.key,w.value,stamp)),
  db.prepare('INSERT INTO audit_logs(user_id,user_name,action,entity_type,entity_id,operation_id,summary,before_snapshot,after_snapshot,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').bind(user.id,user.displayName,'修改历史出货计费资料','历史出货计费资料',p.c.record.key,'outbound-billing-details:'+id,`${p.c.record.product}｜计费资料，原始出入库记录不变｜${p.details.customerName}｜${p.details.locationCode} 第${p.details.layer}层｜${p.details.inboundDate} 至 ${p.details.outboundDate}`,JSON.stringify({record:p.c.record,settings:p.c.settingRows.filter(r=>p.writes.some(w=>w.key===r.key))}),JSON.stringify({details:p.details,settings:p.writes,preview:p.preview}),stamp),
  db.prepare('DELETE FROM goods_transaction_guards WHERE id=?').bind(id),
 ]);}catch{throw new GoodsFlowError('库存、历史记录或计价资料已有变化，本次未保存，请重新预览',409);}
 return {...p.preview,saved:true};
}
