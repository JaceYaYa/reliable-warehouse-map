import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {warehouseApiHarness} from './helpers/warehouse-api-harness.mjs';
const h=warehouseApiHarness(), helpers=h.load(resolve('lib/goods-operation-input.ts')), drafts=h.load(resolve('lib/goods-operation-draft.ts'));
const spec={billingMode:'box',itemLengthCm:0,itemWidthCm:0,itemHeightCm:0,boxLengthCm:0,boxWidthCm:0,boxHeightCm:0,itemVolumeM3:0,boxVolumeM3:0};
const stock={id:1,version:0,inventoryUnit:'box',locationCode:'A32',layerCount:2,product:'饭盒',productCondition:'good',productPrefix:'左边',inboundDate:'2026-07-16',inboundOrder:'IB123',totalQuantity:0,totalBoxes:100};
const choice={key:'same',product:'饭盒',customerName:'客户A',sku:'SKU1',members:[stock,{...stock,id:2,locationCode:'A29',totalBoxes:69}],quantity:0,boxes:169,review:false,reason:''};
const task=(lineId,boxes,outboundOrder='')=>({lineId,outboundOrder,choice,inventoryUnit:'box',quantity:'0',boxes:String(boxes),receipt:{inboundSource:'domestic',productSpec:spec,sku:'SKU1',fnsku:'',barcode:'',productPrefix:'',productCondition:''},placements:[],picks:{1:{quantity:'0',boxes:String(boxes)}},autoPlacement:false,pickCondition:'all'});
test('two tasks retain same product, separate references and allocations across draft recovery',()=>{
 const a=task('a',74,'单A'),b=task('b',19,'单B');
 const draft={version:1,mode:'outbound',customer:'客户A',query:'',lines:[a,b].map(({choice,...l})=>({...l,choiceKey:choice.key,product:choice.product})),inboundDate:'2026-10-08',outboundDate:'2026-10-08',inboundOrder:'',note:'',receiptSource:'inherit',creating:false,newCustomer:'',newProduct:'',newSku:'',newBarcode:'',newSpec:spec,pending:null};
 assert.deepEqual(JSON.parse(JSON.stringify(drafts.parseGoodsOperationDraft(JSON.stringify(draft),'outbound'))),draft);
 assert.equal(drafts.parseGoodsOperationDraft(JSON.stringify({...draft,mode:'inbound'}),'inbound'),null);
 assert.equal(drafts.parseGoodsOperationDraft(JSON.stringify({...draft,lines:[draft.lines[0],{...draft.lines[1],lineId:'a'}]}),'outbound'),null);
});
test('sibling reservations subtract stock without mutating original snapshots',()=>{
 assert.equal(typeof helpers.availableOutboundMembers,'function');
 const a=task('a',74),b=task('b',19), rows=helpers.availableOutboundMembers(b,[a,b]);
 assert.equal(rows[0].totalBoxes,26);assert.equal(choice.members[0].totalBoxes,100);
 assert.equal(helpers.outboundTaskConflict(b,[a,b]),'');
 assert.match(helpers.outboundTaskConflict(b,[task('a',90),b]),/库位/);
 assert.match(helpers.outboundTaskConflict(b,[task('a',160),b]),/合计/);
});
test('copied messages contain only locations and keep each task quantity independent',()=>{
 assert.equal(typeof helpers.formatOutboundTaskMessage,'function');
 const a=task('a',74,'单A'),b=task('b',19,'单B');
 const first=helpers.formatOutboundTaskMessage(a,'2026-10-08',1,[a,b]),second=helpers.formatOutboundTaskMessage(b,'2026-10-08',2,[a,b]);
 assert.equal(first,'产品位于：A32 2层（拿74箱）');
 assert.equal(second,'产品位于：A32 2层（拿19箱）');
 assert.throws(()=>helpers.formatOutboundTaskMessage({...a,picks:{}},'2026-10-08',1,[a]),/分配/);
 assert.throws(()=>helpers.formatOutboundTaskMessage(b,'2026-10-08',2,[task('a',90),b]),/库位/);
 assert.throws(()=>helpers.formatOutboundTaskMessage({...a,boxes:'-1'},'2026-10-08',1,[a]),/数量/);
});

test('copy merges same location and layer across inbound batches without changing the draft',()=>{
 const quantities=[60,260,572,52,14,42];
 const members=quantities.map((quantity,i)=>({...stock,id:i+1,inventoryUnit:'piece',locationCode:i===5?'残次4':'办4',layerCount:1,totalQuantity:quantity,totalBoxes:0,inboundDate:`2026-09-${String(i+1).padStart(2,'0')}`,inboundOrder:`IB-${i}`,productCondition:i===5?'damaged':'good',productPrefix:`标记${i}`}));
 const a={...task('a',0,'OUT-A'),quantity:'1000',choice:{...choice,members,quantity:1000,boxes:0},picks:Object.fromEntries(members.map(row=>[row.id,{quantity:String(row.totalQuantity),boxes:'0'}]))};
 const before=JSON.stringify(a);
 assert.equal(helpers.formatOutboundTaskMessage(a,'2026-10-08',1,[a]),'产品位于：办4 1层（拿958个）+残次4 1层（拿42个）');
 assert.equal(JSON.stringify(a),before);
});

test('copy keeps different layers separate and combines nonzero piece and box amounts',()=>{
 const members=[{...stock,id:1,locationCode:'A30',totalQuantity:60,totalBoxes:2},{...stock,id:2,locationCode:'A30',layerCount:3,totalQuantity:0,totalBoxes:15},{...stock,id:3,locationCode:'A33',totalQuantity:0,totalBoxes:4}];
 const a={...task('a',21),quantity:'60',choice:{...choice,members,quantity:60,boxes:21},picks:{1:{quantity:'60',boxes:'2'},2:{quantity:'0',boxes:'15'},3:{quantity:'0',boxes:'4'}}};
 assert.equal(helpers.formatOutboundTaskMessage(a,'2026-10-08',1,[a]),'产品位于：A30 2层（拿60个、2箱）+A30 3层（拿15箱）+A33 2层（拿4箱）');
});
