"use client";
import {useEffect,useState} from 'react';
import {LayerStoragePricingWorkspace} from './LayerStoragePricingWorkspace';
import {PricingWorkspace} from './pricing';
import type {PricingSettings} from '../lib/pricing';
type Props={onNotice:(message:string)=>void;onStockCustomerSaved:()=>void;onDefaultsChange:(value:PricingSettings)=>void};
export function StoragePricingWorkspace(props:Props){
 const[basis,setBasis]=useState<'layer'|'legacy'|null>(null),[error,setError]=useState(''),[retry,setRetry]=useState(0);
 useEffect(()=>{
  let active=true;
  setError('');
  const fallback='暂时无法读取计价方式，请重试';
  void fetch('/api/pricing/basis',{cache:'no-store'}).then(async response=>{
   const data=await response.json().catch(()=>null);
   if(!active)return;
   if(!response.ok||!(data?.basis==='layer'||data?.basis==='legacy')){
    setError(typeof data?.error==='string'&&data.error?data.error:fallback);
    return;
   }
   setBasis(data.basis);
  }).catch(()=>{if(active)setError(fallback)});
  return()=>{active=false};
 },[retry]);
 if(error)return <div role="alert"><p>{error}</p><button onClick={()=>setRetry(n=>n+1)}>重新读取计价方式</button></div>;
 if(basis===null)return <p role="status">正在读取计价方式…</p>;
 return basis==='layer'?<LayerStoragePricingWorkspace onNotice={props.onNotice}/>:<PricingWorkspace canEdit canEditStockCustomer onStockCustomerSaved={props.onStockCustomerSaved} onDefaultsChange={props.onDefaultsChange} onNotice={props.onNotice}/>;
}
