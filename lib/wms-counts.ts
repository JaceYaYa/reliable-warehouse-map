import {isProtectedOwnerUsername} from './roles';
import {env} from 'cloudflare:workers';
import {locationCodeKey} from './location-code';
import {mergeRequiredWarehouseZones,type WarehouseZoneRecord} from './warehouse-layout';
import {parseLocationAliases,resolveLocationAlias,LOCATION_ALIASES_KEY} from './location-aliases';
import {warehouseTodayDate} from './warehouse-time';

type Actor={id:number;displayName:string;role:string;username?:string};
const reviewer=(actor:Actor)=>actor.role==='admin'||isProtectedOwnerUsername(actor.username);
export type CountObservation={key:string;pieces:number|null;boxes:number;unit?:'item'|'box';product?:string;customer?:string;barcode?:string};
type SourceRow={key:string;kind:'stock'|'carton';stockId?:number;product:string;customer:string;sku:string;barcode:string;layer:number;marker:string;unit:'item'|'box';pieces:number|null;boxes:number;version?:number;location:string};
type CountRecord={id:string;number:string;location:string;blind:number;status:'draft'|'submitted'|'reviewed'|'cancelled';version:number;source:string;observations:string;conclusion:string;created_by:number;created_name:string;created_at:string;updated_at:string;reviewed_name:string|null;reviewed_at:string|null};
export class CountError extends Error{constructor(message:string,public status=400){super(message)}}
const uuid=(v:unknown)=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const text=(v:unknown,max:number)=>typeof v==='string'&&v.length<=max&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v)?v:null;
const integer=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;

// The same deterministic source query is used in the transaction's CHECK guard.
// Carton receipt changes at a different location do not invalidate these placement facts.
const SOURCE_SQL=`SELECT json_object('rows',json(COALESCE((SELECT json_group_array(json(row)) FROM (
 SELECT json_object('key','stock:'||id,'kind','stock','stockId',id,'product',product,'customer',customer_name,'sku',sku,'barcode',trim(fnsku||' / '||barcode,' /'),'layer',layer_count,'marker',trim(product_condition||' '||product_prefix),'unit',inventory_unit,'pieces',CASE WHEN inventory_unit='box' OR (total_quantity=0 AND total_boxes>0 AND inventory_review_decision='') THEN NULL ELSE total_quantity END,'boxes',total_boxes,'version',version,'location',location_code) AS row,0 AS sort_kind,id AS sort_id,'' AS sort_key FROM stocks WHERE upper(trim(location_code))=?
 UNION ALL
 SELECT json_object('key','carton:'||r.id||':'||json_extract(p.value,'$.key'),'kind','carton','product','箱件 · '||r.inbound_order,'customer',r.customer_name,'sku','','barcode','','layer',json_extract(p.value,'$.layerCount'),'marker',COALESCE(json_extract(p.value,'$.marker'),''),'unit','box','pieces',NULL,'boxes',json_extract(p.value,'$.boxes'),'location',json_extract(p.value,'$.locationCode')) AS row,1 AS sort_kind,r.id AS sort_id,json_extract(p.value,'$.key') AS sort_key FROM carton_receipts r,json_each(r.placements) p WHERE upper(trim(json_extract(p.value,'$.locationCode')))=?
 ORDER BY sort_kind,sort_id,sort_key
)), '[]'))) AS source`;
const sourceStatement=(location:string)=>env.DB.prepare(SOURCE_SQL).bind(locationCodeKey(location),locationCodeKey(location));
async function source(location:string){const r=await sourceStatement(location).first<{source:string}>();if(!r?.source)throw new CountError('盘点库存暂时无法读取',503);return r.source;}
const rows=(raw:string):SourceRow[]=>JSON.parse(raw).rows;
const record=(id:string)=>env.DB.prepare('SELECT * FROM wms_counts WHERE id=?').bind(id).first<CountRecord>();
async function canonicalLocation(raw:unknown){if(!text(raw,128)||!String(raw).trim())throw new CountError('请选择实际库位');const result=await env.DB.prepare('SELECT key,value FROM settings WHERE key IN (?,?)').bind('warehouse_zones',LOCATION_ALIASES_KEY).all<{key:string;value:string}>();const values=result.results||[],zones=mergeRequiredWarehouseZones(JSON.parse(values.find(r=>r.key==='warehouse_zones')?.value||'[]') as WarehouseZoneRecord[]),aliases=parseLocationAliases(values.find(r=>r.key===LOCATION_ALIASES_KEY)?.value);const key=locationCodeKey(resolveLocationAlias(String(raw),aliases)),matches=zones.flatMap(z=>z.codes).filter(c=>locationCodeKey(c)===key);if(matches.length!==1)throw new CountError('库位不存在或名称有冲突，请先核对库位图');return matches[0];}

function observations(raw:unknown,expected:SourceRow[]):CountObservation[]{
 if(!Array.isArray(raw)||raw.length>400)throw new CountError('请填写完整的实盘记录');
 const seen=new Set<string>(),result:CountObservation[]=[];
 for(const value of raw){if(!value||typeof value!=='object'||typeof value.key!=='string'||seen.has(value.key))throw new CountError('实盘记录重复或格式不正确');seen.add(value.key);const match=expected.find(r=>r.key===value.key),extra=value.key.startsWith('extra:')&&uuid(value.key.slice(6));if(!match&&!extra)throw new CountError('实盘记录不属于本盘点库位');const unit=match?.unit||value.unit;if(!['item','box'].includes(unit)||!integer(value.boxes)||(unit==='item'?!integer(value.pieces):value.pieces!==null))throw new CountError('件数和箱数必须明确填写非负整数，空白不能当作0；箱库存不填写件数');const line:CountObservation={key:value.key,pieces:unit==='box'?null:value.pieces,boxes:value.boxes};if(extra){const product=text(value.product,128),customer=text(value.customer,128),barcode=text(value.barcode,256);if(product===null||customer===null||barcode===null||(!product?.trim()&&!barcode?.trim()))throw new CountError('未登记货物请填写品名或原始条码，未知客户可以留空');Object.assign(line,{unit,product,customer,barcode});}result.push(line);}
 if(expected.some(r=>!seen.has(r.key)))throw new CountError('还有货物未填写实盘数量');return result;
}

export async function countDto(task:CountRecord,actor:Actor,detail=true){
 const stale=(task.status==='draft'||task.status==='submitted')&&await source(task.location)!==task.source;
 const summary={id:task.id,number:task.number,location:task.location,blind:!!task.blind,status:task.status,version:task.version,createdBy:task.created_name,createdAt:task.created_at,updatedAt:task.updated_at,conclusion:task.conclusion,reviewedBy:task.reviewed_name,reviewedAt:task.reviewed_at,stale,rowCount:rows(task.source).length,canSubmit:task.created_by===actor.id||reviewer(actor),canReview:reviewer(actor)};
 if(!detail)return summary;
 const show=!task.blind||task.status==='reviewed'||task.status==='submitted'&&reviewer(actor),entered=JSON.parse(task.observations) as CountObservation[];
 const lines=rows(task.source).map(r=>{const actual=entered.find(x=>x.key===r.key);return {key:r.key,kind:r.kind,stockId:r.stockId,product:r.product,customer:r.customer||'待核对',sku:r.sku,barcode:r.barcode,layer:r.layer,marker:r.marker,unit:r.unit,location:r.location,expectedPieces:show?r.pieces:null,expectedBoxes:show?r.boxes:null,expectedVisible:show,quantityPending:r.unit==='item'&&r.pieces===null,observedPieces:actual?.pieces??null,observedBoxes:actual?.boxes??null,pieceDifference:show&&r.pieces!==null&&actual?.pieces!==null&&actual?.pieces!==undefined?actual.pieces-r.pieces:null,boxDifference:show&&actual?actual.boxes-r.boxes:null};});
 for(const x of entered.filter(x=>x.key.startsWith('extra:')))lines.push({key:x.key,kind:'extra' as never,stockId:undefined,product:x.product||'未登记货物',customer:x.customer||'待核对',sku:'',barcode:x.barcode||'',layer:0,marker:'未登记货物',unit:x.unit!,location:task.location,expectedPieces:null,expectedBoxes:null,expectedVisible:show,quantityPending:true,observedPieces:x.pieces,observedBoxes:x.boxes,pieceDifference:null,boxDifference:null});
 return {...summary,rows:lines};
}
export async function readCounts(actor:Actor,id?:string|null){if(id){if(!uuid(id))throw new CountError('盘点单编号无效');const task=await record(id);if(!task)throw new CountError('盘点单不存在',404);return {report:await countDto(task,actor)};}const list=await env.DB.prepare('SELECT * FROM wms_counts ORDER BY updated_at DESC,id DESC LIMIT 100').all<CountRecord>();return {reports:await Promise.all((list.results||[]).map(t=>countDto(t,actor,false)))};}

export async function changeCount(body:Record<string,unknown>,actor:Actor){
 if(!uuid(body.requestId))throw new CountError('请求编号无效，请刷新后重试');if(!['create','submit','review','cancel'].includes(String(body.action)))throw new CountError('盘点操作无效');
 if(body.action==='review'&&!reviewer(actor))throw new CountError('盘点复核需要管理员账号',403);
 const requestId=body.requestId as string,fingerprint=JSON.stringify(canonical(body));
 const replay=async()=>{const old=await env.DB.prepare('SELECT * FROM wms_count_requests WHERE id=?').bind(requestId).first<{actor_id:number;fingerprint:string;response:string}>();if(!old)return null;if(old.actor_id!==actor.id||old.fingerprint!==fingerprint)throw new CountError('同一请求编号不能更换内容或操作人',409);return JSON.parse(old.response);};
 const existing=await replay();if(existing)return existing;
 const now=new Date().toISOString();let before:CountRecord|null=null,next:CountRecord;
 if(body.action==='create'){
  const location=await canonicalLocation(body.location);if(typeof body.blind!=='boolean')throw new CountError('请选择盘点模式');if(location.trim().toUpperCase()!==locationCodeKey(location))throw new CountError('库位编码存在历史差异，请先统一代码后盘点');const captured=await source(location),items=rows(captured);if(items.length>200)throw new CountError('该库位记录过多，请先整理后盘点');if(items.some(r=>!integer(r.boxes)||(r.pieces!==null&&!integer(r.pieces))))throw new CountError('当前库存数量格式异常，请先核对');
  // Refuse an apparently empty count if historical full-width location aliases hide rows from SQL.
  const all=await env.DB.prepare('SELECT location_code FROM stocks').all<{location_code:string}>();if((all.results||[]).filter(r=>locationCodeKey(r.location_code)===locationCodeKey(location)).length!==items.filter(r=>r.kind==='stock').length)throw new CountError('库位编码存在历史差异，请先统一代码后盘点');
  const cartonLocations=await env.DB.prepare("SELECT json_extract(p.value,'$.locationCode') AS location FROM carton_receipts r,json_each(r.placements) p").all<{location:string}>();if((cartonLocations.results||[]).filter(r=>locationCodeKey(r.location)===locationCodeKey(location)).length!==items.filter(r=>r.kind==='carton').length)throw new CountError('箱件库位编码存在历史差异，请先统一代码后盘点');
  next={id:requestId,number:'PD-'+warehouseTodayDate().replaceAll('-','')+'-'+requestId.slice(0,8),location,blind:body.blind?1:0,status:'draft',version:0,source:captured,observations:'[]',conclusion:'',created_by:actor.id,created_name:actor.displayName,created_at:now,updated_at:now,reviewed_name:null,reviewed_at:null};
 }else{
  if(!uuid(body.id)||!integer(body.expectedVersion))throw new CountError('盘点单编号或版本无效');before=await record(body.id as string);if(!before)throw new CountError('盘点单不存在',404);if(before.version!==body.expectedVersion)throw new CountError('盘点单已更新，请重新读取',409);if(!reviewer(actor)&&before.created_by!==actor.id)throw new CountError('只能提交或取消自己建立的盘点单',403);
  next={...before,version:before.version+1,updated_at:now};
  if(body.action==='submit'){if(before.status!=='draft')throw new CountError('只有未提交的盘点单可以提交',409);next.observations=JSON.stringify(observations(body.observations,rows(before.source)));next.status='submitted';}
  else{const conclusion=text(body.conclusion,1000);if(!conclusion?.trim()||conclusion.trim().length<2)throw new CountError('请填写复核结论或取消原因');next.conclusion=conclusion.trim();if(body.action==='review'){if(before.status!=='submitted')throw new CountError('请先提交实盘数量再复核',409);next.status='reviewed';next.reviewed_name=actor.displayName;next.reviewed_at=now;}else{if(!['draft','submitted'].includes(before.status))throw new CountError('已经完成或取消的盘点单不能再次取消',409);next.status='cancelled';}}
 }
 const result={report:await countDto(next,actor)},needsInventory=body.action!=='cancel';
 if(needsInventory&&await source(next.location)!==next.source)throw new CountError('这个库位的库存已变化，请重新建立盘点单',409);
 const statements=[env.DB.prepare('INSERT INTO wms_count_requests(id,actor_id,fingerprint,response,created_at) VALUES (?,?,?,?,?)').bind(requestId,actor.id,fingerprint,JSON.stringify(result),now)];
 if(before)statements.push(env.DB.prepare('INSERT INTO wms_count_guards(id,valid) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM wms_counts WHERE id=? AND version=? AND status=?) THEN 1 ELSE 0 END').bind(requestId+':version',before.id,before.version,before.status));
 if(needsInventory)statements.push(env.DB.prepare(`INSERT INTO wms_count_guards(id,valid) SELECT ?,CASE WHEN (${SOURCE_SQL})=? THEN 1 ELSE 0 END`).bind(requestId+':source',locationCodeKey(next.location),locationCodeKey(next.location),next.source));
 if(before)statements.push(env.DB.prepare('UPDATE wms_counts SET status=?,version=?,observations=?,conclusion=?,updated_at=?,reviewed_by=?,reviewed_name=?,reviewed_at=? WHERE id=?').bind(next.status,next.version,next.observations,next.conclusion,now,body.action==='review'?actor.id:null,next.reviewed_name,next.reviewed_at,next.id));
 else statements.push(env.DB.prepare('INSERT INTO wms_counts(id,number,location,blind,status,version,source,observations,conclusion,created_by,created_name,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(next.id,next.number,next.location,next.blind,next.status,0,next.source,next.observations,'',actor.id,actor.displayName,now,now));
 const action={create:'盘点建单',submit:'盘点提交',review:'盘点复核',cancel:'取消盘点'}[String(body.action)]!;
 statements.push(env.DB.prepare('INSERT INTO audit_logs(user_id,user_name,action,entity_type,entity_id,operation_id,summary,created_at) VALUES (?,?,?,?,?,?,?,?)').bind(actor.id,actor.displayName,action,'wms_count',next.id,requestId,next.number+' · '+next.location+' · '+(next.conclusion||'仅记录盘点，不修改库存'),now));
 statements.push(env.DB.prepare('DELETE FROM wms_count_guards WHERE id IN (?,?)').bind(requestId+':version',requestId+':source'));
 try{await env.DB.batch(statements);}catch(error){const recovered=await replay();if(recovered)return recovered;throw new CountError('盘点单或库位库存已变化，本次没有提交，请刷新核对后重新盘点',409);}
 return result;
}

function canonical(value:unknown):unknown {if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical((value as Record<string,unknown>)[key])]));return value;}
