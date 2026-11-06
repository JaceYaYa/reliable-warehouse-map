import assert from 'node:assert/strict';
import test from 'node:test';
import {resolve} from 'node:path';
import {warehouseApiHarness} from './helpers/warehouse-api-harness.mjs';

function setup(){
 const h=warehouseApiHarness();h.seedUser(1,null,'admin','boss');h.setting('warehouse_zones',[{id:'A',title:'A区',codes:['A1','B3']}]);
 const physical=h.stock('A1'),old=h.stock('B3');
 for(const [id,date,boxes,volume,order,marker] of [[physical,'2026-09-11',120,.03,'IB-LATE','右侧 #2'],[old,'2026-09-01',80,.02,'IB-OLD','左侧 #1']])h.sqlite.prepare("UPDATE stocks SET product='同款箱货',sku='CORE-1',customer_name='客户甲',inventory_unit='box',billing_mode='box',inbound_source='return',total_quantity=0,total_boxes=?,box_volume_m3=?,storage_rate_usd=.5,free_days=0,inbound_date=?,inbound_order=?,product_condition='good',product_prefix=? WHERE id=?").run(boxes,volume,date,order,marker,id);
 return {...h,physical,old};
}
const snapshot=h=>JSON.stringify(h.sqlite.prepare('SELECT * FROM stocks ORDER BY id').all());
const state=h=>JSON.parse(h.sqlite.prepare('SELECT value FROM goods_flow_state').get().value);
const totals=h=>h.sqlite.prepare('SELECT (SELECT COUNT(*) FROM goods_operations) operations,(SELECT COUNT(*) FROM audit_logs) logs,(SELECT COUNT(*) FROM storage_fee_settlements) fees').get();
async function payload(h){
 const d=(await h.call('goods')).data,c=d.choices.find(c=>c.members.some(r=>r.id===h.physical));
 return {requestId:crypto.randomUUID(),expectedRevision:d.revision,mode:'outbound',outboundDate:'2026-09-20',lines:[74,19].map((boxes,i)=>({lineId:'task-'+i,key:c.key,members:c.members.map(r=>({id:r.id,version:r.version})),quantity:0,boxes,outboundOrder:i===0?'  OUT-074  ':'',selected:[{id:h.physical,version:0,quantity:0,boxes}]}))};
}

test('independent: 74 + 19 box tasks share physical record, consume FIFO once, retain original cost snapshots and separate optional refs',async()=>{
 const h=setup();try{
  const p=await payload(h),r=await h.call('goods/document','POST',p);assert.equal(r.status,200,JSON.stringify(r.data));
  assert.deepEqual(r.data.lines.map(l=>[l.lineId,l.outboundOrder??'',l.stocks[0].totalQuantity,l.stocks[0].totalBoxes]),[['task-0','OUT-074',0,46],['task-1','',0,27]]);
  const stocks=h.sqlite.prepare('SELECT id,total_quantity,total_boxes,product_prefix,inbound_order FROM stocks ORDER BY id').all();assert.deepEqual(stocks.map(s=>[s.id,s.total_quantity,s.total_boxes,s.product_prefix,s.inbound_order]),[[h.physical,0,27,'右侧 #2','IB-LATE'],[h.old,0,80,'左侧 #1','IB-OLD']]);
  const fees=h.sqlite.prepare('SELECT stock_id,inbound_date,inbound_order,quantity,boxes,box_volume_m3 FROM storage_fee_settlements ORDER BY id').all();assert.deepEqual(fees.map(s=>[s.stock_id,s.inbound_date,s.inbound_order,s.quantity,s.boxes,s.box_volume_m3]),[[h.old,'2026-09-01','IB-OLD',0,74,.02],[h.old,'2026-09-01','IB-OLD',0,6,.02],[h.physical,'2026-09-11','IB-LATE',0,13,.03]]);
  const lots=state(h).categories[0].lots;assert.equal(lots.reduce((n,l)=>n+l.boxes,0),107);assert.equal(lots.find(l=>l.stockId===h.old).boxes,0);assert.equal(lots.find(l=>l.stockId===h.physical).snapshot.totalBoxes,120);
  const logs=h.sqlite.prepare("SELECT summary FROM audit_logs WHERE action='出库' ORDER BY id").all();assert.match(logs[0].summary,/出库单号 OUT-074/);assert.doesNotMatch(logs[1].summary,/OUT-074/);
  const before=snapshot(h),beforeCounts=totals(h),replay=await h.call('goods/document','POST',p);assert.equal(replay.status,200);assert.deepEqual(replay.data,r.data);assert.equal(snapshot(h),before);assert.deepEqual(totals(h),beforeCounts);
 }finally{h.sqlite.close();}
});

test('independent: individually valid picks exceeding sibling remaining balance reject entire document without operations or costs',async()=>{
 const h=setup();try{const p=await payload(h);p.lines.forEach((l,i)=>{l.boxes=i===0?119:2;l.selected[0].boxes=l.boxes;});const before=snapshot(h),r=await h.call('goods/document','POST',p);assert.equal(r.status,400,JSON.stringify(r.data));assert.equal(snapshot(h),before);assert.deepEqual({...totals(h)},{operations:0,logs:0,fees:0});assert.equal(state(h).categories.length,0);}finally{h.sqlite.close();}
});

test('independent: second task cannot forge an internally rebased version, metadata or duplicate line identity',async()=>{
 for(const mutate of [p=>p.lines[1].selected[0].version=1,p=>p.lines[1].members[0].version=1,p=>p.lines[1].outboundOrder={},p=>p.lines[1].outboundOrder='x'.repeat(501),p=>p.lines[1].lineId=' task-0 ']){
  const h=setup();try{const p=await payload(h);mutate(p);const before=snapshot(h),r=await h.call('goods/document','POST',p);assert.ok([400,409].includes(r.status),JSON.stringify(r.data));assert.equal(snapshot(h),before);assert.deepEqual({...totals(h)},{operations:0,logs:0,fees:0});}finally{h.sqlite.close();}
 }
});

test('independent: concurrent physical change rolls back all same-product tasks and costs',async()=>{
 const h=setup();try{const p=await payload(h);h.adapter.beforeBatch=()=>h.sqlite.prepare('UPDATE stocks SET version=version+1 WHERE id=?').run(h.physical);const r=await h.call('goods/document','POST',p);assert.equal(r.status,409,JSON.stringify(r.data));assert.deepEqual(h.sqlite.prepare('SELECT total_boxes FROM stocks ORDER BY id').all().map(r=>r.total_boxes),[120,80]);assert.deepEqual({...totals(h)},{operations:0,logs:0,fees:0});assert.equal(state(h).categories.length,0);}finally{h.sqlite.close();}
});

test('independent: reverse undo of both sibling tasks restores physical quantities and original FIFO costs, prevents replay',async()=>{
 const h=setup();try{const p=await payload(h),r=await h.call('goods/document','POST',p);assert.equal(r.status,200);const logs=h.sqlite.prepare("SELECT id FROM audit_logs WHERE action='出库' ORDER BY id").all();assert.equal((await h.call('movements','POST',{id:logs[0].id})).status,409,'earlier task must remain protected before later task undo');
  const second=await h.call('movements','POST',{id:logs[1].id});assert.equal(second.status,200,JSON.stringify(second.data));assert.equal(h.sqlite.prepare('SELECT total_boxes FROM stocks WHERE id=?').get(h.physical).total_boxes,46);
  const first=await h.call('movements','POST',{id:logs[0].id});assert.equal(first.status,200,JSON.stringify(first.data));assert.deepEqual(h.sqlite.prepare('SELECT total_quantity,total_boxes FROM stocks ORDER BY id').all().map(r=>[r.total_quantity,r.total_boxes]),[[0,120],[0,80]]);assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM storage_fee_settlements').get().n,0);assert.equal(state(h).categories.length,0);assert.equal((await h.call('goods/document','POST',p)).status,409);
 }finally{h.sqlite.close();}
});

test('independent: only the real unchanged undo successor permits earlier task undo; physical edits remain protected',async()=>{
 const h=setup();try{const p=await payload(h),r=await h.call('goods/document','POST',p);assert.equal(r.status,200);const logs=h.sqlite.prepare("SELECT id FROM audit_logs WHERE action='出库' ORDER BY id").all();assert.equal((await h.call('movements','POST',{id:logs[1].id})).status,200);h.sqlite.prepare("UPDATE stocks SET note='撤销后的实物核对备注',version=version+1 WHERE id=?").run(h.physical);const before=snapshot(h),beforeCounts=totals(h),blocked=await h.call('movements','POST',{id:logs[0].id});assert.equal(blocked.status,409,JSON.stringify(blocked.data));assert.equal(snapshot(h),before);assert.deepEqual(totals(h),beforeCounts);}finally{h.sqlite.close();}
});

test('independent: three same-product tasks can reverse undo across a later task using a different physical record',async()=>{
 const h=setup();try{const p=await payload(h),third={...structuredClone(p.lines[1]),lineId:'third',boxes:3,selected:[{id:h.old,version:0,quantity:0,boxes:3}]};p.lines.push(third);const r=await h.call('goods/document','POST',p);assert.equal(r.status,200,JSON.stringify(r.data));const logs=h.sqlite.prepare("SELECT id FROM audit_logs WHERE action='出库' ORDER BY id DESC").all();for(const log of logs){const restored=await h.call('movements','POST',{id:log.id});assert.equal(restored.status,200,JSON.stringify(restored.data));}assert.deepEqual(h.sqlite.prepare('SELECT total_quantity,total_boxes FROM stocks ORDER BY id').all().map(r=>[r.total_quantity,r.total_boxes]),[[0,120],[0,80]]);assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM storage_fee_settlements').get().n,0);}finally{h.sqlite.close();}
});

async function uiTasks(h){const c=(await h.call('goods')).data.choices[0];return [74,19].map((boxes,i)=>({lineId:'ui-'+i,choice:c,quantity:'0',boxes:String(boxes),outboundOrder:i===0?'REF-A':'REF-B',picks:{[h.physical]:{quantity:'0',boxes:String(boxes)}}}));}

test('independent: real outbound still rejects impossible calendar date without inventory or billing writes',async()=>{
 const h=setup();try{const p=await payload(h);p.outboundDate='2026-02-30';const before=snapshot(h),r=await h.call('goods/document','POST',p);assert.equal(r.status,400,JSON.stringify(r.data));assert.equal(snapshot(h),before);assert.deepEqual({...totals(h)},{operations:0,logs:0,fees:0});}finally{h.sqlite.close();}
});
test('independent: copied messages contain only each task locations and amounts without inventory or billing writes',async()=>{
 const h=setup();try{const helpers=h.load(resolve('lib/goods-operation-input.ts')),tasks=await uiTasks(h),before=snapshot(h),messages=tasks.map((t,i)=>helpers.formatOutboundTaskMessage(t,'2026-09-20',i+1,tasks));assert.deepEqual(messages,['产品位于：A1 1层（拿74箱）','产品位于：A1 1层（拿19箱）']);assert.equal(snapshot(h),before);assert.deepEqual({...totals(h)},{operations:0,logs:0,fees:0});}finally{h.sqlite.close();}
});
test('independent: copy does not require a date and rejects every invalid allocation, including zero-like hidden picks',async()=>{
 const h=setup();try{const helpers=h.load(resolve('lib/goods-operation-input.ts')),tasks=await uiTasks(h);for(const date of ['','2026-02-30','invalid'])assert.equal(helpers.formatOutboundTaskMessage(tasks[0],date,1,tasks),'产品位于：A1 1层（拿74箱）');
  for(const invalid of ['junk','','-1','0.5']){const bad=structuredClone(tasks);bad[0].picks[h.old]={quantity:invalid,boxes:'0'};assert.throws(()=>helpers.formatOutboundTaskMessage(bad[0],'2026-09-20',1,bad),/分配|数量/);}
  const incomplete=structuredClone(tasks);delete incomplete[0].picks[h.physical];assert.throws(()=>helpers.formatOutboundTaskMessage(incomplete[0],'2026-09-20',1,incomplete),/分配/);
  const stale=structuredClone(tasks);stale[0].picks[99999]={quantity:'0',boxes:'0'};assert.throws(()=>helpers.formatOutboundTaskMessage(stale[0],'2026-09-20',1,stale),/分配.*变化/);
  const over=structuredClone(tasks);over[1].picks[h.physical].boxes='47';over[1].boxes='47';assert.throws(()=>helpers.formatOutboundTaskMessage(over[0],'2026-09-20',1,over),/重复分配|超过/);
  const badSibling=structuredClone(tasks);badSibling[1].picks[h.physical].boxes='-50';assert.ok(helpers.availableOutboundMembers(badSibling[0],badSibling).every(r=>r.totalBoxes<=tasks[0].choice.members.find(s=>s.id===r.id).totalBoxes));
 }finally{h.sqlite.close();}
});
