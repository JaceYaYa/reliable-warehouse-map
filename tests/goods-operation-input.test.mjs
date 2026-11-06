import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {warehouseApiHarness} from './helpers/warehouse-api-harness.mjs';
const helpers=warehouseApiHarness().load(resolve('lib/goods-operation-input.ts'));
const locationSearch=warehouseApiHarness().load(resolve('lib/location-code.ts'));
test('库位检索优先精确与前缀、自然排序，只返回已有库位；部分匹配不能当作已选择',()=>{
 const codes=['B1','A20','A2','A1','旧A1','A1'];
 assert.deepEqual(Array.from(locationSearch.searchLocationCodes(codes,' ａ１ ')),['A1','旧A1']);
 assert.deepEqual(Array.from(locationSearch.searchLocationCodes(codes,'A2')),['A2','A20']);
 assert.equal(locationSearch.matchingLocationCodes(codes,'A').length,0);
 assert.deepEqual(Array.from(locationSearch.searchLocationCodes(codes,'不存在')),[]);
 assert.deepEqual(Array.from(locationSearch.searchLocationCodes(codes,'')),[]);
 assert.deepEqual(codes,['B1','A20','A2','A1','旧A1','A1']);
});
const stock=(id,values={})=>({id,product:'饭盒',sku:'',barcode:'',productPrefix:'',productCondition:'',totalQuantity:10,totalBoxes:2,...values});
const choice=(key,values={})=>({key,product:'饭盒',customerName:'客户A',sku:'',barcode:'',members:[stock(1)],quantity:10,boxes:2,review:false,reason:'',...values});
const data=[choice('one',{sku:'SKU1',barcode:'CODE1 / CODE2'}),choice('two',{product:'耳机',sku:'SKU2',members:[stock(2,{product:'耳机'})]}),choice('other',{customerName:'客户B',sku:'OTHER'})];
test('全部客户批量添加保留各自归属，同码跨客户保持歧义',()=>{
 const rows=helpers.parseGoodsImport('SKU1\t2\t0\nOTHER\t3\t0',data,'','inbound');
 assert(rows.every(r=>!r.error));assert.deepEqual(Array.from(helpers.importedGoods(rows),r=>r.choice.customerName),['客户A','客户B']);
 const sameCode=choice('same',{customerName:'客户B',sku:'SKU1'});
 assert.match(helpers.parseGoodsImport('SKU1\t2\t0',[...data,sameCode],'','inbound')[0].error,/找到 2 项/);
 assert.equal(helpers.parseGoodsImport('SKU1\t2\t0',[...data,sameCode],'客户B','inbound')[0].choice.key,'same');
});
test('批量添加只匹配所选客户，条码别名和大小写兼容，未知与歧义逐行保留',()=>{
  const duplicate=choice('dup',{sku:'DIFFERENT'}),rows=helpers.parseGoodsImport('code2\t3\t1\n饭盒\t2\t0\nOTHER\t1\t0\n未知\t4\t0',[...data,duplicate],'客户A','inbound');
  assert.equal(rows[0].choice.key,'one');assert.equal(rows[0].error,'');assert.match(rows[1].error,/找到 2 项/);assert.match(rows[2].error,/未找到/);assert.match(rows[3].error,/未找到/);assert.equal(helpers.importedGoods(rows).length,1);
});
test('批量重复行合计；手填草稿永不被覆盖；部分出库禁止合计超库存',()=>{
  const rows=helpers.parseGoodsImport('SKU1 | 4 | 1\nCODE1 | 3 | 1',data,'客户A','outbound');assert.deepEqual(JSON.parse(JSON.stringify(helpers.importedGoods(rows))).map(row=>[row.quantity,row.boxes]),[[7,2]]);
  assert.match(helpers.parseGoodsImport('SKU1\t4\t1',data,'客户A','inbound',['one'])[0].error,/原填写已保留/);
  assert(helpers.parseGoodsImport('SKU1\t6\t1\nSKU1\t6\t1',data,'客户A','outbound').every(row=>row.error.includes('超过')));
});
test('缺少数量、负数、小数、空白箱数和待核对产品拒绝加入；零件数整箱可加入',()=>{
  for(const input of ['SKU1','SKU1\t\t1','SKU1\t-1\t0','SKU1\t1.5\t0','SKU1\t3\t','SKU1\t0\t0'])assert(helpers.parseGoodsImport(input,data,'客户A','inbound')[0].error,input);
  assert.equal(helpers.parseGoodsImport('SKU1\t0\t2',data,'客户A','outbound')[0].error,'');
  assert.match(helpers.parseGoodsImport('BLOCK\t1\t0',[choice('block',{sku:'BLOCK',review:true,reason:'SKU 冲突'})],'客户A','inbound')[0].error,/SKU 冲突/);
});
test('扫码多个 SKU 同码保持歧义；产品精确名不会跨客户匹配',()=>{
  assert.equal(helpers.exactOperationMatches([choice('a',{sku:'X'}),choice('b',{sku:'X'})],'X').length,2);
  assert.equal(helpers.operationChoices(data,'客户A','inbound').length,2);
  assert.equal(helpers.operationChoices([choice('zero',{quantity:0,boxes:0})],'客户A','outbound').length,0);
});
test('正品、残次品和未标注分别筛实际库存，历史残次品前缀仍识别',()=>{
  const good=stock(1,{productCondition:'good'}),bad=stock(2,{product:'残次品：饭盒'}),unknown=stock(3);
  assert.equal(helpers.matchesPickCondition(good,'good'),true);assert.equal(helpers.matchesPickCondition(bad,'damaged'),true);assert.equal(helpers.matchesPickCondition(unknown,'good'),false);assert.equal(helpers.matchesPickCondition(unknown,'unmarked'),true);assert.equal(helpers.matchesPickCondition(bad,'all'),true);
});
test('按手选库位填剩余尊重其他分配、库存上限与件箱独立',()=>{
  assert.deepEqual(JSON.parse(JSON.stringify(helpers.remainingPick(stock(1),{quantity:12,boxes:3},{quantity:5,boxes:3}))),{quantity:'7',boxes:'0'});
  assert.deepEqual(JSON.parse(JSON.stringify(helpers.remainingPick(stock(1),{quantity:50,boxes:50},{quantity:0,boxes:0}))),{quantity:'10',boxes:'2'});
});

test('完成出库分配将实际件箱合计回填，可增减原计划并保护共享库存',()=>{
 const c=choice('one',{members:[stock(1,{locationCode:'A1'}),stock(2,{locationCode:'A2',totalQuantity:8,totalBoxes:3})],quantity:18,boxes:5});
 const l={lineId:'a',choice:c,quantity:'3',boxes:'1',picks:{1:{quantity:'6',boxes:'2'},2:{quantity:'2',boxes:'1'}}};
 const done=helpers.completeOutboundAllocation(l,[l]);assert.equal(done.quantity,'8');assert.equal(done.boxes,'3');assert.equal(l.quantity,'3');
 const reduced={...l,picks:{1:{quantity:'1',boxes:'0'}}};assert.equal(helpers.completeOutboundAllocation(reduced,[reduced]).quantity,'1');
 const sibling={...l,lineId:'b',quantity:'4',boxes:'0',picks:{1:{quantity:'4',boxes:'0'}}};
 assert.throws(()=>helpers.completeOutboundAllocation({...l,picks:{1:{quantity:'7',boxes:'0'}}},[l,sibling]),/超过|重复/);
 for(const quantity of ['','-1','1.5','NaN'])assert.throws(()=>helpers.completeOutboundAllocation({...l,picks:{1:{quantity,boxes:'0'}}},[l]),/整数|无效/);
 assert.throws(()=>helpers.completeOutboundAllocation({...l,picks:{}},[l]),/分配|数量/);
});
test('清空当前单保留计划，待出库仅用所属实物，加入时扣除其他单占用并明确25行上限',()=>{
 const c=choice('one',{members:[stock(1),stock(2)],quantity:20,boxes:4});const l={lineId:'a',choice:c,quantity:'6',boxes:'1',picks:{1:{quantity:'6',boxes:'1'}}};
 const cleared=helpers.clearOutboundAllocation(l);assert.deepEqual(JSON.parse(JSON.stringify(cleared.picks)),{});assert.equal(cleared.quantity,'6');assert.equal(l.picks[1].quantity,'6');
 const staged={...l,allowedStockIds:[2]};assert.deepEqual(Array.from(helpers.availableOutboundMembers(staged,[staged]),r=>r.id),[2]);
 assert.throws(()=>helpers.completeOutboundAllocation({...staged,picks:l.picks},[staged]),/待出库|所属/);
 const tasks=[{id:'s1',lineId:'origin-a',outboundOrder:'单号A',key:'one',product:'饭盒',customerName:'客户A',members:[stock(1)],quantity:10,boxes:2},{id:'s2',lineId:'origin-b',outboundOrder:'单号B',key:'one',product:'饭盒',customerName:'客户A',members:[stock(2)],quantity:10,boxes:2}];
 const plans=helpers.planStagedTaskAddition(tasks,[l]);assert.equal(plans[0].quantity,4);assert.equal(plans[0].boxes,1);assert.equal(plans[1].task.outboundOrder,'单号B');
 assert.equal(helpers.planStagedTaskAddition(tasks,[{...l,stagingTaskId:'s1'}]).length,1);
 assert.throws(()=>helpers.planStagedTaskAddition(tasks,Array.from({length:24},(_,i)=>({...l,lineId:String(i),picks:{}}))),/25|分批/);
});

test('完成分配在退货最后一件自动清箱后再回填，待出库所属限制也用于提交前冲突检查',()=>{
 const c=choice('one',{members:[stock(1,{locationCode:'A1',inventoryUnit:'item',inboundSource:'return',totalQuantity:10,totalBoxes:7})],quantity:10,boxes:7});
 const l={lineId:'a',choice:c,quantity:'4',boxes:'0',picks:{1:{quantity:'10',boxes:'0'}}};
 const done=helpers.completeOutboundAllocation(l,[l]);assert.equal(done.quantity,'10');assert.equal(done.boxes,'7');assert.equal(done.picks[1].boxes,'7');
 assert.match(helpers.outboundTaskConflict({...done,allowedStockIds:[2]},[{...done,allowedStockIds:[2]}]),/所属|待出库/);
});
