import {projectCartonRows} from './carton-pallets';
import {env} from 'cloudflare:workers';
import {loadStockPalletMetadata} from './stock-pallets';
import {automaticPalletRows} from './automatic-pallets';
import {inArray} from 'drizzle-orm';
import {getDb} from '../db';
import {settings,stocks,cartonReceipts,cartonOperations} from '../db/schema';
import {saveAuditedPricingSetting} from './admin-setting-undo';
import {cartonView} from './carton-store';
import {cartonPlacementDetails} from './box-stock-details';
import {GoodsFlowError} from './goods-flow';
import {locationCodeKey} from './location-code';
import {LOCATION_ALIASES_KEY,parseLocationAliases,resolveLocationAlias,type LocationAliases} from './location-aliases';
import {DEFAULT_WAREHOUSE_CANVAS_SIZE,mergeRequiredWarehouseZonesForCanvas,normalizeWarehouseCanvasSize,WAREHOUSE_CANVAS_SETTINGS_KEY} from './warehouse-canvas';
import type {WarehouseZoneRecord} from './warehouse-layout';
import {LAYER_PRICING_KEY,emptyLayerPricingConfig,parseLayerPricingConfig,groupLayerOccupancy,resolveLayerVolume,type LayerPricingConfig,type LayerOccupant} from './layer-storage';

const zoneKey='warehouse_zones';
const settingKeys=[LAYER_PRICING_KEY,zoneKey,LOCATION_ALIASES_KEY,WAREHOUSE_CANVAS_SETTINGS_KEY];
const forbidden=(key:string)=>['__proto__','prototype','constructor'].includes(key);
function checkedAliases(raw?:string):LocationAliases{
 const aliases=parseLocationAliases(raw),seen=new Set<string>();
 for(const [from,to] of Object.entries(aliases)){
  const key=locationCodeKey(from);
  if(forbidden(from)||forbidden(to)||seen.has(key))throw new Error('库位更名记录有重复或无效名称，请先核对');
  seen.add(key);
 }
 return aliases;
}
function checkedZones(raw:string|undefined,canvasRaw:string|undefined):WarehouseZoneRecord[]{
 if(raw===undefined)return [];
 const value=JSON.parse(raw);
 if(!Array.isArray(value)||value.some(zone=>!zone||typeof zone.id!=='string'||typeof zone.title!=='string'||!Array.isArray(zone.codes)||zone.codes.some((code:unknown)=>typeof code!=='string'||!code.trim()||forbidden(code))))throw new Error('仓库区域资料格式不正确');
 const canvas=canvasRaw===undefined?DEFAULT_WAREHOUSE_CANVAS_SIZE:normalizeWarehouseCanvasSize(JSON.parse(canvasRaw));
 return mergeRequiredWarehouseZonesForCanvas(value,canvas);
}
export type LayerPricingSettingsRows={cartonPalletOperations?:readonly {kind:string;beforeSnapshot:string|null;afterSnapshot:string|null}[];palletAudits?:readonly Record<string,unknown>[];settings:readonly (typeof settings.$inferSelect)[];stocks:readonly (typeof stocks.$inferSelect)[];cartons:readonly (typeof cartonReceipts.$inferSelect)[]};
function contextFromRows(input:LayerPricingSettingsRows){
 const {settings:rows,stocks:stockRows,cartons:cartonRows}=input;
 const row=(key:string)=>rows.find(value=>value.key===key)??null;
 const aliases=checkedAliases(row(LOCATION_ALIASES_KEY)?.value),zones=checkedZones(row(zoneKey)?.value,row(WAREHOUSE_CANVAS_SETTINGS_KEY)?.value);
 const configRow=row(LAYER_PRICING_KEY),config=configRow?parseLayerPricingConfig(configRow.value):emptyLayerPricingConfig();
 const occupants:LayerOccupant[]=automaticPalletRows(stockRows,rows,input.palletAudits).filter(stock=>stock.totalQuantity>0||stock.totalBoxes>0).map(stock=>({id:`stock:${stock.id}`,kind:'stock',locationCode:stock.locationCode,layer:stock.layerCount,customerName:stock.customerName,inboundDate:stock.inboundDate,productName:stock.product,sku:stock.sku,palletCount:stock.palletCount,physicalQuantity:stock.totalQuantity,physicalBoxes:stock.totalBoxes}));
 for(const receiptRow of projectCartonRows(cartonRows,input.cartonPalletOperations)){
  const receipt=cartonView(receiptRow);
  for(const placement of receipt.placements){
   if(placement.boxes<=0)continue;
   const details=cartonPlacementDetails(receipt,placement);
   occupants.push({id:`carton:${receipt.id}:${placement.key}`,kind:'carton',locationCode:placement.locationCode,layer:details.layerCount,customerName:details.customerName,inboundDate:details.inboundDate,productName:details.product,sku:details.sku,palletCount:placement.palletCount,physicalQuantity:0,physicalBoxes:placement.boxes});
  }
 }
 const locationNames=new Map<string,string>();
 for(const code of [...zones.flatMap(zone=>zone.codes),...occupants.map(row=>row.locationCode)]){
  const canonical=resolveLocationAlias(code,aliases),key=locationCodeKey(canonical);
  if(!key||forbidden(canonical))throw new Error('当前库存有无效库位名称，请先核对');
  locationNames.set(key,locationNames.get(key)??canonical);
 }
 const locations=[...locationNames.values()].sort((a,b)=>a.localeCompare(b,'zh-CN',{numeric:true}));
 return {row,configRow,config,aliases,zones,occupants,locations,locationNames};
}
async function context(){
 const db=getDb();
 const [settingRows,stockRows,cartonRows,metadata,cartonPalletOperations]=await Promise.all([db.select().from(settings),db.select().from(stocks),db.select().from(cartonReceipts),loadStockPalletMetadata(env.DB),db.select().from(cartonOperations)]);
 return contextFromRows({settings:settingRows,stocks:stockRows,cartons:cartonRows,palletAudits:metadata.audits,cartonPalletOperations});
}
type Context=ReturnType<typeof contextFromRows>;
function validateLocations(config:LayerPricingConfig,state:Context){
 for(const [code,rule] of Object.entries(config.locations)){
  if(!state.locationNames.has(locationCodeKey(resolveLocationAlias(code,state.aliases))))throw new Error(`库位不存在：${code}，请刷新后核对`);
  for(const layer of new Set([1,...Object.keys(rule.layers).map(Number)]))resolveLayerVolume(config,code,layer,state.zones,state.aliases);
 }
}
function dto(state:Context,config=state.config){
 return {ok:true as const,config,locations:state.locations,zones:state.zones,aliases:state.aliases,occupied:groupLayerOccupancy(state.occupants,config,state.zones,state.aliases)};
}
/** Project one supplied database snapshot; performs no database reads or writes. */
export function layerPricingSettingsFromRows(input:LayerPricingSettingsRows){return dto(contextFromRows(input));}
export async function readLayerPricingSettings(){const state=await context();return dto(state);}
export async function saveLayerPricingSettings(user:{id:number;displayName:string},raw:unknown){
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new GoodsFlowError('提交格式不正确',400);
 const body=raw as Record<string,unknown>;
 if(Object.keys(body).some(key=>!['expectedRevision','config'].includes(key))||!Number.isSafeInteger(body.expectedRevision)||Number(body.expectedRevision)<0)throw new GoodsFlowError('配置版本格式不正确',400);
 const config=parseLayerPricingConfig(body.config),state=await context();
 if(body.expectedRevision!==state.config.revision)throw new GoodsFlowError('托层配置已有变化，请刷新后重新核对',409);
 validateLocations(config,state);
 if(state.config.revision>=Number.MAX_SAFE_INTEGER)throw new GoodsFlowError('配置版本已达上限，请联系管理员',400);
 const next={...config,revision:state.config.revision+1};
 // Compute before saving so all configured aliases and occupied rules must be valid.
 dto(state,next);
 await saveAuditedPricingSetting(user,{key:LAYER_PRICING_KEY,value:JSON.stringify(next),action:'修改托层仓储计价',entityType:'托层计价设置',entityId:LAYER_PRICING_KEY,summary:`托层配置版本 ${state.config.revision} → ${next.revision}`,stamp:new Date().toISOString(),expectedRow:state.configRow,expectedSettings:[zoneKey,LOCATION_ALIASES_KEY,WAREHOUSE_CANVAS_SETTINGS_KEY].map(key=>({key,row:state.row(key)}))});
 return dto(await context());
}
