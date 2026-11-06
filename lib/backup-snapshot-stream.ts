import {env} from 'cloudflare:workers';
import {getTableColumns,getTableName,type Table} from 'drizzle-orm';
import {stocks,settings,users,auditLogs,pricingCatalogItems,storageFeeSettlements,goodsFlowState,goodsOperations,workOrders,workOrderEvents,workOrderFiles,cartonReceipts,cartonOperations,layerStorageCheckpoints} from '../db/schema';
import {moveColumns,countColumns,requestColumns} from './wms-backup';
import {WAREHOUSE_CORE_RESTORE_LOCK_KEY,WarehouseHistoryImportError} from './warehouse-history-import';

const schemaSections={stocks,settings,users,auditLogs,pricingCatalogItems,storageFeeSettlements,goodsFlowState,goodsOperations,workOrders,workOrderEvents,workOrderFiles,cartonReceipts,cartonOperations};
const identifier=(name:string)=>'"'+name.replaceAll('"','""')+'"';
const literal=(name:string)=>"'"+name.replaceAll("'","''")+"'";
function source(section:string,table:Table){return {section,table:getTableName(table),columns:Object.fromEntries(Object.entries(getTableColumns(table)).map(([alias,column])=>[alias,column.name]))};}
const sources=[...Object.entries(schemaSections).map(([name,table])=>source(name,table)),
 {section:'wmsMoveRequests',table:'wms_move_requests',columns:moveColumns},
 {section:'wmsCounts',table:'wms_counts',columns:countColumns},
 {section:'wmsCountRequests',table:'wms_count_requests',columns:requestColumns},source('layerStorageCheckpoints',layerStorageCheckpoints)];

export type BackupCursor={section:number;cursor:number|null;first:boolean;limit:number};
export const initialBackupCursor=():BackupCursor=>({section:0,cursor:null,first:true,limit:32});
export async function backupRevision(){return Number((await env.DB.prepare('SELECT revision FROM warehouse_backup_revision WHERE id=1').first<{revision:number}>())?.revision??0);}
export async function readBackupPage(position:BackupCursor){
 const {section,table,columns}=sources[position.section];
 const fields=Object.entries(columns).map(([alias,column])=>`data.${identifier(column)} AS ${identifier(alias)}`).join(',');
 const size='4096+6*('+Object.values(columns).map(column=>`COALESCE(length(CAST(${identifier(column)} AS BLOB)),4)`).join('+')+')';
 const conditions=[...(position.cursor===null?[]:['rowid>?']),...(section==='settings'?[`key<>${literal(WAREHOUSE_CORE_RESTORE_LOCK_KEY)}`]:[])];
 const query=`WITH candidates AS MATERIALIZED (SELECT rowid AS _backupCursor,${size} AS _backupBytes FROM ${identifier(table)}${conditions.length?' WHERE '+conditions.join(' AND '):''} ORDER BY rowid LIMIT ${position.limit}),
  chosen AS MATERIALIZED (SELECT _backupCursor FROM (SELECT *,sum(_backupBytes) OVER(ORDER BY _backupCursor) AS _backupTotal,row_number() OVER(ORDER BY _backupCursor) AS _backupPosition FROM candidates) WHERE _backupTotal<=2097152 OR _backupPosition=1)
  SELECT chosen._backupCursor,${fields} FROM chosen JOIN ${identifier(table)} data ON data.rowid=chosen._backupCursor ORDER BY chosen._backupCursor`;
 const prepared=env.DB.prepare(query),page=await (position.cursor===null?prepared:prepared.bind(position.cursor)).all<Record<string,unknown>>();
 let text=position.first?`,${JSON.stringify(section)}:[`:'';
 if(!page.results.length){text+=']';const next={section:position.section+1,cursor:null,first:true,limit:32};return {text,next,done:next.section===sources.length,count:0};}
 let cursor=position.cursor;
 for(const record of page.results){const {_backupCursor,...row}=record,next=Number(_backupCursor);if(!Number.isSafeInteger(next)||(cursor!==null&&next<=cursor))throw new Error('备份分页位置无效');text+=(cursor===null?'':',')+JSON.stringify(row);cursor=next;}
 return {text,next:{...position,cursor,first:false,limit:page.results.length===position.limit?Math.min(512,position.limit*2):Math.max(1,page.results.length)},done:false,count:page.results.length};
}

/** Bounded indexed reads, with NO temporary DB copy. Triggers fence every source
 * mutation, including deletes and restores; a change aborts before publication. */
export async function backupSnapshotStream(createdAt:string){
 const db=env.DB;
 const revision=async()=>Number((await db.prepare('SELECT revision FROM warehouse_backup_revision WHERE id=1').first<{revision:number}>())?.revision??0);
 const before=await revision();
 const unchanged=async()=>{if(await revision()!==before)throw new WarehouseHistoryImportError('备份期间仓储数据发生变化，本次未生成备份，请稍后重试',409);};
 async function* document(){
  yield `{"version":9,"createdAt":${JSON.stringify(createdAt)}`;
  for(const {section,table,columns} of sources){
   yield `,${JSON.stringify(section)}:[`;
   let cursor:number|null=null,first=true,limit=32;
   const fields=Object.entries(columns).map(([alias,column])=>`data.${identifier(column)} AS ${identifier(alias)}`).join(',');
   // Six times raw bytes bounds JSON escaping; also cap rows independently.
   const size='4096+6*('+Object.values(columns).map(column=>`COALESCE(length(CAST(${identifier(column)} AS BLOB)),4)`).join('+')+')';
   for(;;){
    const conditions=[...(cursor===null?[]:['rowid>?']),...(section==='settings'?[`key<>${literal(WAREHOUSE_CORE_RESTORE_LOCK_KEY)}`]:[])];
    // Probe ONLY ids and lengths, then fetch chosen payloads. Large candidate
    // rows cannot accumulate in a materialized result just to be filtered out.
    const query=`WITH candidates AS MATERIALIZED (SELECT rowid AS _backupCursor,${size} AS _backupBytes FROM ${identifier(table)}${conditions.length?' WHERE '+conditions.join(' AND '):''} ORDER BY rowid LIMIT ${limit}),
     chosen AS MATERIALIZED (SELECT _backupCursor FROM (
      SELECT *,sum(_backupBytes) OVER(ORDER BY _backupCursor) AS _backupTotal,row_number() OVER(ORDER BY _backupCursor) AS _backupPosition FROM candidates
     ) WHERE _backupTotal<=2097152 OR _backupPosition=1)
     SELECT chosen._backupCursor,${fields} FROM chosen JOIN ${identifier(table)} data ON data.rowid=chosen._backupCursor ORDER BY chosen._backupCursor`;
    const statement=db.prepare(query),bound=cursor===null?statement:statement.bind(cursor);
    const page=await bound.all<Record<string,unknown>>();
    if(!page.results.length)break;
    limit=page.results.length===limit?Math.min(512,limit*2):Math.max(1,page.results.length);
    for(const record of page.results){
     const {_backupCursor,...row}=record,next=Number(_backupCursor);
     if(!Number.isSafeInteger(next)||(cursor!==null&&next<=cursor))throw new Error('备份分页位置无效');
     yield (first?'':',')+JSON.stringify(row);first=false;cursor=next;
    }
    await new Promise(resolve=>setTimeout(resolve,20));
   }
   yield ']';
  }
  await unchanged();yield '}';
 }
 const iterator=document(),encoder=new TextEncoder();
 const stream=new ReadableStream<Uint8Array>({async pull(controller){try{const value=await iterator.next();if(value.done)controller.close();else controller.enqueue(encoder.encode(value.value));}catch(error){controller.error(error);}},async cancel(){await iterator.return(undefined);}});
 return {stream,verify:unchanged,cleanup:async()=>{},recordCount:0,rawBytes:0};
}
