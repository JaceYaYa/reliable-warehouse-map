import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
const require=createRequire(import.meta.url);
const spec={billingMode:'item',itemLengthCm:0,itemWidthCm:0,itemHeightCm:0,boxLengthCm:0,boxWidthCm:0,boxHeightCm:0,itemVolumeM3:.01,boxVolumeM3:0};
const row={id:1,version:0,locationCode:'办4',layerCount:1,product:'iPhone 16 Pro',customerName:'客户',sku:'SKU1',barcode:'',fnsku:'',inboundDate:'2026-04-09',inboundSource:'domestic',inventoryUnit:'item',productCondition:'good',productPrefix:'',totalQuantity:1143,totalBoxes:2};
const choice={key:'product1',product:row.product,customerName:row.customerName,sku:row.sku,barcode:'',productSpec:spec,members:[row],quantity:1143,boxes:2,review:false,reason:''};
const input={lineId:'one',choiceKey:choice.key,product:choice.product,customerName:choice.customerName,inventoryUnit:'item',quantity:'1000',boxes:'0',receipt:{inboundSource:'domestic',productSpec:spec,sku:'SKU1',fnsku:'',barcode:'',productPrefix:'',productCondition:'',barcodes:[]},placements:[],picks:{1:{quantity:'1000',boxes:'0'}},autoPlacement:false,pickCondition:'all'};
const draft=()=>({version:1,mode:'outbound',customer:'',query:'',lines:[structuredClone(input)],inboundDate:'2026-10-08',outboundDate:'2026-10-08',inboundOrder:'',note:'',receiptSource:'inherit',creating:false,newCustomer:'',newProduct:'',newSku:'',newBarcode:'',newSpec:spec,pending:null});

// Run the actual component, its effects and date hook through open/close and clock changes.
// Child presentation components are not mounted; requests return a fixed live-stock snapshot.
function uiHarness(saved=draft(),mode='outbound',entry='GoodsOperationsDialog',options={}){
 const slots=[],effects=[],callbacks=[],refs=[],cache=new Map(),timers=new Set(),storage=new Map(),requests=[];
 let cursor=0,dirty=false,tree,clock='2026-10-14',queue=[];
 const props={open:true,initialMode:mode,locations:['办4'],customerNames:['客户'],canInbound:true,canOutbound:true,canEditSku:true,draftKey:'qa:'+mode,onClose:()=>{},onComplete:async()=>{}};
 Object.assign(props,options.props??{});for(const [key,value] of Object.entries(options.storage??{}))storage.set(key,JSON.stringify(value));if(saved)storage.set(props.draftKey,JSON.stringify(saved));
 const same=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]));
 const react={
  useState(initial){const i=cursor++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return[slots[i],v=>{const next=typeof v==='function'?v(slots[i]):v;if(!Object.is(next,slots[i])){slots[i]=next;dirty=true;}}]},
  useRef(initial){const i=cursor++;return refs[i]??=( {current:initial})},
  useCallback(fn,deps){const i=cursor++;if(!same(callbacks[i]?.deps,deps))callbacks[i]={fn,deps};return callbacks[i].fn},
  useEffect(fn,deps){const i=cursor++;if(!same(effects[i]?.deps,deps)){const prev=effects[i];effects[i]={deps,cleanup:prev?.cleanup};queue.push(()=>{prev?.cleanup?.();effects[i].cleanup=fn()})}},
 };
 const storageApi={getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,String(v)),removeItem:k=>storage.delete(k)};
 const globals={console,Response,Request,URL,crypto,structuredClone,Intl,Date,TextEncoder,TextDecoder,Uint8Array,ArrayBuffer,localStorage:storageApi,navigator:{clipboard:{writeText:async()=>{}}},fetch:async(path,requestOptions)=>{requests.push({path,body:requestOptions?.body});return path==='/api/goods/staging'?Response.json({tasks:[],revision:1}):options.fetch?options.fetch(path,requestOptions):Response.json(path==='/api/cartons'?{receipts:[carton]}:{choices:[choice],revision:1})},window:{setInterval:fn=>{timers.add(fn);return fn},clearInterval:fn=>timers.delete(fn),addEventListener(){},removeEventListener(){},innerHeight:900,requestAnimationFrame:fn=>fn()},document:{visibilityState:'visible',body:{style:{overflow:''}},addEventListener(){},removeEventListener(){},getElementById:()=>null,querySelectorAll:()=>[]},Element:class{},ResizeObserver:class{},CustomEvent:class{}};
 const children=new Map();
 function load(file){
  if(file.endsWith('/warehouse-time.ts')||file.endsWith('\\warehouse-time.ts'))return{warehouseTodayDate:()=>clock};
  if(file.endsWith('.css'))return{};
   if(file.endsWith('.tsx')&&!file.endsWith(entry+'.tsx')){
   if(!children.has(file))children.set(file,new Proxy({emptyGoodsProductSpec:()=>structuredClone(spec),barcodeInputs:(a,b)=>[a,b].filter(Boolean).length?[a,b].filter(Boolean):['']},{get:(o,k)=>o[k]??(o[k]=Object.assign(()=>null,{displayName:String(k)}))}));
   return children.get(file);
  }
  if(cache.has(file))return cache.get(file);const exports={};cache.set(file,exports);
  const code=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
  const localRequire=s=>{if(s==='react')return react;if(!s.startsWith('.'))return require(s);let p=resolve(dirname(file),s);if(!existsSync(p))p+=existsSync(p+'.tsx')?'.tsx':'.ts';return load(p)};
  runInNewContext(code,{exports,require:localRequire,...globals});return exports;
 }
 const Component=load(resolve('components/'+entry+'.tsx'))[entry];
 async function settle(){for(let round=0;round<40;round++){if(round===0||dirty){dirty=false;cursor=0;tree=Component(props);const next=queue;queue=[];for(const effect of next)effect();}await new Promise(r=>setImmediate(r));if(!dirty&&!queue.length)return;}throw Error('Hook state did not settle');}
 function nodes(value,result=[]){if(Array.isArray(value)){value.forEach(v=>nodes(v,result));return result;}if(value&&typeof value==='object'&&'props'in value){result.push(value);nodes(value.props.children,result);}return result;}
 const header=()=>nodes(tree).find(n=>n.type?.displayName==='OperationDateHeader').props;
 const savedDraft=()=>JSON.parse(storage.get(props.draftKey));
 return{settle,header,savedDraft,requests,nodes:()=>nodes(tree),props,storage,async reopen(){props.open=false;await settle();props.open=true;await settle()},async tick(day){clock=day;for(const timer of [...timers])timer();await settle()},async change(value){header().onChange(value);await settle()},async confirm(){header().onConfirm();await settle()},dispose(){effects.forEach(e=>e?.cleanup?.())}};
}

const carton={id:'carton-36',version:1,inboundOrder:'IB558715473RS',originalOrder:'FBA19NLP9Z67U',orderHistory:[],customerName:'客户',inboundDate:'2026-10-01',note:'',totalBoxes:36,placements:[{key:'a',locationCode:'C23',layerCount:1,boxes:20,marker:''},{key:'b',locationCode:'C24',layerCount:1,boxes:10,marker:''},{key:'c',locationCode:'C25',layerCount:1,boxes:6,marker:''}]};
const flatText=n=>Array.isArray(n)?n.map(flatText).join(''):n&&typeof n==='object'?flatText(n.props?.children):String(n??'');
const findButton=(h,label)=>h.nodes().find(n=>n.type==='button'&&flatText(n.props.children)===label);
test('actual outbound picker finds an IB carton with no product match and preserves its product draft',async()=>{
 const h=uiHarness();try{await h.settle();const search=h.nodes().find(n=>n.props.role==='combobox');search.props.onChange({target:{value:'IB558715473RS'}});await h.settle();const option=h.nodes().find(n=>n.props.role==='option'&&flatText(n).includes('箱库存'));assert.ok(option);assert.ok(!h.nodes().some(n=>flatText(n)==='没有匹配货物。'));option.props.onClick();await h.settle();assert.ok(!h.nodes().some(n=>n.type?.displayName==='CartonOutboundDialog'));const added=h.nodes().filter(n=>n.type?.displayName==='GoodsOperationRow');assert.equal(added.length,2);assert.equal(added[1].props.line.choice.source,'carton');assert.equal(added[1].props.line.choice.boxes,36);assert.equal(h.savedDraft().lines.length,2);assert.equal(h.savedDraft().lines[0].quantity,'1000');assert.equal(h.savedDraft().lines[1].choiceKey,added[1].props.line.choice.key);assert.ok(h.requests.every(r=>!r.body));}finally{h.dispose();}
});
test('box outbound uses confirmed today and all three exact placement quantities without piece fields',async()=>{
 let sent;const h=uiHarness(null,'outbound','CartonOutboundDialog',{props:{receipt:carton,canOutbound:true,onChanged:async()=>{},onClose:()=>{}},fetch:async(path,opts)=>{sent=JSON.parse(opts.body);return Response.json({ok:true});}});try{await h.settle();assert.equal(h.header().value,'2026-10-14');assert.equal(h.requests.length,0);findButton(h,'全部出库').props.onClick();await h.settle();assert.ok(findButton(h,'确认箱件出库').props.disabled);await h.confirm();findButton(h,'确认箱件出库').props.onClick();await h.settle();assert.equal(sent.picks.reduce((s,p)=>s+p.boxes,0),36);assert.equal(sent.picks.length,3);assert.equal(sent.outboundDate,'2026-10-14');assert.ok(sent.picks.every(p=>!('quantity' in p)));assert.ok(h.nodes().some(n=>flatText(n).includes('已出库 36 箱')));}finally{h.dispose();}
});
test('accepted carton outbound with refresh failure retains and retries exactly the original request',async()=>{
 const bodies=[];let attempts=0;const h=uiHarness(null,'outbound','CartonOutboundDialog',{props:{receipt:carton,canOutbound:true,onChanged:async()=>{if(attempts++===0)throw Error('refresh failed');}},fetch:async(path,opts)=>{bodies.push(opts.body);return Response.json({ok:true});}});try{await h.settle();findButton(h,'全部出库').props.onClick();await h.settle();await h.confirm();findButton(h,'确认箱件出库').props.onClick();await h.settle();assert.ok(findButton(h,'核对原请求'));await h.tick('2026-10-15');findButton(h,'核对原请求').props.onClick();await h.settle();assert.equal(bodies.length,2);assert.equal(bodies[0],bodies[1]);assert.equal(JSON.parse(bodies[1]).outboundDate,'2026-10-14');}finally{h.dispose();}
});

test('fully depleted carton pending outbound remains recoverable without any positive search records',async()=>{
 const pending={requestId:'original-request',id:carton.id,expectedVersion:1,outboundDate:'2026-10-14',picks:carton.placements.map(p=>({key:p.key,boxes:p.boxes}))};
 const h=uiHarness(null,'outbound','GoodsOperationsDialog',{storage:{'qa:outbound:carton-outbound-recovery':{receipt:carton,pending}},fetch:async(path)=>Response.json(path==='/api/cartons'?{receipts:[]}:{choices:[choice],revision:1})});try{await h.settle();const recover=findButton(h,'核对上次箱件出库');assert.ok(recover,'recovery must be independent of current stock');recover.props.onClick();await h.settle();assert.equal(h.nodes().find(n=>n.type?.displayName==='CartonOutboundDialog').props.receipt.id,carton.id);assert.ok(h.requests.every(r=>!r.body));}finally{h.dispose();}
});

test('exact carton identity excludes approximate product noise but keeps explicit product choices',async()=>{
 const noisy={...choice,product:'IB558715278RS',key:'noise',members:[{...row,product:'IB558715278RS'}]};
 const h=uiHarness(null,'outbound','GoodsOperationsDialog',{fetch:async(path)=>Response.json(path==='/api/cartons'?{receipts:[carton]}:{choices:[noisy],revision:1})});try{await h.settle();h.nodes().find(n=>n.props.role==='combobox').props.onChange({target:{value:'IB558715473RS'}});await h.settle();const results=h.nodes().filter(n=>n.props.role==='option');assert.equal(results.length,1);assert.ok(flatText(results[0]).includes('箱库存'));}finally{h.dispose();}
});

test('normalized exact product member IB remains beside matching carton for explicit selection',async()=>{
 const matching={...choice,key:'member-match',members:[{...row,inboundOrder:'IB558715473RS'}]};
 const h=uiHarness(null,'outbound','GoodsOperationsDialog',{fetch:async(path)=>Response.json(path==='/api/cartons'?{receipts:[carton]}:{choices:[matching],revision:1})});try{await h.settle();h.nodes().find(n=>n.props.role==='combobox').props.onChange({target:{value:'IB-003260928RS'}});await h.settle();const results=h.nodes().filter(n=>n.props.role==='option');assert.equal(results.length,2);assert.ok(results.some(n=>flatText(n).includes('箱库存')));assert.ok(results.some(n=>flatText(n).includes('iPhone 16 Pro')));}finally{h.dispose();}
});
function allocationNodes(value,result=[]){if(Array.isArray(value))value.forEach(v=>allocationNodes(v,result));else if(value&&typeof value==='object'&&value.props){result.push(value);allocationNodes(value.props.children,result);}return result;}
test('carton task shares allocation, global date review and one mixed document request',async()=>{
 const sent=[],h=uiHarness(undefined,'outbound','GoodsOperationsDialog',{fetch:async(path,opts)=>{if(opts?.body){sent.push({path,body:JSON.parse(opts.body)});return Response.json({ok:true,documentId:'mixed'});}return Response.json(path==='/api/cartons'?{receipts:[carton]}:{choices:[choice],revision:1});}});
 try{await h.settle();h.nodes().find(n=>n.props.role==='combobox').props.onChange({target:{value:'IB558715473RS'}});await h.settle();h.nodes().find(n=>n.props.role==='option'&&flatText(n).includes('箱库存')).props.onClick();await h.settle();let task=h.nodes().find(n=>n.type?.displayName==='GoodsOperationRow'&&n.props.line.choice.source==='carton');const all=allocationNodes(task.props.allocation).filter(n=>n.type==='button'&&String(n.props['aria-label']).endsWith('此处全部'));assert.equal(all.length,3);for(const button of all){button.props.onClick();await h.settle();}task=h.nodes().find(n=>n.type?.displayName==='GoodsOperationRow'&&n.props.line.choice.source==='carton');assert.equal(task.props.onCompleteAllocation(),'');await h.settle();assert.equal(h.savedDraft().lines[1].boxes,'36');findButton(h,'核对本单').props.onClick();await h.settle();findButton(h,'确认整单出库').props.onClick();await h.settle();assert.equal(sent.length,0,'global date confirmation required');await h.confirm();findButton(h,'确认整单出库').props.onClick();await h.settle();assert.equal(sent.length,1);assert.equal(sent[0].path,'/api/goods/document');assert.equal(sent[0].body.outboundDate,'2026-10-14');assert.equal(sent[0].body.lines.length,2);const line=sent[0].body.lines.find(l=>l.kind==='carton');assert.equal(line.receiptId,carton.id);assert.equal(line.expectedVersion,1);assert.equal(line.picks.length,3);assert.equal(line.picks.reduce((n,p)=>n+Number(p.boxes),0),36);assert.ok(line.picks.every(p=>['a','b','c'].includes(p.key)&&!('id' in p)));}finally{h.dispose();}
});
test('carton allocations survive draft reload and a rejected mixed document keeps all lines',async()=>{
 let saved;const first=uiHarness();try{await first.settle();first.nodes().find(n=>n.props.role==='combobox').props.onChange({target:{value:'IB558715473RS'}});await first.settle();first.nodes().find(n=>n.props.role==='option'&&flatText(n).includes('箱库存')).props.onClick();await first.settle();let task=first.nodes().find(n=>n.type?.displayName==='GoodsOperationRow'&&n.props.line.choice.source==='carton');allocationNodes(task.props.allocation).find(n=>n.type==='button'&&String(n.props['aria-label']).startsWith('C23 ')&&String(n.props['aria-label']).endsWith('此处全部')).props.onClick();await first.settle();task=first.nodes().find(n=>n.type?.displayName==='GoodsOperationRow'&&n.props.line.choice.source==='carton');assert.equal(task.props.onCompleteAllocation(),'');await first.settle();saved=first.savedDraft();assert.equal(saved.lines[1].boxes,'20');}finally{first.dispose();}
 const sent=[],h=uiHarness(saved,'outbound','GoodsOperationsDialog',{fetch:async(path,opts)=>{if(opts?.body){sent.push(path);return Response.json({error:'箱库存已变化，请刷新核对'}, {status:409});}return Response.json(path==='/api/cartons'?{receipts:[carton]}:{choices:[choice],revision:1});}});try{await h.settle();const task=h.nodes().find(n=>n.type?.displayName==='GoodsOperationRow'&&n.props.line.choice.source==='carton');assert.equal(task.props.line.boxes,'20');assert.equal(Object.keys(task.props.line.picks).length,1);findButton(h,'核对本单').props.onClick();await h.settle();await h.confirm();findButton(h,'确认整单出库').props.onClick();await h.settle();assert.deepEqual(sent,['/api/goods/document']);assert.equal(h.savedDraft().lines.length,2);assert.equal(h.savedDraft().lines[1].boxes,'20');assert.equal(h.savedDraft().pending,null);assert.ok(h.nodes().some(n=>flatText(n).includes('箱库存已变化')));}finally{h.dispose();}
});
test('carton task disables unsupported staging before submission and keeps direct outbound available',async()=>{
 const h=uiHarness(null,'outbound','GoodsOperationsDialog',{props:{canMove:true}});try{await h.settle();h.nodes().find(n=>n.props.role==='combobox').props.onChange({target:{value:'IB558715473RS'}});await h.settle();h.nodes().find(n=>n.props.role==='option'&&flatText(n).includes('箱库存')).props.onClick();await h.settle();let task=h.nodes().find(n=>n.type?.displayName==='GoodsOperationRow');for(const button of allocationNodes(task.props.allocation).filter(n=>n.type==='button'&&String(n.props['aria-label']).endsWith('此处全部'))){button.props.onClick();await h.settle();}task=h.nodes().find(n=>n.type?.displayName==='GoodsOperationRow');assert.equal(task.props.onCompleteAllocation(),'');await h.settle();findButton(h,'核对本单').props.onClick();await h.settle();assert.equal(findButton(h,'移库待出库').props.disabled,true);assert.equal(findButton(h,'确认整单出库').props.disabled,false);assert.ok(h.nodes().some(n=>flatText(n).includes('箱库存暂不支持移库待出库')));assert.ok(!h.nodes().some(n=>n.type?.displayName==='CartonOutboundDialog'));assert.ok(h.requests.every(r=>!r.body));}finally{h.dispose();}
});
