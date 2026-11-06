import type {LayerOccupant} from './layer-storage';
import {CUSTOMER_PRICING_KEY_PREFIX} from './customer-pricing.ts';
import {DEFAULT_PRICING_SETTINGS,PRICING_DEFAULTS_KEY} from './pricing.ts';
import {warehouseTodayDate} from './warehouse-time.ts';
import {locationCodeKey} from './location-code.ts';

export type StorageFreePeriodStatus = 'expired'|'near'|'free'|'review';
export type StorageFreePeriodRow = Pick<LayerOccupant,'id'|'kind'|'customerName'|'productName'|'sku'|'locationCode'|'layer'|'inboundDate'> & {
  palletCount?:number|null;estimatedPallets?:boolean;
  billingInboundDate:string|null;
  billingLocationCode?:string;billingLayer?:number;
  freeDays:number|null; freeUntilDate:string|null; chargeStartDate:string|null;
  daysRemaining:number|null; daysOverdue:number|null; status:StorageFreePeriodStatus; reviewReasons:string[];
};
export type StorageFreePeriodsResult = {
  arrivalPolicy?:'batch'|'layer';asOf:string; nearDays:number; rows:StorageFreePeriodRow[];
  summary:{expiredCount:number;nearCount:number;reviewCount:number};customers:string[];
};
type SettingsRow={key:string;value:string};
type CorrectionEvidence={kind:string;beforeRows:string;afterRows:string;result:string;restoredAt?:string|null};
type FreePeriodQuery={asOf?:string;nearDays?:number;customers?:string[];q?:string;status?:'all'|StorageFreePeriodStatus;unclaimed?:boolean};
const DAY_MS=86400000;
const statuses=['all','expired','near','free','review'];
const isFreeDays=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0&&value<=36500;

export function validFreePeriodDate(value:unknown):value is string {
  if(typeof value!=='string'||!/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value))return false;
  const time=Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time)&&new Date(time).toISOString().slice(0,10)===value;
}
function addDays(value:string,days:number):string|null {
  const result=new Date(Date.parse(`${value}T00:00:00Z`)+days*DAY_MS).toISOString();
  return /^\d{4}-/.test(result)?result.slice(0,10):null;
}
function validateQuery(query:FreePeriodQuery){
  const asOf=query.asOf??warehouseTodayDate(),nearDays=query.nearDays??7,status=query.status??'all',q=query.q??'',customers=query.customers??[];
  if(!validFreePeriodDate(asOf))throw Error('查询日期无效，请使用 YYYY-MM-DD');
  if(!isFreeDays(nearDays))throw Error('临近天数须为0至36500的整数');
  if(!statuses.includes(status))throw Error('查询状态无效');
  if(typeof q!=='string'||q.length>200||/[\u0000-\u001f\u007f]/u.test(q))throw Error('搜索内容无效（最多200字）');
  if(!Array.isArray(customers)||customers.length>100||customers.some(c=>typeof c!=='string'||!c.trim()||c.length>200||/[\u0000-\u001f\u007f]/u.test(c)))throw Error('客户查询条件无效');
  if(query.unclaimed!==undefined&&typeof query.unclaimed!=='boolean'||query.unclaimed&&customers.length)throw Error('客户查询条件不能同时选择待认领和指定客户');
  return {asOf,nearDays,status,q:q.trim(),customers:query.unclaimed?['']:customers.map(c=>c.trim())};
}
export function parseFreePeriodQuery(params:URLSearchParams):FreePeriodQuery {
  for(const key of params.keys())if(!['asOf','nearDays','customer','q','status','unclaimed'].includes(key))throw Error('未知查询条件');
  for(const key of ['asOf','nearDays','q','status','unclaimed'])if(params.getAll(key).length>1)throw Error('查询条件不能重复');
  const rawDays=params.get('nearDays');
  if(rawDays!==null&&!/^(?:0|[1-9]\d*)$/.test(rawDays))throw Error('临近天数须为0至36500的整数');
  const query:FreePeriodQuery={};
  if(params.has('asOf'))query.asOf=params.get('asOf')!;
  if(rawDays!==null)query.nearDays=Number(rawDays);
  if(params.has('q'))query.q=params.get('q')!;
  if(params.has('status'))query.status=params.get('status') as FreePeriodQuery['status'];
  if(params.has('customer'))query.customers=params.getAll('customer');
  if(params.has('unclaimed')){if(params.get('unclaimed')!=='1')throw Error('待认领查询条件无效');query.unclaimed=true;}
  validateQuery(query);return query;
}

function configuredFreeDays(rows:SettingsRow[]){
  let defaultFreeDays:number|null=DEFAULT_PRICING_SETTINGS.defaultFreeDays;
  const defaults=rows.find(row=>row.key===PRICING_DEFAULTS_KEY);
  if(defaults){
    try{const raw=JSON.parse(defaults.value);defaultFreeDays=isFreeDays(raw?.defaultFreeDays)?raw.defaultFreeDays:null;}catch{defaultFreeDays=null;}
  }
  const overrides=new Map<string,number|null>();
  for(const row of rows){
    if(!row.key.startsWith(CUSTOMER_PRICING_KEY_PREFIX))continue;
    const fallback=row.key.slice(CUSTOMER_PRICING_KEY_PREFIX.length).trim();
    try{
      const raw=JSON.parse(row.value),customerName=typeof raw?.customerName==='string'?raw.customerName.trim():fallback;
      if(!customerName)continue;
      const value=raw?.freeDays;
      // Null/blank means inherit the configured default, matching existing customer settings.
      if(value===null||value===undefined||(typeof value==='string'&&!value.trim()))continue;
      const numeric=typeof value==='string'?Number(value):value;
      overrides.set(customerName,isFreeDays(numeric)?numeric:null);
    }catch{if(fallback)overrides.set(fallback,null);}
  }
  return {defaultFreeDays,overrides};
}

/** Physical correction snapshots can reveal mixed arrivals; they cannot establish surviving FIFO cohorts. */
export function deriveFreePeriodArrivalReviewIds(occupants:readonly LayerOccupant[],operations:readonly CorrectionEvidence[]):string[]{
  const active=new Map(occupants.filter(row=>row.kind==='stock').map(row=>[row.id,row]));
  const review=new Set<string>();
  const rows=(raw:string):Record<string,unknown>[]=>{
    try{const parsed=JSON.parse(raw);return Array.isArray(parsed)?parsed.filter(row=>row&&typeof row==='object'&&!Array.isArray(row)):[];}catch{return [];}
  };
  const physicalId=(raw:unknown)=>typeof raw==='number'&&Number.isSafeInteger(raw)&&raw>0?`stock:${raw}`:null;
  const count=(raw:unknown):raw is number=>typeof raw==='number'&&Number.isSafeInteger(raw)&&raw>=0;
  for(const operation of operations){
    if(operation.kind!=='correction')continue;
    // Only a recorded restoration timestamp permits treating this correction as undone.
    if(typeof operation.restoredAt==='string'&&operation.restoredAt.trim()&&Number.isFinite(Date.parse(operation.restoredAt)))continue;
    const before=new Map(rows(operation.beforeRows).map(row=>[physicalId(row.id),row]));
    let effectiveDate:unknown;
    try{effectiveDate=JSON.parse(operation.result)?.effectiveDate;}catch{effectiveDate=undefined;}
    for(const after of rows(operation.afterRows)){
      const id=physicalId(after.id),current=id?active.get(id):undefined,previous=id?before.get(id):undefined;
      if(!id||!current||!previous)continue;
      const increased=['totalQuantity','totalBoxes'].some(key=>count(after[key])&&count(previous[key])&&after[key]>previous[key]);
      if(increased&&(!validFreePeriodDate(effectiveDate)||effectiveDate!==current.inboundDate))review.add(id);
    }
  }
  return [...active.keys()].filter(id=>review.has(id));
}

/** Pallet billing keeps each arrival clock; legacy callers may retain pooled layer deadlines. */
export function buildStorageFreePeriods(input:FreePeriodQuery&{occupants:readonly LayerOccupant[];settingsRows:SettingsRow[];arrivalReviewIds?:readonly string[];arrivalPolicy?:'batch'|'layer'}):StorageFreePeriodsResult {
  const query=validateQuery(input),{defaultFreeDays,overrides}=configuredFreeDays(input.settingsRows),ids=new Set<string>();
  const arrivalReviewIds=new Set(input.arrivalReviewIds??[]);
  const layerKey=(occupant:LayerOccupant)=>input.arrivalPolicy==='batch'?occupant.id:JSON.stringify([locationCodeKey(occupant.locationCode),occupant.layer,occupant.customerName.trim()]);
  const layers=new Map<string,{oldest:string|null;invalidDate:boolean;arrivalReview:boolean}>();
  for(const occupant of input.occupants){
    if(!occupant||typeof occupant.id!=='string'||!occupant.id||ids.has(occupant.id))throw Error('库存记录标识缺失或重复，请先核对');
    ids.add(occupant.id);
    const key=layerKey(occupant),group=layers.get(key)??{oldest:null,invalidDate:false,arrivalReview:false};
    if(!validFreePeriodDate(occupant.inboundDate))group.invalidDate=true;
    else if(!group.oldest||occupant.inboundDate<group.oldest)group.oldest=occupant.inboundDate;
    if(arrivalReviewIds.has(occupant.id))group.arrivalReview=true;
    layers.set(key,group);
  }
  const projected:StorageFreePeriodRow[]=input.occupants.map(occupant=>{
    const group=layers.get(layerKey(occupant))!;
    const customerName=typeof occupant.customerName==='string'?occupant.customerName.trim():'';
    const freeDays=overrides.has(customerName)?overrides.get(customerName)!:defaultFreeDays;
    const row:StorageFreePeriodRow={palletCount:occupant.palletCount===undefined?1:Number.isFinite(occupant.palletCount)&&occupant.palletCount>=0?occupant.palletCount:null,estimatedPallets:occupant.estimatedPallets||occupant.palletCount===undefined,id:occupant.id,kind:occupant.kind,customerName,productName:occupant.productName,sku:occupant.sku,locationCode:occupant.physicalLocationCode??occupant.locationCode,layer:occupant.physicalLayer??occupant.layer,billingLocationCode:occupant.locationCode,billingLayer:occupant.layer,inboundDate:occupant.inboundDate,
      billingInboundDate:group.invalidDate||group.arrivalReview?null:group.oldest,freeDays,freeUntilDate:null,chargeStartDate:null,daysRemaining:null,daysOverdue:null,status:'review',reviewReasons:[]};
    if(!customerName)row.reviewReasons.push('unclaimed-customer');
    if(group.invalidDate)row.reviewReasons.push('invalid-inbound-date');
    if(freeDays===null)row.reviewReasons.push('invalid-free-days');
    if(group.arrivalReview)row.reviewReasons.push('数量修正后的实际到仓批次不明确，免租日期待核对');
    if(occupant.stagingPricingReview)row.reviewReasons.push(occupant.stagingPricingReview);
    if(row.reviewReasons.length)return row;
    const start=addDays(row.billingInboundDate!,freeDays!);
    if(!start){row.reviewReasons.push('invalid-date-range');return row;}
    row.chargeStartDate=start;
    row.freeUntilDate=freeDays!>0?addDays(start,-1):null;
    const difference=Math.round((Date.parse(`${start}T00:00:00Z`)-Date.parse(`${query.asOf}T00:00:00Z`))/DAY_MS);
    row.daysRemaining=Math.max(0,difference);row.daysOverdue=Math.max(0,-difference);
    row.status=difference<=0?'expired':difference<=query.nearDays?'near':'free';
    return row;
  });
  const customers=[...new Set(projected.map(row=>row.customerName).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'zh-CN',{numeric:true}));
  const q=query.q.toLocaleLowerCase();
  const matched=projected.filter(row=>(!query.customers.length||query.customers.includes(row.customerName))&&(!q||[row.customerName,row.productName,row.sku,row.locationCode,row.billingLocationCode??'',row.inboundDate].some(value=>String(value).toLocaleLowerCase().includes(q))));
  const summary={expiredCount:matched.filter(row=>row.status==='expired').length,nearCount:matched.filter(row=>row.status==='near').length,reviewCount:matched.filter(row=>row.status==='review').length};
  const order={expired:0,near:1,review:2,free:3};
  const rows=matched.filter(row=>query.status==='all'||row.status===query.status).sort((a,b)=>a.customerName.localeCompare(b.customerName,'zh-CN',{numeric:true})||order[a.status]-order[b.status]||(a.chargeStartDate??'9999-12-31').localeCompare(b.chargeStartDate??'9999-12-31')||a.locationCode.localeCompare(b.locationCode,'zh-CN',{numeric:true})||b.layer-a.layer||a.id.localeCompare(b.id));
  return {...(input.arrivalPolicy==='batch'?{arrivalPolicy:'batch' as const}:{}),asOf:query.asOf,nearDays:query.nearDays,rows,summary,customers};
}
