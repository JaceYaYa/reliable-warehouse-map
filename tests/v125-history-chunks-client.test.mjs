import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareWarehouseHistoryBackup,warehouseHistoryResumePlan,HISTORY_CHUNK_BYTES} from '../lib/warehouse-history-chunks.ts';
const id='7ae3d083-37fc-4551-887d-94df296a4f34';
const body=(index,rows)=>JSON.stringify({action:'warehouse-history',importId:id,index,rows});
test('warehouse history chunks retain row order and bound complete UTF8 requests and rows',()=>{
 const rows=Array.from({length:25},(_,n)=>({id:String(n),result:'仓'.repeat(60000)}));
 const source={version:7,users:[{id:1}],stocks:[{id:2}],settings:[{key:'keep'}],goodsOperations:rows};
 const result=prepareWarehouseHistoryBackup(source,id);
 assert.equal(result.core.goodsOperations.length,0);assert.deepEqual(result.core.users,[]);assert.equal(result.core.stocks,source.stocks);assert.equal(result.core.settings,source.settings);assert.equal(source.goodsOperations,rows);assert.equal(source.users.length,1);
 assert.deepEqual(result.chunks.flat(),rows);assert.ok(result.chunks.length>2);
 for(const [index,chunk]of result.chunks.entries()){assert.ok(chunk.length<=10);assert.ok(new TextEncoder().encode(body(index,chunk)).length<=HISTORY_CHUNK_BYTES);}
});
test('oversized history rejects before a core upload can be prepared',()=>{
 assert.throws(()=>prepareWarehouseHistoryBackup({version:7,goodsOperations:[{id:'oversized',result:'中'.repeat(1500000)}]},id),/第 1 条.*过大/);
});

test('valid database rows exceeding 2MB after JSON escaping still import within the server 4MB envelope',()=>{
 const big={id:1,beforeSnapshot:'"'.repeat(1_300_000)},audits=[big,...Array.from({length:4},(_,n)=>({id:n+2,beforeSnapshot:'"'.repeat(900000)}))];
 const source={version:9,goodsOperations:[],auditLogs:audits};
 const prepared=prepareWarehouseHistoryBackup(source,id);
 assert.equal(prepared.core.auditLogs.length,0);
 assert.deepEqual(prepared.chunks.flat().map(row=>row.warehouseAuditRow),audits);
 for(const [index,rows]of prepared.chunks.entries())assert.ok(Buffer.byteLength(body(index,rows))<=4*1024*1024);
 assert.ok(prepared.chunks.some(rows=>Buffer.byteLength(body(0,rows))>2*1024*1024));
});
test('resume skips confirmed core, validates chunk boundaries and never trusts incomplete completion',()=>{
 const chunks=[[{id:1},{id:2}],[{id:3}]];
 const base={id,total:3,received:2,nextIndex:1,status:'history'};
 assert.deepEqual(warehouseHistoryResumePlan(base,id,chunks),{uploadCore:false,nextIndex:1,complete:false});
 assert.deepEqual(warehouseHistoryResumePlan({...base,status:'preparing'},id,chunks),{uploadCore:true,nextIndex:0,complete:false});
 assert.deepEqual(warehouseHistoryResumePlan(null,id,chunks),{uploadCore:true,nextIndex:0,complete:false});
 assert.deepEqual(warehouseHistoryResumePlan({...base,id:'other'},id,chunks),{uploadCore:true,nextIndex:0,complete:false});
 assert.throws(()=>warehouseHistoryResumePlan({...base,received:1},id,chunks),/进度/);
 assert.throws(()=>warehouseHistoryResumePlan({...base,status:'complete'},id,chunks),/进度/);
 assert.deepEqual(warehouseHistoryResumePlan({...base,received:3,nextIndex:2,status:'complete'},id,chunks),{uploadCore:false,nextIndex:2,complete:true});
});
test('core counts are accepted only when every reported table matches the selected backup',async()=>{
 const {warehouseCoreCounts,verifyWarehouseCoreCounts}=await import('../lib/warehouse-history-chunks.ts');
 const expected=warehouseCoreCounts({stocks:[1,2],cartonReceipts:[1],pricingCatalogItems:[1,2,3],storageFeeSettlements:[],auditLogs:[1]});
 assert.deepEqual(expected,{stocks:2,cartonReceipts:1,catalog:3,settlements:0,auditLogs:1});
 assert.deepEqual(verifyWarehouseCoreCounts(expected,expected),expected);
 assert.equal(verifyWarehouseCoreCounts(undefined,expected),null);
 assert.throws(()=>verifyWarehouseCoreCounts({...expected,stocks:1},expected),/条数/);
 assert.throws(()=>verifyWarehouseCoreCounts({stocks:2},expected),/条数/);
});
test('active core restore stops a same-job retry before it can upload another core',()=>{
 const chunks=[[{id:1}]],preparing={id,total:1,received:0,nextIndex:0,status:'preparing'};
 assert.throws(()=>warehouseHistoryResumePlan(preparing,id,chunks,true),/基础数据仍在恢复中，请稍后核对进度，暂不重复提交/);
 assert.deepEqual(warehouseHistoryResumePlan(preparing,id,chunks,false),{uploadCore:true,nextIndex:0,complete:false});
 assert.deepEqual(warehouseHistoryResumePlan({...preparing,status:'history'},id,chunks,true),{uploadCore:false,nextIndex:0,complete:false});
});
