/** Bound the complete JSON request, including its protocol envelope. */
// The server accepts a complete 4MB request. A valid D1 row can exceed 2MB
// after nested JSON strings are escaped, so count the actual request envelope.
export const HISTORY_CHUNK_BYTES=4*1024*1024;
const MAX_ROWS=10;
const encoder=new TextEncoder();
export function warehouseNeedsHistoryChunks(source:Record<string,unknown>){return Array.isArray(source.goodsOperations)&&!!(source.goodsOperations.length||(Array.isArray(source.auditLogs)&&encoder.encode(JSON.stringify(source.auditLogs)).byteLength>8*1024*1024));}
export type WarehouseHistory={id:string;total:number;received:number;nextIndex:number;status:'preparing'|'history'|'complete'};
export function prepareWarehouseHistoryBackup(source:Record<string,unknown>,importId:string):{core:Record<string,unknown>,chunks:unknown[][]}{
 if(!Array.isArray(source.goodsOperations))throw new Error('备份中的操作历史格式不正确');
 const audits=Array.isArray(source.auditLogs)&&encoder.encode(JSON.stringify(source.auditLogs)).byteLength>8*1024*1024?source.auditLogs:[];
 const historyRows=[...source.goodsOperations,...audits.map(row=>({warehouseAuditRow:row}))];
 const chunks:unknown[][]=[];
 let rows:unknown[]=[],bytes=0;
 const envelopeBytes=(index:number)=>encoder.encode(JSON.stringify({action:'warehouse-history',importId,index,rows:[]})).byteLength;
 for(const [index,row]of historyRows.entries()){
  const encoded=JSON.stringify(row);
  if(encoded===undefined)throw new Error(`第 ${index+1} 条操作历史格式不正确`);
  const size=encoder.encode(encoded).byteLength;
  if(size>4*1024*1024||envelopeBytes(chunks.length)+size>HISTORY_CHUNK_BYTES)throw new Error(`第 ${index+1} 条操作历史过大，尚未写入任何数据，请联系管理员处理。`);
  if(rows.length&&(rows.length>=MAX_ROWS||envelopeBytes(chunks.length)+bytes+1+size>HISTORY_CHUNK_BYTES)){chunks.push(rows);rows=[];bytes=0;}
  if(envelopeBytes(chunks.length)+size>HISTORY_CHUNK_BYTES)throw new Error(`第 ${index+1} 条操作历史过大，尚未写入任何数据，请联系管理员处理。`);
  rows.push(row);bytes+=size+(rows.length>1?1:0);
 }
 if(rows.length)chunks.push(rows);
 return{core:{...source,goodsOperations:[],users:[],...(audits.length?{auditLogs:[]}:{}),...(audits.length?{warehouseAuditExpected:audits.length}:{})},chunks};
}
export function warehouseHistoryResumePlan(history:unknown,id:string,chunks:unknown[][],warehouseCoreBusy=false):{uploadCore:boolean,nextIndex:number,complete:boolean}{
 const restart={uploadCore:true,nextIndex:0,complete:false};
 if(!history||typeof history!=='object'||!('id'in history)||history.id!==id)return restart;
 const job=history as WarehouseHistory;
 if(job.status==='preparing'){
  if(warehouseCoreBusy)throw new Error('基础数据仍在恢复中，请稍后核对进度，暂不重复提交');
  return restart;
 }
 const total=chunks.reduce((sum,chunk)=>sum+chunk.length,0);
 const validIndex=Number.isInteger(job.nextIndex)&&job.nextIndex>=0&&job.nextIndex<=chunks.length;
 const received=validIndex?chunks.slice(0,job.nextIndex).reduce((sum,chunk)=>sum+chunk.length,0):-1;
 const complete=job.status==='complete';
 if(!['history','complete'].includes(job.status)||!validIndex||job.total!==total||job.received!==received||(complete&&(received!==total||job.nextIndex!==chunks.length))||(!complete&&received===total))throw new Error('操作历史导入进度与所选文件不一致，请保留文件并联系管理员核对。');
 return{uploadCore:false,nextIndex:job.nextIndex,complete};
}
export type WarehouseCoreCounts={stocks:number;cartonReceipts:number;catalog:number;settlements:number;auditLogs:number};
export function warehouseCoreCounts(source:Record<string,unknown>):WarehouseCoreCounts{
 const length=(key:string)=>Array.isArray(source[key])?source[key].length:0;
 return{stocks:length('stocks'),cartonReceipts:length('cartonReceipts'),catalog:length('pricingCatalogItems'),settlements:length('storageFeeSettlements'),auditLogs:length('auditLogs')};
}
export function verifyWarehouseCoreCounts(value:unknown,expected:WarehouseCoreCounts):WarehouseCoreCounts|null{
 if(value===undefined||value===null)return null;
 if(typeof value!=='object'||Object.entries(expected).some(([key,count])=>(value as Record<string,unknown>)[key]!==count))throw new Error('核心数据条数与所选备份不一致，请保留文件并联系管理员核对。');
 return value as WarehouseCoreCounts;
}
