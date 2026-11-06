"use client";
import {useEffect,useRef,useState} from 'react';
import type {CartonReceipt} from '../lib/carton-flow';
import {cartonPlacementDetails} from '../lib/box-stock-details';
import {GoodsNumberInput} from './GoodsNumberInput';
import './CartonCorrectionDialog.css';

type CorrectionBody={requestId:string;id:string;expectedVersion:number;placementKey:string;boxes:number;reason?:string};
type Pending={body:CorrectionBody;receipt:CartonReceipt;source?:{locationCode:string;layerCount:number;boxes:number;marker:string;inboundOrder:string;inboundDate:string}};
type Props={receipt:CartonReceipt;placementKey:string;draftKey:string;onChanged:()=>Promise<void>;onClose:()=>void};

export function CartonCorrectionDialog({receipt,placementKey,draftKey,onChanged,onClose}:Props){
 const source=receipt.placements.find(p=>p.key===placementKey),storageKey=draftKey+':correction',effective=source?cartonPlacementDetails(receipt,source):null;
 const [pending,setPending]=useState<Pending|null>(()=>{try{const value=JSON.parse(localStorage.getItem(storageKey)||'null');return value?.body?.id===receipt.id&&typeof value.body.requestId==='string'&&typeof value.body.placementKey==='string'&&Number.isSafeInteger(value.body.boxes)&&value.body.boxes>=0?value:null;}catch{return null;}});
 const [boxes,setBoxes]=useState(String(source?.boxes??'')),[reason,setReason]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const dialog=useRef<HTMLDivElement>(null),inFlight=useRef(false);
 useEffect(()=>{const previous=document.activeElement;dialog.current?.focus();return()=>{if(previous instanceof HTMLElement)previous.focus();}},[]);
 const retain=(value:Pending|null)=>{try{if(value)localStorage.setItem(storageKey,JSON.stringify(value));else localStorage.removeItem(storageKey);setPending(value);if(typeof window!=='undefined')window.dispatchEvent(new Event('warehouse-box-correction-pending'));return true;}catch{setError(value?'浏览器未能保留提交核对信息，本次未提交。请允许本地存储后重试。':'修正已保存，但未能清除核对信息。请使用原请求再次核对。');return false;}};
 const run=async()=>{
  if(inFlight.current)return;
  let request=pending;
  if(!request){
   if(!source||source.boxes<=0){setError('当前库位已没有可修正的箱库存，请刷新库存。');return;}
   if(!/^\d+$/.test(boxes)||!Number.isSafeInteger(Number(boxes))||Number(boxes)<0){setError('修正后箱数必须是大于等于 0 的整数。');return;}
   request={receipt,source:{locationCode:source.locationCode,layerCount:source.layerCount,boxes:source.boxes,marker:source.marker,inboundOrder:effective!.inboundOrder,inboundDate:effective!.inboundDate},body:{requestId:crypto.randomUUID(),id:receipt.id,expectedVersion:receipt.version,placementKey:source.key,boxes:Number(boxes),...(reason.trim()?{reason:reason.trim()}:{})}};
  }
  inFlight.current=true;setBusy(true);setError('');
  if(!retain(request)){inFlight.current=false;setBusy(false);return;}
  try{
   const response=await fetch('/api/cartons/correction',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request.body)}),data=await response.json();
   if(!response.ok){if(response.status<500)retain(null);throw Error(data.error||'修正失败，请核对库存后重试。');}
   // Refresh is part of completion; an uncertain refresh must reuse the same correction request.
   await onChanged();if(retain(null))onClose();
  }catch(e){setError(e instanceof Error?e.message:'提交结果尚未确认，请使用原请求核对。');}
  finally{inFlight.current=false;setBusy(false);}
 };
 const displaySource=pending?(pending.source??receipt.placements.find(p=>p.key===pending.body.placementKey)):source;
 return <div className="carton-correction-backdrop"><div ref={dialog} className="carton-correction-dialog" role="dialog" aria-modal="true" aria-label="修正箱数" tabIndex={-1} onKeyDown={event=>{
  if(event.key==='Escape'){event.stopPropagation();if(!busy)onClose();}
  if(event.key==='Tab'){
   const controls=dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),[tabindex="0"]');
   if(!controls?.length)return;
   const first=controls[0],last=controls[controls.length-1];
   if(event.shiftKey&&(document.activeElement===first||document.activeElement===dialog.current)){event.preventDefault();last.focus();}
   else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
  }
 }}>
  <header><h3>修正箱数</h3><button type="button" disabled={busy} onClick={onClose}>关闭</button></header>
  <div className="carton-correction-content">
   <dl className="carton-correction-values">
    <div><dt>入库单号</dt><dd>{pending?.source?.inboundOrder??effective?.inboundOrder??receipt.inboundOrder}</dd></div>
    <div><dt>当前库位</dt><dd>{displaySource?.locationCode??'上次提交的原库位'} · 第{displaySource?.layerCount??'—'}层 · {displaySource?.marker||'无标记'}</dd></div>
    <div><dt>原入库日期</dt><dd>{pending?.source?.inboundDate??effective?.inboundDate??receipt.inboundDate}</dd></div>
    <div><dt>{pending?'提交前箱数':'当前箱数'}</dt><dd>{displaySource?.boxes??'待核对'} 箱</dd></div>
   </dl>
   <p className="stock-details-help">只修正所选库位的箱库存，保留原入库日期，其他库位不变。本次是库存修正，不是新增入库或出库；产品关联和待核对计价状态保留。</p>
   {pending?<div role="status" className="carton-correction-pending"><p>上次修正结果待核对。将使用原请求核对，请勿重新填写。</p><p>修正后箱数：{pending.body.boxes} 箱</p>{pending.body.reason&&<p>修正原因：{pending.body.reason}</p>}</div>:<fieldset disabled={busy}>
    <label>修正后箱数<GoodsNumberInput aria-label="修正后箱数" value={boxes} onChange={event=>setBoxes(event.target.value)}/></label>
    <label>修正原因（选填）<textarea maxLength={500} value={reason} onChange={event=>setReason(event.target.value)}/></label>
   </fieldset>}
   {error&&<p role="alert" className="identity-error">{error}</p>}
  </div>
  <footer><button type="button" disabled={busy} onClick={onClose}>{pending?'关闭，稍后核对':'取消修正'}</button><button type="button" disabled={busy} onClick={()=>void run()}>{busy?'正在保存…':pending?'核对上次提交':'确认修正'}</button></footer>
 </div></div>;
}
