import test from 'node:test';
import assert from 'node:assert/strict';
import {warehouseApiHarness} from './helpers/warehouse-api-harness.mjs';
import {effectivePermissions,hasPermission} from '../lib/permissions.ts';
import {canWriteWarehouseData,userRoleLabel} from '../lib/roles.ts';
const denied=['pricing.manage','users.manage','backup.manage','health.view'];
const operational=['stock.inbound','stock.outbound','stock.move','stock.edit','stock.convert','stock.delete','stock.restore','product.manage','product.archive','map.edit','capacity.edit','records.view','audit.view','workorders.view','workorders.manage','workorders.execute'];
const setup=()=>{const h=warehouseApiHarness();h.seedUser(1,[],'admin','boss');h.seedUser(2,['users.manage','pricing.manage','stock.inbound'],'employee');h.seedUser(3,['users.manage','pricing.manage'],'admin');h.seedUser(4,['stock.inbound'],'warehouse');return h;};
test('fixed roles cannot be elevated or restricted by saved granular grants',()=>{
 for(const role of ['employee','warehouse'])for(const permissions of [null,[],['users.manage','pricing.manage','stock.inbound'],'["stock.delete"]','bad']){assert.deepEqual(effectivePermissions({role,permissions}),['records.view','workorders.view']);assert.equal(hasPermission({role,permissions},'stock.inbound'),false);}
 for(const permissions of [null,[],['users.manage','pricing.manage'],'bad']){const u={role:'admin',permissions};for(const p of operational)assert.equal(hasPermission(u,p),true,p);for(const p of denied)assert.equal(hasPermission(u,p),false,p);}
 assert.equal(hasPermission({role:'employee',username:' BOSS ',permissions:[]},'users.manage'),true);
 assert.deepEqual(effectivePermissions({role:'invalid',permissions:['users.manage']}),[]);
 assert.equal(canWriteWarehouseData('employee'),false);assert.equal(canWriteWarehouseData('admin'),true);assert.equal(userRoleLabel('warehouse'),'员工');assert.equal(userRoleLabel('admin',' BOSS '),'老板');
});
test('real sessions re-read fixed role and protected system APIs reject admin and employee',async()=>{const h=setup();try{
 const auth=h.load('lib/auth.ts');const request=id=>new Request('http://local.test',{headers:{cookie:`wms_session=test-token-${id}`}});
 for(const id of [2,3,4]){assert.equal((await auth.requireUser(request(id),true)).error.status,403);assert.equal((await h.call('users','GET',undefined,`test-token-${id}`)).status,403);}
 assert.equal((await auth.requireWriteUser(request(2),'stock.inbound')).error.status,403);assert.ok((await auth.requireWriteUser(request(3),'stock.outbound')).user);
 h.sqlite.prepare("UPDATE users SET role='employee',permissions='[\"stock.outbound\"]',permission_version=permission_version+1 WHERE id=3").run();
 assert.equal((await auth.requireWriteUser(request(3),'stock.outbound')).error.status,403);
 assert.ok((await auth.requireUser(request(1),true)).user);
}finally{h.sqlite.close();}});
test('account role create/update is protected, version guarded, audited and rejects granular grants',async()=>{const h=setup();try{
 for(const role of ['boss','warehouse','invalid',null])assert.equal((await h.call('users','POST',{username:'invalid'+String(role),displayName:'测试',password:'12345678',role})).status,400);
 assert.equal((await h.call('users','POST',{username:' BOSS ',displayName:'测试',password:'12345678',role:'admin'})).status,403);
 assert.equal((await h.call('users','POST',{username:'grants',displayName:'测试',password:'12345678',role:'employee',permissions:['users.manage']})).status,400);
 for(const role of ['employee','admin']){const r=await h.call('users','POST',{username:'new'+role,displayName:'测试',password:'12345678',role});assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(h.sqlite.prepare('SELECT role, permissions FROM users WHERE username=?').get('new'+role).role,role);}
 let r=await h.call('users','PATCH',{id:2,role:'admin',expectedVersion:0});assert.equal(r.status,200,JSON.stringify(r.data));const user=h.sqlite.prepare('SELECT role,permissions,permission_version FROM users WHERE id=2').get();assert.equal(user.role,'admin');assert.equal(user.permissions,null);assert.equal(user.permission_version,1);
 assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='修改账号角色'").get().n,1);
 assert.equal((await h.call('users','PATCH',{id:2,role:'employee',expectedVersion:0})).status,409);
 for(const body of [{id:1,role:'employee',expectedVersion:0},{id:1,active:0,expectedVersion:0}])assert.equal((await h.call('users','PATCH',body)).status,403);
 assert.equal((await h.call('users','PATCH',{id:2,permissions:['users.manage'],expectedVersion:1})).status,400);
 assert.equal((await h.call('users','PATCH',{id:2,role:'boss',expectedVersion:1})).status,400);
 assert.equal((await h.call('users','PATCH',{id:2,role:'employee',active:0,expectedVersion:1})).status,400);
 assert.equal((await h.call('users','DELETE',{id:1,confirmUsername:'boss'})).status,403);
 const before=h.sqlite.prepare('SELECT COUNT(*) n FROM users').get().n;
 for(const body of [null,[],{}, {username:2,displayName:'测试',password:'12345678',role:'employee'}])assert.equal((await h.call('users','POST',body)).status,400);
 assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM users').get().n,before);
}finally{h.sqlite.close();}});
test('pricing reads require boss, warehouse catalog lookup contains identities without money',async()=>{const h=setup();try{
 h.sqlite.prepare("INSERT INTO pricing_catalog_items(identity_key,product,sku,fnsku,barcode,customer_name,rate_usd_m3_day,free_days,created_at,updated_at) VALUES ('one','产品','SKU','FNSKU','BAR','客户',12.34,9,'now','now')").run();
 for(const id of [2,3,4])for(const path of ['pricing/catalog','pricing/settings','pricing/catalog/export','pricing/report'])assert.equal((await h.call(path,'GET',undefined,`test-token-${id}`)).status,403,`${id} ${path}`);
 for(const id of [2,3,4]){const r=await h.call('pricing/catalog?warehouseLookup=1','GET',undefined,`test-token-${id}`);assert.equal(r.status,200);assert.equal(r.data.items[0].sku,'SKU');assert.equal(r.data.items[0].fnsku,'FNSKU');assert.equal('rateUsdM3Day' in r.data.items[0],false);assert.equal('ratePerM3Day' in r.data.items[0],false);assert.equal('freeDays' in r.data.items[0],false);}
 assert.equal((await h.call('pricing/catalog')).data.items[0].rateUsdM3Day,12.34);
 assert.equal((await h.call('pricing/settings')).status,200);
}finally{h.sqlite.close();}});

test('stocks and sync preserve physical data but hide financial fields from warehouse roles',async()=>{const h=setup();try{
 const id=h.stock();h.sqlite.prepare("UPDATE stocks SET storage_rate_usd=8.9,free_days=4,sku='SKU',item_volume_m3=.25 WHERE id=?").run(id);
 for(const uid of [2,3,4]){const direct=(await h.call('stocks','GET',undefined,`test-token-${uid}`)).data.stocks[0];assert.equal(direct.sku,'SKU');assert.equal(direct.itemVolumeM3,.25);assert.equal(direct.totalQuantity,10);assert.equal('storageRateUsd' in direct,false);assert.equal('freeDays' in direct,false);const sync=await h.call('sync','GET',undefined,`test-token-${uid}`);assert.equal(sync.status,200);assert.equal('storageRateUsd' in sync.data.data.stocks.stocks[0],false);}
 assert.equal((await h.call('stocks')).data.stocks[0].storageRateUsd,8.9);
}finally{h.sqlite.close();}});
test('admin legacy stock writes preserve server pricing and reject changed rates or fee rules',async()=>{const h=setup();try{
 const id=h.stock();h.sqlite.prepare('UPDATE stocks SET storage_rate_usd=8.9,free_days=4 WHERE id=?').run(id);
 for(const body of [{storageRateUsd:1},{freeDays:0},{ratePerM3Day:0},{rateUsdM3Day:0}]){const r=await h.call('stocks','POST',{id,version:0,...body},'test-token-3');assert.equal(r.status,403,JSON.stringify(r.data));}
 let r=await h.call('stocks','POST',{id,version:0,note:'备注',storageRateUsd:8.9,freeDays:4},'test-token-3');assert.equal(r.status,200,JSON.stringify(r.data));assert.equal('storageRateUsd' in r.data.stock,false);
 const row=h.sqlite.prepare('SELECT storage_rate_usd,free_days,version FROM stocks WHERE id=?').get(id);assert.equal(row.storage_rate_usd,8.9);assert.equal(row.free_days,4);
 assert.equal((await h.call('stocks','PATCH',{id,quantity:1,storageRateUsd:1},'test-token-3')).status,403);
 assert.equal((await h.call('stocks','POST',{id,version:1,note:'员工修改'},'test-token-2')).status,403);
 h.setting('pricing_defaults',{defaultRatePerM3Day:2.5,defaultFreeDays:7});r=await h.call('stocks','POST',{locationCode:'A2',product:'新入库',inboundDate:'2026-09-01',totalQuantity:2,totalBoxes:1},'test-token-3');assert.equal(r.status,200,JSON.stringify(r.data));const inbound=h.sqlite.prepare("SELECT storage_rate_usd,free_days FROM stocks WHERE product='新入库'").get();assert.equal(inbound.storage_rate_usd,2.5);assert.equal(inbound.free_days,7);
}finally{h.sqlite.close();}});
