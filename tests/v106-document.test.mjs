import assert from 'node:assert/strict';
import test from 'node:test';
import {warehouseApiHarness} from './helpers/warehouse-api-harness.mjs';

function fresh({oldBoxes=0,available=100}={}){
 const h=warehouseApiHarness();h.seedUser(1,null,'admin','boss');
 h.setting('warehouse_zones',[{id:'NEW_A',title:'A区',codes:['A1','A2']}]);
 const add=(code,date,boxes)=>{const id=h.stock(code);h.sqlite.prepare("UPDATE stocks SET product='同款饭盒',customer_name='客户A',inbound_date=?,total_quantity=0,total_boxes=?,inventory_unit='box',billing_mode='box',inbound_source='return',box_volume_m3=.1,storage_rate_usd=.5,free_days=0 WHERE id=?").run(date,boxes,id);return id};
 if(oldBoxes)add('A1','2026-06-01',oldBoxes);
 h.pickId=add('A2','2026-08-01',available);return h;
}
async function payload(h,{lineIds=true,boxes=[74,19]}={}){
 const c=(await h.call('goods')).data,choice=c.choices[0],pick=choice.members.find(r=>r.id===h.pickId);
 return{requestId:crypto.randomUUID(),expectedRevision:c.revision,mode:'outbound',outboundDate:'2026-09-10',lines:boxes.map((count,i)=>({...(lineIds?{lineId:`line-${i+1}`} :{}),key:choice.key,members:choice.members.map(r=>({id:r.id,version:r.version})),quantity:0,boxes:count,outboundOrder:i?'ORDER-19':'ORDER-74',selected:[{id:pick.id,version:pick.version,quantity:0,boxes:count}]}))};
}
const dump=h=>JSON.stringify(['stocks','goods_flow_state','goods_operations','audit_logs','storage_fee_settlements','goods_transaction_guards'].map(table=>h.sqlite.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()));
const physical=h=>h.sqlite.prepare('SELECT total_quantity,total_boxes,version FROM stocks WHERE id=?').get(h.pickId);

test('V106 same box product can ship separate 74 and 19 box orders from one physical row',async()=>{
 const h=fresh();try{const p=await payload(h),r=await h.call('goods/document','POST',p);assert.equal(r.status,200,JSON.stringify(r.data));
  assert.deepEqual({...physical(h)},{total_quantity:0,total_boxes:7,version:2});
  assert.deepEqual(r.data.lines.map(l=>[l.lineId,l.outboundOrder,l.stocks[0].totalBoxes,l.stocks[0].version]),[['line-1','ORDER-74',26,1],['line-2','ORDER-19',7,2]]);
  assert.equal(new Set(r.data.operationIds).size,2);assert.equal(new Set(r.data.lines.map(l=>l.categoryId)).size,1);
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM goods_operations').get().n,3);
  assert.equal(h.sqlite.prepare('SELECT revision FROM goods_flow_state').get().revision,1);
  const logs=h.sqlite.prepare("SELECT operation_id,summary FROM audit_logs WHERE action='出库' ORDER BY id").all();
  assert.deepEqual(logs.map(l=>l.operation_id),r.data.operationIds);assert.ok(logs[0].summary.includes('ORDER-74'));assert.ok(logs[1].summary.includes('ORDER-19'));
  assert.deepEqual(h.sqlite.prepare("SELECT result FROM goods_operations WHERE kind='outbound' ORDER BY id").all().map(o=>JSON.parse(o.result).outboundOrder),['ORDER-74','ORDER-19']);
  const before=dump(h),retry=await h.call('goods/document','POST',p);assert.equal(retry.status,200);assert.deepEqual(retry.data,r.data);assert.equal(dump(h),before);
 }finally{h.sqlite.close()}
});

test('V106 repeated product pricing consumes remaining FIFO lots separately from chosen physical row',async()=>{
 const h=fresh({oldBoxes:30});try{const r=await h.call('goods/document','POST',await payload(h));assert.equal(r.status,200,JSON.stringify(r.data));
  assert.deepEqual(r.data.lines.map(l=>l.billingAllocations.map(a=>[a.inboundDate,a.boxes])),[[['2026-06-01',30],['2026-08-01',44]],[['2026-08-01',19]]]);
  assert.deepEqual(h.sqlite.prepare('SELECT inbound_date,quantity,boxes,fee_usd FROM storage_fee_settlements ORDER BY id').all().map(s=>[s.inbound_date,s.quantity,s.boxes,s.fee_usd]),[['2026-06-01',0,30,151.5],['2026-08-01',0,44,88],['2026-08-01',0,19,38]]);
  assert.deepEqual(h.sqlite.prepare('SELECT total_boxes FROM stocks ORDER BY id').all().map(r=>r.total_boxes),[30,7]);
  const category=JSON.parse(h.sqlite.prepare('SELECT value FROM goods_flow_state').get().value).categories[0];assert.equal(category.lots.reduce((n,l)=>n+l.boxes,0),37);
 }finally{h.sqlite.close()}
});

test('V106 combined repeated allocation cannot overdraw and leaves no partial document',async()=>{
 const h=fresh({available:90});try{const before=dump(h),r=await h.call('goods/document','POST',await payload(h));assert.equal(r.status,400,JSON.stringify(r.data));assert.match(r.data.error,/超过可用库存/);assert.equal(dump(h),before)}finally{h.sqlite.close()}
});

test('V106 original snapshot validation rejects stale second member or selected version atomically',async()=>{
 for(const field of ['members','selected']){const h=fresh();try{const p=await payload(h);p.lines[1][field][0].version++;const before=dump(h),r=await h.call('goods/document','POST',p);assert.equal(r.status,409,JSON.stringify(r.data));assert.equal(dump(h),before)}finally{h.sqlite.close()}}
});

test('V106 concurrent inventory write returns 409 with no document rows or settlements',async()=>{
 const h=fresh();try{const p=await payload(h);h.adapter.beforeBatch=()=>h.sqlite.prepare('UPDATE stocks SET version=version+1 WHERE id=?').run(h.pickId);const r=await h.call('goods/document','POST',p);assert.equal(r.status,409,JSON.stringify(r.data));assert.deepEqual({...physical(h)},{total_quantity:0,total_boxes:100,version:1});
  for(const table of ['goods_operations','audit_logs','storage_fee_settlements','goods_transaction_guards'])assert.equal(h.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0);assert.equal(h.sqlite.prepare('SELECT revision FROM goods_flow_state').get().revision,0);
 }finally{h.sqlite.close()}
});

test('V106 older outbound callers can omit line IDs and order references',async()=>{
 const h=fresh();try{const p=await payload(h,{lineIds:false});p.lines.forEach(l=>delete l.outboundOrder);const r=await h.call('goods/document','POST',p);assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(physical(h).total_boxes,7);assert.ok(r.data.lines.every(l=>l.outboundOrder===undefined&&l.lineId===undefined))}finally{h.sqlite.close()}
});

test('V106 supplied duplicate line IDs or invalid order references reject atomically',async()=>{
 for(const change of [p=>p.lines[1].lineId=p.lines[0].lineId,p=>p.lines[1].outboundOrder=42,p=>p.lines[1].outboundOrder='X'.repeat(501)]){const h=fresh();try{const p=await payload(h);change(p);const before=dump(h),r=await h.call('goods/document','POST',p);assert.equal(r.status,400,JSON.stringify(r.data));assert.equal(dump(h),before)}finally{h.sqlite.close()}}
});

test('V106 same inbound product remains rejected while repeated outbound keeps undo dependencies',async()=>{
 const h=fresh();try{const p=await payload(h),inbound={...p,mode:'inbound',receipt:{inboundDate:'2026-09-01'},lines:p.lines.map(l=>({...l,inventoryUnit:'box',receipt:{inboundSource:'domestic',billingMode:'box',boxVolumeM3:.1},placements:[{locationCode:'A1',layerCount:1,quantity:0,boxes:l.boxes}]}))};
  const before=dump(h);assert.equal((await h.call('goods/document','POST',inbound)).status,400);assert.equal(dump(h),before);
  const r=await h.call('goods/document','POST',p);assert.equal(r.status,200,JSON.stringify(r.data));const logs=h.sqlite.prepare("SELECT id FROM audit_logs WHERE action='出库' ORDER BY id").all();const after=dump(h);
  assert.equal((await h.call('movements','POST',{id:logs[0].id})).status,409);assert.equal(dump(h),after);
  assert.equal((await h.call('movements','POST',{id:logs[1].id})).status,200);assert.equal(physical(h).total_boxes,26);assert.equal(h.sqlite.prepare('SELECT SUM(boxes) n FROM storage_fee_settlements').get().n,74);assert.equal((await h.call('goods/document','POST',p)).status,409);
  const first=await h.call('movements','POST',{id:logs[0].id});assert.equal(first.status,200,JSON.stringify(first.data));assert.equal(physical(h).total_boxes,100);assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM storage_fee_settlements').get().n,0);assert.equal(JSON.parse(h.sqlite.prepare('SELECT value FROM goods_flow_state').get().value).categories.length,0);
 }finally{h.sqlite.close()}
});

test('V106 three repeated outbound lines reverse in order with monotonically increasing versions',async()=>{
 const h=fresh();try{const r=await h.call('goods/document','POST',await payload(h,{boxes:[40,30,20]}));assert.equal(r.status,200);const logs=h.sqlite.prepare("SELECT id FROM audit_logs WHERE action='出库' ORDER BY id").all();
  for(const [i,boxes] of [30,60,100].entries()){const undo=await h.call('movements','POST',{id:logs[2-i].id});assert.equal(undo.status,200,JSON.stringify(undo.data));assert.equal(physical(h).total_boxes,boxes);assert.equal(physical(h).version,4+i);}
 }finally{h.sqlite.close()}
});

test('V106 actual edit after later line undo cannot impersonate the document restore chain',async()=>{
 for(const change of ['note','version']){const h=fresh();try{const r=await h.call('goods/document','POST',await payload(h));assert.equal(r.status,200);const logs=h.sqlite.prepare("SELECT id FROM audit_logs WHERE action='出库' ORDER BY id").all();assert.equal((await h.call('movements','POST',{id:logs[1].id})).status,200);
  if(change==='note')h.sqlite.prepare("UPDATE stocks SET note='后续实际编辑',version=version+1 WHERE id=?").run(h.pickId);else h.sqlite.prepare('UPDATE stocks SET version=version+1 WHERE id=?').run(h.pickId);
  const before=dump(h),undo=await h.call('movements','POST',{id:logs[0].id});assert.equal(undo.status,409,JSON.stringify(undo.data));assert.equal(dump(h),before);
 }finally{h.sqlite.close()}}
});
