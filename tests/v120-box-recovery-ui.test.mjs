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
 const storageApi={get length(){return storage.size},key:i=>[...storage.keys()][i]??null,getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,String(v)),removeItem:k=>storage.delete(k)};
 const globals={console,Response,Request,URL,crypto,structuredClone,Intl,Date,TextEncoder,TextDecoder,Uint8Array,ArrayBuffer,localStorage:storageApi,navigator:{clipboard:{writeText:async()=>{}}},fetch:async(path,requestOptions)=>{requests.push({path,body:requestOptions?.body});return path==='/api/goods/staging'?Response.json({tasks:[],revision:1}):options.fetch?options.fetch(path,requestOptions):Response.json(path==='/api/cartons'?{receipts:[carton]}:{choices:[choice],revision:1})},window:{setInterval:fn=>{timers.add(fn);return fn},clearInterval:fn=>timers.delete(fn),addEventListener(){},removeEventListener(){},innerHeight:900},document:{visibilityState:'visible',body:{style:{overflow:''}},addEventListener(){},removeEventListener(){},getElementById:()=>null},Element:class{},ResizeObserver:class{},CustomEvent:class{}};
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

test('global recovery reopens exact saved correction independently of zero live inventory and user scope',async()=>{
 const pending={receipt:carton,body:{requestId:'saved-request',id:carton.id,expectedVersion:1,placementKey:'a',boxes:0}},key='warehouse:carton-details:1:'+carton.id+':correction';
 const h=uiHarness(null,'outbound','PendingBoxCorrections',{props:{userId:1,canEdit:true,onChanged:async()=>{}},storage:{[key]:pending,'warehouse:carton-details:11:other:correction':pending}});try{await h.settle();const recover=findButton(h,'核对箱数修正 '+carton.inboundOrder);assert.ok(recover);assert.equal(h.requests.length,0);recover.props.onClick();await h.settle();const dialog=h.nodes().find(n=>n.type?.displayName==='CartonCorrectionDialog');assert.equal(dialog.props.receipt.id,carton.id);assert.equal(dialog.props.placementKey,'a');assert.equal(dialog.props.draftKey,'warehouse:carton-details:1:'+carton.id);assert.equal(JSON.parse(h.storage.get(key)).body.requestId,'saved-request');h.storage.delete(key);dialog.props.onClose();await h.settle();assert.equal(findButton(h,'核对箱数修正 '+carton.inboundOrder),undefined);}finally{h.dispose();}
});
