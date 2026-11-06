import test from 'node:test';
import assert from 'node:assert/strict';

async function project(input) {
 const mod=await import('../lib/layer-storage-history.ts').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return null;throw e;});
 assert.ok(mod,'physical history projector must exist');
 return mod.projectLayerStorageHistory(input);
}
const stock=(id=1,patch={})=>({id,locationCode:'A1',layerCount:1,inboundDate:'2026-09-01',product:'货物',sku:'SKU',customerName:'甲',totalQuantity:10,totalBoxes:0,...patch});
const carton=(boxes=3,patch={})=>({id:'receipt',inboundDate:'2026-09-10',customerName:'甲',inboundOrder:'IN',placements:JSON.stringify([{key:'p1',locationCode:'A1',layerCount:1,boxes,marker:'',details:{product:'箱货',sku:'BOX'}}]),...patch});
const stamp=day=>`${day}T16:00:00.000Z`;
function base(stocks=[stock()],cartons=[]){return{stocks,cartons,audits:[],goodsOps:[],cartonOps:[],settlements:[],checkpoint:{capturedAt:stamp('2026-10-01'),auditHighId:10,value:JSON.stringify({schemaVersion:1,stocks,cartons})},periodStart:'2026-10-01',periodEndExclusive:'2026-10-08'};}
function audit(id,before,after,action='库存修改',patch={}){return{id,operationId:`op-${id}`,createdAt:stamp('2026-10-03'),action,entityType:'库位',entityId:'A1',beforeSnapshot:JSON.stringify(before),afterSnapshot:JSON.stringify(after),...patch};}
function goods(id,before,after,kind='outbound',patch={}){return{id,createdAt:stamp('2026-10-03'),kind,beforeRows:JSON.stringify(before),afterRows:JSON.stringify(after),result:JSON.stringify({outboundDate:'2026-10-03'}),fingerprint:'{}',restoredAt:null,...patch};}
const at=(result,day)=>result.intervals.find(i=>i.startDate<=day&&day<i.endDateExclusive);
const ids=(result,day)=>at(result,day)?.occupants.map(x=>x.id).sort();

test('checkpoint grants next NY day coverage, never current-location times precheckpoint month; aliases and nonphysical fields ignored',async()=>{
 const input=base([stock(),stock(2)]);input.stocks=input.stocks.map(s=>({...s,locationCode:'NEW',palletCount:999,note:'edited',storageRateUsd:999}));input.aliases={A1:'NEW'};
 const result=await project(input);assert.equal(result.coverageStart,'2026-10-02');assert.equal(at(result,'2026-10-01').issues[0].code,'history-before-checkpoint');
 assert.equal(at(result,'2026-10-02').issues.length,0);assert.equal(ids(result,'2026-10-02').length,2);assert.ok(at(result,'2026-10-02').occupants.every(o=>o.locationCode==='NEW'));
 assert.equal(result.intervals.length,2);
});
test('partial move and same day full onward move use final destination, keeping original arrival and source remainder',async()=>{
 const a=stock(),remain=stock(1,{totalQuantity:6}),b=stock(2,{locationCode:'B1',totalQuantity:4}),c={...b,locationCode:'C1'};const input=base([a]);input.stocks=[remain,c];
 const env=rows=>({kind:'stock-transfer',snapshotVersion:1,rows});input.audits=[audit(11,env([a]),env([remain,b]),'移库'),audit(12,env([b]),env([c]),'移库',{createdAt:'2026-10-03T17:00:00Z'})];
 const result=await project(input);assert.equal(at(result,'2026-10-02').occupants[0].locationCode,'A1');assert.deepEqual(at(result,'2026-10-03').occupants.map(o=>o.locationCode).sort(),['A1','C1']);assert.ok(at(result,'2026-10-03').occupants.every(o=>o.inboundDate==='2026-09-01'));assert.equal(at(result,'2026-10-03').issues.length,0);
});
test('partial and last outbound use physical rows, never unrelated FIFO settlement location',async()=>{
 const a=stock(),half=stock(1,{totalQuantity:5}),empty=stock(1,{totalQuantity:0});const input=base([a]);input.stocks=[empty];
 input.goodsOps=[goods('out1',[a],[half]),goods('out2',[half],[empty],'outbound',{createdAt:stamp('2026-10-05'),result:JSON.stringify({outboundDate:'2026-10-05'})})];
 input.audits=[audit(11,{schema:'goods-operation-v1',rows:[a]},{schema:'goods-operation-v1',rows:[half]},'出库',{operationId:'out1'}),audit(12,{schema:'goods-operation-v1',rows:[half]},{schema:'goods-operation-v1',rows:[empty]},'出库',{operationId:'out2',createdAt:stamp('2026-10-05')})];
 input.settlements=[{operationId:'out1:cost:0',locationCode:'WRONG',stockId:99,outboundAt:'2026-10-03T23:59:59.000Z'}];
 const result=await project(input);assert.deepEqual(ids(result,'2026-10-04'),['stock:1']);assert.deepEqual(ids(result,'2026-10-05'),[]);assert.equal(at(result,'2026-10-04').issues.length,0);
});
test('audit-only layer outbound uses explicit physical business date without any settlement carrier',async()=>{
 for(const removed of [false,true]){const a=stock(),after=removed?null:stock(1,{totalQuantity:0});const input=base([a]);input.stocks=after?[after]:[];input.audits=[audit(11,{...a,physicalOutboundDate:'2026-10-03'},after,'出库',{createdAt:stamp('2026-10-06')})];const r=await project(input);assert.deepEqual(ids(r,'2026-10-02'),['stock:1']);assert.deepEqual(ids(r,'2026-10-03'),[]);assert.equal(at(r,'2026-10-04').issues.length,0);}
});
test('audit-only legacy outbound still falls back to its exact linked settlement date',async()=>{
 const a=stock(),after=stock(1,{totalQuantity:0});const input=base([a]);input.stocks=[after];input.audits=[audit(11,a,after,'出库',{createdAt:stamp('2026-10-06')})];input.settlements=[{operationId:'op-11',outboundAt:'2026-10-03T23:59:59.000Z',locationCode:'COST-LOCATION'}];const r=await project(input);assert.deepEqual(ids(r,'2026-10-02'),['stock:1']);assert.deepEqual(ids(r,'2026-10-03'),[]);assert.equal(at(r,'2026-10-04').issues.length,0);
});
test('present physical outbound date is authoritative: invalid values stay pending instead of using legacy or summary dates',async()=>{
 for(const value of ['2026-02-30','2026-10-03T00:00:00Z','',null,123]){const a=stock(),after=stock(1,{totalQuantity:0});const input=base([a]);input.stocks=[after];input.audits=[audit(11,{...a,physicalOutboundDate:value},after,'出库',{createdAt:stamp('2026-10-06'),summary:'出库日期 2026-10-03'})];input.settlements=[{operationId:'op-11',outboundAt:'2026-10-03T23:59:59.000Z'}];const r=await project(input);assert.ok(at(r,'2026-10-04').issues.some(i=>i.code==='missing-business-date'));}
 const a=stock(),after=stock(1,{totalQuantity:0}),input=base([a]);input.stocks=[after];input.audits=[audit(11,{...a,physicalOutboundDate:'2026-10-04'},after,'出库',{createdAt:stamp('2026-10-06')})];input.settlements=[{operationId:'op-11',outboundAt:'2026-10-03T23:59:59.000Z'}];const r=await project(input);assert.deepEqual(ids(r,'2026-10-03'),['stock:1']);assert.deepEqual(ids(r,'2026-10-04'),[]);
});
test('backdated outbound without intervening physical change is applied on business date',async()=>{
 const a=stock(),empty=stock(1,{totalQuantity:0});const input=base([a]);input.stocks=[empty];input.goodsOps=[goods('out',[a],[empty],'outbound',{createdAt:stamp('2026-10-06')})];
 const r=await project(input);assert.deepEqual(ids(r,'2026-10-02'),['stock:1']);assert.deepEqual(ids(r,'2026-10-03'),[]);assert.equal(at(r,'2026-10-04').issues.length,0);
});
test('backdated outbound across a move flags affected evidence instead of moving full snapshot back in time',async()=>{
 const a=stock(),b=stock(1,{locationCode:'B1'}),empty={...b,totalQuantity:0};const input=base([a]);input.stocks=[empty];input.audits=[audit(11,a,b,'移库',{createdAt:stamp('2026-10-04')})];input.goodsOps=[goods('out',[b],[empty],'outbound',{createdAt:stamp('2026-10-06')})];
 const r=await project(input);assert.ok(at(r,'2026-10-03').issues.some(i=>i.code==='backdated-physical-conflict'));assert.ok(at(r,'2026-10-03').occupants.every(o=>o.locationCode!=='B1'));
});
test('matched undo cancels original outbound business effect, preserving continuous occupancy and arrival',async()=>{
 const a=stock(),empty=stock(1,{totalQuantity:0});const input=base([a]);input.goodsOps=[goods('out',[a],[empty],'outbound',{restoredAt:stamp('2026-10-05')})];input.audits=[audit(11,{schema:'goods-operation-v1',rows:[a]},{schema:'goods-operation-v1',rows:[empty]},'出库',{operationId:'out'}),audit(12,{schema:'goods-operation-v1',rows:[empty]},{schema:'goods-operation-v1',rows:[a]},'恢复',{operationId:'restore:audit:11',entityType:'原记录',entityId:'11',createdAt:stamp('2026-10-05')})];
 const r=await project(input);for(const day of ['2026-10-03','2026-10-05']){assert.deepEqual(ids(r,day),['stock:1']);assert.equal(at(r,day).issues.length,0);}
});
test('unmatched restored flag never makes a fresh receipt or silently cancels',async()=>{
 const a=stock(),empty=stock(1,{totalQuantity:0});const input=base([a]);input.stocks=[empty];input.goodsOps=[goods('out',[a],[empty],'outbound',{restoredAt:stamp('2026-10-05')})];const r=await project(input);assert.ok(r.issues.some(i=>i.code==='unmatched-undo'));
});
test('carton conversion consumes carton source and creates product source atomically without resetting arrival',async()=>{
 const before=carton(),after=carton(0),product=stock(2,{inboundDate:'2026-09-10',totalQuantity:30,totalBoxes:3});const input=base([], [before]);input.stocks=[product];input.cartons=[after];
 input.goodsOps=[goods('convert',[],[product],'convert',{result:JSON.stringify({cartonConversion:{before,after}})})];input.cartonOps=[{id:'convert',kind:'convert',createdAt:stamp('2026-10-03'),beforeSnapshot:JSON.stringify(before),afterSnapshot:JSON.stringify(after),fingerprint:'{}',result:'{}'}];
 const r=await project(input);assert.deepEqual(ids(r,'2026-10-02'),['carton:receipt:p1']);assert.deepEqual(ids(r,'2026-10-03'),['stock:2']);assert.equal(at(r,'2026-10-03').issues.length,0);
});
test('carton placement override supplies ownership/date and backdated outbound uses fingerprint date',async()=>{
 const before=carton(3,{placements:JSON.stringify([{key:'p1',locationCode:'A1',layerCount:2,boxes:3,details:{customerName:'乙',inboundDate:'2026-09-20'}}])}),after={...before,placements:JSON.stringify([{key:'p1',locationCode:'A1',layerCount:2,boxes:0,details:{customerName:'乙',inboundDate:'2026-09-20'}}])};const input=base([],[before]);input.cartons=[after];input.cartonOps=[{id:'co',kind:'outbound',createdAt:stamp('2026-10-05'),beforeSnapshot:JSON.stringify(before),afterSnapshot:JSON.stringify(after),fingerprint:JSON.stringify({outboundDate:'2026-10-03'}),result:'{}'}];const r=await project(input);assert.equal(at(r,'2026-10-02').occupants[0].customerName,'乙');assert.equal(at(r,'2026-10-02').occupants[0].inboundDate,'2026-09-20');assert.deepEqual(ids(r,'2026-10-03'),[]);
});
test('missing checkpoint, corrupted snapshots and mismatched current stock are pending, never empty verified history',async()=>{
 for(const patch of [{checkpoint:null},{checkpoint:{capturedAt:stamp('2026-10-01'),auditHighId:10,value:'bad'}},{stocks:[stock(1,{totalQuantity:11})]},{audits:[audit(11,null,null,'出库',{beforeSnapshot:null,afterSnapshot:null})]}]){const r=await project({...base(),...patch});assert.ok(r.issues.length);assert.ok(at(r,'2026-10-03').issues.length);}
});
test('quantity correction preserves physical location but unknown actual arrival cohort is pending',async()=>{
 const a=stock(),b=stock(1,{totalQuantity:11});const input=base([a]);input.stocks=[b];input.goodsOps=[goods('correct',[a],[b],'correction',{result:JSON.stringify({effectiveDate:'2026-10-03',closedAllocations:[{snapshot:{locationCode:'WRONG'}}]})})];const r=await project(input);assert.ok(at(r,'2026-10-03').issues.some(i=>i.code==='arrival-cohort-unknown'));assert.equal(at(r,'2026-10-03').occupants[0].locationCode,'A1');
});
test('future events cannot escape validation; bounded interval output for many years',async()=>{
 const input=base();input.periodStart='2000-01-01';input.periodEndExclusive='2030-01-01';const r=await project(input);assert.equal(r.intervals.length,2);assert.equal(r.intervals[0].startDate,'2000-01-01');
});

test('legitimate carton SQL NULL inbound/undo snapshots are absence, not missing stock evidence',async()=>{
 const c=carton();const input=base([],[]);input.cartons=[c];input.cartonOps=[{id:'receive',kind:'inbound',createdAt:stamp('2026-10-03'),beforeSnapshot:null,afterSnapshot:JSON.stringify(c),fingerprint:'{}',result:'{}'}];input.audits=[audit(11,null,c,'箱件收货',{operationId:'receive',entityType:'箱件收货',beforeSnapshot:null})];const r=await project(input);assert.equal(at(r,'2026-10-03').issues.length,0);assert.deepEqual(ids(r,'2026-10-03'),['carton:receipt:p1']);
});
test('paired conversion undo restores cartons continuously and is never a new inbound',async()=>{
 const before=carton(),after=carton(0),s=stock(2,{inboundDate:'2026-09-10',totalQuantity:30,totalBoxes:3});const input=base([],[before]);
 input.goodsOps=[goods('convert',[],[s],'convert',{result:JSON.stringify({cartonConversion:{before,after}}),restoredAt:stamp('2026-10-05')})];
 input.cartonOps=[{id:'convert',kind:'convert',createdAt:stamp('2026-10-03'),beforeSnapshot:JSON.stringify(before),afterSnapshot:JSON.stringify(after),fingerprint:'{}',result:'{}',restoredAt:stamp('2026-10-05')},{id:'carton-undo',kind:'restore',createdAt:stamp('2026-10-05'),beforeSnapshot:JSON.stringify(after),afterSnapshot:JSON.stringify(before),fingerprint:JSON.stringify({operationId:'convert'}),result:'{}'}];
 input.audits=[audit(11,{schema:'goods-operation-v1',rows:[]},{schema:'goods-operation-v1',rows:[s]},'库存修改',{operationId:'convert'}),audit(12,{schema:'goods-operation-v1',rows:[s]},{schema:'goods-operation-v1',rows:[]},'恢复',{operationId:'restore:audit:11',entityType:'原记录',entityId:'11',createdAt:stamp('2026-10-05')})];
 const r=await project(input);assert.equal(at(r,'2026-10-03').issues.length,0);assert.deepEqual(ids(r,'2026-10-03'),['carton:receipt:p1']);assert.deepEqual(ids(r,'2026-10-05'),['carton:receipt:p1']);
});
test('conversion missing the other physical ledger stays pending even if a result embeds plausible snapshots',async()=>{
 const before=carton(),after=carton(0),s=stock(2);const input=base([],[before]);input.stocks=[s];input.cartons=[after];input.goodsOps=[goods('convert',[],[s],'convert',{result:JSON.stringify({cartonConversion:{before,after}})})];const r=await project(input);assert.ok(at(r,'2026-10-03').issues.some(i=>i.code==='unpaired-conversion'));
});
test('arrival uncertainty follows split movement descendants, not just the original row id',async()=>{
 const a=stock(),corrected=stock(1,{totalQuantity:12}),remain=stock(1,{totalQuantity:6}),moved=stock(2,{locationCode:'B1',totalQuantity:6});const input=base([a]);input.stocks=[remain,moved];input.goodsOps=[goods('correct',[a],[corrected],'correction',{result:JSON.stringify({effectiveDate:'2026-10-03'})})];input.audits=[audit(12,{kind:'stock-transfer',snapshotVersion:1,rows:[corrected]},{kind:'stock-transfer',snapshotVersion:1,rows:[remain,moved]},'移库',{createdAt:stamp('2026-10-04')})];const r=await project(input);assert.ok(at(r,'2026-10-04').issues.some(i=>i.code==='arrival-cohort-unknown'&&i.recordIds?.includes('stock:2')));
});
test('legacy quantity increase within one physical row makes original arrival cohorts uncertain',async()=>{
 const a=stock(),b=stock(1,{totalQuantity:20});const input=base([a]);input.stocks=[b];input.audits=[audit(11,a,b,'入库')];const r=await project(input);assert.ok(at(r,'2026-10-03').issues.some(i=>i.code==='arrival-cohort-unknown'));
});
test('old malformed unrelated operation cannot invalidate a complete new baseline epoch',async()=>{
 const input=base();input.goodsOps=[{id:'old',kind:'outbound',createdAt:stamp('2026-09-01'),beforeRows:'bad',afterRows:'bad',result:'{}'}];const r=await project(input);assert.equal(at(r,'2026-10-03').issues.length,0);
});
test('an empty duplicate audit cannot conceal conflicting nonempty physical operation snapshots',async()=>{
 const a=stock(),b=stock(1,{totalQuantity:0});const input=base([a]);input.stocks=[b];input.goodsOps=[goods('out',[a],[b])];input.audits=[audit(11,{schema:'goods-operation-v1',rows:[]},{schema:'goods-operation-v1',rows:[]},'出库',{operationId:'out'})];const r=await project(input);assert.ok(r.issues.some(i=>i.code==='source-snapshot-conflict'));
});
test('restored empty product category has no physical impact and must not poison occupied layers',async()=>{
 const input=base();input.goodsOps=[goods('category',[],[],'create',{result:'{}',restoredAt:stamp('2026-10-05')})];const r=await project(input);assert.equal(at(r,'2026-10-03').issues.length,0);
});
test('legacy outbound undone after its settlement was deleted still cancels with exact audit proof',async()=>{
 const a=stock(),b=stock(1,{totalQuantity:0});const input=base([a]);input.audits=[audit(11,a,b,'出库'),audit(12,b,a,'恢复',{operationId:'restore:audit:11',entityType:'原记录',entityId:'11',createdAt:stamp('2026-10-05')})];const r=await project(input);assert.equal(at(r,'2026-10-03').issues.length,0);assert.deepEqual(ids(r,'2026-10-04'),['stock:1']);
});
test('unknown vanished goods taint other occupants sharing any proven affected layer',async()=>{
 const first=stock(),other=stock(2,{inboundDate:'2026-09-20'});const input=base([first,other]);input.stocks=[other];const r=await project(input);assert.ok(at(r,'2026-10-03').issues.some(i=>i.code==='current-state-mismatch'&&i.locationCode==='A1'&&i.layer===1&&!i.recordIds));
});
test('ordinary quantity decrease and managed deletion create no arrival uncertainty for remaining co-occupants',async()=>{
 for(const remaining of [5,0]){const a=stock(),other=stock(2,{inboundDate:'2026-09-20'}),after=stock(1,{totalQuantity:remaining});const input=base([a,other]);input.stocks=[after,other];input.goodsOps=[goods('correct',[a],[after],'correction',{result:JSON.stringify({effectiveDate:'2026-10-03',inventoryDeletion:remaining===0})})];const r=await project(input);assert.equal(r.issues.some(i=>i.code==='arrival-cohort-unknown'),false);assert.deepEqual(r.currentArrivalReviewIds,[]);assert.equal(at(r,'2026-10-04').issues.length,0);}
});
test('current cohort uncertainty follows full/split moves even when selected period ends before the increase',async()=>{
 for(const split of [false,true]){const a=stock(),b=stock(1,{totalQuantity:12}),remaining=stock(1,{totalQuantity:6}),moved=stock(split?2:1,{locationCode:'B1',totalQuantity:split?6:12});const input=base([a]);input.periodEndExclusive='2026-10-03';input.stocks=split?[remaining,moved]:[moved];input.goodsOps=[goods('correct',[a],[b],'correction',{createdAt:stamp('2026-10-04'),result:JSON.stringify({effectiveDate:'2026-10-04'})})];input.audits=[audit(12,{kind:'stock-transfer',snapshotVersion:1,rows:[b]},{kind:'stock-transfer',snapshotVersion:1,rows:input.stocks},'移库',{createdAt:stamp('2026-10-05')})];const r=await project(input);assert.deepEqual(r.currentArrivalReviewIds,split?['stock:1','stock:2']:['stock:1']);assert.equal(r.issues.some(i=>i.code==='arrival-cohort-unknown'),false);}
});
test('prior uncertainty survives decrease but stops at last outbound and does not taint surviving co-occupants forever',async()=>{
 const a=stock(),up=stock(1,{totalQuantity:12}),half=stock(1,{totalQuantity:5}),empty=stock(1,{totalQuantity:0}),other=stock(2);const input=base([a,other]);input.stocks=[empty,other];input.goodsOps=[goods('increase',[a],[up],'correction',{result:JSON.stringify({effectiveDate:'2026-10-03'})}),goods('decrease',[up],[half],'correction',{createdAt:stamp('2026-10-04'),result:JSON.stringify({effectiveDate:'2026-10-04'})}),goods('last',[half],[empty],'outbound',{createdAt:stamp('2026-10-05'),result:JSON.stringify({outboundDate:'2026-10-05'})})];const r=await project(input);assert.ok(at(r,'2026-10-04').issues.some(i=>i.code==='arrival-cohort-unknown'));assert.equal(at(r,'2026-10-05').issues.some(i=>i.code==='arrival-cohort-unknown'),false);assert.deepEqual(r.currentArrivalReviewIds,[]);
});
test('matched restored increase is ignored for both historical and current cohort review',async()=>{
 const a=stock(),up=stock(1,{totalQuantity:12});const input=base([a]);input.periodEndExclusive='2026-10-03';input.goodsOps=[goods('correct',[a],[up],'correction',{createdAt:stamp('2026-10-04'),result:JSON.stringify({effectiveDate:'2026-10-04'}),restoredAt:stamp('2026-10-05')})];input.audits=[audit(11,{schema:'goods-operation-v1',rows:[a]},{schema:'goods-operation-v1',rows:[up]},'库存修改',{operationId:'correct',createdAt:stamp('2026-10-04')}),audit(12,{schema:'goods-operation-v1',rows:[up]},{schema:'goods-operation-v1',rows:[a]},'恢复',{operationId:'restore:audit:11',entityType:'原记录',entityId:'11',createdAt:stamp('2026-10-05')})];const r=await project(input);assert.deepEqual(r.currentArrivalReviewIds,[]);assert.equal(r.issues.some(i=>i.code==='arrival-cohort-unknown'),false);
});
test('carton corrections track only increased placement and propagate its current uncertainty through a move',async()=>{
 const placement=(key,boxes,code='A1')=>({key,locationCode:code,layerCount:1,boxes,details:{inboundDate:'2026-09-10',customerName:'甲'}});const before=carton(0,{placements:JSON.stringify([placement('p1',3),placement('p2',8,'A2')])}),up={...before,placements:JSON.stringify([placement('p1',5),placement('p2',8,'A2')])},moved={...before,placements:JSON.stringify([placement('p1',2),placement('p2',8,'A2'),placement('p3',3,'B1')])};const input=base([],[before]);input.cartons=[moved];input.periodEndExclusive='2026-10-03';input.cartonOps=[{id:'increase',kind:'correction',createdAt:stamp('2026-10-04'),beforeSnapshot:JSON.stringify(before),afterSnapshot:JSON.stringify(up),fingerprint:'{}',result:'{}'},{id:'move',kind:'move',createdAt:stamp('2026-10-05'),beforeSnapshot:JSON.stringify(up),afterSnapshot:JSON.stringify(moved),fingerprint:'{}',result:'{}'}];const r=await project(input);assert.deepEqual(r.currentArrivalReviewIds,['carton:receipt:p1','carton:receipt:p3']);
});
test('real local carton ledgers: receiving, outbound, undo, conversion and paired conversion undo reconcile',async()=>{
 const {warehouseApiHarness}=await import('./helpers/warehouse-api-harness.mjs');const {randomUUID}=await import('node:crypto');const h=warehouseApiHarness();
 const camel=r=>Object.fromEntries(Object.entries(r).map(([k,v])=>[k.replace(/_([a-z])/g,(_,c)=>c.toUpperCase()),v]));
 const collect=()=>({stocks:h.sqlite.prepare('select * from stocks').all().map(camel),cartons:h.sqlite.prepare('select * from carton_receipts').all().map(camel),audits:h.sqlite.prepare('select * from audit_logs').all().map(camel),goodsOps:h.sqlite.prepare('select * from goods_operations').all().map(camel),cartonOps:h.sqlite.prepare('select * from carton_operations').all().map(camel),settlements:h.sqlite.prepare('select * from storage_fee_settlements').all().map(camel)});
 const input={...base([],[]),checkpoint:{capturedAt:'2026-01-01T12:00:00Z',auditHighId:0,value:JSON.stringify({schemaVersion:1,stocks:[],cartons:[]})},periodStart:'2026-09-01',periodEndExclusive:'2030-01-01'};
 try{
  h.seedUser(1,null,'admin','boss');h.setting('warehouse_zones',[{id:'NEW_A',title:'A',codes:['A1']}]);
  const receive=await h.call('cartons','POST',{requestId:randomUUID(),inboundOrder:'IN',inboundDate:'2026-09-25',customerName:'甲',placements:[{key:'one',locationCode:'A1',layerCount:1,boxes:8}]});assert.equal(receive.status,200,JSON.stringify(receive.data));
  assert.deepEqual((await project({...input,...collect()})).issues,[]);
  const out=await h.call('cartons/outbound','POST',{requestId:randomUUID(),id:receive.data.receipt.id,expectedVersion:0,outboundDate:'2026-10-03',picks:[{key:'one',boxes:3}]});assert.equal(out.status,200,JSON.stringify(out.data));
  let log=h.sqlite.prepare("select id from audit_logs where action='箱件出库'").get();assert.equal((await h.call('movements','POST',{id:log.id})).status,200);assert.deepEqual((await project({...input,...collect()})).issues,[]);
  let c=await h.call('goods');const create=await h.call('goods','POST',{requestId:randomUUID(),expectedRevision:c.data.revision,product:'产品',customerName:'甲',sku:'SKU',productSpec:{billingMode:'item',itemVolumeM3:.01}});assert.equal(create.status,200,JSON.stringify(create.data));
  c=await h.call('goods');const choice=c.data.choices.find(x=>x.key===create.data.key);const current=(await h.call('cartons')).data.receipts[0];
  const converted=await h.call('cartons/convert','POST',{requestId:randomUUID(),id:current.id,expectedVersion:current.version,key:choice.key,expectedRevision:c.data.revision,members:[],inboundSource:'return',placements:[{key:'one',quantity:80,productCondition:'good',barcodes:[]}]});assert.equal(converted.status,200,JSON.stringify(converted.data));
  assert.deepEqual((await project({...input,...collect()})).issues,[]);
  log=h.sqlite.prepare("select id from audit_logs where operation_id=?").get(converted.data.operationId);assert.ok(log);assert.equal((await h.call('movements','POST',{id:log.id})).status,200);assert.deepEqual((await project({...input,...collect()})).issues,[]);
 }finally{h.sqlite.close();}
});
