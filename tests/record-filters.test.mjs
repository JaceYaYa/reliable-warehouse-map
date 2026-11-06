import assert from 'node:assert/strict';
import test from 'node:test';
import {warehouseApiHarness} from './helpers/warehouse-api-harness.mjs';

const fresh=(extra={})=>{
 const h=warehouseApiHarness(extra);h.seedUser(1,['records.view','audit.view','backup.manage','pricing.manage'],'admin');h.seedUser(2,[]);h.seedUser(3,['records.view']);h.seedUser(4,['audit.view'],'admin');h.seedUser(5,['backup.manage'],'admin','boss');
 h.sqlite.prepare("UPDATE users SET display_name='实际备份操作员' WHERE id=5").run();return h;
};
const insert=(h,{action='入库',operator='仓管甲',location='A1',customer='客户甲',summary=`货物｜客户 ${customer}｜数量 +1`,stamp='2026-10-02T02:00:00.000Z',entityType='库位',before=null,after=null}={})=>Number(h.sqlite.prepare('INSERT INTO audit_logs(user_id,user_name,action,entity_type,entity_id,summary,before_snapshot,after_snapshot,created_at) VALUES (1,?,?,?,?,?,?,?,?)').run(operator,action,entityType,location,summary,before,after,stamp).lastInsertRowid);
const path=(endpoint,params={})=>`${endpoint}?${new URLSearchParams(Object.entries(params).map(([key,value])=>[key,String(value)]))}`;
async function read(h,endpoint,params={},token){const r=await h.call(path(endpoint,params),'GET',undefined,token);assert.equal(r.status,200,JSON.stringify(r.data));return r.data;}
const ids=data=>data.logs.map(log=>log.id).sort((a,b)=>a-b);

test('两个记录接口均先筛全量再分页，组合条件可找到当前页之外的旧记录，options覆盖全范围',async()=>{
 for(const endpoint of ['movements','audit']){
  const h=fresh();try{
   const action=endpoint==='movements'?'出库':'库位容量修改',otherAction=endpoint==='movements'?'入库':'地图布局修改';
   const target=insert(h,{action,operator:'历史操作员',location:'B3',customer:'历史客户',summary:'特殊货物｜客户 历史客户｜唯一关键字',stamp:'2026-09-01T04:00:00.000Z'});
   for(let i=0;i<65;i++)insert(h,{action:otherAction,operator:'当前操作员',location:'A1',stamp:'2026-10-02T02:00:00.000Z',summary:`最近记录 ${i}｜客户 当前客户`});
   const first=await read(h,endpoint,{page:1,pageSize:10});assert.equal(first.logs.length,10);assert.equal(first.pagination.total,66);assert.ok(!ids(first).includes(target));assert.ok(first.filterOptions.actions.includes(action));assert.ok(first.filterOptions.operators.includes('历史操作员'));
   const selected=await read(h,endpoint,{q:'唯一关键字',action,operator:'历史操作员',location:'B3',customer:'历史客户',from:'2026-09-01',to:'2026-09-01',pageSize:10,status:'active'});assert.deepEqual(ids(selected),[target]);assert.equal(selected.pagination.total,1);assert.equal(selected.pagination.totalPages,1);assert.ok(selected.filterOptions.actions.includes(otherAction));assert.ok(selected.filterOptions.operators.includes('当前操作员'));
   assert.equal((await read(h,endpoint,{...{q:'唯一关键字',action,operator:'当前操作员'}})).pagination.total,0);
   const page=await read(h,endpoint,{page:7,pageSize:10});assert.equal(page.logs.length,6);assert.ok(ids(page).includes(target));assert.equal(page.pagination.totalPages,7);
  }finally{h.sqlite.close()}
 }
});

test('纽约日期自动夏令时整天：包括起点与日末，排除相邻两天，支持不带毫秒和时区偏移',async()=>{
 for(const endpoint of ['movements','audit']){
  const h=fresh();try{
   const action=endpoint==='movements'?'入库':'库位容量修改',cases=[['2026-10-02T03:59:59.999Z',false],['2026-10-02T04:00:00.000Z',true],['2026-10-03T03:59:59.999Z',true],['2026-10-03T04:00:00.000Z',false],['2026-10-02T00:00:00-04:00',true],['2026-10-02T23:59:59-04:00',true],['2026-10-02T12:00:00Z',true]];
   const expected=cases.flatMap(([stamp,included])=>{const id=insert(h,{action,stamp});return included?[id]:[]});const selected=await read(h,endpoint,{from:'2026-10-02',to:'2026-10-02',pageSize:100});assert.deepEqual(ids(selected),expected.sort((a,b)=>a-b));
   assert.equal((await read(h,endpoint,{from:'2026-10-02',pageSize:100})).pagination.total,6);assert.equal((await read(h,endpoint,{to:'2026-10-02',pageSize:100})).pagination.total,6);
  }finally{h.sqlite.close()}
 }
});

test('库位筛选匹配单库位、多值和移库箭头，避免A1匹配A10，并支持历史别名',async()=>{
 for(const endpoint of ['movements','audit']){
  const h=fresh();try{
   h.setting('warehouse_location_aliases',{'旧A1':'A1','原A1':'旧A1'});
   const action=endpoint==='movements'?'移库':'库位名称修改',matched=['A1','A1、B3','B3、A1','A1 → B3','B3 → A1','A1,B3','旧A1','旧A1、B3'];
   const expected=matched.map(location=>insert(h,{action,location}));for(const location of ['A10','A11','XA1','A1X','A10、B3','A10 → B3'])insert(h,{action,location});
   for(const location of ['A1','旧A1','原A1']){const selected=await read(h,endpoint,{location,pageSize:100});assert.deepEqual(ids(selected),expected,`${endpoint} location=${location} 应精确匹配并关联历史名称`);}
   assert.equal((await read(h,endpoint,{location:'A10',pageSize:100})).pagination.total,3);
  }finally{h.sqlite.close()}
 }
});

test('搜索与客户筛选把百分号、下划线、引号当字面内容，并按普通文本大小写搜索',async()=>{
 for(const endpoint of ['movements','audit']){
  const h=fresh();try{
   const action=endpoint==='movements'?'入库':'库位容量修改',literal=insert(h,{action,summary:"特殊100%_ 'Quoted' 客户A%_ SKU-AbC",location:'B3'});
   insert(h,{action,summary:'特殊100AB客户AA SKU-other'});insert(h,{action,summary:'只有100%符号 客户A%'});insert(h,{action,summary:'只有下划线_ 客户A_'});
   for(const q of ['100%_',"'Quoted'",'sku-abc'])assert.deepEqual(ids(await read(h,endpoint,{q,pageSize:100})),[literal]);
   assert.deepEqual(ids(await read(h,endpoint,{customer:'客户A%_',pageSize:100})),[literal]);assert.equal((await read(h,endpoint,{q:"' OR 1=1 --",pageSize:100})).pagination.total,0);
  }finally{h.sqlite.close()}
 }
});

test('出入库撤销状态在全量记录中筛选，管理记录按撤销痕迹判断源记录',async()=>{
 const h=fresh();try{
  const moved=insert(h,{action:'出库'}),active=insert(h,{action:'入库'}),restore=insert(h,{action:'恢复',entityType:'原记录',location:String(moved),summary:`恢复原记录 ${moved}`});
  const reverted=await read(h,'movements',{status:'restored',pageSize:100});assert.deepEqual(ids(reverted),[moved,restore]);assert.ok(reverted.restoredIds.includes(moved));assert.deepEqual(ids(await read(h,'movements',{status:'active',pageSize:100})),[active]);
  const admin=insert(h,{action:'库位容量修改'}),untouched=insert(h,{action:'地图布局修改'}),undo=insert(h,{action:'撤销管理设置',entityType:'管理记录',location:String(admin),summary:`撤销原记录 ${admin}`});
  assert.deepEqual(ids(await read(h,'audit',{status:'restored',pageSize:100})),[restore,admin,undo]);const activeManagement=ids(await read(h,'audit',{status:'active',pageSize:100}));assert.ok(activeManagement.includes(untouched));assert.ok(!activeManagement.includes(undo));assert.ok(!activeManagement.includes(admin));
  assert.equal((await read(h,'movements',{operationsOnly:1,pageSize:100})).filterOptions.actions.includes('恢复'),false);
 }finally{h.sqlite.close()}
});

test('记录接口校验无效筛选、日期和状态；分页规格受限；鉴权分开且失败不泄露记录',async()=>{
 const h=fresh();try{
  insert(h,{action:'入库'});insert(h,{action:'库位容量修改'});
  for(const endpoint of ['movements','audit']){
   for(const filter of [{from:'2026-02-30'},{to:'2026-13-01'},{from:'2026-1-1'},{from:'2026-10-03',to:'2026-10-02'},{status:'pending'},{q:'a'.repeat(501)}]){const r=await h.call(path(endpoint,filter));assert.equal(r.status,400,JSON.stringify(r.data));assert.ok(!r.data.logs);}
   for(const [token,status] of [['missing-token',401],...(endpoint==='audit'?[['test-token-2',403],['test-token-3',403]]:[])]){const r=await h.call(path(endpoint,{q:'隐藏'}),'GET',undefined,token);assert.equal(r.status,status);assert.ok(!r.data.logs);}
   const clamp=await read(h,endpoint,{page:-5,pageSize:999});assert.equal(clamp.pagination.page,1);assert.equal(clamp.pagination.pageSize,100);assert.equal((await read(h,endpoint,{page:'1.9',pageSize:'2.8'})).pagination.pageSize,2);
  }
  assert.equal((await h.call('movements','GET',undefined,'test-token-3')).status,200);assert.equal((await h.call('audit','GET',undefined,'test-token-4')).status,200);
 }finally{h.sqlite.close()}
});

function memoryR2(){
 const entries=new Map(),reads=[],puts=[],values=new Map();
 const add=(key,day,customMetadata)=>entries.set(key,{key,size:17,uploaded:new Date(`2026-09-${String(day).padStart(2,'0')}T00:00:00Z`),...(customMetadata?{customMetadata}:{})});
 const bucket={
  async list(options){reads.push({...options});assert.deepEqual(Array.from(options.include),['customMetadata']);const rows=[...entries.values()].filter(row=>row.key.startsWith(options.prefix)).sort((a,b)=>a.key.localeCompare(b.key)),offset=options.cursor?Number(options.cursor):0,page=rows.slice(offset,offset+2);return{objects:page.map(row=>({...row})),truncated:offset+2<rows.length,...(offset+2<rows.length?{cursor:String(offset+2)}:{})};},
  async get(key){return values.has(key)?{text:async()=>values.get(key)}:null;},
  async delete(keys){for(const key of keys){entries.delete(key);values.delete(key)}},
  async put(key,value,options){puts.push({key,value,options});values.set(key,value);entries.set(key,{key,size:value.length,uploaded:new Date(),customMetadata:options?.customMetadata});},
 };
 return{entries,reads,puts,add,bucket};
}

test('备份列表读取backups和archives两个前缀全部分页及customMetadata，统一排序并保留老数据未记录',async()=>{
 const r2=memoryR2();for(let i=1;i<=5;i++)r2.add(`backups/manual-${i}.json`,i,i===1?undefined:{kind:i===2?'daily':'manual',createdBy:`操作员${i}`});for(let i=1;i<=4;i++)r2.add(`archives/audit-${i}.json`,10+i,i===1?undefined:{kind:'archive',createdBy:'系统自动',recordCount:String(i*10)});
 const h=fresh({BACKUPS:r2.bucket});try{
  const r=await h.call('backups','GET',undefined,'test-token-5');assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.data.backups.length,9);assert.deepEqual(r.data.backups.map(row=>row.key),[...r2.entries.values()].sort((a,b)=>b.uploaded-a.uploaded).map(row=>row.key));
  for(const prefix of ['backups/','archives/']){const calls=r2.reads.filter(call=>call.prefix===prefix);assert.equal(calls.length,prefix==='backups/'?3:2);assert.equal(calls[0].cursor,undefined);assert.equal(calls[1].cursor,'2');assert.ok(calls.every(call=>call.limit===1000));}
  const old=r.data.backups.find(row=>row.key==='backups/manual-1.json');assert.equal(old.createdBy,'未记录');assert.equal(old.kind,'backup');const archive=r.data.backups.find(row=>row.key==='archives/audit-4.json');assert.equal(archive.createdBy,'系统自动');assert.equal(archive.recordCount,40);assert.equal(r.data.backups.find(row=>row.key==='archives/audit-1.json').kind,'archive');assert.deepEqual(r.data.retention,{manual:100,daily:90,monthly:12,weekly:1,beforeRestore:20,archiveAfterDays:365});
 }finally{h.sqlite.close()}
});

test('手动备份写入真实登录人元数据并出现在列表，缺权限与未登录均不会读取R2',async()=>{
 const r2=memoryR2(),h=fresh({BACKUPS:r2.bucket});try{
  const r=await h.call('backups','POST',{},'test-token-5');assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r2.puts.length,1);const saved=r2.puts[0];assert.equal(saved.options.customMetadata.createdBy,'实际备份操作员');assert.equal(saved.options.customMetadata.kind,'manual');assert.equal(saved.options.httpMetadata.contentType,'application/json');assert.equal(JSON.parse(saved.value).version,9);
  const list=await h.call('backups','GET',undefined,'test-token-5');assert.equal(list.status,200);assert.equal(list.data.backups[0].key,r.data.key);assert.equal(list.data.backups[0].createdBy,'实际备份操作员');assert.equal(list.data.backups[0].kind,'manual');
  const before=r2.reads.length;for(const [token,status] of [['missing-token',401],['test-token-2',403],['test-token-3',403]])assert.equal((await h.call('backups','GET',undefined,token)).status,status);assert.equal(r2.reads.length,before);
 }finally{h.sqlite.close()}
});
