"use client";
import {useEffect,useId,useRef,useState} from 'react';
import type {OutboundHistoryRecord} from '../lib/outbound-history';
import {CustomerNameInput} from './CustomerNameInput';
import {LocationSearchInput} from './LocationSearchInput';
import './outbound-billing-details-editor.css';
type Props={record:OutboundHistoryRecord;customerNames:string[];period:{fromDate?:string;toDate?:string;fromMonth:string;toMonth:string};asOf:string;onClose:()=>void;onSaved:()=>void};
type Total={customerName:string;feeUsd:number;pendingCount:number};
type Preview={previewToken:string;before:Total[];after:Total[];notices:string[]};
type Draft={customerName:string;locationCode:string;layer:string;inboundDate:string;outboundDate:string};
const draftFor=(record:OutboundHistoryRecord):Draft=>({customerName:record.customerName,locationCode:record.locationCode||record.originalLocationCode||'',layer:String(record.layer??record.originalLayer??''),inboundDate:record.inboundDate??record.originalInboundDate??'',outboundDate:record.outboundDate??record.originalOutboundDate??''});
const money=(value:number)=>'$'+value.toFixed(2);
export function OutboundBillingDetailsEditor({record,customerNames,period,asOf,onClose,onSaved}:Props){
 const title=useId(),dialog=useRef<HTMLElement>(null),mounted=useRef(false),requestBusy=useRef(false),request=useRef<AbortController|null>(null),inputVersion=useRef(0);
 const [fresh,setFresh]=useState(record),[revision,setRevision]=useState(''),[locations,setLocations]=useState<string[]>([]),[draft,setDraft]=useState<Draft>(()=>draftFor(record)),[preview,setPreview]=useState<Preview|null>(null),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[error,setError]=useState(''),[reload,setReload]=useState(0);
 useEffect(()=>{
  mounted.current=true;const controller=new AbortController(),previous=document.activeElement as HTMLElement|null,overflow=document.body.style.overflow;request.current=controller;document.body.style.overflow='hidden';dialog.current?.focus();setLoading(true);setError('');setPreview(null);
  void(async()=>{try{const response=await fetch('/api/pricing/outbound-details?key='+encodeURIComponent(record.key),{cache:'no-store',signal:controller.signal}),data=await response.json();if(!response.ok)throw Error(data.error||'读取计费资料失败');if(!mounted.current||controller.signal.aborted)return;setFresh(data.record);setRevision(data.revision);setLocations(data.locations);setDraft(draftFor(data.record));}catch(cause){if(mounted.current&&!controller.signal.aborted)setError(cause instanceof Error?cause.message:'读取失败，请重试');}finally{if(mounted.current&&!controller.signal.aborted)setLoading(false);}})();
  return()=>{mounted.current=false;controller.abort();request.current?.abort();document.body.style.overflow=overflow;previous?.focus?.();};
 },[record.key,reload]);
 useEffect(()=>{inputVersion.current++;setPreview(null);},[period.fromDate,period.toDate,period.fromMonth,period.toMonth,asOf]);
 const edit=(key:keyof Draft,value:string)=>{inputVersion.current++;setDraft(before=>({...before,[key]:value}));setPreview(null);setError('');};
 const submit=async(save:boolean)=>{
  if(requestBusy.current||loading||!revision||save&&!preview)return;
  const customerName=draft.customerName.trim(),layer=Number(draft.layer);
  if(!customerName||customerName.length>200||/[\u0000-\u001f\u007f]/u.test(customerName)||!locations.includes(draft.locationCode)||!/^\d+$/.test(draft.layer)||!Number.isSafeInteger(layer)||layer<1||layer>10000||!/^\d{4}-\d\d-\d\d$/.test(draft.inboundDate)||!/^\d{4}-\d\d-\d\d$/.test(draft.outboundDate)||draft.inboundDate>draft.outboundDate){setError('请填写客户、选择库位、填写正整数层及有效入出库日期');return;}
  const controller=new AbortController(),version=inputVersion.current;request.current=controller;requestBusy.current=true;setBusy(true);setError('');
  try{const response=await fetch('/api/pricing/outbound-details',{method:save?'PUT':'POST',cache:'no-store',signal:controller.signal,headers:{'content-type':'application/json'},body:JSON.stringify({key:record.key,expectedRevision:revision,customerName,locationCode:draft.locationCode,layer,inboundDate:draft.inboundDate,outboundDate:draft.outboundDate,...(period.fromDate&&period.toDate?{fromDate:period.fromDate,toDate:period.toDate}:{fromMonth:period.fromMonth,toMonth:period.toMonth}),asOf,...(save?{previewToken:preview!.previewToken}:{})})}),data=await response.json();if(!response.ok)throw Error(data.error||'计费资料保存失败');if(!mounted.current||controller.signal.aborted||version!==inputVersion.current)return;if(save)onSaved();else setPreview(data);}
  catch(cause){if(mounted.current&&!controller.signal.aborted){setPreview(null);setError(cause instanceof Error?cause.message:'处理失败，请重新预览');}}
  finally{requestBusy.current=false;if(mounted.current&&!controller.signal.aborted)setBusy(false);}
 };
 return <div className="obd-backdrop" onKeyDown={e=>{
  if(e.key==='Escape'&&!busy){e.preventDefault();e.stopPropagation();onClose();}
  if(e.key==='Tab'){const list=Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),[tabindex="0"]')??[]).filter(el=>el.getAttribute('tabindex')!=='-1'&&el.getClientRects().length>0);if(!list.length){e.preventDefault();dialog.current?.focus();return;}const first=list[0],last=list[list.length-1];if(e.shiftKey&&(document.activeElement===first||document.activeElement===dialog.current)){e.preventDefault();last.focus();}else if(!e.shiftKey&&(document.activeElement===last||document.activeElement===dialog.current)){e.preventDefault();first.focus();}}
 }}><section ref={dialog} tabIndex={-1} className="obd-dialog" role="dialog" aria-modal="true" aria-labelledby={title} aria-busy={loading||busy}>
  <header><h3 id={title}>补充／修改计费资料</h3><button type="button" disabled={busy} onClick={onClose}>关闭</button></header>
  <div className="obd-body">
   <div className="obd-source"><strong>{fresh.product}</strong><span>SKU：{fresh.sku||'无'} · {fresh.quantity}件 / {fresh.boxes}箱</span><small>原始入库：{fresh.originalInboundDate!==undefined?(fresh.originalInboundDate||'待补充'):(fresh.inboundDate||'待补充')}　原始出库：{fresh.originalOutboundDate!==undefined?(fresh.originalOutboundDate||'待补充'):(fresh.outboundDate||'待补充')}</small></div>
   <p className="obd-policy">计费资料，原始出入库记录不变。按所选日期重算仓储费；历史确认不代表已收款。</p>
   {fresh.billingDetailsConflict&&<p role="alert" className="obd-conflict">{fresh.billingDetailsConflict}</p>}
   {loading?<p role="status">正在核对最新计费资料…</p>:<fieldset disabled={busy||!revision} className="obd-fields">
    <label className="obd-customer">计费客户<CustomerNameInput label="历史出货计费客户" value={draft.customerName} customerNames={customerNames} disabled={busy||!revision} onChange={value=>edit('customerName',value)}/></label>
    <div className="obd-location"><span>计费库位</span><LocationSearchInput value={draft.locationCode} codes={locations} onChange={value=>edit('locationCode',value)}/></div>
    <label>计费层<input aria-label="计费层" type="text" inputMode="numeric" pattern="[0-9]*" maxLength={5} value={draft.layer} onChange={e=>edit('layer',e.currentTarget.value)}/></label>
    <label>计费入库日期<input aria-label="计费入库日期" type="date" value={draft.inboundDate} onInput={e=>edit('inboundDate',e.currentTarget.value)} onChange={e=>edit('inboundDate',e.currentTarget.value)}/></label>
    <label>计费出库日期<input aria-label="计费出库日期" type="date" min={draft.inboundDate||undefined} value={draft.outboundDate} onInput={e=>edit('outboundDate',e.currentTarget.value)} onChange={e=>edit('outboundDate',e.currentTarget.value)}/></label>
   </fieldset>}
   <small className="obd-period">预览账期：{period.fromDate??period.fromMonth} 至 {period.toDate??period.toMonth} · 截至 {asOf}</small>
   {preview&&<div className="obd-preview" role="region" aria-label="计费资料修改预览"><table><thead><tr><th>客户</th><th>修改前</th><th>修改后</th></tr></thead><tbody>{preview.before.map(before=>{const after=preview.after.find(row=>row.customerName===before.customerName);return <tr key={before.customerName}><td>{before.customerName||'未认领'}</td><td>{money(before.feeUsd)}{before.pendingCount>0&&<small>{before.pendingCount}项待核对</small>}</td><td>{after?money(after.feeUsd):'待核对'}{(after?.pendingCount??0)>0&&<small>{after!.pendingCount}项待核对</small>}</td></tr>;})}</tbody></table><p>上表为受影响客户在所选账期的合并费用，同层重叠日期只计一次。</p>{preview.notices.map(notice=><small key={notice}>{notice}</small>)}</div>}
   {error&&<p role="alert" className="obd-error">{error}{!revision&&<button type="button" onClick={()=>setReload(v=>v+1)}>重新读取</button>}</p>}
  </div>
  <footer><button type="button" disabled={busy} onClick={onClose}>取消</button><button type="button" disabled={busy||loading||!revision} onClick={()=>void submit(false)}>{busy?'正在处理…':'预览费用变化'}</button><button type="button" className="obd-save" disabled={busy||loading||!preview} onClick={()=>void submit(true)}>保存计费资料</button></footer>
 </section></div>;
}
