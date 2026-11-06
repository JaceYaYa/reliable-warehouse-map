import {memoryR2} from './helpers/r2-memory.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {warehouseApiHarness} from './helpers/warehouse-api-harness.mjs';
const secret='test-setup-token-at-least-32-characters';
const snapshot={version:4,createdAt:'2026-10-02',stocks:[{id:99,locationCode:'A1',inboundDate:'2026-09-01',product:'测试产品',barcode:'X001',inboundOrder:'IB01',totalQuantity:10,totalBoxes:2,customerName:'测试客户',palletCount:0,layerCount:1,note:'备注',updatedBy:'老板',updatedAt:'2026-10-02'}],settings:[],users:[{id:1,username:'boss',displayName:'老板',role:'admin',passwordHash:'unused',passwordSalt:'unused',active:1,mustChange:0,createdAt:'2026-10-02'}],auditLogs:[],pricingCatalogItems:[],storageFeeSettlements:[]};
const request=(token=secret)=>new Request('https://test.test/api/test-setup',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(snapshot)});
test('snapshot setup requires the test flag and secret',async()=>{for(const env of [{TEST_SETUP_TOKEN:secret},{WAREHOUSE_TEST_MODE:'1',TEST_SETUP_TOKEN:secret}]){const h=warehouseApiHarness(env);try{const r=await h.load('app/api/test-setup/route.ts').POST(request('incorrect'));assert.equal(r.status,404);assert.equal(h.sqlite.prepare('SELECT count(*) n FROM stocks').get().n,0)}finally{h.sqlite.close()}}});
test('test setup restores one isolated snapshot, then rejects overwriting it',async()=>{
 const h=warehouseApiHarness({WAREHOUSE_TEST_MODE:'1',TEST_SETUP_TOKEN:secret,BACKUPS:memoryR2()});try{
 const setup=h.load('app/api/test-setup/route.ts');let r=await setup.POST(request());assert.equal(r.status,200,JSON.stringify(await r.clone().json()));assert.equal(h.sqlite.prepare('SELECT total_quantity FROM stocks WHERE id=99').get().total_quantity,10);assert.equal(h.sqlite.prepare('SELECT status FROM warehouse_test_setup').get().status,'ready');assert.equal(h.sqlite.prepare('SELECT count(*) n FROM sessions').get().n,0);
 r=await setup.POST(request());assert.equal(r.status,409);assert.equal(h.sqlite.prepare('SELECT count(*) n FROM stocks').get().n,1);
 }finally{h.sqlite.close()}
});
