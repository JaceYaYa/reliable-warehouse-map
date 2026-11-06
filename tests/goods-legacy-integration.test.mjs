import {memoryR2} from './helpers/r2-memory.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {warehouseApiHarness} from './helpers/warehouse-api-harness.mjs';

async function fixture(extra={}){
 const h=warehouseApiHarness(extra);h.seedUser(1,null,'admin','boss');h.setting('warehouse_zones',[{id:'NEW_A',title:'A区',codes:['A1','A2','B3']}]);
 const a=h.stock('A1'),b=h.stock('B3');h.sqlite.exec("UPDATE stocks SET product='饭盒',customer_name='客户A',inbound_source='return',item_volume_m3=.1,storage_rate_usd=.5,pallet_count=0,pallet_label='0'");h.sqlite.prepare('UPDATE stocks SET inbound_date=? WHERE id=?').run('2026-06-01',a);
 const c=(await h.call('goods')).data;const choice=c.choices[0];const result=await h.call('goods/outbound','POST',{requestId:crypto.randomUUID(),expectedRevision:c.revision,key:choice.key,members:choice.members.map(r=>({id:r.id,version:r.version})),quantity:5,boxes:1,selected:[{id:b,version:0}]});assert.equal(result.status,200,JSON.stringify(result.data));return{h,a,b};
}
const row=(h,id)=>h.sqlite.prepare('SELECT * FROM stocks WHERE id=?').get(id);
const state=h=>JSON.parse(h.sqlite.prepare('SELECT value FROM goods_flow_state').get().value);
const stocks=async h=>(await h.call('stocks')).data.stocks;

test('旧库存写接口接入成本账本：数量/旧出库拒绝，品相、备注、显示日期同步保存',async()=>{
 const {h,a,b}=await fixture();try{
  const before=await stocks(h),old=before.find(r=>r.id===a),unmodified=JSON.stringify(state(h));
  for(const [path,method,body] of [['stocks','POST',{...old,totalQuantity:11}],['stocks','PATCH',{id:a,quantity:1,boxes:0}],['stocks?id='+a,'DELETE',undefined],['inventory/records','PATCH',{id:a,expectedVersion:old.version,totalQuantity:11}],['stocks','PUT',{id:a,version:old.version,customerName:'新客户'}]]){
   const result=await h.call(path,method,body);assert.equal(result.status,409,`${path}: ${JSON.stringify(result.data)}`);
  }
  assert.equal(JSON.stringify(state(h)),unmodified);assert.equal(row(h,a).total_quantity,10);assert.equal(row(h,b).total_quantity,5);
  const edited=await h.call('inventory/records','PATCH',{id:a,expectedVersion:old.version,note:'新备注',productPrefix:'左侧',productCondition:'damaged',inboundDate:'2026-07-01'});assert.equal(edited.status,200,JSON.stringify(edited.data));assert.equal(edited.data.dateDisplayOnly,true);const lot=state(h).categories[0].lots.find(l=>l.stockId===a);assert.equal(lot.snapshot.inboundDate,'2026-06-01');assert.equal(lot.snapshot.note,'新备注');assert.equal(lot.snapshot.productPrefix,'左侧');
  const all=await stocks(h);const corrected=await h.call('inventory/records/batch','PATCH',{records:all.map(r=>({id:r.id,expectedVersion:r.version})),customerName:'统一客户',product:'统一饭盒'});assert.equal(corrected.status,200,JSON.stringify(corrected.data));assert.equal(state(h).categories[0].customerName,'统一客户');assert.equal(state(h).categories[0].product,'统一饭盒');assert.equal(row(h,a).product_prefix,'左侧');assert.equal(h.sqlite.prepare('SELECT customer_name FROM storage_fee_settlements').get().customer_name,'客户A');
 }finally{h.sqlite.close()}
});

test('实际部分移库和撤销记录保持FIFO批次且audit捕获正确目标编号',async()=>{
 const {h,a}=await fixture();try{const old=(await stocks(h)).find(r=>r.id===a),lots=JSON.stringify(state(h).categories[0].lots),moved=await h.call('stocks/move','POST',{id:a,expectedVersion:old.version,mode:'partial',targetLocation:'A2',quantity:3,boxes:1,sourceRemainingLayerCount:1,targetLayerCount:2});assert.equal(moved.status,200,JSON.stringify(moved.data));const child=moved.data.destination;assert.equal(state(h).categories[0].stockIds.includes(child.id),true);assert.equal(JSON.stringify(state(h).categories[0].lots),lots);const log=h.sqlite.prepare("SELECT * FROM audit_logs WHERE action='移库'").get();assert.equal(JSON.parse(log.after_snapshot).rows[1].id,child.id);const undone=await h.call('movements','POST',{id:log.id});assert.equal(undone.status,200,JSON.stringify(undone.data));assert.equal(row(h,a).total_quantity,10);assert.equal(row(h,child.id),undefined);assert.equal(state(h).categories[0].stockIds.includes(child.id),false);
 }finally{h.sqlite.close()}
});

test('V5整库备份恢复独立成本批次与操作，再经原记录入口撤销；V4恢复清空新账本',async()=>{
 const files=new Map(),{h,a,b}=await fixture({BACKUPS:memoryR2(files)});try{
  const key=(await h.call('backups','POST',{})).data.key,saved=JSON.parse(files.get(key));assert.equal(saved.version,9);assert.equal(saved.goodsFlowState.length,1);assert.equal(saved.goodsOperations.length,1);const originalState=JSON.stringify(state(h)),operation=h.sqlite.prepare("SELECT id FROM audit_logs WHERE action='出库'").get();
  const route=h.load('app/api/backups/route.ts');const restore=async data=>{const form=new FormData();form.set('file',new File([JSON.stringify(data)],'backup.json'));form.set('confirm','恢复备份');return route.PUT(new Request('http://local.test/api/backups',{method:'PUT',headers:{cookie:'wms_session=test-token-1'},body:form}))};
  h.sqlite.exec('UPDATE stocks SET total_quantity=0; UPDATE goods_flow_state SET value=\'{"categories":[]}\'; DELETE FROM goods_operations');const result=await restore(saved);assert.equal(result.status,200,await result.text());assert.equal(JSON.stringify(state(h)),originalState);assert.equal(row(h,b).total_quantity,5);
  const token='test-token-1',hash=createHash('sha256').update(token).digest('hex');h.sqlite.prepare("INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES (?,1,'2099-01-01','now')").run(hash);const undo=await h.call('movements','POST',{id:operation.id});assert.equal(undo.status,200,JSON.stringify(undo.data));assert.equal(row(h,a).total_quantity,10);assert.equal(row(h,b).total_quantity,10);assert.equal(state(h).categories.length,0);
  const old={...saved,version:4};delete old.goodsFlowState;delete old.goodsOperations;const oldRestore=await restore(old);assert.equal(oldRestore.status,200,await oldRestore.text());assert.equal(state(h).categories.length,0);assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM goods_operations').get().n,0);
 }finally{h.sqlite.close()}
});

test('备份库位改名同时升级实物、成本及操作快照，不遗留旧库位',()=>{
 const h=warehouseApiHarness();try{const upgrade=h.load('lib/location-aliases.ts').upgradeBackupLocationNames,data={stocks:[{id:1,locationCode:'A1'}],settings:[],goodsFlowState:[{id:1,value:JSON.stringify({categories:[{lots:[{snapshot:{locationCode:'A1'}}]}]})}],goodsOperations:[{beforeCategory:null,afterCategory:JSON.stringify({lots:[{snapshot:{locationCode:'A1'}}]}),beforeRows:'[]',afterRows:JSON.stringify([{locationCode:'A1'}]),result:JSON.stringify({stocks:[{locationCode:'A1'}]})}]};const next=upgrade(data,{A1:'新A1'});assert.equal(next.stocks[0].locationCode,'新A1');assert.equal(JSON.parse(next.goodsFlowState[0].value).categories[0].lots[0].snapshot.locationCode,'新A1');assert.equal(JSON.parse(next.goodsOperations[0].afterRows)[0].locationCode,'新A1');assert.equal(JSON.parse(next.goodsOperations[0].result).stocks[0].locationCode,'新A1');}finally{h.sqlite.close()}
});
