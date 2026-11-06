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
const receipt={id:'carton1',version:3,inboundOrder:'IB-5959',originalOrder:'FBA-OLD',orderHistory:[],customerName:'',note:'原备注',inboundDate:'2026-10-09',totalBoxes:15,placements:[{key:'p1',locationCode:'A1',layerCount:2,boxes:10,marker:'右边'},{key:'p2',locationCode:'B1',layerCount:1,boxes:5,marker:''}]};
const props={receipt,placementKey:'p1',canEdit:true,canMove:true,canConvert:false,locations:['A1','B1'],customerNames:[],draftKey:'qa',onChanged:async()=>{},onConverted:async()=>{},onClose:()=>{}};
function harness({hooks=false,fetch=async()=>{throw Error('unexpected fetch')},saved={},storageError=()=>false,browserWindow}={}){
 const cache=new Map(),state=[];let cursor=0;
 const react=hooks?{...React,useState:init=>{const i=cursor++;if(!(i in state))state[i]=typeof init==='function'?init():init;return [state[i],v=>{state[i]=typeof v==='function'?v(state[i]):v}]},useRef:init=>{const i=cursor++;if(!(i in state))state[i]={current:init};return state[i]},useEffect:()=>{}}:React;
 function load(file){
  if(cache.has(file))return cache.get(file);if(file.endsWith('.css'))return {};
  const exports={};cache.set(file,exports);
  const code=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
  const localRequire=s=>{if(s==='react')return react;if(!s.startsWith('.'))return require(s);let path=resolve(dirname(file),s);if(!existsSync(path))path+=existsSync(path+'.tsx')?'.tsx':'.ts';return load(path)};
  runInNewContext(code,{exports,require:localRequire,console,Intl,Date,URL,window:browserWindow,Event,crypto:{randomUUID:()=> 'correction-1'},fetch,localStorage:{getItem:k=>saved[k]??null,setItem:(k,v)=>{if(storageError('set'))throw Error('storage blocked');saved[k]=v},removeItem:k=>{if(storageError('remove'))throw Error('storage blocked');delete saved[k]}}});return exports;
 }
 return {load:p=>load(resolve(p)),render:(fn,p)=>{cursor=0;return fn(p)},saved};
}
function nodes(tree){if(!tree||typeof tree!=='object')return [];return [tree,...React.Children.toArray(tree.props?.children).flatMap(nodes)]}
const text=t=>nodes(t).map(n=>React.Children.toArray(n.props?.children).filter(c=>typeof c==='string'||typeof c==='number').join('')).join(' ');
const button=(t,label)=>nodes(t).find(n=>n.type==='button'&&text(n).trim()===label);
const tick=()=>new Promise(r=>setImmediate(r));
const correction=h=>{assert.ok(existsSync(resolve('components/CartonCorrectionDialog.tsx')),'correction dialog must be available');return h.load('components/CartonCorrectionDialog.tsx').CartonCorrectionDialog};
function setBoxes(tree,value){nodes(tree).find(n=>n.type?.name==='GoodsNumberInput').props.onChange({target:{value}})}

test('stock.edit opens a focused correction without conversion or product association',()=>{
 const h=harness({hooks:true}),{CartonDetailsPanel}=h.load('components/CartonDetailsPanel.tsx');
 let tree=h.render(CartonDetailsPanel,props);assert.ok(button(tree,'修正箱数'),'stock.edit exposes correction');assert.equal(button(tree,'转换成产品库存'),undefined);
 button(tree,'修正箱数').props.onClick();tree=h.render(CartonDetailsPanel,props);
 const dialog=nodes(tree).find(n=>n.type?.name==='CartonCorrectionDialog');assert.ok(dialog);assert.equal(dialog.props.placementKey,'p1');
 const readonly=harness(),Panel=readonly.load('components/CartonDetailsPanel.tsx').CartonDetailsPanel;
 assert.doesNotMatch(renderToStaticMarkup(React.createElement(Panel,{...props,canEdit:false})),/<button[^>]*>修正箱数/);
});

test('correction shows selected location/date/count and sends exact placement body durably before fetch',async()=>{
 const saved={},calls=[];let closed=0;
 const h=harness({hooks:true,saved,fetch:async(path,options)=>{assert.equal(saved['qa:correction'],JSON.stringify(JSON.parse(saved['qa:correction'])));assert.deepEqual(JSON.parse(saved['qa:correction']).body,JSON.parse(options.body));calls.push({path,body:JSON.parse(options.body)});return {ok:true,json:async()=>({})}}}),Dialog=correction(h),p={...props,onClose:()=>closed++};
 let tree=h.render(Dialog,p);assert.match(text(tree),/A1/);assert.match(text(tree),/2026-10-09/);assert.match(text(tree),/10 箱/);assert.match(text(tree),/原入库日期/);assert.match(text(tree),/新增入库或出库/);
 assert.equal(nodes(tree).filter(n=>n.type?.name==='GoodsNumberInput').length,1);setBoxes(tree,'7');nodes(tree).find(n=>n.type==='textarea').props.onChange({target:{value:'清点更正'}});
 tree=h.render(Dialog,p);button(tree,'确认修正').props.onClick();await tick();
 assert.deepEqual(calls,[{path:'/api/cartons/correction',body:{requestId:'correction-1',id:'carton1',expectedVersion:3,placementKey:'p1',boxes:7,reason:'清点更正'}}]);assert.equal(saved['qa:correction'],undefined);assert.equal(closed,1);
});

test('zero is accepted as an explicit correction and invalid box counts never submit',async()=>{
 for(const value of ['', '-1','1.5','1e2','9007199254740992']){
  let writes=0;const h=harness({hooks:true,fetch:async()=>{writes++;return {ok:true,json:async()=>({})}}}),Dialog=correction(h);
  let tree=h.render(Dialog,props);setBoxes(tree,value);tree=h.render(Dialog,props);button(tree,'确认修正').props.onClick();await tick();assert.equal(writes,0,value);assert.match(text(h.render(Dialog,props)),/大于等于 0 的整数/);
 }
 const calls=[],h=harness({hooks:true,fetch:async(path,options)=>{calls.push(JSON.parse(options.body));return {ok:true,json:async()=>({})}}}),Dialog=correction(h);
 let tree=h.render(Dialog,props);setBoxes(tree,'0');tree=h.render(Dialog,props);button(tree,'确认修正').props.onClick();await tick();assert.equal(calls[0].boxes,0);assert.equal('reason' in calls[0],false);
});

test('unknown correction survives close/reopen after source placement is depleted and reuses its original request',async()=>{
 const saved={},calls=[];let unknown=true;
 const fetch=async(path,options)=>{calls.push(JSON.parse(options.body));if(unknown)throw Error('网络中断');return {ok:true,json:async()=>({})}};
 let h=harness({hooks:true,saved,fetch}),Dialog=correction(h),tree=h.render(Dialog,props);setBoxes(tree,'0');tree=h.render(Dialog,props);button(tree,'确认修正').props.onClick();await tick();
 tree=h.render(Dialog,props);assert.ok(button(tree,'关闭，稍后核对'));button(tree,'关闭，稍后核对').props.onClick();assert.ok(saved['qa:correction']);
 const depleted={...props,receipt:{...receipt,version:4,placements:[receipt.placements[1]],totalBoxes:5},placementKey:'p2'};
 h=harness({hooks:true,saved,fetch});Dialog=correction(h);tree=h.render(Dialog,depleted);assert.match(text(tree),/A1/);assert.match(text(tree),/10 箱/);assert.equal(nodes(tree).filter(n=>n.type?.name==='GoodsNumberInput').length,0);
 unknown=false;button(tree,'核对上次提交').props.onClick();await tick();assert.deepEqual(calls[1],calls[0]);assert.equal(saved['qa:correction'],undefined);
});

test('receipt panel still exposes pending correction after selected placement reaches zero or disappears',()=>{
 const saved={'qa:correction':JSON.stringify({body:{requestId:'old',id:'carton1',expectedVersion:3,placementKey:'p1',boxes:0}})};
 for(const placements of [[{...receipt.placements[0],boxes:0}],[]]){
  const h=harness({hooks:true,saved}),{CartonDetailsPanel}=h.load('components/CartonDetailsPanel.tsx'),p={...props,receipt:{...receipt,placements,totalBoxes:0}};
  let tree=h.render(CartonDetailsPanel,p);assert.ok(button(tree,'核对上次修正'));button(tree,'核对上次修正').props.onClick();tree=h.render(CartonDetailsPanel,p);assert.ok(nodes(tree).some(n=>n.type?.name==='CartonCorrectionDialog'));
 }
});

test('correction never substitutes another placement for a missing or depleted selection',async()=>{
 for(const p of [{...props,placementKey:'missing'},{...props,receipt:{...receipt,placements:[{...receipt.placements[0],boxes:0},receipt.placements[1]]}}]){
  const h=harness({hooks:true}),{CartonDetailsPanel}=h.load('components/CartonDetailsPanel.tsx');
  assert.equal(button(h.render(CartonDetailsPanel,p),'修正箱数'),undefined);
  let writes=0;const d=harness({hooks:true,fetch:async()=>{writes++;return {ok:true,json:async()=>({})}}}),Dialog=correction(d);
  button(d.render(Dialog,p),'确认修正').props.onClick();await tick();assert.equal(writes,0);assert.match(text(d.render(Dialog,p)),/没有可修正/);
 }
});

test('failed parent refresh keeps the original correction despite a newer receipt snapshot',async()=>{
 const saved={},calls=[];let failed=true;
 const h=harness({hooks:true,saved,fetch:async(path,options)=>{calls.push(JSON.parse(options.body));return {ok:true,json:async()=>({})}}}),Dialog=correction(h),p={...props,onChanged:async()=>{if(failed)throw Error('刷新失败')}};
 let tree=h.render(Dialog,p);setBoxes(tree,'4');tree=h.render(Dialog,p);button(tree,'确认修正').props.onClick();await tick();assert.ok(saved['qa:correction']);
 failed=false;tree=h.render(Dialog,{...p,receipt:{...receipt,version:4}});button(tree,'核对上次提交').props.onClick();await tick();assert.deepEqual(calls[1],calls[0]);assert.equal(saved['qa:correction'],undefined);
});

test('failed persistence aborts fetch; failed cleanup retains original correction for recovery',async()=>{
 let calls=0,block='set';const saved={},h=harness({hooks:true,saved,storageError:operation=>block===operation,fetch:async()=>{calls++;return {ok:true,json:async()=>({})}}}),Dialog=correction(h);
 let tree=h.render(Dialog,props);setBoxes(tree,'2');tree=h.render(Dialog,props);button(tree,'确认修正').props.onClick();await tick();assert.equal(calls,0);assert.match(text(h.render(Dialog,props)),/未提交/);
 block='remove';tree=h.render(Dialog,props);button(tree,'确认修正').props.onClick();await tick();assert.equal(calls,1);assert.ok(saved['qa:correction']);assert.ok(button(h.render(Dialog,props),'核对上次提交'));
 block='';button(h.render(Dialog,props),'核对上次提交').props.onClick();await tick();assert.equal(calls,2);assert.equal(saved['qa:correction'],undefined);
});

test('server uncertainty keeps original correction but confirmed validation error releases it',async()=>{
 for(const status of [500,409]){
  const saved={},h=harness({hooks:true,saved,fetch:async()=>({ok:false,status,json:async()=>({error:'请核对'})})}),Dialog=correction(h);
  let tree=h.render(Dialog,props);setBoxes(tree,'2');tree=h.render(Dialog,props);button(tree,'确认修正').props.onClick();await tick();assert.equal(!!saved['qa:correction'],status===500);
 }
});

test('correction retains the full original receipt snapshot and signals pending updates before fetch and after cleanup',async()=>{
 const saved={},events=[],h=harness({hooks:true,saved,browserWindow:{dispatchEvent:event=>{events.push(event.type)}},fetch:async()=>{
  assert.deepEqual(JSON.parse(saved['qa:correction']).receipt,receipt);
  assert.deepEqual(events,['warehouse-box-correction-pending']);
  return {ok:true,json:async()=>({})};
 }}),Dialog=correction(h);
 let tree=h.render(Dialog,props);setBoxes(tree,'0');tree=h.render(Dialog,props);button(tree,'确认修正').props.onClick();await tick();
 assert.equal(saved['qa:correction'],undefined);assert.deepEqual(events,['warehouse-box-correction-pending','warehouse-box-correction-pending']);
});

test('correction reason control follows the backend 500 character limit',()=>{
 const h=harness({hooks:true}),Dialog=correction(h),tree=h.render(Dialog,props);
 assert.equal(nodes(tree).find(n=>n.type==='textarea').props.maxLength,500);
});
