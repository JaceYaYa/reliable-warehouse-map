import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import React from 'react';

const require=createRequire(import.meta.url),tick=()=>new Promise(r=>setImmediate(r));
const nodes=t=>!t||typeof t!=='object'?[]:[t,...React.Children.toArray(t.props?.children).flatMap(nodes)];
const text=t=>nodes(t).map(n=>React.Children.toArray(n.props?.children).filter(c=>typeof c==='string'||typeof c==='number').join('')).join(' ');
const json=(payload,status=200)=>({ok:status>=200&&status<300,status,json:async()=>payload});

test('history row exposes correction action with original dates and current period, keeping confirmed protection visible',async()=>{
 const record={key:'goods:op:1',product:'历史货',sku:'S',customerName:'客户A',originalCustomerName:'原商家',revision:'rev',locationCode:'A1',layer:1,inboundDate:'2026-01-01',outboundDate:'2026-09-20',quantity:10,boxes:2,sourceLabel:'实物出库记录'};
 const h=harness(async()=>json(report({outboundHistory:[record]})));await h.settle();h.click('修改信息');h.render();const editor=nodes(h.tree).find(n=>typeof n.type==='function'&&n.type.name==='OutboundBillingDetailsEditor');assert.ok(editor);assert.equal(editor.props.record.inboundDate,'2026-01-01');assert.equal(editor.props.record.outboundDate,'2026-09-20');assert.equal(editor.props.period.fromMonth,'2026-09');assert.match(text(h.tree),/原商家/);
});
function row(overrides={}){return {key:'A1:1:A',locationCode:'A1',layer:1,customerName:'客户A',percent:100,volumeM3:2,sharedVolumeM3:2,products:['样品'],skus:['SKU1'],inboundDate:'2026-09-01',startDate:'2026-09-20',endDateExclusive:'2026-10-01',storageDays:11,billableDays:11,freeDays:0,chargeStartDate:'2026-09-01',ratePerM3Day:.7,feeUsd:15.4,status:'verified',reviewReasons:[],evidenceIds:['audit:1'],...overrides};}
function report(overrides={}){return {basis:'layer',asOf:'2026-09-30',period:{fromMonth:'2026-09',toMonth:'2026-09',periodStart:'2026-09-01',periodEndExclusive:'2026-10-01'},settings:{ok:true,config:{schemaVersion:1,revision:4,locations:{}},aliases:{},locations:['A1'],zones:[{id:'A',title:'A区',codes:['A1']}],occupied:[{key:'["A1",1]',locationCode:'A1',layer:1,volumeM3:2,volumeSource:'default',customers:[{customerName:'客户A',oldestInboundDate:'2026-09-01',products:['样品'],recordIds:['1']}],shares:[{customerName:'客户A',percent:100}],reviewReasons:[],occupants:[]}]},current:{layerCount:1,volumeM3:2,dailyFeeUsd:1.4,pendingCount:0,rows:[row({feeUsd:1.4,storageDays:1,billableDays:1})]},rows:[row()],pending:[],totals:{verifiedFeeUsd:15.4,complete:true,pendingSegments:0,customerTotals:[{customerName:'客户A',feeUsd:15.4,pendingCount:0}]},coverage:{checkpointAt:'2026-09-20T16:00:00Z',fromDate:'2026-09-20'},confirmedHistory:{count:0,feeUsd:0,records:[]},...overrides};}
function harness(handler=async()=>json(report()),options={}){
 const directoryFixture=options.directory;
 assert.ok(existsSync('components/LayerStoragePricingWorkspace.tsx'),'layer pricing workspace must exist');
 let cursor=0,tree;const state=[],effectDeps=[],cleanups=[],queued=[],cache=new Map(),calls=[],directoryCalls=[];let didSelect=false;
 const hooks={...React,useState:init=>{const i=cursor++;if(!(i in state))state[i]=typeof init==='function'?init():init;return[state[i],v=>{state[i]=typeof v==='function'?v(state[i]):v}]},useRef:init=>{const i=cursor++;if(!(i in state))state[i]={current:init};return state[i]},useMemo:fn=>fn(),useCallback:(fn,deps)=>{const i=cursor++;if(!state[i]||deps.some((d,j)=>!Object.is(d,state[i].deps[j])))state[i]={fn,deps};return state[i].fn},useEffect:(fn,deps)=>{const i=cursor++;if(!effectDeps[i]||deps.some((d,j)=>!Object.is(d,effectDeps[i][j]))){effectDeps[i]=deps;queued.push(()=>{cleanups[i]?.();cleanups[i]=fn()})}}};
 class Clock extends Date{constructor(...args){super(...(args.length?args:['2026-10-01T01:00:00Z']))}static now(){return Date.parse('2026-10-01T01:00:00Z')}}
 const load=file=>{file=resolve(file);if(file.endsWith('.css'))return {};if(cache.has(file))return cache.get(file);const exports={};cache.set(file,exports);const code=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;runInNewContext(code,{exports,require:s=>{if(s==='react')return hooks;if(!s.startsWith('.'))return require(s);let p=resolve(dirname(file),s);if(!existsSync(p))p+=existsSync(p+'.tsx')?'.tsx':'.ts';return load(p)},console,Error,Date:Clock,Intl,URLSearchParams,AbortController,fetch:async(url,options={})=>{if(String(url)==='/api/pricing/customers'){directoryCalls.push({url:String(url),options});return json(directoryFixture??{customers:['客户A','客户B'],unclaimedCount:1});}calls.push({url:String(url),options});return handler(String(url),options,calls)}});return exports;};
 const {LayerStoragePricingWorkspace}=load('components/LayerStoragePricingWorkspace.tsx');
 const render=()=>{cursor=0;tree=LayerStoragePricingWorkspace({});while(queued.length)queued.shift()();return tree};
 const input=(label,value)=>{const node=nodes(tree).find(n=>n.props?.['aria-label']===label);assert.ok(node,`missing input ${label}`);node.props.onChange({target:{value}});render()};
 const click=label=>{const node=nodes(tree).find(n=>n.type==='button'&&text(n).trim()===label);assert.ok(node,`missing button ${label}`);node.props.onClick?.({preventDefault(){}});render()};
 const settle=async()=>{await tick();render();if(!didSelect&&options.preselect!==false){didSelect=true;input("筛选客户","客户A");}await tick();render();await tick();render()};
 render();return{render,input,click,settle,calls,directoryCalls,get tree(){return tree},get editor(){return nodes(tree).find(n=>n.type?.name==='LayerPricingSettings')}};
}

test('default query follows New York calendar dates and export and expiry routes use the requested filters',async()=>{
 const h=harness();await h.settle();const first=new URL(h.calls[0].url,'https://test');assert.equal(first.searchParams.get('fromDate'),'2026-09-01');assert.equal(first.searchParams.get('toDate'),'2026-09-30');assert.equal(h.calls[0].options.cache,'no-store');assert.ok(nodes(h.tree).some(n=>n.type==='a'&&n.props.href==='/pricing/free-periods'));
 h.input('起始日期','2026-08-07');h.input('结束日期','2026-09-12');h.input('筛选客户','客户A');h.input('搜索库位或货物','A1 / SKU');h.click('查询');await h.settle();const query=new URL(h.calls.at(-1).url,'https://test').search;assert.ok(nodes(h.tree).some(n=>n.type==='a'&&n.props.href===`/api/pricing/layers/export${query}`));assert.match(decodeURIComponent(query),/customer=客户A/);
});

test('verified subtotal and pending history remain separate and null row fee never appears as a zero charge',async()=>{
 const pendingRow=row({key:'pending',feeUsd:null,ratePerM3Day:null,status:'review',reviewReasons:['基线以前实际占层历史不足']});const h=harness(async()=>json(report({rows:[row({key:'good',locationCode:'A2',feeUsd:12.34}),pendingRow],pending:[{code:'history-gap',message:'基线以前实际占层历史不足',startDate:'2026-09-01',endDateExclusive:'2026-09-20'}],totals:{verifiedFeeUsd:12.34,complete:false,pendingSegments:3,customerTotals:[{customerName:'客户A',feeUsd:12.34,pendingCount:3}]}})));await h.settle();assert.match(text(h.tree),/12\.34/);assert.match(text(h.tree),/不能计算/);assert.match(text(h.tree),/基线以前实际占层历史不足/);assert.match(text(h.tree),/非账单/);const tr=nodes(h.tree).find(n=>n.type==='tr'&&n.props['data-uncalculable-row']==='pending');assert.ok(tr);assert.match(text(tr),/金额未知/);assert.doesNotMatch(text(tr),/\$0\.00/);assert.match(text(h.tree),/未计入合计/);
});

test('late filter responses cannot replace a newer report',async()=>{
 const waiting=[];const h=harness(async()=>new Promise(r=>waiting.push(r)));await h.settle();h.input('搜索库位或货物','OLD');h.click('查询');h.input('搜索库位或货物','NEW');h.click('查询');assert.equal(waiting.length,3);waiting[2](json(report({rows:[row({products:['最新结果']})]})));await h.settle();waiting[1](json(report({rows:[row({products:['旧结果']})]})));waiting[0](json(report({rows:[row({products:['最初结果']})]})));await h.settle();assert.match(text(h.tree),/最新结果/);assert.doesNotMatch(text(h.tree),/旧结果|最初结果/);
});

test('changed report query never shows old totals, exports or report settings while pending or after a failure',async()=>{
 let finish;
 const h=harness(async(_url,_options,calls)=>calls.length===1?json(report({rows:[row({products:['上次报告专属货物']})]})):new Promise(resolve=>{finish=resolve;}));
 await h.settle();assert.match(text(h.tree),/上次报告专属货物/);assert.ok(h.editor);
 h.input('起始日期','2025-01-01');h.input('结束日期','2026-10-29');h.click('查询');
 const assertUnavailable=()=>{assert.doesNotMatch(text(h.tree),/上次报告专属货物|本期可计算仓储费合计|导出 Excel/);assert.equal(h.editor,undefined);assert.ok(!nodes(h.tree).some(n=>n.props?.href?.startsWith('/api/pricing/layers/export')));};
 assertUnavailable();assert.match(text(h.tree),/正在读取托层报告/);
 finish(json({error:'报告暂时无法生成'},500));await h.settle();assertUnavailable();assert.match(text(h.tree),/报告暂时无法生成/);
 h.click('重试');assertUnavailable();finish(json(report({rows:[row({products:['本次完整报告']})],period:{fromDate:'2025-01-01',toDate:'2026-10-29',periodStart:'2025-01-01',periodEndExclusive:'2026-10-30'}})));await h.settle();
 assert.match(text(h.tree),/本次完整报告/);assert.match(text(h.tree),/2025-01-01 至 2026-10-29/);assert.ok(h.editor);assert.match(nodes(h.tree).find(n=>n.props.className==='lsp-export').props.href,/fromDate=2025-01-01&toDate=2026-10-29/);
});

test('same-query refresh failure leaves no current report actions and late failure cannot hide a newer success',async()=>{
 const waiting=[];let initial=true;const h=harness(async()=>{if(initial){initial=false;return json(report({rows:[row({products:['刷新前货物']})]}));}return new Promise(resolve=>waiting.push(resolve));});await h.settle();
 h.click('刷新资料');assert.doesNotMatch(text(h.tree),/刷新前货物|导出 Excel/);assert.equal(h.editor,undefined);
 waiting[0](json({error:'刷新失败'},500));await h.settle();assert.match(text(h.tree),/刷新失败/);assert.doesNotMatch(text(h.tree),/刷新前货物|导出 Excel/);
 h.click('重试');h.input('搜索库位或货物','NEW');h.click('查询');waiting[2](json(report({rows:[row({products:['新查询成功']})]})));await h.settle();waiting[1](json({error:'过期失败'},500));await h.settle();assert.match(text(h.tree),/新查询成功/);assert.doesNotMatch(text(h.tree),/过期失败/);assert.ok(h.editor);
});

test('date and search drafts require a query and a previous record editor cannot reopen against a new period',async()=>{
 const record={key:'goods:old',revision:'r1',product:'旧记录',customerName:'客户A'};
 const h=harness(async()=>json(report({outboundHistory:[record]})));await h.settle();h.click('修改信息');assert.ok(nodes(h.tree).some(n=>n.type?.name==='OutboundBillingDetailsEditor'));
 h.input('起始日期','2025-01-01');assert.match(text(h.tree),/查询条件已修改，请点击查询/);assert.match(nodes(h.tree).find(n=>n.props.className==='lsp-export').props.href,/fromDate=2026-09-01/);
 h.click('查询');await h.settle();assert.ok(h.editor);assert.ok(!nodes(h.tree).some(n=>n.type?.name==='OutboundBillingDetailsEditor'),'an editor from the old query must not reopen against a new period');
 h.input('搜索库位或货物','SKU-NEW');assert.match(text(h.tree),/查询条件已修改，请点击查询/);
});

test('failed settings callback throws human error without reload and retains controlled revision; success reloads report',async()=>{
 let fail=true,revision=4;const h=harness(async(url,options)=>{if(options.method==='PATCH'){assert.equal(url,'/api/pricing/layers/settings');if(fail)return json({error:'版本已失效，本次未保存'},409);revision=5;return json({...report().settings,config:{schemaVersion:1,revision,locations:{}}});}return json(report({settings:{...report().settings,config:{schemaVersion:1,revision,locations:{}}}}));});await h.settle();const changed={schemaVersion:1,revision:4,locations:{A1:{defaultVolumeM3:3,layers:{}}}};
 await assert.rejects(()=>h.editor.props.onSave(changed),/版本已失效，本次未保存/);h.render();assert.equal(h.calls.length,2);assert.equal(h.editor.props.config.revision,4);assert.deepEqual(JSON.parse(h.calls[1].options.body),{expectedRevision:4,config:changed});fail=false;await h.editor.props.onSave(changed);h.render();assert.equal(h.calls.length,4);assert.equal(h.editor.props.config.revision,5);
});

test('chosen customer profile accepts explicit zero and blank inherits with exact existing endpoint payload',async()=>{
 const patches=[];const h=harness(async(url,options)=>{if(url.startsWith('/api/pricing/customer-settings')){if(options.method==='PATCH'){const body=JSON.parse(options.body);patches.push(body);return json({ok:true,profile:body})}return json({ok:true,profile:{customerName:'客户A',ratePerM3Day:null,freeDays:null}})}return json(report())});await h.settle();h.input('客户规则客户','客户A');h.click('读取客户规则');await h.settle();h.input('客户每日单价','0');h.input('客户免租天数','0');h.click('保存客户规则');await h.settle();assert.deepEqual(patches[0],{customerName:'客户A',ratePerM3Day:0,freeDays:0});h.input('客户每日单价','');h.input('客户免租天数','');h.click('保存客户规则');await h.settle();assert.deepEqual(patches[1],{customerName:'客户A',ratePerM3Day:null,freeDays:null});
});

test('failed customer profile save preserves raw inputs and does not refresh fee data',async()=>{
 const h=harness(async(url,options)=>url.startsWith('/api/pricing/customer-settings')?options.method==='PATCH'?json({error:'客户规则保存冲突'},409):json({ok:true,profile:{customerName:'客户A',ratePerM3Day:.7,freeDays:30}}):json(report()));await h.settle();h.input('客户规则客户','客户A');h.click('读取客户规则');await h.settle();h.input('客户每日单价','2.50');h.input('客户免租天数','12');h.click('保存客户规则');await h.settle();assert.match(text(h.tree),/客户规则保存冲突/);assert.equal(nodes(h.tree).find(n=>n.props?.['aria-label']==='客户每日单价').props.value,'2.50');assert.equal(h.calls.filter(c=>c.url.startsWith('/api/pricing/layers/report')).length,1);
});

test('empty report and fetch authorization errors stay explicit instead of inventing bill rows',async()=>{
 const h=harness(async()=>json(report({rows:[],current:{layerCount:0,volumeM3:0,dailyFeeUsd:0,pendingCount:0,rows:[]},totals:{verifiedFeeUsd:0,complete:true,pendingSegments:0,customerTotals:[]}})));await h.settle();assert.match(text(h.tree),/本期无可计算的在库费用/);const denied=harness(async()=>json({error:'仅老板可查看托层计价'},403));await denied.settle();assert.match(text(denied.tree),/仅老板可查看托层计价/);assert.equal(denied.editor,undefined);
});

test('confirmed history is a separate read-only section and does not become the layer subtotal',async()=>{
 const h=harness(async()=>json(report({confirmedHistory:{count:1,feeUsd:99,records:[{id:42,customerName:'客户A',product:'历史样品',feeUsd:99,settledAt:'2026-09-01',settledBy:'老板'}]}})));await h.settle();assert.match(text(h.tree),/旧已确认账单/);assert.match(text(h.tree),/99\.00/);assert.match(text(h.tree),/15\.40/);assert.doesNotMatch(text(h.tree),/修改账单|确认结算|切换旧计价/);
});

test('settings save finishing after a filter change reloads the latest applied query instead of the old one',async()=>{
 let finish;const h=harness(async(url,options)=>{if(options.method==='PATCH')return new Promise(r=>{finish=()=>r(json(report().settings))});const q=new URL(url,'https://test').searchParams.get('q');return json(report({rows:[row({products:[q?'新筛选结果':'原筛选结果']})]}));});await h.settle();const save=h.editor.props.onSave({schemaVersion:1,revision:4,locations:{}});h.input('搜索库位或货物','NEW');h.click('查询');await h.settle();finish();await save;h.render();assert.equal(new URL(h.calls.at(-1).url,'https://test').searchParams.get('q'),'NEW');assert.match(text(h.tree),/新筛选结果/);assert.doesNotMatch(text(h.tree),/原筛选结果/);
});

test('invalid date range and invalid customer numbers are rejected while keeping raw inputs',async()=>{
 const h=harness(async(url)=>url.startsWith('/api/pricing/customer-settings')?json({ok:true,profile:{customerName:'客户A',ratePerM3Day:null,freeDays:null}}):json(report()));await h.settle();h.input('起始日期','2026-10-01');h.input('结束日期','2026-09-12');h.click('查询');assert.equal(h.calls.length,1);assert.match(text(h.tree),/起始日期不能晚于结束日期/);h.input('客户规则客户','客户A');h.click('读取客户规则');await h.settle();h.input('客户每日单价','-1');h.click('保存客户规则');await h.settle();assert.equal(h.calls.filter(c=>c.options.method==='PATCH').length,0);h.input('客户每日单价','2.5');h.input('客户免租天数','1.5');h.click('保存客户规则');await h.settle();assert.equal(h.calls.filter(c=>c.options.method==='PATCH').length,0);assert.equal(nodes(h.tree).find(n=>n.props?.['aria-label']==='客户免租天数').props.value,'1.5');
});

test('small configured volume and daily rate remain visible as nonzero values',async()=>{
 const h=harness(async()=>json(report({rows:[row({volumeM3:.00001,sharedVolumeM3:.00001,ratePerM3Day:.001})]})));await h.settle();const tr=nodes(h.tree).find(n=>n.type==='tr'&&n.props['data-layer-row']==='A1:1:A');assert.match(text(tr),/0\.00001 m³/);assert.match(text(tr),/\$0\.001 \/ m³/);
});

test('customer groups show batch dates, pallet fee details and independent free clocks',async()=>{
 const h=harness(async()=>json(report({rows:[row({products:['货物甲','货物乙'],percent:50,sharedVolumeM3:1}),row({key:'A1:1:B',customerName:'客户B',percent:50,sharedVolumeM3:1,feeUsd:20})]})));await h.settle();
 const groups=nodes(h.tree).filter(n=>n.type==='section'&&n.props['data-layer-customer']);assert.equal(groups.length,3);assert.match(text(groups[0]),/客户A/);assert.match(text(groups[0]),/15\.40/);
 const tr=nodes(h.tree).find(n=>n.type==='tr'&&n.props['data-layer-row']==='A1:1:A');assert.match(text(tr),/2 m³/);assert.match(text(tr),/2026-09-01/);assert.ok(nodes(tr).some(n=>n.type==='details'));assert.doesNotMatch(text(h.tree),/分摊|50%|100%/);assert.match(text(h.tree),/各到仓批次分别计算免租/);
});

function openDefaults(h){const details=nodes(h.tree).find(n=>n.type==='details'&&n.props.className.includes('lsp-default-settings'));assert.ok(details,'global default rule editor must be available');details.props.onToggle({currentTarget:{open:true}});h.render();}

test('pricing starts with only the customer directory and clearing selection drops details without a full report request',async()=>{
 const h=harness(undefined,{preselect:false});await h.settle();assert.equal(h.calls.length,0);assert.equal(h.directoryCalls.length,1);assert.match(text(h.tree),/请先选择客户/);assert.ok(!nodes(h.tree).some(n=>n.type==='tr'&&n.props['data-layer-row']));
 h.input('筛选客户','客户A');await h.settle();assert.equal(h.calls.length,1);assert.match(h.calls[0].url,/customer=/);assert.ok(nodes(h.tree).some(n=>n.type==='tr'&&n.props['data-layer-row']));
 h.input('筛选客户','');await h.settle();assert.equal(h.calls.length,1);assert.ok(!nodes(h.tree).some(n=>n.type==='tr'&&n.props['data-layer-row']));
 h.input('筛选客户','__unclaimed__');await h.settle();assert.match(h.calls.at(-1).url,/unclaimed=1/);
});
test('a settings save finishing after customer is cleared cannot request or show an all-customer report',async()=>{
 let finish;const h=harness(async(url,options)=>options.method==='PATCH'?new Promise(resolve=>{finish=resolve;}):json(report()));await h.settle();const saving=h.editor.props.onSave(report().settings.config);await tick();h.input('筛选客户','');finish(json({ok:true}));await saving;await h.settle();assert.equal(h.calls.filter(c=>c.url.startsWith('/api/pricing/layers/report')).length,1);assert.ok(!nodes(h.tree).some(n=>n.type==='tr'&&n.props['data-layer-row']));
});

test('customer heading shows effective default and custom rules and opens the same customer editor in place',async()=>{
 const h=harness(async(url,options)=>url.startsWith('/api/pricing/customer-settings')?json({ok:true,profile:{customerName:'客户A',ratePerM3Day:0,freeDays:null}}):json(report({customerProfiles:[{customerName:'客户A',ratePerM3Day:0,freeDays:null}],rows:[row({ratePerM3Day:0,freeDays:90})]})));await h.settle();
 const header=nodes(h.tree).find(n=>n.type==='section'&&n.props['data-layer-customer']==='客户A');assert.match(text(header),/客户专属/);assert.match(text(header),/\$0/);assert.match(text(header),/免租 90 天.*沿用默认/);nodes(h.tree).find(n=>n.props?.['aria-label']==='设置计价 · 客户A').props.onClick();h.render();await h.settle();const updated=nodes(h.tree).find(n=>n.type==='section'&&n.props['data-layer-customer']==='客户A');assert.ok(nodes(updated).some(n=>n.props?.['aria-label']==='客户每日单价'));assert.equal(nodes(updated).find(n=>n.props?.['aria-label']==='客户每日单价').props.value,'0');assert.equal(nodes(updated).find(n=>n.props?.['aria-label']==='客户免租天数').props.value,'');
 const defaults=harness();await defaults.settle();const defaultHeader=nodes(defaults.tree).find(n=>n.type==='section'&&n.props['data-layer-customer']==='客户A');assert.match(text(defaultHeader),/沿用默认/);
});

test('same-layer batches keep separate fee rows and expandable evidence',async()=>{
 const h=harness(async()=>json(report({rows:[row({key:'part1',storageDays:5,billableDays:5,feeUsd:7,calculationBasis:'current-occupancy'}),row({key:'part2',startDate:'2026-09-25',storageDays:6,billableDays:6,feeUsd:8.4})],coverage:{fromDate:null,checkpointAt:null,currentOccupancyPeriods:[{startDate:'2026-09-01',endDateExclusive:'2026-09-20'}]}})));await h.settle();
 const monthly=nodes(h.tree).find(n=>n.type==='section'&&n.props.className==='lsp-monthly'),rows=nodes(monthly).filter(n=>n.type==='tr'&&n.props['data-layer-row']);assert.equal(rows.length,2);assert.match(text(rows[0]),/7\.00/);assert.match(text(rows[1]),/8\.40/);assert.match(text(rows[0]),/计费 5 天/);assert.match(text(monthly),/1 个库位/);assert.match(text(h.tree),/历史缺失时段按当前记录托数估算/);assert.doesNotMatch(text(h.tree),/历史证据尚不完整|分摊比例/);
});

test('global defaults load lazily and save explicit zero through the existing endpoint without losing another draft',async()=>{
 const patches=[];const h=harness(async(url,options)=>{if(url==='/api/pricing/settings'){if(options.method==='PATCH'){patches.push(JSON.parse(options.body));return json({ok:true,settings:patches.at(-1)})}return json({ok:true,settings:{defaultRatePerM3Day:.7,defaultFreeDays:30}})}if(url.startsWith('/api/pricing/customer-settings'))return json({ok:true,profile:{customerName:'客户A',ratePerM3Day:.9,freeDays:15}});return json(report())});await h.settle();assert.equal(h.calls.length,1);h.input('客户规则客户','客户A');h.click('读取客户规则');await h.settle();h.input('客户每日单价','2.50');openDefaults(h);await h.settle();assert.equal(nodes(h.tree).find(n=>n.props?.['aria-label']==='全仓默认每日单价').props.value,'0.7');assert.equal(nodes(h.tree).find(n=>n.props?.['aria-label']==='全仓默认免租天数').props.value,'30');h.input('全仓默认每日单价','0');h.input('全仓默认免租天数','0');h.click('保存全仓默认规则');await h.settle();assert.deepEqual(patches,[{defaultRatePerM3Day:0,defaultFreeDays:0}]);assert.equal(h.calls.filter(c=>c.url.startsWith('/api/pricing/layers/report')).length,2);assert.equal(nodes(h.tree).find(n=>n.props?.['aria-label']==='客户每日单价').props.value,'2.50');assert.equal(h.editor.props.config.revision,4);
});

test('global defaults reject blanks, out-of-range rates and fractional days without converting them to zero',async()=>{
 const h=harness(async(url)=>url==='/api/pricing/settings'?json({ok:true,settings:{defaultRatePerM3Day:.7,defaultFreeDays:30}}):json(report()));await h.settle();openDefaults(h);await h.settle();for(const invalid of ['','-1','1000001','NaN']){h.input('全仓默认每日单价',invalid);h.click('保存全仓默认规则');await h.settle();assert.equal(h.calls.filter(c=>c.options.method==='PATCH').length,0);assert.equal(nodes(h.tree).find(n=>n.props?.['aria-label']==='全仓默认每日单价').props.value,invalid);}h.input('全仓默认每日单价','2.5');for(const invalid of ['','1.5','-1','36501']){h.input('全仓默认免租天数',invalid);h.click('保存全仓默认规则');await h.settle();assert.equal(h.calls.filter(c=>c.options.method==='PATCH').length,0);assert.equal(nodes(h.tree).find(n=>n.props?.['aria-label']==='全仓默认免租天数').props.value,invalid);}
});

test('global default save error keeps raw inputs and skips report refresh',async()=>{
 const h=harness(async(url,options)=>url==='/api/pricing/settings'?options.method==='PATCH'?json({error:'默认规则保存冲突，本次未保存'},409):json({ok:true,settings:{defaultRatePerM3Day:.7,defaultFreeDays:30}}):json(report()));await h.settle();openDefaults(h);await h.settle();h.input('全仓默认每日单价','2.50');h.input('全仓默认免租天数','14');h.click('保存全仓默认规则');await h.settle();assert.match(text(h.tree),/默认规则保存冲突，本次未保存/);assert.equal(nodes(h.tree).find(n=>n.props?.['aria-label']==='全仓默认每日单价').props.value,'2.50');assert.equal(nodes(h.tree).find(n=>n.props?.['aria-label']==='全仓默认免租天数').props.value,'14');assert.equal(h.calls.filter(c=>c.url.startsWith('/api/pricing/layers/report')).length,1);
});

test('failed lazy global-default read offers a retry instead of guessed editable values',async()=>{
 let fails=true;const h=harness(async(url)=>url==='/api/pricing/settings'?fails?json({error:'默认规则暂时无法读取'},503):json({ok:true,settings:{defaultRatePerM3Day:0,defaultFreeDays:0}}):json(report()));await h.settle();openDefaults(h);await h.settle();assert.match(text(h.tree),/默认规则暂时无法读取/);assert.equal(nodes(h.tree).find(n=>n.props?.['aria-label']==='全仓默认每日单价'),undefined);fails=false;h.click('重试读取默认规则');await h.settle();assert.equal(nodes(h.tree).find(n=>n.props?.['aria-label']==='全仓默认每日单价').props.value,'0');assert.equal(nodes(h.tree).find(n=>n.props?.['aria-label']==='全仓默认免租天数').props.value,'0');
});
test('staged goods retain original billing layer and fee while exposing physical destination in expandable details',async()=>{
 const staged=row({locationCode:'A1',layer:2,physicalLocations:[{locationCode:'待出库',layer:1,staged:true}],feeUsd:15.4,volumeM3:2,inboundDate:'2026-09-01'});
 const h=harness(async()=>json(report({rows:[staged],current:{layerCount:1,volumeM3:2,dailyFeeUsd:1.4,pendingCount:0,rows:[staged]}})));await h.settle();
 const tr=nodes(h.tree).find(n=>n.type==='tr'&&n.props['data-layer-row']===staged.key),source=nodes(tr).find(n=>n.type==='td'&&n.props['data-label']==='库位 / 层');
 assert.match(text(source),/A1.*第 2 层/);assert.match(text(source),/待出库沿用原层计价/);assert.doesNotMatch(text(source),/第 1 层/);
 const details=nodes(tr).find(n=>n.type==='details');assert.match(text(details),/该时段实物位置.*待出库.*第 1 层/);assert.match(text(tr),/15\.40/);assert.match(text(tr),/2 m³/);assert.match(text(tr),/2026-09-01/);assert.match(text(h.tree),/当前计价层数/);assert.doesNotMatch(text(h.tree),/当前实际占用/);
});

test('historical-only customer has explicit label and separately displays original inbound and outbound dates without monthly fee',async()=>{const h=harness(async()=>json(report({rows:[],current:{layerCount:0,volumeM3:0,dailyFeeUsd:0,pendingCount:0,rows:[]},totals:{verifiedFeeUsd:0,complete:true,pendingSegments:0,customerTotals:[]},outboundHistory:[{key:'old:XZX',sourceLabel:'历史出库结算记录',customerName:'XZX',product:'历史产品',sku:'S1',locationCode:'A1',layer:null,inboundDate:'2026-02-11',outboundDate:'2026-07-24',quantity:4,boxes:0,order:''}]})),{preselect:false,directory:{customers:['XZX'],historicalCustomers:['XZX'],unclaimedCount:0}});await h.settle();assert.match(text(h.tree),/XZX.*历史出货/);h.input('筛选客户','XZX');await h.settle();assert.match(text(h.tree),/原始出货记录/);assert.match(text(h.tree),/入库日期/);assert.match(text(h.tree),/出库日期/);assert.match(text(h.tree),/2026-02-11/);assert.match(text(h.tree),/2026-07-24/);assert.match(text(h.tree),/原确认状态不影响重算/);assert.match(text(h.tree),/当前无在库货物/);});
test('native date input events retain exact draft dates through late report responses and export applied bounds',async()=>{
 const waiting=[],h=harness(async()=>new Promise(resolve=>waiting.push(resolve)));await h.settle();const native=(label,value)=>{const input=nodes(h.tree).find(n=>n.props?.['aria-label']===label);assert.equal(typeof input.props.onInput,'function');input.props.onInput({currentTarget:{value}});h.render();};native('起始日期','2026-10-14');native('结束日期','2026-10-20');h.click('查询');await h.settle();assert.equal(waiting.length,2);const params=new URL(h.calls.at(-1).url,'https://test').searchParams;assert.equal(params.get('fromDate'),'2026-10-14');assert.equal(params.get('toDate'),'2026-10-20');waiting[1](json(report({period:{fromDate:'2026-10-14',toDate:'2026-10-20',periodStart:'2026-10-14',periodEndExclusive:'2026-10-21'}})));await h.settle();waiting[0](json(report()));await h.settle();assert.equal(nodes(h.tree).find(n=>n.props?.['aria-label']==='起始日期').props.value,'2026-10-14');assert.equal(nodes(h.tree).find(n=>n.props?.['aria-label']==='结束日期').props.value,'2026-10-20');assert.match(nodes(h.tree).find(n=>n.type==='a'&&n.props.className?.includes('lsp-export')).props.href,/fromDate=2026-10-14&toDate=2026-10-20/);
});

test('empty or fully migrated archive has no redundant archive panel',async()=>{const h=harness(async()=>json(report()));await h.settle();assert.doesNotMatch(text(h.tree),/旧已确认账单|暂无旧已确认账单/);});
