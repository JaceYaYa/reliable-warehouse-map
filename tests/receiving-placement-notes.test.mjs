import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {warehouseApiHarness} from './helpers/warehouse-api-harness.mjs';
import {fileURLToPath} from 'node:url';
test('arbitrary carton order and separate location notes survive receiving and retry',async()=>{
 const h=warehouseApiHarness();h.seedUser(1,null,'admin','boss');h.setting('warehouse_zones',[{id:'NEW_A',title:'A区',codes:['A1','A2']}]);
 try{const body={requestId:randomUUID(),inboundOrder:'散箱-周二到货',inboundDate:'2026-10-06',customerName:'',note:'',placements:[{key:'one',locationCode:'A1',layerCount:1,boxes:3,marker:'#1',note:'外箱破损'},{key:'two',locationCode:'A2',layerCount:1,boxes:2,marker:'右边',note:'等待核对'}]};
 const result=await h.call('cartons','POST',body);assert.equal(result.status,200);assert.deepEqual(result.data.receipt.placements.map(p=>p.note),['外箱破损','等待核对']);assert.equal(result.data.receipt.inboundOrder,body.inboundOrder);assert.equal(result.data.receipt.totalBoxes,5);assert.deepEqual((await h.call('cartons','POST',body)).data,result.data);assert.equal(h.sqlite.prepare('SELECT count(*) n FROM carton_receipts').get().n,1);
 const corrected=await h.call('cartons/claim','POST',{requestId:randomUUID(),id:result.data.receipt.id,expectedVersion:0,customerName:'商家',inboundOrder:body.inboundOrder,placementNotes:{one:'已检查',two:''}});assert.equal(corrected.status,200);assert.deepEqual(corrected.data.receipt.placements.map(p=>p.note),['已检查','']);assert.equal(corrected.data.receipt.totalBoxes,5);
 }finally{h.sqlite.close();}
});
test('selected location summary counts physical products and productless cartons separately',()=>{
 const h=warehouseApiHarness();try{const {summarizeLocations}=h.load(fileURLToPath(new URL('../lib/location-summary.ts',import.meta.url)));
 const summary=summarizeLocations([{locationCode:'A1',product:'饭盒',customerName:'A',totalQuantity:20,totalBoxes:2},{locationCode:'A1',product:'饭盒',customerName:'A',totalQuantity:10,totalBoxes:1},{locationCode:'A2',product:'台灯',customerName:'A',totalQuantity:4,totalBoxes:0}],[{placements:[{locationCode:'A1',boxes:3}]}]);assert.equal(summary.A1,'1 种产品 · 30件 / 3箱 · 另有 3箱件');assert.equal(summary.A2,'1 种产品 · 4件 / 0箱');
 }finally{h.sqlite.close();}
});
test('product receiving stores the note on its own allocated stock row',async()=>{
 const h=warehouseApiHarness();h.seedUser(1,null,'admin','boss');h.setting('warehouse_zones',[{id:'NEW_A',title:'A区',codes:['A1','A2']}]);h.stock('A1');h.sqlite.prepare("UPDATE stocks SET customer_name='测试商家'").run();
 try{const context=(await h.call('goods')).data,choice=context.choices[0];const result=await h.call('goods/inbound','POST',{requestId:randomUUID(),key:choice.key,expectedRevision:context.revision,members:choice.members.map(r=>({id:r.id,version:r.version})),inventoryUnit:'item',quantity:5,boxes:0,receipt:{inboundDate:'2026-10-06',inboundSource:'domestic',note:'旧整行备注',requirePlacementDetails:true,productSpec:{billingMode:'item',itemLengthCm:0,itemWidthCm:0,itemHeightCm:0,boxLengthCm:0,boxWidthCm:0,boxHeightCm:0,itemVolumeM3:0,boxVolumeM3:0}},placements:[{locationCode:'A1',layerCount:1,quantity:3,boxes:0,productCondition:'good',productPrefix:'#1',barcodes:[],note:'此处外箱完好'},{locationCode:'A2',layerCount:1,quantity:2,boxes:0,productCondition:'damaged',productPrefix:'右边',barcodes:[],note:''}]});assert.equal(result.status,200,JSON.stringify(result.data));assert.deepEqual(h.sqlite.prepare('SELECT note FROM stocks WHERE id>1 ORDER BY id').all().map(r=>r.note),['此处外箱完好','']);
 }finally{h.sqlite.close();}
});
