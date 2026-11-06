"use client";
import {useEffect,useId,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import './OperationDateHeader.css';
export function PlacementNote({value,onChange,disabled=false}:{value:string;onChange:(value:string)=>void;disabled?:boolean}){
 const [open,setOpen]=useState(false),[draft,setDraft]=useState(''),id=useId(),editor=useRef<HTMLTextAreaElement>(null),trigger=useRef<HTMLButtonElement>(null);
 const close=()=>{setOpen(false);trigger.current?.focus();};
 useEffect(()=>{if(!open)return;editor.current?.focus();const escape=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close();}if(e.key==='Tab'){const nodes=[...(editor.current?.closest('section')?.querySelectorAll<HTMLElement>('textarea,button')??[])];const at=nodes.indexOf(document.activeElement as HTMLElement);if(e.shiftKey&&at===0){e.preventDefault();nodes.at(-1)?.focus();}else if(!e.shiftKey&&at===nodes.length-1){e.preventDefault();nodes[0]?.focus();}}};document.addEventListener('keydown',escape,true);return()=>document.removeEventListener('keydown',escape,true);},[open]);
 return <div className="placement-note-control"><span>备注</span><button ref={trigger} type="button" disabled={disabled} aria-label={value.trim()?'修改库位备注':'填写库位备注'} onClick={()=>{setDraft(value);setOpen(true);}}>{value.trim()?'备注已填写':'＋'}</button>{open&&createPortal(<div className="placement-note-overlay"><section className="placement-note-dialog" role="dialog" aria-modal="true" aria-labelledby={id}><h2 id={id}>备注</h2><textarea ref={editor} aria-label="库位备注" maxLength={16000} value={draft} onChange={e=>setDraft(e.target.value)}/><div><button type="button" onClick={close}>取消</button><button type="button" onClick={()=>{onChange(draft);close();}}>保存备注</button></div></section></div>,document.body)}</div>;
}
