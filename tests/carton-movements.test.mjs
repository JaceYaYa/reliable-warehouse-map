import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import {warehouseApiHarness} from './helpers/warehouse-api-harness.mjs';
test('carton receiving, outbound, latest movement and restore are in ordinary movement records even before claim',async()=>{
 const h=warehouseApiHarness();h.seedUser(1,null,'admin','boss');h.setting('warehouse_zones',[{id:'NEW_A',title:'A区',codes:['A1','A2']}]);
 try{const inbound=await h.call('cartons','POST',{requestId:randomUUID(),inboundOrder:'任意到货号',inboundDate:'2026-10-01',placements:[{key:'one',locationCode:'A1',layerCount:1,boxes:8}]});assert.equal(inbound.status,200);
 const records=await h.call('movements?operationsOnly=1&location=A1');assert.equal(records.data.logs.length,1);assert.match(records.data.logs[0].summary,/任意到货号/);assert.equal(records.data.logs[0].canRestore,true);const latest=await h.call('movements?latest=1');assert.equal(latest.data.logs[0].id,records.data.logs[0].id);
 const outbound=await h.call('cartons/outbound','POST',{requestId:randomUUID(),id:inbound.data.receipt.id,expectedVersion:0,outboundDate:'2026-10-03',picks:[{key:'one',boxes:3}]});assert.equal(outbound.status,200);const logs=await h.call('movements');assert.equal(logs.data.logs.length,2);assert.match(logs.data.logs[0].summary,/2026-10-03/);assert.equal((await h.call('movements','POST',{id:logs.data.logs[0].id})).status,200);assert.equal((await h.call('cartons')).data.receipts[0].totalBoxes,8);const restored=await h.call('movements?status=restored');assert.ok(restored.data.logs.some(l=>l.id===logs.data.logs[0].id));
 }finally{h.sqlite.close()}
});

test('箱件删除属于普通记录且可安全恢复，不混入纯出入库筛选',async()=>{
 const h=warehouseApiHarness();h.seedUser(1,null,'admin','boss');h.setting('warehouse_zones',[{id:'NEW_A',title:'A区',codes:['A1']}]);
 try{const r=await h.call('cartons','POST',{requestId:randomUUID(),inboundOrder:'IB-DELETE',inboundDate:'2026-10-01',placements:[{key:'one',locationCode:'A1',layerCount:1,boxes:20}]}),d=await h.call('cartons/discard','DELETE',{requestId:randomUUID(),id:r.data.receipt.id,placementKey:'one',expectedVersion:0});assert.equal(d.status,200);
 const logs=await h.call('movements?location=A1'),log=logs.data.logs.find(l=>l.action==='箱件删除');assert.ok(log);assert.equal(log.canRestore,true);assert.match(log.summary,/本次删除 20箱（不计出库）/);assert.ok(!(await h.call('movements?operationsOnly=1')).data.logs.some(l=>l.action==='箱件删除'));
 assert.equal((await h.call('movements','POST',{id:log.id})).status,200);assert.equal((await h.call('cartons')).data.receipts[0].totalBoxes,20);const restored=await h.call('movements?status=restored');assert.ok(restored.data.logs.some(l=>l.id===log.id&&l.canRestore===false));
 }finally{h.sqlite.close()}
});

test('箱件删除立即刷新recent同步版本和最新卡片，撤销权限随删除权限核对',async()=>{
 const h=warehouseApiHarness();h.seedUser(1,null,'admin','boss');h.seedUser(2,null,'employee','reader');h.setting('warehouse_zones',[{id:'NEW_A',title:'A区',codes:['A1']}]);
 try{const inbound=await h.call('cartons','POST',{requestId:randomUUID(),inboundOrder:'IB-RECENT-DELETE',inboundDate:'2026-10-01',placements:[{key:'one',locationCode:'A1',layerCount:1,boxes:2}]}),before=await h.call('sync');assert.equal(before.status,200);
 const deleted=await h.call('cartons/discard','DELETE',{requestId:randomUUID(),id:inbound.data.receipt.id,placementKey:'one',expectedVersion:0});assert.equal(deleted.status,200);
 const sync=await h.call('sync?'+new URLSearchParams(before.data.versions));assert.equal(sync.status,200);assert.notEqual(sync.data.versions.recent,before.data.versions.recent);assert.equal(sync.data.data.recent.logs[0].action,'箱件删除');assert.equal(sync.data.data.recent.logs[0].canRestore,true);assert.equal(sync.data.data.recent.logs[0].entityId,'A1');
 const employee=await h.call('sync','GET',undefined,'test-token-2');assert.equal(employee.data.data.recent.logs[0].action,'箱件删除');assert.equal(employee.data.data.recent.logs[0].canRestore,false);
 const log=sync.data.data.recent.logs[0];assert.equal((await h.call('movements','POST',{id:log.id})).status,200);const restored=await h.call('sync?'+new URLSearchParams(sync.data.versions));assert.notEqual(restored.data.versions.recent,sync.data.versions.recent);assert.equal(restored.data.data.recent.logs[0].action,'撤销箱件操作');assert.equal((await h.call('cartons')).data.receipts[0].totalBoxes,2);
 }finally{h.sqlite.close()}
});
