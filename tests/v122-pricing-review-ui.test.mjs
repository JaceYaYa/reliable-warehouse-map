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
function harness({hooks=false,fetch=async()=>{throw Error('unexpected fetch')},saved={},storageError=()=>false,effects=false}={}){
 const cache=new Map(),state=[],effectDeps=[],queued=[];let cursor=0;
 const react=hooks?{...React,useState:init=>{const i=cursor++;if(!(i in state))state[i]=typeof init==='function'?init():init;return [state[i],v=>{state[i]=typeof v==='function'?v(state[i]):v}]},useRef:init=>{const i=cursor++;if(!(i in state))state[i]={current:init};return state[i]},useCallback:fn=>fn,useEffect:(fn,deps)=>{if(!effects)return;const i=cursor++;if(!effectDeps[i]||deps.some((v,j)=>!Object.is(v,effectDeps[i][j]))){effectDeps[i]=deps;queued.push(fn)}}}:React;
 function load(file){
  if(cache.has(file))return cache.get(file);if(file.endsWith('.css'))return {};
  const exports={};cache.set(file,exports);
  const code=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
  const localRequire=s=>{if(s==='react')return react;if(s==='react-dom')return {createPortal:v=>v};if(!s.startsWith('.'))return require(s);let path=resolve(dirname(file),s);if(!existsSync(path))path+=existsSync(path+'.tsx')?'.tsx':'.ts';return load(path)};
  runInNewContext(code,{exports,require:localRequire,console,Intl,Date,URL,document:{body:{},addEventListener:()=>{},removeEventListener:()=>{}},window:{addEventListener:()=>{},removeEventListener:()=>{},setInterval:()=>1,clearInterval:()=>{}},crypto:{randomUUID:()=> 'request-1'},fetch,localStorage:{getItem:k=>saved[k]??null,setItem:(k,v)=>{if(storageError())throw Error('storage blocked');saved[k]=v},removeItem:k=>{delete saved[k]}}});return exports;
 }
 return {load:p=>load(resolve(p)),render:(fn,p)=>{cursor=0;const t=fn(p);while(queued.length)queued.shift()();return t},saved};
}
function nodes(tree){if(!tree||typeof tree!=='object')return [];return [tree,...React.Children.toArray(tree.props?.children).flatMap(nodes)]}
const text=t=>nodes(t).map(n=>React.Children.toArray(n.props?.children).filter(c=>typeof c==='string'||typeof c==='number').join('')).join(' ');
const button=(t,label)=>nodes(t).find(n=>n.type==='button'&&text(n).trim()===label);
const tick=()=>new Promise(r=>setImmediate(r));


function expand(tree){if(!tree||typeof tree!=='object')return tree;if(['StockDetailFields','CartonStockDetailsEditor','CartonIdentityDialog'].includes(tree.type?.name))return expand(tree.type(tree.props));return {...tree,props:{...tree.props,children:React.Children.toArray(tree.props?.children).map(expand)}}}
const view=(h,fn,p)=>expand(h.render(fn,p));
const field=(tree,label)=>nodes(tree).find(n=>n.type==='label'&&React.Children.toArray(n.props?.children).filter(v=>typeof v==='string').join('').trim()===label)?.props.children.find(n=>n&&typeof n==='object');



test('pricing UI keeps missing-basis review state through API normalization',()=>{const h=harness(),m=h.load('components/PricingWorkspace.tsx');assert.equal(typeof m.normalizeReportRow,'function');const row=m.normalizeReportRow({id:1,stockId:1,inventoryStatus:'in_stock',productName:'待核价货物',customerName:'客户',sku:'SKU',pricingReview:true,pricingReviewReason:'体积待核对',feeUsd:0},0);assert.equal(row.pricingReview,true);assert.equal(row.pricingReviewReason,'体积待核对');});
test('product fee groups expose unresolved records and sum only supported amounts',()=>{const h=harness(),{groupPricingProducts}=h.load('lib/pricing-product-groups.ts');const base={productName:'产品',customerName:'客户',sku:'SKU',inventoryStatus:'in_stock',settlementStatus:null,quantity:1,boxes:1,locationCode:'A1'};const [g]=groupPricingProducts([{...base,periodFeeUsd:2},{...base,periodFeeUsd:123,pricingReview:true}]);assert.equal(g.feeUsd,2);assert.equal(g.pricingReviewRows,1);});
