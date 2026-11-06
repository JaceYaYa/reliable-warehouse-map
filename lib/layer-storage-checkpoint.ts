import {getDb} from '../db';
import {remapSnapshotLocations,resolveLocationAlias,type LocationAliases} from './location-aliases';

export type LayerStorageCheckpoint={id:1;capturedAt:string;value:string;auditHighId:number};
type Row=Record<string,unknown>;
const fail=():never=>{throw new Error('托层占用基线资料不完整或格式不正确');};
const integer=(value:unknown,min=0)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=min;
const text=(value:unknown,required=false)=>typeof value==='string'&&(!required||!!value.trim());
function object(value:unknown,required:string[],optional:string[]=[]):Row{
 if(!value||typeof value!=='object'||Array.isArray(value))return fail();
 const row=value as Row;
 if(required.some(key=>!Object.prototype.hasOwnProperty.call(row,key))||Object.keys(row).some(key=>![...required,...optional].includes(key)))return fail();
 for(const key in row)if(!Object.prototype.hasOwnProperty.call(row,key))return fail();
 return row;
}
function placements(raw:unknown){
 if(typeof raw!=='string')return fail();
 let rows:unknown;try{rows=JSON.parse(raw);}catch{return fail();}
 if(!Array.isArray(rows))return fail();
 const keys=new Set<string>();
 for(const value of rows){
  const row=object(value,['key','locationCode','layerCount','boxes','marker'],['palletCount','palletManual','note','product','details']);
  if(!text(row.key,true)||keys.has(String(row.key))||!text(row.locationCode,true)||!integer(row.layerCount,1)||!integer(row.boxes)||!text(row.marker)||(row.note!==undefined&&!text(row.note))||(row.palletCount!==undefined&&(typeof row.palletCount!=='number'||!Number.isFinite(row.palletCount)||row.palletCount<0)))return fail();
  if(row.palletManual!==undefined&&typeof row.palletManual!=='boolean')return fail();
  keys.add(String(row.key));
  if(row.product!==undefined){const p=object(row.product,['key','name','sku','customerName']);if(!text(p.key,true)||!text(p.name,true)||!text(p.sku)||!text(p.customerName))return fail();}
  if(row.details!==undefined){const d=object(row.details,[],['product','sku','customerName','inboundDate','inboundSource','productCondition','inboundOrder','barcodes']);for(const [key,value] of Object.entries(d))if(key==='barcodes'?!Array.isArray(value)||value.some(v=>!text(v)):!text(value))return fail();}
 }
 return rows;
}
export function parseLayerStorageCheckpoint(value:unknown):LayerStorageCheckpoint{
 const row=object(value,['id','capturedAt','value','auditHighId']);
 if(row.id!==1||!integer(row.auditHighId)||typeof row.value!=='string'||typeof row.capturedAt!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(row.capturedAt)||!Number.isFinite(Date.parse(row.capturedAt))||new Date(row.capturedAt).toISOString().slice(0,19)!==row.capturedAt.slice(0,19))return fail();
 let raw:unknown;try{raw=JSON.parse(row.value);}catch{return fail();}
 const snapshot=object(raw,['schemaVersion','stocks','cartons'],['palletSchemaVersion']);
 if(snapshot.palletSchemaVersion!==undefined&&snapshot.palletSchemaVersion!==1)return fail();
 if(snapshot.schemaVersion!==1||!Array.isArray(snapshot.stocks)||!Array.isArray(snapshot.cartons))return fail();
 const stockIds=new Set<number>(),cartonIds=new Set<string>();
 for(const value of snapshot.stocks){const stock=object(value,['id','locationCode','layerCount','customerName','inboundDate','product','sku','totalQuantity','totalBoxes'],['palletCount','palletManual']);if(stock.palletCount!==undefined&&(typeof stock.palletCount!=='number'||!Number.isFinite(stock.palletCount)||stock.palletCount<0)||stock.palletManual!==undefined&&typeof stock.palletManual!=='boolean')return fail();if(!integer(stock.id,1)||stockIds.has(Number(stock.id))||!text(stock.locationCode,true)||!integer(stock.layerCount,1)||!text(stock.customerName)||!text(stock.inboundDate)||!text(stock.product)||!text(stock.sku)||!integer(stock.totalQuantity)||!integer(stock.totalBoxes))return fail();stockIds.add(Number(stock.id));}
 for(const value of snapshot.cartons){const carton=object(value,['id','inboundOrder','customerName','inboundDate','placements','note']);if(!text(carton.id,true)||cartonIds.has(String(carton.id))||!text(carton.inboundOrder)||!text(carton.customerName)||!text(carton.inboundDate)||!text(carton.note))return fail();placements(carton.placements);cartonIds.add(String(carton.id));}
 return {id:1,capturedAt:row.capturedAt,value:row.value,auditHighId:row.auditHighId as number};
}
export function validateLayerStorageCheckpointBackup(data:{layerStorageCheckpoints?:unknown}){
 if(!Array.isArray(data.layerStorageCheckpoints)||data.layerStorageCheckpoints.length!==1)return fail();
 return data.layerStorageCheckpoints.map(parseLayerStorageCheckpoint);
}
export function remapLayerStorageCheckpoint(value:unknown,aliases:LocationAliases):LayerStorageCheckpoint{
 const row=parseLayerStorageCheckpoint(value);
 if(!Object.keys(aliases).length)return row;
 const snapshot=JSON.parse(row.value);
 snapshot.stocks=snapshot.stocks.map((stock:Row)=>({...stock,locationCode:resolveLocationAlias(String(stock.locationCode),aliases)}));
 snapshot.cartons=snapshot.cartons.map((carton:Row)=>({...carton,placements:remapSnapshotLocations(String(carton.placements),aliases)}));
 return parseLayerStorageCheckpoint({...row,value:JSON.stringify(snapshot)});
}
/** Same single-statement capture used by migration, after restoring a legacy backup. */
export const CAPTURE_LAYER_STORAGE_CHECKPOINT_SQL=`INSERT OR IGNORE INTO layer_storage_checkpoints(id,captured_at,value,audit_high_id)
SELECT 1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),
 json_object('schemaVersion',1,'palletSchemaVersion',1,
  'stocks',json((SELECT COALESCE(json_group_array(json_object('id',id,'locationCode',location_code,'layerCount',layer_count,'customerName',customer_name,'inboundDate',inbound_date,'product',product,'sku',sku,'totalQuantity',total_quantity,'totalBoxes',total_boxes,'palletCount',pallet_count,'palletManual',json(CASE
   WHEN (SELECT value FROM settings WHERE key='pallet_manual:stock:'||s.id) IN ('true','false') THEN (SELECT value FROM settings WHERE key='pallet_manual:stock:'||s.id)
   WHEN pallet_count!=1 THEN 'true'
   WHEN EXISTS(SELECT 1 FROM audit_logs a WHERE a.action='库存修改' AND json_valid(a.before_snapshot) AND json_valid(a.after_snapshot) AND json_extract(a.after_snapshot,'$.id')=s.id AND json_type(a.before_snapshot,'$.palletCount') IN ('integer','real') AND json_type(a.after_snapshot,'$.palletCount') IN ('integer','real') AND json_extract(a.before_snapshot,'$.palletCount')!=json_extract(a.after_snapshot,'$.palletCount')) THEN 'true'
   ELSE 'false' END))),'[]') FROM (SELECT * FROM stocks ORDER BY id) s)),
  'cartons',json((SELECT COALESCE(json_group_array(json_object('id',id,'inboundOrder',inbound_order,'customerName',customer_name,'inboundDate',inbound_date,'placements',printf('%s',(SELECT COALESCE(json_group_array(json_set(p.value,'$.palletManual',json(CASE
   WHEN json_type(p.value,'$.palletManual') IN ('true','false') THEN CASE WHEN json_extract(p.value,'$.palletManual') THEN 'true' ELSE 'false' END
   WHEN COALESCE(json_extract(p.value,'$.palletCount'),1)!=1 THEN 'true'
   WHEN EXISTS(SELECT 1 FROM carton_operations o,json_each(CASE WHEN json_valid(o.before_snapshot) THEN json_extract(o.before_snapshot,'$.placements') ELSE '[]' END) b,json_each(CASE WHEN json_valid(o.after_snapshot) THEN json_extract(o.after_snapshot,'$.placements') ELSE '[]' END) a
    WHERE o.receipt_id=c.id AND o.restored_at IS NULL AND o.kind IN ('details','correction') AND json_extract(b.value,'$.key')=json_extract(p.value,'$.key') AND json_extract(a.value,'$.key')=json_extract(p.value,'$.key') AND json_type(b.value,'$.palletProjection') IS NULL AND json_type(b.value,'$.palletCount') IN ('integer','real') AND json_type(a.value,'$.palletCount') IN ('integer','real') AND json_extract(b.value,'$.palletCount')!=json_extract(a.value,'$.palletCount')) THEN 'true'
   ELSE 'false' END))),'[]') FROM json_each(c.placements) p)),'note',note)),'[]') FROM (SELECT * FROM carton_receipts ORDER BY id) c))
 ),COALESCE((SELECT MAX(id) FROM audit_logs),0)
WHERE NOT EXISTS (SELECT 1 FROM layer_storage_checkpoints WHERE id=1)`;

/** Capture documentary facts lazily; never rewrite inventory or an existing checkpoint. */
export async function ensureLayerStorageCheckpoint(){
 const client=getDb().$client;
 const lookup=client.prepare('SELECT captured_at AS capturedAt FROM layer_storage_checkpoints WHERE id=1');
 const existing=await lookup.first<{capturedAt:string}>();
 if(existing)return existing;
 await client.prepare(CAPTURE_LAYER_STORAGE_CHECKPOINT_SQL).run();
 return lookup.first<{capturedAt:string}>();
}
