import test from 'node:test';
import assert from 'node:assert/strict';
import {warehouseApiHarness} from './helpers/warehouse-api-harness.mjs';
import {readFileSync} from 'node:fs';

test('product database is a peer of product and box inventory, with independent filters',()=>{
 const ui=readFileSync('components/InventoryWorkspace.tsx','utf8');
 assert.match(ui,/setMode\("products"\)/);
 assert.match(ui,/aria-label="库存与产品资料"/);
 const products=readFileSync('components/ProductsWorkspace.tsx','utf8');
 assert.match(products,/暂无库存/);assert.match(products,/清空筛选/);
 assert.match(products,/库存清零后产品资料仍保留/);
 assert.match(products,/if\(active&&!busy\)void load\(\)/);
 assert.match(products,/\[active,stockSnapshot\]/);
});

test('database state separates out-of-stock memories, stocked products and inactive products',()=>{
 const h=warehouseApiHarness();try{const {productDatabaseStatus,filterProductDatabase}=h.load('lib/product-database.ts');
 const records=[{product:'饭盒',sku:'S1',customerName:'A',quantity:0,boxes:0},{product:'饭盒',sku:'S1',customerName:'B',quantity:8,boxes:1},{product:'箱管理产品',sku:'S2',customerName:'A',quantity:0,boxes:2},{product:'停用饭盒',sku:'OLD',customerName:'A',quantity:0,boxes:0,archived:true}];
 assert.deepEqual(records.map(productDatabaseStatus),['empty','stocked','stocked','inactive']);
 assert.equal(filterProductDatabase(records,'all','','').length,3);
 assert.equal(filterProductDatabase(records,'empty','A',' Ｓ１ ').length,1);
 assert.equal(filterProductDatabase(records,'inactive','','').length,1);
 assert.equal(filterProductDatabase(records,'stocked','B','饭盒').length,1);
 }finally{h.sqlite.close()}
});

test('sold-out product remains available for receipt, receives into the same category without duplication',async()=>{
 const h=warehouseApiHarness();try{h.seedUser(1,null,'admin','boss');h.setting('warehouse_zones',[{id:'A',title:'A区',codes:['A1','A2']}]);
 const id=h.stock('A1');h.sqlite.prepare("UPDATE stocks SET product='饭盒',sku='S1',customer_name='商家A',total_quantity=2,total_boxes=0,inbound_source='domestic',inventory_unit='item' WHERE id=?").run(id);
 let c=(await h.call('goods')).data,choice=c.choices[0],refs=p=>p.members.map(r=>({id:r.id,version:r.version}));
 let r=await h.call('goods/outbound','POST',{requestId:crypto.randomUUID(),expectedRevision:c.revision,key:choice.key,members:refs(choice),quantity:2,boxes:0,selected:[{id,version:choice.members[0].version}],outboundDate:'2026-10-07'});
 assert.equal(r.status,200,JSON.stringify(r.data));
 c=(await h.call('goods')).data;choice=c.choices.find(p=>p.sku==='S1');assert.equal(choice.quantity,0);
 const database=(await h.call('goods/products')).data.products;assert.equal(database.length,1);assert.equal(database[0].sku,'S1');
 const inventory=h.load('lib/inventory-groups.ts');assert.equal(inventory.physicalInventoryStocks(choice.members).length,0);
 const key=choice.key;const body={requestId:crypto.randomUUID(),expectedRevision:c.revision,key,members:refs(choice),inventoryUnit:'item',receipt:{inboundDate:'2026-10-08',inboundSource:'domestic',billingMode:'item',itemVolumeM3:0,boxVolumeM3:0,storageRateUsd:0,freeDays:0,sku:'S1',barcode:'',productCondition:'good',productPrefix:'',inboundOrder:'再次入库',note:''},placements:[{locationCode:'A2',layerCount:1,quantity:3,boxes:0}]};
 body.receipt.inboundDate='2026-09-08';r=await h.call('goods/inbound','POST',body);assert.equal(r.status,200,JSON.stringify(r.data));assert.equal((await h.call('goods/inbound','POST',body)).status,200);
 c=(await h.call('goods')).data;assert.equal(c.choices.length,1);assert.equal(c.choices[0].key,key);assert.equal(c.choices[0].quantity,3);assert.equal(inventory.physicalInventoryStocks(c.choices[0].members).length,1);
 assert.equal((await h.call('goods/products')).data.products.length,1);
 }finally{h.sqlite.close()}
});
