"use client";
import {useCallback,useEffect,useRef,useState} from 'react';
import type {CartonReceipt} from '../lib/carton-flow';
import {palletCountValue,palletCountExceeds,palletRemaining,palletLabel} from '../lib/pallet';
import {cartonPalletCount} from '../lib/carton-flow';
import {cartonPlacementDetails} from '../lib/box-stock-details';
import {warehouseTodayDate} from '../lib/warehouse-time';
import {OperationDateHeader} from './OperationDateHeader';
import {GoodsNumberInput} from './GoodsNumberInput';
import {useWarehouseDateDefault} from './useWarehouseDateDefault';
import './CartonReceipts.css';
type Body={requestId:string;id:string;expectedVersion:number;outboundDate:string;picks:{key:string;boxes:number;pallets?:string}[]};
type Props={receipt:CartonReceipt;canOutbound:boolean;draftKey:string;onClose:()=>void;onChanged:()=>void|Promise<void>};
export function CartonOutboundDialog({receipt,canOutbound,draftKey,onClose,onChanged}:Props){
 const [date,setDate]=useState(warehouseTodayDate),[automatic,setAutomatic]=useState(true),[confirmed,setConfirmed]=useState(''),[picks,setPicks]=useState<Record<string,string>>({}),[pallets,setPallets]=useState<Record<string,string>>({}),[pending,setPending]=useState<Body|null>(null),[hydrated,setHydrated]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[done,setDone]=useState(false);
 const saving=useRef(false),key=`${draftKey}:carton-outbound:${receipt.id}`,recoveryKey=`${draftKey}:carton-outbound-recovery`;
 const retainRecovery=(body:Body)=>localStorage.setItem(recoveryKey,JSON.stringify({receipt,pending:body}));
 const clearRecovery=()=>{const raw=localStorage.getItem(recoveryKey);if(raw&&JSON.parse(raw).receipt?.id===receipt.id)localStorage.removeItem(recoveryKey);};
 useEffect(()=>{try{const raw=localStorage.getItem(key);if(raw){const saved=JSON.parse(raw);if(saved.pending?.id===receipt.id&&typeof saved.pending.requestId==='string'&&Array.isArray(saved.pending.picks)){setPending(saved.pending);setDate(saved.pending.outboundDate);setAutomatic(false);setPicks(Object.fromEntries(saved.pending.picks.map((p:{key:string;boxes:number})=>[p.key,String(p.boxes)])));setPallets(Object.fromEntries(saved.pending.picks.map((p:{key:string;pallets?:string})=>[p.key,p.pallets??''])));}else if(saved.picks&&typeof saved.picks==='object'){setPicks(saved.picks);setPallets(saved.pallets??{});}}}catch{setError('原草稿无法读取，请核对操作记录。');}setHydrated(true);},[key,receipt.id]);
 useEffect(()=>{if(!hydrated||done)return;try{localStorage.setItem(key,JSON.stringify({picks,pallets,pending}));if(pending)retainRecovery(pending);}catch{setError('浏览器无法保留草稿，请勿刷新，先核对本次操作。');}},[key,picks,pallets,pending,hydrated,done]);
 const refreshDate=useCallback((value:string)=>{setDate(value);setConfirmed('');},[]);
 useWarehouseDateDefault(hydrated&&automatic&&!pending&&!busy,date,refreshDate);
 const positive=receipt.placements.filter(p=>p.boxes>0),total=pending?pending.picks.reduce((s,p)=>s+p.boxes,0):positive.reduce((s,p)=>s+(Number(picks[p.key])||0),0);
 const invalid=positive.some(p=>{const value=picks[p.key]??'',count=palletCountValue(pallets[p.key]);return !Number.isFinite(count)||palletCountExceeds(count,cartonPalletCount(p))||(count>0&&!(Number(value)>0))||value!==''&&(!/^\d+$/.test(value)||!Number.isSafeInteger(Number(value))||Number(value)>p.boxes);});
 const locked=busy||!!pending||done||!hydrated;
 const submit=async()=>{
  if(saving.current||!canOutbound||done)return;
  if(!pending&&(confirmed!==date||!date||date>warehouseTodayDate()||positive.some(p=>Number(picks[p.key])>0&&date<cartonPlacementDetails(receipt,p).inboundDate)||invalid||total<=0)){setError('请确认有效出库日期，并填写不超过库存的箱数和非负托盘数。');return;}
  const body=pending??{requestId:crypto.randomUUID(),id:receipt.id,expectedVersion:receipt.version,outboundDate:date,picks:positive.filter(p=>Number(picks[p.key])>0).map(p=>({key:p.key,boxes:Number(picks[p.key]),pallets:pallets[p.key]??''}))};
  saving.current=true;setBusy(true);setError('');setPending(body);let accepted=false;
  try{
   // Persist the exact payload before sending, so a retry cannot deduct twice.
   localStorage.setItem(key,JSON.stringify({picks,pallets,pending:body}));retainRecovery(body);
   const response=await fetch('/api/cartons/outbound',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),data=await response.json();
   if(!response.ok){if(response.status>=400&&response.status<500){setPending(null);clearRecovery();localStorage.setItem(key,JSON.stringify({picks,pallets,pending:null}));}throw Error(data.error||'箱件出库失败');}
   accepted=true;await onChanged();localStorage.removeItem(key);clearRecovery();setDone(true);setPending(null);
  }catch(e){setError(accepted?'出库已提交，但页面刷新失败；请点“核对原请求”，不要重新出库。':e instanceof Error?e.message:'提交结果待确认，请核对原请求。');}finally{saving.current=false;setBusy(false);}
 };
 return <div className="carton-overlay" onKeyDown={e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();if(!busy)onClose();}}}><section className="carton-dialog carton-edit-dialog" role="dialog" aria-modal="true" aria-label="箱库存出库" aria-busy={busy}><OperationDateHeader title="箱库存出库" label="出库日期" value={date} confirmed={confirmed===date} onConfirm={()=>setConfirmed(date)} onChange={value=>{setDate(value);setAutomatic(false);setConfirmed('');}} onClose={onClose} disabled={busy} dateLocked={!!pending||done}/><div className="carton-content"><h3>{receipt.inboundOrder}</h3><p>{receipt.customerName||'商家待认领'} · 入库 {receipt.inboundDate}</p>{!done&&<><p>按箱数选择实际库位；原产品出库草稿会保留。</p><fieldset disabled={locked}><div className="carton-card-actions"><button type="button" onClick={()=>setPicks(Object.fromEntries(positive.map(p=>[p.key,String(p.boxes)])))}>全部出库</button><button type="button" onClick={()=>{setPicks({});setPallets({});}}>清除分配</button></div>{positive.map(p=><div className="carton-outbound-row" key={p.key}><span>{p.locationCode} · {p.layerCount}层 · {p.marker||'无标记'} · 可用 {p.boxes}箱 / {palletLabel(cartonPalletCount(p))}托盘{<> · {cartonPlacementDetails(receipt,p).product} · SKU {cartonPlacementDetails(receipt,p).sku||'无'} · 入库 {cartonPlacementDetails(receipt,p).inboundDate} · {cartonPlacementDetails(receipt,p).customerName||'待认领'}</>}</span><label>出库箱数<GoodsNumberInput aria-label={`${p.locationCode} ${p.key}出库箱数`} value={picks[p.key]??''} min="0" max={p.boxes} step="1" onChange={e=>setPicks(old=>({...old,[p.key]:e.target.value}))}/></label><label>出库托盘数（选填）<input type="text" inputMode="decimal" aria-label={`${p.locationCode} ${p.key}出库托盘数`} value={pallets[p.key]??''} placeholder="留空：部分不扣，出完清零" onChange={e=>setPallets(old=>({...old,[p.key]:e.target.value}))}/></label><span>剩余 {palletLabel(Number(picks[p.key])===p.boxes?0:palletRemaining(cartonPalletCount(p),palletCountValue(pallets[p.key])))} 托盘</span><button type="button" onClick={()=>setPicks(old=>({...old,[p.key]:String(p.boxes)}))}>此处全部</button><button type="button" onClick={()=>{setPicks(old=>({...old,[p.key]:''}));setPallets(old=>({...old,[p.key]:''}));}}>清除</button></div>)}</fieldset><p role="status">已分配 {total} 箱{invalid?' · 数量或托盘数无效或超过库存':''}</p><p className="carton-pending">本次按实际箱数扣减；体积和费用保持待核对。</p></>}{done&&<p role="status">{receipt.inboundOrder} 已出库 {total||Object.values(picks).reduce((s,v)=>s+(Number(v)||0),0)} 箱，其他出库草稿已保留。</p>}{error&&<p className="carton-error" role="alert">{error}</p>}</div><footer>{done?<button type="button" onClick={onClose}>完成</button>:<button type="button" disabled={busy||!hydrated||!canOutbound||(!pending&&(invalid||total<=0||confirmed!==date))} onClick={()=>void submit()}>{busy?'正在提交…':pending?'核对原请求':'确认箱件出库'}</button>}</footer></section></div>;
}
