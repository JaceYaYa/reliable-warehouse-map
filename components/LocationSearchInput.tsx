"use client";
import {useContext,useEffect,useId,useRef,useState} from 'react';
import {LocationSummaryContext} from './LocationSummaryContext';
import {matchingLocationCodes,searchLocationCodes} from '../lib/location-code';

type Props={value:string;codes:readonly string[];onChange:(code:string)=>void};
export function LocationSearchInput({value,codes,onChange}:Props){
 const summaries=useContext(LocationSummaryContext);
 const id=useId(),root=useRef<HTMLDivElement>(null),input=useRef<HTMLInputElement>(null),committed=useRef(value);
 const [query,setQuery]=useState(value),[open,setOpen]=useState(false),[active,setActive]=useState(-1),[above,setAbove]=useState(false),[height,setHeight]=useState(220);
 const matches=searchLocationCodes(codes,query),options=matches.slice(0,30),expanded=open;
 useEffect(()=>{if(value!==committed.current){committed.current=value;setQuery(value);setActive(-1);}},[value]);
 useEffect(()=>{if(!open)return;const outside=(e:PointerEvent)=>{if(!root.current?.contains(e.target as Node))setOpen(false);};document.addEventListener('pointerdown',outside);return()=>document.removeEventListener('pointerdown',outside);},[open]);
 useEffect(()=>{if(!open)return;const box=root.current,scroll=box?.closest('.goods-content');if(!box)return;const resize=()=>{const bounds=box.getBoundingClientRect(),container=scroll?.getBoundingClientRect(),top=container?.top??0,bottom=container?.bottom??window.innerHeight,below=bottom-bounds.bottom-8,over=bounds.top-top-8,up=below<160&&over>below;setAbove(false);setHeight(Math.max(90,Math.min(280,below)));};resize();window.addEventListener('resize',resize);scroll?.addEventListener('scroll',resize,{passive:true});return()=>{window.removeEventListener('resize',resize);scroll?.removeEventListener('scroll',resize);};},[open]);
 useEffect(()=>{if(open&&active>=0)document.getElementById(`${id}-${active}`)?.scrollIntoView({block:'nearest'});},[open,active,id]);
 const choose=(code:string,focus=true)=>{committed.current=code;setQuery(code);onChange(code);setOpen(false);setActive(-1);if(focus)input.current?.focus({preventScroll:true});};
 return <div ref={root} className="goods-location-search" onBlur={e=>{if(!e.currentTarget.contains(e.relatedTarget as Node)){const exact=matchingLocationCodes(codes,query);if(exact.length===1)choose(exact[0],false);else setOpen(false);}}}>
 <input ref={input} role="combobox" aria-label="库位" aria-autocomplete="list" aria-expanded={expanded} aria-controls={expanded?id:undefined} aria-activedescendant={expanded&&active>=0&&options[active]?`${id}-${active}`:undefined} autoComplete="off" maxLength={100} placeholder="输入库位编号搜索" value={query} onFocus={()=>setOpen(true)} onChange={e=>{setQuery(e.target.value);setOpen(true);setActive(-1);if(value){committed.current='';onChange('');}}} onKeyDown={e=>{
  if(e.nativeEvent.isComposing||e.nativeEvent.keyCode===229)return;
  if(e.key==='Tab'){const exact=matchingLocationCodes(codes,query);if(exact.length===1)choose(exact[0],false);else setOpen(false);}
  else if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();e.stopPropagation();setOpen(true);setActive(previous=>e.key==='ArrowDown'?Math.min(previous+1,options.length-1):Math.max(previous-1,0));}
  else if(e.key==='Enter'){e.preventDefault();e.stopPropagation();if(expanded&&active>=0&&options[active])choose(options[active]);else{const exact=matchingLocationCodes(codes,query);if(exact.length===1)choose(exact[0]);else setOpen(true);}}
  else if(e.key==='Escape'&&expanded){e.preventDefault();e.stopPropagation();setOpen(false);setActive(-1);}
 }}/>
 {expanded&&<div id={id} tabIndex={-1} role="listbox" aria-label="匹配库位" className={`goods-location-options${above?' goods-location-options-above':''}`} style={{maxHeight:height}}>
 {options.map((code,index)=><button type="button" role="option" id={`${id}-${index}`} tabIndex={-1} aria-selected={active===index} key={code} onPointerDown={e=>e.preventDefault()} onClick={e=>{e.preventDefault();e.stopPropagation();choose(code);}}>{code}</button>)}
 {!options.length&&<p>{query.trim()?'没有匹配的库位，请修改搜索内容。':'输入库位编号，例如 A1。'}</p>}{matches.length>30&&<p>显示前 30 个匹配库位，请继续输入缩小范围。</p>}
 </div>}
 {query.trim()&&!value&&!expanded&&<small className="goods-location-unselected">请输入完整库位编号或从提示中选择</small>}
 {value&&<small className="location-stock-summary">{summaries[value]??'0 种产品 · 0件 / 0箱'}</small>}
 </div>;
}
