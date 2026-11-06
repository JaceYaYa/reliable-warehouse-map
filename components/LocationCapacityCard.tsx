"use client";
import {useEffect,useRef,useState} from 'react';
import type {LocationLayerVolume} from '../lib/location-layer-volume';
import './LocationCapacityCard.css';
export type CapacityVolumePatch={layerVolumeM3?:number|null;layerVolumes?:Array<{layer:number;volumeM3:number|null}>;expectedLayerRevision?:number};
type Props={location:string;layers:number;canEdit:boolean;busy?:boolean;blocked?:boolean;onLayersChange:(value:number)=>void;onSave:(patch:CapacityVolumePatch)=>Promise<{layerVolume:LocationLayerVolume}>};
type Meta=LocationLayerVolume['locations'][string];
type Entry={raw:Record<string,string>;original:Record<string,string>;added:number[];revision:number;meta:Meta;shown:number;addRaw:string};
const inherited=(entry:Entry,layer:number)=>entry.meta.inherited.exceptions[layer]??entry.meta.inherited.base;
const effective=(entry:Entry,layer:number)=>entry.meta.overrides[layer]??inherited(entry,layer);
function fromInfo(info:LocationLayerVolume,location:string):Entry{
 const meta=info.locations?.[location];if(!meta||!Number.isSafeInteger(info.revision))throw Error('库位体积资料不完整，请刷新');
 const raw=Object.fromEntries(Object.entries(meta.overrides).map(([layer,value])=>[layer,String(value)]));
 return{raw,original:{...raw},added:[],revision:info.revision,meta,shown:100,addRaw:''};
}
const changes=(entry:Entry)=>Object.entries(entry.raw).filter(([layer,raw])=>raw!==(entry.original[layer]??String(inherited(entry,Number(layer)))));
export function LocationCapacityCard({location,layers,canEdit,busy=false,blocked=false,onLayersChange,onSave}:Props){
 const [entries,setEntries]=useState<Record<string,Entry>>({}),[error,setError]=useState(''),[loading,setLoading]=useState(false),[reload,setReload]=useState(0);const sequence=useRef(0),saving=useRef(false);
 useEffect(()=>{const id=++sequence.current,controller=new AbortController();let active=true;
  Promise.resolve().then(()=>{if(active){setLoading(true);setError('');}});
  fetch('/api/locations',{cache:'no-store',signal:controller.signal}).then(async response=>{const data=await response.json();if(!response.ok)throw Error(data.error||'库位体积读取失败');const next=fromInfo(data.layerVolume,location);if(!active||id!==sequence.current)return;setEntries(old=>old[location]&&changes(old[location]).length?old:{...old,[location]:next});}).catch(cause=>{if(active&&!controller.signal.aborted)setError(cause instanceof Error?cause.message:'库位体积读取失败');}).finally(()=>{if(active)setLoading(false)});return()=>{active=false;controller.abort()};
 },[location,reload]);
 const entry=entries[location],dirty=entry?changes(entry):[],changed=dirty.length>0;
 const update=(fn:(value:Entry)=>Entry)=>setEntries(old=>old[location]?{...old,[location]:fn(old[location])}:old);
 const save=async()=>{if(saving.current||!canEdit||busy||blocked||loading||!entry)return;
  const layerVolumes:Array<{layer:number;volumeM3:number|null}>=[];
  for(const [layer,raw] of dirty){const value=raw.trim(),number=Number(value);if(!value||(!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)||!Number.isFinite(number)||number<=0||number>1e6)){setError(`第${layer}层托盘立方米须填写大于0的数字，不得留空`);return;}layerVolumes.push({layer:Number(layer),volumeM3:number});}
  saving.current=true;setError('');try{const result=await onSave(changed?{layerVolumes,expectedLayerRevision:entry.revision}:{});const next=fromInfo(result.layerVolume,location);setEntries(old=>({...old,[location]:{...next,added:entry.added,shown:entry.shown}}));}catch(cause){setError(cause instanceof Error?cause.message:'保存失败，填写已保留');}finally{saving.current=false;}};
 const discard=()=>{setEntries(old=>{const next={...old};delete next[location];return next});setError('');setReload(n=>n+1)};
 const rows=entry?[...new Set([...Array.from({length:Math.min(Math.max(layers,1),entry.shown)},(_,index)=>index+1),...Object.keys(entry.meta.overrides).map(Number),...Object.keys(entry.meta.inherited.exceptions).map(Number),...entry.added,...Object.keys(entry.raw).map(Number)])].sort((a,b)=>a-b):[];
 const disabled=busy||loading||!entry||!canEdit;
 const add=()=>{if(!entry)return;const layer=Number(entry.addRaw);if(!/^[1-9]\d*$/.test(entry.addRaw)||!Number.isInteger(layer)||layer>10000){setError('新增层号须为1至10000的整数');return;}update(value=>({...value,added:[...value.added,layer],addRaw:''}));setError('');};
 return <section className={canEdit?'capacity-card location-capacity-card':'capacity-card location-capacity-card read-only-capacity'} aria-label="库位容量与体积"><header><b>{location} 最大容量</b>{canEdit?<button type="button" disabled={busy||blocked||loading||!entry} onClick={()=>void save()}>{busy?'保存中…':blocked?'请先保存地图':'保存容量'}</button>:<span>仅浏览</span>}</header>
 <div className="location-capacity-fields"><label>最大层数<input type="text" inputMode="numeric" aria-label="最大层数" value={layers} disabled={busy||!canEdit} onChange={event=>{if(/^\d*$/.test(event.target.value))onLayersChange(Number(event.target.value))}}/></label></div>
 <b className="layer-volume-heading">每层托盘立方米 <span>（m³/托）</span></b><div className="layer-volume-rows">{rows.map(layer=>{const raw=entry.raw[layer]??String(effective(entry,layer)),pending=dirty.some(([key])=>key===String(layer));return <div className="layer-volume-row" key={layer}><label>第{layer}层<input type="text" inputMode="decimal" aria-label={`第${layer}层托盘立方米（m³/托）`} value={raw} disabled={disabled} onChange={event=>{const raw=event.target.value;update(value=>({...value,raw:{...value.raw,[layer]:raw}}));setError('');}}/></label>{pending&&<small>待保存</small>}</div>})}</div>
 {entry&&layers>entry.shown&&<button type="button" onClick={()=>update(value=>({...value,shown:Math.min(10000,value.shown+100)}))}>显示更多层</button>}
 {canEdit&&<div className="layer-volume-add"><label>新增层号<input type="text" inputMode="numeric" aria-label="新增层号" value={entry?.addRaw??''} disabled={disabled} onChange={event=>update(value=>({...value,addRaw:event.target.value}))}/></label><button type="button" disabled={disabled} onClick={add}>添加层</button></div>}
 <small>同层多种货物算一层。最大层数0表示不限。可添加容量以外的层号，体积设置不改变最大层数。各层可分别填写，保存后按填写数值计算。</small>{loading&&<p role="status">正在读取体积…</p>}{error&&<p className="location-capacity-error" role="alert">{error}</p>}{canEdit&&(error||changed)&&<button type="button" className="location-capacity-refresh" disabled={busy||loading} onClick={discard}>{changed?'放弃体积修改并刷新':'重新读取体积'}</button>}</section>;
}
