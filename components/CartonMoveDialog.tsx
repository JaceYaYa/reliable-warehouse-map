"use client";
import {useEffect,useRef,useState} from 'react';
import {palletCountValue,palletCountsEqual,palletLabel} from '../lib/pallet';
import {cartonPalletCount} from '../lib/carton-flow';
import type {CartonReceipt} from '../lib/carton-flow';
import {GoodsNumberInput} from './GoodsNumberInput';
import {LocationSearchInput} from './LocationSearchInput';
import './CartonMoveDialog.css';

type MoveRow={pallets:string;key:number;boxes:string;locationCode:string;layerCount:string;marker:string;note:string};
type MoveBody={requestId:string;id:string;expectedVersion:number;moves:{fromKey:string;boxes:number;pallets?:string;toLocationCode:string;toLayerCount:number;toMarker:string;toNote:string}[]};
type Pending={body:MoveBody;source?:{locationCode:string;layerCount:number;boxes:number;marker:string}};
type Props={receipt:CartonReceipt;placementKey:string;locations:readonly string[];draftKey:string;onChanged:()=>Promise<void>;onClose:()=>void};

export function CartonMoveDialog({receipt,placementKey,locations,draftKey,onChanged,onClose}:Props){
 const source=receipt.placements.find(p=>p.key===placementKey);
 const storageKey=draftKey+':move';
 const [pending,setPending]=useState<Pending|null>(()=>{try{const value=JSON.parse(localStorage.getItem(storageKey)||'null');return value?.body?.id===receipt.id&&typeof value.body.requestId==='string'&&Array.isArray(value.body.moves)?value:null;}catch{return null;}});
 const [rows,setRows]=useState<MoveRow[]>([{key:0,boxes:'',pallets:'',locationCode:'',layerCount:String(source?.layerCount??1),marker:source?.marker??'',note:source?.note??receipt.note}]);
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 const dialog=useRef<HTMLDivElement>(null),inFlight=useRef(false);
 useEffect(()=>{const previous=document.activeElement;dialog.current?.focus();return()=>{if(previous instanceof HTMLElement)previous.focus();}},[]);
 const retain=(value:Pending|null)=>{try{if(value)localStorage.setItem(storageKey,JSON.stringify(value));else localStorage.removeItem(storageKey);setPending(value);return true;}catch{setError(value?'浏览器未能保留提交核对信息，本次未提交。请允许本地存储后重试。':'移动已完成，但未能清除核对信息。请使用原请求再次核对。');return false;}};
 const update=(key:number,values:Partial<MoveRow>)=>setRows(previous=>previous.map(row=>row.key===key?{...row,...values}:row));
 const run=async()=>{
  if(inFlight.current)return;
  let request=pending;
  if(!request){
   if(!source||source.boxes<=0){setError('当前库位已没有可移动箱库存，请刷新库存。');return;}
   for(const row of rows){
    if(!Number.isFinite(palletCountValue(row.pallets))){setError('请填写有效的非负移动托盘数。');return;}
    if(!/^\d+$/.test(row.boxes)||!Number.isSafeInteger(Number(row.boxes))||Number(row.boxes)<=0){setError('每个目标库位都需要填写大于 0 的整数箱数。');return;}
    if(!locations.includes(row.locationCode)){setError('请从库位提示中选择实际存在的目标库位。');return;}
    if(!/^\d+$/.test(row.layerCount)||!Number.isSafeInteger(Number(row.layerCount))||Number(row.layerCount)<1){setError('层数必须是大于等于 1 的整数。');return;}
   }
   if(rows.reduce((sum,row)=>sum+Number(row.boxes),0)>source.boxes){setError(`移动箱数超过当前可用的 ${source.boxes} 箱。`);return;}
   const movedBoxes=rows.reduce((sum,row)=>sum+Number(row.boxes),0),movedPallets=rows.reduce((sum,row)=>sum+palletCountValue(row.pallets),0),availablePallets=cartonPalletCount(source);
   const equalPallets=palletCountsEqual(movedPallets,availablePallets);
   if(movedPallets>availablePallets&&!equalPallets||movedBoxes===source.boxes&&rows.every(row=>row.pallets.trim()!=='')&&!equalPallets){setError('移动托盘数超过可用数量，或全部移库时托盘数尚未分配完。');return;}
   request={source:{locationCode:source.locationCode,layerCount:source.layerCount,boxes:source.boxes,marker:source.marker},body:{requestId:crypto.randomUUID(),id:receipt.id,expectedVersion:receipt.version,moves:rows.map(row=>({fromKey:source.key,boxes:Number(row.boxes),...(row.pallets.trim()?{pallets:row.pallets}:{}),toLocationCode:row.locationCode,toLayerCount:Number(row.layerCount),toMarker:row.marker,toNote:row.note}))}};
  }
  inFlight.current=true;setBusy(true);setError('');if(!retain(request)){inFlight.current=false;setBusy(false);return;}
  try{
   const response=await fetch('/api/cartons/move',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request.body)}),data=await response.json();
   if(!response.ok){if(response.status<500)retain(null);throw Error(data.error||'移动失败，请核对库存后重试。');}
   // Refresh is part of completion: keep the original request if it fails, so retry cannot move twice.
   await onChanged();if(retain(null))onClose();
  }catch(e){setError(e instanceof Error?e.message:'提交结果尚未确认，请使用原请求核对。');}
  finally{inFlight.current=false;setBusy(false);}
 };
 const total=pending?pending.body.moves.reduce((sum,row)=>sum+row.boxes,0):rows.reduce((sum,row)=>sum+Number(row.boxes||0),0);
 const frozen=busy||!!pending,displaySource=pending?(pending.source??receipt.placements.find(p=>p.key===pending.body.moves[0]?.fromKey)):source;
 return <div className="carton-move-backdrop"><div ref={dialog} className="carton-move-dialog" role="dialog" aria-modal="true" aria-label="移动箱库存" tabIndex={-1} onKeyDown={event=>{
  if(event.key==='Escape'){event.stopPropagation();if(!busy)onClose();}
  if(event.key==='Tab'){
   const controls=dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),[tabindex="0"]');
   if(!controls?.length)return;
   const first=controls[0],last=controls[controls.length-1];
   if(event.shiftKey&&(document.activeElement===first||document.activeElement===dialog.current)){event.preventDefault();last.focus();}
   else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
  }
 }}>
  <header><h3>移动箱库存</h3><button type="button" disabled={busy} onClick={onClose}>关闭</button></header>
  <div className="carton-move-content">
   <p className="carton-move-source">入库单号：{receipt.inboundOrder}<br/>来源：{displaySource?.locationCode??'上次提交的原库位'} · 第{displaySource?.layerCount??'—'}层 · {displaySource?.marker||'无标记'}<br/>{pending?'提交前可用':'当前可用'} {displaySource?.boxes??'待核对'} 箱{source&&!pending?` / ${palletLabel(cartonPalletCount(source))} 托盘`:''}</p>
   <p className="stock-details-help">可以拆分到多个库位；未移动的箱数保留在原库位。产品关联、入库日期和箱数合计保持不变。</p>
   {pending?<div role="status" className="carton-move-pending"><p>上次移动结果待核对。将使用原请求核对，请勿重新分配。</p>{pending.body.moves.map((row,index)=><p key={index}>{row.boxes} 箱 → {row.toLocationCode} · 第{row.toLayerCount}层 · {row.toMarker||'无标记'}</p>)}</div>:<fieldset disabled={frozen}>
    {rows.map((row,index)=><section className="carton-move-row" key={row.key} aria-label={`目标库位 ${index+1}`}>
     <div className="carton-move-row-title"><b>目标 {index+1}</b>{rows.length>1&&<button type="button" onClick={()=>setRows(previous=>previous.filter(value=>value.key!==row.key))}>移除</button>}</div>
     <label>移动箱数<GoodsNumberInput aria-label={`目标 ${index+1} 移动箱数`} value={row.boxes} onChange={event=>update(row.key,{boxes:event.target.value})}/></label>
     <label>移动托盘数（选填）<input type="text" inputMode="decimal" aria-label={`目标 ${index+1} 移动托盘数`} value={row.pallets} placeholder="部分留空按0；全移最后空行带余量" onChange={event=>update(row.key,{pallets:event.target.value})}/></label>
     <label className="carton-move-target">目标库位<LocationSearchInput value={row.locationCode} codes={locations} onChange={locationCode=>update(row.key,{locationCode})}/></label>
     <label>层数<GoodsNumberInput aria-label={`目标 ${index+1} 层数`} value={row.layerCount} onChange={event=>update(row.key,{layerCount:event.target.value})}/></label>
     <label className="carton-move-marker">位置标记（选填）<input maxLength={500} value={row.marker} onChange={event=>update(row.key,{marker:event.target.value})}/></label>
     <label className="carton-move-row-note">备注<textarea maxLength={16000} value={row.note} onChange={event=>update(row.key,{note:event.target.value})}/></label>
    </section>)}
    <button type="button" onClick={()=>setRows(previous=>[...previous,{...previous[previous.length-1],key:Math.max(...previous.map(row=>row.key))+1,boxes:'',pallets:'',locationCode:''}])}>＋ 添加目标库位</button>
   </fieldset>}
   <p className="carton-move-summary">本次移动 {total} 箱{source&&!pending?`，原库位保留 ${Math.max(0,source.boxes-total)} 箱`:''}。</p>
   {!locations.length&&!pending&&<p role="alert">尚未读取可用库位，请关闭后刷新重试。</p>}
   {error&&<p role="alert" className="identity-error">{error}</p>}
  </div>
  <footer><button type="button" disabled={busy} onClick={onClose}>{pending?'关闭，稍后核对':'取消移动'}</button><button type="button" disabled={busy||(!pending&&!locations.length)} onClick={()=>void run()}>{busy?'正在保存…':pending?'核对上次提交':'确认移动'}</button></footer>
 </div></div>;
}
