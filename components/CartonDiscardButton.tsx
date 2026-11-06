"use client";
import {useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import type {CartonReceipt} from '../lib/carton-flow';
import './CartonDiscardButton.css';
export function CartonDiscardButton({receipt,placementKey,onDeleted}:{receipt:CartonReceipt;placementKey:string;onDeleted:()=>void|Promise<void>}){
 const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const pending=useRef<{requestId:string;id:string;placementKey:string;expectedVersion:number}|null>(null);
 const placement=receipt.placements.find(p=>p.key===placementKey);
 if(!placement||placement.boxes<=0)return null;
 const submit=async()=>{if(busy)return;setBusy(true);setError('');pending.current??={requestId:crypto.randomUUID(),id:receipt.id,placementKey,expectedVersion:receipt.version};
  try{const r=await fetch('/api/cartons/discard',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify(pending.current)}),data=await r.json();if(!r.ok){if(r.status<500)pending.current=null;throw Error(data.error||'删除失败，请重试');}await onDeleted();pending.current=null;setOpen(false);}
  catch(e){setError(e instanceof Error?e.message:'删除结果尚未确认，请使用原请求重试。');}finally{setBusy(false);}};
 return <><button type="button" className="delete-stock" aria-label={`删除箱库存 ${receipt.inboundOrder} ${placement.locationCode} ${placement.layerCount}层`} onClick={()=>{setError('');setOpen(true)}}>删除</button>{open&&createPortal(<div className="carton-delete-backdrop"><section role="dialog" aria-modal="true" aria-label="删除箱库存" className="carton-delete-dialog"><h2>删除箱库存</h2><p><b>{receipt.inboundOrder}</b></p><p>{placement.locationCode} · 第 {placement.layerCount} 层 · {placement.boxes} 箱</p><p>只删除这里的箱数，其他库位保留。不记为出库，可在操作记录中撤销恢复。</p>{error&&<p role="alert">{error}</p>}<footer><button type="button" disabled={busy} onClick={()=>setOpen(false)}>取消</button><button type="button" disabled={busy} onClick={()=>void submit()}>{busy?'正在删除…':pending.current?'核对上次删除':'确认删除箱库存'}</button></footer></section></div>,document.body)}</>;
}
