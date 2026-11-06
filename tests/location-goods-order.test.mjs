import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {warehouseApiHarness} from './helpers/warehouse-api-harness.mjs';
const {locationGoodsByLayer}=warehouseApiHarness().load(resolve('lib/location-goods-order.ts'));
test('location goods sort layers numerically descending across product and carton stock',()=>{
 const stocks=[{id:1,layerCount:1},{id:2,layerCount:2},{id:3,layerCount:10}];
 const receipts=[{id:'c',placements:[{key:'x',locationCode:'A1',boxes:5,layerCount:5},{key:'y',locationCode:'B1',boxes:5,layerCount:20},{key:'z',locationCode:'A1',boxes:0,layerCount:30}]}];
 const sorted=locationGoodsByLayer(stocks,receipts,'A1');
 assert.deepEqual(Array.from(sorted,x=>x.layer),[10,5,2,1]);
 assert.deepEqual(stocks.map(x=>x.id),[1,2,3]);
 assert.equal(sorted[1].receipt,receipts[0]);assert.equal(sorted[0].stock,stocks[2]);
});
test('same-layer goods retain their existing order and missing layer defaults to one',()=>{
 const stocks=[{id:1,layerCount:2},{id:2,layerCount:2},{id:3}];
 const receipts=[{id:'c',placements:[{key:'a',locationCode:'A1',boxes:2,layerCount:2},{key:'b',locationCode:'A1',boxes:2,layerCount:2}]}];
 const sorted=locationGoodsByLayer(stocks,receipts,'A1');
 assert.deepEqual(Array.from(sorted,x=>x.kind==='stock'?x.stock.id:x.placement.key),[1,2,'a','b',3]);
});
