'use client';
import {useEffect,useRef,useState} from 'react';
import './UnclaimedCustomerPicker.css';
type Props={recordId:string;customers:string[];onSaved:()=>void};
export function UnclaimedCustomerPicker({recordId,customers,onSaved}:Props){
 const [customer,setCustomer]=useState(''),[confirming,setConfirming]=useState(false),[saving,setSaving]=useState(false),[error,setError]=useState('');
 const locked=useRef(false),active=useRef(true);
 useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
 const save=async()=>{
  if(locked.current||!confirming||!customer||!customers.includes(customer))return;
  locked.current=true;setSaving(true);setError('');
  try{
   const response=await fetch('/api/pricing/unclaimed-customer',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:recordId,customerName:customer})});
   const payload=await response.json();if(!response.ok)throw Error(payload.error||'客户认领未完成，请核对后重试');
   if(payload.ok!==true)throw Error('客户认领结果尚未确认，请刷新核对');
   if(active.current){setConfirming(false);setCustomer('');onSaved();}
  }catch(problem){if(active.current)setError(problem instanceof Error?problem.message:'客户认领结果尚未确认，请刷新核对');}
  finally{locked.current=false;if(active.current)setSaving(false);}
 };
 return <div className="unclaimed-customer-picker" aria-busy={saving}>
  <div className="ucp-controls"><select aria-label="认领客户" value={customer} disabled={saving} onChange={event=>{setCustomer(event.target.value);setConfirming(false);setError('');}}><option value="">选择客户</option>{customers.map(name=><option key={name} value={name}>{name}</option>)}</select>{!confirming&&<button type="button" disabled={!customer||saving} onClick={()=>setConfirming(true)}>认领客户</button>}</div>
  {confirming&&<div className="ucp-confirm"><span>确认将此条货物认领给「{customer}」？</span><button type="button" disabled={saving} onClick={()=>void save()}>{saving?'正在保存…':'确认认领'}</button><button type="button" disabled={saving} onClick={()=>{setConfirming(false);setError('');}}>取消</button></div>}
  {error&&<p className="ucp-error" role="alert">{error}</p>}
 </div>;
}
