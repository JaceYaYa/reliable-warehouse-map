"use client";

import {useRef,useState} from 'react';
import {LocationSearchInput} from './LocationSearchInput';
import {parseLayerPricingConfig,resolveLayerVolume,type LayerOccupancy,type LayerPricingConfig} from '../lib/layer-storage';
import {locationCodeKey} from '../lib/location-code';
import type {LocationAliases} from '../lib/location-aliases';
import type {WarehouseZoneRecord} from '../lib/warehouse-layout';
import './LayerPricingSettings.css';

type Props={config:LayerPricingConfig;occupied:LayerOccupancy[];locations:string[];zones:WarehouseZoneRecord[];aliases?:LocationAliases;onSave:(config:LayerPricingConfig)=>Promise<void>};
type RawRule={volume:string;shares?:Array<{customerName:string;percent:string}>};
type RawLocation={volume:string;layers:Record<string,RawRule>};
type Draft=Record<string,RawLocation>;
const sourceNames:Record<string,string>={layer:'单层设置',location:'库位设置','builtin-exception':'指定层规则','one-piece-zone':'一件代发区域',default:'全仓默认'};

function toDraft(config:LayerPricingConfig,aliases:LocationAliases):Draft{
 const links=new Map(Object.entries(aliases).map(([from,to])=>[locationCodeKey(from),locationCodeKey(to)]));
 const canonical=(value:string)=>{let code=locationCodeKey(value);const seen=new Set<string>();while(links.has(code)){if(seen.has(code))throw Error('库位更名记录循环，请先核对');seen.add(code);code=links.get(code)!;}return code;};
 const output:Draft=Object.create(null);
 for(const [original,location] of Object.entries(config.locations)){
  const code=canonical(original),existing=output[code]??{volume:'',layers:{}};
  const volume=location.defaultVolumeM3===undefined?'':String(location.defaultVolumeM3);
  if(existing.volume&&volume&&existing.volume!==volume)throw Error(`更名后库位体积冲突：${code}`);
  existing.volume=existing.volume||volume;
  for(const [layer,rule] of Object.entries(location.layers)){
   const previous=existing.layers[layer]??{volume:''},nextVolume=rule.volumeM3===undefined?'':String(rule.volumeM3);
   const nextShares=rule.shares?.map(s=>({customerName:s.customerName,percent:String(s.percent)}));
   if(previous.volume&&nextVolume&&previous.volume!==nextVolume)throw Error(`更名后单层体积冲突：${code} 第 ${layer} 层`);
   // Ignored legacy metadata never blocks renamed-location volume edits; keep the first saved value.
   existing.layers[layer]={volume:previous.volume||nextVolume,...(previous.shares||nextShares?{shares:previous.shares??nextShares}:{})};
  }
  output[code]=existing;
 }
 return output;
}
function decimal(raw:string,max:number,allowZero=false):number|null{
 if(!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw.trim()))return null;
 const value=Number(raw);return Number.isFinite(value)&&value<=max&&(allowZero?value>=0:value>0)?value:null;
}
export function LayerPricingSettings({config,occupied,locations,zones,aliases={},onSave}:Props){
 const source=JSON.stringify([locations.map(locationCodeKey).sort(),Object.entries(aliases).map(([from,to])=>[locationCodeKey(from),locationCodeKey(to)]).sort((a,b)=>a[0].localeCompare(b[0])),zones.map(zone=>[zone.id,zone.codes.map(locationCodeKey).sort()]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])))]);
 const [draft,setDraft]=useState<Draft>(()=>toDraft(config,aliases));
 const [openedRevision,setOpenedRevision]=useState(config.revision);
 const [openedSource,setOpenedSource]=useState(source);
 const [selected,setSelected]=useState(()=>locationCodeKey(locations[0]??''));
 const [layer,setLayer]=useState(1),[layerInput,setLayerInput]=useState('1');
 const [error,setError]=useState(''),[layerError,setLayerError]=useState('');
 const [saving,setSaving]=useState(false),[saved,setSaved]=useState(false);
 const request=useRef(false);
 const stale=config.revision!==openedRevision||source!==openedSource;
 // Adopt the parent's confirmed save response once. Ordinary refreshes never replace a draft.
 if(saved&&stale){setDraft(toDraft(config,aliases));setOpenedRevision(config.revision);setOpenedSource(source);setSaved(false);setError('');}

 const selectedLabel=locations.find(code=>locationCodeKey(code)===selected);
 const locationOccupied=occupied.filter(item=>locationCodeKey(item.locationCode)===selected);
 const update=(change:(current:Draft)=>Draft)=>{setDraft(change);setError('');setSaved(false);};
 const local=draft[selected]??{volume:'',layers:{}};
 const rule=local.layers[String(layer)]??{volume:''};
 const selectedOccupancy=locationOccupied.find(item=>item.layer===layer);
 const customers=selectedOccupancy?.customers.map(c=>c.customerName)??[];
 const unknown=customers.some(name=>!name.trim());
 const previewLocation={layers:{[String(layer)]:{...(decimal(rule.volume,1e6)!==null?{volumeM3:decimal(rule.volume,1e6)!}:{})}},...(decimal(local.volume,1e6)!==null?{defaultVolumeM3:decimal(local.volume,1e6)!}:{})};
 const preview=selected?resolveLayerVolume({schemaVersion:1,revision:openedRevision,locations:{[selected]:previewLocation}},selected,layer,zones,aliases):null;
 const volumeInvalid=!!local.volume.trim()&&decimal(local.volume,1e6)===null||!!rule.volume.trim()&&decimal(rule.volume,1e6)===null;
 const layerOptions=[...new Set([...locationOccupied.map(o=>o.layer),...Object.keys(local.layers).map(Number)])].sort((a,b)=>b-a);
 const setLocation=(code:string)=>{setSelected(locationCodeKey(code));setLayer(1);setLayerInput('1');setLayerError('');setError('');};
 const editLocation=(value:string)=>update(current=>({...current,[selected]:{...(current[selected]??{volume:'',layers:{}}),volume:value}}));
 const editRule=(change:(value:RawRule)=>RawRule)=>update(current=>{const location=current[selected]??{volume:'',layers:{}};return {...current,[selected]:{...location,layers:{...location.layers,[String(layer)]:change(location.layers[String(layer)]??{volume:''})}}};});
 const cancel=()=>{setDraft(toDraft(config,aliases));setOpenedRevision(config.revision);setOpenedSource(source);setError('');setLayerError('');setSaved(false);setLayerInput(String(layer));if(selectedLabel===undefined)setLocation(locations[0]??'');};
 const chooseLayer=()=>{const value=Number(layerInput);if(!/^\d+$/.test(layerInput.trim())||!Number.isInteger(value)||value<1||value>10000){setLayerError('层号请输入 1–10000 的整数');return;}setLayer(value);setLayerInput(String(value));setLayerError('');setError('');};
 const buildConfig=():LayerPricingConfig=>{
  const next:LayerPricingConfig={schemaVersion:1,revision:openedRevision,locations:{}};
  for(const [code,location] of Object.entries(draft)){
   const output:LayerPricingConfig['locations'][string]={layers:{}};
   if(location.volume.trim()){const value=decimal(location.volume,1e6);if(value===null)throw Error(`${code} 的默认体积请输入大于 0、且不超过 1000000 的数字`);output.defaultVolumeM3=value;}
   for(const [number,raw] of Object.entries(location.layers)){
    const item:LayerPricingConfig['locations'][string]['layers'][string]={};
    if(raw.volume.trim()){const value=decimal(raw.volume,1e6);if(value===null)throw Error(`${code} 第 ${number} 层体积请输入大于 0、且不超过 1000000 的数字`);item.volumeM3=value;}
    // Legacy metadata is round-tripped untouched; the full-layer rule does not use it.
    if(raw.shares)item.shares=raw.shares.map(s=>({customerName:s.customerName,percent:Number(s.percent)}));
    if(Object.keys(item).length)output.layers[number]=item;
   }
   if(output.defaultVolumeM3!==undefined||Object.keys(output.layers).length)next.locations[code]=output;
  }
  return parseLayerPricingConfig(next);
 };
 const save=async()=>{
  if(request.current)return;
  if(stale){setError('配置版本已变化，请取消修改并载入最新版本后重新填写');return;}
  if(!selected||selectedLabel===undefined){setError('请先搜索并选择一个实际库位');return;}
  let next:LayerPricingConfig;try{next=buildConfig();}catch(cause){setError(cause instanceof Error?cause.message:'设置内容无效，请核对填写');return;}
  request.current=true;setSaving(true);setError('');setSaved(false);
  try{await onSave(next);setSaved(true);}catch(cause){setError(cause instanceof Error?cause.message:'保存失败，请重试');}finally{request.current=false;setSaving(false);}
 };

 return <form className="layer-pricing-settings" onSubmit={event=>{event.preventDefault();void save();}}>
  <header className="layer-settings-heading"><div><p>托层配置</p><h2>库位计价体积</h2><span>每客户独立计整层；同客户同层多种货物只计一次。</span></div><span className="layer-settings-revision">版本 {openedRevision}</span></header>
  {stale&&<div className="layer-settings-notice" role="alert">{config.revision!==openedRevision?<>配置版本已变化：当前填写基于版本 {openedRevision}，最新版本为 {config.revision}。</>:'实际库位或更名资料已变化。'}填写已保留，请取消修改以载入最新设置。</div>}
  <fieldset disabled={saving} className="layer-settings-fields">
   <div className="layer-settings-location"><label>搜索库位<LocationSearchInput value={selectedLabel??selected} codes={locations} onChange={setLocation}/></label><span>{selected?`${selectedLabel??selected} · ${locationOccupied.length} 个有货层`:'请从搜索结果选择库位'}</span></div>
   {selected&&selectedLabel!==undefined&&<>
    <section className="layer-settings-default"><div><h3>库位默认体积</h3><p>留空沿用规则，单层设置优先。</p></div><label className="layer-settings-volume"><span>每层 m³</span><input type="text" inputMode="decimal" aria-label="库位默认体积（m³）" aria-invalid={!!local.volume.trim()&&decimal(local.volume,1e6)===null} autoComplete="off" placeholder="沿用规则" value={local.volume} onChange={event=>editLocation(event.target.value)} disabled={saving}/></label></section>
    <section className="layer-settings-detail">
     <div className="layer-settings-layer-picker"><div><h3>单层设置</h3><p>可直接输入层号；只配置计价体积。</p></div><div className="layer-settings-layer-entry"><label><span>层号</span><input type="text" inputMode="numeric" aria-label="选择层号" aria-invalid={!!layerError} value={layerInput} onChange={event=>{setLayerInput(event.target.value);setLayerError('');}} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();chooseLayer();}}}/></label><button type="button" onClick={chooseLayer}>查看此层</button></div></div>
     {layerError&&<p className="layer-settings-error" role="alert">{layerError}</p>}
     {!!layerOptions.length&&<div className="layer-settings-layer-options" aria-label="当前有货或已配置层">{layerOptions.slice(0,30).map(number=><button key={number} type="button" aria-pressed={layer===number} onClick={()=>{setLayer(number);setLayerInput(String(number));setLayerError('');}}>第 {number} 层</button>)}{layerOptions.length>30&&<span>其余层请直接输入层号</span>}</div>}
     <div className="layer-settings-rule"><div><h4>{selectedLabel} · 第 {layer} 层</h4><div className="layer-settings-effective" aria-live="polite">{volumeInvalid?<span className="layer-settings-error">体积填写待核对</span>:preview&&<><strong>{preview.volumeM3} m³</strong><span>来源：{sourceNames[preview.volumeSource]??'待核对'}</span></>}</div></div><label className="layer-settings-volume"><span>本层 m³</span><input type="text" inputMode="decimal" aria-label="本层体积（m³）" aria-invalid={!!rule.volume.trim()&&decimal(rule.volume,1e6)===null} autoComplete="off" placeholder="沿用规则" value={rule.volume} onChange={event=>editRule(current=>({...current,volume:event.target.value}))}/></label></div>
     {!selectedOccupancy?<p className="layer-settings-muted">当前层无货，可预先设置体积；空层不计占层。</p>:<div className="layer-settings-occupants"><h4>当前客户 · 每客户独立计整层</h4>{customers.map((customer,index)=><div key={`${customer}:${index}`}><span>{customer||'未认领 · 待核对'}</span><strong>{volumeInvalid||!preview?'体积待核对':`${preview.volumeM3} m³`}</strong></div>)}{unknown&&<p className="layer-settings-pending">含未认领货物，费用归属待核对，请先认领客户。</p>}</div>}
    </section>
   </>}
  </fieldset>
  <footer className="layer-settings-footer"><div aria-live="polite">{error?<p className="layer-settings-error" role="alert">{error}</p>:saved?<p className="layer-settings-saved" role="status">设置已保存</p>:<p>留空恢复继承；混放客户各计一次整层体积。</p>}</div><div><button type="button" onClick={cancel} disabled={saving}>取消修改</button><button type="submit" disabled={saving||stale||!selected} className="layer-settings-save">{saving?'保存中…':'保存设置'}</button></div></footer>
 </form>;
}
