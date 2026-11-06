import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {warehouseApiHarness} from './helpers/warehouse-api-harness.mjs';
const h=warehouseApiHarness(),load=()=>h.load(resolve('lib/message-goods.ts'));
const stock={id:1,locationCode:'C14',product:'RLX10车载支架长方形',customerName:'商家A',sku:'RLX10',barcode:'BC1',fnsku:'',totalQuantity:90,totalBoxes:5,productCondition:'good',layerCount:1,inboundDate:'2026-09-01',inboundSource:'domestic',billingMode:'item',itemVolumeM3:.002,boxVolumeM3:0,storageRateUsd:.7,freeDays:0,palletCount:0,updatedAt:'now'};
const choice={key:'one',product:stock.product,customerName:'商家A',sku:'RLX10',barcode:'BC1',members:[stock],quantity:90,boxes:5,review:false,reason:''};
test('消息装箱加散件不误报数量；移库保留起止库位并不得默认新增入库',()=>{
 const result=load().recognizeGoodsMessage('无卡！-- QT NO C RLX10车载支架长方形\n新品共70个（1箱X54个+16个）\n残次品8个（1箱X8个）（外包装破损）\n注从E1二层移到C14一层\n9/10清点',{locations:['E1','C14'],stocks:[stock],date:'2026-10-03',mode:'inbound'});
 assert.equal(result.rows.length,2);assert.deepEqual(Array.from(result.rows,r=>[r.quantity,r.boxes,r.productCondition]),[[70,1,'good'],[8,1,'damaged']]);
 assert(!result.rows.some(r=>r.warnings.some(w=>/总件数.*不一致/.test(w))));assert.equal(result.transfer,true);assert.match(result.transferText,/E1.*C14/);assert(result.rows.every(r=>r.locationCode==='C14'&&r.layerCount===1));
});
test('商家范围约束候选；同码跨商家不能自动选，未知产品不创建',()=>{
 const m=load(),row={product:'',sku:'RLX10',barcodes:[],customerName:''},other={...choice,key:'two',customerName:'商家B',members:[{...stock,id:2,customerName:'商家B'}]};
 assert.equal(m.matchMessageProducts(row,[choice,other],'','inbound').length,2);
 assert.deepEqual(Array.from(m.matchMessageProducts(row,[choice,other],'商家A','inbound'),c=>c.key),['one']);
 assert.equal(m.matchMessageProducts({...row,sku:'UNKNOWN'},[choice],'','inbound').length,0);
});
test('同行正残消息归并一个商品，多库位条码独立且不继承旧码；未知来源保持待选择',()=>{
 const input={id:'msg1',mode:'inbound',date:'2026-10-03',rows:[{choiceKey:'one',quantity:70,boxes:1,locationCode:'C14',layerCount:1,productCondition:'good',productPrefix:'无卡',inboundSource:'',inboundOrder:'',note:'',barcodes:[]},{choiceKey:'one',quantity:8,boxes:1,locationCode:'C14',layerCount:1,productCondition:'damaged',productPrefix:'无卡',inboundSource:'',inboundOrder:'',note:'包装破损',barcodes:['NEW']} ]};let n=0;
 const lines=load().materializeMessageImport(input,[choice],[],()=>String(++n));assert.equal(lines.length,1);assert.equal(lines[0].quantity,'78');assert.equal(lines[0].boxes,'2');assert.equal(lines[0].receipt.inboundSource,'');assert.deepEqual(Array.from(lines[0].placements,p=>Array.from(p.barcodes)),[[],['NEW']]);assert.equal(lines[0].receipt.sku,'RLX10');
});
test('出库消息按实际品相与库位分配，不借用其他商家或超出计划',()=>{
 const bad={...stock,id:2,totalQuantity:8,totalBoxes:1,productCondition:'damaged'},c={...choice,members:[stock,bad],quantity:98,boxes:6};
 const input={id:'msg2',mode:'outbound',date:'2026-10-03',rows:[{choiceKey:'one',quantity:3,boxes:0,locationCode:'C14',layerCount:1,productCondition:'damaged',productPrefix:'',inboundSource:'',inboundOrder:'',note:'',barcodes:[]}]};
 const lines=load().materializeMessageImport(input,[c],[],()=>'' );assert.equal(lines[0].picks[2].quantity,'3');assert.equal(lines[0].picks[1],undefined);assert.equal(lines[0].quantity,'3');
 assert.throws(()=>load().materializeMessageImport({...input,rows:[{...input.rows[0],quantity:500}]},[c],[],()=>''),/库存/);
});

test('原文没写商家时不继承第一条历史记录消除同名歧义',()=>{
 const m=load(),otherStock={...stock,id:2,customerName:'商家B'},other={...choice,key:'two',customerName:'商家B',members:[otherStock]};
 const result=m.recognizeGoodsMessage('产品：RLX10车载支架长方形\n新品共4个（1箱X4个）\n位于：C14一层\n退货',{locations:['C14'],stocks:[stock,otherStock],date:'2026-10-03',mode:'inbound'});
 assert.equal(result.rows[0].customerName,'');assert.equal(m.matchMessageProducts(result.rows[0],[choice,other],'','inbound').length,2);
 const named=m.recognizeGoodsMessage('客户：商家B\n产品：RLX10车载支架长方形\n正品4件',{locations:['C14'],stocks:[stock,otherStock],date:'2026-10-03',mode:'inbound'});
 assert.equal(named.rows[0].customerName,'商家B');assert.equal(m.matchMessageProducts(named.rows[0],[choice,other],'','inbound')[0].key,'two');
});

test('混合来源保持待选择；出库明确位置标记不得扣另一条记录',()=>{
 const m=load(),r=m.recognizeGoodsMessage('产品：RLX10车载支架长方形\n正品2件\n来源：退货\n产品：另一产品\n残次品1件\n来源：国内',{locations:['C14'],stocks:[stock],date:'2026-10-03',mode:'inbound'});
 assert(r.rows.every(row=>row.inboundSource===''));assert(r.rows.every(row=>row.warnings.some(w=>/不同来源/.test(w))));
 const c={...choice,members:[{...stock,productPrefix:'左边'},{...stock,id:2,productPrefix:'右边'}]},data={id:'marker',date:'2026-10-03',mode:'outbound',rows:[{choiceKey:'one',quantity:2,boxes:0,locationCode:'C14',layerCount:1,productCondition:'good',productPrefix:'右边',inboundSource:'',inboundOrder:'',note:'',barcodes:[]}]};
 const lines=m.materializeMessageImport(data,[c],[],()=> 'new');assert.deepEqual(Object.keys(lines[0].picks),['2']);
 const unmatched=m.materializeMessageImport({...data,rows:[{...data.rows[0],productPrefix:'#3'}]},[c],[],()=> 'new');assert.equal(Object.keys(unmatched[0].picks).length,0);
});

test('没有从由字样或仅库位箭头也必须拦截移库消息',()=>{
 for(const move of ['A1移到A2','A1→A2','A1 -> A2','移库到A2']){
 const r=load().recognizeGoodsMessage('产品：RLX10车载支架长方形\n正品2件\n'+move,{locations:['A1','A2'],stocks:[stock],date:'2026-10-03',mode:'inbound'});assert.equal(r.transfer,true,move);assert.equal(r.rows.length,1,move);
 }
});
