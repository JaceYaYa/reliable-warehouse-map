"use client";
import {useEffect} from "react";

// Legacy map dialogs and newer inventory dialogs share the same keyboard behavior.
export function ModalFocus(){
 useEffect(()=>{
  let active:HTMLElement|null=null,frame=0;
  const returns=new Map<HTMLElement,HTMLElement|null>();
  const visible=(el:HTMLElement)=>el.getClientRects().length>0&&getComputedStyle(el).visibility!=="hidden";
  const controls=(el:HTMLElement)=>Array.from(el.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex]:not([tabindex="-1"])')).filter(n=>visible(n)&&!n.closest('[inert]')&&n.tabIndex>=0);
  const sync=()=>{
   frame=0;
   const candidates=Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"],dialog[open],.modal-backdrop > section,.modal-backdrop > .config-modal,.scanner-modal,.list-editor-drawer.open')).filter(visible);
   const depth=(el:HTMLElement)=>{let z=0,node:HTMLElement|null=el;while(node){z=Math.max(z,Number.parseInt(getComputedStyle(node).zIndex)||0);node=node.parentElement;}return z;};
   candidates.sort((a,b)=>depth(a)-depth(b));
   const next=candidates.at(-1)||null;if(next===active){const focused=document.activeElement;if(next&&(!(focused instanceof HTMLElement)||!next.contains(focused)||!visible(focused)||focused.matches(':disabled')))(controls(next)[0]||next).focus({preventScroll:true});return;}
   const previous=active;active=next;
   if(previous&&!candidates.includes(previous)){const trigger=returns.get(previous);returns.delete(previous);if(trigger?.isConnected&&(!next||next.contains(trigger)))trigger.focus({preventScroll:true});}
   if(next){if(!returns.has(next))returns.set(next,document.activeElement instanceof HTMLElement?document.activeElement:null);if(!next.hasAttribute('role'))next.setAttribute('role','dialog');if(next.tagName!=='DIALOG')next.setAttribute('aria-modal','true');if(!next.hasAttribute('aria-label')&&!next.hasAttribute('aria-labelledby'))next.setAttribute('aria-label',next.querySelector('h2')?.textContent||'库位操作');next.tabIndex=-1;if(!next.contains(document.activeElement))(next.querySelector<HTMLElement>('[autofocus]')||controls(next)[0]||next).focus({preventScroll:true});}
  };
  const schedule=()=>{if(!frame)frame=requestAnimationFrame(sync);};
  const observer=new MutationObserver(schedule);observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['class','open']});sync();
  const key=(event:KeyboardEvent)=>{
   if(!active)return;
   if(event.key==='Escape'){
    if(active.tagName==='DIALOG'||(event.target instanceof Element&&event.target.closest('[role="combobox"][aria-expanded="true"]')))return;
    event.preventDefault();event.stopImmediatePropagation();
    const buttons=Array.from(active.querySelectorAll<HTMLButtonElement>('button'));
    const close=buttons.find(b=>b.getAttribute('aria-label')?.startsWith('关闭'))||buttons.find(b=>/^(关闭|×|取消扫码)$/.test(b.textContent?.trim()||''));
    if(close&&visible(close)&&!close.disabled&&active.getAttribute('aria-busy')!=='true')close.click();
    return;
   }
   if(event.key!=='Tab')return;const items=controls(active),index=items.indexOf(document.activeElement as HTMLElement);if(!items.length){event.preventDefault();active.focus({preventScroll:true});}else if(event.shiftKey&&(index<=0)){event.preventDefault();items.at(-1)!.focus();}else if(!event.shiftKey&&(index===items.length-1||index<0)){event.preventDefault();items[0].focus();}
  };
  const focus=(event:FocusEvent)=>{if(active&&event.target instanceof Node&&!active.contains(event.target))(controls(active)[0]||active).focus({preventScroll:true});};
  document.addEventListener('keydown',key,true);document.addEventListener('focusin',focus);document.addEventListener('focusout',schedule);
  return()=>{observer.disconnect();cancelAnimationFrame(frame);document.removeEventListener('keydown',key,true);document.removeEventListener('focusin',focus);document.removeEventListener('focusout',schedule);};
 },[]);
 return null;
}
