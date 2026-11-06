import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {defaultLayerCapacity,layerUsage} from '../lib/layer-capacity.ts';
import {summarizeZoneLayerAvailability} from '../lib/warehouse-capacity.ts';
import {effectivePermissions,hasPermission,ALL_PERMISSIONS} from '../lib/permissions.ts';
import {warehouseApiHarness} from './helpers/warehouse-api-harness.mjs';
const zones=()=>[{id:'NEW_A',title:'A区',codes:['A1','A2'],locationCodesVersion:1,layoutVersion:8,newPalletCapacityVersion:1,features:[],layout:{A1:{x:1,y:1,w:1,h:1,capacityLayers:2},A2:{x:3,y:1,w:1,h:1,capacityLayers:2}}}];
test('layer capacity counts distinct occupied shelf numbers, including unopened boxes and overflow',()=>{
 assert.equal(layerUsage([],2).state,'empty');
 assert.deepEqual(layerUsage([{layerCount:2},{layerCount:2}],2).layers,[2]);
 assert.equal(layerUsage([{layerCount:2},{layerCount:2}],2).remaining,1);
 assert.equal(layerUsage([{layerCount:1},{layerCount:2}],2).state,'full');
 assert.equal(layerUsage([{layerCount:3}],2).state,'over');
 assert.equal(layerUsage([{layerCount:3}],2).remaining,2);
 assert.equal(layerUsage([{layerCount:1}],0).state,'unlimited');
 assert.equal(layerUsage([],0).state,'empty');
});
test('presets match requested ranges and do not change old named bins',()=>{
 for(const [code,n] of [['A1',2],['A38',2],['B32',2],['B33',0],['C11',2],['C34',2],['C10',4],['D32',3],['E6',4],['E7',0],['A1通道',1],['自定义通道',1],['旧A1',0],['新B1',2]])assert.equal(defaultLayerCapacity(code),n,code);
 const result=summarizeZoneLayerAvailability(zones(),[{locationCode:'A1',layerCount:2},{locationCode:'A1',layerCount:2},{locationCode:'A2',layerCount:3}]);
 assert.equal(result[0].remainingLayers,3);
});
test('migration presets persist without changing geometry, existing overrides, inventory or legacy labels',()=>{
 const h=warehouseApiHarness();try{const z=zones();z[0].codes.push('旧A1','D32','E6','A1通道');delete z[0].layout.A1.capacityLayers;z[0].layout.A2.capacityLayers=9;h.setting('warehouse_zones',z);const id=h.stock();const before=h.sqlite.prepare('SELECT * FROM stocks WHERE id=?').get(id);h.sqlite.exec(readFileSync('drizzle/0013_layer_capacity_defaults.sql','utf8'));const after=JSON.parse(h.sqlite.prepare("SELECT value FROM settings WHERE key='warehouse_zones'").get().value)[0];assert.deepEqual(after.codes,z[0].codes);assert.deepEqual(after.layout.A1,{...z[0].layout.A1,capacityLayers:2});assert.equal(after.layout.A2.capacityLayers,9);assert.equal(after.layout['旧A1'].capacityLayers,0);assert.equal(after.layout.D32.capacityLayers,3);assert.equal(after.layout.E6.capacityLayers,4);assert.equal(after.layout['A1通道'].capacityLayers,1);assert.deepEqual(h.sqlite.prepare('SELECT * FROM stocks WHERE id=?').get(id),before);h.sqlite.exec(readFileSync('drizzle/0013_layer_capacity_defaults.sql','utf8'));assert.equal(JSON.parse(h.sqlite.prepare("SELECT value FROM settings WHERE key='warehouse_zones'").get().value)[0].layout.A2.capacityLayers,9)}finally{h.sqlite.close()}
});
test('fixed profiles ignore historical grant arrays and boss remains protected',()=>{
 assert.equal(hasPermission({role:'employee',permissions:ALL_PERMISSIONS},'stock.inbound'),false);
 assert.equal(hasPermission({role:'admin',permissions:[]},'stock.inbound'),true);
 assert.equal(hasPermission({role:'admin',permissions:'invalid'},'stock.outbound'),true);
 for(const key of ['pricing.manage','users.manage','backup.manage','health.view'])assert.equal(hasPermission({role:'admin',permissions:ALL_PERMISSIONS},key),false);
 assert.deepEqual(effectivePermissions({username:'boss',permissions:[]}),ALL_PERMISSIONS);
});

test('fixed-role account changes reject custom grants, protect boss and apply downgrade to existing sessions',async()=>{
 const h=warehouseApiHarness();try{h.seedUser(1,null,'admin','boss');h.seedUser(2,['users.manage'],'employee');h.seedUser(3,[],'admin');
 let r=await h.call('users','POST',{username:'fixed',displayName:'固定员工',password:'test-pass-123',role:'employee'});assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(h.sqlite.prepare("SELECT role FROM users WHERE username='fixed'").get().role,'employee');
 assert.equal((await h.call('users','POST',{username:'old',displayName:'旧授权',password:'test-pass-123',role:'admin',permissions:['stock.outbound']})).status,400);
 assert.equal((await h.call('users','POST',{username:'escalate',displayName:'越权',password:'test-pass-123',role:'admin'},'test-token-2')).status,403);
 assert.equal((await h.call('users','PATCH',{id:1,role:'employee',expectedVersion:0})).status,403);
 assert.equal((await h.call('users','PATCH',{id:2,role:'admin',expectedVersion:0},'test-token-2')).status,403);
 assert.equal((await h.call('users','PATCH',{id:3,role:'employee',expectedVersion:0})).status,200);
 assert.equal((await h.call('stocks','POST',{locationCode:'A1',product:'不应入库',inboundDate:'2026-09-01'},'test-token-3')).status,403);
 assert.equal((await h.call('users','PATCH',{id:3,role:'admin',expectedVersion:0})).status,409);
 assert.equal(h.sqlite.prepare("SELECT count(*) AS n FROM audit_logs WHERE action='修改账号角色'").get().n,1);assert.equal(h.sqlite.prepare('SELECT count(*) AS n FROM stocks').get().n,0);
 }finally{h.sqlite.close()}
});

test('employee cannot write warehouse surfaces; admin receives with explicit pallet count and no pricing access',async()=>{
 const h=warehouseApiHarness();try{h.seedUser(1,ALL_PERMISSIONS,'employee');h.setting('warehouse_zones',zones());const id=h.stock();
 for(const [path,method,payload]of [['stocks','POST',{id,product:'不可改'}],['stocks','PATCH',{id,quantity:1}],['stocks/move','POST',{}],['stocks/discard','DELETE',{}],['locations','POST',{}],['locations','PATCH',{}],['users','GET',undefined],['pricing/report','GET',undefined]])assert.equal((await h.call(path,method,payload)).status,403,path+method);
 assert.equal((await h.call('movements')).status,200);h.seedUser(2,[],'admin');
 const r=await h.call('stocks','POST',{locationCode:'A1',product:'未开箱',inboundDate:'2026-09-01',totalQuantity:0,totalBoxes:8,layerCount:3,inboundSource:'domestic',palletCount:999},'test-token-2');assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.data.stock.layerCount,3);assert.equal(r.data.stock.palletCount,999);
 assert.equal((await h.call('pricing/report','GET',undefined,'test-token-2')).status,403);
 }finally{h.sqlite.close()}
});

test('historical pallet values cannot leave a ghost row after full outbound',async()=>{
 const h=warehouseApiHarness();try{h.seedUser(1,['stock.outbound'],'admin');const id=h.stock('A1',2,8);const r=await h.call('stocks','PATCH',{id,quantity:10,boxes:2});assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.data.removed,true);assert.equal(h.sqlite.prepare('SELECT count(*) AS n FROM stocks').get().n,0)}finally{h.sqlite.close()}
});
test('capacity updates reject fractional and stale writes; saved overrides survive refresh',async()=>{
 const h=warehouseApiHarness();try{h.seedUser(1,['capacity.edit'],'admin');h.setting('warehouse_zones',zones());const snapshot=(await h.call('locations')).data;
 assert.equal((await h.call('locations','PATCH',{locationCode:'A1',capacityLayers:1.5,expectedRevision:snapshot.revision})).status,400);
 let r=await h.call('locations','PATCH',{locationCode:'A1',capacityLayers:4,expectedRevision:snapshot.revision});assert.equal(r.status,200,JSON.stringify(r.data));
 assert.equal((await h.call('locations','PATCH',{locationCode:'A1',capacityLayers:2,expectedRevision:snapshot.revision})).status,409);
 assert.equal((await h.call('locations')).data.zones[0].layout.A1.capacityLayers,4);
 }finally{h.sqlite.close()}
});

test('concurrent role elevation prevents a stale account deletion',async()=>{
 const h=warehouseApiHarness();try{h.seedUser(1,null,'admin','boss');h.seedUser(2,['stock.inbound']);h.sqlite.exec('UPDATE users SET active=0 WHERE id=2');h.adapter.beforeBatch=()=>h.sqlite.prepare("UPDATE users SET role='admin',permission_version=permission_version+1 WHERE id=2").run();const r=await h.call('users','DELETE',{id:2,confirmUsername:'user2'});assert.equal(r.status,409,JSON.stringify(r.data));assert.ok(h.sqlite.prepare('SELECT id FROM users WHERE id=2').get());assert.equal(h.sqlite.prepare("SELECT count(*) AS n FROM audit_logs WHERE action='删除账号'").get().n,0)}finally{h.sqlite.close()}
});
