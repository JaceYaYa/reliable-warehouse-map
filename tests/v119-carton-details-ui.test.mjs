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
  const localRequire=s=>{if(s==='react')return react;if(!s.startsWith('.'))return require(s);let path=resolve(dirname(file),s);if(!existsSync(path))path+=existsSync(path+'.tsx')?'.tsx':'.ts';return load(path)};
  runInNewContext(code,{exports,require:localRequire,console,Intl,Date,URL,crypto:{randomUUID:()=> 'request-1'},fetch,localStorage:{getItem:k=>saved[k]??null,setItem:(k,v)=>{if(storageError())throw Error('storage blocked');saved[k]=v},removeItem:k=>{delete saved[k]}}});return exports;
 }
 return {load:p=>load(resolve(p)),render:(fn,p)=>{cursor=0;return fn(p)},saved};
}
function nodes(tree){if(!tree||typeof tree!=='object')return [];return [tree,...React.Children.toArray(tree.props?.children).flatMap(nodes)]}
const text=t=>nodes(t).map(n=>React.Children.toArray(n.props?.children).filter(c=>typeof c==='string'||typeof c==='number').join('')).join(' ');
const button=(t,label)=>nodes(t).find(n=>n.type==='button'&&text(n).trim()===label);
const tick=()=>new Promise(r=>setImmediate(r));

test('5959-like move/edit permissions directly expose carton actions without conversion',()=>{
 const h=harness(),{CartonDetailsPanel}=h.load('components/CartonDetailsPanel.tsx');
 const html=renderToStaticMarkup(React.createElement(CartonDetailsPanel,props));
 assert.match(html,/移动箱库存/);assert.match(html,/关联现有产品/);assert.doesNotMatch(html,/转换成产品库存/);
 const readonly=renderToStaticMarkup(React.createElement(CartonDetailsPanel,{...props,canMove:false,canEdit:false}));
 assert.match(readonly,/当前账号/);assert.doesNotMatch(readonly,/<button[^>]*>移动箱库存/);
});
test('associated cartons show the exact product and readonly SKU alongside retained order',()=>{
 const {CartonDetailsPanel}=harness().load('components/CartonDetailsPanel.tsx');
 const linked={...receipt,placements:[{...receipt.placements[0],product:{key:'exact',name:'精确产品',sku:'SKU-ONE',customerName:'客户A'}}]};
 const html=renderToStaticMarkup(React.createElement(CartonDetailsPanel,{...props,receipt:linked}));
 assert.match(html,/精确产品/);assert.match(html,/SKU-ONE/);assert.match(html,/IB-5959/);assert.match(html,/箱库存/);
});
test('move validates split total then sends the selected placement and retains exact request after refresh failure',async()=>{
 const calls=[],saved={};let refreshFails=true,closed=0;
 const h=harness({hooks:true,saved,fetch:async(path,options)=>{calls.push({path,body:JSON.parse(options.body)});return {ok:true,json:async()=>({})}}});
 const {CartonMoveDialog}=h.load('components/CartonMoveDialog.tsx');
 const p={...props,onClose:()=>{closed++},onChanged:async()=>{if(refreshFails)throw Error('刷新失败')}};
 let tree=h.render(CartonMoveDialog,p);
 let fields=nodes(tree).filter(n=>n.type?.name==='GoodsNumberInput');fields[0].props.onChange({target:{value:'11'}});
 tree=h.render(CartonMoveDialog,p);nodes(tree).find(n=>n.type?.name==='LocationSearchInput').props.onChange('B1');
 tree=h.render(CartonMoveDialog,p);button(tree,'确认移动').props.onClick();await tick();
 assert.equal(calls.length,0);assert.match(text(h.render(CartonMoveDialog,p)),/超过/);
 tree=h.render(CartonMoveDialog,p);nodes(tree).filter(n=>n.type?.name==='GoodsNumberInput')[0].props.onChange({target:{value:'4'}});
 tree=h.render(CartonMoveDialog,p);button(tree,'确认移动').props.onClick();await tick();
 assert.equal(calls.length,1);assert.deepEqual(calls[0].body.moves,[{fromKey:'p1',boxes:4,toLocationCode:'B1',toLayerCount:1,toMarker:'右边',toNote:'原备注'}]);
 assert.equal(JSON.parse(saved['qa:move']).body.requestId,'request-1');assert.equal(closed,0);
 refreshFails=false;tree=h.render(CartonMoveDialog,p);button(tree,'核对上次提交').props.onClick();await tick();
 assert.deepEqual(calls[1],calls[0]);assert.equal(saved['qa:move'],undefined);assert.equal(closed,1);
});
test('association picks exact same-customer choice and never submits product master edits or piece quantities',async()=>{
 const calls=[],choices=[{key:'same',product:'产品甲',customerName:'客户A',sku:'SKU-A',barcode:'',members:[],quantity:0,boxes:0,review:false,reason:''},{key:'other',product:'产品甲',customerName:'客户B',sku:'SKU-B',barcode:'',members:[],quantity:0,boxes:0,review:false,reason:''}];
 const h=harness({hooks:true,fetch:async(path,options)=>{calls.push({path,body:options?.body?JSON.parse(options.body):null});return {ok:true,json:async()=>options?.body?{}:{choices,revision:9}}}});
 const {CartonDetailsPanel}=h.load('components/CartonDetailsPanel.tsx');
 let tree=h.render(CartonDetailsPanel,props);button(tree,'关联现有产品').props.onClick();await tick();
 tree=h.render(CartonDetailsPanel,props);nodes(tree).find(n=>n.type==='input'&&n.props.placeholder==='产品、SKU、条码或商家').props.onChange({target:{value:'产品甲'}});
 tree=h.render(CartonDetailsPanel,props);const candidates=nodes(tree).filter(n=>n.type==='button'&&text(n).includes('产品甲'));
 assert.equal(candidates.length,1);candidates[0].props.onClick();
 tree=h.render(CartonDetailsPanel,props);assert.match(text(tree),/SKU-A/);button(tree,'确认关联').props.onClick();await tick();
 const post=calls.find(c=>c.body);assert.equal(post.path,'/api/cartons/claim');assert.deepEqual(post.body.placementProducts,{p1:{choiceKey:'same'}});assert.equal(post.body.expectedGoodsRevision,9);assert.equal(post.body.expectedVersion,3);
 for(const key of ['sku','product','quantity','placements'])assert.equal(key in post.body,false,key);
});

test('empty receipt customer requires explicit inheritance before linking; refresh failure freezes claim',async()=>{
 const calls=[],saved={},chosen={key:'same',product:'产品甲',customerName:'客户A',sku:'SKU-A',barcode:'',members:[],quantity:0,boxes:0,review:false,reason:''};let failedRefresh=true;
 const h=harness({hooks:true,saved,fetch:async(path,options)=>{if(options?.body)calls.push(JSON.parse(options.body));return {ok:true,json:async()=>options?.body?{}:{choices:[chosen],revision:9}}}});
 const {CartonDetailsPanel}=h.load('components/CartonDetailsPanel.tsx'),p={...props,receipt:{...receipt,customerName:''},onChanged:async()=>{if(failedRefresh)throw Error('刷新失败')}};
 let tree=h.render(CartonDetailsPanel,p);button(tree,'关联现有产品').props.onClick();await tick();
 tree=h.render(CartonDetailsPanel,p);nodes(tree).find(n=>n.type==='input'&&n.props.placeholder).props.onChange({target:{value:'SKU-A'}});
 tree=h.render(CartonDetailsPanel,p);nodes(tree).find(n=>n.type==='button'&&text(n).includes('产品甲')).props.onClick();
 tree=h.render(CartonDetailsPanel,p);button(tree,'确认关联').props.onClick();await tick();
 assert.equal(calls.length,0);assert.match(text(h.render(CartonDetailsPanel,p)),/请确认将本单商家/);
 tree=h.render(CartonDetailsPanel,p);nodes(tree).find(n=>n.type==='input'&&n.props.type==='checkbox').props.onChange({target:{checked:true}});
 tree=h.render(CartonDetailsPanel,p);button(tree,'确认关联').props.onClick();await tick();assert.equal(calls[0].customerName,'客户A');
 tree=h.render(CartonDetailsPanel,p);assert.ok(nodes(tree).some(n=>n.type==='fieldset'&&n.props.disabled));assert.ok(saved.qa);
 failedRefresh=false;button(tree,'核对上次提交').props.onClick();await tick();assert.deepEqual(calls[1],calls[0]);assert.equal(saved.qa,undefined);
});

test('movement supports two destinations and keeps source metadata without guessing piece quantities',async()=>{
 const calls=[],h=harness({hooks:true,fetch:async(path,options)=>{calls.push(JSON.parse(options.body));return {ok:true,json:async()=>({})}}}),{CartonMoveDialog}=h.load('components/CartonMoveDialog.tsx'),p={...props,onClose:()=>{}};
 let tree=h.render(CartonMoveDialog,p);button(tree,'＋ 添加目标库位').props.onClick();
 tree=h.render(CartonMoveDialog,p);let sections=nodes(tree).filter(n=>n.type==='section');
 for(const [index,section] of sections.entries()){
  nodes(section).find(n=>n.type?.name==='GoodsNumberInput').props.onChange({target:{value:String(index+2)}});
  nodes(section).find(n=>n.type?.name==='LocationSearchInput').props.onChange(index?'B2':'B1');
 }
 tree=h.render(CartonMoveDialog,p);assert.match(text(tree),/原库位保留 5 箱/);button(tree,'确认移动').props.onClick();await tick();
 assert.equal(calls.length,1);assert.deepEqual(calls[0].moves.map(m=>[m.fromKey,m.boxes,m.toLocationCode,m.toLayerCount,m.toMarker,m.toNote]),[['p1',2,'B1',1,'右边','原备注'],['p1',3,'B2',1,'右边','原备注']]);
 assert.equal('quantity' in calls[0],false);
});

test('unknown movement result restores the original payload after closing and reopening',async()=>{
 const saved={},calls=[];let offline=true,closed=0;
 const fetch=async(path,options)=>{calls.push(JSON.parse(options.body));if(offline)throw Error('网络中断');return {ok:true,json:async()=>({})}};
 let h=harness({hooks:true,saved,fetch}),{CartonMoveDialog}=h.load('components/CartonMoveDialog.tsx'),p={...props,onClose:()=>{closed++}};
 let tree=h.render(CartonMoveDialog,p);nodes(tree).find(n=>n.type?.name==='LocationSearchInput').props.onChange('B1');nodes(tree).find(n=>n.type?.name==='GoodsNumberInput').props.onChange({target:{value:'2'}});
 tree=h.render(CartonMoveDialog,p);button(tree,'确认移动').props.onClick();await tick();
 tree=h.render(CartonMoveDialog,p);button(tree,'关闭，稍后核对').props.onClick();assert.equal(closed,1);assert.ok(saved['qa:move']);
 offline=false;h=harness({hooks:true,saved,fetch});({CartonMoveDialog}=h.load('components/CartonMoveDialog.tsx'));tree=h.render(CartonMoveDialog,{...p,placementKey:'target',receipt:{...receipt,placements:[{...receipt.placements[0],key:'target',locationCode:'B1'}]}});
 assert.match(text(tree),/来源：A1/);
 assert.equal(nodes(tree).filter(n=>n.type?.name==='GoodsNumberInput').length,0);button(tree,'核对上次提交').props.onClick();await tick();assert.deepEqual(calls[1],calls[0]);assert.equal(saved['qa:move'],undefined);
});

test('movement never sends a write if it cannot durably retain the retry payload',async()=>{
 let calls=0;const h=harness({hooks:true,storageError:()=>true,fetch:async()=>{calls++;return {ok:true,json:async()=>({})}}}),{CartonMoveDialog}=h.load('components/CartonMoveDialog.tsx'),p={...props,onClose:()=>{}};
 let tree=h.render(CartonMoveDialog,p);nodes(tree).find(n=>n.type?.name==='LocationSearchInput').props.onChange('B1');nodes(tree).find(n=>n.type?.name==='GoodsNumberInput').props.onChange({target:{value:'2'}});
 tree=h.render(CartonMoveDialog,p);button(tree,'确认移动').props.onClick();await tick();assert.equal(calls,0);assert.match(text(h.render(CartonMoveDialog,p)),/未提交/);
});

test('clear association asks for an explicit confirmation and sends only the selected reference removal',async()=>{
 const calls=[],h=harness({hooks:true,fetch:async(path,options)=>{calls.push({path,body:JSON.parse(options.body)});return {ok:true,json:async()=>({})}}}),{CartonDetailsPanel}=h.load('components/CartonDetailsPanel.tsx');
 const p={...props,receipt:{...receipt,placements:[{...receipt.placements[0],product:{key:'product-one',name:'产品甲',sku:'SKU-A',customerName:'客户A'}}]}};
 let tree=h.render(CartonDetailsPanel,p);button(tree,'解除当前关联').props.onClick();await tick();assert.equal(calls.length,0);
 tree=h.render(CartonDetailsPanel,p);assert.match(text(tree),/只解除当前库位/);button(tree,'确认解除关联').props.onClick();await tick();
 assert.equal(calls[0].path,'/api/cartons/claim');assert.deepEqual(calls[0].body.placementProducts,{p1:null});assert.equal('customerName' in calls[0].body,false);assert.equal('quantity' in calls[0].body,false);
});

test('failed local persistence also aborts carton metadata writes',async()=>{
 let calls=0;const h=harness({hooks:true,storageError:()=>true,fetch:async()=>{calls++;return {ok:true,json:async()=>({})}}}),{CartonDetailsPanel}=h.load('components/CartonDetailsPanel.tsx');
 let tree=h.render(CartonDetailsPanel,props);button(tree,'修改信息').props.onClick();tree=h.render(CartonDetailsPanel,props);button(tree,'保存修改').props.onClick();await tick();assert.equal(calls,0);assert.match(text(h.render(CartonDetailsPanel,props)),/未提交/);
});

test('receipt-level unknown move is recoverable from a different surviving placement',()=>{
 const saved={'qa:move':JSON.stringify({body:{id:receipt.id,requestId:'old-move',expectedVersion:2,moves:[{fromKey:'removed',boxes:10,toLocationCode:'A1',toLayerCount:1}]}})},h=harness({saved}),{CartonDetailsPanel}=h.load('components/CartonDetailsPanel.tsx');
 const html=renderToStaticMarkup(React.createElement(CartonDetailsPanel,props));assert.match(html,/核对上次移动/);
});
