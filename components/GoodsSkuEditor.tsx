"use client";
import {useState,useRef,useId} from 'react';
import {createPortal} from 'react-dom';
import type {GoodsChoice} from '../lib/goods-flow';

type SkuRequest={requestId:string;expectedRevision:number;key:string;members:{id:number;version:number}[];sku:string;confirmAll:true};
export function GoodsSkuEditor({choice,revision,draftKey,onClose,onSaved}:{choice:GoodsChoice;revision:number;draftKey:string;onClose:()=>void;onSaved:(result:{key:string;sku:string})=>Promise<void>}){
 const title=useId(),storageKey=draftKey+':sku:'+choice.key;
 const [restored]=useState<SkuRequest|null>(()=>{try{const raw=localStorage.getItem(storageKey),v=raw&&JSON.parse(raw);return v&&v.key===choice.key&&typeof v.requestId==='string'&&typeof v.sku==='string'&&v.confirmAll===true&&Array.isArray(v.members)?v:null;}catch{return null;}});
 const pending=useRef<SkuRequest|null>(restored),[sku,setSku]=useState(restored?.sku??choice.sku),[confirmed,setConfirmed]=useState(!!restored),[busy,setBusy]=useState(false),[uncertain,setUncertain]=useState(!!restored),[message,setMessage]=useState(restored?'上次修改结果尚待核对，将使用原请求重新核对。':'');
 const save=async()=>{
  if(busy||(!pending.current&&!confirmed))return;setBusy(true);setMessage('');let accepted=false;
  try{
   pending.current??={requestId:crypto.randomUUID(),expectedRevision:revision,key:choice.key,members:choice.members.map(r=>({id:r.id,version:r.version})),sku:sku.trim(),confirmAll:true};
   try{localStorage.setItem(storageKey,JSON.stringify(pending.current));}catch{}
   const response=await fetch('/api/goods/sku',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(pending.current)}),result=await response.json();
   if(!response.ok){if(response.status>=400&&response.status<500){pending.current=null;setUncertain(false);try{localStorage.removeItem(storageKey);}catch{}}throw Error(result.error||'SKU 修改失败');}
   accepted=true;await onSaved(result);try{localStorage.removeItem(storageKey);}catch{}pending.current=null;onClose();
  }catch(e){setUncertain(!!pending.current);setMessage(accepted?'SKU 已保存，页面更新未完成，请核对并重试刷新资料。':e instanceof Error?e.message:'无法读取修改结果，请核对并重试。');}finally{setBusy(false);}
 };
 return createPortal(<div className="goods-backdrop goods-sku-backdrop"><section className="goods-dialog goods-sku-dialog" role="dialog" aria-modal="true" aria-labelledby={title} aria-busy={busy}><header><div><h2 id={title}>修改产品 SKU</h2></div><button type="button" aria-label="关闭 SKU 修改" disabled={busy} onClick={onClose}>关闭</button></header><div className="goods-content"><p>{choice.product} · {choice.customerName}</p><p className="goods-sku-warning">此修改会同步更新这个产品的所有库位 SKU，包含当前为零库存的记录。其他产品的 SKU 不受影响。</p><p className="goods-help">当前关联 {choice.members.length} 条库存记录；件数、箱数、入库日期及条码保持原值。</p><label>新 SKU<input aria-label="新 SKU" value={sku} maxLength={500} disabled={busy||uncertain} onChange={e=>setSku(e.target.value)}/></label><label className="goods-sku-confirm"><input type="checkbox" checked={confirmed} disabled={busy||uncertain} onChange={e=>setConfirmed(e.target.checked)}/>我确认同步修改这个产品的所有库位 SKU</label>{message&&<p className="goods-line-error" role="status">{message}</p>}</div><footer className="goods-footer"><button type="button" className="goods-primary" disabled={busy||(!confirmed&&!uncertain)} onClick={()=>void save()}>{busy?'正在保存…':uncertain?'核对并重试修改':'确认同步修改'}</button></footer></section></div>,document.body);
}
