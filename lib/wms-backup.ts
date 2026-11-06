import { sql, type SQL } from "drizzle-orm";
import { getDb } from "../db";

type Row = Record<string, unknown>;
export type WmsBackup = { wmsMoveRequests?: unknown; wmsCounts?: unknown; wmsCountRequests?: unknown; users?: unknown };
const uuid = (v: unknown) => typeof v === "string" && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(v);
const integer = (v: unknown, min=0) => Number.isSafeInteger(v) && Number(v)>=min;
const object = (v: unknown): v is Row => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, required=false) => typeof v === "string" && (!required || !!v.trim());
function fail(): never { throw new Error("WMS 盘点或移库请求备份缺失、重复或格式不正确"); }
function parsed(v: unknown): unknown { if(typeof v!=="string")return fail();try{return JSON.parse(v);}catch{return fail();} }
function unique(rows: Row[],key: string){if(new Set(rows.map(r=>r[key])).size!==rows.length)fail();}
const statuses = ["draft","submitted","reviewed","cancelled"];
const quantity = (v: unknown) => v===null || integer(v);
function stock(v: unknown){
  if(!object(v)||!integer(v.id,1)||!text(v.locationCode,true)||!integer(v.totalQuantity)||!integer(v.totalBoxes)||!integer(v.version))fail();
}

/** Validate the entire new section before whole-warehouse restore removes any existing table. */
export function validateWmsBackup(data: WmsBackup) {
  if(!Array.isArray(data.wmsMoveRequests)||!Array.isArray(data.wmsCounts)||!Array.isArray(data.wmsCountRequests))fail();
  const moves=data.wmsMoveRequests as Row[],counts=data.wmsCounts as Row[],requests=data.wmsCountRequests as Row[];
  if([moves,counts,requests].some(list=>list.some(r=>!object(r))))fail();
  unique(moves,'requestId');unique(moves,'operationId');unique(counts,'id');unique(counts,'number');unique(requests,'id');
  // Staff deletion preserves historical operations; a historical actor need not remain an active user.
  const actor=(v:unknown)=>integer(v,1);
  for(const row of moves){
    if(!uuid(row.requestId)||!uuid(row.operationId)||!actor(row.actorId)||!text(row.createdAt,true)||row.responseStatus!==200)fail();
    const intent=parsed(row.fingerprint),result=parsed(row.responseJson);
    if(!object(intent)||!integer(intent.id,1)||!integer(intent.expectedVersion)||!text(intent.targetLocation,true)||!['all','partial'].includes(String(intent.mode)))fail();
    if(!object(result)||result.ok!==true||result.mode!==intent.mode||!object(result.capacity)||(result.warning!==null&&!text(result.warning)))fail();
    stock(result.destination);if(result.mode==='all'){if(result.source!==null)fail();}else stock(result.source);
  }
  for(const row of counts){
    if(!uuid(row.id)||!text(row.number,true)||!text(row.location,true)||![0,1].includes(Number(row.blind))||typeof row.blind!=='number'||!statuses.includes(String(row.status))||!integer(row.version)||!actor(row.createdBy)||!text(row.createdName)||!text(row.createdAt,true)||!text(row.updatedAt,true)||!text(row.conclusion))fail();
    if(row.reviewedBy!==null&&!actor(row.reviewedBy))fail();
    if(row.reviewedName!==null&&!text(row.reviewedName))fail();if(row.reviewedAt!==null&&!text(row.reviewedAt,true))fail();
    if(row.status==='reviewed'&&(!actor(row.reviewedBy)||!text(row.reviewedName,true)||!text(row.reviewedAt,true)))fail();
    const source=parsed(row.source),observations=parsed(row.observations);
    if(!object(source)||!Array.isArray(source.rows)||!Array.isArray(observations)||source.rows.length>200||observations.length>400)fail();
    const sourceRows=source.rows as Row[],entered=observations as Row[];
    if([...sourceRows,...entered].some(r=>!object(r)))fail();unique(sourceRows,'key');unique(entered,'key');
    for(const item of sourceRows){
      if(!text(item.key,true)||!['stock','carton'].includes(String(item.kind))||!['item','box'].includes(String(item.unit))||!quantity(item.pieces)||!integer(item.boxes)||!integer(item.layer,1)||!text(item.location,true)||!['product','customer','sku','barcode','marker'].every(k=>text(item[k])))fail();
      if(item.kind==='stock'&&(!integer(item.stockId,1)||!integer(item.version)))fail();
      if(item.unit==='box'&&item.pieces!==null)fail();
    }
    for(const item of entered){
      const expected=sourceRows.find(r=>r.key===item.key),extra=typeof item.key==='string'&&item.key.startsWith('extra:')&&uuid(item.key.slice(6));
      if(!expected&&!extra)fail();const unit=expected?.unit??item.unit;
      if(!integer(item.boxes)||(unit==='box'?item.pieces!==null:unit!=='item'||!integer(item.pieces)))fail();
      if(extra&&!['product','customer','barcode'].every(k=>text(item[k])))fail();
    }
    if(['submitted','reviewed'].includes(String(row.status))&&sourceRows.some(r=>!entered.some(e=>e.key===r.key)))fail();
  }
  for(const row of requests){
    if(!uuid(row.id)||!actor(row.actorId)||!text(row.createdAt,true))fail();
    const intent=parsed(row.fingerprint),response=parsed(row.response);
    if(!object(intent)||intent.requestId!==row.id||!['create','submit','review','cancel'].includes(String(intent.action)))fail();
    if(!object(response)||!object(response.report))fail();const report=response.report;
    if(!uuid(report.id)||!counts.some(c=>c.id===report.id)||!statuses.includes(String(report.status))||!integer(report.version)||typeof report.blind!=='boolean'||!text(report.location,true))fail();
  }
}

export const moveColumns={requestId:'request_id',actorId:'actor_id',fingerprint:'fingerprint',operationId:'operation_id',responseJson:'response_json',responseStatus:'response_status',createdAt:'created_at'};
export const countColumns={id:'id',number:'number',location:'location',blind:'blind',status:'status',version:'version',source:'source',observations:'observations',conclusion:'conclusion',createdBy:'created_by',createdName:'created_name',createdAt:'created_at',updatedAt:'updated_at',reviewedBy:'reviewed_by',reviewedName:'reviewed_name',reviewedAt:'reviewed_at'};
export const requestColumns={id:'id',actorId:'actor_id',fingerprint:'fingerprint',response:'response',createdAt:'created_at'};
/** Include these selects in the same D1 snapshot batch as inventory and existing tables. */
export function wmsBackupQueries(db: ReturnType<typeof getDb>) {
  const select=(table:string,columns:Record<string,string>)=>db.select(Object.fromEntries(Object.entries(columns).map(([alias,column])=>[alias,sql<string|number|null>`${sql.raw(column)}`])) as Record<string,SQL<string|number|null>>).from(sql.raw(table));
  return [select('wms_move_requests',moveColumns),select('wms_counts',countColumns),select('wms_count_requests',requestColumns)] as const;
}
