import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {warehouseApiHarness} from './helpers/warehouse-api-harness.mjs';

const refs=c=>c.members.map(s=>({id:s.id,version:s.version}));
const stocks=h=>h.sqlite.prepare('SELECT * FROM stocks ORDER BY id').all();
const categories=h=>JSON.parse(h.sqlite.prepare('SELECT value FROM goods_flow_state WHERE id=1').get().value).categories;
async function setup(mode='item'){
 const h=warehouseApiHarness();h.seedUser(1,null,'admin','piece-inbound');h.setting('warehouse_zones',[{id:'NEW_A',title:'A区',codes:['A1','A2']}]);
 const c=(await h.call('goods','POST',{requestId:randomUUID(),expectedRevision:0,customerName:'退货客户',product:'退货计件测试',sku:'RETURN-PIECES',productSpec:{billingMode:mode,itemVolumeM3:.002,boxVolumeM3:.06}}));assert.equal(c.status,200,JSON.stringify(c.data));
 const context=(await h.call('goods')).data,choice=context.choices[0];
 const body={requestId:randomUUID(),expectedRevision:context.revision,key:choice.key,members:refs(choice),inventoryUnit:'item',quantity:7,boxes:3,receipt:{inboundDate:'2026-10-01',inboundSource:'return',productCondition:'good'},placements:[{locationCode:'A1',layerCount:1,quantity:4,boxes:2},{locationCode:'A2',layerCount:2,quantity:3,boxes:1,productCondition:'damaged'}]};
 return{h,body};
}

test('退货件入库忽略旧草稿包装箱数，库位和成本快照只新增件数，重试/撤销完整',async()=>{
 const{h,body}=await setup();try{
  const before=structuredClone(categories(h)),r=await h.call('goods/inbound','POST',body);assert.equal(r.status,200,JSON.stringify(r.data));assert.deepEqual(r.data.stocks.map(s=>[s.totalQuantity,s.totalBoxes,s.inventoryUnit]),[[4,0,'item'],[3,0,'item']]);
  assert.deepEqual(stocks(h).map(s=>[s.total_quantity,s.total_boxes]),[[4,0],[3,0]]);assert.ok(categories(h)[0].lots.every(l=>l.boxes===0&&l.snapshot.totalBoxes===0));assert.deepEqual((await h.call('goods/inbound','POST',body)).data,r.data);
  const log=h.sqlite.prepare('SELECT id FROM audit_logs WHERE operation_id=?').get(body.requestId);assert.equal((await h.call('movements','POST',{id:log.id})).status,200);assert.equal(stocks(h).length,0);assert.deepEqual(categories(h),before);
 }finally{h.sqlite.close();}
});

test('旧入库请求未指定单位但退货按件记录，残留箱数也清零，零件不能用箱数绕过',async()=>{
 for(const quantity of [7,0]){const{h,body}=await setup();try{
  delete body.inventoryUnit;body.quantity=quantity;body.placements=[{locationCode:'A1',layerCount:1,quantity,boxes:3}];const r=await h.call('goods/inbound','POST',body);assert.equal(r.status,quantity?200:400,JSON.stringify(r.data));assert.equal(stocks(h).length,quantity?1:0);if(quantity)assert.equal(stocks(h)[0].total_boxes,0);
 }finally{h.sqlite.close();}}
});

test('国内和无来源件库存包装箱数保留，明确箱库存退货数量及箱计费不被清掉',async()=>{
 for(const source of ['domestic','unspecified']){const{h,body}=await setup();try{body.receipt.inboundSource=source;const r=await h.call('goods/inbound','POST',body);assert.equal(r.status,200,JSON.stringify(r.data));assert.deepEqual(stocks(h).map(s=>s.total_boxes),[2,1]);assert.deepEqual(categories(h)[0].lots.map(l=>l.boxes),[2,1]);}finally{h.sqlite.close();}}
 const{h,body}=await setup('box');try{body.inventoryUnit='box';body.quantity=0;body.boxes=5;body.placements=[{locationCode:'A1',layerCount:1,quantity:0,boxes:5}];const r=await h.call('goods/inbound','POST',body);assert.equal(r.status,200,JSON.stringify(r.data));assert.deepEqual(r.data.stocks.map(s=>[s.totalQuantity,s.totalBoxes,s.inventoryUnit,s.billingMode]),[[0,5,'box','box']]);assert.equal(categories(h)[0].lots[0].boxes,5);}finally{h.sqlite.close();}
});

test('整张退货件入库旧草稿总箱数或分配箱数残留/不一致时统一归零',async()=>{
 for(const source of ['both','total','placements']){const{h,body}=await setup();try{
  if(source==='total')body.placements.forEach(p=>p.boxes=0);if(source==='placements')body.boxes=0;
  const r=await h.call('goods/document','POST',{requestId:randomUUID(),mode:'inbound',expectedRevision:body.expectedRevision,receipt:{inboundDate:body.receipt.inboundDate},lines:[body]});assert.equal(r.status,200,JSON.stringify(r.data));assert.deepEqual(stocks(h).map(s=>s.total_boxes),[0,0]);assert.ok(categories(h)[0].lots.every(l=>l.boxes===0));
 }finally{h.sqlite.close();}}
});

test('退货件入库碰到按箱计费资料时明确提示核对，不偷偷改变计价方式或建立零费记录',async()=>{
 const{h,body}=await setup('box');try{const r=await h.call('goods/inbound','POST',body);assert.equal(r.status,400,JSON.stringify(r.data));assert.match(r.data.error,/当前按箱计费.*仓储计价.*按件/);assert.equal(stocks(h).length,0);assert.equal(categories(h)[0].lots.length,0);assert.equal(categories(h)[0].productSpec.billingMode,'box');}finally{h.sqlite.close();}
});
