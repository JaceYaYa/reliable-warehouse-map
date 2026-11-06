import type {getDb} from '../db';
import {GoodsFlowError} from './goods-flow';
import {locationCodeKey} from './location-code';
import {resolveLocationAlias,type LocationAliases} from './location-aliases';
import {LAYER_PRICING_KEY,emptyLayerPricingConfig,parseLayerPricingConfig,resolveLayerVolume,type LayerPricingConfig} from './layer-storage';
import type {WarehouseZoneRecord} from './warehouse-layout';

export type LocationLayerVolume = {
  revision:number;
  defaults:Record<string,number>;
  locations:Record<string,{overrides:Record<string,number>;inherited:{base:number;exceptions:Record<string,number>}}>;
  preview:Record<string,{volumeM3:number;volumeSource:string}>;
};
export type LocationSettingRow = {key:string;value:string;updatedAt:string};
const canonical=(code:string,aliases:LocationAliases)=>locationCodeKey(resolveLocationAlias(code,aliases));

export function locationLayerConfig(raw?:string):LayerPricingConfig {
  try {return raw===undefined?emptyLayerPricingConfig():parseLayerPricingConfig(raw);}
  catch(error){throw new GoodsFlowError(error instanceof Error?error.message:'托层配置格式不正确',400);}
}

/** Only physical values leave this projection; client shares remain in the canonical config. */
export function locationLayerVolume(config:LayerPricingConfig,zones:readonly WarehouseZoneRecord[],aliases:LocationAliases):LocationLayerVolume {
  const defaults:Array<[string,number]>=[],preview:Array<[string,{volumeM3:number;volumeSource:string}]>=[];
  for(const code of zones.flatMap(zone=>zone.codes)){
    const key=canonical(code,aliases);
    // Shared resolver validates collapsed aliases and keeps individual layers above defaults.
    preview.push([code,resolveLayerVolume(config,code,1,zones,aliases)]);
    const explicit=Object.entries(config.locations).find(([name,rule])=>canonical(name,aliases)===key&&rule.defaultVolumeM3!==undefined)?.[1].defaultVolumeM3;
    if(explicit!==undefined)defaults.push([code,explicit]);
  }
  const locations:LocationLayerVolume['locations']={};
  for(const code of zones.flatMap(zone=>zone.codes)){
    const matches=Object.entries(config.locations).filter(([name])=>canonical(name,aliases)===canonical(code,aliases));
    const overrides:Record<string,number>={};
    for(const [,rule] of matches)for(const [layer,value] of Object.entries(rule.layers))if(value.volumeM3!==undefined)overrides[layer]=value.volumeM3;
    // Resolve only this location's inherited rule; never clone a whole warehouse per row.
    const inheritedConfig:LayerPricingConfig={schemaVersion:1,revision:config.revision,locations:Object.fromEntries(matches.map(([name,rule])=>[name,{...(rule.defaultVolumeM3===undefined?{}:{defaultVolumeM3:rule.defaultVolumeM3}),layers:{}}]))};
    const base=resolveLayerVolume(inheritedConfig,code,10000,zones,aliases).volumeM3,exceptions:Record<string,number>={};
    for(let layer=1;layer<=4;layer++){const value=resolveLayerVolume(inheritedConfig,code,layer,zones,aliases).volumeM3;if(value!==base)exceptions[layer]=value;}
    locations[code]={overrides,inherited:{base,exceptions}};
  }
  return {revision:config.revision,defaults:Object.fromEntries(defaults),preview:Object.fromEntries(preview),locations};
}

export function changeLocationLayerVolume(config:LayerPricingConfig,code:string,value:unknown,expectedRevision:unknown,aliases:LocationAliases):LayerPricingConfig {
  if(!Number.isSafeInteger(expectedRevision)||Number(expectedRevision)<0)throw new GoodsFlowError('托层配置版本须为大于或等于0的整数',400);
  if(value!==null&&(typeof value!=='number'||!Number.isFinite(value)||value<=0||value>1e6))throw new GoodsFlowError('每层默认体积须为大于0且不超过1000000的数字；清除时请传空值',400);
  if(expectedRevision!==config.revision)throw new GoodsFlowError('托层配置已有变化，请刷新后重新核对',409);
  const key=canonical(code,aliases),matches=Object.entries(config.locations).filter(([name])=>canonical(name,aliases)===key);
  const explicit=matches.filter(([,rule])=>rule.defaultVolumeM3!==undefined);
  const previous=explicit[0]?.[1].defaultVolumeM3;
  if(value===null?previous===undefined:previous===value)return config;
  if(config.revision>=Number.MAX_SAFE_INTEGER)throw new GoodsFlowError('配置版本已达上限，请联系管理员',400);
  const next=parseLayerPricingConfig(config);
  if(value===null){for(const [name] of explicit)delete next.locations[name].defaultVolumeM3;}
  else if(explicit.length){for(const [name] of explicit)next.locations[name].defaultVolumeM3=value as number;}
  else {
    const name=matches[0]?.[0]??code;
    if(!Object.hasOwn(next.locations,name))Object.defineProperty(next.locations,name,{value:{layers:{}},enumerable:true,configurable:true,writable:true});
    next.locations[name].defaultVolumeM3=value as number;
  }
  next.revision=config.revision+1;
  return parseLayerPricingConfig(next);
}

/** Apply physical overrides only; preserve shares and other settings, with one revision per save. */
export function changeLocationLayerVolumes(config:LayerPricingConfig,code:string,changes:unknown,expectedRevision:unknown,aliases:LocationAliases):LayerPricingConfig {
  if(!Array.isArray(changes)||!changes.length||changes.length>10000)throw new GoodsFlowError('请提交1至10000条单层体积设置',400);
  const seen=new Set<number>();
  for(const item of changes){
    if(!item||typeof item!=='object'||Array.isArray(item)||Object.keys(item).some(key=>!['layer','volumeM3'].includes(key))||!Number.isInteger(item.layer)||item.layer<1||item.layer>10000||seen.has(item.layer))throw new GoodsFlowError('层数须为1至10000的整数且不能重复',400);
    if(item.volumeM3!==null&&(typeof item.volumeM3!=='number'||!Number.isFinite(item.volumeM3)||item.volumeM3<=0||item.volumeM3>1e6))throw new GoodsFlowError('每层托盘立方米须为大于0且不超过1000000的数字',400);
    seen.add(item.layer);
  }
  if(!Number.isSafeInteger(expectedRevision)||Number(expectedRevision)<0)throw new GoodsFlowError('托层配置版本须为大于或等于0的整数',400);
  if(expectedRevision!==config.revision)throw new GoodsFlowError('托层配置已有变化，请刷新后重新核对',409);
  const next=parseLayerPricingConfig(config),matches=Object.keys(next.locations).filter(name=>canonical(name,aliases)===canonical(code,aliases));
  let changed=false;
  for(const {layer,volumeM3} of changes){
    const explicit=matches.filter(name=>next.locations[name].layers[layer]?.volumeM3!==undefined);
    if(volumeM3===null){for(const name of explicit){delete next.locations[name].layers[layer].volumeM3;changed=true;}}
    else if(explicit.length){for(const name of explicit)if(next.locations[name].layers[layer].volumeM3!==volumeM3){next.locations[name].layers[layer].volumeM3=volumeM3;changed=true;}}
    else{const name=matches[0]??code;if(!Object.hasOwn(next.locations,name)){Object.defineProperty(next.locations,name,{value:{layers:{}},enumerable:true,configurable:true,writable:true});matches.push(name);}next.locations[name].layers[layer]={...next.locations[name].layers[layer],volumeM3};changed=true;}
  }
  if(!changed)return config;
  if(config.revision>=Number.MAX_SAFE_INTEGER)throw new GoodsFlowError('配置版本已达上限，请联系管理员',400);
  next.revision=config.revision+1;return parseLayerPricingConfig(next);
}

/** Existing transaction CHECK guards abort the whole batch on any stale raw setting. */
export async function saveLocationCapacity(client:ReturnType<typeof getDb>['$client'],user:{id:number;displayName:string},input:{
  expected:Array<{key:string;row:LocationSettingRow|null}>;
  zoneValue:string;layerValue?:string;updatedAt:string;locationCode:string;summary:string;
  before:unknown;after:unknown;
}) {
  const id=crypto.randomUUID(),guardIds=input.expected.map((_,index)=>`${id}:${index}`);
  const guards=input.expected.map(({key,row},index)=>row
    ?client.prepare('INSERT INTO goods_transaction_guards(id,valid) VALUES (?,CASE WHEN EXISTS(SELECT 1 FROM settings WHERE key=? AND value=? AND updated_at=?) THEN 1 ELSE 0 END)').bind(guardIds[index],key,row.value,row.updatedAt)
    :client.prepare('INSERT INTO goods_transaction_guards(id,valid) VALUES (?,CASE WHEN NOT EXISTS(SELECT 1 FROM settings WHERE key=?) THEN 1 ELSE 0 END)').bind(guardIds[index],key));
  const layerWrite=input.layerValue===undefined?[]:[client.prepare('INSERT INTO settings(key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').bind(LAYER_PRICING_KEY,input.layerValue,input.updatedAt)];
  await client.batch([
    ...guards,
    client.prepare('UPDATE settings SET value=?,updated_at=? WHERE key=?').bind(input.zoneValue,input.updatedAt,'warehouse_zones'),
    ...layerWrite,
    client.prepare('INSERT INTO audit_logs(user_id,user_name,action,entity_type,entity_id,operation_id,summary,before_snapshot,after_snapshot,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').bind(user.id,user.displayName,'修改库位容量','库位',input.locationCode,`capacity-change:${id}`,input.summary,JSON.stringify(input.before),JSON.stringify(input.after),input.updatedAt),
    ...guardIds.map(guardId=>client.prepare('DELETE FROM goods_transaction_guards WHERE id=?').bind(guardId)),
  ]);
}
