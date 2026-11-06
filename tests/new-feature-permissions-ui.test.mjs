import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const require=createRequire(import.meta.url),cache=new Map();
function load(file){
 if(cache.has(file))return cache.get(file);
 if(file.endsWith('.css'))return {default:new Proxy({}, {get:(_,k)=>String(k)})};
 const exports={};cache.set(file,exports);
 const code=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
 const localRequire=s=>{if(!s.startsWith('.'))return require(s);let path=resolve(dirname(file),s);if(!existsSync(path))path+=existsSync(path+'.tsx')?'.tsx':'.ts';return load(path)};
 runInNewContext(code,{exports,require:localRequire,console,Intl,Date,URL,localStorage:{getItem:()=>null}});return exports;
}
const {StockDetailsPanel}=load(resolve('components/StockDetailsPanel.tsx'));
const {CartonDetailsPanel}=load(resolve('components/CartonDetailsPanel.tsx'));
const {AccountManager}=load(resolve('components/AccountManager.tsx'));
const {ALL_PERMISSIONS}=load(resolve('lib/permissions.ts'));
const noop=()=>{},stock={id:1,product:'测试产品',customerName:'客户',sku:'SKU',inventoryUnit:'item',locationCode:'A1',layerCount:1,inboundDate:'2026-10-09',inboundSource:'domestic',totalQuantity:0,totalBoxes:2,inboundOrder:'IB1',note:'',fnsku:'',barcode:''};
const stockProps={value:stock,onChange:noop,onSave:async()=>({ok:true}),onIdentitySaved:async()=>{},canEdit:false,canMove:false,onMove:noop};
test('conversion permission alone exposes both stock directions without quantity or identity edits',()=>{
 const item=renderToStaticMarkup(React.createElement(StockDetailsPanel,{...stockProps,canConvert:true}));
 assert.match(item,/转换为箱库存/);assert.doesNotMatch(item,/修改信息|修改名称 \/ SKU \/ 商家|修正数量/);
 const box=renderToStaticMarkup(React.createElement(StockDetailsPanel,{...stockProps,value:{...stock,inventoryUnit:'box'},canConvert:true}));
 assert.match(box,/转换为产品库存/);assert.doesNotMatch(box,/转换为箱库存/);
 const edit=renderToStaticMarkup(React.createElement(StockDetailsPanel,{...stockProps,canEdit:true}));assert.doesNotMatch(edit,/转换为/);
});
test('master permission alone exposes identity operation without physical stock editing or conversion',()=>{
 const html=renderToStaticMarkup(React.createElement(StockDetailsPanel,{...stockProps,canManageProduct:true}));
 assert.match(html,/修改名称 \/ SKU \/ 商家/);assert.doesNotMatch(html,/修改信息|转换为|修正数量/);
});
test('carton conversion permission alone has a direct entry without claim metadata editing',()=>{
 const receipt={id:1,version:0,inboundOrder:'IB1',customerName:'客户',note:'',inboundDate:'2026-10-09',totalBoxes:2,placements:[{key:'p1',locationCode:'A1',layerCount:1,boxes:2}]};
 const props={receipt,placementKey:'p1',canEdit:false,customerNames:[],draftKey:'qa',onChanged:async()=>{},onConverted:async()=>{}};
 const html=renderToStaticMarkup(React.createElement(CartonDetailsPanel,{...props,canConvert:true}));assert.match(html,/转换成产品库存/);assert.doesNotMatch(html,/修改信息/);
 assert.doesNotMatch(renderToStaticMarkup(React.createElement(CartonDetailsPanel,{...props,canConvert:false})),/转换成产品库存/);
});
test('boss account UI renders fixed employee/admin roles and admins cannot see account manager',()=>{
 const html=renderToStaticMarkup(React.createElement(AccountManager,{viewer:{id:1,username:'boss',role:'admin',permissions:[]},onClose:noop}));
 for(const label of ['员工','管理员'])assert.ok(html.includes(label),label);
 assert.equal(renderToStaticMarkup(React.createElement(AccountManager,{viewer:{id:2,role:'admin',permissions:ALL_PERMISSIONS},onClose:noop})), '');
 assert.equal((html.match(/type="checkbox"/g)||[]).length,0);
});
