import {projectCartonRows,rawCartonRow,persistedCartonRow,fixedCartonPlacement,cartonProjectionPeers,withCartonProjectionPeers} from './carton-pallets';
import {palletCountValue,palletCountsEqual,palletCountExceeds,palletRemaining} from './pallet';
import {cartonPlacementDetails} from './box-stock-details';
import {parseProductBarcodes,splitProductBarcodes} from './product-barcodes';
import {warehouseTodayDate} from './warehouse-time';
import {env} from 'cloudflare:workers';
import {eq,desc,getTableColumns} from 'drizzle-orm';
import {getDb} from '../db';
import {cartonReceipts,cartonOperations,settings,auditLogs,stocks} from '../db/schema';
import {GoodsFlowError,goodsInteger} from './goods-flow';
import {goodsResponseError,loadGoodsContext} from './goods-store';
import {INVENTORY_ASSOCIATIONS_KEY} from './inventory-associations';
import {hasPermission,type PermissionUser,type Permission} from './permissions';
import {mergeRequiredWarehouseZones} from './warehouse-layout';
import {locationCodeKey} from './location-code';
import {parseLocationAliases,resolveLocationAlias,LOCATION_ALIASES_KEY} from './location-aliases';
import {cartonPalletCount,cartonPalletTotal,cartonTotal,type CartonReceipt,type CartonPlacement,type CartonOrderHistory} from './carton-flow';
type User=PermissionUser&{id:number;displayName:string};
type Row=typeof cartonReceipts.$inferSelect & {palletRawPlacements?:string};
export const cartonActions={inbound:'箱件收货',claim:'箱件认领改单',move:'移库',correction:'库存修改',details:'库存修改',outbound:'箱件出库',discard:'箱件删除',restore:'撤销箱件操作'} as const;
const pallets=(value:unknown,blankDefault=0)=>{const n=palletCountValue(value,blankDefault);if(!Number.isFinite(n))throw new GoodsFlowError('托盘数格式不正确，可填写 1、1/3、0.5',400);return n;};
const clean=(value:unknown,label:string,max=500,required=false)=>{if(typeof value!=='string')throw new GoodsFlowError(`${label}格式不正确`,400);const v=value.trim();if(v.length>max||(required&&!v))throw new GoodsFlowError(`请填写${label}（最多 ${max} 字）`,400);return v;};
const uuid=(value:unknown)=>{if(typeof value!=='string'||! /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))throw new GoodsFlowError('请求编号无效，请重新打开操作界面',400);return value;};
const date=(value:unknown,label:string)=>{const v=clean(value,label,10,true);if(!/^\d{4}-\d{2}-\d{2}$/.test(v)||!Number.isFinite(Date.parse(v))||new Date(v).toISOString().slice(0,10)!==v||v>warehouseTodayDate())throw new GoodsFlowError(`${label}无效`,400);return v;};
const encode=(v:unknown):string=>JSON.stringify(v);
export function cartonBody(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw new GoodsFlowError('提交格式不正确',400);return value as Record<string,unknown>;}
const canonical=(v:unknown):unknown=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,canonical(x)])):v;
export function cartonView(row:Row):CartonReceipt {const placements=JSON.parse(row.placements) as CartonPlacement[];return {...row,placements,orderHistory:JSON.parse(row.orderHistory),totalBoxes:cartonTotal(placements),status:row.customerName?'claimed':'pending',pricingStatus:'pending'};}
const rowFields=['id','inboundOrder','originalOrder','orderHistory','customerName','inboundDate','placements','note','version','createdBy','createdAt','updatedBy','updatedAt'] as const;
const sqlFields=['id','inbound_order','original_order','order_history','customer_name','inbound_date','placements','note','version','created_by','created_at','updated_by','updated_at'];
const values=(row:Row)=>rowFields.map(k=>row[k]);
async function rowById(id:string){const [row]=await getDb().select().from(cartonReceipts).where(eq(cartonReceipts.id,id));return row;}
async function operationById(id:string){const [row]=await getDb().select().from(cartonOperations).where(eq(cartonOperations.id,id));return row;}
async function replay(id:string,kind:string,body:unknown,user:User){const old=await operationById(id);if(!old)return null;if(old.userId!==user.id)throw new GoodsFlowError('此请求属于另一操作人员',409);if(old.kind!==kind||old.fingerprint!==encode(canonical(body)))throw new GoodsFlowError('请求编号已用于其他内容，请刷新后重试',409);if(old.restoredAt)throw new GoodsFlowError('此操作已撤销，请重新填写',409);return JSON.parse(old.result);}
function guard(id:string,before:Row|null,extra='1',bindings:unknown[]=[]){const peerRows=before?cartonProjectionPeers(before):undefined;if(peerRows){extra+=" AND (SELECT COUNT(*) FROM carton_receipts)=? AND NOT EXISTS(SELECT 1 FROM json_each(?) j LEFT JOIN carton_receipts c ON c.id=json_extract(j.value,'$.id') WHERE c.id IS NULL OR c.placements IS NOT json_extract(j.value,'$.placements') OR c.customer_name IS NOT json_extract(j.value,'$.customerName') OR c.inbound_order IS NOT json_extract(j.value,'$.inboundOrder') OR c.inbound_date IS NOT json_extract(j.value,'$.inboundDate') OR c.version IS NOT json_extract(j.value,'$.version') OR c.updated_at IS NOT json_extract(j.value,'$.updatedAt'))";bindings=[...bindings,peerRows.length,JSON.stringify(peerRows)];}before=before?rawCartonRow(before):null;const clause=before?`EXISTS(SELECT 1 FROM carton_receipts WHERE ${sqlFields.map(k=>`${k}=?`).join(' AND ')})`:'NOT EXISTS(SELECT 1 FROM carton_receipts WHERE id=?)';return env.DB.prepare(`INSERT INTO carton_transaction_guards(id,valid) SELECT ?,CASE WHEN ${clause} AND (${extra}) THEN 1 ELSE 0 END`).bind(id,...(before?values(before):[id]),...bindings);}
function cartonCommitPlan(kind:keyof typeof cartonActions,body:Record<string,unknown>,user:User,before:Row|null,after:Row|null,extra='1',bindings:unknown[]=[],restoreOf?:string){
 const writeAfter=after?persistedCartonRow(after):null;
 if(after&&writeAfter&&encode(after)!==encode(writeAfter))after={...after,palletRawPlacements:writeAfter.placements};
 const requestId=uuid(body.requestId),now=new Date().toISOString(),receiptId=after?.id??before!.id,result={ok:true,...(kind==='outbound'||kind==='discard'?{pallets:cartonPalletTotal(before?JSON.parse(before.placements):[])-cartonPalletTotal(after?JSON.parse(after.placements):[])}:{}),operationId:requestId,receipt:after?cartonView(after):null,pricingStatus:'pending'};
 const statements=[guard(requestId,before,extra,bindings)];
 if(writeAfter)statements.push(env.DB.prepare(`INSERT INTO carton_receipts(${sqlFields.join(',')}) VALUES(${sqlFields.map(()=>'?').join(',')}) ON CONFLICT(id) DO UPDATE SET ${sqlFields.slice(1).map(k=>`${k}=excluded.${k}`).join(',')}`).bind(...values(writeAfter)));
 else statements.push(env.DB.prepare('DELETE FROM carton_receipts WHERE id=?').bind(before!.id));
 statements.push(env.DB.prepare('INSERT INTO carton_operations(id,receipt_id,kind,fingerprint,before_snapshot,after_snapshot,result,user_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(requestId,receiptId,kind,encode(canonical(body)),before?encode(before):null,after?encode(after):null,encode(result),user.id,now));
 if(restoreOf)statements.push(env.DB.prepare('UPDATE carton_operations SET restored_at=? WHERE id=?').bind(now,restoreOf));
 const viewRow=(after??before)!,currentBoxes=cartonTotal(after?JSON.parse(after.placements):[]),beforeBoxes=cartonTotal(before?JSON.parse(before.placements):[]),locationSummary=(JSON.parse(viewRow.placements) as CartonPlacement[]).map(p=>`${p.locationCode} · ${p.layerCount}层${p.marker?` · ${p.marker}`:''}`).join('；');
 const selectedBefore=kind==='correction'||kind==='details'?(JSON.parse(before!.placements) as CartonPlacement[]).find(p=>p.key===body.placementKey):undefined,selectedAfter=kind==='correction'||kind==='details'?(JSON.parse(after!.placements) as CartonPlacement[]).find(p=>p.key===body.placementKey):undefined;
 const previousDetails=selectedBefore?cartonPlacementDetails(cartonView(before!),selectedBefore):undefined,currentDetails=selectedAfter?cartonPlacementDetails(cartonView(after!),selectedAfter):undefined;
 const detailLabels={product:'产品名称',sku:'SKU',customerName:'商家',inboundSource:'来源',layerCount:'层数',productCondition:'品相',productPrefix:'产品附加前缀',palletCount:'托盘数',inboundOrder:'入库单号',barcodes:'条码',note:'备注'} as const;
 const changedFields=currentDetails&&previousDetails?Object.entries(detailLabels).filter(([key])=>encode(previousDetails[key as keyof typeof detailLabels])!==encode(currentDetails[key as keyof typeof detailLabels])).map(([,label])=>label):[];
 const summary=currentDetails&&selectedAfter&&selectedBefore?
  `${currentDetails.inboundOrder||'无'} | 产品 ${currentDetails.product} | SKU ${currentDetails.sku||'无'} | 商家 ${currentDetails.customerName||'待认领'} | ${kind==='correction'?`箱数校正 ${selectedBefore.boxes}箱 → ${selectedAfter.boxes}箱 | 校正库位 ${selectedAfter.locationCode} · ${selectedAfter.layerCount}层 | 剩余 ${currentBoxes}箱 | 入库日期 ${currentDetails.inboundDate}${body.reason?` | 原因 ${clean(body.reason,'校正原因')}`:''}`:`资料修改 | 修改库位 ${selectedAfter.locationCode} · ${selectedAfter.layerCount}层 | 入库日期 ${previousDetails!.inboundDate!==currentDetails.inboundDate?`${previousDetails!.inboundDate} → ${currentDetails.inboundDate}`:currentDetails.inboundDate}${changedFields.length?` | 修改字段 ${changedFields.join('、')}`:''} | 剩余 ${currentBoxes}箱`} | 原收货单号 ${viewRow.originalOrder} | 原收货日期 ${viewRow.inboundDate} | 库位 ${locationSummary}`:
  `${viewRow.inboundOrder} | 商家 ${viewRow.customerName||'待认领'} | ${kind==='outbound'?`本次出库 ${beforeBoxes-currentBoxes}箱 | 托盘 -${cartonPalletTotal(JSON.parse(before!.placements))-cartonPalletTotal(after?JSON.parse(after.placements):[])} | 出库日期 ${body.outboundDate}`:kind==='discard'?`本次删除 ${beforeBoxes-currentBoxes}箱（不计出库） | 剩余 ${currentBoxes}箱 | 入库日期 ${viewRow.inboundDate}`:`剩余 ${currentBoxes}箱 | 入库日期 ${viewRow.inboundDate}`} | 库位 ${locationSummary}${kind==='claim'?` | 原单号 ${before!.inboundOrder} → ${after!.inboundOrder}`:''}`;
 statements.push(env.DB.prepare('INSERT INTO audit_logs(user_id,user_name,action,entity_type,entity_id,operation_id,summary,before_snapshot,after_snapshot,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(user.id,user.displayName,cartonActions[kind],restoreOf?'箱件原操作':'箱件收货',restoreOf??receiptId,requestId,summary,before?encode(before):null,after?encode(after):null,now));
 statements.push(env.DB.prepare('DELETE FROM carton_transaction_guards WHERE id=?').bind(requestId));
 return {queries:statements,result,after};
}
async function commit(...args:Parameters<typeof cartonCommitPlan>){const {queries:statements,result}=cartonCommitPlan(...args);try{await env.DB.batch(statements);}catch(error){let current:unknown=error;for(let i=0;i<8&&current;i++){if(/CHECK constraint|UNIQUE constraint/.test(String(current)))throw new GoodsFlowError('箱件或库位资料已被其他人修改，请刷新核对后重试',409);current=typeof current==='object'&&'cause' in current?(current as {cause:unknown}).cause:null;}throw error;}return result; }

export async function createCarton(body:Record<string,unknown>,user:User){
 const requestId=uuid(body.requestId),old=await replay(requestId,'inbound',body,user);if(old)return old;
 const inboundOrder=clean(body.inboundOrder,'入库单号',200,true),inboundDate=date(body.inboundDate,'入库日期'),customerName=clean(body.customerName??'','商家',200),note=clean(body.note??'','备注',5000);
 if(!Array.isArray(body.placements)||!body.placements.length||body.placements.length>100)throw new GoodsFlowError('请分配 1 至 100 个实际库位',400);
 const [zone,alias]=await Promise.all([getDb().select().from(settings).where(eq(settings.key,'warehouse_zones')).then(r=>r[0]),getDb().select().from(settings).where(eq(settings.key,LOCATION_ALIASES_KEY)).then(r=>r[0])]);
 const aliases=parseLocationAliases(alias?.value),codes=mergeRequiredWarehouseZones(zone?JSON.parse(zone.value):[]).flatMap(z=>z.codes);
 const keys=new Set<string>(),placements:CartonPlacement[]=body.placements.map((raw:unknown)=>{if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new GoodsFlowError('库位分配格式不正确',400);const p=raw as Record<string,unknown>,key=clean(p.key,'分配标识',100,true);if(keys.has(key))throw new GoodsFlowError('库位分配重复',400);keys.add(key);const requested=resolveLocationAlias(clean(p.locationCode,'库位',100,true),aliases),matches=codes.filter(c=>locationCodeKey(c)===locationCodeKey(requested));if(matches.length!==1)throw new GoodsFlowError('请选择地图中实际已有的库位',400);if(p.palletManual!==undefined&&typeof p.palletManual!=='boolean')throw new GoodsFlowError('托盘模式不正确',400);const count=pallets(p.palletCount,1);return {key,palletManual:typeof p.palletManual==='boolean'?p.palletManual:count!==1,palletCount:count,locationCode:matches[0],layerCount:goodsInteger(p.layerCount,'层',1),boxes:goodsInteger(p.boxes,'箱数',1),marker:clean(p.marker??'','产品附加前缀',500),note:clean(p.note??body.note??'','备注',16000)};});
 if(!Number.isSafeInteger(cartonTotal(placements)))throw new GoodsFlowError('总箱数超出范围',400);
 const now=new Date().toISOString(),row:Row={id:requestId,inboundOrder,originalOrder:inboundOrder,orderHistory:encode([{number:inboundOrder,changedAt:now,changedBy:user.id}]),customerName,inboundDate,placements:encode(placements),note,version:0,createdBy:user.id,createdAt:now,updatedBy:user.id,updatedAt:now};
 const clause=`COALESCE((SELECT value FROM settings WHERE key='warehouse_zones'),'')=? AND COALESCE((SELECT value FROM settings WHERE key=?),'')=?`;
 return commit('inbound',body,user,null,row,clause,[zone?.value??'',LOCATION_ALIASES_KEY,alias?.value??'']);
}
async function mutable(body:Record<string,unknown>){const id=uuid(body.id),row=await rowById(id);if(!row)throw new GoodsFlowError('箱件收货记录不存在',404);const version=goodsInteger(body.expectedVersion,'资料版本',0);if(version!==row.version)throw new GoodsFlowError('箱件资料已变化，请刷新再处理',409);const all=await getDb().select().from(cartonReceipts),ops=await getDb().select().from(cartonOperations),selected=projectCartonRows(all,ops).find(r=>r.id===id);if(!selected||selected.version!==version)throw new GoodsFlowError('箱件资料已变化，请刷新再处理',409);return selected;}
/** A matching request may finish between the initial replay read and any later validation read. */
async function committedRetry<T>(kind:string,body:Record<string,unknown>,user:User,run:()=>Promise<T>){try{return await run();}catch(error){if(error instanceof GoodsFlowError&&error.status===403)throw error;const completed=await replay(uuid(body.requestId),kind,body,user);if(completed)return completed;throw error;}}
export async function claimCarton(body:Record<string,unknown>,user:User){return committedRetry('claim',body,user,()=>claimCartonOnce(body,user));}
export async function moveCarton(body:Record<string,unknown>,user:User){return committedRetry('move',body,user,()=>moveCartonOnce(body,user));}
export async function outboundCarton(body:Record<string,unknown>,user:User){return committedRetry('outbound',body,user,()=>outboundCartonOnce(body,user));}
export async function correctCarton(body:Record<string,unknown>,user:User){return committedRetry('correction',body,user,()=>correctCartonOnce(body,user));}
/** Guard current permissions before replay, including direct store callers. */
export async function updateCartonDetails(body:Record<string,unknown>,user:User){return committedRetry('details',body,user,()=>updateCartonDetailsOnce(body,user));}
async function updateCartonDetailsOnce(body:Record<string,unknown>,user:User){
 if((body.details!==undefined&&!hasPermission(user,'stock.edit'))||(body.identity!==undefined&&!hasPermission(user,'product.manage')))throw new GoodsFlowError('当前账号没有此箱库存资料修改权限',403);
 const requestId=uuid(body.requestId),old=await replay(requestId,'details',body,user);if(old)return old;
 const before=await mutable(body),key=clean(body.placementKey,'分配标识',100,true),placements=JSON.parse(before.placements) as CartonPlacement[],target=placements.find(p=>p.key===key);
 if(!target||target.boxes<=0)throw new GoodsFlowError('所选库位已没有箱库存，请刷新核对',400);
 if(body.details===undefined&&body.identity===undefined)throw new GoodsFlowError('请填写要修改的箱库存资料',400);
 const effective=cartonPlacementDetails(cartonView(before),target);
 if(body.details!==undefined){
  const d=cartonBody(body.details),allowed=['inboundDate','inboundSource','layerCount','productCondition','productPrefix','inboundOrder','barcodes','note'];
  if(Object.keys(d).some(k=>!allowed.includes(k)&&k!=='palletCount'&&k!=='palletManual')||allowed.some(k=>!Object.prototype.hasOwnProperty.call(d,k)))throw new GoodsFlowError('箱库存资料字段不完整或包含不允许修改的字段',400);
  const inboundDate=date(d.inboundDate,'入库日期');
  if(!['domestic','return','unspecified'].includes(String(d.inboundSource))||typeof d.inboundSource!=='string')throw new GoodsFlowError('入库来源无效',400);
  if(!['','good','damaged'].includes(String(d.productCondition))||typeof d.productCondition!=='string')throw new GoodsFlowError('请选择正品或残次品',400);
  let barcodes:string[];try{barcodes=splitProductBarcodes(parseProductBarcodes(d.barcodes));}catch(e){throw new GoodsFlowError((e as Error).message,400);}
  target.details={...target.details,inboundDate,inboundSource:d.inboundSource as 'domestic'|'return'|'unspecified',productCondition:d.productCondition as ''|'good'|'damaged',inboundOrder:clean(d.inboundOrder,'入库单号',200),barcodes};
  if(d.palletManual!==undefined&&typeof d.palletManual!=='boolean')throw new GoodsFlowError('托盘模式不正确',400);
  if(d.palletCount!==undefined){const count=pallets(d.palletCount,effective.palletCount);if(d.palletManual===true||count!==effective.palletCount){Object.assign(target,fixedCartonPlacement(target,count));delete target.palletProjection;delete target.palletAutomatic;}}
  target.layerCount=goodsInteger(d.layerCount,'层',1);target.marker=clean(d.productPrefix,'产品附加前缀',500);target.note=clean(d.note,'备注',16000);
 }
 if(body.identity!==undefined){const identity=cartonBody(body.identity);if(Object.keys(identity).length!==3||!['product','sku','customerName'].every(k=>Object.prototype.hasOwnProperty.call(identity,k)))throw new GoodsFlowError('箱库存身份字段不正确',400);target.details={...target.details,product:clean(identity.product,'产品名称',2000,true),sku:clean(identity.sku,'SKU',500),customerName:clean(identity.customerName,'商家',200)};}
 let clause='1',bindings:unknown[]=[];
 if(target.details?.inboundDate!==undefined&&target.details.inboundDate!==effective.inboundDate){
  const operations=await getDb().select().from(cartonOperations).where(eq(cartonOperations.receiptId,before.id));
  for(const op of operations){if(op.kind!=='outbound'||op.restoredAt)continue;const payload=JSON.parse(op.fingerprint);if(payload.picks?.some((p:{key:string})=>p.key===key)&&target.details.inboundDate>payload.outboundDate)throw new GoodsFlowError('入库日期不能晚于所选库位已记录的出库日期',409);}
  // Capture full outbound evidence so a simultaneous historical change cannot bypass date checks.
  const evidence=operations.filter(op=>op.kind==='outbound').map(op=>({id:op.id,fingerprint:op.fingerprint,restoredAt:op.restoredAt}));
  clause="(SELECT COUNT(*) FROM carton_operations WHERE receipt_id=? AND kind='outbound')=? AND NOT EXISTS(SELECT 1 FROM json_each(?) j LEFT JOIN carton_operations o ON o.id=json_extract(j.value,'$.id') WHERE o.id IS NULL OR o.fingerprint IS NOT json_extract(j.value,'$.fingerprint') OR o.restored_at IS NOT json_extract(j.value,'$.restoredAt'))";
  bindings=[before.id,evidence.length,encode(evidence)];
 }
 const after={...before,placements:encode(placements),version:before.version+1,updatedAt:new Date().toISOString(),updatedBy:user.id};
 return commit('details',body,user,before,after,clause,bindings);
}

async function correctCartonOnce(body:Record<string,unknown>,user:User){
 if(!hasPermission(user,'stock.edit'))throw new GoodsFlowError('当前账号没有箱库存数量校正权限',403);
 const requestId=uuid(body.requestId),old=await replay(requestId,'correction',body,user);if(old)return old;
 const before=await mutable(body),key=clean(body.placementKey,'分配标识',100,true),boxes=goodsInteger(body.boxes,'校正后箱数',0),placements=JSON.parse(before.placements) as CartonPlacement[],target=placements.find(p=>p.key===key);
 if(!target||target.boxes<=0)throw new GoodsFlowError('所选库位已没有箱库存，请刷新核对',400);
 const count=body.palletCount===undefined?cartonPalletCount(target):pallets(body.palletCount,cartonPalletCount(target));
 if(boxes===target.boxes&&count===cartonPalletCount(target))throw new GoodsFlowError('校正后箱数与当前箱数相同',400);
 if(body.reason!==undefined)clean(body.reason,'校正原因');
 const fixed=boxes===0||body.palletManual===true||body.palletCount!==undefined&&count!==cartonPalletCount(target);target.boxes=boxes;if(fixed){Object.assign(target,fixedCartonPlacement(target,boxes>0?count:0));delete target.palletProjection;delete target.palletAutomatic;}
 if(!Number.isSafeInteger(cartonTotal(placements)))throw new GoodsFlowError('总箱数超出范围',400);
 const after={...before,placements:encode(placements),version:before.version+1,updatedAt:new Date().toISOString(),updatedBy:user.id};
 return commit('correction',body,user,before,after);
}
async function claimCartonOnce(body:Record<string,unknown>,user:User){
 const requestId=uuid(body.requestId),old=await replay(requestId,'claim',body,user);if(old)return old;
 const before=await mutable(body),customerName=clean(body.customerName??before.customerName,'商家',200),inboundOrder=clean(body.inboundOrder??before.inboundOrder,'入库单号',200,true),note=clean(body.note??before.note,'备注',5000),now=new Date().toISOString();
 const history=JSON.parse(before.orderHistory) as CartonOrderHistory[];if(inboundOrder!==before.inboundOrder)history.push({number:inboundOrder,changedAt:now,changedBy:user.id});
 const placements=JSON.parse(before.placements) as CartonPlacement[];
 if(body.placementNotes!==undefined){if(!body.placementNotes||typeof body.placementNotes!=='object'||Array.isArray(body.placementNotes))throw new GoodsFlowError('库位备注格式不正确',400);const notes=body.placementNotes as Record<string,unknown>;if(Object.keys(notes).some(key=>!placements.some(p=>p.key===key)))throw new GoodsFlowError('备注对应的库位已变化，请刷新后修改',409);for(const p of placements)if(Object.prototype.hasOwnProperty.call(notes,p.key))p.note=clean(notes[p.key],'备注',16000);}
 let clause='1',bindings:unknown[]=[];
 const placementCustomers=body.placementCustomerNames===undefined?null:cartonBody(body.placementCustomerNames);
 if(placementCustomers&&(!Object.keys(placementCustomers).length||Object.entries(placementCustomers).some(([key,value])=>!body.placementProducts||typeof body.placementProducts!=='object'||Array.isArray(body.placementProducts)||!(body.placementProducts as Record<string,unknown>)[key]||typeof value!=='string'||!value.trim())))throw new GoodsFlowError('库位商家只能随明确的产品关联一起修改',400);
 if(body.placementProducts!==undefined){
  if(!body.placementProducts||typeof body.placementProducts!=='object'||Array.isArray(body.placementProducts))throw new GoodsFlowError('库位产品关联格式不正确',400);
  const entries=Object.entries(body.placementProducts as Record<string,unknown>);
  if(!entries.length||entries.length>100)throw new GoodsFlowError('请选择要关联或取消关联的实际库位',400);
  for(const [key,value] of entries){const target=placements.find(p=>p.key===key);if(!target||target.boxes<=0)throw new GoodsFlowError('所选库位已没有箱件，请刷新后处理',400);if(value!==null&&(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==1||!Object.prototype.hasOwnProperty.call(value,'choiceKey')))throw new GoodsFlowError('只能从已有产品中选择关联，不能填写产品资料',400);}
  const context=entries.some(([,v])=>v!==null)?await loadGoodsContext():null;
  if(context){
   if(goodsInteger(body.expectedGoodsRevision,'产品资料版本',0)!==context.stored.revision)throw new GoodsFlowError('产品资料已变化，请刷新后重新选择',409);
   // Guard the exact source of goodsChoices, including identity edits that did not bump a stock version.
   const changed=Object.entries(getTableColumns(stocks)).map(([key,column])=>`s."${column.name}" IS NOT json_extract(j.value,'$.${key}')`).join(' OR ');
   clause=`EXISTS(SELECT 1 FROM goods_flow_state WHERE id=1 AND revision=? AND value=?) AND COALESCE((SELECT value FROM settings WHERE key=?),'')=? AND (SELECT COUNT(*) FROM stocks)=? AND NOT EXISTS(SELECT 1 FROM json_each(?) j LEFT JOIN stocks s ON s.id=json_extract(j.value,'$.id') WHERE s.id IS NULL OR ${changed})`;
   bindings=[context.stored.revision,context.stored.value,INVENTORY_ASSOCIATIONS_KEY,context.associationValue??'',context.rows.length,encode(context.rows)];
  }
  for(const [key,value] of entries){
   const target=placements.find(p=>p.key===key)!;if(value===null){delete target.product;continue;}
   const choiceKey=clean((value as Record<string,unknown>).choiceKey,'产品选择',2000,true),choice=context!.choices.find(c=>c.key===choiceKey);
   if(!choice||choice.review||choice.archived||!choice.customerName.trim()||choice.members.some(r=>r.inventoryUnit==='box'))throw new GoodsFlowError('请选择商家明确、已核对且未停用的产品',400);
   const selectedCustomer=placementCustomers&&Object.prototype.hasOwnProperty.call(placementCustomers,key)?clean(placementCustomers[key],'商家',200,true):body.customerName!==undefined&&customerName!==before.customerName?customerName:cartonPlacementDetails(cartonView(before),target).customerName;
   if(choice.customerName!==selectedCustomer)throw new GoodsFlowError('所选产品的商家与箱件商家不一致，请先核对认领资料',400);
   target.product={key:choice.key,name:choice.product,sku:choice.sku,customerName:choice.customerName};
   if(target.details){delete target.details.product;delete target.details.sku;}
   if(target.details?.customerName!==undefined||placementCustomers&&Object.prototype.hasOwnProperty.call(placementCustomers,key))target.details={...target.details,customerName:choice.customerName};
  }
 }
 if(placements.some(p=>p.boxes>0&&p.product&&p.details?.customerName===undefined&&p.product.customerName!==customerName))throw new GoodsFlowError('请先取消或重新选择现有库位产品关联，再更改箱件商家',400);
 const after={...before,placements:encode(placements),customerName,inboundOrder,note,orderHistory:encode(history),version:before.version+1,updatedAt:now,updatedBy:user.id};
 try{return await commit('claim',body,user,before,after,clause,bindings);}catch(error){const completed=await replay(requestId,'claim',body,user);if(completed)return completed;throw error;}
}
/** Split and coalesce within one receipt only. Validate every allocation against the original sources. */
async function moveCartonOnce(body:Record<string,unknown>,user:User){
 if(!hasPermission(user,'stock.move'))throw new GoodsFlowError('当前账号没有箱件移库权限',403);
 const requestId=uuid(body.requestId),old=await replay(requestId,'move',body,user);if(old)return old;
 const before=await mutable(body),original=(JSON.parse(before.placements) as CartonPlacement[]).map(p=>({...p,palletCount:cartonPalletCount(p)}));
 if(!Array.isArray(body.moves)||!body.moves.length||body.moves.length>100)throw new GoodsFlowError('请填写 1 至 100 条移库分配',400);
 const [zone,alias]=await Promise.all([getDb().select().from(settings).where(eq(settings.key,'warehouse_zones')).then(r=>r[0]),getDb().select().from(settings).where(eq(settings.key,LOCATION_ALIASES_KEY)).then(r=>r[0])]);
 const aliases=parseLocationAliases(alias?.value),codes=mergeRequiredWarehouseZones(zone?JSON.parse(zone.value):[]).flatMap(z=>z.codes),allocations=new Map<string,number>();
 const activeCode=(code:string)=>{const resolved=resolveLocationAlias(code,aliases),matches=codes.filter(c=>locationCodeKey(c)===locationCodeKey(resolved));if(matches.length!==1)throw new GoodsFlowError('请选择地图中实际已有的库位',400);return matches[0];};
 const moves=body.moves.map(raw=>{
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new GoodsFlowError('移库分配格式不正确',400);
  const p=raw as Record<string,unknown>,key=clean(p.fromKey,'来源分配标识',100,true),source=original.find(x=>x.key===key),boxes=goodsInteger(p.boxes,'移库箱数',1);
  if(!source||source.boxes<=0)throw new GoodsFlowError('来源库位已没有箱件，请刷新核对',400);
  const allocated=(allocations.get(key)??0)+boxes;if(!Number.isSafeInteger(allocated)||allocated>source.boxes)throw new GoodsFlowError('来源库位的移库总箱数超过原有箱数',400);allocations.set(key,allocated);
  activeCode(source.locationCode);
  return {...source,palletCount:pallets(p.pallets),autoPallets:p.pallets===undefined||typeof p.pallets==='string'&&!p.pallets.trim(),fromKey:key,key:'',locationCode:activeCode(clean(p.toLocationCode,'目标库位',100,true)),layerCount:goodsInteger(p.toLayerCount,'目标层',1),boxes,marker:p.toMarker===undefined?source.marker:clean(p.toMarker,'产品附加前缀',500),...(p.toNote===undefined?{}:{note:clean(p.toNote,'备注',16000)})};
 });
 const palletAllocations=new Map<string,number>();
 for(const source of original){
  const selected=moves.filter(m=>m.fromKey===source.key);if(!selected.length)continue;
  let count=selected.reduce((n,m)=>n+m.palletCount,0);
  const equal=palletCountsEqual(count,source.palletCount);
  if(count>source.palletCount&&!equal)throw new GoodsFlowError('来源库位的移库托盘数超过现有托盘数',400);
  // Preserve the explicitly allocated decimal values; only normalize the source balance.
  if(equal)count=source.palletCount;
  if(allocations.get(source.key)===source.boxes){const auto=selected.filter(m=>m.autoPallets).at(-1);if(auto){auto.palletCount+=source.palletCount-count;count=source.palletCount;}if(!palletCountsEqual(count,source.palletCount))throw new GoodsFlowError('全部移库必须一并分配全部托盘',400);}
  palletAllocations.set(source.key,count);
 }
 const placements=original.map(p=>allocations.has(p.key)?{...fixedCartonPlacement(p,palletRemaining(p.palletCount,palletAllocations.get(p.key)??0)),boxes:p.boxes-(allocations.get(p.key)??0)}:{...p});
 for(const {autoPallets,fromKey,...moved} of moves){
  const target=placements.find(p=>locationCodeKey(resolveLocationAlias(p.locationCode,aliases))===locationCodeKey(moved.locationCode)&&p.layerCount===moved.layerCount&&p.marker===moved.marker&&p.note===moved.note&&encode(canonical(p.product))===encode(canonical(moved.product))&&encode(canonical(p.details))===encode(canonical(moved.details)));
  if(target){const count=cartonPalletCount(target)+moved.palletCount;Object.assign(target,fixedCartonPlacement(target,count));delete target.palletProjection;delete target.palletAutomatic;target.boxes+=moved.boxes;target.locationCode=moved.locationCode;}else placements.push({...fixedCartonPlacement(moved,moved.palletCount),key:crypto.randomUUID()});
 }
 if(placements.filter(p=>p.boxes>0).length>100)throw new GoodsFlowError('同一箱件单最多保留 100 条有箱件的库位分配，请先整理后再移库',400);
 if(cartonTotal(placements)!==cartonTotal(original)||placements.some(p=>!Number.isSafeInteger(p.boxes)))throw new GoodsFlowError('移库箱数校验失败，请重新核对',400);
 const after={...before,placements:encode(placements),version:before.version+1,updatedAt:new Date().toISOString(),updatedBy:user.id},clause=`COALESCE((SELECT value FROM settings WHERE key='warehouse_zones'),'')=? AND COALESCE((SELECT value FROM settings WHERE key=?),'')=?`;
 try{return await commit('move',body,user,before,after,clause,[zone?.value??'',LOCATION_ALIASES_KEY,alias?.value??'']);}catch(error){const completed=await replay(requestId,'move',body,user);if(completed)return completed;throw error;}
}
async function outboundCartonOnce(body:Record<string,unknown>,user:User){const requestId=uuid(body.requestId),old=await replay(requestId,'outbound',body,user);if(old)return old;const before=await mutable(body),outboundDate=date(body.outboundDate,'出库日期');if(!Array.isArray(body.picks)||!body.picks.length)throw new GoodsFlowError('请填写出库分配箱数',400);const placements=JSON.parse(before.placements) as CartonPlacement[],keys=new Set();for(const raw of body.picks){if(!raw||typeof raw!=='object')throw new GoodsFlowError('出库分配格式不正确',400);const p=raw as Record<string,unknown>,key=clean(p.key,'分配标识',100,true),boxes=goodsInteger(p.boxes,'出库箱数',1),target=placements.find(x=>x.key===key);if(keys.has(key)||!target||boxes>target.boxes)throw new GoodsFlowError('出库数量超过所选库位箱数，或库位重复',400);if(outboundDate<cartonPlacementDetails(cartonView(before),target).inboundDate)throw new GoodsFlowError('出库日期不能早于所选库位入库日期',400);const beforePallets=cartonPalletCount(target),picked=pallets(p.pallets);if(palletCountExceeds(picked,beforePallets))throw new GoodsFlowError('出库托盘数超过所选库位现有托盘数',400);keys.add(key);target.boxes-=boxes;if(target.boxes===0||picked>0){Object.assign(target,fixedCartonPlacement(target,target.boxes===0?0:palletRemaining(beforePallets,picked)));delete target.palletProjection;delete target.palletAutomatic;}}try{return await commit('outbound',body,user,before,{...before,placements:encode(placements),version:before.version+1,updatedAt:new Date().toISOString(),updatedBy:user.id});}catch(error){const completed=await replay(requestId,'outbound',body,user);if(completed)return completed;throw error;}}
/** Delete only the selected physical placement; retain the receipt and its history for exact undo. */
export async function discardCarton(body:Record<string,unknown>,user:User){
 if(!hasPermission(user,'stock.delete'))throw new GoodsFlowError('当前账号没有箱件删除权限',403);
 const requestId=uuid(body.requestId),old=await replay(requestId,'discard',body,user);if(old)return old;
 const before=await mutable(body),key=clean(body.placementKey,'库位分配标识',100,true),placements=JSON.parse(before.placements) as CartonPlacement[],target=placements.find(p=>p.key===key);
 if(!target)throw new GoodsFlowError('没有找到要删除的箱件库位，请刷新核对',400);
 if(target.boxes<=0)throw new GoodsFlowError('该库位已没有箱件，无需重复删除',409);
 target.boxes=0;Object.assign(target,fixedCartonPlacement(target,0));delete target.palletProjection;delete target.palletAutomatic;
 const after={...before,placements:encode(placements),version:before.version+1,updatedAt:new Date().toISOString(),updatedBy:user.id};
 try{return await commit('discard',body,user,before,after);}catch(error){const completed=await replay(requestId,'discard',body,user);if(completed)return completed;throw error;}
}
const permission=(kind:string):Permission=>kind==='inbound'?'stock.inbound':kind==='outbound'?'stock.outbound':kind==='discard'?'stock.delete':kind==='move'?'stock.move':'stock.edit';
const operationPermitted=(op:typeof cartonOperations.$inferSelect,user:User)=>{if(op.kind!=='details')return hasPermission(user,permission(op.kind));const payload=JSON.parse(op.fingerprint);return (payload.details===undefined||hasPermission(user,'stock.edit'))&&(payload.identity===undefined||hasPermission(user,'product.manage'));};
/** Only a recorded undo may advance bookkeeping fields while restoring exact business content. */
async function matchesRestorableState(op:typeof cartonOperations.$inferSelect,current:Row){
 if(op.afterSnapshot&&encode(current)===encode(rawCartonRow(JSON.parse(op.afterSnapshot) as Row)))return true;
 if(op.kind!=='move'||!op.afterSnapshot)return false;
 const expected=rawCartonRow(JSON.parse(op.afterSnapshot) as Row);
 const business=(row:Row)=>Object.fromEntries(Object.entries(row).filter(([key])=>!['version','updatedAt','updatedBy'].includes(key)));
 if(current.version<=expected.version||encode(canonical(business(current)))!==encode(canonical(business(expected))))return false;
 const operations=await getDb().select().from(cartonOperations).where(eq(cartonOperations.receiptId,op.receiptId));
 const later=operations.filter(x=>x.kind!=='restore'&&x.beforeSnapshot&&Number(JSON.parse(x.beforeSnapshot).version)>=expected.version);
 return later.length>0&&later.every(x=>!!x.restoredAt)&&operations.some(x=>x.kind==='restore'&&x.afterSnapshot===encode(current));
}
export async function restoreCarton(body:Record<string,unknown>,user:User){
 const op=await operationById(uuid(body.operationId));
 if(op&&JSON.parse(op.fingerprint).merchantChangeId)throw new GoodsFlowError('这是商家整批调整的一部分，请在“商家合并／批量更换”中撤销整次调整',409);
 if((op?.kind==='correction'||op?.kind==='details')&&(!hasPermission(user,'stock.restore')||!operationPermitted(op,user)))throw new GoodsFlowError('当前账号没有此箱库存修改的撤销权限',403);
 const old=await replay(uuid(body.requestId),'restore',body,user);if(old)return old;
 if(!op)throw new GoodsFlowError('没有找到箱件操作',404);
 if(op.kind==='convert'){const [log]=await getDb().select().from(auditLogs).where(eq(auditLogs.operationId,op.id));if(!log)throw new GoodsFlowError('转换记录不完整',409);const {restoreGoodsOperation}=await import('./goods-restore');const response=await restoreGoodsOperation(log,user);if(!response)throw new GoodsFlowError('转换记录不完整',409);if(!response.ok){const problem=await response.json() as {error:string};throw new GoodsFlowError(problem.error,response.status);}return {ok:true};}
 if(op.kind==='restore'||op.restoredAt)throw new GoodsFlowError('该箱件操作已撤销或不能再次撤销',409);
 if(!hasPermission(user,'stock.restore')||!operationPermitted(op,user))throw new GoodsFlowError('当前账号没有此箱件操作的撤销权限',403);
 const current=await rowById(op.receiptId);if(!current||goodsInteger(body.expectedVersion,'资料版本',0)!==current.version||!await matchesRestorableState(op,current))throw new GoodsFlowError('箱件已有后续修改或出库，不能撤销旧记录',409);
 const before=op.beforeSnapshot?rawCartonRow(JSON.parse(op.beforeSnapshot) as Row):null,after=before?{...before,version:current.version+1,updatedAt:new Date().toISOString(),updatedBy:user.id}:null;
 let clause='EXISTS(SELECT 1 FROM carton_operations WHERE id=? AND restored_at IS NULL AND after_snapshot=?)';const bindings:unknown[]=[op.id,op.afterSnapshot];
 if(encode(current)!==encode(rawCartonRow(JSON.parse(op.afterSnapshot!) as Row))){clause+=" AND NOT EXISTS(SELECT 1 FROM carton_operations WHERE receipt_id=? AND kind<>'restore' AND before_snapshot IS NOT NULL AND CAST(json_extract(before_snapshot,'$.version') AS INTEGER)>=? AND restored_at IS NULL) AND EXISTS(SELECT 1 FROM carton_operations WHERE receipt_id=? AND kind='restore' AND after_snapshot=?)";bindings.push(op.receiptId,(JSON.parse(op.afterSnapshot!) as Row).version,op.receiptId,encode(current));}
 if(after&&(JSON.parse(after.placements) as CartonPlacement[]).some(p=>p.boxes>0)){
  const [zone,alias]=await Promise.all([getDb().select().from(settings).where(eq(settings.key,'warehouse_zones')).then(r=>r[0]),getDb().select().from(settings).where(eq(settings.key,LOCATION_ALIASES_KEY)).then(r=>r[0])]);
  const aliases=parseLocationAliases(alias?.value),codes=mergeRequiredWarehouseZones(zone?JSON.parse(zone.value):[]).flatMap(z=>z.codes);
  const placements=JSON.parse(after.placements) as CartonPlacement[];
  let renamed=false;for(const p of placements){if(!p.boxes)continue;const matches=codes.filter(c=>locationCodeKey(c)===locationCodeKey(resolveLocationAlias(p.locationCode,aliases)));if(matches.length!==1)throw new GoodsFlowError(`原库位 ${p.locationCode} 已删除或变更，请先核对实际存放位置，不能直接撤销`,409);if(p.locationCode!==matches[0]){renamed=true;p.locationCode=matches[0];}}
  if(renamed)after.placements=encode(placements);
  clause+=" AND COALESCE((SELECT value FROM settings WHERE key='warehouse_zones'),'')=? AND COALESCE((SELECT value FROM settings WHERE key=?),'')=?";
  bindings.push(zone?.value??'',LOCATION_ALIASES_KEY,alias?.value??'');
 }
 return commit('restore',body,user,current,after,clause,bindings,op.id);
}
export async function listCartons(){const rows=await getDb().select().from(cartonReceipts).orderBy(desc(cartonReceipts.createdAt));const ops=await getDb().select().from(cartonOperations);return projectCartonRows(rows,ops).map(cartonView);}
export async function listCartonOperations(){const ops=await getDb().select().from(cartonOperations).orderBy(desc(cartonOperations.createdAt));return ops;}
export async function cartonUndoStates(logs:(typeof auditLogs.$inferSelect)[],user:User){const map=new Map<number,{canRestore:boolean;restoreReason:string}>();for(const log of logs){if(!log.operationId||log.entityType!=='箱件收货')continue;const op=await operationById(log.operationId);if(!op)continue;const row=await rowById(op.receiptId),permitted=hasPermission(user,'stock.restore')&&operationPermitted(op,user),safe=!op.restoredAt&&op.kind!=='restore'&&!!row&&await matchesRestorableState(op,row);map.set(log.id,{canRestore:safe&&permitted,restoreReason:!permitted?'无撤销权限':op.restoredAt?'已撤销':safe?'':'箱件已有后续变更'});}return map;}
export async function restoreCartonAudit(log:typeof auditLogs.$inferSelect,user:User){if(log.entityType!=='箱件收货'||!log.operationId)return null;const op=await operationById(log.operationId),row=op?await rowById(op.receiptId):null;if(!row)throw new GoodsFlowError('箱件记录不存在，无法撤销',409);return Response.json(await restoreCarton({requestId:crypto.randomUUID(),operationId:log.operationId,expectedVersion:row.version},user));}
export {goodsResponseError as cartonResponseError};

export {mutable as cartonMutable,guard as cartonGuard,rowById as cartonRowById,replay as cartonReplay,uuid as cartonUuid};

/** Pure preparation: caller commits all product/carton statements in ONE transaction. */
export async function prepareCartonDocumentOutbound(body:Record<string,unknown>,user:User,simulated?:Row,simulatedRows?:Map<string,Row>){
 const before=simulated??await mutable({...body,id:body.receiptId});
 // The document keeps its original effective shares while guards follow earlier writes in the same batch.
 if(simulatedRows?.size){const all=await getDb().select().from(cartonReceipts);withCartonProjectionPeers(before,all.map(r=>simulatedRows.has(r.id)?persistedCartonRow(simulatedRows.get(r.id)!):r));}
 const outboundDate=date(body.outboundDate,'出库日期');
 if(before.id!==body.receiptId)throw new GoodsFlowError('箱库存来源不一致',400);
 if(!Array.isArray(body.picks)||!body.picks.length||body.picks.length>100)throw new GoodsFlowError('请填写1至100条箱库存分配',400);
 if(goodsInteger(body.quantity??0,'出库件数')!==0)throw new GoodsFlowError('箱库存只按箱数出库',400);
 const placements=JSON.parse(before.placements) as CartonPlacement[],keys=new Set<string>();let total=0;
 for(const raw of body.picks){if(!raw||typeof raw!=='object')throw new GoodsFlowError('箱库存分配无效',400);const pick=raw as Record<string,unknown>,key=clean(pick.key,'分配标识',100,true),boxes=goodsInteger(pick.boxes,'出库箱数',1),target=placements.find(p=>p.key===key);
 if(keys.has(key)||!target||boxes>target.boxes)throw new GoodsFlowError('箱库存出库超过可用箱数或分配重复',400);keys.add(key);
 const detail=cartonPlacementDetails(cartonView(before),target);if(body.product!==undefined&&body.product!==detail.product||body.sku!==undefined&&body.sku!==detail.sku)throw new GoodsFlowError('箱库存产品资料已变化，请刷新核对',409);if(body.customerName!==undefined&&body.customerName!==detail.customerName)throw new GoodsFlowError('箱库存商家已变化，请刷新核对',409);
 if(outboundDate<detail.inboundDate)throw new GoodsFlowError('出库日期不能早于箱库存入库日期',400);
 const current=cartonPalletCount(target),picked=pallets(pick.pallets);if(palletCountExceeds(picked,current))throw new GoodsFlowError('出库托盘数超过箱库存现有托盘数',400);
 target.boxes-=boxes;if(target.boxes===0||picked>0){Object.assign(target,fixedCartonPlacement(target,target.boxes===0?0:palletRemaining(current,picked)));delete target.palletProjection;delete target.palletAutomatic;}total+=boxes;}
 if(goodsInteger(body.boxes,'出库总箱数',1)!==total)throw new GoodsFlowError('箱库存分配合计与总箱数不一致',400);
 const after={...before,placements:encode(placements),version:before.version+1,updatedAt:new Date().toISOString(),updatedBy:user.id},plan=cartonCommitPlan('outbound',{...body,id:body.receiptId},user,before,after);
 return {...plan,after:{...after,palletRawPlacements:persistedCartonRow(after).placements},result:{...plan.result,kind:'carton',receiptId:before.id,quantity:0,boxes:total,outboundDate,outboundOrder:clean(body.outboundOrder??'','出库单号',200)}};
}
