import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import React from 'react';

const require=createRequire(import.meta.url);
const empty=()=>({schemaVersion:1,revision:4,locations:{}});
const zones=[{id:'A',title:'A区',codes:['A1','D1']},{id:'Y',title:'一件代发室',codes:['Y-1']}];
const occupancy=(names=['客户A'],layer=1,locationCode='A1')=>({key:JSON.stringify([locationCode,layer]),locationCode,layer,volumeM3:2,volumeSource:'default',customers:names.map(customerName=>({customerName,oldestInboundDate:'2026-10-01',products:['货物'],recordIds:['1']})),shares:names.length===1&&names[0]?[{customerName:names[0],percent:100}]:null,reviewReasons:names.includes('')?['unclaimed-customer']:names.length>1?['mixed-customer-shares-required']:[],occupants:[]});
const nodes=t=>!t||typeof t!=='object'?[]:[t,...React.Children.toArray(t.props?.children).flatMap(nodes)];
const text=t=>nodes(t).map(n=>React.Children.toArray(n.props?.children).filter(c=>typeof c==='string'||typeof c==='number').join('')).join(' ');
const tick=()=>new Promise(r=>setImmediate(r));

function editor(options={}){
 assert.ok(existsSync('components/LayerPricingSettings.tsx'),'layer settings editor must exist');
 const states=[],effects=[],queued=[],cache=new Map();let cursor=0,tree;
 const hooks={...React,useState:init=>{const i=cursor++;if(!(i in states))states[i]=typeof init==='function'?init():init;return[states[i],v=>{states[i]=typeof v==='function'?v(states[i]):v}]},useRef:init=>{const i=cursor++;if(!(i in states))states[i]={current:init};return states[i]},useEffect:(fn,deps)=>{const i=cursor++;if(!effects[i]||deps.some((d,j)=>!Object.is(d,effects[i][j]))){effects[i]=deps;queued.push(fn)}},useMemo:fn=>fn(),useCallback:fn=>fn};
 const load=file=>{file=resolve(file);if(file.endsWith('.css'))return {};if(cache.has(file))return cache.get(file);const exports={};cache.set(file,exports);const code=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;runInNewContext(code,{exports,require:s=>{if(s==='react')return hooks;if(!s.startsWith('.'))return require(s);let p=resolve(dirname(file),s);if(!existsSync(p))p+=existsSync(p+'.tsx')?'.tsx':'.ts';return load(p)},console,Error});return exports;};
 const calls=[],props={config:empty(),occupied:[occupancy()],locations:['A1','D1','Y-1'],zones,onSave:async value=>{calls.push(JSON.parse(JSON.stringify(value)))},...options};
 const {LayerPricingSettings}=load('components/LayerPricingSettings.tsx');
 const render=()=>{cursor=0;tree=LayerPricingSettings(props);while(queued.length)queued.shift()();return tree};
 const field=label=>nodes(tree).find(n=>n.type==='input'&&n.props['aria-label']===label);
 const button=label=>nodes(tree).find(n=>n.type==='button'&&text(n).trim()===label);
 const input=(label,value)=>{assert.ok(field(label),`missing field ${label}`);field(label).props.onChange({target:{value}});render()};
 const click=label=>{const b=button(label);assert.ok(b,`missing button ${label}`);b.props.onClick?.({preventDefault(){}});render()};
 const submit=async()=>{nodes(tree).find(n=>n.type==='form').props.onSubmit({preventDefault(){}});await tick();render();};
 render();return {props,calls,render,input,click,submit,field,button,get tree(){return tree},select:code=>{nodes(tree).find(n=>n.type?.name==='LocationSearchInput').props.onChange(code);render();}};
}

test('text numeric fields preserve decimal typing and Enter submits a positive custom volume',async()=>{
 const e=editor();e.input('库位默认体积（m³）','2.');assert.equal(e.field('库位默认体积（m³）').props.value,'2.');e.input('库位默认体积（m³）','2.5');
 for(const n of nodes(e.tree).filter(n=>n.type==='input')){assert.notEqual(n.props.type,'number');assert.notEqual(n.props.role,'spinbutton');}
 await e.submit();assert.equal(e.calls.length,1);assert.equal(e.calls[0].locations.A1.defaultVolumeM3,2.5);assert.equal(e.calls[0].revision,4);
});

test('layer override wins and clearing overrides inherits location then built-in source',async()=>{
 const e=editor();e.select('D1');assert.match(text(e.tree),/1 m³/);assert.match(text(e.tree),/指定层规则/);
 e.input('库位默认体积（m³）','3');e.input('本层体积（m³）','.75');assert.match(text(e.tree),/0.75 m³/);assert.match(text(e.tree),/单层设置/);await e.submit();assert.equal(e.calls[0].locations.D1.layers['1'].volumeM3,.75);
 e.input('本层体积（m³）','');assert.match(text(e.tree),/3 m³/);assert.match(text(e.tree),/库位设置/);e.input('库位默认体积（m³）','');assert.match(text(e.tree),/指定层规则/);await e.submit();assert.equal(e.calls[1].locations.D1,undefined);
 e.select('Y-1');assert.match(text(e.tree),/0.2 m³/);assert.match(text(e.tree),/一件代发区域/);
});

test('mixed actual clients each show full layer volume with no allocation controls',async()=>{
 const e=editor({occupied:[occupancy(['客户A','客户B','客户C'])]});for(const n of ['客户A','客户B','客户C'])assert.equal(e.field(`${n}分摊比例（%）`),undefined);
 assert.doesNotMatch(text(e.tree),/分摊|100%/);assert.match(text(e.tree),/客户A/);assert.match(text(e.tree),/每客户独立/);e.input('本层体积（m³）','3');await e.submit();assert.equal(e.calls.length,1);assert.deepEqual(e.calls[0].locations.A1.layers['1'],{volumeM3:3});
});

test('single client shows full volume and unknown client stays pending without editable guessed allocation',async()=>{
 const e=editor();assert.match(text(e.tree),/客户A/);assert.match(text(e.tree),/2 m³/);e.props.occupied=[occupancy([''])];e.render();assert.match(text(e.tree),/未认领/);assert.match(text(e.tree),/待核对/);assert.equal(nodes(e.tree).filter(n=>n.type==='input'&&String(n.props['aria-label']).includes('分摊比例')).length,0);
});

test('invalid raw volume and layer numbers reject save and bounded manual layer does not create 10000 rows',async()=>{
 const e=editor();for(const raw of ['0','-1','NaN','Infinity','1000001']){e.input('库位默认体积（m³）',raw);await e.submit();assert.equal(e.calls.length,0);assert.equal(e.field('库位默认体积（m³）').props.value,raw);}
 e.input('库位默认体积（m³）','');for(const raw of ['0','1.5','10001']){e.input('选择层号',raw);e.click('查看此层');assert.match(text(e.tree),/1[～—–-]10000/);}
 e.input('选择层号','10000');e.click('查看此层');e.input('本层体积（m³）','1.25');await e.submit();assert.equal(e.calls.length,1);assert.equal(e.calls[0].locations.A1.layers['10000'].volumeM3,1.25);assert.ok(nodes(e.tree).length<250);
});

test('parent revision refresh keeps raw edits and blocks stale save until cancel reloads latest',async()=>{
 const e=editor();e.input('库位默认体积（m³）','2.');e.props.config={schemaVersion:1,revision:5,locations:{A1:{defaultVolumeM3:7,layers:{}}}};e.render();assert.equal(e.field('库位默认体积（m³）').props.value,'2.');assert.match(text(e.tree),/版本/);assert.equal(e.button('保存设置').props.disabled,true);await e.submit();assert.equal(e.calls.length,0);
 e.click('取消修改');e.render();assert.equal(e.field('库位默认体积（m³）').props.value,'7');e.input('库位默认体积（m³）','8');await e.submit();assert.equal(e.calls[0].revision,5);assert.equal(e.calls[0].locations.A1.defaultVolumeM3,8);
});

test('save failure preserves raw fields and human-readable server error; subsequent successful refresh adopts revision',async()=>{
 let reject=true;const e=editor({onSave:async config=>{if(reject)throw Error('配置版本已变化，请重新载入');e.props.config={...config,revision:5};}});e.input('库位默认体积（m³）','2.50');await e.submit();assert.equal(e.field('库位默认体积（m³）').props.value,'2.50');assert.match(text(e.tree),/配置版本已变化，请重新载入/);
 reject=false;await e.submit();e.render();assert.equal(e.button('保存设置').props.disabled,false);assert.doesNotMatch(text(e.tree),/最新版本为/);
});

test('customer set refresh allows volume save while preserving ignored legacy allocation metadata',async()=>{
 const config=empty();config.locations.A1={layers:{'1':{shares:[{customerName:'客户A',percent:60},{customerName:'客户B',percent:40}]}}};const e=editor({config,occupied:[occupancy(['客户A','客户B'])]});
 e.props.occupied=[occupancy(['客户A','客户C'])];e.render();assert.doesNotMatch(text(e.tree),/分摊|60%|40%/);e.input('本层体积（m³）','4');await e.submit();assert.equal(e.calls.length,1);assert.deepEqual(e.calls[0].locations.A1.layers['1'],{volumeM3:4,shares:[{customerName:'客户A',percent:60},{customerName:'客户B',percent:40}]});
});

test('clearing a searchable location and receiving an empty actual location list stay editable without a guessed rule',()=>{
 const e=editor();e.select('');assert.equal(e.button('保存设置').props.disabled,true);assert.match(text(e.tree),/搜索结果选择库位/);e.select('D1');assert.match(text(e.tree),/指定层规则/);
 const blank=editor({locations:[],occupied:[]});assert.equal(blank.button('保存设置').props.disabled,true);
});

test('Enter in the layer picker selects that bounded layer without submitting, and pending saves cannot duplicate callbacks',async()=>{
 let finish,calls=0;const e=editor({onSave:async()=>{calls++;await new Promise(r=>{finish=r})}});e.input('选择层号','9999');let prevented=false;e.field('选择层号').props.onKeyDown({key:'Enter',preventDefault(){prevented=true}});e.render();assert.equal(prevented,true);assert.match(text(e.tree),/第 9999 层/);assert.equal(calls,0);
 const form=()=>nodes(e.tree).find(n=>n.type==='form');form().props.onSubmit({preventDefault(){}});e.render();form().props.onSubmit({preventDefault(){}});assert.equal(calls,1);assert.equal(e.button('保存中…').props.disabled,true);finish();await tick();e.render();
});

test('volume-only save does not invent allocation metadata and unclaimed customers remain pending',async()=>{
 for(const names of [['客户A','客户B'],['','客户A']]){const e=editor({occupied:[occupancy(names)]});e.input('库位默认体积（m³）','3.2');await e.submit();assert.equal(e.calls.length,1);assert.deepEqual(e.calls[0].locations.A1,{defaultVolumeM3:3.2,layers:{}});assert.doesNotMatch(text(e.tree),/分摊/);if(names.includes(''))assert.match(text(e.tree),/待核对/);}
});

test('same-revision parent refresh and location switching keep all raw drafts, without mutating controlled props',async()=>{
 const original=empty(),e=editor({config:original});e.input('库位默认体积（m³）','2.00');e.select('D1');e.input('本层体积（m³）','1.25');e.props.config=JSON.parse(JSON.stringify(original));e.render();e.select('A1');assert.equal(e.field('库位默认体积（m³）').props.value,'2.00');await e.submit();assert.equal(e.calls[0].locations.A1.defaultVolumeM3,2);assert.equal(e.calls[0].locations.D1.layers['1'].volumeM3,1.25);assert.deepEqual(original,empty());
});

test('renamed location edits preserve and merge compatible old-key rules into one actual location',async()=>{
 const config=empty();config.locations.oldA1={defaultVolumeM3:3,layers:{'2':{volumeM3:4,shares:[{customerName:'客户A',percent:100}]}}};config.locations.R1={layers:{'3':{volumeM3:5}}};
 const e=editor({config,aliases:{oldA1:'R1'},locations:['R1'],occupied:[occupancy(['客户A'],2,'R1')]});assert.equal(e.field('库位默认体积（m³）').props.value,'3');e.input('选择层号','2');e.click('查看此层');assert.equal(e.field('本层体积（m³）').props.value,'4');assert.match(text(e.tree),/4 m³/);e.input('库位默认体积（m³）','3.5');await e.submit();assert.equal(e.calls.length,1);assert.equal(e.calls[0].locations.oldA1,undefined);assert.deepEqual(e.calls[0].locations.R1,{defaultVolumeM3:3.5,layers:{'2':{volumeM3:4,shares:[{customerName:'客户A',percent:100}]},'3':{volumeM3:5}}});
});

test('renamed legacy allocation differences do not crash settings or block a volume-only save',async()=>{
 const config=empty();config.locations.OLD={defaultVolumeM3:3,layers:{'1':{volumeM3:3,shares:[{customerName:'甲',percent:100}]}}};config.locations.A1={defaultVolumeM3:3,layers:{'1':{volumeM3:3,shares:[{customerName:'乙',percent:100}]}}};
 const original=JSON.parse(JSON.stringify(config));const e=editor({config,aliases:{OLD:'A1'},locations:['A1'],occupied:[occupancy(['甲','乙'])]});
 assert.equal(e.field('本层体积（m³）').props.value,'3');assert.doesNotMatch(text(e.tree),/分摊/);e.input('本层体积（m³）','4');await e.submit();assert.equal(e.calls.length,1);assert.equal(e.calls[0].locations.A1.layers['1'].volumeM3,4);assert.deepEqual(e.calls[0].locations.A1.layers['1'].shares,[{customerName:'甲',percent:100}]);assert.deepEqual(config,original);
});

test('same-revision rename refresh keeps raw drafts and requires explicit cancel before using new aliases',async()=>{
 const e=editor();e.input('库位默认体积（m³）','2.50');e.props.aliases={A1:'R1'};e.props.locations=['R1','D1','Y-1'];e.render();assert.equal(e.button('保存设置').props.disabled,true);await e.submit();assert.equal(e.calls.length,0);e.click('取消修改');e.render();assert.equal(e.field('库位默认体积（m³）').props.value,'');assert.equal(e.button('保存设置').props.disabled,false);
});

test('lowercase and fullwidth display locations use canonical rules and actual customers and save only one canonical key',async()=>{
 for(const label of ['a1','ａ１','Ａ１']){
  const config=empty();config.locations.A1={defaultVolumeM3:3,layers:{}};const actualLocations=[label];
  const e=editor({config,locations:actualLocations,occupied:[occupancy(['客户A','客户B'],1,'A1')]});
  assert.equal(e.field('库位默认体积（m³）').props.value,'3');assert.match(text(e.tree),/1 个有货层/);assert.doesNotMatch(text(e.tree),/当前层无货/);
  assert.equal(nodes(e.tree).find(n=>n.type?.name==='LocationSearchInput').props.value,label);
  assert.equal(e.field('客户A分摊比例（%）'),undefined);assert.equal(e.field('客户B分摊比例（%）'),undefined);
  e.select(label);e.input('库位默认体积（m³）','4');await e.submit();
  assert.equal(e.calls.length,1);assert.deepEqual(e.calls[0].locations,{A1:{defaultVolumeM3:4,layers:{}}});
  assert.deepEqual(actualLocations,[label]);assert.deepEqual(config.locations.A1,{defaultVolumeM3:3,layers:{}});
 }
});
