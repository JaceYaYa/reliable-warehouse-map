"use client";
import {useCallback,useEffect,useState} from 'react';
import {pendingBoxCorrections,type BoxCorrectionRecovery} from '../lib/pending-box-corrections';
import {CartonCorrectionDialog} from './CartonCorrectionDialog';

export function PendingBoxCorrections({userId,canEdit,onChanged}:{userId:number;canEdit:boolean;onChanged:()=>Promise<void>}){
 const [rows,setRows]=useState<BoxCorrectionRecovery[]>([]),[active,setActive]=useState<BoxCorrectionRecovery|null>(null),[error,setError]=useState('');
 const refresh=useCallback(()=>{try{setRows(pendingBoxCorrections(localStorage,userId));setError('');}catch{setError('浏览器未能读取待核对的箱数修正，请先核对操作记录。');}},[userId]);
 useEffect(()=>{setActive(null);refresh();const events=['warehouse-box-correction-pending','focus','storage'];for(const event of events)window.addEventListener(event,refresh);return()=>{for(const event of events)window.removeEventListener(event,refresh);};},[refresh]);
 if(!rows.length&&!error&&!active)return null;
 return <section className="goods-feedback" aria-label="待核对箱数修正">{error&&<p role="alert">{error}</p>}{rows.map(row=><div key={row.requestId}><p>箱数修正结果待核对：{row.receipt.inboundOrder}。即使库存已清零，也请核对原请求。</p><button type="button" disabled={!canEdit} onClick={()=>setActive(row)}>核对箱数修正 {row.receipt.inboundOrder}</button></div>)}{!canEdit&&rows.length>0&&<p>当前账号缺少库存编辑权限，原请求保留。</p>}{active&&canEdit&&<CartonCorrectionDialog receipt={active.receipt} placementKey={active.placementKey} draftKey={active.draftKey} onChanged={onChanged} onClose={()=>{setActive(null);refresh();}}/>}</section>;
}
