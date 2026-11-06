import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {parseDelivery,deliveryBody} from '../lib/workorders/legacy/delivery-data.mjs';
import {applyPacking} from '../lib/workorders/legacy/sku-delivery.mjs';
import {combineDocuments,parseFreightSheets} from '../lib/workorders/legacy/freight-data.mjs';
import {parseCartonScreenshot} from '../lib/workorders/legacy/carton-screenshot.mjs';
import {mergeSources} from '../lib/workorders/legacy/source-merge.mjs';
import {normalizeOcr} from '../lib/workorders/legacy/task-draft.mjs';
import {warehouseApiHarness} from './helpers/warehouse-api-harness.mjs';
const fixture=name=>JSON.parse(readFileSync(new URL(`fixtures/workorders/${name}.json`,import.meta.url)));
const skuDoc=()=>parseDelivery(fixture('delivery-sku-pages'));
test('workorders parsing: five BySKU OBC documents retain independent units and require explicit non-rounding packing',()=>{
 const doc=skuDoc();assert.equal(doc.rows.length,5);assert.equal(doc.mode,'sku');assert.deepEqual(doc.rows.map(r=>[r.orderNo.slice(-2),r.shipUnits]),[['RV','300'],['RS','200'],['RW','300'],['RT','300'],['RU','300']]);assert.ok(doc.rows.every(r=>r.boxes===''&&r.perCarton===''&&r.inboundNo===''));assert.match(deliveryBody(doc),/1400个/);assert.doesNotMatch(deliveryBody(doc),/14箱|10X18X18/);
 applyPacking(doc,100);assert.deepEqual(doc.rows.map(r=>r.boxes),[3,2,3,3,3]);assert.match(deliveryBody(doc),/OBC5577154605RS 2箱 100个\/箱 共200个/);applyPacking(doc,113);assert.ok(doc.rows.every(r=>r.boxes===''));assert.throws(()=>applyPacking(doc,0),/大于0/);
});
test('workorders parsing: combined BySKU PDF repeats count once but conflicting order quantities stay blocked',()=>{
 const pages=fixture('delivery-sku-pages'),combined=combineDocuments([parseDelivery(pages.slice(0,2)),parseDelivery(pages.slice(2)),skuDoc()]);assert.equal(combined.doc.rows.length,5);assert.equal(combined.doc.rows.reduce((n,r)=>n+Number(r.shipUnits),0),1400);assert.match(combined.warnings.join(),/重复清单/);const wrong=skuDoc();wrong.rows[0].shipUnits='301';assert.throws(()=>combineDocuments([skuDoc(),wrong]),/不一致/);
});
test('workorders parsing: PDF anchor and OCR preserve order/barcode conflicts without leaking auto customer into body',()=>{
 const ocr=normalizeOcr(fixture('delivery-sku-ocr').text),result=mergeSources({pdf:skuDoc(),ocr});assert.deepEqual(result.conflicts,[]);assert.equal(result.doc.rows.length,5);assert.match(result.draft.product,/16\s*promax/);assert.doesNotMatch(deliveryBody(result.doc),/示例商家|8000001/);
 const wrong=mergeSources({pdf:skuDoc(),ocr:ocr.replace('X0050YE8A5','X001234567')});assert.equal(wrong.draft.newBarcode,'');assert.ok(wrong.conflicts.some(c=>c.id==='field:newBarcode'&&!c.resolved));assert.doesNotMatch(wrong.doc.requirements,/X0050YE8A5|X001234567/);const resolved=mergeSources({pdf:skuDoc(),ocr:ocr.replace('X0050YE8A5','X001234567'),resolutions:{'field:newBarcode':'X0050YE8A5'}});assert.equal(resolved.draft.newBarcode,'X0050YE8A5');assert.doesNotMatch(resolved.doc.requirements,/X001234567/);
});
test('workorders parsing: Excel quantity semantics must be chosen and 0 actual outbound is not planned units',()=>{
 const sheets=fixture('freight-sheets'),unknown=parseFreightSheets(sheets);assert.equal(unknown.needsQuantityMode,true);assert.deepEqual(unknown.records.map(r=>[r.boxes,r.rawQuantity,r.actualBoxes]),[[4,100,0],[7,100,0],[1,113,0]]);assert.ok(unknown.records.every(r=>r.perCarton===''&&r.shipUnits===''));
 const per=parseFreightSheets(sheets,{quantityMode:'perCarton'});assert.deepEqual(per.records.map(r=>r.shipUnits),['400','700','113']);assert.equal(per.doc.declaredBoxes,12);for(const [i,total]of [400,701,113].entries())sheets[0].rows[i+1][12]=total;const totals=parseFreightSheets(sheets,{quantityMode:'total'});assert.equal(totals.records[1].perCarton,'');assert.match(totals.warnings.join(),/不能整除/);
});
test('workorders parsing: screenshot columns do not confuse carton barcode with units; I/1 identities require confirmation',()=>{
 const pdf=parseDelivery(fixture('delivery-pages')),ocr=fixture('carton-ocr'),parsed=parseCartonScreenshot(ocr);assert.deepEqual(parsed.rows.map(r=>[r.perCarton,r.boxes,r.shipUnits]),[['100',4,'400'],['100',7,'700'],['113',1,'113']]);const rows=parsed.rows.map(r=>({...r,source:'截图 1 箱型明细'})),text='产品：钢化膜 高清款 17 promax\nIB002251127RS-C1 4箱 每箱100个 共400\nIB002251128RT-C1 7箱 每箱100个 共700\nIB002251128RT-C2 1箱 里面有113个 出货100个 余13个转产品库存，不出库';
 const result=mergeSources({pdf,text,ocr:ocr.text,screenshotRows:rows}),resolutions={};for(const conflict of result.conflicts.filter(c=>c.id.endsWith('confirm-inbound'))){assert.equal(conflict.resolved,false);resolutions[conflict.id]=conflict.options[0].value;}assert.equal(Object.keys(resolutions).length,3);const mixed=mergeSources({pdf,text,ocr:ocr.text,screenshotRows:rows,resolutions});assert.ok(mixed.conflicts.some(c=>c.id==='row:IB557706673RT-C7:shipUnits'&&!c.resolved));const checked=mergeSources({pdf,text,ocr:ocr.text,screenshotRows:rows,resolutions:{...resolutions,'row:IB557706673RT-C7:shipUnits':'100'}});assert.match(deliveryBody(checked.doc),/12箱 共1200个/);assert.equal(checked.doc.hold,false);
});
test('workorders parsing: original checkmarks remain warnings and never become completed status or quantity confirmation',t=>{
 const h=warehouseApiHarness();t.after(()=>h.sqlite.close());const model=h.load(resolve('lib/workorders/model.ts')),payload={...model.emptyWorkPayload(),sourceText:'√ 已清点\n产品：白色支架\n数量：9箱 每箱120套 一共1080套\n库位：A1\n操作要求：装箱发货',reviewed:false},risk=model.workorderRisks(payload,'general');assert.ok(risk.warnings.some(w=>w.includes('不代表已执行')));assert.equal(payload.reviewed,false);assert.equal(payload.document,null);
});
test('workorders parsing: generated employee body states only real material gaps and omits optional absent business number',t=>{
 const h=warehouseApiHarness();t.after(()=>h.sqlite.close());const model=h.load(resolve('lib/workorders/model.ts')),payload={...model.emptyWorkPayload(),sourceText:'产品：白色支架\n数量：10件\n库位：A1\n操作要求：将10件装箱并标注完成'};
 assert.doesNotMatch(model.generatedEmployeeBody(payload,'general',1),/标签文件|资料补齐|单号：待补充/);payload.sourceText+='\n打印面单并贴标签';assert.match(model.generatedEmployeeBody(payload,'general',0),/员工可下载的标签/);assert.doesNotMatch(model.generatedEmployeeBody(payload,'general',1),/待补充：/);payload.externalMaterialsConfirmed=true;assert.doesNotMatch(model.generatedEmployeeBody(payload,'general',0),/待补充：/);
 const doc=skuDoc();doc.requirements='将货物装箱并保留余货。';doc.extraRequirements='1. 将货物装箱并保留余货。\n清点数量。';payload.document=doc;const generated=model.generatedEmployeeBody(payload,'outbound',1);assert.equal((generated.match(/将货物装箱并保留余货。/g)||[]).length,1);assert.match(generated,/清点数量。/);assert.equal(doc.extraRequirements,'1. 将货物装箱并保留余货。\n清点数量。','rendering leaves original source instructions unchanged');
});

test('workorders rescue: rejecting generated text retains manual body; accepting replaces it',t=>{
 const h=warehouseApiHarness();t.after(()=>h.sqlite.close());const model=h.load(resolve('lib/workorders/model.ts'));
 assert.equal(typeof model.employeeBodyReplacement,'function','body replacement must require an explicit choice for existing text');
 let confirmations=0;
 assert.equal(model.employeeBodyReplacement('人工保留的要求','新正文',()=>{confirmations++;return false;}),null);
 assert.equal(confirmations,1);
 assert.equal(model.employeeBodyReplacement('人工保留的要求','新正文',()=>true),'新正文');
 assert.equal(model.employeeBodyReplacement('','新正文',()=>{throw Error('empty body should not need confirmation');}),'新正文');
 assert.equal(model.employeeBodyReplacement('相同正文','相同正文',()=>{throw Error('identical body should not need confirmation');}),'相同正文');
});

test('workorders rescue: each Excel file retains its own quantity meaning and explicit unknown does not inherit another mode',async t=>{
 const h=warehouseApiHarness();t.after(()=>h.sqlite.close());const readers=h.load(resolve('lib/workorders/readers.ts'));
 const {createRequire}=await import('node:module'),XLSX=createRequire(import.meta.url)('xlsx');
 const workbook=(quantity,name)=>{const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['Outbound/出库单号','Box type No/箱类型号','Outbound Qty/出库箱数','Product Name/产品名称','SKU','Qty/数量'],['OBC678901234','IB556715456RS',4,'测试产品','SKU-A',quantity]]),'出库');return new File([XLSX.write(book,{type:'buffer',bookType:'xlsx'})],name);};
 const parsed=await readers.readWorkorderMaterials([{file:workbook(10,'per.xlsx'),visibility:'source',quantityMode:'perCarton'},{file:workbook(40,'total.xlsx'),visibility:'source',quantityMode:'total'}],'unknown',()=>{});
 assert.equal(parsed.document.rows[0].shipUnits,'40','first file multiplies only its per-carton quantity');
 assert.match(parsed.text,/每箱10个 出货40个/,'second file divides its own total quantity');
 assert.equal(parsed.warnings.length,0,'both meanings are independently known');
 const unknown=await readers.readWorkorderMaterials([{file:workbook(10,'unknown.xlsx'),visibility:'source',quantityMode:'unknown'}],'perCarton',()=>{});
 assert.equal(unknown.document.rows[0].shipUnits,'','explicit unknown cannot silently become 40');
 assert.match(unknown.warnings.join(),/含义待确认/);
});

test('workorders rescue: checked fields affect generation and risks while source conflicts and hold remain visible',t=>{
 const h=warehouseApiHarness();t.after(()=>h.sqlite.close());const model=h.load(resolve('lib/workorders/model.ts'));
 const payload={...model.emptyWorkPayload(),sourceText:'产品：原品\n数量：10件\n库位：A1\n操作要求：清点',draftOverrides:{product:'核对品',sku:'CHECKED-SKU',quantity:'2箱 每箱10件 共20件',location:'B3',fnsku:'X001234567',returnAddress:'地址 QT (NO C)'}};
 assert.match(model.generatedEmployeeBody(payload,'inbound'),/核对品/);
 assert.match(model.generatedEmployeeBody(payload,'inbound'),/CHECKED-SKU/);
 assert.match(model.generatedEmployeeBody(payload,'inbound'),/QT \(NO C\)/);
 payload.draftOverrides.quantity='2箱 每箱10件 共30件';assert.ok(model.workorderRisks(payload,'general').issues.some(v=>v.includes('数量不一致')));
 payload.sourceText+='\n暂不出库';assert.equal(model.workorderRisks(payload,'general').held,true);
 payload.ocrText='产品：其他品';assert.ok(model.workorderRisks(payload,'general').unresolved.length>0);
 assert.equal(payload.sourceText.startsWith('产品：原品'),true,'original source remains intact');
});

test('workorders rescue: regenerated rows retain references by order and SKU/carton identity, not recycled row ID',t=>{
 const h=warehouseApiHarness();t.after(()=>h.sqlite.close());const model=h.load(resolve('lib/workorders/model.ts'));
 assert.equal(typeof model.previousWorkRow,'function','regeneration needs semantic row identity');
 const old={mode:'sku',orderNo:'OBC678901234',sku:'',rows:[{id:'pdf-0',orderNo:'OBC678901234',sku:'SKU-A',inboundNo:'',locations:[{stockId:1}]},{id:'pdf-1',orderNo:'OBC678901234',sku:'SKU-B',inboundNo:'',locations:[{stockId:2}]}]};
 const next={...old,rows:[]};assert.equal(model.previousWorkRow(old,{id:'pdf-0',orderNo:'OBC678901234',sku:'SKU-B',inboundNo:''},next).locations[0].stockId,2);
 assert.equal(model.previousWorkRow(old,{id:'pdf-0',orderNo:'OBC432109876',sku:'SKU-A',inboundNo:''},next),undefined,'different order must not inherit old location');
 assert.equal(model.previousWorkRow(old,{id:'pdf-0',orderNo:'OBC678901234',sku:'SKU-C',inboundNo:''},next),undefined,'different SKU must not inherit old location');
});

test('workorders rescue: preview validates real file bytes and never gives HTML a same-origin render MIME',async t=>{
 const h=warehouseApiHarness();t.after(()=>h.sqlite.close());const readers=h.load(resolve('lib/workorders/readers.ts'));
 assert.equal(typeof readers.safeMaterialPreview,'function','pending files need a safe preview representation');
 const html='<html><script>window.opener && (window.opener.document.body.textContent="owned")</script></html>';
 for(const file of [new File([html],'drop.html',{type:'text/html'}),new File([html],'fake.png',{type:'image/png'}),new File([html],'fake.pdf',{type:'application/pdf'})]){
  const preview=await readers.safeMaterialPreview(file);assert.equal(preview.blob.type,'application/octet-stream');assert.equal(preview.download,true);assert.equal(preview.image,false);assert.equal(await preview.blob.text(),html);
 }
 const png=await readers.safeMaterialPreview(new File([Uint8Array.from([137,80,78,71,13,10,26,10,0])],'image.png',{type:'text/html'}));assert.equal(png.blob.type,'image/png');assert.equal(png.download,false);assert.equal(png.image,true);
 const pdf=await readers.safeMaterialPreview(new File(['%PDF-1.7\nfixture'],'document.pdf',{type:'text/html'}));assert.equal(pdf.blob.type,'application/pdf');assert.equal(pdf.download,false);assert.equal(pdf.image,false);
});

test('workorders rescue: edited operation fields retain material handoff and hold gates',t=>{
 const h=warehouseApiHarness();t.after(()=>h.sqlite.close());const model=h.load(resolve('lib/workorders/model.ts'));
 const payload={...model.emptyWorkPayload(),sourceText:'产品：测试产品\n数量：10件\n库位：A1\n操作要求：清点',draftOverrides:{requirements:'打印面单并贴标签'}};
 assert.ok(model.workorderRisks(payload,'general',0).issues.some(issue=>issue.includes('员工没有可下载附件')),'checked operation requirements need employee materials');
 payload.draftOverrides.requirements='暂不出库，等待面单';assert.equal(model.workorderRisks(payload,'general').held,true,'checked hold requirement must prevent dispatch');
});
