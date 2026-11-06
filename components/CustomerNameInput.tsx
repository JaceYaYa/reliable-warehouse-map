"use client";
import {useEffect,useId,useMemo,useRef,useState} from "react";
import "./customer-name-input.css";

type Props={value:string;onChange:(value:string)=>void;customerNames:readonly string[];label?:string;id?:string;disabled?:boolean;className?:string;placeholder?:string;emptyOption?:string};
const searchKey=(value:string)=>value.normalize("NFKC").trim().toLocaleLowerCase();
export function CustomerNameInput({value,onChange,customerNames,label="客户名称",id,disabled=false,className="",placeholder="填写或选择客户",emptyOption}:Props){
  const generated=useId(),inputId=id||generated,menuId=`${generated}-customers`,root=useRef<HTMLDivElement>(null),input=useRef<HTMLInputElement>(null);
  const [open,setOpen]=useState(false),[showAll,setShowAll]=useState(false),[active,setActive]=useState(-1);
  const names=useMemo(()=>[...new Set(customerNames.filter(name=>typeof name==="string"&&name.trim()))].sort((a,b)=>a.localeCompare(b,"zh-CN")),[customerNames]);
  const options=(emptyOption?[{value:"",label:emptyOption}]:[]).concat(names.filter(name=>showAll||!searchKey(value)||searchKey(name).includes(searchKey(value))).map(name=>({value:name,label:name})));
  const expanded=open&&!disabled;
  useEffect(()=>{if(!expanded)return;const outside=(event:PointerEvent)=>{if(!root.current?.contains(event.target as Node))setOpen(false)};document.addEventListener("pointerdown",outside);return()=>document.removeEventListener("pointerdown",outside)},[expanded]);
  useEffect(()=>{if(expanded&&active>=0)document.getElementById(`${menuId}-${active}`)?.scrollIntoView({block:"nearest"})},[expanded,active,menuId]);
  const choose=(name:string)=>{onChange(name);setOpen(false);setActive(-1);input.current?.focus({preventScroll:true})};
  return <div ref={root} className={`customer-name-combo ${className}`} onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node))setOpen(false)}}>
    <input ref={input} id={inputId} className="customer-name-input" role="combobox" aria-label={label} aria-autocomplete="list" aria-expanded={expanded} aria-controls={expanded?menuId:undefined} aria-activedescendant={expanded&&active>=0&&options[active]?`${menuId}-${active}`:undefined} value={value} disabled={disabled} maxLength={500} autoComplete="off" placeholder={placeholder} onChange={event=>{onChange(event.target.value);setOpen(true);setShowAll(false);setActive(-1)}} onKeyDown={event=>{
      if(event.nativeEvent.isComposing||event.nativeEvent.keyCode===229)return;
      if(event.key==="ArrowDown"||event.key==="ArrowUp"){event.preventDefault();event.stopPropagation();if(!expanded){setOpen(true);setShowAll(true);setActive(-1)}else setActive(index=>event.key==="ArrowDown"?Math.min(index+1,options.length-1):Math.max(index-1,0));}
      else if(event.key==="Enter"&&expanded&&active>=0&&options[active]){event.preventDefault();event.stopPropagation();choose(options[active].value)}
      else if(event.key==="Escape"&&expanded){event.preventDefault();event.stopPropagation();setOpen(false);setActive(-1)}
      else if(event.key==="Tab"||event.key==="Enter")setOpen(false);
    }}/>
    <button type="button" className="customer-name-toggle" aria-label={`选择已有${label}`} aria-haspopup="listbox" aria-expanded={expanded} disabled={disabled} onClick={event=>{event.preventDefault();event.stopPropagation();setOpen(!expanded);setShowAll(true);setActive(-1);input.current?.focus({preventScroll:true})}}>⌄</button>
    {expanded&&<div id={menuId} className="customer-name-options" role="listbox" aria-label={`${label}选项`}>{options.map((option,index)=><button id={`${menuId}-${index}`} type="button" role="option" aria-selected={value===option.value} className={active===index?"active":""} key={option.value} tabIndex={-1} onPointerDown={event=>event.preventDefault()} onClick={event=>{event.preventDefault();event.stopPropagation();choose(option.value)}}>{option.label}</button>)}{!options.length&&<p>没有匹配的客户，可直接填写新名称。</p>}</div>}
  </div>;
}
