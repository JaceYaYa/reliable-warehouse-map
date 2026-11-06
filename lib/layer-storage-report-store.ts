import {projectCartonRows} from './carton-pallets';
import {env} from 'cloudflare:workers';
import {STOCK_PALLET_AUDITS_SQL} from './stock-pallets';
import {automaticPalletRows} from './automatic-pallets';
import {buildOutboundHistory} from './outbound-history';
import {ensureLayerStorageCheckpoint} from './layer-storage-checkpoint';
import {getDb} from '../db';
import {stocks,cartonReceipts,settings,auditLogs,goodsOperations,cartonOperations,storageFeeSettlements,layerStorageCheckpoints} from '../db/schema';
import {layerPricingSettingsFromRows} from './layer-storage-store';
import {projectLayerStorageHistory} from './layer-storage-history';
import {buildLayerStorageReport} from './layer-storage-report';
import {resolveStorageBillingPeriod} from './pricing';
import {warehouseTodayDate} from './warehouse-time';
import {validFreePeriodDate} from './storage-free-periods';
import {eq,sql} from 'drizzle-orm';
import {LEGACY_WAITING_MOVE_AUDIT_PREDICATE} from './legacy-waiting-origins';
import {waitingPricingFromEvidence} from './manual-waiting-origins';
import {outboundHistoryQueries} from './outbound-history-store';
import {applyOutboundCorrections,type OutboundCorrection} from './outbound-history-corrections';
import {applyOutboundBillingDetails} from './outbound-billing-details';
import {merchantAliases,merchantPhysicalOwners,merchantOutboundHistory,merchantCurrentClaims} from './merchant-identity';
import {migratedLegacyBillIds} from './legacy-bill-migrations';
export type LayerReportSimulation={stocks?:Array<typeof stocks.$inferSelect>;cartons?:Array<typeof cartonReceipts.$inferSelect>;settings?:Array<typeof settings.$inferSelect>};
export type LayerReportQuery={fromDate?:string;toDate?:string;fromMonth?:string;toMonth?:string;asOf?:string;customers?:string[];q?:string;unclaimed?:boolean};
export function parseLayerReportQuery(params:URLSearchParams):LayerReportQuery{
 for(const k of params.keys())if(!['fromDate','toDate','fromMonth','toMonth','asOf','customer','q','unclaimed'].includes(k))throw Error('未知查询条件');
 for(const k of ['fromDate','toDate','fromMonth','toMonth','asOf','q','unclaimed'])if(params.getAll(k).length>1)throw Error('查询条件不能重复');
 const today=warehouseTodayDate(),asOf=params.get('asOf')??today;if(!validFreePeriodDate(asOf)||asOf>today)throw Error('计算日期无效或晚于今天');
 const q=params.get('q')??'',customers=params.getAll('customer');if(q.length>200||/[\u0000-\u001f\u007f]/u.test(q))throw Error('搜索内容格式不正确');
 if(customers.length>100||customers.some(c=>!c.trim()||c.length>500||/[\u0000-\u001f\u007f]/u.test(c)))throw Error('客户查询条件格式不正确');
 const fromDate=params.has('fromDate')?params.get('fromDate')!:undefined,toDate=params.has('toDate')?params.get('toDate')!:undefined;const fromMonth=params.has('fromMonth')?params.get('fromMonth')!:undefined,toMonth=params.has('toMonth')?params.get('toMonth')!:undefined;const period=resolveStorageBillingPeriod({fromDate,toDate,fromMonth,toMonth,today:asOf});if(period.periodStart>asOf)throw Error("起始月份不能晚于计算日期");
 if(params.has('unclaimed')&&(params.get('unclaimed')!=='1'||customers.length))throw Error('待认领查询不能与客户查询混用');
 return{fromDate,toDate,fromMonth,toMonth,asOf,customers:params.has('unclaimed')?['']:customers.map(c=>c.trim()),q:q.trim(),unclaimed:params.has('unclaimed')};
}
export async function readLayerStorageReport(query:LayerReportQuery,override?:OutboundCorrection,simulation?:LayerReportSimulation){
 const hint=await ensureLayerStorageCheckpoint();
 const asOf=query.asOf??warehouseTodayDate(),period=resolveStorageBillingPeriod({fromDate:query.fromDate,toDate:query.toDate,fromMonth:query.fromMonth,toMonth:query.toMonth,today:asOf}),db=getDb();
 // A date-only hint chooses the cheap migration path. Recheck the actual checkpoint
 // in the same transactional read as stock/settings; never rely on the hint for billing.
 const beforeCoverage=(cp:{capturedAt:string}|null|undefined)=>!cp||Number.isFinite(Date.parse(cp.capturedAt))&&period.periodEndExclusive<=new Date(Date.parse(warehouseTodayDate(new Date(cp.capturedAt))+'T00:00:00Z')+86400000).toISOString().slice(0,10);
 const fast=beforeCoverage(hint);
 // The category snapshots belong to undo. Billing replays the physical rows.
 const goodsHistoryQuery=()=>db.select({
  id:goodsOperations.id,kind:goodsOperations.kind,fingerprint:goodsOperations.fingerprint,
  beforeRows:goodsOperations.beforeRows,afterRows:goodsOperations.afterRows,
  result:goodsOperations.result,createdAt:goodsOperations.createdAt,restoredAt:goodsOperations.restoredAt,
 }).from(goodsOperations);
 const stageQuery=()=>goodsHistoryQuery().where(eq(goodsOperations.kind,'staging'));
 const moveQuery=()=>db.select({id:auditLogs.id,action:auditLogs.action,operationId:auditLogs.operationId,createdAt:auditLogs.createdAt,beforeSnapshot:auditLogs.beforeSnapshot,afterSnapshot:auditLogs.afterSnapshot}).from(auditLogs).where(sql.raw(LEGACY_WAITING_MOVE_AUDIT_PREDICATE));
 const readFast=()=>db.batch([db.select().from(stocks),db.select().from(cartonReceipts),db.select().from(settings),db.select().from(storageFeeSettlements),db.select().from(layerStorageCheckpoints),stageQuery(),...outboundHistoryQueries(),moveQuery()]);
 // The hint can prove a full read is needed. Avoid a discarded preliminary snapshot.
 let [stockRows,cartonRows,settingRows,settlements,checkpoints,stagingRows,outboundRows,cartonOutboundRows,directRows,moveRows]:Awaited<ReturnType<typeof readFast>>=fast?await readFast():[[],[],[],[],[],[],[],[],[],[]];
 let audits:typeof auditLogs.$inferSelect[]=[],goodsOps:Awaited<ReturnType<typeof goodsHistoryQuery>>=[],cartonOps:typeof cartonOperations.$inferSelect[]=[];
 if(!fast||!beforeCoverage(checkpoints.find(c=>c.id===1))){
  // Once real historical coverage is needed, keep its complete atomic snapshot.
  [stockRows,cartonRows,settingRows,settlements,checkpoints,audits,goodsOps,cartonOps,directRows]=await db.batch([db.select().from(stocks),db.select().from(cartonReceipts),db.select().from(settings),db.select().from(storageFeeSettlements),db.select().from(layerStorageCheckpoints),db.select().from(auditLogs),goodsHistoryQuery(),db.select().from(cartonOperations),outboundHistoryQueries()[2]]);
  moveRows=audits.filter(a=>a.action==='移库'||a.action==='恢复');
  stagingRows=goodsOps.filter(o=>o.kind==='staging');outboundRows=goodsOps.filter(o=>o.kind==='outbound');cartonOutboundRows=cartonOps.filter(o=>o.kind==='outbound');
 }
 stockRows=simulation?.stocks??stockRows;cartonRows=simulation?.cartons??cartonRows;settingRows=simulation?.settings??settingRows;
 const palletAudits=(await env.DB.prepare(STOCK_PALLET_AUDITS_SQL).all()).results as Record<string,unknown>[];
 const cartonPalletOperations=(await env.DB.prepare("SELECT kind,before_snapshot AS beforeSnapshot,after_snapshot AS afterSnapshot FROM carton_operations WHERE kind IN ('details','correction') AND restored_at IS NULL").all()).results as Array<{kind:string;beforeSnapshot:string|null;afterSnapshot:string|null}>;
 const effectiveCartons=projectCartonRows(cartonRows,cartonPalletOperations);
 const aliases=merchantAliases(settingRows),dto=layerPricingSettingsFromRows({settings:settingRows,stocks:stockRows,cartons:cartonRows,palletAudits,cartonPalletOperations}),checkpoint=checkpoints.find(c=>c.id===1)??null;
 for(const group of dto.occupied)for(const o of group.occupants){if(o.kind==='stock'){const s=stockRows.find(s=>'stock:'+s.id===o.id);o.physicalQuantity=s?.totalQuantity??0;o.physicalBoxes=s?.totalBoxes??0;}else{const receipt=cartonRows.find(r=>o.id.startsWith('carton:'+r.id+':'));const p=receipt?(JSON.parse(receipt.placements) as Array<{key:string;boxes:number}>).find(p=>'carton:'+receipt.id+':'+p.key===o.id):null;o.physicalQuantity=0;o.physicalBoxes=p?.boxes??0;}}
 const history=projectLayerStorageHistory({stocks:stockRows,cartons:cartonRows,audits,goodsOps,cartonOps,settlements,checkpoint:checkpoint?{capturedAt:checkpoint.capturedAt,value:checkpoint.value,auditHighId:checkpoint.auditHighId}:null,aliases:dto.aliases,periodStart:period.periodStart,periodEndExclusive:period.periodEndExclusive,includeQuantities:true,customerAliases:aliases,customerOwners:merchantPhysicalOwners(settingRows)});
 const rawOutboundHistory=buildOutboundHistory({settlements,goods:outboundRows,cartons:cartonOutboundRows,direct:directRows});
 const outboundHistory=merchantOutboundHistory(applyOutboundBillingDetails(applyOutboundCorrections(rawOutboundHistory,settingRows,override),settingRows),settingRows,history.lineage);
 const migratedConfirmedIds=[...migratedLegacyBillIds(settlements,rawOutboundHistory,outboundHistory,directRows,aliases)];
 const claims=merchantCurrentClaims(dto.occupied.flatMap(g=>g.occupants),settingRows,asOf,history.lineage);
 const waitingEvidence=[...directRows.map(r=>({...r,action:'出库'})),...outboundRows.map(r=>({...r,kind:'outbound'}))];
 const report=buildLayerStorageReport({settings:dto,settingsRows:settingRows,history,currentPalletCounts:Object.fromEntries([...automaticPalletRows(stockRows,settingRows,palletAudits).map(s=>['stock:'+s.id,s.palletCount]),...effectiveCartons.flatMap(r=>(JSON.parse(r.placements) as Array<{key:string;palletCount:number}>).map(p=>['carton:'+r.id+':'+p.key,p.palletCount]))]),confirmedSettlements:settlements,migratedConfirmedIds,stagingPricing:waitingPricingFromEvidence(stagingRows,moveRows,settingRows,stockRows,dto.aliases,waitingEvidence),outboundHistory:[...outboundHistory,...claims],...query,asOf});
 const q=query.q?.toLowerCase();return {...report,outboundHistory:outboundHistory.filter(r=>(!query.customers?.length||query.customers.includes(r.customerName))&&(!q||[r.customerName,r.product,r.sku,r.locationCode,r.order].some(v=>v.toLowerCase().includes(q))))};
}
