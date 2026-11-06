import {validateStagingLayerPricingOrigins,type StagingLayerPricingOrigin} from './staging-layer-pricing';
import {env} from 'cloudflare:workers';
import {and,eq,isNull,asc} from 'drizzle-orm';
import {getDb} from '../db';
import {goodsOperations,settings} from '../db/schema';
import {GoodsFlowError,goodsInteger,materializeGoods,assertGoodsBalance,parseGoodsState,goodsChoices,type GoodsStock,type GoodsState} from './goods-flow';
import {goodsPalletModeWrites,goodsFinish,goodsGuard,goodsIdempotency,goodsOperation,goodsStockInsert,goodsStockUpdate,goodsStateUpdate,loadGoodsContext} from './goods-store';
import {parseAssociationState} from './inventory-associations';
import {loadLocationAliases} from './location-alias-store';
import {resolveLocationAlias,parseLocationAliases,LOCATION_ALIASES_KEY} from './location-aliases';
import {locationCodeKey} from './location-code';
import {mergeRequiredWarehouseZones,type WarehouseZoneRecord} from './warehouse-layout';
import {palletCountValue,palletCountExceeds,palletCountsEqual,palletRemaining,palletLabel} from './pallet';
type Context=Awaited<ReturnType<typeof loadGoodsContext>>;
type Operation=typeof goodsOperations.$inferSelect;
export type StagingTask={id:string;lineId:string;outboundOrder:string;product:string;customerName:string;key:string;stagedAt:string;members:GoodsStock[];quantity:number;boxes:number};
type SavedTask=Omit<StagingTask,'members'>&{stockIds:number[]};
const text=(raw:unknown,label:string,max=500)=>{if(typeof raw!=='string'||raw.trim().length>max)throw new GoodsFlowError(`${label}格式不正确`,400);return raw.trim();};
const positive=(s:GoodsStock)=>s.totalQuantity>0||s.totalBoxes>0;
export const loadActiveStagingOperations=()=>getDb().select().from(goodsOperations).where(and(eq(goodsOperations.kind,'staging'),isNull(goodsOperations.restoredAt))).orderBy(asc(goodsOperations.createdAt),asc(goodsOperations.id));

/** Validate persisted task identities and conservation before backup or exact undo. */
export function validateStagingOperation(op:{id?:string;beforeCategory:string|null;afterCategory:string;beforeRows:string;afterRows:string;result:string}){
 const fail=()=>{throw new GoodsFlowError('待出库移库记录不完整，请核对备份',400);};
 const result=JSON.parse(op.result),before=JSON.parse(op.beforeRows),after=JSON.parse(op.afterRows);
 if(!op.beforeCategory||!result||result.staging!==true||(op.id!==undefined&&result.operationId!==op.id)||!Array.isArray(result.tasks)||!result.tasks.length||result.tasks.length>25||!Array.isArray(before)||!before.length||!Array.isArray(after))fail();
 parseGoodsState(op.beforeCategory!);parseGoodsState(op.afterCategory);
 const ids=new Set<number>(),sourceIds=new Set<number>();for(const s of before){if(!Number.isSafeInteger(s.id)||sourceIds.has(s.id))fail();sourceIds.add(s.id);}
 const afterIds=new Set<number>();for(const s of after){if(!Number.isSafeInteger(s.id)||afterIds.has(s.id))fail();afterIds.add(s.id);}
 for(const s of [...before,...after])for(const field of ['totalQuantity','totalBoxes'])if(!Number.isSafeInteger(s[field])||s[field]<0)fail();
 for(const s of [...before,...after])if(typeof s.palletCount!=='number'||!Number.isFinite(s.palletCount)||s.palletCount<0||s.palletCount>Number.MAX_SAFE_INTEGER)fail();
 const taskIds=new Set<string>();for(const task of result.tasks){if(!task||typeof task.id!=='string'||!task.id||taskIds.has(task.id)||typeof task.lineId!=='string'||!task.lineId||typeof task.outboundOrder!=='string'||!Array.isArray(task.stockIds)||!task.stockIds.length)fail();taskIds.add(task.id);for(const id of task.stockIds){if(!Number.isSafeInteger(id)||id<=0||ids.has(id)||sourceIds.has(id)||!afterIds.has(id))fail();ids.add(id);}for(const [field,rowField]of[['quantity','totalQuantity'],['boxes','totalBoxes']])if(!Number.isSafeInteger(task[field])||task[field]<0||task[field]!==after.filter((s:GoodsStock)=>task.stockIds.includes(s.id)).reduce((n:number,s:GoodsStock)=>n+Number(s[rowField as keyof GoodsStock]),0))fail();if(!task.quantity&&!task.boxes)fail();if(!Array.isArray(task.members)||JSON.stringify(task.members)!==JSON.stringify(after.filter((s:GoodsStock)=>task.stockIds.includes(s.id))))fail();}
 if(after.some((s:GoodsStock)=>!sourceIds.has(s.id)&&!ids.has(s.id))||[...sourceIds].some(id=>!afterIds.has(id)))fail();
 for(const field of ['totalQuantity','totalBoxes'])if(before.reduce((n:number,s:GoodsStock)=>n+Number(s[field as keyof GoodsStock]),0)!==after.reduce((n:number,s:GoodsStock)=>n+Number(s[field as keyof GoodsStock]),0))fail();
 if(!palletCountsEqual(before.reduce((n:number,s:GoodsStock)=>n+s.palletCount,0),after.reduce((n:number,s:GoodsStock)=>n+s.palletCount,0)))fail();
 if(Object.hasOwn(result,'layerPricingOrigins')){try{validateStagingLayerPricingOrigins(result,op.beforeRows,op.afterRows,String(result.operationId));}catch{fail();}}
 return result as {staging:true;tasks:SavedTask[]};
}

function deriveTasks(context:Context,operations:Operation[],legacyLocation='待出库'){
 const tasks:StagingTask[]=[],claimed=new Set<number>();
 const choices=goodsChoices(context.rows,parseAssociationState(context.associationValue),context.state,true);
 const add=(saved:Omit<SavedTask,'stockIds'|'quantity'|'boxes'>,members:GoodsStock[])=>{
  const groups=choices.flatMap(choice=>{const own=members.filter(row=>choice.members.some(s=>s.id===row.id));return own.length?[{choice,own}]:[];});
  for(const{choice,own}of groups){tasks.push({...saved,id:groups.length>1?`${saved.id}:${choice.key}`:saved.id,product:choice.product,customerName:choice.customerName,key:choice.key,members:own,quantity:own.reduce((n,s)=>n+s.totalQuantity,0),boxes:own.reduce((n,s)=>n+s.totalBoxes,0)});}
 };
 for(const op of operations){const data=validateStagingOperation(op);for(const task of data.tasks){const members=context.rows.filter(s=>task.stockIds.includes(s.id)&&positive(s)&&!claimed.has(s.id));members.forEach(s=>claimed.add(s.id));if(members.length)add(task,members);}}
 // Only the pre-existing dedicated location is a legacy task. Arbitrary similar names never imply ownership.
 for(const choice of choices){const members=choice.members.filter(s=>s.locationCode===legacyLocation&&positive(s)&&!claimed.has(s.id));if(members.length)add({id:`legacy:${choice.key}`,lineId:`legacy:${choice.key}`,outboundOrder:'',product:choice.product,customerName:choice.customerName,key:choice.key,stagedAt:''},members);}
 return tasks;
}
export async function loadStagingTasks(context?:Context):Promise<StagingTask[]>{const current=context??await loadGoodsContext(),[operations,aliases]=await Promise.all([loadActiveStagingOperations(),loadLocationAliases()]);return deriveTasks(current,operations,resolveLocationAlias('待出库',aliases));}
export async function activeStagingStockIds():Promise<Set<number>>{return new Set((await loadStagingTasks()).flatMap(t=>t.members.map(s=>s.id)));}
export function publicStagingTasks(tasks:StagingTask[],pricing:boolean){return tasks.map(t=>({...t,members:t.members.map(s=>{const{storageRateUsd,freeDays,...safe}=s;return pricing?s:safe;})}));}

export async function stageGoods(body:Record<string,unknown>,user:{id:number;displayName:string}){
 const idem=await goodsIdempotency(body.requestId,{...body,actorId:user.id});
 if(idem.replayed)return{result:idem.replayed,tasks:idem.replayed.tasks as StagingTask[]};
 try{
 const context=await loadGoodsContext();if(body.expectedRevision!==context.stored.revision)throw new GoodsFlowError('库存列表已变化，请刷新核对；填写仍保留');
 if(!Array.isArray(body.lines)||!body.lines.length||body.lines.length>25)throw new GoodsFlowError('请选择 1 至 25 项待出库货物',400);
 const layer=goodsInteger(body.targetLayerCount,'目标层数',1),requested=text(body.targetLocation,'目标库位');
 const db=getDb(),[zoneRows,aliasRows]=await db.batch([db.select().from(settings).where(eq(settings.key,'warehouse_zones')),db.select().from(settings).where(eq(settings.key,LOCATION_ALIASES_KEY))]),zone=zoneRows[0],aliasRow=aliasRows[0];if(!zone)throw new GoodsFlowError('库位资料不存在，请先检查库位');
 let zones:WarehouseZoneRecord[];try{zones=JSON.parse(zone.value);if(!Array.isArray(zones))throw Error();}catch{throw new GoodsFlowError('库位资料异常，请先检查库位',500);}
 const aliases=parseLocationAliases(aliasRow?.value),resolved=resolveLocationAlias(requested,aliases),matches=mergeRequiredWarehouseZones(zones).flatMap(z=>z.codes).filter(code=>locationCodeKey(code)===locationCodeKey(resolved));if(matches.length!==1)throw new GoodsFlowError('目标库位不存在或有重复，请重新选择',400);
 const operations=await loadActiveStagingOperations(),pending=new Set(deriveTasks(context,operations,resolveLocationAlias('待出库',aliases)).flatMap(t=>t.members.map(s=>s.id)));
 const stamp=new Date().toISOString(),next=structuredClone(context.state),working=context.rows.map(r=>({...r})),sources=new Map<number,GoodsStock>(),created:GoodsStock[]=[],layerPricingOrigins:StagingLayerPricingOrigin[]=[],tasks:SavedTask[]=[],lineIds=new Set<string>(),affectedCategories=new Set<string>();let highId=Math.max(0,...context.rows.map(s=>s.id));
 for(const raw of body.lines){
  if(!raw||typeof raw!=='object')throw new GoodsFlowError('待出库货物行无效',400);const line=raw as Record<string,unknown>,lineId=text(line.lineId,'任务编号',120);if(!lineId||lineIds.has(lineId))throw new GoodsFlowError('任务编号缺失或重复',400);lineIds.add(lineId);
  const choice=context.choices.find(c=>c.key===line.key);if(!choice)throw new GoodsFlowError('所选货物已变化，请刷新核对');
  let category=choice.categoryId?next.categories.find(c=>c.id===choice.categoryId):next.categories.find(c=>c.stockIds.some(id=>choice.members.some(s=>s.id===id)));
  if(!category){category=materializeGoods(choice,stamp,{allowPendingIdentity:true});next.categories.push(category);}assertGoodsBalance(category,working);affectedCategories.add(category.id);
  const quantity=goodsInteger(line.quantity,'本次备货件数'),boxes=goodsInteger(line.boxes,'本次备货箱数');if(!quantity&&!boxes)throw new GoodsFlowError('请填写大于 0 的备货件数或箱数',400);
  if(!Array.isArray(line.selected)||!line.selected.length)throw new GoodsFlowError('请选择备货的实物库位',400);
  const selected=new Set<number>(),targetIds:number[]=[];let allocatedQ=0,allocatedB=0;
  for(const entry of line.selected){
   if(!entry||typeof entry!=='object')throw new GoodsFlowError('实物分配无效',400);const ref=entry as Record<string,unknown>,id=goodsInteger(ref.id,'货物编号',1),original=context.rows.find(s=>s.id===id),current=working.find(s=>s.id===id);
   if(selected.has(id)||!original||!current||!choice.members.some(s=>s.id===id))throw new GoodsFlowError('所选库位重复或不属于这项货物',400);selected.add(id);
   if(original.version!==ref.version)throw new GoodsFlowError('所选库位库存已变化，请刷新核对');if(pending.has(id))throw new GoodsFlowError('这条货物已经移库待出库，请从待出库任务继续操作');
   const q=goodsInteger(ref.quantity,'库位备货件数'),b=goodsInteger(ref.boxes,'库位备货箱数');if(!q&&!b)throw new GoodsFlowError('每处备货分配必须有件数或箱数',400);if(q>current.totalQuantity||b>current.totalBoxes)throw new GoodsFlowError(`${current.locationCode} 可用库存不足，本次未移动`,400);if(current.inventoryUnit==='box'&&q)throw new GoodsFlowError('独立箱库存不填写件数',400);
   const requestedPallets=palletCountValue(ref.pallets);
   if(!Number.isFinite(requestedPallets)||palletCountExceeds(requestedPallets,current.palletCount))throw new GoodsFlowError(`${current.locationCode} 备货托盘数无效或超过可用托盘数`,400);
   const full=q===current.totalQuantity&&b===current.totalBoxes,movedPallets=full||palletCountsEqual(requestedPallets,current.palletCount)?current.palletCount:requestedPallets;
   if(!sources.has(id))sources.set(id,{...original});current.totalQuantity-=q;current.totalBoxes-=b;current.palletCount=palletRemaining(current.palletCount,movedPallets);current.palletLabel=palletLabel(current.palletCount);current.version=original.version+1;current.updatedAt=stamp;current.updatedBy=user.displayName;
   if(created.length>=100)throw new GoodsFlowError('每次备货最多分配 100 条库位记录',400);
   const target={...original,id:++highId,locationCode:matches[0],layerCount:layer,totalQuantity:q,totalBoxes:b,palletCount:movedPallets,palletLabel:palletLabel(movedPallets),updatedAt:stamp,updatedBy:user.displayName,version:0};layerPricingOrigins.push({stockId:target.id,sourceStockId:original.id,locationCode:original.locationCode,layer:original.layerCount,targetLocationCode:target.locationCode,targetLayer:target.layerCount,target:{locationCode:target.locationCode,layer:target.layerCount},stagedAt:stamp,operationId:idem.id});created.push(target);working.push(target);category.stockIds.push(target.id);targetIds.push(target.id);allocatedQ+=q;allocatedB+=b;
  }
  if(allocatedQ!==quantity||allocatedB!==boxes)throw new GoodsFlowError('库位分配合计与本次备货数量不一致',400);assertGoodsBalance(category,working);
  tasks.push({id:`${idem.id}:${lineId}`,lineId,outboundOrder:line.outboundOrder===undefined?'':text(line.outboundOrder,'出库单号'),product:choice.product,customerName:choice.customerName,key:`category:${category.id}`,stagedAt:stamp,stockIds:targetIds,quantity,boxes});
 }
 const beforeRows=[...sources.values()],afterRows=[...beforeRows.map(s=>working.find(r=>r.id===s.id)!),...created];for(const category of next.categories.filter(c=>affectedCategories.has(c.id)))assertGoodsBalance(category,working);
 for(const row of afterRows){row.palletAutomatic=false;row.palletManual=true;row.palletRawCount=row.palletCount;row.palletRawLabel=row.palletLabel;}
 const result={ok:true,operationId:idem.id,staging:true,targetLocation:matches[0],targetLayerCount:layer,associationValue:context.associationValue,layerPricingOrigins,tasks:tasks.map(t=>({...t,members:created.filter(s=>t.stockIds.includes(s.id))}))};
 validateStagingOperation({beforeCategory:JSON.stringify(context.state),afterCategory:JSON.stringify(next),beforeRows:JSON.stringify(beforeRows),afterRows:JSON.stringify(afterRows),result:JSON.stringify(result)});
 const expectedOps=operations.map(op=>({id:op.id,result:op.result,afterRows:op.afterRows}));
 const pendingGuard=env.DB.prepare("INSERT INTO goods_transaction_guards(id,valid) VALUES (?,CASE WHEN (SELECT COUNT(*) FROM goods_operations WHERE kind='staging' AND restored_at IS NULL)=? AND NOT EXISTS(SELECT 1 FROM json_each(?) j LEFT JOIN goods_operations o ON o.id=json_extract(j.value,'$.id') WHERE o.id IS NULL OR o.restored_at IS NOT NULL OR o.result<>json_extract(j.value,'$.result') OR o.after_rows<>json_extract(j.value,'$.afterRows')) THEN 1 ELSE 0 END)").bind(`${idem.id}:staging`,operations.length,JSON.stringify(expectedOps));
 const zoneGuard=env.DB.prepare("INSERT INTO goods_transaction_guards(id,valid) VALUES (?,CASE WHEN EXISTS(SELECT 1 FROM settings WHERE key='warehouse_zones' AND value=?) AND COALESCE((SELECT value FROM settings WHERE key=?),'')=? THEN 1 ELSE 0 END)").bind(`${idem.id}:zones`,zone.value,LOCATION_ALIASES_KEY,aliasRow?.value??'');
 await env.DB.batch([goodsGuard(context,idem.id,{rows:context.rows,highId:Math.max(0,...context.rows.map(s=>s.id)),association:true}),pendingGuard,zoneGuard,...beforeRows.map(s=>goodsStockUpdate(working.find(r=>r.id===s.id)!)),...created.map(goodsStockInsert),...goodsPalletModeWrites(afterRows),goodsStateUpdate(next),goodsOperation({id:idem.id,kind:'staging',categoryId:'',fingerprint:idem.fingerprint,beforeCategory:context.state,afterCategory:next,beforeRows,afterRows,settlementIds:[],result,stamp}),env.DB.prepare('INSERT INTO audit_logs(user_id,user_name,action,entity_type,entity_id,operation_id,summary,before_snapshot,after_snapshot,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').bind(user.id,user.displayName,'移库','待出库',matches[0],idem.id,`移库待出库｜${tasks.length} 项任务｜目标 ${matches[0]} 第 ${layer} 层｜${tasks.reduce((n,t)=>n+t.quantity,0)}件/${tasks.reduce((n,t)=>n+t.boxes,0)}箱｜全仓数量与原计价批次保留，不产生出库费用`,JSON.stringify({schema:'goods-operation-v1',operationId:idem.id,rows:beforeRows}),JSON.stringify({schema:'goods-operation-v1',operationId:idem.id,rows:afterRows}),stamp),goodsFinish(`${idem.id}:zones`),goodsFinish(`${idem.id}:staging`),goodsFinish(idem.id)]);
 const afterContext={...context,state:next,rows:working};return{result,tasks:deriveTasks(afterContext,[{id:idem.id,beforeCategory:JSON.stringify(context.state),afterCategory:JSON.stringify(next),beforeRows:JSON.stringify(beforeRows),afterRows:JSON.stringify(afterRows),result:JSON.stringify(result)} as Operation]).filter(t=>!t.id.startsWith('legacy:'))};
 }catch(error){
  // A concurrent identical request may have committed after our initial lookup or context read.
  const recovered=await goodsIdempotency(body.requestId,{...body,actorId:user.id});if(recovered.replayed)return{result:recovered.replayed,tasks:recovered.replayed.tasks as StagingTask[]};throw error;
 }
}
