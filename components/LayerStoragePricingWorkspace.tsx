"use client";

import {Fragment,useCallback,useEffect,useRef,useState,type ReactNode} from 'react';
import {validFreePeriodDate} from '../lib/storage-free-periods';
import {warehouseTodayDate} from '../lib/warehouse-time';
import type {LayerStorageReport,LayerStorageReportRow,UncalculableStorageRecord} from '../lib/layer-storage-report-types';
import {decodeLayerReport} from '../lib/layer-report-transport';
import type {LayerPricingConfig} from '../lib/layer-storage';
import type {CustomerPricingProfile} from '../lib/customer-pricing';
import {LayerPricingSettings} from './LayerPricingSettings';
import {palletLabel} from '../lib/pallet';
import {layerDisplayFees} from '../lib/layer-fee-rounding';
import {UnclaimedCustomerPicker} from './UnclaimedCustomerPicker';
import {OutboundBillingDetailsEditor} from './OutboundBillingDetailsEditor';
import {MerchantChangeWorkspace} from './MerchantChangeWorkspace';
import {WaitingBillingOriginWorkspace} from './WaitingBillingOriginWorkspace';
import type {OutboundHistoryRecord} from '../lib/outbound-history';
import './LayerStoragePricingWorkspace.css';

type Props={onNotice?:(message:string)=>void};
type Filters={fromDate:string;toDate:string;customer:string;q:string};
const money=(value:number|null|undefined)=>typeof value==='number'&&Number.isFinite(value)?`$${value.toFixed(2)}`:'待核对';
const displayNumber=new Intl.NumberFormat('zh-CN',{maximumSignificantDigits:6,useGrouping:false});
const number=(value:number|null|undefined)=>typeof value==='number'&&Number.isFinite(value)?displayNumber.format(value):'待核对';
const rate=(value:number|null|undefined)=>typeof value==='number'&&Number.isFinite(value)?`$${value}`:'待核对';
const queryFor=(filters:Filters)=>{const query=new URLSearchParams({fromDate:filters.fromDate,toDate:filters.toDate});if(filters.customer==='__unclaimed__')query.set('unclaimed','1');else if(filters.customer.trim())query.append('customer',filters.customer.trim());if(filters.q.trim())query.set('q',filters.q.trim());return query.toString();};
async function request<T>(url:string,options:RequestInit={}):Promise<T>{
 const response=await fetch(url,{...options,cache:'no-store'});
 const value=await response.json();
 if(!response.ok)throw Error(typeof value?.error==='string'?value.error:response.status===403?'仅老板可查看托层计价':response.status===401?'登录已失效，请重新登录':'读取或保存失败，请重试');
 return value as T;
}
function sortLocationRows(rows:LayerStorageReportRow[],amounts:ReturnType<typeof layerDisplayFees>){
 const groups=new Map<string,LayerStorageReportRow[]>();for(const row of rows){const key=JSON.stringify([row.customerName,row.locationCode]),own=groups.get(key)??[];own.push(row);groups.set(key,own);}
 const total=(items:LayerStorageReportRow[])=>items.some(row=>amounts.get(row.key)===null)?-Infinity:Math.round(items.reduce((sum,row)=>sum+(amounts.get(row.key)??0),0)*100);
 return [...groups.values()].sort((a,b)=>a[0].customerName.localeCompare(b[0].customerName,'zh-CN')||(total(b)-total(a)||0)||a[0].locationCode.localeCompare(b[0].locationCode,'zh-CN',{numeric:true})).flat();
}
function layerRows(rows:LayerStorageReportRow[],preview=false,customerRule?:(customer:string,rows:LayerStorageReportRow[])=>ReactNode,rowActions?:(row:LayerStorageReportRow)=>ReactNode,allRows=rows,roundingRows=allRows,expanded=false){
 const amounts=layerDisplayFees(roundingRows);
 if(!expanded){
  const clients=new Map<string,LayerStorageReportRow[]>();for(const row of sortLocationRows(rows,amounts)){const own=clients.get(row.customerName)??[];own.push(row);clients.set(row.customerName,own);}
  const sum=(items:LayerStorageReportRow[])=>items.some(row=>amounts.get(row.key)===null)?null:items.reduce((n,row)=>n+(amounts.get(row.key)??0),0);
  const palletRange=(items:LayerStorageReportRow[])=>{if(items.some(row=>row.palletCount===undefined))return '托数见明细';const points=new Map<string,number>();for(const row of items){points.set(row.startDate,(points.get(row.startDate)??0)+row.palletCount!);points.set(row.endDateExclusive,(points.get(row.endDateExclusive)??0)-row.palletCount!);}const events=[...points].sort(([a],[b])=>a.localeCompare(b));let current=0;const values:number[]=[];for(let i=0;i<events.length-1;i++){current+=events[i][1];if(events[i+1][0]>events[i][0])values.push(Number(current.toPrecision(12)));}const min=Math.min(...values),max=Math.max(...values);return values.length?(min===max?(min>0&&min<1e-7?number(min):palletLabel(min)):number(min)+'～'+number(max))+' 托':'托数见明细';};
  return <div className="lsp-location-tree">{[...clients].map(([customer,items])=>{const all=allRows.filter(row=>row.customerName===customer),locations=new Map<string,LayerStorageReportRow[]>();for(const row of items){const own=locations.get(row.locationCode)??[];own.push(row);locations.set(row.locationCode,own);}return <section key={customer} className="lsp-tree-customer" data-layer-customer={customer}><header><div><strong>{customer||'未认领 · 待核对'}</strong>{!preview&&customerRule?.(customer,all)}</div><strong>{preview?'日费':'本期'} {money(sum(all))}</strong></header>{[...locations].map(([location,records])=>{const layers=new Map<number,LayerStorageReportRow[]>();for(const row of records){const own=layers.get(row.layer)??[];own.push(row);layers.set(row.layer,own);}return <details className="lsp-location-group" key={location} data-location-row={JSON.stringify([customer,location])}><summary><span className="lsp-tree-arrow" aria-hidden="true">▸</span><strong>{location}</strong><span>{layers.size} 层 · {palletRange(records)}</span><strong className="lsp-money">{money(sum(records))}</strong></summary><div className="lsp-location-body">{[...layers].sort(([a],[b])=>b-a).map(([layer,batches])=><details className="lsp-layer-group" key={layer} data-location-layer={layer}><summary><span className="lsp-tree-arrow" aria-hidden="true">▸</span><strong>第 {layer} 层</strong><span>{palletRange(batches)} · {batches.length} 条批次／时段</span><strong className="lsp-money">{money(sum(batches))}</strong></summary>{layerRows(batches,preview,undefined,rowActions,batches,roundingRows,true)}</details>)}</div></details>})}</section>})}</div>;
 }
 rows=rows.map(row=>({...row,feeUsd:amounts.get(row.key)??null}));
 const groups=new Map<string,LayerStorageReportRow[]>();
 for(const row of rows){const group=groups.get(row.customerName)??[];group.push(row);groups.set(row.customerName,group);}
 return <div className="lsp-table-scroll"><table className="lsp-table"><thead><tr><th>库位 / 层</th><th>批次到仓 / 免租</th><th>托数 / 计费体积</th><th>计费日 / 占层天数</th><th>计算价格</th></tr></thead><tbody>{[...groups].map(([customer,items])=>{
 const allItems=allRows.filter(r=>r.customerName===customer),verified=allItems.reduce((sum,row)=>sum+(amounts.get(row.key)??0),0),pending=allItems.filter(row=>row.status==='review').length,fullLayerCount=new Set(allItems.map(r=>JSON.stringify([r.locationCode,r.layer]))).size;
 const layers=new Map<string,LayerStorageReportRow[]>();for(const row of items){const key=row.key,own=layers.get(key)??[];own.push(row);layers.set(key,own);}
 return <Fragment key={customer}>{!expanded&&<tr className="lsp-customer-group" data-layer-customer={customer}><td colSpan={5}><div><div><strong>{customer||'未认领 · 待核对'}</strong>{!preview&&customerRule?.(customer,items)}<span>占用 {fullLayerCount} 层 · 各批次独立计费和免租</span></div><div><strong>{pending?'本期待核对':`${preview?'日费':'本期'} ${money(verified)}`}</strong>{pending>0&&<small>已计算 {money(verified)} · 另有 {pending} 条待核对</small>}</div></div></td></tr>}{[...layers.values()].map(segments=>{
 const physicalLocations=[...new Map(segments.flatMap(segment=>segment.physicalLocations??[]).map(position=>[JSON.stringify([position.locationCode,position.layer,position.staged]),position])).values()],staged=physicalLocations.some(position=>position.staged);
 const first=segments[0],arrival=segments.map(x=>x.inboundDate).filter((x):x is string=>!!x).sort()[0]??null,reviewReasons=[...new Set(segments.flatMap(x=>x.reviewReasons))],fee=segments.some(x=>x.feeUsd===null)?null:segments.reduce((n,x)=>n+x.feeUsd!,0),volumeValues=[...new Set(segments.map(x=>x.volumeM3))],row={...first,inboundDate:arrival,chargeStartDate:segments.map(x=>x.chargeStartDate).filter((x):x is string=>!!x).sort()[0]??null,feeUsd:fee,startDate:segments.map(x=>x.startDate).sort()[0],endDateExclusive:segments.map(x=>x.endDateExclusive).sort().at(-1)!,overlappingBillIds:[...new Set(segments.flatMap(x=>x.overlappingBillIds??[]))],products:[...new Set(segments.flatMap(x=>x.products))],skus:[...new Set(segments.flatMap(x=>x.skus))],storageDays:segments.reduce((n,x)=>n+x.storageDays,0),billableDays:segments.reduce((n,x)=>n+x.billableDays,0),reviewReasons};
 return <tr key={first.key} data-layer-row={first.key} className={fee===null?'lsp-row-review':undefined}>
  <td data-label="库位 / 层"><strong>{row.locationCode}</strong><span>第 {row.layer} 层</span>{staged&&<small className="lsp-staging-note">待出库沿用原层计价</small>}{segments.some(s=>s.evidenceIds.some(id=>id.startsWith('manual-waiting-origin:')))&&<small>人工指定原层</small>}</td>
  <td data-label="批次到仓 / 免租"><strong>{row.inboundDate||'待核对'}</strong><small>{row.freeDays===null?'免租天数待核对':row.freeDays===0?'无免租期':`免租 ${row.freeDays} 天`}{row.chargeStartDate?` · ${row.chargeStartDate} 起计费`:''}</small><details className="lsp-row-details"><summary>查看货物与计费明细</summary><span>客户：{row.customerName||'未认领 · 待核对'}</span><span>{row.products.join('、')||'货物名称待补充'}</span><span>SKU：{row.skus.join('、')||'无'}</span>{physicalLocations.length>0&&<span className="lsp-physical-locations">该时段实物位置：{physicalLocations.map(position=>`${position.locationCode} 第 ${position.layer} 层${position.staged?'（待出库）':''}`).join('；')}</span>}{segments.map(segment=><small key={segment.key}>{segment.startDate} 至 {segment.endDateExclusive}（不含） · 批次到仓日 {segment.inboundDate||'待核对'} · {number(segment.palletCount)} 托 × {number(segment.volumeM3)} m³/托 · 计费 {segment.billableDays} 天 · {money(segment.feeUsd)}{segment.calculationBasis==='current-occupancy'?' · 按当前占层计算':''}</small>)}</details></td>
  <td data-label="托数 / 计费体积"><strong>{number(row.palletCount)} 托 · {volumeValues.map(number).join(' / ')} m³/托</strong><span>计费体积 {number(row.sharedVolumeM3)} m³</span>{row.estimatedPallets&&<small>历史托数估算</small>}<small>托数 × 每托体积</small></td>
  <td data-label="计费日 / 占层天数"><strong>计费 {number(row.billableDays)} 天</strong><span>占层 {number(row.storageDays)} 天</span></td>
  <td data-label="计算价格"><strong className={row.feeUsd===null?'lsp-pending-text':'lsp-money'}>{money(row.feeUsd)}</strong><span>{preview?'日费':'本期费用'}</span><span className="lsp-rate">费率 {rate(row.ratePerM3Day)} / m³ / 天</span>{row.reviewReasons.length>0&&<small className="lsp-pending-text">{row.reviewReasons.join('；')}</small>}{!preview&&rowActions?.(row)}</td>
 </tr>})}</Fragment>;
 })}</tbody></table></div>;
}

export function LayerStoragePricingWorkspace({onNotice}:Props){
 const [filters,setFilters]=useState<Filters>(()=>{const today=warehouseTodayDate();return {fromDate:today.slice(0,7)+'-01',toDate:today,customer:'',q:''};});
 const [query,setQuery]=useState('');
 const [loadedReport,setLoadedReport]=useState<{query:string;data:LayerStorageReport}|null>(null),[loading,setLoading]=useState(false),[error,setError]=useState(''),[filterError,setFilterError]=useState('');
 // A report and its actions are available only after this exact query succeeds.
 const data=!loading&&!error&&loadedReport?.query===query?loadedReport.data:null;
 const [directory,setDirectory]=useState<{customers:string[];unclaimedCount:number;historicalCustomers?:string[]}>({customers:[],unclaimedCount:0}),[directoryLoading,setDirectoryLoading]=useState(true),[directoryError,setDirectoryError]=useState(''),[directoryReload,setDirectoryReload]=useState(0),[page,setPage]=useState(0);
 const [outboundPage,setOutboundPage]=useState(0),[shippedPage,setShippedPage]=useState(0),[uncalculablePage,setUncalculablePage]=useState(0);
 const [billingEditing,setBillingEditing]=useState<OutboundHistoryRecord|null>(null);
 const [merchantOpen,setMerchantOpen]=useState(false);
 const [waitingOriginOpen,setWaitingOriginOpen]=useState(false);
 const reportSequence=useRef(0),appliedQuery=useRef(query),profileSequence=useRef(0),profileRequest=useRef(false);
 const [profileCustomer,setProfileCustomer]=useState(''),[loadedCustomer,setLoadedCustomer]=useState('');
 const [profileRate,setProfileRate]=useState(''),[profileDays,setProfileDays]=useState('');
 const [profileBusy,setProfileBusy]=useState(false),[profileError,setProfileError]=useState(''),[profileNotice,setProfileNotice]=useState('');
 const [defaultsLoaded,setDefaultsLoaded]=useState(false),[defaultsBusy,setDefaultsBusy]=useState(false);
 const [defaultRate,setDefaultRate]=useState(''),[defaultDays,setDefaultDays]=useState('');
 const [defaultsError,setDefaultsError]=useState(''),[defaultsNotice,setDefaultsNotice]=useState('');
 const defaultsRequest=useRef(false);
 const loadReport=useCallback(async(currentQuery:string,signal?:AbortSignal)=>{
  const selected=new URLSearchParams(currentQuery);
  if(!currentQuery||(!selected.get('customer')&&selected.get('unclaimed')!=='1')){setLoading(false);return;}
  const sequence=++reportSequence.current;
  try{
   const next=decodeLayerReport(await request<unknown>(`/api/pricing/layers/report?${currentQuery}`,{signal,headers:{accept:'application/vnd.wms.layer-report+json'}}));
   if(!next||next.basis!=='layer'||!Array.isArray(next.rows)||!next.settings?.config||!next.totals||!next.current||!Array.isArray(next.pending))throw Error('托层报告资料不完整，请刷新重试');
   if(sequence===reportSequence.current&&!signal?.aborted&&currentQuery===appliedQuery.current){setLoadedReport({query:currentQuery,data:next});setError('');setLoading(false);}
  }catch(cause){if(sequence===reportSequence.current&&!signal?.aborted){setError(cause instanceof Error?cause.message:'托层报告读取失败，请重试');setLoading(false);}throw cause;}
 },[]);
 useEffect(()=>{
  const controller=new AbortController();
  void request<{customers:string[];unclaimedCount:number;historicalCustomers?:string[]}>('/api/pricing/customers',{signal:controller.signal}).then(next=>{if(!controller.signal.aborted){if(!Array.isArray(next.customers)||!Number.isSafeInteger(next.unclaimedCount))throw Error('客户名单读取失败');setDirectory(next);setDirectoryLoading(false);setDirectoryError('');}}).catch(cause=>{if(!controller.signal.aborted){setDirectoryError(cause instanceof Error?cause.message:'客户名单读取失败');setDirectoryLoading(false);}});
  return()=>controller.abort();
 },[directoryReload]);
 useEffect(()=>{
  if(!query)return;
  const controller=new AbortController();
  // State changes in this loader happen only after the network promise settles.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  void loadReport(query,controller.signal).catch(()=>{});
  return()=>controller.abort();
 },[query,loadReport]);
 const applyFilters=()=>{
  if(!filters.customer){setFilterError('请先选择客户');return;}
  const valid=validFreePeriodDate;
  if(!valid(filters.fromDate)||!valid(filters.toDate)||filters.fromDate>filters.toDate){setFilterError('请选择有效日期，起始日期不能晚于结束日期');return;}
  setFilterError('');setBillingEditing(null);setPage(0);setShippedPage(0);setUncalculablePage(0);setOutboundPage(0);setLoading(true);setError('');const next=queryFor(filters);appliedQuery.current=next;if(next===query)void loadReport(next).catch(()=>{});else setQuery(next);
 };
 const refresh=()=>{if(!query){setDirectoryLoading(true);setDirectoryReload(n=>n+1);return;}setLoading(true);setError('');void loadReport(query).catch(()=>{});};
 const chooseCustomer=(customer:string)=>{setBillingEditing(null);setOutboundPage(0);setShippedPage(0);setUncalculablePage(0);reportSequence.current++;const next={...filters,customer};profileSequence.current++;profileRequest.current=false;setProfileBusy(false);setProfileCustomer('');setLoadedCustomer('');setProfileError('');setProfileNotice('');setFilters(next);setLoadedReport(null);setPage(0);setFilterError('');setError('');const nextQuery=customer?queryFor(next):'';appliedQuery.current=nextQuery;setQuery(nextQuery);setLoading(!!customer);};
 const saveSettings=async(config:LayerPricingConfig)=>{
  await request('/api/pricing/layers/settings',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({expectedRevision:config.revision,config})});
  setLoading(true);
  try{await loadReport(appliedQuery.current);}catch(cause){throw Error(`设置已保存，但报告刷新失败：${cause instanceof Error?cause.message:'请刷新重试'}`);}
  onNotice?.('托层体积设置已保存');
 };
 const customers=directory.customers;
 const historyPage=Math.min(outboundPage,Math.max(0,Math.ceil((data?.outboundHistory?.length??0)/25)-1));
 const loadProfile=async(chosenCustomer?:string)=>{
  if(profileRequest.current)return;
  const customer=(chosenCustomer??profileCustomer).trim();
  if(!customer||!customers.includes(customer)){setProfileError('请选择当前货物的一个实际客户');return;}
  const sequence=++profileSequence.current;profileRequest.current=true;setProfileCustomer(customer);setLoadedCustomer('');setProfileBusy(true);setProfileError('');setProfileNotice('');
  try{const result=await request<{ok:true;profile:CustomerPricingProfile}>(`/api/pricing/customer-settings?${new URLSearchParams({customer})}`);if(sequence!==profileSequence.current)return;setLoadedCustomer(customer);setProfileRate(result.profile.ratePerM3Day===null?'':String(result.profile.ratePerM3Day));setProfileDays(result.profile.freeDays===null?'':String(result.profile.freeDays));}
  catch(cause){if(sequence===profileSequence.current)setProfileError(cause instanceof Error?cause.message:'客户规则读取失败');}finally{if(sequence===profileSequence.current){profileRequest.current=false;setProfileBusy(false);}}
 };
 const saveProfile=async()=>{
  if(profileRequest.current)return;
  if(!loadedCustomer||loadedCustomer!==profileCustomer.trim()){setProfileError('请先读取这个客户的现有规则');return;}
  const rateText=profileRate.trim(),daysText=profileDays.trim();
  const rate=rateText?Number(rateText):null,freeDays=daysText?Number(daysText):null;
  if(rate!==null&&(!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(rateText)||!Number.isFinite(rate)||rate<0||rate>1000000)){setProfileError('单价请输入 0–1000000 的有效数字，留空沿用默认规则');return;}
  if(freeDays!==null&&(!/^\d+$/.test(daysText)||!Number.isSafeInteger(freeDays)||freeDays<0||freeDays>36500)){setProfileError('免租天数请输入 0–36500 的整数，留空沿用默认规则');return;}
  const sequence=++profileSequence.current;
  profileRequest.current=true;setProfileBusy(true);setProfileError('');setProfileNotice('');
  try{
   await request('/api/pricing/customer-settings',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({customerName:loadedCustomer,ratePerM3Day:rate,freeDays})});
   if(sequence===profileSequence.current)setProfileNotice('客户规则已保存');onNotice?.('客户单价与免租天数已保存');setLoading(true);
   try{await loadReport(appliedQuery.current);}catch{if(sequence===profileSequence.current)setProfileNotice('客户规则已保存，报告刷新失败，请点击刷新资料重试');}
  }catch(cause){if(sequence===profileSequence.current)setProfileError(cause instanceof Error?cause.message:'客户规则保存失败');}finally{if(sequence===profileSequence.current){profileRequest.current=false;setProfileBusy(false);}}
 };
 const changeProfileCustomer=(value:string)=>{setProfileCustomer(value);setProfileError('');setProfileNotice('');};
 const loadDefaults=async()=>{
  if(defaultsRequest.current)return;
  defaultsRequest.current=true;setDefaultsBusy(true);setDefaultsError('');setDefaultsNotice('');
  try{
   const result=await request<{ok:true;settings:{defaultRatePerM3Day:number;defaultFreeDays:number}}>('/api/pricing/settings');
   const value=result.settings;
   if(!value||typeof value.defaultRatePerM3Day!=='number'||!Number.isFinite(value.defaultRatePerM3Day)||value.defaultRatePerM3Day<0||value.defaultRatePerM3Day>1000000||!Number.isSafeInteger(value.defaultFreeDays)||value.defaultFreeDays<0||value.defaultFreeDays>36500)throw Error('默认规则资料无效，请核对后重试');
   setDefaultRate(String(value.defaultRatePerM3Day));setDefaultDays(String(value.defaultFreeDays));setDefaultsLoaded(true);
  }catch(cause){setDefaultsError(cause instanceof Error?cause.message:'默认规则读取失败，请重试');}finally{defaultsRequest.current=false;setDefaultsBusy(false);}
 };
 const saveDefaults=async()=>{
  if(defaultsRequest.current)return;
  if(!defaultsLoaded){setDefaultsError('请先读取已保存的全仓默认规则');return;}
  const rateText=defaultRate.trim(),daysText=defaultDays.trim(),defaultRatePerM3Day=Number(rateText),defaultFreeDays=Number(daysText);
  if(!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(rateText)||!Number.isFinite(defaultRatePerM3Day)||defaultRatePerM3Day<0||defaultRatePerM3Day>1000000){setDefaultsError('全仓默认单价必须填写 0–1000000 的有效数字，不能留空');return;}
  if(!/^\d+$/.test(daysText)||!Number.isSafeInteger(defaultFreeDays)||defaultFreeDays<0||defaultFreeDays>36500){setDefaultsError('全仓默认免租天数必须填写 0–36500 的整数，不能留空');return;}
  defaultsRequest.current=true;setDefaultsBusy(true);setDefaultsError('');setDefaultsNotice('');
  try{
   await request('/api/pricing/settings',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({defaultRatePerM3Day,defaultFreeDays})});
   setDefaultsNotice('全仓默认规则已保存');onNotice?.('全仓默认单价与免租天数已保存');setLoading(true);
   try{await loadReport(appliedQuery.current);}catch{setDefaultsNotice('全仓默认规则已保存，报告刷新失败，请点击刷新资料重试');}
  }catch(cause){setDefaultsError(cause instanceof Error?cause.message:'默认规则保存失败，请重试');}finally{defaultsRequest.current=false;setDefaultsBusy(false);}
 };

 const financialRows=data?.sections?[...data.sections.inStock.rows,...data.sections.shipped.rows]:(data?.rows??[]).filter(row=>row.status==='verified'&&row.feeUsd!==null);
 const inStockRows=data?.sections?.inStock.rows??financialRows.filter(row=>row.section!=='shipped'),shippedRows=data?.sections?.shipped.rows??financialRows.filter(row=>row.section==='shipped');
 const displayAmounts=layerDisplayFees(data?.rows??[]),sectionFee=(rows:LayerStorageReportRow[])=>Number(rows.reduce((sum,row)=>sum+(displayAmounts.get(row.key)??0),0).toFixed(2));
 const inStockFee=data?.sections?.inStock.feeUsd??sectionFee(inStockRows),shippedFee=data?.sections?.shipped.feeUsd??sectionFee(shippedRows);
 const uncalculable:UncalculableStorageRecord[]=data?.sections?.uncalculable??(data?.rows??[]).filter(row=>row.status==='review'||row.feeUsd===null).map(row=>({key:row.key,kind:'current',customerName:row.customerName,product:row.products.join('、'),sku:row.skus.join('、'),locationCode:row.locationCode,layer:row.layer,inboundDate:row.inboundDate,outboundDate:null,reasons:row.reviewReasons,startDate:row.startDate,endDateExclusive:row.endDateExclusive}));
 const paginate=(rows:LayerStorageReportRow[],selectedPage:number)=>{const sorted=sortLocationRows(rows,displayAmounts),keys=[...new Set(sorted.map(row=>JSON.stringify([row.customerName,row.locationCode])))],count=Math.max(1,Math.ceil(keys.length/25)),current=Math.min(selectedPage,count-1),visible=new Set(keys.slice(current*25,(current+1)*25));return {rows:sorted.filter(row=>visible.has(JSON.stringify([row.customerName,row.locationCode]))),count,current,layerCount:keys.length};};
 const stockPaging=paginate(inStockRows,page),shippedPaging=paginate(shippedRows,shippedPage),uncalculablePages=Math.max(1,Math.ceil(uncalculable.length/25)),uncalculableCurrentPage=Math.min(uncalculablePage,uncalculablePages-1);
 const rowActions=(row:LayerStorageReportRow)=>{
  const unclaimed=(data?.settings.occupied??[]).filter(g=>g.locationCode===row.locationCode&&g.layer===row.layer).flatMap(g=>g.occupants).filter(o=>!o.customerName.trim());
  return <>{row.reviewReasons.some(reason=>reason.includes('待出库原计费层'))&&<button type="button" onClick={()=>setWaitingOriginOpen(true)}>设置原计费库位／层</button>}{!row.customerName&&unclaimed.map(o=><div key={o.id} className="lsp-claim-row"><small>{o.productName||'未认领货物'}</small><UnclaimedCustomerPicker recordId={o.id} customers={customers} onSaved={()=>{setDirectoryReload(n=>n+1);refresh();}}/></div>)}</>;
 };
 const profileEditor=<div className="lsp-customer-fields"><div className="lsp-customer-picker"><label>客户<input aria-label="客户规则客户" type="search" list="layer-pricing-rule-customers" placeholder="选择当前货物客户" value={profileCustomer} disabled={profileBusy} onChange={event=>changeProfileCustomer(event.target.value)}/><datalist id="layer-pricing-rule-customers">{customers.map(customer=><option key={customer} value={customer}/>)}</datalist></label><button type="button" disabled={profileBusy} onClick={()=>void loadProfile()}>读取客户规则</button></div><p>客户专属规则优先；单价或免租天数留空沿用默认仓储规则，0 是明确设置。</p>{loadedCustomer&&<><div className="lsp-customer-inputs"><label>每日单价（$/m³）<input type="text" inputMode="decimal" aria-label="客户每日单价" placeholder="沿用默认规则" value={profileRate} disabled={profileBusy} onChange={event=>{setProfileRate(event.target.value);setProfileError('');setProfileNotice('');}}/></label><label>免租天数<input type="text" inputMode="numeric" aria-label="客户免租天数" placeholder="沿用默认规则" value={profileDays} disabled={profileBusy} onChange={event=>{setProfileDays(event.target.value);setProfileError('');setProfileNotice('');}}/></label><button type="button" className="lsp-primary-button" disabled={profileBusy||loadedCustomer!==profileCustomer.trim()} onClick={()=>void saveProfile()}>保存客户规则</button></div><small>当前读取：{loadedCustomer}</small></>}{profileError&&<p role="alert" className="lsp-error">{profileError}</p>}{profileNotice&&<p role="status" className="lsp-saved">{profileNotice}</p>}</div>;
 const customerRule=(customer:string,items:LayerStorageReportRow[])=>{
  if(!customer)return null;
  const profile=data?.customerProfiles?.find(p=>p.customerName===customer),effective=items[0];
  const customRate=profile?.ratePerM3Day!==null&&profile?.ratePerM3Day!==undefined,customFree=profile?.freeDays!==null&&profile?.freeDays!==undefined;
  return <div className="lsp-inline-rule"><div className="lsp-rule-summary"><span className={customRate?'lsp-rule-custom':''}>单价 {rate(effective.ratePerM3Day)} / m³ / 天 · {customRate?'客户专属':'沿用默认'}</span><span className={customFree?'lsp-rule-custom':''}>免租 {number(effective.freeDays)} 天 · {customFree?'客户专属':'沿用默认'}</span><button type="button" aria-label={`设置计价 · ${customer}`} disabled={profileBusy} onClick={()=>void loadProfile(customer)}>设置计价</button></div>{profileCustomer===customer&&<div className="lsp-inline-rule-editor">{profileEditor}<button type="button" disabled={profileBusy} onClick={()=>{setProfileCustomer('');setLoadedCustomer('');setProfileError('');setProfileNotice('');}}>收起设置</button></div>}</div>;
 };
 const renderFinancial=(title:string,section:'in_stock'|'shipped',rows:LayerStorageReportRow[],subtotal:number,paging:ReturnType<typeof paginate>,setCurrent:(value:number)=>void)=><section className="lsp-monthly" data-billing-section={section}><h3>{title}<span>{paging.layerCount} 个库位 · 小计 <strong>{money(subtotal)}</strong></span></h3>{rows.length?layerRows(paging.rows,false,customerRule,rowActions,rows,data?.rows??rows):<p className="lsp-empty">本期无可计算的{title}费用。</p>}{paging.count>1&&<nav className="lsp-pagination" aria-label={title+'分页'}><button type="button" disabled={paging.current===0} onClick={()=>setCurrent(paging.current-1)}>上一页</button><span>第 {paging.current+1} / {paging.count} 页 · 每页 25 个库位</span><button type="button" disabled={paging.current+1>=paging.count} onClick={()=>setCurrent(paging.current+1)}>下一页</button></nav>}</section>;
 return <section className="layer-storage-pricing" aria-busy={loading}>
  <header className="lsp-heading"><div><span>仓储计价</span><h2>仓储费明细与客户计价</h2><p>仓储费 = 托数 × 所在层每托体积 × 客户每日单价 × 计费天数。各到仓批次分别计算免租；同层旧货计费、新货仍可免租。</p></div><nav><button type="button" onClick={()=>setMerchantOpen(true)}>商家合并／批量更换</button><button type="button" onClick={()=>setWaitingOriginOpen(true)}>设置原计费库位／层</button><a href="/pricing/free-periods">免租到期查询 ↗</a><button type="button" onClick={refresh} disabled={loading}>刷新资料</button></nav></header>
  <div className="lsp-filters" role="search"><label>起始日期<input aria-label="起始日期" type="date" value={filters.fromDate} onInput={event=>{const value=event.currentTarget.value;setFilters(current=>({...current,fromDate:value}));}} onChange={event=>setFilters(current=>({...current,fromDate:event.target.value}))}/></label><label>结束日期<input aria-label="结束日期" type="date" value={filters.toDate} onInput={event=>{const value=event.currentTarget.value;setFilters(current=>({...current,toDate:value}));}} onChange={event=>setFilters(current=>({...current,toDate:event.target.value}))}/></label><label>客户<select aria-label="筛选客户" value={filters.customer} disabled={directoryLoading} onChange={event=>chooseCustomer(event.target.value)}><option value="">请先选择客户</option>{customers.map(customer=><option key={customer} value={customer}>{customer}{directory.historicalCustomers?.includes(customer)?"（历史出货，当前无库存）":""}</option>)}{(directory.unclaimedCount>0||filters.customer==='__unclaimed__')&&<option value="__unclaimed__">待认领（{directory.unclaimedCount} 条）</option>}</select></label><label className="lsp-search">搜索<input aria-label="搜索库位或货物" type="search" placeholder="库位、货物或 SKU" value={filters.q} onChange={event=>setFilters(current=>({...current,q:event.target.value}))} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();applyFilters();}}}/></label><button type="button" onClick={applyFilters}>查询</button></div>
  {directoryError&&<p className="lsp-error" role="alert">{directoryError}<button type="button" onClick={refresh}>重试读取客户</button></p>}
  {!filters.customer&&<p className="lsp-empty">{directoryLoading?"正在读取客户名单…":"请先选择客户，再查看该客户的仓储费用。"}</p>}
  {filterError&&<p className="lsp-error" role="alert">{filterError}</p>}
  {query&&queryFor(filters)!==query&&<p className="lsp-basis-note" role="status">查询条件已修改，请点击查询。当前报告及导出仍对应上次已查询的条件。</p>}
  {loading&&<p className="lsp-loading" role="status">正在读取托层报告…本次结果尚未生成，暂不可查看或导出。</p>}
  {error&&<div className="lsp-error" role="alert">{error} 本次报告未生成，请重试后再核对或导出。<button type="button" onClick={refresh}>重试</button></div>}
  {data&&<>
   <div className="lsp-period-heading"><div><h3>{data.period.fromDate} 至 {data.period.toDate} · 托数仓储报告</h3><p>纽约日期 {data.asOf} · 截止 {data.period.periodEndExclusive}（不含）</p></div><a className={`lsp-export${loading||error?' is-disabled':''}`} href={`/api/pricing/layers/export?${query}`} aria-disabled={loading||!!error} onClick={event=>{if(loading||error)event.preventDefault();}}>导出 Excel</a></div>
   <div className="lsp-totals"><div><span>本期可计算仓储费合计</span><strong>{money(Number((inStockFee+shippedFee).toFixed(2)))}</strong><small>在库与已出库合计；各批次按实际托数计费</small></div><div className={uncalculable.length?'is-pending':''}><span>不能计算</span><strong>{uncalculable.length} 条</strong><small>金额未知，未计入合计；请在第三部分补充资料</small></div><div><span>当前计价层数</span><strong>{data.current.layerCount} 层</strong><small>计价体积 {number(data.current.volumeM3)} m³ · 按记录托数与所在层每托体积计算</small></div></div>
   {!!data.coverage.currentOccupancyPeriods?.length&&<div className="lsp-basis-note">历史缺失时段按当前记录托数估算，各批次保留自身到仓日与免租期；缺少托数按 1 托估算。<details><summary>查看适用时段</summary>{data.coverage.currentOccupancyPeriods.map(p=><span key={p.startDate}>{p.startDate} 至 {p.endDateExclusive}（不含）</span>)}</details></div>}
   {!data.rows.some(r=>r.customerName===profileCustomer)&&<details className="lsp-customer-settings"><summary>客户单价与免租天数<span>也可在客户名字旁直接设置</span></summary>{profileEditor}</details>}
   {renderFinancial('在库','in_stock',inStockRows,inStockFee,stockPaging,setPage)}
   <div className="lsp-shipped-section">
   {renderFinancial('已出库','shipped',shippedRows,shippedFee,shippedPaging,setShippedPage)}
   {!!data.outboundHistory?.length&&<details className="lsp-monthly lsp-outbound-history"><summary>原始出货记录<span>原日期保留 · {data.outboundHistory.length} 条</span></summary><p className="lsp-empty">{data.current.layerCount===0?'该客户当前无在库货物。':''}以下保留该客户全部原始日期，供核对与更正商家。当前计费占层区间：{data.period.periodStart} 至 {data.period.periodEndExclusive}（不含）；原确认状态不影响重算。</p><div className="lsp-table-scroll"><table className="lsp-table"><thead><tr><th>产品 / SKU</th><th>原记录库位 / 层</th><th>入库日期</th><th>出库日期</th><th>出货数量 / 来源</th><th>操作</th></tr></thead><tbody>{data.outboundHistory.slice(historyPage*25,historyPage*25+25).map(record=>{const originalLocation=record.originalLocationCode!==undefined?record.originalLocationCode:record.locationCode,originalLayer=record.originalLayer!==undefined?record.originalLayer:record.layer,originalInbound=record.originalInboundDate!==undefined?record.originalInboundDate:record.inboundDate,originalOutbound=record.originalOutboundDate!==undefined?record.originalOutboundDate:record.outboundDate;return <tr key={record.key} data-source-history={record.key}><td data-label="产品 / SKU"><strong>{record.product}</strong><small>SKU：{record.sku||'无'}</small>{record.billingFactsManual&&<><small className="lsp-billing-correction">计费资料已补充</small><small>计费客户：{record.customerName||'未认领'}</small></>}</td><td data-label="原记录库位 / 层"><span>{originalLocation||'待补充'}{originalLayer?' · 第'+originalLayer+'层':' · 层数待补充'}</span>{record.billingFactsManual&&<small>计费：{record.locationCode||'待补充'}{record.layer?' · 第'+record.layer+'层':''}</small>}</td><td data-label="入库日期"><strong>{originalInbound||'待补充'}</strong>{record.billingFactsManual&&<small>计费：{record.inboundDate||'待补充'}</small>}</td><td data-label="出库日期"><strong>{originalOutbound||'待补充'}</strong>{record.billingFactsManual&&<small>计费：{record.outboundDate||'待补充'}</small>}</td><td data-label="出货数量 / 来源"><span>{record.quantity}件 / {record.boxes}箱</span><small>{record.sourceLabel}</small>{record.originalCustomerName!==undefined&&record.originalCustomerName!==record.customerName&&<small>原商家：{record.originalCustomerName||'未认领'}</small>}</td><td data-label="操作"><button type="button" disabled={!record.revision} onClick={()=>setBillingEditing(record)}>修改信息</button></td></tr>;})}</tbody></table></div>{data.outboundHistory.length>25&&<nav className="lsp-pagination" aria-label="历史出货分页"><button disabled={historyPage===0} onClick={()=>setOutboundPage(historyPage-1)}>上一页</button><span>第 {historyPage+1} / {Math.ceil(data.outboundHistory.length/25)} 页</span><button disabled={(historyPage+1)*25>=data.outboundHistory.length} onClick={()=>setOutboundPage(historyPage+1)}>下一页</button></nav>}</details>}
   </div>
   <section className="lsp-monthly lsp-uncalculable" data-billing-section="uncalculable"><h3>不能计算<span>{uncalculable.length} 条 · 小计：金额未知，不计入合计</span></h3><p className="lsp-section-note">缺少或不明确的资料必须补充后再计算；这里的记录不表示免费。所选占层区间：{data.period.periodStart} 至 {data.period.periodEndExclusive}（不含）。</p>{uncalculable.length?<div className="lsp-table-scroll"><table className="lsp-table"><thead><tr><th>客户 / 货物</th><th>库位 / 层</th><th>入库 / 出库日期</th><th>不能计算原因</th><th>操作</th></tr></thead><tbody>{uncalculable.slice(uncalculableCurrentPage*25,(uncalculableCurrentPage+1)*25).map(item=>{
    const stockId=item.recordId?.match(/^(?:stock:)?(\d+)$/)?.[1],history=data.outboundHistory?.find(record=>record.key===item.historyKey),currentRows=data.rows.filter(row=>row.key===item.key||(row.locationCode===item.locationCode&&row.layer===item.layer&&row.customerName===item.customerName&&row.status==='review'));
    return <tr key={item.key} data-uncalculable-row={item.key}><td data-label="客户 / 货物"><strong>{item.customerName||'未认领 · 待核对'}</strong><span>{item.product||'货物待补充'}</span><small>SKU：{item.sku||'无'}</small></td><td data-label="库位 / 层"><strong>{item.locationCode||'库位待补充'}</strong><span>{item.layer===null?'层数待补充':'第 '+item.layer+' 层'}</span></td><td data-label="入库 / 出库日期"><span>入库 {item.inboundDate||'待补充'}</span><span>{item.kind==='current'?'当前在库':'出库 '+(item.outboundDate||'待补充')}</span><small>相关占层 {item.startDate} 至 {item.endDateExclusive}（不含）</small></td><td data-label="不能计算原因"><strong className="lsp-pending-text">金额未知</strong>{item.reasons.map((reason,index)=><span key={index}>{reason}</span>)}</td><td data-label="操作"><div className="lsp-repair-actions">{history&&<button type="button" onClick={()=>setBillingEditing(history)}>补充计费资料</button>}{item.kind==='current'&&<>{currentRows.map(row=><Fragment key={row.key}>{rowActions(row)}</Fragment>)}{!item.customerName&&item.recordId&&currentRows.length===0&&<UnclaimedCustomerPicker recordId={item.recordId} customers={customers} onSaved={()=>{setDirectoryReload(n=>n+1);refresh();}}/>}{item.customerName&&<button type="button" onClick={()=>void loadProfile(item.customerName)}>设置客户计价</button>}{item.customerName&&profileCustomer===item.customerName&&<div className="lsp-inline-rule-editor">{profileEditor}</div>}{item.reasons.some(reason=>reason.includes('待出库原计费层'))&&currentRows.length===0&&<button type="button" onClick={()=>setWaitingOriginOpen(true)}>设置原计费库位／层</button>}{stockId&&<a href={'/?wms=stock&stock='+encodeURIComponent(stockId)}>修改库存资料 ↗</a>}</>}{!history&&item.kind!=='current'&&<><button type="button" onClick={()=>setMerchantOpen(true)}>核对商家归属</button><small>需核对原始记录后补充计费资料</small></>}</div></td></tr>;
   })}</tbody></table></div>:<p className="lsp-empty">所选期间没有不能计算的记录。</p>}{uncalculablePages>1&&<nav className="lsp-pagination" aria-label="不能计算分页"><button type="button" disabled={uncalculableCurrentPage===0} onClick={()=>setUncalculablePage(uncalculableCurrentPage-1)}>上一页</button><span>第 {uncalculableCurrentPage+1} / {uncalculablePages} 页 · 每页 25 条</span><button type="button" disabled={uncalculableCurrentPage+1>=uncalculablePages} onClick={()=>setUncalculablePage(uncalculableCurrentPage+1)}>下一页</button></nav>}</section>
   {billingEditing&&<OutboundBillingDetailsEditor record={billingEditing} customerNames={customers} period={data.period} asOf={data.asOf} onClose={()=>setBillingEditing(null)} onSaved={()=>{setBillingEditing(null);setDirectoryReload(n=>n+1);refresh();}}/>}
   <details className="lsp-current"><summary><span>当前占层日费预览 · 非账单</span><span>{data.current.layerCount} 层 · {number(data.current.volumeM3)} m³</span></summary><div className="lsp-current-body"><p>已核实日费预览 <strong>{money(data.current.dailyFeeUsd)} / 天</strong>{data.current.pendingCount>0&&<span className="lsp-pending-text"> · {data.current.pendingCount} 项待核对，金额未知</span>}。仅展示当前实物与当前规则，不代表整月或已确认费用。</p>{data.current.rows.length?layerRows(data.current.rows,true):<p className="lsp-empty">当前暂无有货托层。</p>}</div></details>
   <details className="lsp-editor"><summary>库位计价体积设置<span>库位默认 / 单层设置</span></summary><div><LayerPricingSettings config={data.settings.config} occupied={data.settings.occupied} locations={data.settings.locations} zones={data.settings.zones} aliases={data.settings.aliases} onSave={saveSettings}/></div></details>
   <details className="lsp-customer-settings lsp-default-settings" onToggle={event=>{if(event.currentTarget.open&&!defaultsLoaded&&!defaultsRequest.current)void loadDefaults();}}><summary>全仓默认单价与免租天数<span>无客户专属规则时使用</span></summary><div className="lsp-customer-fields"><p>客户专属规则优先。全仓默认值必须填写；单价 0 为免费，免租 0 天为无免租期。</p>{defaultsLoaded?<div className="lsp-customer-inputs"><label>默认每日单价（$/m³）<input type="text" inputMode="decimal" aria-label="全仓默认每日单价" value={defaultRate} disabled={defaultsBusy} onChange={event=>{setDefaultRate(event.target.value);setDefaultsError('');setDefaultsNotice('');}}/></label><label>默认免租天数<input type="text" inputMode="numeric" aria-label="全仓默认免租天数" value={defaultDays} disabled={defaultsBusy} onChange={event=>{setDefaultDays(event.target.value);setDefaultsError('');setDefaultsNotice('');}}/></label><button type="button" className="lsp-primary-button" disabled={defaultsBusy} onClick={()=>void saveDefaults()}>保存全仓默认规则</button></div>:defaultsBusy?<p role="status">正在读取已保存的默认规则…</p>:<button type="button" onClick={()=>void loadDefaults()}>重试读取默认规则</button>}{defaultsError&&<p className="lsp-error" role="alert">{defaultsError}</p>}{defaultsNotice&&<p className="lsp-saved" role="status">{defaultsNotice}</p>}</div></details>

   {data.confirmedHistory.count>0&&<details className="lsp-confirmed"><summary>旧已确认账单 · 只读归档 · 非收款<span>{data.confirmedHistory.count} 条 · {money(data.confirmedHistory.feeUsd)}</span></summary><div><p>确认不代表收款。这里保留原单据名称、金额和确认状态；本期按所选占层日期重新计算，不扣除或冻结这些费用。</p>{data.confirmedHistory.records.length?<ul>{data.confirmedHistory.records.map((record,index)=><li key={String(record.id??index)}><div><strong>{String(record.customerName||'客户待补充')}</strong><span>{String(record.product??record.productName??'历史仓储记录')}</span></div><div><strong>{money(typeof record.feeUsd==='number'?record.feeUsd:null)}</strong><span>入库：{String(record.inboundDate||'待补充').slice(0,10)} · 出库：{String(record.outboundAt||'待补充').slice(0,10)}</span><span>确认：{String(record.settledAt??record.createdAt??'确认日期待补充').slice(0,10)}</span></div></li>)}</ul>:<p>暂无旧已确认账单。</p>}</div></details>}
  </>}
  {waitingOriginOpen&&<WaitingBillingOriginWorkspace period={data?.period??{fromDate:filters.fromDate,toDate:filters.toDate}} asOf={data?.asOf??warehouseTodayDate()} customer={filters.customer==='__unclaimed__'?'':filters.customer||undefined} onClose={()=>setWaitingOriginOpen(false)} onSaved={()=>{setWaitingOriginOpen(false);refresh();}}/>}
  {merchantOpen&&<MerchantChangeWorkspace period={data?.period??{fromDate:filters.fromDate,toDate:filters.toDate,fromMonth:filters.fromDate.slice(0,7),toMonth:filters.toDate.slice(0,7)}} asOf={data?.asOf??warehouseTodayDate()} onClose={()=>setMerchantOpen(false)} onSaved={target=>{setMerchantOpen(false);setDirectoryReload(n=>n+1);if(target)chooseCustomer(target);else refresh();}}/>}
 </section>;
}
