import {groupLayerOccupancy,type LayerOccupancy} from './layer-storage';
import {DEFAULT_PRICING_SETTINGS,PRICING_DEFAULTS_KEY,resolveStorageBillingPeriod} from './pricing';
import {CUSTOMER_PRICING_KEY_PREFIX,customerPricingProfiles} from './customer-pricing';
import {warehouseTodayDate} from './warehouse-time';
import {validFreePeriodDate} from './storage-free-periods';
import type{LayerHistoryIssue,LayerHistoryResult}from './layer-storage-history';
import type{LayerSettingsDTO,LayerStorageReport,LayerStorageReportRow}from './layer-storage-report-types';
import {projectStagingLayerOccupants,type StagingLayerPricing} from './staging-layer-pricing';
import {historicalLifetimeOccupants,correctedVerifiedOccupants,ownsHistoricalSource} from './outbound-history-corrections';
import type {OutboundHistoryRecord} from './outbound-history';
import {merchantAliases,resolveMerchantName} from './merchant-identity';
import {storageReportSections} from './storage-report-sections';
import {partitionHistoricalPallets,stableManualPallets} from './layer-pallet-portions';
import {projectOutboundBillingFacts} from './outbound-billing-details';

type Rule={rate:number|null;freeDays:number|null;reasons:string[]};
type SettingRow={key:string;value:string};
export type LayerStorageReportInput={settings:LayerSettingsDTO;settingsRows:SettingRow[];history:LayerHistoryResult;confirmedSettlements:Record<string,unknown>[];migratedConfirmedIds?:readonly number[];currentPalletCounts?:Record<string,number>;outboundHistory?:OutboundHistoryRecord[];stagingPricing?:StagingLayerPricing;fromDate?:string;toDate?:string;fromMonth?:string;toMonth?:string;asOf?:string;customers?:string[];q?:string};
const MS=86400000;
const days=(a:string,b:string)=>Math.max(0,Math.round((Date.parse(b+'T00:00:00Z')-Date.parse(a+'T00:00:00Z'))/MS));
const add=(d:string,n:number)=>{const s=new Date(Date.parse(d+'T00:00:00Z')+n*MS).toISOString();return /^\d{4}-/.test(s)?s.slice(0,10):null;};
const unique=(a:string[])=>[...new Set(a)];
const money=(n:number)=>Number(n.toFixed(2));
function numeric(raw:unknown,integer=false){if(typeof raw!=='number'&&typeof raw!=='string'||typeof raw==='string'&&!raw.trim())return null;const n=Number(raw);return Number.isFinite(n)&&n>=0&&n<=(integer?36500:1e6)&&(!integer||Number.isSafeInteger(n))?n:null;}
function pricingRules(rows:SettingRow[]){
 let rate:number|null=DEFAULT_PRICING_SETTINGS.defaultRatePerM3Day,freeDays:number|null=DEFAULT_PRICING_SETTINGS.defaultFreeDays;const reasons:string[]=[];
 const globals=rows.filter(r=>r.key===PRICING_DEFAULTS_KEY);
 if(globals.length>1){rate=null;freeDays=null;reasons.push('默认计价规则重复，需核对');}
 else if(globals[0]){try{const v=JSON.parse(globals[0].value);if(!v||typeof v!=='object'||Array.isArray(v))throw Error();if(v.defaultRatePerM3Day!==undefined)rate=numeric(v.defaultRatePerM3Day);if(v.defaultFreeDays!==undefined)freeDays=numeric(v.defaultFreeDays,true);if(rate===null||freeDays===null)reasons.push('默认费率或免租设置无效，需核对');}catch{rate=null;freeDays=null;reasons.push('默认计价规则损坏，需核对');}}
 return(customer:string):Rule=>{let r=rate,f=freeDays;const issues=[...reasons],values=rows.filter(v=>v.key===CUSTOMER_PRICING_KEY_PREFIX+customer);
  if(values.length>1)return{rate:null,freeDays:null,reasons:['客户计价规则重复，需核对']};
  if(values[0]){try{const v=JSON.parse(values[0].value);if(!v||typeof v!=='object'||Array.isArray(v)||v.customerName!==undefined&&String(v.customerName).trim()!==customer)throw Error();if(v.ratePerM3Day!==undefined&&v.ratePerM3Day!==null&&String(v.ratePerM3Day).trim()!=='')r=numeric(v.ratePerM3Day);if(v.freeDays!==undefined&&v.freeDays!==null&&String(v.freeDays).trim()!=='')f=numeric(v.freeDays,true);if(r===null||f===null)issues.push('客户费率或免租天数无效，需核对');}catch{r=null;f=null;issues.push('客户计价规则损坏，需核对');}}
  return{rate:r,freeDays:f,reasons:r!==null&&f!==null?[]:unique(issues)};
 };
}
const reasonLabels:Record<string,string>={'unclaimed-customer':'货物商家待认领'};
// Owner-approved migration rule: missing historical occupancy uses today's layers.
// This is a billing basis, not reconstructed historical evidence or a stock write.
const currentBasisCodes=new Set(['history-before-checkpoint','missing-checkpoint','invalid-checkpoint','invalid-physical-data','missing-physical-snapshot','source-snapshot-conflict','recorded-chain-mismatch','current-state-mismatch','backdated-physical-conflict','unmatched-undo','undo-crosses-checkpoint','metadata-effective-date-unknown','missing-business-date','unpaired-conversion','ambiguous-event-order','history-gap']);
const irrelevantUnitIssue=(i:LayerHistoryIssue)=>i.code==='arrival-cohort-unknown';
const matches=(issue:LayerHistoryIssue,g:LayerOccupancy,customerName:string,start:string,end:string)=>{
 if(issue.startDate>=end||issue.endDateExclusive<=start)return false;
 if(issue.customerName&&issue.customerName!==customerName)return false;
 if(issue.locationCode&&issue.locationCode!==g.locationCode&&!g.occupants.some(o=>o.physicalLocationCode===issue.locationCode))return false;
 if(issue.layer!==undefined&&issue.layer!==g.layer&&!g.occupants.some(o=>o.physicalLayer===issue.layer&&(!issue.locationCode||o.physicalLocationCode===issue.locationCode)))return false;
 if(issue.recordIds?.length&&!g.occupants.some(o=>issue.recordIds!.includes(o.id)))return false;
 return true;
};
export function isConfirmedLayerLegacyBill(record:Record<string,unknown>){
 if(record.settlementStatus!=='settled')return false;
 // Old domestic/non-return outbounds were automatically marked settled at $0.
 // Human confirmations increment the version; zero-valued human bills remain protected.
 const automatic=record.inboundSource!=='return'&&Number(record.feeUsd)===0&&record.version===0&&typeof record.createdAt==='string'&&record.settledAt===record.createdAt&&typeof record.operatedBy==='string'&&record.settledBy===record.operatedBy;
 return !automatic;
}
export function buildLayerStorageReport(input:LayerStorageReportInput):LayerStorageReport{
 const asOf=input.asOf??warehouseTodayDate();if(!validFreePeriodDate(asOf))throw Error('计算日期无效');
 const period=resolveStorageBillingPeriod({fromDate:input.fromDate,toDate:input.toDate,fromMonth:input.fromMonth,toMonth:input.toMonth,today:asOf}),readRule=pricingRules(input.settingsRows),confirmed=input.confirmedSettlements.filter(r=>isConfirmedLayerLegacyBill(r)&&!input.migratedConfirmedIds?.includes(Number(r.id))),customers=input.customers??[],query=(input.q??'').normalize('NFKC').trim().toLowerCase();
 if(period.periodStart>asOf)throw Error("起始月份不能晚于计算日期");
 const rawCurrent=input.settings.occupied.flatMap(g=>g.occupants);
 const shipmentRecords=stableManualPallets(input.outboundHistory??[],input.history.intervals,rawCurrent,input.currentPalletCounts,input.stagingPricing,input.history.lineage),aliases=merchantAliases(input.settingsRows);
 const names=new Map<string,string>(),rules=new Map<string,Rule>();
 const canonical=(name:string)=>{let value=names.get(name);if(value===undefined){value=resolveMerchantName(name,aliases);names.set(name,value);}return value;};
 const rule=(customer:string)=>{let value=rules.get(customer);if(!value){value=readRule(customer);rules.set(customer,value);}return value;};
 const currentById=new Map(rawCurrent.map(row=>[row.id,row])),currentByCustomerDate=new Map<string,typeof rawCurrent>();
 for(const row of rawCurrent){const key=JSON.stringify([canonical(row.customerName),row.inboundDate]),own=currentByCustomerDate.get(key)??[];own.push(row);currentByCustomerDate.set(key,own);}
 const visible=(_g:LayerOccupancy,c:string)=>!customers.length||customers.includes(c);
 const searchable=(g:LayerOccupancy,c:string)=>!query||[g.locationCode,String(g.layer),c,...g.occupants.flatMap(o=>[o.productName,o.sku,o.physicalLocationCode??''])].join(' ').normalize('NFKC').toLowerCase().includes(query);
 const createRows=(groups:LayerOccupancy[],start:string,end:string,issues:LayerHistoryIssue[],evidenceIds:string[],historical:boolean,calculationBasis:'history'|'current-occupancy'='history')=>groups.flatMap(group=>group.occupants.filter(o=>group.customers.some(c=>c.customerName===o.customerName)&&visible(group,o.customerName)&&searchable(group,o.customerName)).map(occupant=>{
  const g={...group,occupants:[occupant]},c={customerName:occupant.customerName,oldestInboundDate:occupant.inboundDate,products:[occupant.productName]},palletCount=occupant.palletCount??1,estimatedPallets=occupant.estimatedPallets??occupant.palletCount===undefined;
  const pricing=rule(c.customerName),share=100,reason=[...g.reviewReasons.filter(r=>r!=='unclaimed-customer'||!c.customerName).map(r=>reasonLabels[r]??r),...pricing.reasons],arrival=validFreePeriodDate(c.oldestInboundDate)?c.oldestInboundDate:null;
  if(!arrival||arrival>start)reason.push('实际入库日期缺失、无效或晚于占层日期');
  if(g.occupants.some(o=>o.customerName===c.customerName&&!validFreePeriodDate(o.inboundDate)))reason.push('同层货物存在无法核对的入库日期');
  for(const occupant of g.occupants)if(occupant.customerName===c.customerName&&occupant.stagingPricingReview)reason.push(occupant.stagingPricingReview);
  for(const issue of issues)if(matches(issue,g,c.customerName,start,end))reason.push(issue.message);
  // Confirmation was bookkeeping, never payment. Recalculate all computable
  // occupancy; immutable archived amounts do not block or offset this report.
  const currentReferences=(currentByCustomerDate.get(JSON.stringify([c.customerName,c.oldestInboundDate]))??[]).filter(raw=>g.occupants.some(o=>o.customerName===c.customerName&&raw.inboundDate===o.inboundDate&&ownsHistoricalSource({physicalId:raw.id} as OutboundHistoryRecord,o,start,input.stagingPricing??{origins:[],unresolvedStockIds:[]},input.history.lineage)));
  const charge=arrival&&pricing.freeDays!==null?add(arrival,pricing.freeDays):null;if(arrival&&pricing.freeDays!==null&&!charge)reason.push('免租到期日期超出可计算范围');
  const storageDays=days(start,end),billableDays=charge?days(start>charge?start:charge,end):0,shared=share===null?null:g.volumeM3*palletCount;
  if(!Number.isFinite(palletCount)||palletCount<0)reason.push('托盘数无效，需核对');
  let fee=reason.length||pricing.rate===null||pricing.freeDays===null||shared===null?null:shared*pricing.rate*billableDays;
  if(fee!==null&&(!Number.isFinite(fee)||fee>Number.MAX_SAFE_INTEGER)){fee=null;reason.push('金额超出可安全计算范围，需核对');}
  return{key:JSON.stringify([start,end,g.locationCode,g.layer,c.customerName,occupant.id,occupant.billingSection]),palletCount,estimatedPallets,section:occupant.billingSection??(!historical||currentReferences.length?'in_stock':'shipped'),recordIds:unique([...g.occupants.filter(o=>o.customerName===c.customerName).flatMap(o=>[o.id,...(o.sourcePhysicalId?[o.sourcePhysicalId]:[])]),...currentReferences.map(o=>o.id)]),locationCode:g.locationCode,layer:g.layer,customerName:c.customerName,percent:share,physicalLocations:[...new Map(g.occupants.filter(o=>o.customerName===c.customerName).map(o=>{const physical={locationCode:o.physicalLocationCode??o.locationCode,layer:o.physicalLayer??o.layer,staged:o.physicalLocationCode!==undefined};return [JSON.stringify(physical),physical] as const;})).values()],volumeM3:g.volumeM3,sharedVolumeM3:shared,products:[...c.products],skus:unique(g.occupants.filter(o=>o.customerName===c.customerName).map(o=>o.sku).filter(Boolean)),inboundDate:arrival,startDate:start,endDateExclusive:end,storageDays,billableDays,freeDays:pricing.freeDays,chargeStartDate:charge,ratePerM3Day:pricing.rate,feeUsd:fee===null?null:Number(fee.toFixed(8)),status:fee===null?'review':'verified',reviewReasons:unique(reason),evidenceIds:[...evidenceIds,...g.occupants.filter(o=>manualIds.has(o.sourcePhysicalId??o.id)&&o.physicalLocationCode!==undefined).map(o=>'manual-waiting-origin:'+(o.sourcePhysicalId??o.id).slice(6))],calculationBasis,overlappingBillIds:[]} satisfies LayerStorageReportRow;
 }));
 const rows:LayerStorageReportRow[]=[],currentOccupancyPeriods:Array<{startDate:string;endDateExclusive:string}>=[];
 const relevantOccupants=(rows:LayerOccupancy['occupants'],day?:string)=>{const normalized=rows.map(o=>({...o,customerName:canonical(o.customerName)})).filter(o=>!customers.length||customers.includes(o.customerName));return projectStagingLayerOccupants(normalized.map(o=>({...o,id:o.sourcePhysicalId??o.id})),input.stagingPricing??{origins:[],unresolvedStockIds:[]},input.settings.aliases,day).map((o,n)=>({...o,id:normalized[n].id}));};
 const currentOccupants=relevantOccupants(rawCurrent),allIssues=uniqueIssues([...input.history.issues,...input.history.intervals.flatMap(i=>i.issues)]).filter(i=>!irrelevantUnitIssue(i));
 const manualIds=new Set((input.stagingPricing?.originHistory??[]).filter(o=>o.operationId.startsWith('manual-waiting-origin:')).map(o=>'stock:'+o.stockId));
 const originDays=(input.stagingPricing?.originHistory??[]).flatMap(o=>[o.stagedAt,o.endedAt].filter((v):v is string=>!!v).map(v=>warehouseTodayDate(new Date(v))));
 const boundaries=unique([period.periodStart,period.periodEndExclusive,...originDays,...input.history.intervals.flatMap(i=>[i.startDate,i.endDateExclusive]),...shipmentRecords.flatMap(r=>[r.inboundDate,r.outboundDate]).filter(validFreePeriodDate),...allIssues.flatMap(i=>[i.startDate,i.endDateExclusive]),...currentOccupants.map(o=>o.inboundDate).filter(validFreePeriodDate)]).filter(d=>d>=period.periodStart&&d<=period.periodEndExclusive).sort();
 for(let n=0;n<boundaries.length-1;n++){
  const start=boundaries[n],end=boundaries[n+1],interval=input.history.intervals.find(i=>i.startDate<=start&&i.endDateExclusive>=end),issues=allIssues.filter(i=>i.startDate<end&&i.endDateExclusive>start);
  const fallbackIssues=issues.filter(i=>currentBasisCodes.has(i.code)),globalFallback=!interval||fallbackIssues.some(i=>!i.customerName&&!i.locationCode&&i.layer===undefined&&!i.recordIds?.length);
  const lifetime=relevantOccupants(historicalLifetimeOccupants(shipmentRecords,start,end),start);
  const currentAtDay=manualIds.size?[...currentOccupants.filter(o=>!manualIds.has(o.id)),...relevantOccupants(rawCurrent.filter(o=>manualIds.has(o.id)),start)]:currentOccupants;
  // Unknown historical dates belong in the third section, not in the same-layer
  // oldest-date clock of otherwise valid goods. Manual facts own their customer
  // projection; applying the older owner projection first duplicates portions.
  const palletBasis=(o:LayerOccupancy['occupants'][number])=>o.palletCount!==undefined?o:{...o,palletCount:currentById.get(o.sourcePhysicalId??o.id)?.palletCount??input.currentPalletCounts?.[o.sourcePhysicalId??o.id]??1,estimatedPallets:true};
  const physicalAtDay=correctedVerifiedOccupants((interval?.occupants??[]).map(palletBasis),shipmentRecords.filter(r=>!r.billingFactsManual&&!r.billingDetailsConflict),rawCurrent,start,end,input.stagingPricing,input.history.lineage);
  const correctedAtDay=projectOutboundBillingFacts(physicalAtDay,shipmentRecords,rawCurrent,start,end,input.stagingPricing,input.history.lineage).filter(o=>validFreePeriodDate(o.inboundDate));
  const current=groupLayerOccupancy([...currentAtDay.filter(o=>validFreePeriodDate(o.inboundDate)&&o.inboundDate<=start),...lifetime].map(palletBasis),input.settings.config,input.settings.zones,input.settings.aliases),historical=groupLayerOccupancy(relevantOccupants(partitionHistoricalPallets(correctedAtDay.map(palletBasis),shipmentRecords,rawCurrent,start,end,input.stagingPricing,input.history.lineage),start).map(palletBasis),input.settings.config,input.settings.zones,input.settings.aliases);
  const pairs=new Map<string,{current?:LayerOccupancy;historical?:LayerOccupancy;customer:string}>();
  for(const [basis,groups]of [['current',current],['historical',historical]] as const)for(const g of groups)for(const c of g.customers){const key=JSON.stringify([g.locationCode,g.layer,c.customerName]),pair=pairs.get(key)??{customer:c.customerName};pair[basis]=g;pairs.set(key,pair);}
  let usedCurrent=globalFallback;
  for(const pair of pairs.values()){
   const useCurrent=globalFallback||fallbackIssues.some(i=>[pair.current,pair.historical].some(g=>g&&matches(i,g,pair.customer,start,end))),group=useCurrent?pair.current:pair.historical;
   if(!group)continue;if(useCurrent)usedCurrent=true;
   const scoped={...group,customers:group.customers.filter(c=>c.customerName===pair.customer)};
   rows.push(...createRows([scoped],start,end,issues.filter(i=>!useCurrent||!currentBasisCodes.has(i.code)),useCurrent?[`current-occupancy:${asOf}`]:interval!.evidenceIds,true,useCurrent?'current-occupancy':'history'));
  }
  if(usedCurrent){const last=currentOccupancyPeriods.at(-1);if(last?.endDateExclusive===start)last.endDateExclusive=end;else currentOccupancyPeriods.push({startDate:start,endDateExclusive:end});}
 }
 for(const invalid of rawCurrent.filter(o=>!validFreePeriodDate(o.inboundDate))){const normalized={...invalid,customerName:canonical(invalid.customerName)},groups=groupLayerOccupancy([normalized],input.settings.config,input.settings.zones,input.settings.aliases);rows.push(...createRows(groups,period.periodStart,period.periodEndExclusive,[],[],false,'current-occupancy').map(row=>({...row,key:'invalid-current:'+invalid.id})));}
 const pending=uniqueIssues(rows.filter(r=>r.section==='in_stock'&&r.status==='review').map(r=>({code:'row-review',message:r.reviewReasons.join('；'),startDate:r.startDate,endDateExclusive:r.endDateExclusive,locationCode:r.locationCode,layer:r.layer,customerName:r.customerName})));
 // Present-day occupancy is a physical preview, not evidence for an earlier month.
 const currentGroups=groupLayerOccupancy(currentOccupants,input.settings.config,input.settings.zones,input.settings.aliases).filter(g=>g.customers.some(c=>visible(g,c.customerName)&&searchable(g,c.customerName))),currentEnd=add(asOf,1)??asOf,currentRows=createRows(currentGroups,asOf,currentEnd,[],[],false,'current-occupancy'),customerNames=unique(rows.map(r=>r.customerName));
 const customerTotals=customerNames.map(customerName=>{const own=rows.filter(r=>r.customerName===customerName);return{customerName,feeUsd:money(own.reduce((n,r)=>n+(r.feeUsd??0),0)),pendingCount:own.filter(r=>r.section==='in_stock'&&r.feeUsd===null).length};});
 const confirmedRecords=confirmed.filter(r=>!customers.length||customers.includes(canonical(String(r.customerName??'')))).map(r=>Object.fromEntries(['id','customerName','product','sku','locationCode','inboundDate','outboundAt','quantity','boxes','feeUsd','settledAt','settledBy','billingMode'].map(k=>[k,r[k]??null])));
 const sections=storageReportSections(rows,shipmentRecords.filter(r=>(!customers.length||customers.includes(r.customerName))&&(!query||[r.customerName,r.product,r.sku,r.locationCode].join(' ').normalize('NFKC').toLowerCase().includes(query))),rawCurrent.map(o=>({...o,customerName:canonical(o.customerName)})).filter(o=>(!customers.length||customers.includes(o.customerName))&&(!query||[o.customerName,o.productName,o.sku,o.locationCode].join(' ').normalize('NFKC').toLowerCase().includes(query))),period);
 return{sections,basis:'layer',customerProfiles:[...customerPricingProfiles(input.settingsRows).values()],asOf,period:{fromDate:period.fromDate,toDate:period.toDate,fromMonth:period.fromMonth,toMonth:period.toMonth,periodStart:period.periodStart,periodEndExclusive:period.periodEndExclusive},settings:input.settings,current:{layerCount:currentGroups.length,volumeM3:Number(currentRows.reduce((n,row)=>n+(row.sharedVolumeM3??0),0).toFixed(8)),dailyFeeUsd:money(currentRows.reduce((n,r)=>n+(r.feeUsd??0),0)),pendingCount:currentRows.filter(r=>r.feeUsd===null).length,rows:currentRows},rows,pending,totals:{verifiedFeeUsd:money(customerTotals.reduce((n,r)=>n+r.feeUsd,0)),complete:pending.length===0,pendingSegments:pending.length,customerTotals},coverage:{checkpointAt:input.history.checkpointAt,fromDate:input.history.coverageStart,currentOccupancyPeriods},confirmedHistory:{count:confirmedRecords.length,feeUsd:money(confirmedRecords.reduce((n,r)=>n+Number(r.feeUsd??0),0)),records:confirmedRecords}};
}
function uniqueIssues(issues:LayerHistoryIssue[]){const seen=new Set<string>();return issues.filter(i=>{const key=JSON.stringify([i.code,i.message,i.startDate,i.endDateExclusive,i.locationCode,i.layer,i.customerName,i.recordIds]);if(seen.has(key))return false;seen.add(key);return true;});}
