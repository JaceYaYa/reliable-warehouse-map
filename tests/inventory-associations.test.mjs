import test from 'node:test';
import assert from 'node:assert/strict';
import {warehouseApiHarness} from './helpers/warehouse-api-harness.mjs';
const h=warehouseApiHarness(),lib=h.load('lib/inventory-associations.ts');h.sqlite.close();
const row=(id,patch={})=>({id,product:'iPhone 17 Pro Max',customerName:'QT',sku:'',barcode:'',locationCode:`A${id}`,layerCount:1,inboundDate:'2026-08-24',totalQuantity:10,totalBoxes:2,version:0,note:'原备注',...patch});
const plain=v=>JSON.parse(JSON.stringify(v));

test('association suggestions recognize a shared individual alias while preserving customer boundaries',()=>{
 const groups=lib.associatedInventory([row(1,{product:'红色加热饭盒',sku:'S1',barcode:'FIRST / UPC001'}),row(2,{product:'手持风扇',sku:'S2',barcode:'UPC001 / SECOND'}),row(3,{product:'手持风扇',customerName:'其他客户',barcode:'UPC001'})],lib.emptyAssociationState()),pairs=lib.inventoryCandidates(groups);
 assert.equal(pairs.length,1);assert.equal(pairs[0].reason,'产品条形码相同');assert.ok(pairs[0].left.customer==='QT'&&pairs[0].right.customer==='QT');
});
test('recommendations compare linked and single groups, with conflicts visible and customer/box boundaries preserved',()=>{
 const rows=[row(1,{barcode:'X1'}),row(2,{barcode:'X1'}),row(3,{product:'iPhone17ProMax',barcode:'X2'}),row(4,{customerName:'其他客户'}),row(5,{product:'IB550715669RS'}),row(6,{product:'IB550715669RS-C6'})];
 const groups=lib.associatedInventory(rows,lib.emptyAssociationState()),pairs=lib.inventoryCandidates(groups);
 assert.equal(pairs.length,1);assert.equal(pairs[0].left.members.length,2);assert.equal(pairs[0].right.members.length,1);
 assert.ok(!pairs[0].differences.some(v=>v.includes('条形码')));assert.equal(pairs[0].score,1);
 const variants=lib.associatedInventory([row(8,{product:'iPhone 16 Pro Max'}),row(9),row(10,{product:'未开箱'}),row(11,{product:'未开箱'})],lib.emptyAssociationState());assert.equal(lib.inventoryCandidates(variants).length,0);
 const spelling=lib.associatedInventory([row(12,{product:'仓库骨传导耳机HS1',sku:'A'}),row(13,{product:'仓库骨传导耳机 HS1',sku:'B'})],lib.emptyAssociationState());assert.equal(lib.inventoryCandidates(spelling).length,1);
});
test('barcode differences or missing barcodes are neutral; SKU conflicts still need review',()=>{
 const input=[row(1,{sku:'SAME',barcode:'X1'}),row(2,{sku:'SAME',barcode:'X2'}),row(3,{sku:'SAME'})],copy=structuredClone(input);
 const groups=lib.associatedInventory(input,lib.emptyAssociationState());assert.equal(groups.length,1);assert.equal(groups[0].members.length,3);assert.equal(groups[0].barcode,'X1 / X2');assert.ok(groups.every(g=>!g.review));assert.deepEqual(plain(lib.inventoryDifferences(groups)),[]);assert.equal(lib.inventoryCandidates(groups).length,0);assert.deepEqual(input,copy);
 const conflict=lib.associatedInventory([input[0],row(4,{sku:'OTHER',barcode:'X1'})],lib.emptyAssociationState());assert.ok(conflict.every(g=>g.review));assert.ok(lib.inventoryDifferences(conflict).includes('SKU不同'));
 const oldIdentity=JSON.stringify(['QT',input[1].product,'SAME','X2']),state={revision:1,associations:[{id:'legacy',product:'统一商品',customer:'QT',members:[{stockId:1,identity:lib.inventoryIdentity(input[0])},{stockId:2,identity:oldIdentity}]}]};
 const linked=lib.associatedInventory([input[0],{...input[1],barcode:'CHANGED'}],state);assert.equal(linked.length,1);assert.equal(linked[0].review,false);assert.equal(linked[0].barcode,'X1 / CHANGED');
 const stale=lib.associatedInventory([input[0],{...input[1],sku:'CHANGED'}],state);assert.equal(stale.length,2);assert.ok(stale.every(g=>g.review));
});

test('barcode notes and mixed-carton markers never recommend unrelated named products as the same goods',()=>{
 const groups=lib.associatedInventory([row(1,{product:'iPhone 16',barcode:'见备注'}),row(2,{product:'iPhone 17',barcode:'见备注'}),row(3,{product:'真空封口机 黑',barcode:'混装'}),row(4,{product:'真空封口机 白',barcode:'混装'})],lib.emptyAssociationState());assert.equal(groups.length,4);assert.equal(lib.inventoryCandidates(groups).length,0);
});
test('manual linkage preserves every row, dates, quantities and separate identifiers; undo and stale identities are safe',()=>{
 const rows=[row(1,{sku:'A',inboundDate:'2026-06-01'}),row(2,{sku:'B',product:'iPhone17 ProMax'}),row(3,{sku:'A'})],copy=structuredClone(rows);
 const association={id:'a',product:'统一名称',customer:'QT',createdAt:'now',createdBy:'tester',members:rows.slice(0,2).map(s=>({stockId:s.id,identity:lib.inventoryIdentity(s)}))};
 const state={revision:1,associations:[association]},groups=lib.associatedInventory(rows,state);
 assert.equal(groups.length,1);assert.equal(groups[0].quantity,30);assert.equal(groups[0].boxes,6);assert.equal(groups[0].members.length,3);assert.equal(groups[0].product,'统一名称');assert.equal(groups[0].members[0].stock.inboundDate,'2026-06-01');assert.equal(groups[0].sku,'A / B');assert.deepEqual(rows,copy);
 assert.equal(lib.associatedInventory(rows,lib.emptyAssociationState()).length,2);
 const changed=lib.associatedInventory([rows[0],{...rows[1],customerName:'其他客户'},rows[2]],state);assert.equal(changed.length,2);assert.ok(changed.every(g=>g.review));
 const removed=lib.associatedInventory(rows.slice(1),state);assert.equal(removed.reduce((n,g)=>n+g.quantity,0),20);
});
function setup(){const h=warehouseApiHarness();h.seedUser(1,['stock.edit'],'admin');h.seedUser(2,[]);for(let i=0;i<3;i++){const id=h.stock(`A${i+1}`);h.sqlite.prepare('UPDATE stocks SET product=?,sku=?,customer_name=?,inbound_date=?,note=? WHERE id=?').run(i===1?'产品A新版':'产品A',i===1?'B':'A',i===2?'其他客户':'QT','2026-01-01','原备注',id)}return h}
function source(h){const stocks=h.sqlite.prepare('SELECT id, product, product_prefix productPrefix, product_condition productCondition,customer_name customerName,sku,barcode,location_code locationCode,inbound_date inboundDate,total_quantity totalQuantity,total_boxes totalBoxes,layer_count layerCount,version,note FROM stocks').all();const raw=h.sqlite.prepare('SELECT value FROM settings WHERE key=?').get(lib.INVENTORY_ASSOCIATIONS_KEY)?.value;const state=lib.parseAssociationState(raw);return {stocks,state,groups:lib.associatedInventory(stocks,state)}}
function request(h,customer='QT'){const {groups,state}=source(h),chosen=groups.filter(g=>g.customer===customer);return {action:'link',revision:state.revision,product:'统一产品A',groupKeys:chosen.map(g=>g.key),members:chosen.flatMap(g=>g.members.map(m=>({id:m.stock.id,identity:lib.inventoryIdentity(m.stock),version:m.stock.version})))}}
test('real API persists across reads and reverses associations without rewriting inventory or billing',async()=>{
 const h=setup();try{const before=h.sqlite.prepare('SELECT * FROM stocks').all(),data=request(h);assert.equal((await h.call('inventory/associations','POST',data)).status,200);
 const get=await h.call('inventory/associations');assert.equal(get.data.state.revision,1);assert.equal(get.data.state.associations.length,1);
 const group=source(h).groups.find(g=>g.associationIds?.length);assert.equal(group.members.length,2);assert.deepEqual(h.sqlite.prepare('SELECT * FROM stocks').all(),before);
 assert.equal(h.sqlite.prepare('SELECT count(*) n FROM storage_fee_settlements').get().n,0);assert.equal(h.sqlite.prepare('SELECT count(*) n FROM audit_logs').get().n,1);
 const undo=await h.call('inventory/associations','POST',{action:'unlink',revision:1,groupKey:group.key});assert.equal(undo.status,200);assert.equal(undo.data.state.associations.length,0);assert.deepEqual(h.sqlite.prepare('SELECT * FROM stocks').all(),before);assert.equal(source(h).groups.length,3);
 }finally{h.sqlite.close()}
});
test('API rejects unauthorized users, forged identities, cross-customer groups and stale state',async()=>{
 const h=setup();try{const data=request(h);assert.equal((await h.call('inventory/associations','POST',data,'test-token-2')).status,403);assert.equal((await h.call('inventory/associations','GET',undefined,'test-token-2')).status,200);
 const forged=structuredClone(data);forged.members[0].identity='fake';assert.equal((await h.call('inventory/associations','POST',forged)).status,409);
 const other=source(h).groups.find(g=>g.customer==='其他客户');assert.equal((await h.call('inventory/associations','POST',{...data,groupKeys:[...data.groupKeys,other.key]})).status,400);
 assert.equal((await h.call('inventory/associations','POST',data)).status,200);assert.equal((await h.call('inventory/associations','POST',data)).status,409);assert.equal(h.sqlite.prepare('SELECT count(*) n FROM audit_logs').get().n,1);
 }finally{h.sqlite.close()}
});
test('atomic stock and association guards reject edits arriving between read and save',async()=>{
 const h=setup();try{const data=request(h);h.adapter.beforeBatch=()=>h.sqlite.exec('UPDATE stocks SET version=version+1,total_quantity=5 WHERE id=1');assert.equal((await h.call('inventory/associations','POST',data)).status,409);assert.equal(h.sqlite.prepare('SELECT count(*) n FROM audit_logs').get().n,0);
 const retry=request(h);assert.equal((await h.call('inventory/associations','POST',retry)).status,200);const next=request(h);next.groupKeys=['invalid'];assert.equal((await h.call('inventory/associations','POST',next)).status,400);
 const group=source(h).groups.find(g=>g.associationIds?.length);h.adapter.beforeBatch=()=>h.setting(lib.INVENTORY_ASSOCIATIONS_KEY,{revision:3,associations:[]});assert.equal((await h.call('inventory/associations','POST',{action:'unlink',revision:1,groupKey:group.key})).status,409);assert.equal(h.sqlite.prepare('SELECT count(*) n FROM audit_logs').get().n,1);
 }finally{h.sqlite.close()}
});

test('not-same decision removes only one candidate pair, persists, and undo retains history without changing stocks',async()=>{
 const h=setup();try{
  h.sqlite.prepare('UPDATE stocks SET product=? WHERE customer_name=?').run('仓库产品A真空封口机','QT');
  const before=h.sqlite.prepare('SELECT * FROM stocks').all(),data={...request(h),action:'exclude'};
  const baseline=source(h);assert.equal(lib.inventoryCandidates(baseline.groups).length,1);
  const saved=await h.call('inventory/associations','POST',data);assert.equal(saved.status,200);assert.equal(saved.data.state.associations.length,0);assert.equal(saved.data.state.reviews.length,1);
  let next=source(h);assert.equal(next.groups.length,3);assert.equal(lib.inventoryCandidates(next.groups,next.state).length,0);
  assert.equal((await h.call('inventory/associations')).data.state.reviews[0].action,'exclude');
  const third=h.stock('A4');h.sqlite.prepare('UPDATE stocks SET product=?,sku=?,customer_name=? WHERE id=?').run('仓库产品A真空封口机','C','QT',third);
  next=source(h);const pairs=lib.inventoryCandidates(next.groups,next.state);assert.equal(pairs.length,2);assert.ok(pairs.every(p=>[p.left,p.right].some(g=>g.members.some(m=>m.stock.id===third))));
  const undone=await h.call('inventory/associations','POST',{action:'undo',revision:next.state.revision,reviewId:saved.data.state.reviews[0].id});assert.equal(undone.status,200);assert.ok(undone.data.state.reviews[0].revertedAt);
  next=source(h);assert.equal(lib.inventoryCandidates(next.groups,next.state).length,3);
  assert.equal((await h.call('inventory/associations','POST',{action:'undo',revision:next.state.revision,reviewId:saved.data.state.reviews[0].id})).status,409);
  assert.deepEqual(h.sqlite.prepare('SELECT * FROM stocks WHERE id<>?').all(third),before);assert.equal(h.sqlite.prepare('SELECT count(*) n FROM audit_logs').get().n,2);
 }finally{h.sqlite.close()}
});

test('negative decisions tolerate barcode/location/quantity changes, but SKU, name or membership changes reopen review',()=>{
 const rows=[row(1,{product:'仓库产品A真空封口机',sku:'A'}),row(2,{product:'仓库产品A真空封口机',sku:'B'}),row(3,{product:'仓库产品A真空封口机',sku:'C'})];
 const groups=lib.associatedInventory(rows,lib.emptyAssociationState());const chosen=groups.filter(g=>g.members[0].stock.id!==3);
 const state={revision:1,associations:[],reviews:[{id:'ignore',action:'exclude',customer:'QT',product:'产品A',groups:chosen.map(lib.reviewGroup),createdAt:'2026-10-02',createdBy:'tester',before:[],after:[]}]};
 const visible=input=>lib.inventoryCandidates(lib.associatedInventory(input,state),state).length;
 assert.equal(visible(rows),2);assert.equal(visible(rows.map(s=>({...s,barcode:'NEW',locationCode:'B1',totalQuantity:99}))),2);
 assert.equal(visible([rows[0],{...rows[1],sku:'UPDATED'},rows[2]]),3);
 assert.equal(visible([rows[0],{...rows[1],product:'仓库产品A 真空封口机'},rows[2]]),3);
 assert.equal(visible([...rows,row(4,{product:'仓库产品A真空封口机',sku:'A'})]),3);
 assert.throws(()=>lib.parseAssociationState(JSON.stringify({...state,reviews:[{id:'broken'}]})),/核对记录/);
});

test('history undo restores prior links in order and blocks overwriting subsequent work',async()=>{
 const h=setup();try{
  let saved=await h.call('inventory/associations','POST',request(h));assert.equal(saved.status,200);const first=saved.data.state.reviews[0].id,firstRule=plain(saved.data.state.associations[0]);
  const id=h.stock('A4');h.sqlite.prepare('UPDATE stocks SET product=?,sku=?,customer_name=? WHERE id=?').run('产品A其他','C','QT',id);
  saved=await h.call('inventory/associations','POST',request(h));assert.equal(saved.status,200);const second=saved.data.state.reviews[1].id;
  assert.equal(saved.data.state.reviews[1].before[0].id,firstRule.id);
  assert.equal((await h.call('inventory/associations','POST',{action:'undo',revision:2,reviewId:first})).status,409);
  let undo=await h.call('inventory/associations','POST',{action:'undo',revision:2,reviewId:second});assert.equal(undo.status,200);assert.deepEqual(plain(undo.data.state.associations),[firstRule]);
  undo=await h.call('inventory/associations','POST',{action:'undo',revision:3,reviewId:first});assert.equal(undo.status,200);assert.equal(undo.data.state.associations.length,0);assert.equal(undo.data.state.reviews.filter(r=>r.revertedAt).length,2);
 }finally{h.sqlite.close()}
});

test('old manual links appear in history, and unlink operations can be reversed without deleting earlier history',async()=>{
 const h=setup();try{
  let saved=await h.call('inventory/associations','POST',request(h));const rule=saved.data.state.associations[0];h.setting(lib.INVENTORY_ASSOCIATIONS_KEY,{revision:1,associations:[rule]});
  let state=source(h);const legacy=lib.inventoryReviewHistory(state.state);assert.equal(legacy.length,1);assert.equal(legacy[0].id,`legacy:${rule.id}`);
  let undone=await h.call('inventory/associations','POST',{action:'undo',revision:1,reviewId:legacy[0].id});assert.equal(undone.status,200);assert.equal(undone.data.state.associations.length,0);assert.ok(undone.data.state.reviews[0].revertedAt);
  saved=await h.call('inventory/associations','POST',request(h));state=source(h);const group=state.groups.find(g=>g.associationIds?.length);
  const unlink=await h.call('inventory/associations','POST',{action:'unlink',revision:state.state.revision,groupKey:group.key});assert.equal(unlink.status,200);const last=unlink.data.state.reviews.at(-1);assert.equal(last.action,'unlink');
  undone=await h.call('inventory/associations','POST',{action:'undo',revision:unlink.data.state.revision,reviewId:last.id});assert.equal(undone.status,200);assert.equal(undone.data.state.associations[0].id,saved.data.state.associations[0].id);
 }finally{h.sqlite.close()}
});

test('negative review and undo enforce permissions, member versions and atomic concurrent stock guards',async()=>{
 const h=setup();try{
  const data={...request(h),action:'exclude'};assert.equal((await h.call('inventory/associations','POST',data,'test-token-2')).status,403);
  const forged=structuredClone(data);forged.members[0].version=999;assert.equal((await h.call('inventory/associations','POST',forged)).status,409);
  h.adapter.beforeBatch=()=>h.sqlite.exec('UPDATE stocks SET version=version+1 WHERE id=1');assert.equal((await h.call('inventory/associations','POST',data)).status,409);
  const saved=await h.call('inventory/associations','POST',{...request(h),action:'exclude'});assert.equal(saved.status,200);
  const undo={action:'undo',revision:saved.data.state.revision,reviewId:saved.data.state.reviews[0].id};assert.equal((await h.call('inventory/associations','POST',undo,'test-token-2')).status,403);
  h.adapter.beforeBatch=()=>h.sqlite.exec('UPDATE stocks SET version=version+1 WHERE id=1');assert.equal((await h.call('inventory/associations','POST',undo)).status,409);assert.equal(h.sqlite.prepare('SELECT count(*) n FROM audit_logs').get().n,1);
 }finally{h.sqlite.close()}
});

test('shared-name extraction respects full AB/B tokens and retains numbers, directions, quality and suffix details',()=>{
 const h=warehouseApiHarness();try{const match=h.load('lib/product-match.ts'),body='黄色手动 Choking Rescue Device';
 assert.equal(match.commonMatchedProduct([`AB ${body}`,`B ${body}`]),body);
 assert.equal(match.matchedProductParts(row(1,{product:`AB ${body}`}),body).prefix,'AB');
 assert.equal(match.matchedProductParts(row(2,{product:`B ${body}`}),body).prefix,'B');
 assert.equal(match.commonMatchedProduct(['#1-2 左侧 黑色充电款加热饭盒','#3-4 右侧 黑色充电款加热饭盒']),'黑色充电款加热饭盒');
 const details=match.matchedProductParts(row(1,{product:`残次品 AB ${body} 无卡`,productPrefix:'#9 · 右侧'}),body);assert.equal(details.prefix,'#9 · 右侧 · AB · 无卡');assert.equal(details.condition,'damaged');assert.equal(details.label,'残次品 · #9 · 右侧 · AB · 无卡');
 assert.equal(match.commonMatchedProduct(['黄色自动 Auto-Choking Rescue Device','绿色自动 Auto-Choking Rescue Device']),'自动 Auto-Choking Rescue Device');
 assert.equal(match.commonMatchedProduct(['不同商品','Unrelated Widget']),'');
 // A custom name not found in the originals retains their full body as a marker instead of dropping information.
 assert.equal(match.matchedProductParts(row(1,{product:'AB 原始产品'}),'统一名称').prefix,'AB 原始产品');
 }finally{h.sqlite.close()}
});

test('manual match persists per-record name marks, exposes one shared product and undoes without altering inventory or billing',async()=>{
 const h=setup();try{const body='黄色手动 Choking Rescue Device';h.sqlite.prepare('UPDATE stocks SET product=?,sku=? WHERE id=1').run(`AB ${body}`,'');h.sqlite.prepare('UPDATE stocks SET product=?,sku=?,product_condition=? WHERE id=2').run(`B ${body}`,'','damaged');
 const before=h.sqlite.prepare('SELECT * FROM stocks').all(),data=request(h);data.product=body;data.annotations=[{id:1,productPrefix:'AB · #9'},{id:2,productPrefix:'B'}];
 const saved=await h.call('inventory/associations','POST',data);assert.equal(saved.status,200);assert.equal(saved.data.state.associations[0].members[0].productPrefix,'AB · #9');
 const state=source(h),g=state.groups.find(g=>g.associationIds?.length);assert.equal(g.product,body);assert.equal(g.quantity,20);assert.equal(g.boxes,4);assert.equal(g.damagedQuantity,10);assert.equal(g.members[0].name,body);assert.equal(g.members[0].prefix,'AB · #9');assert.equal(g.members[1].prefix,'残次品 · B');assert.equal(g.members[0].stock.product,`AB ${body}`);
 const goods=h.load('lib/goods-flow.ts').goodsChoices(state.stocks,state.state,{categories:[]});assert.equal(goods.find(g=>g.customerName==='QT').product,body);
 const get=await h.call('inventory/associations');assert.equal(get.data.state.reviews[0].after[0].members[1].productPrefix,'B');
 const undone=await h.call('inventory/associations','POST',{action:'undo',revision:state.state.revision,reviewId:saved.data.state.reviews[0].id});assert.equal(undone.status,200);assert.equal(undone.data.state.associations.length,0);assert.ok(undone.data.state.reviews[0].revertedAt);assert.deepEqual(h.sqlite.prepare('SELECT * FROM stocks').all(),before);assert.equal(h.sqlite.prepare('SELECT count(*) n FROM storage_fee_settlements').get().n,0);
 }finally{h.sqlite.close()}
});

test('older first-name links and same-SKU matches split shared names for display without stripping unrelated product names globally',()=>{
 const rows=[row(1,{product:'AB 黄色手动 Choking Rescue Device'}),row(2,{product:'B 黄色手动 Choking Rescue Device'})],copy=structuredClone(rows),body='黄色手动 Choking Rescue Device';
 const old={revision:1,associations:[{id:'old',product:rows[0].product,customer:'QT',createdAt:'now',createdBy:'tester',members:rows.map(s=>({stockId:s.id,identity:lib.inventoryIdentity(s)}))}]};
 const linked=lib.associatedInventory(rows,old);assert.equal(linked.length,1);assert.equal(linked[0].product,body);assert.deepEqual(plain(linked[0].members.map(m=>m.prefix)),['AB','B']);assert.deepEqual(rows,copy);
 const sku=lib.associatedInventory(rows.map(s=>({...s,sku:'SAME'})),lib.emptyAssociationState());assert.equal(sku.length,1);assert.equal(sku[0].product,body);assert.deepEqual(plain(sku[0].members.map(m=>m.prefix)),['AB','B']);
 assert.equal(lib.associatedInventory(rows,lib.emptyAssociationState()).length,2,'no auto-merge merely because the suffix matches');
});

test('bad or mismatched name-marker payloads are rejected before saving any association or audit',async()=>{
 const h=setup();try{const data=request(h);for(const annotations of [[{id:1,productPrefix:'AB'}],[{id:1,productPrefix:'AB'},{id:1,productPrefix:'B'}],[{id:1,productPrefix:2},{id:2,productPrefix:'B'}],[{id:1,productPrefix:'x'.repeat(2001)},{id:2,productPrefix:'B'}]])assert.equal((await h.call('inventory/associations','POST',{...data,annotations})).status,400);assert.equal(source(h).state.associations.length,0);assert.equal(h.sqlite.prepare('SELECT count(*) n FROM audit_logs').get().n,0);
 }finally{h.sqlite.close()}
});

test('saving a matched displayed name and new marker preserves its explicit association; SKU or other name changes still require review',async()=>{
 const h=setup();try{const body='黄色手动 Choking Rescue Device';h.sqlite.prepare('UPDATE stocks SET product=?,sku=? WHERE id=1').run(`AB ${body}`,'');h.sqlite.prepare('UPDATE stocks SET product=?,sku=? WHERE id=2').run(`B ${body}`,'');
 const saved=await h.call('inventory/associations','POST',{...request(h),product:body});assert.equal(saved.status,200);
 const edit=await h.call('inventory/records','PATCH',{id:1,expectedVersion:0,product:body,productPrefix:'AB · #99'});assert.equal(edit.status,200,JSON.stringify(edit.data));
 let groups=source(h).groups;assert.equal(groups.filter(g=>g.customer==='QT').length,1);assert.equal(groups.find(g=>g.customer==='QT').members.find(m=>m.stock.id===1).prefix,'AB · #99');assert.equal(groups.find(g=>g.customer==='QT').review,false);
 h.sqlite.prepare('UPDATE stocks SET sku=? WHERE id=1').run('CHANGED');groups=source(h).groups;assert.ok(groups.filter(g=>g.customer==='QT').every(g=>g.review));
 }finally{h.sqlite.close()}
});

test('a previous client defaulting to the first full name is normalized on the server with durable AB/B markers',async()=>{
 const h=setup();try{const body='黄色手动 Choking Rescue Device';h.sqlite.prepare('UPDATE stocks SET product=?,sku=? WHERE id=1').run(`AB ${body}`,'');h.sqlite.prepare('UPDATE stocks SET product=?,sku=? WHERE id=2').run(`B ${body}`,'');const saved=await h.call('inventory/associations','POST',{...request(h),product:`AB ${body}`});assert.equal(saved.status,200);assert.equal(saved.data.state.associations[0].product,body);assert.deepEqual(plain(saved.data.state.associations[0].members.map(m=>m.productPrefix)),['AB','B']);
 }finally{h.sqlite.close()}
});
