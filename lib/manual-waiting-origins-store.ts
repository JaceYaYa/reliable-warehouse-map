import {env} from 'cloudflare:workers';
import {getDb} from '../db';
import {stocks,settings,goodsOperations,auditLogs} from '../db/schema';
import {eq,sql} from 'drizzle-orm';
import {layerPricingSettingsFromRows} from './layer-storage-store';
import {LEGACY_WAITING_MOVE_AUDIT_PREDICATE} from './legacy-waiting-origins';
import {deriveStagingLayerPricing} from './staging-layer-pricing';
import {waitingPricingFromEvidence,waitingStockIdentity,readManualWaitingOrigins,WAITING_MANUAL_ORIGIN_PREFIX,type ManualWaitingOrigin} from './manual-waiting-origins';
import {resolveLocationAlias} from './location-aliases';
import {locationCodeKey} from './location-code';
import {parseLayerReportQuery} from './layer-storage-report-store';
import {resolveStorageBillingPeriod} from './pricing';
import {warehouseTodayDate} from './warehouse-time';
import {validFreePeriodDate} from './storage-free-periods';
import {GoodsFlowError} from './goods-flow';
import {merchantAliases,resolveMerchantName} from './merchant-identity';
type Body=Record<string,unknown>;
async function hash(value:unknown){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value))))).map(v=>v.toString(16).padStart(2,'0')).join('');}
async function context(){const db=getDb(),[stockRows,settingRows,stageRows,moveRows,auditHigh]=await db.batch([db.select().from(stocks),db.select().from(settings),db.select({id:goodsOperations.id,kind:goodsOperations.kind,fingerprint:goodsOperations.fingerprint,beforeRows:goodsOperations.beforeRows,afterRows:goodsOperations.afterRows,result:goodsOperations.result,createdAt:goodsOperations.createdAt,restoredAt:goodsOperations.restoredAt}).from(goodsOperations).where(eq(goodsOperations.kind,'staging')),db.select({id:auditLogs.id,action:auditLogs.action,operationId:auditLogs.operationId,createdAt:auditLogs.createdAt,beforeSnapshot:auditLogs.beforeSnapshot,afterSnapshot:auditLogs.afterSnapshot}).from(auditLogs).where(sql.raw(LEGACY_WAITING_MOVE_AUDIT_PREDICATE)),db.select({high:sql<number>`coalesce(max(${auditLogs.id}),0)`}).from(auditLogs)]),dto=layerPricingSettingsFromRows({stocks:stockRows,settings:settingRows,cartons:[]}),pricing=waitingPricingFromEvidence(stageRows,moveRows,settingRows,stockRows,dto.aliases),explicit=deriveStagingLayerPricing(stageRows),canonical=(c:string)=>locationCodeKey(resolveLocationAlias(c,dto.aliases)),owners=merchantAliases(settingRows),manuals=readManualWaitingOrigins(settingRows);
 const revision=await hash([stockRows,settingRows,stageRows,moveRows,auditHigh]);
 const records=stockRows.filter(s=>(s.totalQuantity>0||s.totalBoxes>0)&&canonical(s.locationCode)===canonical('待出库')).map(s=>{const origin=pricing.origins.find(o=>o.stockId===s.id),automatic=origin&&!origin.operationId.startsWith('manual-waiting-origin:'),corrupt=explicit.unresolvedStockIds.includes(s.id),manual=manuals.find(m=>m.stockId===s.id);return {stockId:s.id,customerName:resolveMerchantName(s.customerName,owners),product:s.product,sku:s.sku,inboundDate:s.inboundDate,physicalLocationCode:s.locationCode,physicalLayer:s.layerCount,quantity:s.totalQuantity,boxes:s.totalBoxes,canAssign:!automatic&&!corrupt,reason:automatic?'已自动找到原计费层，无需人工设置':corrupt?'备货原始证据损坏，请先核对原记录':'缺少可证明的原计费层，可人工指定计费依据',automaticOrigin:automatic?{locationCode:origin.locationCode,layer:origin.layer}:null,manual:manual??null};});
 return{stockRows,settingRows,stageRows,moveRows,auditHigh:Number(auditHigh[0]?.high??0),dto,pricing,canonical,revision,records};}
export async function manualWaitingOriginContext(customer?:string){const c=await context();return{revision:c.revision,records:c.records.filter(r=>customer===undefined||r.customerName===(customer==='__unclaimed__'?'':customer)),locations:c.dto.locations.filter(code=>c.canonical(code)!==c.canonical('待出库')),today:warehouseTodayDate()};}
async function prepare(body:Body,user:{id:number;displayName:string}){
 if(Object.keys(body).some(k=>!['stockId','expectedRevision','locationCode','layer','effectiveFrom','fromDate','toDate','fromMonth','toMonth','asOf','previewToken'].includes(k))||!Number.isSafeInteger(body.stockId)||Number(body.stockId)<=0||typeof body.expectedRevision!=='string'||typeof body.locationCode!=='string'||!Number.isSafeInteger(body.layer)||Number(body.layer)<1||Number(body.layer)>10000||!validFreePeriodDate(body.effectiveFrom))throw new GoodsFlowError('原计费层或生效日期格式无效',400);
 const params=new URL('http://local/').searchParams;for(const key of ['fromDate','toDate','fromMonth','toMonth','asOf'])if(body[key]!==undefined){if(typeof body[key]!=='string')throw new GoodsFlowError('查询日期无效',400);params.set(key,body[key]);}
 let query;try{query=parseLayerReportQuery(params);}catch(e){throw new GoodsFlowError(e instanceof Error?e.message:'查询日期无效',400);}
 const period=resolveStorageBillingPeriod({...query,today:query.asOf});
 const c=await context();if(body.expectedRevision!==c.revision)throw new GoodsFlowError('库存或计价资料已有变化，请刷新后重新预览',409);
 const record=c.records.find(r=>r.stockId===body.stockId),stock=c.stockRows.find(s=>s.id===body.stockId);if(!record||!stock)throw new GoodsFlowError('请选择当前待出库货物',400);if(!record.canAssign)throw new GoodsFlowError(record.reason,409);
 const location=c.dto.locations.find(code=>c.canonical(code)===c.canonical(String(body.locationCode)));if(!location||c.canonical(location)===c.canonical('待出库'))throw new GoodsFlowError('请选择有效的原计费库位，不能选择待出库',400);
 if(!validFreePeriodDate(stock.inboundDate)||body.effectiveFrom<stock.inboundDate||body.effectiveFrom>warehouseTodayDate())throw new GoodsFlowError('生效日期须在货物到仓日至今天之间',400);
 const values={stockId:stock.id,locationCode:location,layer:Number(body.layer),effectiveFrom:body.effectiveFrom},previewToken=await hash([c.revision,values,query,user.id]);
 const preview={...values,record,previewToken,period,notices:['这是人工计费依据修正，实际原库位尚无完整证明','仅从所选生效日起调整计费库位／层；保留实际位置、到仓日期和数量','以后找到可证明的自动来源时，自动来源优先；库存变化后需重新核对人工设置']};return{c,stock,values,preview};
}
export async function previewManualWaitingOrigin(body:Body,user:{id:number;displayName:string}){return(await prepare(body,user)).preview;}
export async function saveManualWaitingOrigin(body:Body,user:{id:number;displayName:string}){
 const {c,stock,values,preview}=await prepare(body,user);if(body.previewToken!==preview.previewToken)throw new GoodsFlowError('预览已变化，请重新预览后保存',409);
 const stamp=new Date().toISOString(),key=WAITING_MANUAL_ORIGIN_PREFIX+stock.id,before=c.settingRows.find(r=>r.key===key)??null,manual:ManualWaitingOrigin={schemaVersion:1,...values,physicalLocationCode:stock.locationCode,physicalLayer:stock.layerCount,assignedAt:stamp,assignedBy:user.displayName,stockVersion:stock.version,stockUpdatedAt:stock.updatedAt,identity:waitingStockIdentity(stock)},id=crypto.randomUUID(),guards=[];
 guards.push(env.DB.prepare("INSERT INTO goods_transaction_guards(id,valid) VALUES (?,CASE WHEN (SELECT COUNT(*) FROM settings)=? AND (SELECT coalesce(max(id),0) FROM audit_logs)=? AND EXISTS(SELECT 1 FROM stocks WHERE id=? AND version=? AND updated_at=? AND location_code=? AND customer_name=? AND inbound_date=? AND total_quantity=? AND total_boxes=?) THEN 1 ELSE 0 END)").bind(id,c.settingRows.length,c.auditHigh,stock.id,stock.version,stock.updatedAt,stock.locationCode,stock.customerName,stock.inboundDate,stock.totalQuantity,stock.totalBoxes));
 for(const [index,row] of c.settingRows.entries())guards.push(env.DB.prepare('INSERT INTO goods_transaction_guards(id,valid) VALUES (?,CASE WHEN EXISTS(SELECT 1 FROM settings WHERE key=? AND value=? AND updated_at=?) THEN 1 ELSE 0 END)').bind(id+':'+index,row.key,row.value,row.updatedAt));
 try{await env.DB.batch([...guards,env.DB.prepare('INSERT INTO settings(key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').bind(key,JSON.stringify(manual),stamp),env.DB.prepare('INSERT INTO audit_logs(user_id,user_name,action,entity_type,entity_id,operation_id,summary,before_snapshot,after_snapshot,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').bind(user.id,user.displayName,'设置待出库原计费层','待出库计费依据',String(stock.id),'manual-waiting-origin:'+id,`人工计费依据｜货物 ${stock.id}｜${values.locationCode} 第 ${values.layer} 层｜${values.effectiveFrom} 起生效；实际位置与库存未修改`,JSON.stringify({schema:'manual-waiting-origin-v1',row:before}),JSON.stringify({schema:'manual-waiting-origin-v1',manual}),stamp),...guards.map((_,index)=>env.DB.prepare('DELETE FROM goods_transaction_guards WHERE id=?').bind(index===0?id:id+':'+(index-1)))]);}catch{throw new GoodsFlowError('库存或计价资料已有变化，本次未保存，请重新预览',409);}
 return {...preview,saved:true};
}
