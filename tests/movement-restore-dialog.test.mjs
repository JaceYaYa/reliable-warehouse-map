import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
const require=createRequire(import.meta.url);
function harness(){
 const slots=[],refs=[],effects=[],requests=[];let cursor=0,dirty=true,tree,queue=[];
 const react={useState(v){const i=cursor++;if(!(i in slots))slots[i]=typeof v==='function'?v():v;return[slots[i],v=>{slots[i]=typeof v==='function'?v(slots[i]):v;dirty=true}]},useRef(v){const i=cursor++;return refs[i]??={current:v}},useEffect(fn,deps){const i=cursor++;if(!effects[i]){effects[i]=true;queue.push(fn)}}};
 const jsx=require('react/jsx-runtime'),record={id:42,userName:'测试员',action:'移库',entityType:'待出库',entityId:'A2',summary:'25件；目标A2三层',createdAt:'2026-10-15T10:00:00Z',canRestore:true};
 const exports={},code=ts.transpileModule(readFileSync(resolve('app/movements/page.tsx'),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
 const localRequire=s=>s.endsWith('.css')?{}:s==='react'?react:s==='react/jsx-runtime'?jsx:s==='next/link'?{default:()=>null}:s.includes('RecordFilters')?{RecordFilters:()=>null}:s.includes('record-filters')?{emptyRecordFilters:()=>({}),recordFilterQuery:()=>''}:s.includes('warehouse-time')?{warehouseTimestamp:s=>s}:require(s);
 runInNewContext(code,{exports,require:localRequire,console,window:{setTimeout:fn=>{queue.push(fn);return 1},clearTimeout(){}},fetch:async(path,options)=>{requests.push({path,options:options?.method==="POST"?options:undefined});return Response.json(options?.method==="POST"?{ok:true}:{logs:[record],filterOptions:{actions:[],operators:[]},restoredIds:requests.some(r=>r.options)?[42]:[],canRestore:true,canRestoreDeletedStocks:true,pagination:{page:1,pageSize:50,total:1,totalPages:1}})}});
 async function settle(){for(let n=0;n<30;n++){if(dirty){dirty=false;cursor=0;tree=exports.default();}const callbacks=queue;queue=[];callbacks.forEach(fn=>fn());await new Promise(r=>setImmediate(r));if(!dirty&&!queue.length)return}throw Error('unsettled')}
 function nodes(v,out=[]){if(arguments.length===0)v=tree;if(Array.isArray(v))v.forEach(n=>nodes(n,out));else if(v&&typeof v==='object'&&v.props){out.push(v);nodes(v.props.children,out)}return out}
 const text=v=>Array.isArray(v)?v.map(text).join(''):v?.props?text(v.props.children):String(v??'');
 const button=label=>{const n=nodes().find(n=>n.type==='button'&&text(n.props.children)===label);assert.ok(n,'button '+label);return n};
 return{settle,nodes,requests,click:async label=>{await button(label).props.onClick();await settle()}};
}
test('movement recovery opens an in-page confirmation and cancel never writes',async()=>{const h=harness();await h.settle();await h.click('恢复');assert.equal(h.requests.filter(r=>r.options).length,0);assert.ok(h.nodes().some(n=>n.props.role==='dialog'&&n.props['aria-label']==='确认恢复操作'));await h.click('取消');assert.equal(h.requests.filter(r=>r.options).length,0);assert.ok(!h.nodes().some(n=>n.props.role==='dialog'))});
test('movement recovery submits only the selected record after confirmation',async()=>{const h=harness();await h.settle();await h.click('恢复');await h.click('确认恢复');const posts=h.requests.filter(r=>r.options);assert.equal(posts.length,1);assert.deepEqual(JSON.parse(posts[0].options.body),{id:42});assert.ok(!h.nodes().some(n=>n.props.role==='dialog'))});
