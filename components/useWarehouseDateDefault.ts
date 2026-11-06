"use client";
import {useEffect} from 'react';
import {warehouseTodayDate} from '../lib/warehouse-time';

/** Only refresh automatic dates; explicit dates and uncertain submissions stay fixed. */
export function useWarehouseDateDefault(active:boolean,value:string,onChange:(date:string)=>void){
 useEffect(()=>{
  if(!active)return;
  const refresh=()=>{if(document.visibilityState==='hidden')return;const date=warehouseTodayDate();if(date!==value)onChange(date);};
  refresh();
  const timer=window.setInterval(refresh,30000);
  window.addEventListener('focus',refresh);
  document.addEventListener('visibilitychange',refresh);
  return()=>{window.clearInterval(timer);window.removeEventListener('focus',refresh);document.removeEventListener('visibilitychange',refresh);};
 },[active,value,onChange]);
}
