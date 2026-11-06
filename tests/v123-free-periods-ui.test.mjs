import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import React from 'react';
const require=createRequire(import.meta.url),tick=()=>new Promise(r=>setImmediate(r));
const nodes=t=>!t||typeof t!=='object'?[]:[t,...React.Children.toArray(t.props?.children).flatMap(nodes)];
const text=t=>nodes(t).map(n=>React.Children.toArray(n.props?.children).filter(c=>typeof c==='string'||typeof c==='number').join('')).join(' ');
const row=(overrides={})=>({id:'stock:1',kind:'stock',customerName:'客户A',productName:'已到期手机',sku:'SKU-OLD',locationCode:'A1',layer:1,inboundDate:'2026-09-24',billingInboundDate:'2026-09-20',freeDays:30,freeUntilDate:'2026-10-19',chargeStartDate:'2026-10-20',daysRemaining:0,daysOverdue:0,status:'expired',reviewReasons:[],...overrides});
const payload=()=>({asOf:'2026-10-24',nearDays:7,customers:['客户A','客户B'],summary:{expiredCount:1,nearCount:1,reviewCount:1},rows:[row(),row({id:'2',customerName:'客户B',productName:'临近箱货',sku:'BOX',kind:'carton',status:'near',daysRemaining:7}),row({id:'3',customerName:'',productName:'无日期货物',inboundDate:'',status:'review',chargeStartDate:null,freeUntilDate:null,daysRemaining:null,daysOverdue:null,reviewReasons:['unclaimed-customer','invalid-inbound-date']})]});
function page(options={}){
 const config={authStatus:200,user:{id:1,username:'boss',role:'admin'},data:payload(),dataStatus:200,directoryStatus:200,customers:['客户A','客户B'],unclaimedCount:1,...options};
 const states=[],deps=[],cleanups=[],queued=[],cache=new Map(),calls=[];let cursor=0,tree;
 const hooks={...React,useState:init=>{const i=cursor++;if(!(i in states))states[i]=typeof init==='function'?init():init;return[states[i],value=>{states[i]=typeof value==='function'?value(states[i]):value}]},useEffect:(fn,values)=>{const i=cursor++;if(!deps[i]||values.some((v,j)=>!Object.is(v,deps[i][j]))){deps[i]=values;queued.push(()=>{cleanups[i]?.();cleanups[i]=fn()})}},useMemo:fn=>fn(),useRef:init=>{const i=cursor++;if(!(i in states))states[i]={current:init};return states[i]}};
 const fetch=async(url,request={})=>{calls.push({url,request});if(config.fail)throw Error('网络暂不可用');if(url==='/api/auth/me')return{status:config.authStatus,ok:config.authStatus===200,json:async()=>({user:config.user})};if(url==='/api/pricing/customers')return{status:config.directoryStatus,ok:config.directoryStatus===200,json:async()=>config.directoryStatus===200?{customers:config.customers,unclaimedCount:config.unclaimedCount}:{error:'客户目录读取失败'}};if(config.query)return config.query(url,request);const parsed=new URL(url,'http://local.test'),customer=parsed.searchParams.get('customer');const rows=config.data.rows.filter(r=>parsed.searchParams.has('unclaimed')?!r.customerName:r.customerName===customer);return{status:config.dataStatus,ok:config.dataStatus===200,json:async()=>config.dataStatus===200?{...config.data,rows}:{error:'免租资料暂不可用'}};};
 const load=file=>{file=resolve(file);if(file.endsWith('.css'))return {};if(cache.has(file))return cache.get(file);const exports={};cache.set(file,exports);const code=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;runInNewContext(code,{exports,require:s=>{if(s==='react')return hooks;if(!s.startsWith('.'))return require(s);let p=resolve(dirname(file),s);if(!existsSync(p))p+=existsSync(p+'.tsx')?'.tsx':'.ts';return load(p)},console,Error,fetch,AbortController,URLSearchParams});return exports;};
 const Component=load('components/StorageFreePeriodsPage.tsx').StorageFreePeriodsPage;
 const render=()=>{cursor=0;tree=Component();while(queued.length)queued.shift()();return tree};
 const input=(label,value)=>{const n=nodes(tree).find(n=>n.props?.['aria-label']===label);assert.ok(n,`missing ${label}`);n.props.onChange({target:{value}});render();};
 const click=label=>{const b=nodes(tree).find(n=>n.type==='button'&&text(n).trim()===label);assert.ok(b,`missing ${label}`);b.props.onClick();render();};
 render();return{options:config,calls,render,input,click,get tree(){return tree},ready:async()=>{await tick();render();await tick();render();}};
}

test('initial page authenticates and reads only lightweight customer directory until one customer is chosen',async()=>{
 const p=page();await p.ready();assert.deepEqual(p.calls.map(x=>x.url),['/api/auth/me','/api/pricing/customers']);assert.match(text(p.tree),/请先选择客户/);assert.doesNotMatch(text(p.tree),/已到期手机|SKU-OLD|临近箱货/);assert.equal(nodes(p.tree).filter(n=>n.type==='table').length,0);
 p.input('客户','客户A');await p.ready();assert.equal(p.calls.at(-1).url,'/api/pricing/free-periods?customer=%E5%AE%A2%E6%88%B7A');assert.match(text(p.tree),/已到期手机/);assert.doesNotMatch(text(p.tree),/临近箱货/);
 assert.equal(nodes(p.tree).find(n=>n.type==='a'&&text(n).includes('返回计价')).props.href,'/?pricing=1');
});

test('employee nonboss and signed-out gates never read customer directory or goods',async()=>{
 for(const options of [{user:{username:'user2',role:'admin',permissions:['pricing.manage']}},{user:{username:'user3',role:'employee',permissions:['pricing.manage']}},{authStatus:401}]){const p=page(options);await p.ready();assert.equal(p.calls.length,1);assert.match(text(p.tree),/请先登录|无权访问/);}
});

test('selected customer rows use compact table pagination and local search status filtering',async()=>{
 const data={...payload(),rows:Array.from({length:31},(_,i)=>row({id:'stock:'+i,productName:'货物'+i,status:i===0?'near':'expired',daysRemaining:i===0?7:0}))};
 const p=page({data});await p.ready();p.input('客户','客户A');await p.ready();assert.equal(nodes(p.tree).filter(n=>n.type==='tbody')[0].props.children.length,25);assert.match(text(p.tree),/第 1 \/ 2 页/);p.click('下一页');assert.match(text(p.tree),/货物30/);assert.doesNotMatch(text(p.tree),/货物0 /);
 p.input('到期状态','near');assert.match(text(p.tree),/货物0/);assert.doesNotMatch(text(p.tree),/货物30/);p.input('搜索货物','not found');assert.match(text(p.tree),/没有符合条件的货物/);assert.equal(p.calls.length,3);
 p.click('清除筛选');assert.match(text(p.tree),/请先选择客户/);assert.equal(nodes(p.tree).filter(n=>n.type==='table').length,0);assert.equal(p.calls.length,3);
});

test('unclaimed selection queries only unclaimed and offers explicit inline assignment component',async()=>{
 const p=page();await p.ready();p.input('客户','__unclaimed__');await p.ready();assert.equal(p.calls.at(-1).url,'/api/pricing/free-periods?unclaimed=1');assert.match(text(p.tree),/无日期货物/);assert.doesNotMatch(text(p.tree),/已到期手机/);const picker=nodes(p.tree).find(n=>typeof n.type==='function'&&n.type.name==='UnclaimedCustomerPicker');assert.ok(picker);assert.equal(picker.props.recordId,'3');assert.deepEqual(Array.from(picker.props.customers),['客户A','客户B']);
});

test('row preserves physical inbound, layer billing date, zero-free-day and status distinctions',async()=>{
 const p=page({data:{...payload(),rows:[row({inboundDate:'2026-10-24',freeDays:0,freeUntilDate:null,chargeStartDate:'2026-10-24'})]}});await p.ready();p.input('客户','客户A');await p.ready();const t=text(p.tree);for(const value of ['实际入库日','层计费起算入库日','2026-09-20','2026-10-24','无免租期','今日开始计费','SKU-OLD','A1 / 第 1 层'])assert.ok(t.includes(value),value);assert.doesNotMatch(t,/2026-10-19/);
});

test('empty selected result and query failure remain explicit and retry retains customer',async()=>{
 const p=page({dataStatus:500});await p.ready();p.input('客户','客户A');await p.ready();assert.match(text(p.tree),/免租资料暂不可用/);assert.doesNotMatch(text(p.tree),/已到期手机/);p.options.dataStatus=200;p.options.data={...payload(),rows:[]};p.click('重试查询');await p.ready();assert.match(text(p.tree),/暂无在库货物/);assert.equal(p.calls.at(-1).url,'/api/pricing/free-periods?customer=%E5%AE%A2%E6%88%B7A');
});

test('late response for a previous customer cannot populate a newer selection or cleared screen',async()=>{
 const waiting=[];const p=page({query:(url)=>new Promise(resolve=>waiting.push({url,resolve}))});await p.ready();p.input('客户','客户A');p.input('客户','客户B');waiting[1].resolve({status:200,ok:true,json:async()=>({...payload(),rows:[row({customerName:'客户B',productName:'B独有货物'})]})});await p.ready();assert.match(text(p.tree),/B独有货物/);waiting[0].resolve({status:200,ok:true,json:async()=>payload()});await p.ready();assert.doesNotMatch(text(p.tree),/已到期手机/);p.click('清除筛选');assert.doesNotMatch(text(p.tree),/B独有货物/);
});

test('directory failures retry authenticated reads without querying unselected inventory',async()=>{
 const p=page({directoryStatus:500});await p.ready();assert.match(text(p.tree),/客户目录读取失败/);p.options.directoryStatus=200;p.click('重试');await p.ready();assert.match(text(p.tree),/请先选择客户/);assert.ok(p.calls.every(c=>!c.url.startsWith('/api/pricing/free-periods')));
});

test('dedicated route renders the page component',()=>{const source=readFileSync('app/pricing/free-periods/page.tsx','utf8'),exports={};runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,require:s=>s.includes('StorageFreePeriodsPage')?{StorageFreePeriodsPage:()=>null}:require(s)});assert.equal(exports.default().type.name,'StorageFreePeriodsPage');});
test('staged free-period row keeps physical location and shows differing original billing layer without changing dates',async()=>{
 const p=page({data:{...payload(),rows:[row({locationCode:'待出库',layer:1,billingLocationCode:'A1',billingLayer:2})]}});await p.ready();p.input('客户','客户A');await p.ready();const tr=nodes(p.tree).find(n=>n.type==='tbody').props.children[0];assert.match(text(tr),/待出库 \/ 第 1 层/);assert.match(text(tr),/按 A1 第2层计价/);assert.match(text(tr),/2026-09-24/);assert.match(text(tr),/2026-09-20/);assert.match(text(tr),/2026-10-19/);
});
test('pallet-mode expiry page shows separate batch free clocks and pallet amounts',async()=>{const p=page({data:{...payload(),arrivalPolicy:'batch',rows:[row({palletCount:.5,inboundDate:'2026-09-01',billingInboundDate:'2026-09-01',chargeStartDate:'2026-10-01',status:'expired'}),row({id:'new',palletCount:.5,inboundDate:'2026-10-20',billingInboundDate:'2026-10-20',chargeStartDate:'2026-11-19',status:'free',daysRemaining:26})]}});await p.ready();p.input('客户','客户A');await p.ready();const t=text(p.tree);assert.match(t,/批次免租起算日/);assert.match(t,/各到仓批次按自己的入库日独立计算免租/);assert.match(t,/2026-10-01/);assert.match(t,/2026-11-19/);assert.match(t,/1\/2 托/);assert.doesNotMatch(t,/同客户同层按最早/);const tr=nodes(p.tree).filter(n=>n.type==='tbody').flatMap(n=>React.Children.toArray(n.props.children));assert.equal(tr.length,2);assert.match(text(tr[0]),/已到期/);assert.match(text(tr[1]),/免租中/);});
