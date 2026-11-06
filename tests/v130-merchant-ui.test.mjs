import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import React from 'react';
const require=createRequire(import.meta.url),tick=()=>new Promise(r=>setImmediate(r));
const nodes=t=>!t||typeof t!=='object'?[]:[t,...React.Children.toArray(t.props?.children).flatMap(nodes)];
const text=t=>nodes(t).map(n=>React.Children.toArray(n.props?.children).filter(c=>typeof c==='string'||typeof c==='number').join('')).join(' ');
const visibleText=t=>typeof t==='string'||typeof t==='number'?String(t):!t||typeof t!=='object'?'':React.Children.toArray(t.type==='details'&&!t.props.open?React.Children.toArray(t.props.children).find(child=>child.type==='summary'):t.props?.children).map(visibleText).join(' ');
const record=(id,kind='stock',customerName='客户A',extra={})=>({id,kind,customerName,product:'手机',sku:'SKU-A',locationCode:'A1',layer:2,inboundDate:'2026-09-01',outboundDate:kind==='history'?'2026-10-10':null,quantity:12,boxes:kind==='carton'?3:0,...extra});
const preview=()=>({previewToken:'preview-1',targetCustomerName:'客户C',affected:{stocks:1,cartons:1,history:1},customers:[{name:'客户A',beforeFee:30,afterFee:0,beforePending:0,afterPending:0},{name:'客户C',beforeFee:null,afterFee:22,beforePending:1,afterPending:1}],period:{fromMonth:'2026-09',toMonth:'2026-10'},notices:['沿用目标客户费率与免租期']});
const response=(data,status=200)=>({ok:status===200,status,json:async()=>data});
function workspace(options={}){
 const config={directory:{customers:['客户A','客户B','客户C'],records:[],revision:'rev-1',changes:[]},records:{客户A:[record('stock:1'),record('carton:R:1','carton'),record('history:H1','history')],客户B:[record('stock:2','stock','客户B',{sku:'SKU-B',product:'箱货'})],__unclaimed__:[record('carton:R:2','carton','')]},...options};
 const states=[],deps=[],cleanups=[],queued=[],cache=new Map(),calls=[],saved=[];let cursor=0,tree,closed=0;
 const props={period:{fromMonth:'2026-09',toMonth:'2026-10'},asOf:'2026-10-27',onClose:()=>closed++,onSaved:target=>saved.push(target)};
 const hooks={...React,useState:init=>{const i=cursor++;if(!(i in states))states[i]=typeof init==='function'?init():init;return[states[i],v=>{states[i]=typeof v==='function'?v(states[i]):v}]},useEffect:(fn,values)=>{const i=cursor++;if(!deps[i]||values.some((v,j)=>!Object.is(v,deps[i][j]))){deps[i]=values;queued.push(()=>{cleanups[i]?.();cleanups[i]=fn()})}},useMemo:fn=>fn(),useCallback:(fn,values)=>{const i=cursor++;if(!deps[i]||values.some((v,j)=>!Object.is(v,deps[i][j]))){deps[i]=values;states[i]=fn;}return states[i]},useRef:init=>{const i=cursor++;if(!(i in states))states[i]={current:init};return states[i]}};
 const fetch=async(url,request={})=>{calls.push({url,request});if(config.query){const result=config.query(url,request);if(result!==undefined)return result;}if(request.method==='POST')return response(preview());if(request.method==='PUT')return response({...preview(),saved:true,changeId:'change-1'});if(request.method==='DELETE')return response({ok:true});const customer=new URL(url,'http://local.test').searchParams.get('customer');return response({...config.directory,records:customer?config.records[customer]??[]:[]});};
 const load=file=>{file=resolve(file);if(file.endsWith('.css'))return{};if(cache.has(file))return cache.get(file);const exports={};cache.set(file,exports);runInNewContext(ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText,{exports,require:s=>{if(s==='react')return hooks;if(!s.startsWith('.'))return require(s);let p=resolve(dirname(file),s);if(!existsSync(p))p+=existsSync(p+'.tsx')?'.tsx':'.ts';return load(p)},fetch,Error,console,AbortController,URLSearchParams});return exports;};
 const Component=load('components/MerchantChangeWorkspace.tsx').MerchantChangeWorkspace;
 const render=()=>{cursor=0;tree=Component(props);while(queued.length)queued.shift()();return tree;};
 const find=label=>nodes(tree).find(n=>n.props?.['aria-label']===label||typeof n.type==='function'&&n.props?.label===label);
 const input=(label,value)=>{const n=find(label);assert.ok(n,`missing ${label}`);n.props.onChange(typeof n.type==='function'?value:{target:{value}});render();};
 const check=(label,checked=true)=>{const n=find(label);assert.ok(n,`missing ${label}`);n.props.onChange({target:{checked}});render();};
 const button=label=>nodes(tree).find(n=>n.type==='button'&&text(n).trim()===label);
 const click=label=>{const b=button(label);assert.ok(b,`missing ${label}`);b.props.onClick();render();};
 render();return{config,calls,saved,props,find,input,check,button,click,render,get closed(){return closed},get tree(){return tree},ready:async()=>{await tick();render();await tick();render();}};
}
const writes=p=>p.calls.filter(c=>c.request.method);
const prepare=async p=>{await p.ready();p.check('合并客户 客户A');p.input('目标客户','客户C');p.click('预览变更');await p.ready();};

test('initial directory is lightweight and global mode previews only explicit old customers',async()=>{
 const p=workspace();await p.ready();assert.deepEqual(p.calls.map(c=>c.url),['/api/pricing/merchants']);assert.equal(p.button('预览变更').props.disabled,true);assert.doesNotMatch(text(p.tree),/SKU-A/);
 p.check('合并客户 客户A');p.input('目标客户',' 客户C ');p.click('预览变更');await p.ready();
 assert.deepEqual(JSON.parse(writes(p)[0].request.body),{mode:'customers',sources:['客户A'],targetCustomerName:'客户C',expectedRevision:'rev-1',fromMonth:'2026-09',toMonth:'2026-10',asOf:'2026-10-27'});
 const output=text(p.tree);for(const value of ['库存 1','箱记录 1','历史出库 1','$30.00','$22.00','待核对','保留原客户名称和金额','沿用目标客户费率与免租期'])assert.ok(output.includes(value),value);
 assert.equal(writes(p).length,1);assert.equal(p.saved.length,0);
});

test('record mode queries a chosen customer and keeps explicit selections across customer and text filters',async()=>{
 const p=workspace();await p.ready();p.click('选择记录调整');assert.equal(p.calls.length,1);assert.match(text(p.tree),/请先选择客户/);
 p.input('记录所属客户','客户');await p.ready();assert.equal(p.calls.length,1);
 p.input('记录所属客户','客户A');await p.ready();assert.equal(p.calls.at(-1).url,'/api/pricing/merchants?customer=%E5%AE%A2%E6%88%B7A');
 assert.match(text(p.tree),/2026-09-01/);assert.match(text(p.tree),/2026-10-10/);assert.match(text(p.tree),/12 件/);assert.match(text(p.tree),/3 箱/);
 p.check('选择记录 stock:1');p.input('搜索记录','history:H1');p.check('全选当前筛选记录');
 p.input('记录所属客户','客户B');await p.ready();p.input('搜索记录','');p.check('选择记录 stock:2');p.input('目标客户','客户C');p.click('预览变更');await p.ready();
 assert.deepEqual(JSON.parse(writes(p)[0].request.body),{mode:'records',records:['history:H1','stock:1','stock:2'],targetCustomerName:'客户C',expectedRevision:'rev-1',fromMonth:'2026-09',toMonth:'2026-10',asOf:'2026-10-27'});
 assert.match(text(p.tree),/已选 3 条/);
});

test('carton and unclaimed records are explicit choices and filtered select-all never changes hidden rows',async()=>{
 const p=workspace();await p.ready();p.click('选择记录调整');p.input('记录所属客户','客户A');await p.ready();p.check('选择记录 carton:R:1');
 p.input('搜索记录','SKU-A');p.check('全选当前筛选记录');p.input('搜索记录','history:H1');p.check('全选当前筛选记录',false);
 p.click('未认领');await p.ready();assert.match(p.calls.at(-1).url,/customer=__unclaimed__/);p.input('搜索记录','');p.check('选择记录 carton:R:2');p.input('目标客户','新客户');p.click('预览变更');await p.ready();
 assert.deepEqual(JSON.parse(writes(p)[0].request.body).records,['carton:R:1','carton:R:2','stock:1']);
});

test('editing inputs, scope, filters, or the parent period makes an earlier preview unsaveable',async()=>{
 for(const edit of [p=>p.input('目标客户','客户B'),p=>p.check('合并客户 客户B'),p=>p.input('搜索原客户','A'),p=>p.click('选择记录调整'),p=>{p.props.period={fromMonth:'2026-10',toMonth:'2026-10'};p.render();}]){
  const p=workspace();await prepare(p);assert.ok(p.button('确认保存'));edit(p);assert.equal(p.button('确认保存'),undefined);assert.equal(writes(p).length,1);
 }
});

test('late preview responses and late previous-customer rows never replace the edited scope',async()=>{
 let finish;const p=workspace({query:(url,r)=>r.method==='POST'?new Promise(resolve=>finish=resolve):undefined});await p.ready();p.check('合并客户 客户A');p.input('目标客户','客户C');p.click('预览变更');p.input('目标客户','客户B');finish(response(preview()));await p.ready();assert.equal(p.button('确认保存'),undefined);
 const pending=[];const q=workspace({query:(url,r)=>!r.method&&url.includes('?customer=')?new Promise(resolve=>pending.push(resolve)):undefined});await q.ready();q.click('选择记录调整');q.input('记录所属客户','客户A');q.input('记录所属客户','客户B');pending[1](response({customers:['客户A','客户B'],revision:'rev-1',records:[record('stock:B','stock','客户B',{product:'B专属货'})]}));await q.ready();pending[0](response({customers:['客户A','客户B'],revision:'rev-1',records:[record('stock:A')]}));await q.ready();assert.match(text(q.tree),/B专属货/);assert.equal(q.find('选择记录 stock:A'),undefined);
});

test('save is single flight, uses the preview token, and finish refreshes the selected target',async()=>{
 let finish;const p=workspace({query:(url,r)=>r.method==='PUT'?new Promise(resolve=>finish=resolve):undefined});await prepare(p);const save=p.button('确认保存').props.onClick;save();save();p.render();assert.equal(writes(p).filter(c=>c.request.method==='PUT').length,1);assert.equal(JSON.parse(writes(p).at(-1).request.body).previewToken,'preview-1');finish(response({...preview(),saved:true,changeId:'change-1'}));await p.ready();assert.match(text(p.tree),/已保存/);assert.ok(p.button('撤销本次调整'));p.click('完成并查看目标客户');assert.deepEqual(p.saved,['客户C']);
});

test('JSON preview/save errors stay visible, retain choices and require a fresh preview after conflict',async()=>{
 const p=workspace({query:(url,r)=>r.method==='POST'?response({error:'目标客户费率待补充'},400):undefined});await prepare(p);assert.match(text(p.tree),/目标客户费率待补充/);assert.equal(p.find('合并客户 客户A').props.checked,true);assert.equal(p.button('确认保存'),undefined);
 p.config.query=(url,r)=>r.method==='PUT'?response({error:'资料已改变，请重新预览'},409):undefined;p.click('预览变更');await p.ready();p.click('确认保存');await p.ready();assert.match(text(p.tree),/资料已改变，请重新预览/);assert.equal(p.button('确认保存'),undefined);assert.equal(p.saved.length,0);assert.equal(p.find('目标客户').props.value,'客户C');
});

test('saved safe undo sends a single scoped deletion, reloads directory and retains dependency errors',async()=>{
 const p=workspace();await prepare(p);p.click('确认保存');await p.ready();p.config.query=(url,r)=>r.method==='DELETE'?response({error:'已有后续计价，不能撤销'},409):undefined;p.click('撤销本次调整');await p.ready();assert.match(text(p.tree),/已有后续计价，不能撤销/);assert.deepEqual(JSON.parse(writes(p).at(-1).request.body),{changeId:'change-1'});assert.equal(p.saved.length,0);
 p.config.query=undefined;p.click('撤销本次调整');await p.ready();assert.match(text(p.tree),/已撤销/);assert.equal(p.calls.at(-1).request.method,undefined);assert.equal(p.calls.at(-1).url,'/api/pricing/merchants');assert.equal(p.button('撤销本次调整'),undefined);
});

test('directory failures are retryable and do not silently create an empty available scope',async()=>{
 const p=workspace({query:()=>response({error:'客户目录读取失败'},500)});await p.ready();assert.match(text(p.tree),/客户目录读取失败/);assert.equal(p.button('预览变更').props.disabled,true);p.config.query=undefined;p.click('重试目录');await p.ready();assert.ok(p.find('合并客户 客户A'));assert.equal(writes(p).length,0);
});

test('a recent safe undo requires an inline choice and refreshes the parent when leaving',async()=>{
 const p=workspace({directory:{customers:['客户A'],records:[],revision:'rev-1',changes:[{id:'earlier-change',createdAt:'2026-10-27 09:00',summary:'客户A 合并至 客户C',canUndo:true},{id:'blocked-change',createdAt:'2026-10-26',summary:'已计费调整',canUndo:false,reason:'存在后续已确认账单'}]}});await p.ready();assert.match(text(p.tree),/存在后续已确认账单/);p.click('撤销此调整');assert.equal(writes(p).length,0);p.click('取消撤销');assert.equal(writes(p).length,0);p.click('撤销此调整');p.click('确认撤销此调整');await p.ready();assert.deepEqual(JSON.parse(writes(p)[0].request.body),{changeId:'earlier-change'});p.click('关闭');assert.deepEqual(p.saved,['']);
});

test('a target included in global sources blocks preview and cancel never writes',async()=>{
 const p=workspace();await p.ready();p.check('合并客户 客户A');p.input('目标客户','客户A');assert.equal(p.button('预览变更').props.disabled,true);assert.match(text(p.tree),/取消该项勾选/);p.click('取消');assert.equal(p.closed,1);assert.equal(writes(p).length,0);
});

test('opaque record identifiers stay in closed details while stable checkbox selection remains usable',async()=>{
 const p=workspace();await p.ready();p.click('选择记录调整');p.input('记录所属客户','客户A');await p.ready();
 assert.doesNotMatch(visibleText(p.tree),/stock:1|carton:R:1|history:H1/);assert.match(visibleText(p.tree),/手机|SKU-A|A1|2026-09-01/);
 const row=nodes(p.tree).find(n=>n.type==='tr'&&nodes(n).some(child=>child.props?.['aria-label']==='选择记录 stock:1'));
 const details=nodes(row).find(n=>n.type==='details');assert.ok(details);assert.ok(!details.props.open);assert.match(text(details),/stock:1/);
 p.check('选择记录 stock:1');p.input('目标客户','客户C');p.click('预览变更');await p.ready();assert.deepEqual(JSON.parse(writes(p)[0].request.body).records,['stock:1']);
});

test('a new customer GET revision clears stale record choices and requires viewing and reselecting fresh rows',async()=>{
 const p=workspace();await p.ready();p.click('选择记录调整');p.input('记录所属客户','客户A');await p.ready();p.check('选择记录 stock:1');p.input('目标客户','客户C');p.click('预览变更');await p.ready();
 p.config.directory.revision='rev-2';p.config.records.客户A=[record('stock:1','stock','客户A',{quantity:99})];p.input('记录所属客户','客户B');await p.ready();
 assert.match(text(p.tree),/资料已更新.*重新选择/);assert.match(text(p.tree),/已选 0 条/);assert.equal(p.button('确认保存'),undefined);assert.equal(p.button('预览变更').props.disabled,true);
 p.input('记录所属客户','客户A');await p.ready();assert.match(text(p.tree),/99 件/);assert.equal(p.find('选择记录 stock:1').props.checked,false);p.check('选择记录 stock:1');p.click('预览变更');await p.ready();assert.equal(JSON.parse(writes(p).at(-1).request.body).expectedRevision,'rev-2');assert.deepEqual(JSON.parse(writes(p).at(-1).request.body).records,['stock:1']);
});

test('row-error retry cannot retain selections against a newer revision',async()=>{
 const p=workspace();await p.ready();p.click('选择记录调整');p.input('记录所属客户','客户A');await p.ready();p.check('选择记录 stock:1');p.input('目标客户','客户C');p.config.query=(url,r)=>!r.method&&url.includes('customer=%E5%AE%A2%E6%88%B7B')?response({error:'临时读取失败'},500):undefined;p.input('记录所属客户','客户B');await p.ready();assert.match(text(p.tree),/临时读取失败/);
 p.config.query=undefined;p.config.directory.revision='rev-2';p.click('重试记录');await p.ready();assert.equal(p.button('预览变更').props.disabled,true);assert.match(text(p.tree),/资料已更新.*重新选择/);
});

test('directory-error retry cannot silently carry global sources onto a fresh revision',async()=>{
 const p=workspace();await prepare(p);p.config.query=(url,r)=>r.method==='PUT'?response({error:'资料冲突'},409):!r.method&&url==='/api/pricing/merchants'?response({error:'目录暂时不可用'},500):undefined;p.click('确认保存');await p.ready();assert.match(text(p.tree),/目录暂时不可用/);
 p.config.query=undefined;p.config.directory.revision='rev-2';p.click('重试目录');await p.ready();assert.equal(p.find('合并客户 客户A').props.checked,false);assert.equal(p.button('预览变更').props.disabled,true);assert.match(text(p.tree),/资料已更新.*重新选择/);
});

test('successful undo can adopt its new revision without replacing the actual undo result with a stale-selection warning',async()=>{
 const p=workspace();await prepare(p);p.click('确认保存');await p.ready();p.config.query=(url,r)=>{if(r.method==='DELETE'){p.config.directory.revision='rev-after-undo';return response({ok:true});}};p.click('撤销本次调整');await p.ready();assert.match(text(p.tree),/已撤销客户调整/);assert.doesNotMatch(text(p.tree),/已清空原选择/);assert.equal(p.button('预览变更').props.disabled,true);
});
