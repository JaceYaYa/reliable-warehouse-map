"use client";
import {useId,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import type {GoodsChoice} from '../lib/goods-flow';
import {emptyGoodsProductSpec,parseGoodsProductSpec,type GoodsProductSpec} from '../lib/goods-product-spec';
import {GoodsProductDimensions} from './GoodsProductDimensions';
import './GoodsProductSpecEditor.css';

type SpecRequest={requestId:string;expectedRevision:number;key:string;members:{id:number;version:number}[];productSpec:GoodsProductSpec;confirmAll:true};
export type GoodsProductSpecSaveResult={ok:true;key:string;previousKey:string;categoryId:string;productSpec:GoodsProductSpec;revision:number;stockIds:number[]};
type Props={open?:boolean;choice:GoodsChoice;revision:number;draftKey:string;disabled?:boolean;onClose:()=>void;onSaved:(result:GoodsProductSpecSaveResult)=>void|Promise<void>};
function readPending(key:string):SpecRequest|null{
 try{
  const raw=localStorage.getItem(key),v=raw&&JSON.parse(raw);
  if(!v||typeof v.requestId!=='string'||!/^[-\da-f]{36}$/i.test(v.requestId)||typeof v.key!=='string'||!Number.isSafeInteger(v.expectedRevision)||v.confirmAll!==true||!Array.isArray(v.members)||v.members.some((r:{id:unknown;version:unknown})=>!r||!Number.isSafeInteger(r.id)||!Number.isSafeInteger(r.version)))return null;
  parseGoodsProductSpec(v.productSpec,true);return v as SpecRequest;
 }catch{return null}
}
export function GoodsProductSpecEditor({open=true,choice,revision,draftKey,disabled=false,onClose,onSaved}:Props){
 const id=useId(),storageKey=draftKey+':product-spec:'+encodeURIComponent(JSON.stringify([choice.customerName,choice.product]));
 const [restored]=useState(()=>readPending(storageKey)),pending=useRef<SpecRequest|null>(restored),saving=useRef(false);
 const [value,setValue]=useState<GoodsProductSpec>(restored?.productSpec??choice.productSpec??emptyGoodsProductSpec()),[confirmed,setConfirmed]=useState(!!restored),[busy,setBusy]=useState(false),[uncertain,setUncertain]=useState(!!restored),[message,setMessage]=useState(restored?'上次保存结果尚待核对，将使用原请求核对。':'');
 let problem='';try{parseGoodsProductSpec(value,true)}catch(e){problem=e instanceof Error?e.message:'请填写有效体积'}
 const locked=disabled||busy||uncertain;
 const save=async()=>{
  if(disabled||saving.current||(!pending.current&&(!confirmed||problem)))return;
  saving.current=true;setBusy(true);setMessage('');let accepted=false;
  try{
   pending.current??={requestId:crypto.randomUUID(),expectedRevision:revision,key:choice.key,members:choice.members.map(r=>({id:r.id,version:r.version})),productSpec:parseGoodsProductSpec(value,true),confirmAll:true};
   try{localStorage.setItem(storageKey,JSON.stringify(pending.current))}catch{}
   const response=await fetch('/api/goods/spec',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(pending.current)});
   let result;try{result=await response.json()}catch{throw Error('无法读取保存结果，请使用原请求核对，避免重复保存。')}
   if(!response.ok){if(response.status>=400&&response.status<500){pending.current=null;setUncertain(false);try{localStorage.removeItem(storageKey)}catch{}}throw Error(result.error||'体积/尺寸保存失败，填写仍保留。')}
   if(result.ok!==true||typeof result.key!=='string'||typeof result.previousKey!=='string'||!Number.isSafeInteger(result.revision))throw Error('保存结果不完整，请核对上次保存。');
   result.productSpec=parseGoodsProductSpec(result.productSpec,true);accepted=true;
   window.dispatchEvent(new CustomEvent('warehouse-goods-spec-updated',{detail:{previousKey:result.previousKey,nextKey:result.key,productSpec:result.productSpec,revision:result.revision}}));
   await onSaved(result as GoodsProductSpecSaveResult);
   try{localStorage.removeItem(storageKey)}catch{}pending.current=null;setUncertain(false);onClose();
  }catch(e){setUncertain(!!pending.current);setMessage(accepted?'产品体积/尺寸已保存，页面更新未完成；请核对上次保存再刷新资料。':e instanceof Error?e.message:'无法读取结果，请核对上次保存。')}
  finally{saving.current=false;setBusy(false)}
 };
 if(!open)return null;
 return createPortal(<div className="goods-spec-backdrop"><section className="goods-spec-dialog" role="dialog" aria-modal="true" aria-labelledby={id} aria-busy={busy}><header><div><h2 id={id}>修改产品体积/尺寸</h2><p>{choice.product} · {choice.customerName}</p></div><button type="button" aria-label="关闭产品体积修改" disabled={busy} onClick={onClose}>关闭</button></header><div className="goods-spec-body"><p>此修改保存为产品资料，今后的入库会沿用。原库位、历史计价批次和已生成费用保持原值。</p><GoodsProductDimensions value={value} disabled={locked} onChange={next=>{setValue(next);setMessage('')}}/><label className="goods-spec-confirm"><input type="checkbox" disabled={locked} checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>我确认修改这个产品的体积/尺寸，供今后的入库使用</label>{message&&<p className="goods-spec-feedback" role="status">{message}</p>}{!message&&problem&&<p className="goods-spec-feedback">{problem}</p>}</div><footer><button type="button" disabled={busy} onClick={onClose}>取消</button><button type="button" className="goods-spec-save" disabled={disabled||busy||(!uncertain&&(!confirmed||!!problem))} onClick={()=>void save()}>{busy?'正在保存…':uncertain?'核对上次保存':'保存产品资料'}</button></footer></section></div>,document.body);
}
