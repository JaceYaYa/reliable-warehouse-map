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
 const react=hooks?{...React,useId:()=> 'qa-id',useState:init=>{const i=cursor++;if(!(i in state))state[i]=typeof init==='function'?init():init;return [state[i],v=>{state[i]=typeof v==='function'?v(state[i]):v}]},useRef:init=>{const i=cursor++;if(!(i in state))state[i]={current:init};return state[i]},useCallback:(fn,deps)=>{if(!effects)return fn;const i=cursor++;if(!state[i]||deps.some((v,j)=>!Object.is(v,state[i].deps[j])))state[i]={fn,deps};return state[i].fn},useEffect:(fn,deps)=>{if(!effects)return;const i=cursor++;if(!effectDeps[i]||deps.some((v,j)=>!Object.is(v,effectDeps[i][j]))){effectDeps[i]=deps;queued.push(fn)}}}:React;
 function load(file){
  if(cache.has(file))return cache.get(file);if(file.endsWith('.css'))return {};
  const exports={};cache.set(file,exports);
  const code=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
  const localRequire=s=>{if(s==='react')return react;if(s==='react-dom')return {createPortal:v=>v};if(!s.startsWith('.'))return require(s);let path=resolve(dirname(file),s);if(!existsSync(path))path+=existsSync(path+'.tsx')?'.tsx':'.ts';return load(path)};
  runInNewContext(code,{exports,require:localRequire,console,Intl,Date,URL,document:{body:{style:{}},addEventListener:()=>{},removeEventListener:()=>{}},window:{addEventListener:()=>{},removeEventListener:()=>{},setInterval:()=>1,clearInterval:()=>{}},crypto:{randomUUID:()=> 'request-1'},fetch,localStorage:{getItem:k=>saved[k]??null,setItem:(k,v)=>{if(storageError())throw Error('storage blocked');saved[k]=v},removeItem:k=>{delete saved[k]}}});return exports;
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


test('shared full editor exposes editable pallet metadata without spinner and preserves fractional input text',()=>{
 const h=harness(),{StockDetailFields}=h.load('components/StockDetailFields.tsx');let patch;
 const value={inboundDate:'2026-10-01',inboundSource:'domestic',layerCount:1,productCondition:'',productPrefix:'',inboundOrder:'IB',barcodes:[],note:'',palletCount:1};
 const tree=StockDetailFields({value,onChange:v=>patch=v,quantity:'4箱',onCorrection:()=>{}});
 const input=nodes(tree).find(n=>n.type==='input'&&n.props['aria-label']==='托盘数');assert.ok(input,'full box and product editor must expose pallet count');assert.equal(input.props.value,1);assert.notEqual(input.props.type,'number');input.props.onChange({target:{value:'1/3'}});assert.equal(patch.palletCount,'1/3');
});
test('new inbound placement defaults one pallet and ordinary metadata save carries selected count',async()=>{
 const h=harness({hooks:true,fetch:async(path,options)=>{h.calls.push({path,body:JSON.parse(options.body)});return {ok:true,json:async()=>({})}}});h.calls=[];
 const {nextGoodsPlacement}=h.load('lib/goods-operation-draft.ts');assert.equal(nextGoodsPlacement(undefined,'p').palletCount,'1');
 const {CartonDetailsPanel}=h.load('components/CartonDetailsPanel.tsx');let t=view(h,CartonDetailsPanel,props);button(t,'修改信息').props.onClick();t=view(h,CartonDetailsPanel,props);const input=nodes(t).find(n=>n.type==='input'&&n.props['aria-label']==='托盘数');assert.equal(input.props.value,1);input.props.onChange({target:{value:'0.5'}});t=view(h,CartonDetailsPanel,props);button(t,'保存修改').props.onClick();await tick();assert.equal(h.calls[0].body.details.palletCount,'0.5');assert.equal(h.calls[0].body.placementKey,'p1');assert.equal(h.calls[0].body.expectedVersion,3);
});


test('same product outbound tasks reserve fractional pallets and reject duplicate pallet allocation',()=>{
 const h=harness(),{availableOutboundMembers,outboundTaskConflict}=h.load('lib/goods-operation-input.ts');
 const row={id:1,locationCode:'A1',totalQuantity:10,totalBoxes:2,palletCount:1.5},choice={key:'g',members:[row],quantity:10,boxes:2};
 const a={lineId:'a',choice,quantity:'2',boxes:'0',picks:{1:{quantity:'2',boxes:'0',pallets:'1/3'}}},b={lineId:'b',choice,quantity:'2',boxes:'0',picks:{1:{quantity:'2',boxes:'0',pallets:'1.25'}}};
 assert.equal(availableOutboundMembers(a,[a,b])[0].palletCount,.25);
 assert.match(outboundTaskConflict(a,[a,b]),/托盘/);
 b.picks[1].pallets='0.5';assert.equal(outboundTaskConflict(a,[a,b]),'');
 b.picks[1].pallets='-1';assert.match(outboundTaskConflict(a,[a,b]),/托盘/);
});

test('carton outbound carries selected raw pallets, preserves exact retry, and rejects over-allocation',async()=>{
 const saved={},calls=[];let fail=true;const h=harness({hooks:true,effects:true,saved,fetch:async(path,options)=>{calls.push({path,body:JSON.parse(options.body)});if(fail)throw Error('offline');return {ok:true,json:async()=>({})}}}),{CartonOutboundDialog}=h.load('components/CartonOutboundDialog.tsx');
 const p={receipt:{...receipt,placements:[{...receipt.placements[0],palletCount:1.5}]},canOutbound:true,draftKey:'qa-out',onClose:()=>{},onChanged:async()=>{}};
 let t=h.render(CartonOutboundDialog,p);t=h.render(CartonOutboundDialog,p);
 nodes(t).find(n=>n.type?.name==='OperationDateHeader').props.onConfirm();
 nodes(t).find(n=>n.type?.name==='GoodsNumberInput'&&n.props['aria-label']?.includes('出库箱数')).props.onChange({target:{value:'2'}});
 t=h.render(CartonOutboundDialog,p);let input=nodes(t).find(n=>n.type==='input'&&n.props['aria-label']?.includes('出库托盘数'));assert.ok(input);input.props.onChange({target:{value:'2'}});
 t=h.render(CartonOutboundDialog,p);assert.equal(button(t,'确认箱件出库').props.disabled,true);input=nodes(t).find(n=>n.type==='input'&&n.props['aria-label']?.includes('出库托盘数'));input.props.onChange({target:{value:'1/3'}});
 t=h.render(CartonOutboundDialog,p);assert.equal(button(t,'确认箱件出库').props.disabled,false);button(t,'确认箱件出库').props.onClick();await tick();assert.equal(calls[0].body.picks[0].pallets,'1/3');assert.equal(calls[0].body.picks[0].boxes,2);assert.equal(calls[0].body.expectedVersion,3);
 fail=false;t=h.render(CartonOutboundDialog,p);button(t,'核对原请求').props.onClick();await tick();assert.deepEqual(calls[1],calls[0]);
});

test('carton move split has independent pallet inputs and blank last row retains automatic remainder',async()=>{
 const calls=[],h=harness({hooks:true,fetch:async(path,options)=>{calls.push(JSON.parse(options.body));return {ok:true,json:async()=>({})}}}),{CartonMoveDialog}=h.load('components/CartonMoveDialog.tsx');
 const p={...props,receipt:{...receipt,placements:[{...receipt.placements[0],palletCount:2}]},onClose:()=>{}};
 let t=h.render(CartonMoveDialog,p);const change=(label,value)=>nodes(t).find(n=>n.props?.['aria-label']===label).props.onChange({target:{value}});
 change('目标 1 移动箱数','4');nodes(t).find(n=>n.type?.name==='LocationSearchInput').props.onChange('B1');
 const input=nodes(t).find(n=>n.type==='input'&&n.props['aria-label']==='目标 1 移动托盘数');assert.ok(input);input.props.onChange({target:{value:'1/2'}});
 t=h.render(CartonMoveDialog,p);button(t,'＋ 添加目标库位').props.onClick();t=h.render(CartonMoveDialog,p);assert.equal(nodes(t).find(n=>n.props?.['aria-label']==='目标 2 移动托盘数').props.value,'');
 change('目标 2 移动箱数','6');nodes(t).filter(n=>n.type?.name==='LocationSearchInput')[1].props.onChange('B2');t=h.render(CartonMoveDialog,p);button(t,'确认移动').props.onClick();await tick();assert.equal(calls[0].moves[0].pallets,'1/2');assert.equal(calls[0].moves[1].pallets,undefined);
});

test('box projection exposes actual pallet count for both origins including zero and legacy default',()=>{
 const h=harness(),{boxInventoryRecords}=h.load('lib/box-inventory-records.ts');
 const stocks=[{id:1,inventoryUnit:'box',product:'P',customerName:'C',totalQuantity:0,totalBoxes:2,locationCode:'A1',layerCount:1,inboundDate:'2026-10-01',palletCount:0}];
 const records=boxInventoryRecords(stocks,[receipt]);assert.equal(records[0].palletCount,0);assert.equal(records[1].palletCount,1);
});


test('goods allocation writes pallets on the actual physical pick and exposes remaining counts without fee preview',async()=>{
 const calls=[],saved={},h=harness({hooks:true,effects:true,saved,fetch:async(path,options)=>{if(options?.method==='POST'){calls.push({path,body:JSON.parse(options.body)});throw Error('offline')}return {ok:true,json:async()=>path==='/api/cartons'?{receipts:[]}:path==='/api/goods/staging'?{tasks:[],revision:4}:{revision:4,choices:[choice]}}}});
 const spec=h.load('lib/goods-product-spec.ts').emptyGoodsProductSpec(),date=h.load('lib/warehouse-time.ts').warehouseTodayDate();
 const row={id:1,version:7,product:'测试货物',customerName:'客户A',sku:'SKU',barcode:'',fnsku:'',productCondition:'good',productPrefix:'右边',locationCode:'A1',layerCount:1,totalQuantity:10,totalBoxes:2,palletCount:1.5,inboundDate:'2026-10-01',inboundOrder:'IB',updatedAt:'2026-10-01',inboundSource:'domestic',inventoryUnit:'item'},choice={key:'g1',product:'测试货物',customerName:'客户A',sku:'SKU',barcode:'',members:[row],quantity:10,boxes:2,review:false,reason:'',productSpec:spec,costBatches:[{inboundDate:'2026-10-01',quantity:10,boxes:2}]};
 const line={lineId:'task1',choiceKey:'g1',product:'测试货物',customerName:'客户A',outboundOrder:'OUT',inventoryUnit:'item',quantity:'2',boxes:'0',receipt:{inboundSource:'domestic',productSpec:spec,sku:'SKU',fnsku:'',barcode:'',productPrefix:'',productCondition:''},placements:[],picks:{1:{quantity:'2',boxes:'0'}},autoPlacement:false,pickCondition:'all'};
 saved.goods=JSON.stringify({version:1,mode:'outbound',customer:'',query:'',lines:[line],inboundDate:'2026-10-01',outboundDate:date,inboundOrder:'',note:'',receiptSource:'inherit',creating:false,newCustomer:'',newProduct:'',newSku:'',newBarcode:'',newSpec:spec,pending:null});
 const {GoodsOperationsDialog}=h.load('components/GoodsOperationsDialog.tsx'),p={open:true,initialMode:'outbound',draftKey:'goods',locations:['A1'],canInbound:true,canOutbound:true,canEditSku:true,onClose:()=>{},onComplete:async()=>{}};
 let t;for(let i=0;i<3;i++){t=h.render(GoodsOperationsDialog,p);await tick()}
 let allocation=nodes(t).find(n=>n.type?.name==='GoodsOperationRow').props.allocation;
 const input=nodes(allocation).find(n=>n.type==='input'&&n.props['aria-label']==='A1 记录 1 本次出库托盘数');assert.ok(input);assert.match(text(allocation),/托盘/);assert.doesNotMatch(text(allocation),/计价|费用|最早入库/);
 input.props.onChange({target:{value:'1/3'}});t=h.render(GoodsOperationsDialog,p);nodes(t).find(n=>n.type?.name==='OperationDateHeader').props.onConfirm();t=h.render(GoodsOperationsDialog,p);button(t,'核对本单').props.onClick();t=h.render(GoodsOperationsDialog,p);button(t,'确认整单出库').props.onClick();await tick();assert.equal(calls.length,1);assert.equal(calls[0].body.lines[0].selected[0].pallets,'1/3');assert.equal(calls[0].body.lines[0].selected[0].id,1);assert.equal(calls[0].body.lines[0].selected[0].version,7);assert.equal(calls[0].body.lines[0].quantity,'2');
 t=h.render(GoodsOperationsDialog,p);button(t,'核对上次提交').props.onClick();await tick();assert.deepEqual(calls[1],calls[0]);
});

test('carton inbound raw count defaults per placement and survives an uncertain retry',async()=>{
 const calls=[],h=harness({hooks:true,effects:true,fetch:async(path,options)=>{calls.push(JSON.parse(options.body));throw Error('offline')}}),{CartonInboundDialog}=h.load('components/CartonInboundDialog.tsx'),p={open:true,locations:['A1'],customerNames:[],canInbound:true,draftKey:'in',onClose:()=>{},onComplete:async()=>{}};
 let t=h.render(CartonInboundDialog,p);t=h.render(CartonInboundDialog,p);
 const order=nodes(t).find(n=>n.type==='input'&&n.props.placeholder==='填写入库单号（不限格式）');order.props.onChange({target:{value:'IB-NEW'}});t=h.render(CartonInboundDialog,p);
 nodes(t).find(n=>n.type?.name==='LocationSearchInput').props.onChange('A1');t=h.render(CartonInboundDialog,p);
 nodes(t).find(n=>n.props?.['aria-label']==='库位1箱数').props.onChange({target:{value:'4'}});t=h.render(CartonInboundDialog,p);
 const input=nodes(t).find(n=>n.type==='input'&&n.props['aria-label']==='库位1托盘数');assert.equal(input.props.value,'1');input.props.onChange({target:{value:'1/2'}});t=h.render(CartonInboundDialog,p);nodes(t).find(n=>n.type?.name==='OperationDateHeader').props.onConfirm();t=h.render(CartonInboundDialog,p);button(t,'确认收货').props.onClick();await tick();assert.equal(calls[0].placements[0].palletCount,'1/2');assert.equal(calls[0].placements[0].boxes,4);t=h.render(CartonInboundDialog,p);button(t,'重试提交').props.onClick();await tick();assert.deepEqual(calls[1],calls[0]);
});


test('message receiving defaults each actual placement to one and preserves explicitly supplied zero',()=>{
 const h=harness(),{materializeMessageImport}=h.load('lib/message-goods.ts');
 const row={choiceKey:'one',quantity:2,boxes:1,locationCode:'A1',layerCount:1,productCondition:'good',productPrefix:'',inboundSource:'domestic',inboundOrder:'IB',note:'',barcodes:[]},choice={key:'one',product:'P',customerName:'C',sku:'S',members:[{palletCount:9}],review:false};let n=0;
 const lines=materializeMessageImport({mode:'inbound',rows:[row,{...row,palletCount:'0'},{...row,palletCount:'1/3'}]},[choice],[],()=>String(++n));assert.deepEqual(Array.from(lines[0].placements,p=>p.palletCount),['1','0','1/3']);
});


test('message dialog keeps explicit pallet zero through review and import callback',async()=>{
 let imported;const choice={key:'p',product:'透明饭盒',customerName:'客户A',sku:'S',members:[],quantity:10,boxes:1,review:false};
 const h=harness({hooks:true,effects:true,fetch:async()=>({ok:true,json:async()=>({choices:[choice]})})}),{MessageGoodsDialog}=h.load('components/MessageGoodsDialog.tsx'),p={open:true,stocks:[],locations:['A1'],canInbound:true,canOutbound:true,onClose:()=>{},onImport:value=>{imported=value}};
 let t=h.render(MessageGoodsDialog,p);await tick();t=h.render(MessageGoodsDialog,p);nodes(t).find(n=>n.props?.['aria-label']==='粘贴仓库消息').props.onChange({target:{value:'产品：透明饭盒\n正品4个 1箱 0托\n位于：A1一层\n来源：国内'}});t=h.render(MessageGoodsDialog,p);button(t,'识别并匹配').props.onClick();t=h.render(MessageGoodsDialog,p);
 const input=nodes(t).find(n=>n.props?.['aria-label']==='消息 1 入库托盘数');assert.ok(input);assert.equal(input.props.value,'0');button(t,'添加到入库草稿').props.onClick();assert.equal(imported.rows[0].palletCount,'0');
});

test('legacy message receiving defaults new rows to one but retains same-batch occupancy and explicit zero',()=>{
 const {parseInboundMessage}=harness().load('lib/inbound-message.ts'),options={inboundDate:'2026-10-01',locations:['A1'],stocks:[]};
 assert.equal(parseInboundMessage('产品：透明饭盒\n正品4个1箱\n位于：A1一层',options).items[0].draft.palletCount,1);
 assert.equal(parseInboundMessage('产品：透明饭盒\n正品4个1箱0托\n位于：A1一层',options).items[0].draft.palletCount,0);
 assert.equal(parseInboundMessage('产品：透明饭盒\n正品4个1箱1/3托\n位于：A1一层',options).items[0].draft.palletCount,1/3);
 const reference={id:1,product:'IB557715465RS',note:'FBA18XB2J3B3U',customerName:'DQ',locationCode:'A1',layerCount:1,totalQuantity:0,totalBoxes:8,palletCount:2};
 for(const palletCount of [0,2,.5])assert.equal(parseInboundMessage('FBA18XB2J3B3U。DQ入库8箱，放在A1第一层',{...options,stocks:[{...reference,palletCount}]}).items[0].draft.palletCount,palletCount);
});

test('physical staging can split return units and packaging across orders while actual outbound rejects the overlap',async()=>{
 const calls=[],saved={},h=harness({hooks:true,effects:true,saved,fetch:async(path,options)=>{if(options?.method==='POST'){calls.push({path,body:JSON.parse(options.body)});throw Error('offline')}return {ok:true,json:async()=>path==='/api/cartons'?{receipts:[]}:path==='/api/goods/staging'?{tasks:[],revision:4}:{choices:[choice],revision:4}}}});
 const spec=h.load('lib/goods-product-spec.ts').emptyGoodsProductSpec(),date=h.load('lib/warehouse-time.ts').warehouseTodayDate();
 const row={id:1,version:7,product:'退货产品',customerName:'客户A',sku:'SKU',barcode:'',fnsku:'',productCondition:'good',productPrefix:'',locationCode:'A1',layerCount:1,totalQuantity:10,totalBoxes:2,palletCount:1,inboundDate:'2026-10-01',inboundOrder:'IB',updatedAt:'2026-10-01',inboundSource:'return',inventoryUnit:'item'},choice={key:'g1',product:'退货产品',customerName:'客户A',sku:'SKU',barcode:'',members:[row],quantity:10,boxes:2,review:false,reason:'',productSpec:spec};
 const line=(id,q,b)=>({lineId:id,choiceKey:'g1',product:choice.product,customerName:choice.customerName,outboundOrder:id,inventoryUnit:'item',quantity:q,boxes:b,receipt:{inboundSource:'return',productSpec:spec,sku:'SKU',fnsku:'',barcode:'',productPrefix:'',productCondition:''},placements:[],picks:{1:{quantity:q,boxes:b,pallets:'.5'}},autoPlacement:false,pickCondition:'all'});
 const lines=[line('A','10','0'),line('B','0','2')];saved.goods=JSON.stringify({version:1,mode:'outbound',customer:'',query:'',lines,inboundDate:'2026-10-01',outboundDate:date,inboundOrder:'',note:'',receiptSource:'inherit',creating:false,newCustomer:'',newProduct:'',newSku:'',newBarcode:'',newSpec:spec,pending:null});
 const helpers=h.load('lib/goods-operation-input.ts'),tasks=lines.map(l=>({...l,choice}));assert.equal(helpers.outboundTaskConflict(tasks[0],tasks,'staging'),'');assert.match(helpers.outboundTaskConflict(tasks[0],[tasks[0],{...tasks[1],picks:{1:{...tasks[1].picks[1],pallets:'.75'}}}],'staging'),/托盘/);assert.match(helpers.outboundTaskConflict(tasks[0],tasks),/托盘|库存/);assert.equal(helpers.availableOutboundMembers(tasks[1],tasks,'staging')[0].palletCount,.5);assert.equal(helpers.outboundPalletDeduction(row,{quantity:'10',boxes:'0',pallets:''},'staging'),0);assert.equal(helpers.outboundPalletDeduction(row,{quantity:'10',boxes:'0',pallets:''}),1);assert.equal(helpers.completeOutboundAllocation(tasks[0],tasks,'staging').boxes,'0');
 const {GoodsOperationsDialog}=h.load('components/GoodsOperationsDialog.tsx'),p={open:true,initialMode:'outbound',draftKey:'goods',locations:['A1','B1'],canInbound:true,canOutbound:true,canMove:true,canEditSku:true,onClose:()=>{},onComplete:async()=>{}};let t;for(let i=0;i<3;i++){t=h.render(GoodsOperationsDialog,p);await tick()}
 assert.deepEqual(nodes(t).filter(n=>n.type?.name==='GoodsOperationRow').map(n=>n.props.line.boxes),['0','2']);nodes(t).find(n=>n.type?.name==='OperationDateHeader').props.onConfirm();t=h.render(GoodsOperationsDialog,p);button(t,'核对本单').props.onClick();t=h.render(GoodsOperationsDialog,p);assert.equal(button(t,'确认整单出库').props.disabled,true);assert.equal(button(t,'移库待出库').props.disabled,false);button(t,'移库待出库').props.onClick();t=h.render(GoodsOperationsDialog,p);
 const section=nodes(t).find(n=>n.props?.['aria-label']==='确认移库待出库');nodes(section).find(n=>n.type?.name==='LocationSearchInput').props.onChange('B1');t=h.render(GoodsOperationsDialog,p);assert.equal(button(t,'确认整单移库待出库').props.disabled,false);button(t,'确认整单移库待出库').props.onClick();await tick();assert.equal(calls.length,1);assert.equal(calls[0].path,'/api/goods/staging');assert.deepEqual(calls[0].body.lines.map(l=>[l.quantity,l.boxes,l.selected[0].pallets]),[['10','0','.5'],['0','2','.5']]);t=h.render(GoodsOperationsDialog,p);button(t,'核对上次提交').props.onClick();await tick();assert.deepEqual(calls[1],calls[0]);
});
