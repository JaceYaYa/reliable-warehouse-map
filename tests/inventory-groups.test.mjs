import test from 'node:test';
import assert from 'node:assert/strict';
import {warehouseApiHarness} from './helpers/warehouse-api-harness.mjs';
const h=warehouseApiHarness(),{groupInventory,filterInventory,splitInventoryPrefix}=h.load('lib/inventory-groups.ts');h.sqlite.close();
const row=(id,patch={})=>({id,product:'iPhone 17 Pro Max',customerName:'QT',sku:'',barcode:'',locationCode:`A${id}`,layerCount:1,inboundDate:'2026-08-24',totalQuantity:10,totalBoxes:2,...patch});
const plain=v=>JSON.parse(JSON.stringify(v));

test('individual combined aliases and historical FNSKU resolve one SKU anchor without joining another customer',()=>{
 const input=[row(1,{sku:'FIRST',barcode:'X1 / UPC1',fnsku:'OLD-F1'}),row(2,{sku:'SECOND',barcode:'X2 / UPC2'}),row(3,{barcode:'UPC1'}),row(4,{barcode:'OLD-F1'}),row(5,{customerName:'另一个客户',sku:'FIRST',barcode:'X1 / UPC1'})],copy=structuredClone(input),groups=groupInventory(input);
 assert.equal(groups.length,3);const first=groups.find(g=>g.customer==='QT'&&g.sku==='FIRST');assert.deepEqual(plain(first.members.map(m=>m.stock.id)),[1,3,4]);assert.equal(first.barcode,'OLD-F1 / X1 / UPC1');assert.equal(filterInventory(groups,'product','QT','OLD-F1').length,1);assert.deepEqual(input,copy);
 const ambiguous=groupInventory([row(1,{sku:'FIRST',barcode:'SHARED / UPC1'}),row(2,{sku:'SECOND',barcode:'SHARED / UPC2'}),row(3,{barcode:'SHARED'})]);assert.equal(ambiguous.length,3);assert.ok(ambiguous.every(g=>g.review));
});
test('legacy direction, number and damage prefixes associate without losing physical rows or dates',()=>{
 const input=[row(1,{product:'#1 iPhone 17 Pro Max',inboundDate:'2026-05-05'}),row(2,{product:'#2 iPhone 17 ProMax',inboundDate:'2026-04-09'}),row(3,{product:'残次品：iPhone 17 Pro Max',totalQuantity:3}),row(4,{product:'#1右侧 iPhone 17 Pro Max'})];
 const copy=structuredClone(input),g=groupInventory(input);assert.equal(g.length,1);assert.equal(g[0].quantity,33);assert.equal(g[0].boxes,8);assert.equal(g[0].damagedQuantity,3);assert.equal(g[0].members[0].stock.id,2);assert.deepEqual(input,copy);assert.deepEqual(plain(g[0].members.map(m=>m.stock.id).sort()),[1,2,3,4]);
 assert.equal(splitInventoryPrefix('（有卡）手机支架').name,'(有卡)手机支架');assert.equal(splitInventoryPrefix('AB 黄色救援器').prefix,'');
});
test('customers, colours and package variants do not silently merge; missing customers remain individual',()=>{
 const g=groupInventory([row(1),row(2,{customerName:'其他客户'}),row(3,{product:'iPhone 17 Pro Max（有卡）'}),row(4,{customerName:''}),row(5,{customerName:''}),row(6,{product:'未开箱'}),row(7,{product:'未开箱'})]);assert.equal(g.length,7);assert.equal(g.filter(x=>x.review).length,4);
});
test('name-only records cannot bridge conflicting identifiers',()=>{
 const g=groupInventory([row(1,{barcode:'X001'}),row(2,{barcode:'X002'}),row(3),row(4,{sku:'SKU-1',barcode:'X001'}),row(5,{sku:'SKU-2',barcode:'X002'})]);assert.equal(g.length,3);assert.equal(g.find(x=>x.members.some(m=>m.stock.id===3)).members.length,1);assert.equal(g.reduce((n,x)=>n+x.quantity,0),50);
});
test('identifier anchors tolerate different product names, with a unique fallback for missing identifiers',()=>{
 const g=groupInventory([row(1,{sku:'SKU-1',barcode:'0001'}),row(2,{sku:'SKU-1',barcode:'0001',product:'领星产品名称'}),row(3)]);assert.equal(g.length,1);assert.equal(g[0].sku,'SKU-1');assert.equal(g[0].members.length,3);
});

test('same customer and product without SKU combine across barcodes, preserving the screenshot quantities and every original row',()=>{
 const product='真空封口机 黑',customerName='示例商家-希之星(8003005)',input=[row(1,{product,customerName,barcode:'X004XVLMYL',locationCode:'A16',totalQuantity:720,totalBoxes:12}),row(2,{product,customerName,barcode:'X004XVLMYL',locationCode:'A25',totalQuantity:720,totalBoxes:12}),row(3,{product,customerName,barcode:'X004XVLMYL',locationCode:'D2',totalQuantity:33,totalBoxes:0}),row(4,{product,customerName,barcode:'X004V918PX',locationCode:'A29',totalQuantity:1440,totalBoxes:24}),row(5,{product,customerName,barcode:'X004V918PX',locationCode:'A30',totalQuantity:1440,totalBoxes:24})],copy=structuredClone(input),groups=groupInventory(input);
 assert.equal(groups.length,1);assert.equal(groups[0].quantity,4353);assert.equal(groups[0].boxes,72);assert.equal(groups[0].members.length,5);assert.equal(groups[0].review,false);assert.match(groups[0].reason,/同客户、同产品名称/);assert.deepEqual(new Set(groups[0].barcode.split(' / ')),new Set(['X004XVLMYL','X004V918PX']));assert.equal(filterInventory(groups,'product','','X004V918PX')[0].members.length,5);assert.deepEqual(input,copy);
});

test('same SKU is one group regardless of barcode; missing SKU follows one unambiguous product name',()=>{
 const groups=groupInventory([row(1,{sku:'SAME',barcode:'X1'}),row(2,{sku:'SAME',barcode:'X2'}),row(3,{barcode:'X3'}),row(4)]);assert.equal(groups.length,1);assert.equal(groups[0].sku,'SAME');assert.equal(groups[0].review,false);assert.equal(groups[0].members.length,4);assert.deepEqual(new Set(groups[0].barcode.split(' / ')),new Set(['X1','X2','X3']));
 const conflict=groupInventory([row(1,{sku:'FIRST',barcode:'X'}),row(2,{sku:'SECOND',barcode:'X'}),row(3,{barcode:'X'}),row(4,{barcode:'Y'})]);assert.equal(conflict.length,4);assert.ok(conflict.every(g=>g.review));
});

test('a shared barcode never joins different named variants, and placeholder barcodes cannot decide conflicting SKUs',()=>{
 const variants=groupInventory([row(1,{product:'真空封口机 黑',barcode:'混装'}),row(2,{product:'真空封口机 白',barcode:'混装'}),row(3,{product:'iPhone 16',barcode:'X1'}),row(4,{product:'iPhone 17',barcode:'X1'})]);assert.equal(variants.length,4);
 const conflict=groupInventory([row(1,{sku:'S1',barcode:'见备注'}),row(2,{sku:'S2',barcode:'X2'}),row(3,{barcode:'见备注'})]);assert.equal(conflict.length,3);assert.ok(conflict.every(g=>g.review));
});
test('box batches associate by full batch name and never drop unresolved or zero records',()=>{
 const input=[row(1,{product:'IB550715669RS',totalQuantity:0,totalBoxes:36}),row(2,{product:'IB550715669RS',totalQuantity:0,totalBoxes:23}),row(3,{product:'IB550715669RS-C6',totalQuantity:0,totalBoxes:3}),row(4,{totalQuantity:0,totalBoxes:0})],g=groupInventory(input);assert.equal(g.length,3);assert.equal(g.filter(x=>x.boxOnly).length,2);assert.equal(g.reduce((n,x)=>n+x.boxes,0),62);assert.equal(filterInventory(g,'box','','').length,2);assert.equal(filterInventory(g,'product','','').length,1);
});
test('customer, box, linking and text filters preserve whole associated goods',()=>{
 const g=groupInventory([row(1,{note:'核对备注',inboundOrder:'IB123'}),row(2,{product:'左侧 iPhone 17 Pro Max'}),row(3,{customerName:'其他客户',totalBoxes:0})]);assert.equal(filterInventory(g,'product','QT','IB123')[0].members.length,2);assert.equal(filterInventory(g,'box','','').length,0);assert.equal(filterInventory(g,'product','','','linked').length,1);assert.equal(filterInventory(g,'product','','A2').length,1);assert.equal(filterInventory(g,'product','','核对备注').length,1);
});
