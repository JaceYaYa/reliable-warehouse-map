import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {warehouseApiHarness} from './helpers/warehouse-api-harness.mjs';

function fixture(t){
 const objects=new Map(),hooks={get:null},bucket={put:async(key,bytes,options)=>objects.set(key,{bytes,options}),get:async key=>{hooks.get?.();hooks.get=null;return objects.has(key)?{body:objects.get(key).bytes}:null;}};
 const h=warehouseApiHarness({BACKUPS:bucket});t.after(()=>h.sqlite.close());
 h.seedUser(1,null,'admin','boss');h.seedUser(2,null,'admin','worker');h.seedUser(3,['workorders.view','workorders.execute'],'admin','other');h.seedUser(4,['workorders.view'],'employee','readonly');h.seedUser(5,['workorders.view','workorders.manage','workorders.execute'],'admin','manager');
 const id=h.stock('A1');h.sqlite.prepare("UPDATE stocks SET customer_name='内部客户',product='测试产品',sku='SKU-A',inbound_order='IB556715456RS',total_quantity=100,total_boxes=10,updated_at='2026-10-02T01:00:00Z' WHERE id=?").run(id);
 const model=h.load(resolve('lib/workorders/model.ts')),files=h.load(resolve('app/api/workorders/files/route.ts'));
 const ref={stockId:id,version:0,updatedAt:'2026-10-02T01:00:00Z',locationCode:'A1',product:'测试产品',sku:'SKU-A',customerName:'内部客户',totalQuantity:100,totalBoxes:10,inboundOrder:'IB556715456RS',layerCount:1};
 const row=(change={})=>({id:crypto.randomUUID(),inboundNo:'IB556715456RS',sku:'SKU-A',product:'测试产品',boxes:1,perCarton:'10',shipUnits:'10',remainderAction:'',locations:[{...ref}],...change});
 const doc=(change={})=>({orderNo:'OBC678901234',customer:'内部客户',product:'测试产品',sku:'SKU-A',requirements:'将产品装箱并发货',rows:[row()],warnings:[],...change});
 const payload=(change={})=>({sourceText:'',ocrText:'',sourceDocument:null,document:doc(),resolutions:{},reviewed:true,...change});
 const body=(change={})=>({id:crypto.randomUUID(),mutationId:crypto.randomUUID(),title:'公开工单',employeeBody:'将产品装箱并发货',customerName:'内部客户',assignedTo:'worker',kind:'outbound',status:'ready',fileIds:[],payload:payload(),...change});
 const patch=(id,expectedVersion,action,change={})=>h.call('workorders/item','PATCH',{...change,id,expectedVersion,action,mutationId:crypto.randomUUID()});
 const upload=async(orderId,id,visibility='source',token='test-token-1',file=new File(['%PDF-1.7 fixture'],'label.pdf'))=>{const form=new FormData();form.set('orderId',orderId);form.set('id',id);form.set('visibility',visibility);form.set('file',file);return files.POST(new Request('http://local.test/api/workorders/files',{method:'POST',headers:{cookie:'wms_session='+token},body:form}));};
 const download=(id,token='test-token-2')=>files.GET(new Request('http://local.test/api/workorders/files?id='+id,{headers:{cookie:'wms_session='+token}}));
 return{...h,ref,row,doc,payload,body,patch,upload,download,objects,hooks,model};
}

test('workorders: create, execute, cancel/reopen persist history while inventory stays unchanged',async t=>{
 const h=fixture(t),initial=JSON.stringify(h.sqlite.prepare('SELECT * FROM stocks').all()),body=h.body();
 const created=await h.call('workorders','POST',body);assert.equal(created.status,200);assert.equal(created.data.status,'ready');
 const startBody={id:body.id,expectedVersion:0,action:'start',mutationId:crypto.randomUUID()};let result=await h.call('workorders/item','PATCH',startBody,'test-token-2');assert.equal(result.status,200);assert.equal(result.data.status,'in_progress');
 assert.deepEqual(await h.call('workorders/item','PATCH',startBody,'test-token-2'),result,'lost response retry returns the committed result');
 assert.equal((await h.call('workorders/item','PATCH',startBody,'test-token-3')).status,409,'other actor cannot replay a committed execution');
 result=await h.call('workorders/item','PATCH',{id:body.id,expectedVersion:1,action:'complete',mutationId:crypto.randomUUID()},'test-token-2');assert.equal(result.status,200);
 assert.equal((await h.patch(body.id,2,'reopen',{reason:'重新核对操作'})).status,200);assert.equal((await h.patch(body.id,3,'cancel',{reason:'客户取消'})).status,200);
 const events=h.sqlite.prepare('SELECT action,result FROM work_order_events WHERE order_id=?').all(body.id);assert.deepEqual(events.map(e=>e.action),['下达','开始执行','员工确认完成','重新打开','取消']);
 const last=JSON.parse(events.at(-1).result);assert.equal(last.before.status,'draft');assert.equal(last.after.status,'cancelled');assert.equal(JSON.stringify(h.sqlite.prepare('SELECT * FROM stocks').all()),initial);assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM audit_logs').get().n,0);
});
test('workorders: create replay is exact and actor-bound, not a second workorder',async t=>{
 const h=fixture(t),body=h.body({status:'draft'}),first=await h.call('workorders','POST',body);assert.equal(first.status,200);assert.deepEqual(await h.call('workorders','POST',body),first);
 assert.equal((await h.call('workorders','POST',{...body,title:'改正文'})).status,409);assert.equal((await h.call('workorders','POST',body,'test-token-5')).status,409);assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM work_orders').get().n,1);
});
test('workorders: permissions, initial password and unique account assignment enforced server-side',async t=>{
 const h=fixture(t);assert.equal((await h.call('workorders','GET',undefined,'missing')).status,401);assert.equal((await h.call('workorders','POST',h.body(),'test-token-4')).status,403);assert.equal((await h.call('workorders/inventory','GET',undefined,'test-token-4')).status,403);assert.equal((await h.call('workorders/options','GET',undefined,'test-token-4')).status,403);
 h.sqlite.prepare("UPDATE users SET must_change=1 WHERE id=5").run();assert.equal((await h.call('workorders','POST',h.body(),'test-token-5')).status,403);
 assert.equal((await h.call('workorders','POST',h.body({assignedTo:'not-account'}))).status,400);assert.equal((await h.call('workorders','POST',h.body({assignedTo:'readonly'}))).status,400);
 const created=await h.call('workorders','POST',h.body());h.sqlite.prepare("UPDATE users SET display_name='改了显示名' WHERE id=2").run();assert.equal((await h.call('workorders/item','PATCH',{id:created.data.id,action:'start',expectedVersion:0,mutationId:crypto.randomUUID()},'test-token-4')).status,403);assert.equal((await h.call('workorders/item','PATCH',{id:created.data.id,action:'start',expectedVersion:0,mutationId:crypto.randomUUID()},'test-token-2')).status,200);
 const options=await h.call('workorders/options');assert.equal(options.status,200);assert.ok(options.data.customers.includes('内部客户'));assert.ok(options.data.users.some(u=>u.username==='worker'&&u.displayName==='改了显示名'));assert.ok(!options.data.users.some(u=>u.username==='readonly'));assert.ok(!JSON.stringify(options.data).includes('password'));
});
test('workorders: employee views never return internal source, customer or old private summaries',async t=>{
 const h=fixture(t),body=h.body({status:'draft',assignedTo:'',title:'内部草稿费率秘密',payload:h.payload({sourceText:'客户费用私密'})});assert.equal((await h.call('workorders','POST',body)).status,200);assert.equal((await h.call('workorders/item?id='+body.id,'GET',undefined,'test-token-4')).status,404);
 assert.equal((await h.patch(body.id,0,'edit',{...body,title:'公开工单'})).status,200);assert.equal((await h.patch(body.id,1,'dispatch')).status,200);
 const item=await h.call('workorders/item?id='+body.id,'GET',undefined,'test-token-4'),list=await h.call('workorders','GET',undefined,'test-token-4');assert.equal(item.status,200);assert.ok(!Object.hasOwn(item.data.order,'payload'));assert.ok(!Object.hasOwn(item.data.order,'customerName'));assert.ok(item.data.events.every(e=>!Object.hasOwn(e,'summary')));assert.ok(!JSON.stringify(item.data).includes('费率秘密'));assert.ok(!JSON.stringify(list.data).includes('费用私密'));assert.equal((await h.call('workorders?customer=内部客户','GET',undefined,'test-token-4')).status,403);
});
test('workorders: invalid enum prototype keys, malformed payload and empty structured outbound rejected',async t=>{
 const h=fixture(t);for(const key of ['__proto__','toString','constructor']){assert.equal((await h.call('workorders','POST',h.body({kind:key}))).status,400);assert.equal((await h.call('workorders?status='+key)).status,400);assert.equal((await h.call('workorders?kind='+key)).status,400);}
 assert.equal((await h.call('workorders','POST',h.body({status:'completed'}))).status,400);assert.equal((await h.call('workorders','POST',h.body({payload:h.payload({document:h.doc({rows:[]})})}))).status,400);
 const malformed=h.doc();malformed.rows[0].perCarton={number:10};assert.equal((await h.call('workorders','POST',h.body({payload:h.payload({document:malformed})}))).status,400);assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM work_orders').get().n,0);
});
test('workorders: original hold and source conflicts cannot be erased by editable executable document',async t=>{
 const h=fixture(t);for(const sourceText of ['本单暂不出库。√','本单暂停出库，等客户确认','没有面单，暂不发货']){const p=h.payload({sourceText});assert.equal(h.model.workorderRisks(p,'outbound').held,true);assert.equal((await h.call('workorders','POST',h.body({payload:p}))).status,400);}
 const p=h.payload({sourceText:'产品：白色支架',ocrText:'产品：黑色支架'});assert.ok(h.model.workorderRisks(p,'outbound').unresolved.length);assert.equal((await h.call('workorders','POST',h.body({payload:p}))).status,400);
 const checked=h.payload({sourceText:'√ 普通发货，按工单数量操作'});assert.ok(h.model.workorderRisks(checked,'outbound').warnings.some(w=>w.includes('不代表已执行')));assert.equal((await h.call('workorders','POST',h.body({payload:checked}))).data.status,'ready');
});
test('workorders: source fingerprints track edits, structured-only sources and ignore employee labels',async t=>{
 const h=fixture(t),p=h.payload({sourceText:'来源A'}),body=h.body({status:'draft',payload:p});assert.equal((await h.call('workorders','POST',body)).status,200);
 const next=h.payload({sourceText:'来源B'});assert.equal((await h.patch(body.id,0,'edit',{...body,payload:next})).status,200);assert.equal((await h.call('workorders','POST',h.body({status:'draft',payload:next}))).status,409);assert.equal((await h.call('workorders','POST',h.body({status:'draft',payload:p}))).status,200);
 const source=h.doc(),structured=h.payload({sourceDocument:source});assert.equal((await h.call('workorders','POST',h.body({status:'draft',payload:structured}))).status,200);assert.equal((await h.call('workorders','POST',h.body({status:'draft',payload:structured}))).status,409);
 const store=h.load(resolve('lib/workorders/store.ts')),hash=await store.workSourceFingerprint(structured,[]);assert.equal(await store.workSourceFingerprint(structured,[{hash:'different-label',visibility:'employee'}]),hash);
 const existing=await h.call('workorders','POST',h.body({status:'draft',payload:h.payload({sourceText:'来源C'})}));assert.equal((await h.patch(existing.data.id,0,'edit',{...h.body(),payload:next})).status,409,'edit cannot duplicate another source');assert.equal(h.sqlite.prepare('SELECT version FROM work_orders WHERE id=?').get(existing.data.id).version,0);
});
test('workorders: all duplicate stock refs checked, stale references rejected and repeated OBC quantities aggregated',async t=>{
 const h=fixture(t),good=h.row(),bad=h.row({locations:[{...h.ref,locationCode:'Z99',product:'错误商品'}]});assert.equal((await h.call('workorders','POST',h.body({payload:h.payload({document:h.doc({rows:[bad,good]})})}))).status,400);
 assert.equal((await h.call('workorders','POST',h.body({payload:h.payload({document:h.doc({rows:[h.row({locations:[{...h.ref,version:9}]})]})})}))).status,409);
 const rows=[h.row({boxes:6,shipUnits:'60'}),h.row({boxes:6,shipUnits:'60'})];assert.equal((await h.call('workorders','POST',h.body({payload:h.payload({document:h.doc({rows})})}))).status,400,'two orders may not each claim same availability');
 rows[1].boxes=4;rows[1].shipUnits='40';assert.equal((await h.call('workorders','POST',h.body({payload:h.payload({document:h.doc({rows})})}))).status,200);
});
test('workorders: multi-location assignments require exact allocation and never deduct inventory',async t=>{
 const h=fixture(t),id=h.stock('B3');h.sqlite.prepare("UPDATE stocks SET customer_name='内部客户',product='测试产品',sku='SKU-A',inbound_order='IB556715456RS',total_quantity=100,total_boxes=10,updated_at='2026-10-02T01:00:00Z' WHERE id=?").run(id);const other={...h.ref,stockId:id,locationCode:'B3'},row=h.row({boxes:2,shipUnits:'20',locations:[h.ref,other]}),p=h.payload({document:h.doc({rows:[row]})});
 assert.equal((await h.call('workorders','POST',h.body({payload:p}))).status,400);row.locationAllocations=[{stockId:h.ref.stockId,boxes:'1',units:'10'},{stockId:id,boxes:'1',units:'10'}];assert.equal((await h.call('workorders','POST',h.body({payload:p}))).status,200);assert.match(h.model.generatedEmployeeBody(p,'outbound'),/A1（取1箱 \/ 10件）.*B3（取1箱 \/ 10件）/);
 row.locationAllocations[1].units='9';assert.equal((await h.call('workorders','POST',h.body({payload:p}))).status,400);assert.equal(h.sqlite.prepare('SELECT SUM(total_quantity) n FROM stocks').get().n,200);
});
test('workorders: zero historical quantities require explicit sufficient signed field confirmation',async t=>{
 const h=fixture(t);h.sqlite.prepare('UPDATE stocks SET total_quantity=0,total_boxes=0 WHERE id=?').run(h.ref.stockId);const row=h.row({locations:[{...h.ref,totalQuantity:0,totalBoxes:0}]}),doc=h.doc({rows:[row]}),p=h.payload({document:doc});assert.equal((await h.call('workorders','POST',h.body({payload:p}))).status,400);
 row.quantityConfirmation={actualBoxes:'1',actualUnits:'10',confirmed:true,signature:h.model.workQuantitySignature(doc,row)};assert.equal((await h.call('workorders','POST',h.body({payload:p}))).status,200);row.shipUnits='11';assert.equal((await h.call('workorders','POST',h.body({payload:p}))).status,400);assert.equal(h.sqlite.prepare('SELECT total_quantity FROM stocks WHERE id=?').get(h.ref.stockId).total_quantity,0);
});
test('workorders: stock and order concurrency guards compare actual facts even if version timestamps stay unchanged',async t=>{
 const h=fixture(t),body=h.body();h.adapter.beforeBatch=()=>h.sqlite.prepare("UPDATE stocks SET total_quantity=5 WHERE id=?").run(h.ref.stockId);assert.equal((await h.call('workorders','POST',body)).status,409);assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM work_orders').get().n,0);assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM work_order_events').get().n,0);assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM goods_transaction_guards').get().n,0);
 h.sqlite.prepare('UPDATE stocks SET total_quantity=100 WHERE id=?').run(h.ref.stockId);assert.equal((await h.call('workorders','POST',body)).status,200);h.adapter.beforeBatch=()=>h.sqlite.prepare("UPDATE work_orders SET employee_body='新备份正文' WHERE id=?").run(body.id);const start=await h.call('workorders/item','PATCH',{id:body.id,expectedVersion:0,action:'start',mutationId:crypto.randomUUID()},'test-token-2');assert.equal(start.status,409);const row=h.sqlite.prepare('SELECT status,employee_body,version FROM work_orders WHERE id=?').get(body.id);assert.equal(row.status,'ready');assert.equal(row.employee_body,'新备份正文');assert.equal(row.version,0);assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM work_order_events WHERE order_id=?').get(body.id).n,1);
});
test('workorders: immutable files retain private sources and reject stale employee download authorization',async t=>{
 const h=fixture(t),orderId=crypto.randomUUID(),source=crypto.randomUUID(),employee=crypto.randomUUID();assert.equal((await h.upload(orderId,source)).status,200);assert.equal((await h.upload(orderId,employee,'employee')).status,200);assert.equal((await h.upload(orderId,employee,'employee')).status,200);assert.equal(h.objects.size,2);
 assert.equal((await h.upload(orderId,employee,'source')).status,409);assert.equal((await h.upload(orderId,crypto.randomUUID(),'employee','test-token-4')).status,403);assert.equal((await h.call('workorders','POST',h.body({id:orderId,fileIds:[source,employee]}))).status,200);
 h.sqlite.prepare("UPDATE users SET role='employee',permission_version=permission_version+1 WHERE id=2").run();assert.equal((await h.download(source)).status,404);const file=await h.download(employee);assert.equal(file.status,200);assert.match(file.headers.get('Content-Disposition'),/attachment/);assert.match(await file.text(),/%PDF/);
 h.hooks.get=()=>h.sqlite.prepare("UPDATE work_orders SET file_ids='[]' WHERE id=?").run(orderId);assert.equal((await h.download(employee)).status,409);assert.equal(h.objects.size,2,'removing references never deletes original blobs');
});
test('workorders: active attachment counts, reuse after failed save and file snapshot race are checked',async t=>{
 const h=fixture(t),orderId=crypto.randomUUID(),ids=[];for(let i=0;i<11;i++){const id=crypto.randomUUID();ids.push(id);assert.equal((await h.upload(orderId,id,'employee')).status,200);}
 assert.equal((await h.call('workorders','POST',h.body({id:orderId,fileIds:ids}))).status,400);assert.equal((await h.call('workorders','POST',h.body({id:orderId,fileIds:ids.slice(0,10)}))).status,200);assert.equal(h.objects.size,11);
 const second=crypto.randomUUID(),fileId=crypto.randomUUID();await h.upload(second,fileId);h.adapter.beforeBatch=()=>h.sqlite.prepare("UPDATE work_order_files SET visibility='employee' WHERE id=?").run(fileId);assert.equal((await h.call('workorders','POST',h.body({id:second,fileIds:[fileId]}))).status,409);assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM work_orders WHERE id=?').get(second).n,0);
});
test('workorders: label instructions require real employee attachment or explicit external handoff confirmation',async t=>{
 const h=fixture(t),p=h.payload({document:h.doc({requirements:'按照所附标签换标，并贴面单发货'})});assert.equal((await h.call('workorders','POST',h.body({payload:p}))).status,400);p.externalMaterialsConfirmed=true;assert.equal((await h.call('workorders','POST',h.body({payload:p}))).status,200);
 const noLabels=h.payload({document:h.doc({requirements:'无需换标，不用贴标签，仅装箱发货'})});assert.equal((await h.call('workorders','POST',h.body({payload:noLabels}))).status,200);
 for(const requirements of ['无需换标，但请按附件打印箱唛','不贴透明标签，只贴新产品标签','将产品标签更换为 X00562K0MV','透明标签改为 001234567890','产品条形码替换为 X00562K0MV'])assert.equal((await h.call('workorders','POST',h.body({payload:h.payload({document:h.doc({requirements})})}))).status,400,requirements);
 const id=crypto.randomUUID(),fileId=crypto.randomUUID();await h.upload(id,fileId,'source');p.externalMaterialsConfirmed=false;assert.equal((await h.call('workorders','POST',h.body({id,fileIds:[fileId],payload:p}))).status,400);
});
test('workorders: all-range filters and New York day boundaries work before pagination without SQL wildcards',async t=>{
 const h=fixture(t);for(let i=0;i<35;i++){const id=crypto.randomUUID();h.sqlite.prepare("INSERT INTO work_orders(id,number,kind,title,customer_name,employee_body,payload,file_ids,status,assigned_to,version,created_by,created_at,updated_by,updated_at) VALUES (?,?,'general',?,'内部客户','正文','{}','[]','ready','worker',0,1,?,1,?)").run(id,'H'+i,i===0?'稀有%_标题':'普通工单',i===0?'2026-10-02T04:00:00.000Z':'2026-10-03T00:00:00.000Z',i===0?'2026-10-02T04:00:00.000Z':'2026-10-03T00:00:00.000Z');}
 const page=await h.call('workorders?page=1&pageSize=10');assert.equal(page.data.orders.length,10);assert.equal(page.data.pagination.total,35);
 const filtered=await h.call('workorders?q='+encodeURIComponent('%_')+'&kind=general&status=ready&customer='+encodeURIComponent('内部客户')+'&operator=worker&from=2026-10-02&to=2026-10-02&pageSize=10');assert.equal(filtered.status,200);assert.equal(filtered.data.pagination.total,1);assert.equal(filtered.data.orders[0].title,'稀有%_标题');assert.equal((await h.call('workorders?from=2026-02-30')).status,400);assert.equal((await h.call('workorders?from=2026-10-03&to=2026-10-02')).status,400);
});
