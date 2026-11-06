import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {warehouseApiHarness} from './helpers/warehouse-api-harness.mjs';
const refs=p=>p.members.map(r=>({id:r.id,version:r.version}));
function setup(q=1,b=7,source='return',unit='item'){
 const h=warehouseApiHarness();h.seedUser(1,null,'admin','boss');h.setting('warehouse_zones',[{id:'NEW_A',title:'A区',codes:['A1','A2']}]);const id=h.stock('A1');
 h.sqlite.prepare("UPDATE stocks SET product='真空封口机 黑',customer_name='客户A',sku='RETURN-1',inbound_date='2026-04-17',total_quantity=?,total_boxes=?,inbound_source=?,inventory_unit=?,billing_mode='item',item_volume_m3=.001,storage_rate_usd=.5,free_days=0 WHERE id=?").run(q,b,source,unit,id);return{h,id};
}
async function dispatch(h,id,q,b){const c=(await h.call('goods')).data,p=c.choices.find(p=>p.members.some(r=>r.id===id));return h.call('goods/outbound','POST',{requestId:randomUUID(),key:p.key,expectedRevision:c.revision,members:refs(p),quantity:q,boxes:b,outboundDate:'2026-10-14',selected:[{id,version:p.members.find(r=>r.id===id).version,quantity:q,boxes:b}]});}
const stock=(h,id)=>h.sqlite.prepare('SELECT total_quantity,total_boxes FROM stocks WHERE id=?').get(id);
test('退货1件出完，即使请求未填包装7箱也同时清零；计费仅1件，重试与撤销不漏箱',async()=>{
 const{h,id}=setup();try{const r=await dispatch(h,id,1,0);assert.equal(r.status,200,JSON.stringify(r.data));assert.deepEqual({...stock(h,id)},{total_quantity:0,total_boxes:0});
 assert.equal(r.data.boxes,7);assert.equal(r.data.automaticClearedBoxes,7);
 const fees=h.sqlite.prepare('SELECT quantity,boxes,fee_usd FROM storage_fee_settlements').all();assert.equal(fees.reduce((n,x)=>n+x.quantity,0),1);assert.equal(fees.reduce((n,x)=>n+x.boxes,0),7);assert.equal(fees.reduce((n,x)=>n+x.fee_usd,0),.09);
 const log=h.sqlite.prepare("SELECT * FROM audit_logs WHERE action='出库'").get();assert.match(log.summary,/箱数 -7/);assert.equal((await h.call('movements','POST',{id:log.id})).status,200);assert.deepEqual({...stock(h,id)},{total_quantity:1,total_boxes:7});assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM storage_fee_settlements').get().n,0);
 }finally{h.sqlite.close();}
});
test('截图0件7箱经修正补1件，两个计价段可一起出库；辅助箱段不阻止出库、不收费',async()=>{
 const{h,id}=setup(0,7);try{const info=(await h.call('goods/correction?stockId='+id)).data;const fixed=await h.call('goods/correction','POST',{requestId:randomUUID(),stockId:id,expectedRevision:info.revision,members:info.members,newQuantity:1,newBoxes:7,effectiveDate:'2026-04-17',confirmed:true,pricingSource:'product',lotId:''});assert.equal(fixed.status,200,JSON.stringify(fixed.data));
 const r=await dispatch(h,id,1,7);assert.equal(r.status,200,JSON.stringify(r.data));assert.deepEqual({...stock(h,id)},{total_quantity:0,total_boxes:0});const fees=h.sqlite.prepare('SELECT quantity,boxes,fee_usd FROM storage_fee_settlements').all();assert.equal(fees.length,2);assert.ok(fees.some(x=>x.quantity===0&&x.boxes===7&&x.fee_usd===0));assert.equal(fees.reduce((n,x)=>n+x.quantity,0),1);
 const report=await h.call('pricing/report?asOf=2026-10-14');assert.equal(report.status,200,JSON.stringify(report.data));assert.equal(report.data.inStockItems.length,0);
 }finally{h.sqlite.close();}
});
test('旧0件7箱可只出辅助箱；件数不被推算，未知每件体积不阻塞零件辅助记录',async()=>{
 const{h,id}=setup(0,7);try{h.sqlite.prepare('UPDATE stocks SET item_volume_m3=0 WHERE id=?').run(id);const r=await dispatch(h,id,0,7);assert.equal(r.status,200,JSON.stringify(r.data));assert.deepEqual({...stock(h,id)},{total_quantity:0,total_boxes:0});const fee=h.sqlite.prepare('SELECT quantity,boxes,fee_usd FROM storage_fee_settlements').get();assert.deepEqual({...fee},{quantity:0,boxes:7,fee_usd:0});}finally{h.sqlite.close();}
});
test('退货部分出件不清余箱，国内件库存和独立箱库存不跟随清零',async()=>{
 for(const [q,b,source,unit,take,expectedQ,expectedB] of [[10,7,'return','item',3,7,7],[1,7,'domestic','item',1,0,7],[0,7,'domestic','box',0,0,6]]){const{h,id}=setup(q,b,source,unit);try{const r=await dispatch(h,id,take,unit==='box'?1:0);assert.equal(r.status,200,JSON.stringify(r.data));assert.deepEqual({...stock(h,id)},{total_quantity:expectedQ,total_boxes:expectedB});}finally{h.sqlite.close();}}
});
test('同产品两条任务依次出完同库位，最后一条清箱；过量出库整单拒绝',async()=>{
 for(const total of [10,11]){const{h,id}=setup(10,7);try{const c=(await h.call('goods')).data,p=c.choices[0],line=q=>({key:p.key,members:refs(p),quantity:q,boxes:0,selected:[{id,version:p.members[0].version,quantity:q,boxes:0}]});const r=await h.call('goods/document','POST',{requestId:randomUUID(),mode:'outbound',expectedRevision:c.revision,outboundDate:'2026-10-14',lines:[line(4),line(total-4)]});assert.equal(r.status,total===10?200:400,JSON.stringify(r.data));assert.deepEqual({...stock(h,id)},total===10?{total_quantity:0,total_boxes:0}:{total_quantity:10,total_boxes:7});if(total===10){assert.equal(r.data.lines[0].boxes,0);assert.equal(r.data.lines[1].boxes,7);}}finally{h.sqlite.close();}}
});
test('独立退货箱库存按件计价的矛盾仍须核对，不把箱库存冒充辅助包装',async()=>{
 const{h,id}=setup(0,7,'return','box');try{const r=await dispatch(h,id,0,7);assert.equal(r.status,400);assert.match(r.data.error,/独立箱库存/);assert.deepEqual({...stock(h,id)},{total_quantity:0,total_boxes:7});}finally{h.sqlite.close();}
});
test('前台派生分配与后台一致：全出自动合箱、改部分恢复原手填，多个任务最后一单清箱',()=>{
 const{h,id}=setup(10,7);try{
 const normalize=h.load('lib/return-packaging.ts').normalizeReturnPackagingLines;
 const row={id,totalQuantity:10,totalBoxes:7,inboundSource:'return',inventoryUnit:'item'},choice={key:'one',members:[row]};
 const line=q=>({lineId:randomUUID(),choice,quantity:String(q),boxes:'0',picks:{[id]:{quantity:String(q),boxes:'0'}},placements:[],receipt:{inboundSource:'return'},inventoryUnit:'item'});
 const raw=[line(10)],full=normalize(raw,'outbound');assert.equal(full[0].boxes,'7');assert.equal(full[0].picks[id].boxes,'7');assert.equal(raw[0].boxes,'0');
 raw[0].quantity='3';raw[0].picks[id].quantity='3';const partial=normalize(raw,'outbound');assert.equal(partial[0].boxes,'0');assert.equal(partial[0].picks[id].boxes,'0');
 const tasks=normalize([line(4),line(6)],'outbound');assert.deepEqual(Array.from(tasks,l=>l.boxes),['0','7']);
 const inbound=normalize([{...line(5),boxes:'4',placements:[{boxes:'4',quantity:'5'}]}],'inbound');assert.equal(inbound[0].boxes,'0');assert.equal(inbound[0].placements[0].boxes,'0');
 }finally{h.sqlite.close();}
});
