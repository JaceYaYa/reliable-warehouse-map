import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const require=createRequire(import.meta.url);
const receipt={id:'carton1',version:3,inboundOrder:'IB-5959',originalOrder:'FBA-OLD',orderHistory:[],customerName:'客户A',note:'原备注',inboundDate:'2026-10-09',totalBoxes:10,placements:[{key:'p1',locationCode:'A1',layerCount:1,boxes:10,marker:'右边'}]};
const props={receipt,placementKey:'p1',canEdit:true,canMove:true,canConvert:false,locations:['A1','B1','B2'],customerNames:[],draftKey:'qa',onChanged:async()=>{},onConverted:async()=>{}};
function harness({hooks=false,fetch=async()=>{throw Error('unexpected fetch')},saved={},storageError=()=>false}={}){
 const cache=new Map(),state=[];let cursor=0;
 const react=hooks?{...React,useState:init=>{const i=cursor++;if(!(i in state))state[i]=typeof init==='function'?init():init;return [state[i],v=>{state[i]=typeof v==='function'?v(state[i]):v}]},useRef:init=>{const i=cursor++;if(!(i in state))state[i]={current:init};return state[i]},useEffect:()=>{}}:React;
 function load(file){
  if(cache.has(file))return cache.get(file);if(file.endsWith('.css'))return {};
  const exports={};cache.set(file,exports);
  const code=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
  const localRequire=s=>{if(s==='react')return react;if(s==='react-dom')return {createPortal:v=>v};if(!s.startsWith('.'))return require(s);let path=resolve(dirname(file),s);if(!existsSync(path))path+=existsSync(path+'.tsx')?'.tsx':'.ts';return load(path)};
  runInNewContext(code,{exports,require:localRequire,console,Intl,Date,URL,document:{body:{}},crypto:{randomUUID:()=> 'request-1'},fetch,localStorage:{getItem:k=>saved[k]??null,setItem:(k,v)=>{if(storageError())throw Error('storage blocked');saved[k]=v},removeItem:k=>{delete saved[k]}}});return exports;
 }
 return {load:p=>load(resolve(p)),render:(fn,p)=>{cursor=0;return fn(p)},saved};
}
function nodes(tree){if(!tree||typeof tree!=='object')return [];return [tree,...React.Children.toArray(tree.props?.children).flatMap(nodes)]}
const text=t=>nodes(t).map(n=>React.Children.toArray(n.props?.children).filter(c=>typeof c==='string'||typeof c==='number').join('')).join(' ');
const button=(t,label)=>nodes(t).find(n=>n.type==='button'&&text(n).trim()===label);
const tick=()=>new Promise(r=>setImmediate(r));


function expand(tree){if(!tree||typeof tree!=='object')return tree;if(['StockDetailFields','CartonStockDetailsEditor','CartonIdentityDialog'].includes(tree.type?.name))return expand(tree.type(tree.props));return {...tree,props:{...tree.props,children:React.Children.toArray(tree.props?.children).map(expand)}}}
const view=(h,fn,p)=>expand(h.render(fn,p));
const field=(tree,label)=>nodes(tree).find(n=>n.type==='label'&&React.Children.toArray(n.props?.children).filter(v=>typeof v==='string').join('').trim()===label)?.props.children.find(n=>n&&typeof n==='object');

test('receipt ordinary editor exposes every stock detail and sends only selected placement values',async()=>{
 const calls=[],h=harness({hooks:true,fetch:async(path,options)=>{calls.push({path,body:JSON.parse(options.body)});return {ok:true,json:async()=>({})}}}),{CartonDetailsPanel}=h.load('components/CartonDetailsPanel.tsx');
 const p={...props,receipt:{...receipt,placements:[receipt.placements[0],{...receipt.placements[0],key:'p2',note:'other location'}]}};
 let t=view(h,CartonDetailsPanel,p);button(t,'修改信息').props.onClick();t=view(h,CartonDetailsPanel,p);
 for(const name of ['入库日期','来源','层数','品相','产品附加前缀','入库单号','备注'])assert.ok(field(t,name),name);
 field(t,'入库日期').props.onChange({target:{value:'2026-10-08'}});field(t,'来源').props.onChange({target:{value:'domestic'}});field(t,'层数').props.onChange({target:{value:'2'}});field(t,'品相').props.onChange({target:{value:'damaged'}});field(t,'产品附加前缀').props.onChange({target:{value:'左边'}});field(t,'入库单号').props.onChange({target:{value:'IB-NEW'}});field(t,'备注').props.onChange({target:{value:'selected note'}});
 nodes(t).find(n=>n.type?.name==='GoodsBarcodeInputs').props.onChange(['CODE-A','CODE-B']);
 t=view(h,CartonDetailsPanel,p);assert.doesNotMatch(text(t),/other location/);button(t,'保存修改').props.onClick();await tick();
 assert.deepEqual(calls,[{path:'/api/cartons/details',body:{requestId:'request-1',id:'carton1',expectedVersion:3,placementKey:'p1',details:{inboundDate:'2026-10-08',inboundSource:'domestic',layerCount:2,productCondition:'damaged',productPrefix:'左边',inboundOrder:'IB-NEW',barcodes:['CODE-A','CODE-B'],note:'selected note',palletCount:1}}}]);
});
test('unknown details submit survives close/reopen and blocks move correction conversion identity',async()=>{
 const saved={},calls=[];let fail=true;const fetch=async(path,options)=>{calls.push({path,body:JSON.parse(options.body)});if(fail)throw Error('offline');return {ok:true,json:async()=>({})}};
 let h=harness({hooks:true,saved,fetch}),{CartonDetailsPanel}=h.load('components/CartonDetailsPanel.tsx');const p={...props,canManageProduct:true,canConvert:true};let t=view(h,CartonDetailsPanel,p);button(t,'修改信息').props.onClick();t=view(h,CartonDetailsPanel,p);field(t,'备注').props.onChange({target:{value:'exact pending'}});t=view(h,CartonDetailsPanel,p);button(t,'保存修改').props.onClick();await tick();t=view(h,CartonDetailsPanel,p);button(t,'关闭，稍后核对').props.onClick();t=view(h,CartonDetailsPanel,p);
 for(const label of ['移动箱库存','修正箱数','转换成产品库存','修改名称 / SKU / 商家'])assert.equal(button(t,label).props.disabled,true,label);
 fail=false;h=harness({hooks:true,saved,fetch});({CartonDetailsPanel}=h.load('components/CartonDetailsPanel.tsx'));t=view(h,CartonDetailsPanel,p);button(t,'核对上次提交').props.onClick();await tick();assert.deepEqual(calls[1],calls[0]);assert.equal(saved.qa,undefined);
});
test('identity stays available inside ordinary editor and writes selected record without product creation',async()=>{
 const calls=[],h=harness({hooks:true,fetch:async(path,options)=>{calls.push({path,body:JSON.parse(options.body)});return {ok:true,json:async()=>({})}}}),{CartonDetailsPanel}=h.load('components/CartonDetailsPanel.tsx');const p={...props,canManageProduct:true,canCreateProduct:false};let t=view(h,CartonDetailsPanel,p);button(t,'修改信息').props.onClick();t=view(h,CartonDetailsPanel,p);button(t,'修改名称 / SKU / 商家').props.onClick();t=view(h,CartonDetailsPanel,p);assert.match(text(t),/仅修改当前箱库存记录/);field(t,'产品名称').props.onChange({target:{value:'箱中产品'}});field(t,'SKU').props.onChange({target:{value:'SKU-X'}});t=view(h,CartonDetailsPanel,p);button(t,'确认修改').props.onClick();await tick();assert.equal(calls[0].path,'/api/cartons/details');assert.deepEqual(calls[0].body.identity,{product:'箱中产品',sku:'SKU-X',customerName:'客户A'});assert.equal(calls[0].body.placementKey,'p1');assert.equal('details' in calls[0].body,false);
});
test('ordinary and legacy stock editors share the same full editable controls',()=>{
 const h=harness({hooks:true}),{StockDetailsPanel}=h.load('components/StockDetailsPanel.tsx');const p={value:{id:1,product:'P',sku:'S',customerName:'C',inboundDate:'2026-10-09',inboundSource:'unspecified',layerCount:1,inboundOrder:'IB',note:'n',fnsku:'',barcode:'',totalBoxes:2,totalQuantity:0,inventoryUnit:'box'},canEdit:true,canMove:false,onChange:()=>{},onSave:async()=>({ok:true}),onIdentitySaved:async()=>{},onMove:()=>{}};let t=view(h,StockDetailsPanel,p);button(t,'修改信息').props.onClick();t=h.render(StockDetailsPanel,p);assert.ok(nodes(t).some(n=>n.type?.name==='StockDetailFields'));
});

test('readonly effective placement metadata is selectable text and identity requires its separate permission',()=>{
 const {CartonDetailsPanel}=harness().load('components/CartonDetailsPanel.tsx');const p={...props,canEdit:false,canManageProduct:false,receipt:{...receipt,placements:[{...receipt.placements[0],details:{product:'当前箱名',sku:'LOCAL-SKU',customerName:'客户B',inboundDate:'2026-10-08',inboundSource:'return',productCondition:'damaged',inboundOrder:'LOCAL-ORDER',barcodes:['LOCAL-CODE']},note:'LOCAL-NOTE'}]}};
 const html=renderToStaticMarkup(React.createElement(CartonDetailsPanel,p));for(const value of ['当前箱名','LOCAL-SKU','客户B','2026-10-08','退货','残次品','LOCAL-ORDER','LOCAL-CODE','LOCAL-NOTE'])assert.ok(html.includes(value),value);assert.doesNotMatch(html,/<input|修改名称 \/ SKU \/ 商家/);
 const edit=renderToStaticMarkup(React.createElement(CartonDetailsPanel,{...p,canEdit:true,canManageProduct:false}));assert.match(edit,/修改信息/);assert.doesNotMatch(edit,/修改名称 \/ SKU \/ 商家/);
});
test('details request is persisted before fetch, retains unknown 5xx and parent refresh failure, but releases stale conflict',async()=>{
 for(const outcome of ['server','refresh','stale']){
  const saved={},calls=[];const h=harness({hooks:true,saved,fetch:async(path,options)=>{const body=JSON.parse(options.body);assert.deepEqual(JSON.parse(saved.qa).body,body);calls.push(body);return {ok:outcome==='refresh',status:outcome==='server'?503:409,json:async()=>({error:'conflict'})}}}),{CartonDetailsPanel}=h.load('components/CartonDetailsPanel.tsx'),p={...props,onChanged:async()=>{throw Error('refresh failed')}};
  let t=view(h,CartonDetailsPanel,p);button(t,'修改信息').props.onClick();t=view(h,CartonDetailsPanel,p);field(t,'备注').props.onChange({target:{value:'retained input'}});t=view(h,CartonDetailsPanel,p);button(t,'保存修改').props.onClick();await tick();t=view(h,CartonDetailsPanel,p);
  assert.equal(calls.length,1);assert.equal(!!saved.qa,outcome!=='stale');assert.equal(field(t,'备注').props.value,'retained input');assert.equal(button(t,outcome==='stale'?'保存修改':'核对上次提交')!==undefined,true);
 }
});
test('details storage failure aborts network and unknown identity restores source snapshot after selection changed',async()=>{
 let count=0;const blocked=harness({hooks:true,storageError:()=>true,fetch:async()=>{count++;return {ok:true,json:async()=>({})}}}),Panel=blocked.load('components/CartonDetailsPanel.tsx').CartonDetailsPanel;
 let t=view(blocked,Panel,props);button(t,'修改信息').props.onClick();t=view(blocked,Panel,props);button(t,'保存修改').props.onClick();await tick();assert.equal(count,0);assert.match(text(view(blocked,Panel,props)),/未提交/);
 const saved={},calls=[];let fail=true;const fetch=async(path,options)=>{calls.push(JSON.parse(options.body));if(fail)throw Error('offline');return {ok:true,json:async()=>({})}};
 let h=harness({hooks:true,saved,fetch}),{CartonDetailsPanel}=h.load('components/CartonDetailsPanel.tsx'),p={...props,canManageProduct:true};t=view(h,CartonDetailsPanel,p);button(t,'修改名称 / SKU / 商家').props.onClick();t=view(h,CartonDetailsPanel,p);field(t,'产品名称').props.onChange({target:{value:'name pending'}});t=view(h,CartonDetailsPanel,p);button(t,'确认修改').props.onClick();await tick();assert.equal(JSON.parse(saved.qa).source.placementKey,'p1');
 fail=false;h=harness({hooks:true,saved,fetch});({CartonDetailsPanel}=h.load('components/CartonDetailsPanel.tsx'));p={...p,placementKey:'p2',receipt:{...receipt,version:4,placements:[{...receipt.placements[0],key:'p2',locationCode:'B2'}]}};t=view(h,CartonDetailsPanel,p);assert.match(text(t),/A1/);assert.equal(field(t,'产品名称').props.value,'name pending');button(t,'核对上次提交').props.onClick();await tick();assert.deepEqual(calls[1],calls[0]);
});
test('dirty ordinary metadata cannot open correction and pending movement prevents new detail or identity writes',()=>{
 let h=harness({hooks:true}),{CartonDetailsPanel}=h.load('components/CartonDetailsPanel.tsx');let t=view(h,CartonDetailsPanel,props);button(t,'修改信息').props.onClick();t=view(h,CartonDetailsPanel,props);field(t,'备注').props.onChange({target:{value:'dirty'}});t=view(h,CartonDetailsPanel,props);button(t,'修正箱数').props.onClick();t=view(h,CartonDetailsPanel,props);assert.match(text(t),/先保存或取消/);assert.equal(nodes(t).some(n=>n.type?.name==='CartonCorrectionDialog'),false);
 h=harness({hooks:true,saved:{'qa:move':JSON.stringify({body:{id:'carton1',requestId:'move-pending'}})}});({CartonDetailsPanel}=h.load('components/CartonDetailsPanel.tsx'));t=view(h,CartonDetailsPanel,{...props,canManageProduct:true,canConvert:true});for(const label of ['修改信息','修改名称 / SKU / 商家','转换成产品库存','修正箱数'])assert.equal(button(t,label).props.disabled,true,label);assert.equal(button(t,'核对上次移动').props.disabled,false);
});
test('association searches effective placement customer and confirmed empty override inheritance stays local',async()=>{
 for(const customerName of ['客户B','']){
  const calls=[],choices=[{key:'b',product:'产品B',customerName:'客户B',sku:'SKU-B',members:[],quantity:0,boxes:0,review:false,reason:''},{key:'a',product:'产品A',customerName:'客户A',sku:'SKU-A',members:[],quantity:0,boxes:0,review:false,reason:''}],h=harness({hooks:true,fetch:async(path,options)=>{if(options?.body)calls.push(JSON.parse(options.body));return {ok:true,json:async()=>options?.body?{}:{choices,revision:9}}}}),{CartonDetailsPanel}=h.load('components/CartonDetailsPanel.tsx'),p={...props,receipt:{...receipt,placements:[{...receipt.placements[0],details:{customerName}}]}};
  let t=view(h,CartonDetailsPanel,p);button(t,'关联现有产品').props.onClick();await tick();t=view(h,CartonDetailsPanel,p);nodes(t).find(n=>n.type==='input'&&n.props.placeholder==='产品、SKU、条码或商家').props.onChange({target:{value:'产品'}});t=view(h,CartonDetailsPanel,p);if(customerName)assert.equal(nodes(t).some(n=>n.type==='button'&&text(n).includes('产品A')),false);nodes(t).find(n=>n.type==='button'&&text(n).includes('产品B')).props.onClick();t=view(h,CartonDetailsPanel,p);button(t,'确认关联').props.onClick();await tick();if(!customerName){assert.equal(calls.length,0);t=view(h,CartonDetailsPanel,p);nodes(t).find(n=>n.type==='input'&&n.props.type==='checkbox').props.onChange({target:{checked:true}});t=view(h,CartonDetailsPanel,p);button(t,'确认关联').props.onClick();await tick();assert.deepEqual(calls[0].placementCustomerNames,{p1:'客户B'});}assert.equal('customerName' in calls[0],false);
 }
});

test('legacy box details display selectable SKU including the missing value',()=>{
 const {StockDetailsPanel}=harness().load('components/StockDetailsPanel.tsx'),p={value:{id:1,product:'P',sku:'BOX-SKU',customerName:'C',inboundDate:'2026-10-09',inboundSource:'unspecified',layerCount:1,inboundOrder:'IB',note:'n',fnsku:'',barcode:'',totalBoxes:2,totalQuantity:0,inventoryUnit:'box'},canEdit:false,canMove:false,onChange:()=>{},onSave:async()=>({ok:true}),onIdentitySaved:async()=>{},onMove:()=>{}};
 let html=renderToStaticMarkup(React.createElement(StockDetailsPanel,p));assert.match(html,/<dt>SKU<\/dt><dd>BOX-SKU<\/dd>/);assert.doesNotMatch(html,/<input/);html=renderToStaticMarkup(React.createElement(StockDetailsPanel,{...p,value:{...p.value,sku:''}}));assert.match(html,/<dt>SKU<\/dt><dd>无<\/dd>/);
});
test('ordinary editor never substitutes a different placement for a missing selection',()=>{
 const h=harness({hooks:true}),{CartonDetailsPanel}=h.load('components/CartonDetailsPanel.tsx'),t=view(h,CartonDetailsPanel,{...props,placementKey:'missing'});assert.equal(button(t,'修改信息').props.disabled,true);assert.equal(button(t,'修正箱数'),undefined);
});

test('product manager alone edits box identity without unlocking ordinary stock details',async()=>{
 const calls=[],h=harness({hooks:true,fetch:async(path,options)=>{calls.push({path,body:JSON.parse(options.body)});return {ok:true,json:async()=>({})}}}),{CartonDetailsPanel}=h.load('components/CartonDetailsPanel.tsx'),p={...props,canEdit:false,canManageProduct:true};let t=view(h,CartonDetailsPanel,p);assert.equal(button(t,'修改信息'),undefined);assert.ok(button(t,'修改名称 / SKU / 商家'));button(t,'修改名称 / SKU / 商家').props.onClick();t=view(h,CartonDetailsPanel,p);field(t,'产品名称').props.onChange({target:{value:'manager identity'}});t=view(h,CartonDetailsPanel,p);button(t,'确认修改').props.onClick();await tick();assert.equal(calls[0].path,'/api/cartons/details');assert.equal(calls[0].body.identity.product,'manager identity');assert.equal('details' in calls[0].body,false);
});

test('open metadata draft stays on original version and fields despite a newer polled receipt',async()=>{
 const calls=[],saved={},h=harness({hooks:true,saved,fetch:async(path,options)=>{calls.push(JSON.parse(options.body));return {ok:false,status:409,json:async()=>({error:'changed'})}}}),{CartonDetailsPanel}=h.load('components/CartonDetailsPanel.tsx');let t=view(h,CartonDetailsPanel,props);button(t,'修改信息').props.onClick();t=view(h,CartonDetailsPanel,props);field(t,'备注').props.onChange({target:{value:'operator A note'}});
 const newer={...props,receipt:{...receipt,version:4,placements:[{...receipt.placements[0],details:{inboundDate:'2026-10-08',inboundOrder:'operator B order',barcodes:['operator B barcode']}}]}};t=view(h,CartonDetailsPanel,newer);button(t,'保存修改').props.onClick();await tick();assert.equal(calls[0].expectedVersion,3);assert.equal(calls[0].details.inboundDate,'2026-10-09');assert.equal(calls[0].details.inboundOrder,'IB-5959');assert.deepEqual(calls[0].details.barcodes,[]);t=view(h,CartonDetailsPanel,newer);assert.equal(field(t,'备注').props.value,'operator A note');button(t,'保存修改').props.onClick();await tick();assert.equal(calls.length,1,'conflict requires explicit reopen');button(t,'取消修改').props.onClick();t=view(h,CartonDetailsPanel,newer);button(t,'修改信息').props.onClick();t=view(h,CartonDetailsPanel,newer);assert.equal(field(t,'入库日期').props.value,'2026-10-08');button(t,'保存修改').props.onClick();await tick();assert.equal(calls[1].expectedVersion,4);
});
test('identity draft freezes independently while ordinary metadata draft keeps its original base',async()=>{
 const calls=[],saved={},h=harness({hooks:true,saved,fetch:async(path,options)=>{calls.push(JSON.parse(options.body));return {ok:true,json:async()=>({})}}}),{CartonDetailsPanel}=h.load('components/CartonDetailsPanel.tsx');let p={...props,canManageProduct:true},t=view(h,CartonDetailsPanel,p);button(t,'修改信息').props.onClick();t=view(h,CartonDetailsPanel,p);field(t,'备注').props.onChange({target:{value:'ordinary draft'}});
 p={...p,receipt:{...receipt,version:4,placements:[{...receipt.placements[0],details:{product:'B name',sku:'B sku',customerName:'客户B'}}]}};t=view(h,CartonDetailsPanel,p);button(t,'修改名称 / SKU / 商家').props.onClick();t=view(h,CartonDetailsPanel,p);field(t,'产品名称').props.onChange({target:{value:'A name'}});p={...p,receipt:{...p.receipt,version:5}};t=view(h,CartonDetailsPanel,p);button(t,'确认修改').props.onClick();await tick();assert.equal(calls[0].expectedVersion,4);assert.deepEqual(calls[0].identity,{product:'A name',sku:'B sku',customerName:'客户B'});t=view(h,CartonDetailsPanel,p);button(t,'保存修改').props.onClick();await tick();assert.equal(calls[1].expectedVersion,3);assert.equal(calls[1].details.note,'ordinary draft');
});

test('identity conflict preserves input and original persisted source until explicit close/reopen review',async()=>{
 const saved={},calls=[],sources=[],h=harness({hooks:true,saved,fetch:async(path,options)=>{calls.push(JSON.parse(options.body));sources.push(JSON.parse(saved.qa).source);return {ok:false,status:409,json:async()=>({error:'changed'})}}}),{CartonDetailsPanel}=h.load('components/CartonDetailsPanel.tsx');let p={...props,canManageProduct:true},t=view(h,CartonDetailsPanel,p);button(t,'修改名称 / SKU / 商家').props.onClick();t=view(h,CartonDetailsPanel,p);field(t,'SKU').props.onChange({target:{value:'typed SKU'}});p={...p,receipt:{...receipt,version:4,placements:[{...receipt.placements[0],details:{product:'polled name',sku:'polled SKU',customerName:'客户B'}}]}};t=view(h,CartonDetailsPanel,p);button(t,'确认修改').props.onClick();await tick();assert.equal(calls[0].expectedVersion,3);assert.equal(sources[0].receipt.version,3);assert.equal(sources[0].placementKey,'p1');t=view(h,CartonDetailsPanel,p);assert.equal(field(t,'SKU').props.value,'typed SKU');button(t,'确认修改').props.onClick();await tick();assert.equal(calls.length,1);button(t,'取消').props.onClick();t=view(h,CartonDetailsPanel,p);button(t,'修改名称 / SKU / 商家').props.onClick();t=view(h,CartonDetailsPanel,p);assert.equal(field(t,'SKU').props.value,'polled SKU');button(t,'确认修改').props.onClick();await tick();assert.equal(calls[1].expectedVersion,4);
});
