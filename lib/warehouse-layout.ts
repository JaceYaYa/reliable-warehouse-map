export type LayoutBox={x:number;y:number;w:number;h:number;capacityLayers?:number;capacityPallets?:number;capacityBoxes?:number;groupId?:string;groupLocked?:boolean};
export type LayoutFeature=LayoutBox&{id:string;type:"aisle"|"area"|"label"|"box"|"line";label:string;color?:string};
export type WarehouseZoneRecord={id:string;title:string;codes:string[];layout?:Record<string,LayoutBox>;features?:LayoutFeature[];mapBox?:LayoutBox;unified?:boolean;layoutVersion?:number;locationCodesVersion?:number;newPalletCapacityVersion?:number};

export const LEGACY_WAREHOUSE_MAP_WIDTH=3400;
export const LEGACY_WAREHOUSE_MAP_HEIGHT=2100;
export const V5_WAREHOUSE_MAP_WIDTH=3400;
export const V5_WAREHOUSE_MAP_HEIGHT=2700;
export const V6_WAREHOUSE_MAP_WIDTH=4000;
export const V6_WAREHOUSE_MAP_HEIGHT=2700;
export const V7_WAREHOUSE_MAP_WIDTH=4800;
export const V7_WAREHOUSE_MAP_HEIGHT=2700;
export const WAREHOUSE_MAP_WIDTH=6000;
export const WAREHOUSE_MAP_HEIGHT=3600;
export const WAREHOUSE_TOP_EXTENSION=V5_WAREHOUSE_MAP_HEIGHT-LEGACY_WAREHOUSE_MAP_HEIGHT;
export const WAREHOUSE_LAYOUT_VERSION=8;
export const NEW_PALLET_CAPACITY=2;
export const NEW_PALLET_CAPACITY_VERSION=1;

const newZoneDefinitions=[
 {id:"NEW_A",title:"新A区 · 新库位",prefix:"新A",count:38,rowY:48,color:"#c85f52"},
 {id:"NEW_B",title:"新B区 · 新库位",prefix:"新B",count:34,rowY:168,color:"#4d7fb8"},
 {id:"NEW_C",title:"新C区 · 新库位",prefix:"新C",count:34,rowY:288,color:"#3b9f91"},
 {id:"NEW_D",title:"新D区 · 新库位",prefix:"新D",count:30,rowY:408,color:"#8a69ad"},
] as const;

const previousNewZoneRowY:Record<string,number>={NEW_A:48,NEW_B:188,NEW_C:328,NEW_D:468};

export const newWarehouseZoneSpecs=newZoneDefinitions.map(zone=>({
 id:zone.id,
 title:zone.title,
 codes:Array.from({length:zone.count},(_,i)=>`${zone.prefix}${i+1}`),
}));

const newAisleDefinitions=[
 {id:"AISLE_A",zoneId:"NEW_A",title:"A通道",legacyTitles:["新A通道"],codePrefix:"A",targetPrefix:"新A",count:38,rowOffsetPx:102},
 {id:"AISLE_D",zoneId:"NEW_D",title:"D通道",legacyTitles:["新D通道"],codePrefix:"D",targetPrefix:"新D",count:32,rowOffsetPx:-100},
] as const;

export const newWarehouseAisleSpecs=newAisleDefinitions.map(aisle=>({
 id:aisle.id,
 zoneId:aisle.zoneId,
 title:aisle.title,
 targetPrefix:aisle.targetPrefix,
 rowOffsetPx:aisle.rowOffsetPx,
 codes:Array.from({length:aisle.count},(_,i)=>`${aisle.codePrefix}${i+1}通道`),
}));

export const requiredZoneSpecs=[
 ...newWarehouseZoneSpecs,
 {id:"A",title:"A区 · 主库位",codes:Array.from({length:44},(_,i)=>`A${i+1}`)},
 {id:"B",title:"B区 · 主库位",codes:Array.from({length:27},(_,i)=>`B${i+1}`)},
 {id:"C",title:"C区 · 侧墙区",codes:Array.from({length:5},(_,i)=>`C${i+1}`)},
 {id:"L",title:"L区 · 货架区",codes:Array.from({length:10},(_,i)=>`L${i+1}`)},
 {id:"O",title:"办公室区",codes:Array.from({length:13},(_,i)=>`办公室${i+1}`)},
 {id:"T",title:"T区",codes:Array.from({length:18},(_,i)=>`T${i+1}`)},
 {id:"S",title:"二仓区",codes:Array.from({length:8},(_,i)=>`二仓${i+1}`)},
 {id:"Y",title:"一件代发室",codes:Array.from({length:8},(_,i)=>`Y-${i+1}`)},
 {id:"R",title:"库房操作室",codes:["库房操作室1","库房操作室2"]},
];

const positions:Record<string,[number,number]>={};
const row=(codes:string[],col:number,r:number)=>codes.forEach((code,i)=>positions[code]=[col+i,r]);
const column=(codes:string[],col:number,r:number)=>codes.forEach((code,i)=>positions[code]=[col,r+i]);
row(Array.from({length:9},(_,i)=>`T${i+1}`),1,1);row(Array.from({length:9},(_,i)=>`T${18-i}`),1,3);
row(Array.from({length:28},(_,i)=>`A${28-i}`),11,1);positions.A29=[14,21];
row(["C5","C4","C3","C2","C1"],11,3);row(Array.from({length:19},(_,i)=>`B${19-i}`),16,3);column(Array.from({length:7},(_,i)=>`B${27-i}`),35,4);positions.B20=[35,11];
column(Array.from({length:8},(_,i)=>`二仓${i+1}`),8,11);
row(["L5","L4","L3","L2","L1"],15,13);row(["L10","L9","L8","L7","L6"],15,14);
positions["Y-5"]=[21,13];positions["Y-4"]=[21,14];positions["Y-3"]=[21,15];positions["Y-2"]=[21,16];positions["Y-1"]=[21,17];positions["Y-6"]=[22,15];positions["Y-7"]=[22,16];positions["Y-8"]=[22,17];
row(["办公室1","办公室2","办公室3","办公室4"],24,11);column(["办公室5","办公室6","办公室7","办公室8","办公室9","办公室10"],27,12);positions["办公室11"]=[24,15];positions["办公室12"]=[24,16];positions["办公室13"]=[23,17];
positions["库房操作室2"]=[17,19];positions["库房操作室1"]=[20,19];positions.A38=[27,19];positions.A39=[27,20];row(["A37","A36","A35","A34","A33","A32","A31","A30","A44","A43","A42","A41","A40"],15,21);
for(let i=1;i<=13;i++)positions[`办${i}`]=positions[`办公室${i}`];

const legacyGridBox=(col:number,r:number):LayoutBox=>({x:1.1+col*2.48,y:1.2+r*4.38,w:2.28,h:3.55});
const percentX=(pixels:number)=>pixels/WAREHOUSE_MAP_WIDTH*100;
const percentY=(pixels:number)=>pixels/WAREHOUSE_MAP_HEIGHT*100;
const percentXForWidth=(pixels:number,width:number)=>pixels/width*100;
const percentYForHeight=(pixels:number,height:number)=>pixels/height*100;

const migrateLayoutBox=<T extends LayoutBox>(box:T,sourceWidth:number,sourceHeight:number,topOffset=0):T=>({
 ...box,
 x:percentX(box.x/100*sourceWidth),
 y:percentY(topOffset+box.y/100*sourceHeight),
 w:percentX(box.w/100*sourceWidth),
 h:percentY(box.h/100*sourceHeight),
});

export function migrateLegacyLayoutBox<T extends LayoutBox>(box:T):T{
 return migrateLayoutBox(box,LEGACY_WAREHOUSE_MAP_WIDTH,LEGACY_WAREHOUSE_MAP_HEIGHT,WAREHOUSE_TOP_EXTENSION);
}

export function migrateV5LayoutBox<T extends LayoutBox>(box:T):T{
 return migrateLayoutBox(box,V5_WAREHOUSE_MAP_WIDTH,V5_WAREHOUSE_MAP_HEIGHT);
}

export function migrateV6LayoutBox<T extends LayoutBox>(box:T):T{
 return migrateLayoutBox(box,V6_WAREHOUSE_MAP_WIDTH,V6_WAREHOUSE_MAP_HEIGHT);
}

export function migrateV7LayoutBox<T extends LayoutBox>(box:T):T{
 return migrateLayoutBox(box,V7_WAREHOUSE_MAP_WIDTH,V7_WAREHOUSE_MAP_HEIGHT);
}

const newSlotWidthPx=legacyGridBox(0,0).w/100*LEGACY_WAREHOUSE_MAP_WIDTH;
const newSlotHeightPx=legacyGridBox(0,0).h/100*LEGACY_WAREHOUSE_MAP_HEIGHT;
const newRowMarginPx=48;
const compactNewRowLeftPx=120,compactNewRowRightEdgePx=3600;
type NewRowGeometry={rightX:number;stepPx:number};
const fullWidthNewRowGeometry=(width:number):NewRowGeometry=>{
 const rightX=width-newRowMarginPx-newSlotWidthPx;
 return{rightX,stepPx:(rightX-newRowMarginPx)/(38-1)};
};
const compactNewRowGeometry:NewRowGeometry={rightX:compactNewRowRightEdgePx-newSlotWidthPx,stepPx:(compactNewRowRightEdgePx-newSlotWidthPx-compactNewRowLeftPx)/(38-1)};

function newWarehouseBoxForZoneNumber(zoneId:string,number:number,maxNumber:number,width:number,height:number,rowYByZone:Record<string,number>,geometry:NewRowGeometry):LayoutBox|null{
 const zone=newZoneDefinitions.find(candidate=>candidate.id===zoneId);
 if(!zone||!Number.isInteger(number)||number<1||number>maxNumber)return null;
 return{x:percentXForWidth(geometry.rightX-(number-1)*geometry.stepPx,width),y:percentYForHeight(rowYByZone[zone.id],height),w:percentXForWidth(newSlotWidthPx,width),h:percentYForHeight(newSlotHeightPx,height)};
}

function newWarehouseBoxForGeometry(code:string,width:number,height:number,rowYByZone:Record<string,number>,geometry:NewRowGeometry):LayoutBox|null{
 const zone=newZoneDefinitions.find(candidate=>code.startsWith(candidate.prefix));
 if(!zone)return null;
 const number=Number(code.slice(zone.prefix.length));
 return newWarehouseBoxForZoneNumber(zone.id,number,zone.count,width,height,rowYByZone,geometry);
}

const currentNewZoneRowY=Object.fromEntries(newZoneDefinitions.map(zone=>[zone.id,zone.rowY]));
const currentAisleRowY:Record<string,number>={NEW_A:150,NEW_D:308};
const newWarehouseBox=(code:string)=>{
 const box=newWarehouseBoxForGeometry(code,WAREHOUSE_MAP_WIDTH,WAREHOUSE_MAP_HEIGHT,currentNewZoneRowY,compactNewRowGeometry);
 return box?{...box,capacityPallets:NEW_PALLET_CAPACITY}:null;
};

function parseRequiredAisleCode(code:string){
 for(const aisle of newAisleDefinitions){
  const suffix="通道";
  if(!code.startsWith(aisle.codePrefix)||!code.endsWith(suffix))continue;
  const number=Number(code.slice(aisle.codePrefix.length,-suffix.length));
  if(Number.isInteger(number)&&number>=1&&number<=aisle.count)return{aisle,number,targetCode:`${aisle.targetPrefix}${number}`};
 }
 return null;
}

function newWarehouseAisleBox(code:string):LayoutBox|null{
 const parsed=parseRequiredAisleCode(code);
 if(!parsed)return null;
 const base=newWarehouseBoxForZoneNumber(parsed.aisle.zoneId,parsed.number,parsed.aisle.count,WAREHOUSE_MAP_WIDTH,WAREHOUSE_MAP_HEIGHT,currentNewZoneRowY,compactNewRowGeometry);
 return base?{...base,y:percentYForHeight(currentAisleRowY[parsed.aisle.zoneId],WAREHOUSE_MAP_HEIGHT)}:null;
}

function requiredWarehouseFeaturesForGeometry(zoneId:string,width:number,height:number,rowYByZone:Record<string,number>,geometry:NewRowGeometry):LayoutFeature[]{
 const zone=newZoneDefinitions.find(candidate=>candidate.id===zoneId);
 if(!zone)return[];
 const rowY=rowYByZone[zone.id],top=rowY-36,lastX=geometry.rightX-(zone.count-1)*geometry.stepPx,padding=24,left=Math.max(0,lastX-padding),right=Math.min(width,geometry.rightX+newSlotWidthPx+padding);
 return[
  {id:`required-${zone.id}-box`,type:"box",label:"",color:zone.color,x:percentXForWidth(left,width),y:percentYForHeight(top,height),w:percentXForWidth(right-left,width),h:percentYForHeight(112,height)},
  {id:`required-${zone.id}-label`,type:"label",label:`${zone.prefix}区`,color:zone.color,x:percentXForWidth(left+8,width),y:percentYForHeight(top+8,height),w:percentXForWidth(100,width),h:percentYForHeight(27,height)},
 ];
}

const v5NewWarehouseBox=(code:string):LayoutBox|null=>{
 const zone=newZoneDefinitions.find(candidate=>code.startsWith(candidate.prefix));
 if(!zone)return null;
 const number=Number(code.slice(zone.prefix.length));
 if(!Number.isInteger(number)||number<1||number>zone.count)return null;
 const legacy=legacyGridBox(38-number,0);
 return{x:legacy.x,y:percentYForHeight(previousNewZoneRowY[zone.id],V5_WAREHOUSE_MAP_HEIGHT),w:legacy.w,h:percentYForHeight(newSlotHeightPx,V5_WAREHOUSE_MAP_HEIGHT)};
};

const v5RequiredWarehouseFeatures=(zoneId:string):LayoutFeature[]=>{
 const zone=newZoneDefinitions.find(candidate=>candidate.id===zoneId);
 if(!zone)return[];
 const rowY=previousNewZoneRowY[zone.id],top=rowY-36;
 return[
  {id:`required-${zone.id}-box`,type:"box",label:"",color:zone.color,x:.55,y:percentYForHeight(top,V5_WAREHOUSE_MAP_HEIGHT),w:96.9,h:percentYForHeight(112,V5_WAREHOUSE_MAP_HEIGHT)},
  {id:`required-${zone.id}-label`,type:"label",label:`${zone.prefix}区`,color:zone.color,x:.72,y:percentYForHeight(top+8,V5_WAREHOUSE_MAP_HEIGHT),w:2.9,h:percentYForHeight(27,V5_WAREHOUSE_MAP_HEIGHT)},
 ];
};

const sourceNewWarehouseBox=(code:string,layoutVersion:number|undefined):LayoutBox|null=>layoutVersion===5?v5NewWarehouseBox(code):layoutVersion===6?newWarehouseBoxForGeometry(code,V6_WAREHOUSE_MAP_WIDTH,V6_WAREHOUSE_MAP_HEIGHT,previousNewZoneRowY,fullWidthNewRowGeometry(V6_WAREHOUSE_MAP_WIDTH)):layoutVersion===7?newWarehouseBoxForGeometry(code,V7_WAREHOUSE_MAP_WIDTH,V7_WAREHOUSE_MAP_HEIGHT,previousNewZoneRowY,fullWidthNewRowGeometry(V7_WAREHOUSE_MAP_WIDTH)):null;
const sourceRequiredWarehouseFeatures=(zoneId:string,layoutVersion:number|undefined):LayoutFeature[]=>layoutVersion===5?v5RequiredWarehouseFeatures(zoneId):layoutVersion===6?requiredWarehouseFeaturesForGeometry(zoneId,V6_WAREHOUSE_MAP_WIDTH,V6_WAREHOUSE_MAP_HEIGHT,previousNewZoneRowY,fullWidthNewRowGeometry(V6_WAREHOUSE_MAP_WIDTH)):layoutVersion===7?requiredWarehouseFeaturesForGeometry(zoneId,V7_WAREHOUSE_MAP_WIDTH,V7_WAREHOUSE_MAP_HEIGHT,previousNewZoneRowY,fullWidthNewRowGeometry(V7_WAREHOUSE_MAP_WIDTH)):[];

export const requiredWarehouseFeatures=(zoneId:string)=>requiredWarehouseFeaturesForGeometry(zoneId,WAREHOUSE_MAP_WIDTH,WAREHOUSE_MAP_HEIGHT,currentNewZoneRowY,compactNewRowGeometry);

export function actualWarehouseLayout(codes:string[]){
 return Object.fromEntries(codes.map((code,i)=>{
  const newBox=newWarehouseBox(code);
  if(newBox)return[code,newBox];
  const aisleBox=newWarehouseAisleBox(code);
  if(aisleBox)return[code,aisleBox];
  const p=positions[code]||[i%36,18+Math.floor(i/36)],box=migrateLegacyLayoutBox(legacyGridBox(p[0],p[1])),n=Number((code.match(/\d+/)||[0])[0]);
  if(code.startsWith("A")&&n>=1&&n<=28)box.capacityPallets=6;
  if(code.startsWith("A")&&n>=30&&n<=44)box.capacityPallets=4;
  if(code.startsWith("B")&&n>=1&&n<=19)box.capacityPallets=4;
  if(code.startsWith("B")&&n>=20&&n<=27)box.capacityPallets=3;
  return[code,box];
 }));
}

function palletCapacityBaseBox(code:string,layoutVersion:number|undefined):LayoutBox|null{
 if(layoutVersion===5||layoutVersion===6||layoutVersion===7)return sourceNewWarehouseBox(code,layoutVersion);
 return newWarehouseBox(code);
}

function applyNewPalletCapacityUpgrade(zone:WarehouseZoneRecord):WarehouseZoneRecord{
 const spec=newWarehouseZoneSpecs.find(candidate=>candidate.id===zone.id);
 if(!spec||zone.locationCodesVersion)return zone;
 const savedVersion=Number(zone.newPalletCapacityVersion)||0,initialize=savedVersion<NEW_PALLET_CAPACITY_VERSION,layout={...(zone.layout||{})};
 for(const code of spec.codes){
  const saved=layout[code],base=saved||palletCapacityBaseBox(code,zone.layoutVersion);
  if(!base)continue;
  layout[code]={...base,...(saved||{}),capacityPallets:initialize?NEW_PALLET_CAPACITY:saved?.capacityPallets??NEW_PALLET_CAPACITY};
 }
 return{...zone,layout,newPalletCapacityVersion:initialize?NEW_PALLET_CAPACITY_VERSION:savedVersion};
}

function newZoneRecord(spec:(typeof newWarehouseZoneSpecs)[number]):WarehouseZoneRecord{
 return{
  ...spec,
  layout:actualWarehouseLayout(spec.codes),
  features:requiredWarehouseFeatures(spec.id),
  unified:true,
  layoutVersion:WAREHOUSE_LAYOUT_VERSION,
  newPalletCapacityVersion:NEW_PALLET_CAPACITY_VERSION,
 };
}

const normalizedZoneTitle=(value:string|undefined)=>String(value||"").normalize("NFKC").replace(/\s+/g,"");

function aisleZoneMatchScore(zone:WarehouseZoneRecord,aisle:(typeof newAisleDefinitions)[number]){
 const title=normalizedZoneTitle(zone.title);
 const savedCodeCount=zone.codes.filter(code=>parseRequiredAisleCode(code)?.aisle.id===aisle.id).length;
 const identityScore=zone.id===aisle.id?4:title===normalizedZoneTitle(aisle.title)?3:aisle.legacyTitles.some(candidate=>title===normalizedZoneTitle(candidate))?2:0;
 return savedCodeCount*10+identityScore;
}

function aisleTargetFallbackBox(aisle:(typeof newAisleDefinitions)[number],number:number,layoutVersion:number|undefined):LayoutBox|null{
 if(layoutVersion===5){
  const legacy=legacyGridBox(38-number,0);
  return{x:legacy.x,y:percentYForHeight(previousNewZoneRowY[aisle.zoneId],V5_WAREHOUSE_MAP_HEIGHT),w:legacy.w,h:percentYForHeight(newSlotHeightPx,V5_WAREHOUSE_MAP_HEIGHT)};
 }
 if(layoutVersion===6)return newWarehouseBoxForZoneNumber(aisle.zoneId,number,aisle.count,V6_WAREHOUSE_MAP_WIDTH,V6_WAREHOUSE_MAP_HEIGHT,previousNewZoneRowY,fullWidthNewRowGeometry(V6_WAREHOUSE_MAP_WIDTH));
 if(layoutVersion===7)return newWarehouseBoxForZoneNumber(aisle.zoneId,number,aisle.count,V7_WAREHOUSE_MAP_WIDTH,V7_WAREHOUSE_MAP_HEIGHT,previousNewZoneRowY,fullWidthNewRowGeometry(V7_WAREHOUSE_MAP_WIDTH));
 return newWarehouseBoxForZoneNumber(aisle.zoneId,number,aisle.count,WAREHOUSE_MAP_WIDTH,WAREHOUSE_MAP_HEIGHT,currentNewZoneRowY,compactNewRowGeometry);
}

const layoutHeightForVersion=(layoutVersion:number|undefined)=>layoutVersion===5?V5_WAREHOUSE_MAP_HEIGHT:layoutVersion===6?V6_WAREHOUSE_MAP_HEIGHT:layoutVersion===7?V7_WAREHOUSE_MAP_HEIGHT:WAREHOUSE_MAP_HEIGHT;

function completeAisleZone(zone:WarehouseZoneRecord,aisle:(typeof newAisleDefinitions)[number],targetZone:WarehouseZoneRecord,fallbackTemplate?:LayoutBox):WarehouseZoneRecord{
 const spec=newWarehouseAisleSpecs.find(candidate=>candidate.id===aisle.id)!;
 const required=new Set(spec.codes),codes=[...spec.codes,...zone.codes.filter(code=>!required.has(code))],layout={...(zone.layout||{})},targetVersion=zone.layoutVersion??targetZone.layoutVersion??WAREHOUSE_LAYOUT_VERSION,rowHeight=layoutHeightForVersion(targetVersion);
 const ownTemplate=spec.codes.map(code=>layout[code]).find(Boolean),shapeTemplate=ownTemplate||fallbackTemplate;
 for(const [index,code] of spec.codes.entries()){
  if(layout[code])continue;
  const number=index+1,targetCode=`${aisle.targetPrefix}${number}`,target=targetZone.layout?.[targetCode]||aisleTargetFallbackBox(aisle,number,targetVersion),fallback=newWarehouseAisleBox(code);
  if(!target&&!fallback)continue;
  const base=target||fallback!;
  layout[code]={x:base.x,y:ownTemplate?.y??base.y+aisle.rowOffsetPx/rowHeight*100,w:shapeTemplate?.w??base.w,h:shapeTemplate?.h??base.h,...(shapeTemplate?.capacityPallets===undefined?{}:{capacityPallets:shapeTemplate.capacityPallets}),...(shapeTemplate?.capacityBoxes===undefined?{}:{capacityBoxes:shapeTemplate.capacityBoxes})};
 }
 return{...zone,title:aisle.title,codes,layout:Object.fromEntries(Object.entries(layout).filter(([code])=>codes.includes(code))),unified:true,layoutVersion:targetVersion};
}

export function mergeRequiredWarehouseZones(input:WarehouseZoneRecord[]):WarehouseZoneRecord[]{
 const zones=Array.isArray(input)?input.map(zone=>({...zone,codes:Array.isArray(zone.codes)?[...zone.codes]:[]})):[];
 if(zones.some(zone=>zone.locationCodesVersion))return zones.map(zone=>({...zone,layout:zone.layout?Object.fromEntries(Object.entries(zone.layout).filter(([code])=>zone.codes.includes(code))):zone.layout}));
 const newIds=new Set<string>(newWarehouseZoneSpecs.map(zone=>zone.id));
 const aisleMigrationEnabled=zones.some(zone=>newAisleDefinitions.some(aisle=>aisleZoneMatchScore(zone,aisle)>0));
 const requiredNewCodes=new Set(newWarehouseZoneSpecs.flatMap(zone=>zone.codes));
 const requiredAisleCodes=new Set(aisleMigrationEnabled?newWarehouseAisleSpecs.flatMap(aisle=>aisle.codes):[]);
 const allRequiredCodes=new Set([...requiredNewCodes,...requiredAisleCodes]);
 const inheritedCapacity=new Map<string,Pick<LayoutBox,"capacityPallets"|"capacityBoxes">>();
 const inheritedAisleLayout=new Map<string,LayoutBox>();
 for(const zone of zones)for(const code of zone.codes){
  const box=zone.layout?.[code];
  if(requiredNewCodes.has(code)&&box&&!inheritedCapacity.has(code))inheritedCapacity.set(code,{capacityPallets:box.capacityPallets,capacityBoxes:box.capacityBoxes});
  if(requiredAisleCodes.has(code)&&box&&!inheritedAisleLayout.has(code))inheritedAisleLayout.set(code,{...box});
 }
 const aisleZoneIndexes=new Map<string,number>();
 if(aisleMigrationEnabled)for(const aisle of newAisleDefinitions){
  let bestIndex=-1,bestScore=0;
  zones.forEach((zone,index)=>{const score=newIds.has(zone.id)?0:aisleZoneMatchScore(zone,aisle);if(score>bestScore){bestIndex=index;bestScore=score;}});
  if(bestIndex>=0)aisleZoneIndexes.set(aisle.id,bestIndex);
 }
 const claimedAisleIndexes=new Set(aisleZoneIndexes.values());
 const otherZones=zones.filter((zone,index)=>!newIds.has(zone.id)&&!claimedAisleIndexes.has(index)).map(zone=>({
  ...zone,
  codes:zone.codes.filter(code=>!allRequiredCodes.has(code)),
  layout:zone.layout?Object.fromEntries(Object.entries(zone.layout).filter(([code])=>!allRequiredCodes.has(code))):zone.layout,
 }));
 const aisleExtras=new Map<string,string[]>();
 for(const aisle of newAisleDefinitions){
  const index=aisleZoneIndexes.get(aisle.id),current=index===undefined?undefined:zones[index];
  aisleExtras.set(aisle.id,(current?.codes||[]).filter(code=>!allRequiredCodes.has(code)));
 }
 const claimedExtraCodes=new Set([...otherZones.flatMap(zone=>zone.codes),...aisleExtras.values()].flat());
 const mergedNewZones=newWarehouseZoneSpecs.map(spec=>{
  const current=zones.find(zone=>zone.id===spec.id);
  const extraCodes=(current?.codes||[]).filter(code=>!allRequiredCodes.has(code)&&!claimedExtraCodes.has(code));
  extraCodes.forEach(code=>claimedExtraCodes.add(code));
  const codes=[...spec.codes,...new Set(extraCodes)];
  if(!current){
   const created=newZoneRecord({...spec,codes});
   for(const code of spec.codes){
    const capacity=inheritedCapacity.get(code);
    if(capacity&&created.layout?.[code])created.layout[code]={...created.layout[code],...capacity,capacityPallets:NEW_PALLET_CAPACITY};
   }
   return created;
  }
  return applyNewPalletCapacityUpgrade({
   ...current,
   codes,
   layout:current.layout?Object.fromEntries(Object.entries(current.layout).filter(([code])=>codes.includes(code))):current.layout,
   features:current.features,
   unified:true,
   layoutVersion:current.layoutVersion,
  });
 });
 const mergedAisleZones:WarehouseZoneRecord[]=[];
 if(aisleMigrationEnabled)for(const aisle of newAisleDefinitions){
  const index=aisleZoneIndexes.get(aisle.id),current=index===undefined?undefined:zones[index],spec=newWarehouseAisleSpecs.find(candidate=>candidate.id===aisle.id)!,extraCodes=aisleExtras.get(aisle.id)||[],codes=[...spec.codes,...extraCodes];
  const targetZone=mergedNewZones.find(zone=>zone.id===aisle.zoneId)!;
  const base:WarehouseZoneRecord=current?{...current,codes,layout:current.layout?Object.fromEntries(Object.entries(current.layout).filter(([code])=>codes.includes(code))):current.layout}:{id:spec.id,title:spec.title,codes,layout:{},features:[],unified:true,layoutVersion:targetZone.layoutVersion??WAREHOUSE_LAYOUT_VERSION};
  const layout={...(base.layout||{})};
  for(const code of spec.codes)if(!layout[code]&&inheritedAisleLayout.has(code))layout[code]={...inheritedAisleLayout.get(code)!};
  const aTemplate=mergedAisleZones[0]&&newWarehouseAisleSpecs[0].codes.map(code=>mergedAisleZones[0].layout?.[code]).find(Boolean);
  mergedAisleZones.push(completeAisleZone({...base,layout},aisle,targetZone,aTemplate));
 }
 return[...mergedNewZones,...mergedAisleZones,...otherZones];
}

const locationGapX=percentX(6.12),locationGapY=percentY(4.86),freeStepX=percentX(11.9),freeStepY=percentY(12.15);
const minimumLayoutWidth=percentX(LEGACY_WAREHOUSE_MAP_WIDTH/100),minimumLayoutHeight=percentY(LEGACY_WAREHOUSE_MAP_HEIGHT/100);
const overlaps=(a:LayoutBox,b:LayoutBox)=>a.x<b.x+b.w+locationGapX&&a.x+a.w+locationGapX>b.x&&a.y<b.y+b.h+locationGapY&&a.y+a.h+locationGapY>b.y;

const nearestFree=(source:LayoutBox,occupied:LayoutBox[])=>{
 if(!occupied.some(box=>overlaps(source,box)))return source;
 const stepX=source.w+freeStepX,stepY=source.h+freeStepY;
 for(let ring=1;ring<40;ring++)for(let dy=-ring;dy<=ring;dy++)for(let dx=-ring;dx<=ring;dx++){
  if(Math.max(Math.abs(dx),Math.abs(dy))!==ring)continue;
  const candidate={...source,x:Math.max(0,Math.min(100-source.w,source.x+dx*stepX)),y:Math.max(0,Math.min(100-source.h,source.y+dy*stepY))};
  if(!occupied.some(box=>overlaps(candidate,box)))return candidate;
 }
 return source;
};

export function normalizeWarehouseZone(zone:WarehouseZoneRecord):WarehouseZoneRecord{
 const base=actualWarehouseLayout(zone.codes),isCurrent=zone.layoutVersion===WAREHOUSE_LAYOUT_VERSION,migrateSavedLayout=!isCurrent,migrateBox=<T extends LayoutBox>(box:T)=>zone.layoutVersion===7?migrateV7LayoutBox(box):zone.layoutVersion===6?migrateV6LayoutBox(box):zone.layoutVersion===5?migrateV5LayoutBox(box):migrateLegacyLayoutBox(box),newZoneSpec=newWarehouseZoneSpecs.find(spec=>spec.id===zone.id),requiredNewCodes=new Set(newZoneSpec?.codes||[]),sameGeometry=(a:LayoutBox,b:LayoutBox)=>Math.abs(a.x-b.x)<1e-7&&Math.abs(a.y-b.y)<1e-7&&Math.abs(a.w-b.w)<1e-7&&Math.abs(a.h-b.h)<1e-7,canReflowSource=zone.layoutVersion===5||zone.layoutVersion===6||zone.layoutVersion===7,sourceDefaultLayout:Record<string,LayoutBox>=canReflowSource&&newZoneSpec?Object.fromEntries(newZoneSpec.codes.map(code=>[code,sourceNewWarehouseBox(code,zone.layoutVersion)!])):{},reflowCanonicalNewZone=canReflowSource&&!!newZoneSpec&&newZoneSpec.codes.every(code=>!zone.layout?.[code]||sameGeometry(zone.layout[code],sourceDefaultLayout[code]));
 const layout=Object.fromEntries(zone.codes.map(code=>{
  const saved=zone.layout?.[code];
  const currentGeometryFallback=migrateSavedLayout&&!!newZoneSpec&&requiredNewCodes.has(code)&&!canReflowSource;
  const migrated=migrateSavedLayout&&saved&&!currentGeometryFallback?migrateBox(saved):saved;
  const reflowRequiredCode=requiredNewCodes.has(code)&&reflowCanonicalNewZone;
  const box:LayoutBox=isCurrent?{...base[code],...(saved||{})}:reflowRequiredCode?{...base[code],...(saved||{}),x:base[code].x,y:base[code].y,w:base[code].w,h:base[code].h}:migrateSavedLayout&&migrated?{...base[code],...migrated}:{...base[code],capacityPallets:saved?.capacityPallets,capacityBoxes:saved?.capacityBoxes};
  box.w=Math.max(minimumLayoutWidth,Math.min(100,box.w));
  box.h=Math.max(minimumLayoutHeight,Math.min(100,box.h));
  box.x=Math.max(0,Math.min(100-box.w,box.x));
  box.y=Math.max(0,Math.min(100-box.h,box.y));
  return[code,box];
 }));
 const hasSavedFeatures=zone.features!==undefined;
 const sourceFeatures=hasSavedFeatures?zone.features!:requiredWarehouseFeatures(zone.id).map(feature=>zone.locationCodesVersion&&!zone.codes.some(code=>/^新[ABCD]\d+$/.test(code))?{...feature,label:feature.label.replace(/^新([ABCD])区$/,"$1区")}:feature);
 const migrateLegacyCanvas=zone.layoutVersion!==WAREHOUSE_LAYOUT_VERSION;
 const requiredFeatureMap=new Map(requiredWarehouseFeatures(zone.id).map(feature=>[feature.id,feature]));
 const sourceRequiredFeatureMap=new Map(sourceRequiredWarehouseFeatures(zone.id,zone.layoutVersion).map(feature=>[feature.id,feature]));
 const features=migrateLegacyCanvas&&hasSavedFeatures?sourceFeatures.map(feature=>{const currentRequired=requiredFeatureMap.get(feature.id),sourceRequired=sourceRequiredFeatureMap.get(feature.id),required=currentRequired&&sourceRequired&&sameGeometry(feature,sourceRequired)?currentRequired:undefined;return required?{...feature,x:required.x,y:required.y,w:required.w,h:required.h}:migrateBox(feature)}):sourceFeatures;
 const mapBox=migrateLegacyCanvas&&zone.mapBox?migrateBox(zone.mapBox):zone.mapBox;
 return applyNewPalletCapacityUpgrade({...zone,layout,features,mapBox,unified:true,layoutVersion:WAREHOUSE_LAYOUT_VERSION});
}

export function normalizeWarehouseZones(input:WarehouseZoneRecord[],options:{repairSaved?:boolean}={}):WarehouseZoneRecord[]{
 const inputZones=Array.isArray(input)?input:[],merged=mergeRequiredWarehouseZones(inputZones);
 const inputSavedLayoutCodes=new Set(inputZones.flatMap(zone=>Object.keys(zone.layout||{}))),savedLayoutCodes=new Set([...inputSavedLayoutCodes,...merged.flatMap(zone=>zone.codes.filter(code=>!!parseRequiredAisleCode(code)))]);
 const hadSavedAisleTemplate=new Map(newAisleDefinitions.map(aisle=>[aisle.id,inputZones.some(zone=>zone.codes.some(code=>parseRequiredAisleCode(code)?.aisle.id===aisle.id&&!!zone.layout?.[code]))]));
 const normalizedZones=merged.map((zone,index)=>{
  const normalized=normalizeWarehouseZone(zone);
  return{...normalized,mapBox:normalized.mapBox||{x:3+(index%3)*32,y:5+Math.floor(index/3)*43,w:28,h:36}};
 });
 for(const aisle of newAisleDefinitions){
  let sourceIndex=-1,sourceScore=0;
  merged.forEach((zone,index)=>{const score=aisleZoneMatchScore(zone,aisle);if(score>sourceScore){sourceIndex=index;sourceScore=score;}});
  if(sourceIndex<0||merged[sourceIndex].layoutVersion===WAREHOUSE_LAYOUT_VERSION)continue;
  const aisleZone=normalizedZones[sourceIndex],targetZone=normalizedZones.find(zone=>zone.id===aisle.zoneId),spec=newWarehouseAisleSpecs.find(candidate=>candidate.id===aisle.id)!;
  if(!aisleZone||!targetZone)continue;
  const layout={...(aisleZone.layout||{})},preserveSavedRow=hadSavedAisleTemplate.get(aisle.id);
  for(const [index,code] of spec.codes.entries()){
   if(inputSavedLayoutCodes.has(code))continue;
   const number=index+1,targetCode=`${aisle.targetPrefix}${number}`,target=targetZone.layout?.[targetCode]||aisleTargetFallbackBox(aisle,number,WAREHOUSE_LAYOUT_VERSION),box=layout[code];
   if(!target||!box)continue;
   layout[code]={...box,x:target.x,...(aisle.id==="AISLE_D"&&!preserveSavedRow?{y:target.y+aisle.rowOffsetPx/WAREHOUSE_MAP_HEIGHT*100}:{})};
  }
  normalizedZones[sourceIndex]={...aisleZone,layout};
 }
 const occupied:LayoutBox[]=[];
 return normalizedZones.map(zone=>{
  const layout=Object.fromEntries(zone.codes.map(code=>{
   const source=zone.layout![code],box=options.repairSaved||!savedLayoutCodes.has(code)?nearestFree(source,occupied):source;
   occupied.push(box);
   return[code,box];
  }));
  return{...zone,layout};
 });
}
