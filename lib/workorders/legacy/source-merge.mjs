const structuredClone = value => JSON.parse(JSON.stringify(value));
import {extractDraft,DRAFT_FIELDS,TYPE_LABELS} from './task-draft.mjs';
import {deliveryOnHold} from './delivery-data.mjs';
import {mergeSkuSources} from './sku-delivery.mjs';
export {parseCartonScreenshot} from './carton-screenshot.mjs';

const unique=values=>[...new Set(values.filter(value=>value!==''&&value!==undefined&&value!==null))];
const clean=value=>String(value??'').trim();
const norm=value=>clean(value).normalize('NFKC');
const codes=(text,prefix)=>unique((norm(text).match(new RegExp('\\b'+prefix+'[A-Z0-9-]{6,50}\\b','gi'))||[]).map(value=>value.toUpperCase()));
const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const labels={orderNo:'出库单号',inboundNo:'入库单号',customer:'客户',product:'产品',sku:'SKU',fnsku:'FNSKU',quantity:'数量',location:'库位',returnAddress:'退货地址',newBarcode:'新产品条码',transparentBarcode:'透明标签码',labelGap:'标签间距',boxes:'箱数',perCarton:'每箱件数',shipUnits:'本次出货件数',remainderAction:'余货处理'};
const barcodePattern=/(?:新(?:产品)?标签|(?:产品)?标签[^\n；;。]{0,15}?(?:更换为|替换为|换成)|(?:更换为|替换为|换标为)|(?:贴|换|更换)\s*新?\s*(?:产品)?条(?:形(?:码)?|码))\s*[：:]?\s*([A-Z0-9][A-Z0-9-]{5,40})/gi;
function sourceDraft(raw,type){
 const draft=extractDraft(raw,type),text=norm(raw);
 const allBarcodes=unique([...text.matchAll(barcodePattern)].map(match=>match[1]));
 if(draft.newBarcode&&!allBarcodes.includes(draft.newBarcode))allBarcodes.unshift(draft.newBarcode);
 // extractDraft has a broad hold detector. Re-evaluate the original message before retaining its synthetic hold line.
 if(!deliveryOnHold({requirements:raw})){draft.hold=false;if(draft.requirements.startsWith('暂不出库。\n'))draft.requirements=draft.requirements.slice(6)}
 return {draft,allBarcodes};
}
function rowFacts(raw){
 const facts=[];
 for(const line of clean(raw).split(/\r?\n/)){
  const inbound=codes(line,'IB');if(inbound.length!==1)continue;
  const tail=line.slice(line.toUpperCase().indexOf(inbound[0])+inbound[0].length),fact={inboundNo:inbound[0]};
  const boxes=tail.match(/(?:出库箱数|取箱数)\s*[：:]?\s*(\d+)/)?.[1]||tail.match(/^\s*[：:]?\s*(\d+)\s*箱/)?.[1];
  const per=tail.match(/(?:每箱|箱内产品数量)\s*[：:]?\s*(\d+)\s*(?:个|件|套|台|pcs)?/i)?.[1]||tail.match(/(?:1|一)箱\s*(?:里面有|内有|箱内有?)\s*(\d+)\s*(?:个|件|套|台|pcs)/i)?.[1];
  const ship=tail.match(/(?:本次出货(?:件数)?|出货产品数|出库产品数|出货|出库|实发)\s*[：:]?\s*(\d+)\s*(?:个|件|套|台|pcs)/i)?.[1]||tail.match(/(?:合计|共)\s*[：:]?\s*(\d+)\s*(?:个|件|套|台|pcs)?/i)?.[1];
  const remainder=tail.match(/(?:尾数|余数|剩余|余货|多出来的?(?:尾数)?|(?:需要)?拿出)\s*(?:的)?\s*\d+\s*(?:个|件|套|台|pcs)\s*([^\n]+)/i)?.[1];
  if(boxes!==undefined)fact.boxes=boxes;if(per!==undefined)fact.perCarton=per;if(ship!==undefined)fact.shipUnits=ship;if(remainder)fact.remainderAction=remainder.trim().replace(/^[：:，,；;]\s*/,'');
  facts.push(fact);
 }
 return facts;
}

/** Pure, stateless merge: PDF rows anchor carton identities; source conflicts must be resolved explicitly. */
export function mergeSources({pdf=null,text='',ocr='',type='auto',resolutions={},screenshotRows=[],ocrSources=null}={}){
 const doc=pdf?structuredClone(pdf):null,conflicts=[],warnings=[...(doc?.warnings||[])],values=new Map();
 const input=[['text','文字补充',String(text||'')],...(ocrSources?ocrSources.map((raw,i)=>['ocr:'+i,'截图 '+(i+1)+' 识字',String(raw||'')]):[['ocr','截图识字',String(ocr||'')]])].filter(([, ,raw])=>raw.trim());
 const sources=input.map(([id,label,raw])=>({id,label,raw,...sourceDraft(raw,doc?'transfer':type)}));
 if(doc?.mode==='sku'){const result=mergeSkuSources({doc,sources,resolutions});result.doc.hold=deliveryOnHold({hold:doc.hold,requirements:result.draft.requirements});result.draft.hold=result.doc.hold;return result}
 const add=(id,value,label)=>{if(value===undefined||value===null||clean(value)==='')return;const list=values.get(id)||[];list.push({value:clean(value),label});values.set(id,list)};
 const choose=(id,label,{fixed=false}={})=>{
  const list=values.get(id)||[],distinct=unique(list.map(entry=>entry.value));if(!distinct.length)return '';if(distinct.length===1)return distinct[0];
  const options=distinct.map(value=>({value,label:list.filter(entry=>entry.value===value).map(entry=>entry.label).join(' / ')+'：'+value}));
  const supplied=resolutions[id],selected=Number.isInteger(supplied)?options[supplied]:options.find(option=>option.value===supplied);
  const resolved=!!selected;conflicts.push({id,label,options,resolved});return resolved?selected.value:fixed?list[0].value:'';
 };
 const hard=(id,label)=>{if(!conflicts.some(conflict=>conflict.id===id))conflicts.push({id,label,options:[],resolved:false})};
 if(doc){
  const keys=doc.rows.map(row=>row.inboundNo.toUpperCase());
  if(new Set(keys).size!==keys.length)hard('pdf:duplicate-inbound','PDF 含重复入库箱型，请核对原文件；不会相加数量。');
  for(const key of ['orderNo','customer','product','sku','newBarcode'])add('field:'+key,doc[key],'领星 PDF');
  for(const row of doc.rows)for(const key of ['boxes','perCarton','shipUnits','remainderAction'])add('row:'+row.inboundNo+':'+key,row[key],'领星 PDF');
 }
 const active=[],allOrders=unique(sources.flatMap(source=>codes(source.raw,'OBC')));
 if(!doc&&allOrders.length>1)hard('sources:orderNo','文字与截图中有不同的出库单号，请更正或移除不属于本单的来源。');
 for(const source of sources){
  const orders=codes(source.raw,'OBC'),inbound=codes(source.raw,'IB');let valid=true;
  if(doc&&orders.some(order=>order!==doc.orderNo.toUpperCase())){hard('source:'+source.id+':orderNo',source.label+'中的出库单号与 PDF 不同，请更正或移除这份来源。');valid=false}
  if(doc&&inbound.some(code=>!doc.rows.some(row=>row.inboundNo.toUpperCase()===code))){hard('source:'+source.id+':inboundNo',source.label+'出现 PDF 之外的入库箱型，请更正或移除这份来源。');valid=false}
  if(!doc&&allOrders.length>1&&orders.length){valid=false}
  if(!valid)continue;
  active.push(source);warnings.push(...source.draft.warnings);
  for(const key of DRAFT_FIELDS){if(['title','requirements','newBarcode'].includes(key)||doc&&['inboundNo','quantity'].includes(key))continue;add('field:'+key,source.draft[key],source.label)}
  for(const barcode of source.allBarcodes)add('field:newBarcode',barcode,source.label);
  if(doc)for(const fact of rowFacts(source.raw))for(const key of ['boxes','perCarton','shipUnits','remainderAction'])add('row:'+fact.inboundNo+':'+key,fact[key],source.label);
 }
 // OCR table rows belong to the screenshot source. An unrelated screenshot cannot supplement this PDF.
 if(doc)for(const [index,row]of screenshotRows.entries()){
  const sourceId=row.sourceId||'ocr';if(sources.some(source=>source.id===sourceId)&&!active.some(source=>source.id===sourceId))continue;
  let inbound=clean(row.inboundNo).toUpperCase();const label=row.source||'截图箱型明细';
  if(row.needsConfirmation){
   const suggested=clean(row.suggestedInboundNo).toUpperCase(),id='screenshot-row:'+index+':confirm-inbound';
   if(doc.rows.some(anchor=>anchor.inboundNo.toUpperCase()===suggested)){
    const options=[{value:suggested,label:'确认对应 PDF 箱号：'+suggested}],resolved=resolutions[id]===suggested||resolutions[id]===0;
    conflicts.push({id,label:label+'箱号识字待确认：'+inbound,options,resolved});if(!resolved)continue;inbound=suggested;
   }
  }
  if(!doc.rows.some(anchor=>anchor.inboundNo.toUpperCase()===inbound)){hard('screenshot-row:'+index+':inboundNo',label+'出现 PDF 之外的入库箱型 '+inbound+'，请核对原图。');continue}
  for(const key of ['boxes','perCarton','shipUnits'])if(row[key]!==''&&row[key]!==undefined){
   if(!/^\d+$/.test(String(row[key]))||!Number.isSafeInteger(Number(row[key]))||Number(row[key])<(key==='shipUnits'?0:1))hard('screenshot-row:'+index+':'+key,label+'的'+(labels[key]||key)+'不是有效整数，请核对原图。');
   else add('row:'+inbound+':'+key,row[key],label);
  }
 }
 const effectiveType=doc?'transfer':type!=='auto'&&TYPE_LABELS[type]?type:active.find(source=>source.draft.type!=='general')?.draft.type||'general';
 const draft=Object.fromEntries(DRAFT_FIELDS.map(key=>[key,'']));draft.type=effectiveType;
 for(const key of DRAFT_FIELDS)if(!['title','requirements','inboundNo','quantity'].includes(key)||!doc&&['inboundNo','quantity'].includes(key))draft[key]=choose('field:'+key,labels[key]||key);
 // Remove superseded label codes from executable instructions; immutable raw sources remain with the caller.
 const labelFields=['newBarcode','transparentBarcode'],allLabelCodes=unique(labelFields.flatMap(key=>(values.get('field:'+key)||[]).map(entry=>entry.value)));
 const instructions=raw=>String(raw||'').split(/\r?\n/).filter(line=>!doc||!codes(line,'IB').length).map(line=>{
  let value=line;
  for(const key of labelFields){const candidates=unique((values.get('field:'+key)||[]).map(entry=>entry.value));if(candidates.length<2)continue;
   if(!draft[key]&&candidates.some(code=>value.includes(code)))return '';
   for(const code of candidates)if(code!==draft[key])value=value.replace(new RegExp('(?<![A-Z0-9-])'+escape(code)+'(?![A-Z0-9-])','g'),draft[key]);
  }
  return value.trim();
 }).filter(Boolean);
 const tableNoise=line=>/箱类型号|自定义箱条码|包[裹衷]跟踪号|关联托盘号|箱内产品数量|出库箱数|出库产品数|尺寸\s*\(?|重量\s*\(/.test(line)||/产品明细.*托盘明细|箱类型明细.*换标服务|[I1|]B[A-Z0-9-]{6,50}/i.test(line)||/^(?:产品明细|箱型明细|箱类型明细|托盘明细|操作|查看|编辑|删除)(?:\s*\d+)?$/.test(line.trim())||/^[\s\d.*x×\-\/|]*(?:in|lb|cm|kg)?[\s\d.*x×\-\/|]*$/i.test(line.trim());
 const supplemental=unique(active.flatMap(source=>instructions(source.draft.requirements).filter(line=>!(source.id.startsWith('ocr')&&screenshotRows.length&&tableNoise(line.replace(/\s/g,''))))));
 if(doc){
  doc.requirements=unique(instructions(doc.requirements)).join('\n');doc.extraRequirements=supplemental.filter(line=>!doc.requirements.split('\n').includes(line)).join('\n');
  for(const key of ['orderNo','customer','product','sku','newBarcode'])doc[key]=draft[key];
  for(const row of doc.rows)for(const key of ['boxes','perCarton','shipUnits','remainderAction']){const value=choose('row:'+row.inboundNo+':'+key,row.inboundNo+' '+labels[key],{fixed:key==='boxes'});row[key]=key==='boxes'?Number(value):value}
  draft.inboundNo=doc.rows.map(row=>row.inboundNo).join('、');draft.quantity='';draft.requirements=[doc.requirements,doc.extraRequirements].filter(Boolean).join('\n');
  doc.hold=deliveryOnHold({hold:!!pdf.hold,requirements:pdf.requirements,extraRequirements:active.map(source=>source.raw).join('\n')});draft.hold=doc.hold;
 }else{draft.requirements=supplemental.join('\n');draft.hold=deliveryOnHold({requirements:active.map(source=>source.raw).join('\n')})}
 draft.title=(TYPE_LABELS[effectiveType]+(draft.product?' · '+draft.product:draft.orderNo?' · '+draft.orderNo:'')).slice(0,160);
 if(allLabelCodes.length&&!draft.newBarcode&&!draft.transparentBarcode&&conflicts.some(conflict=>labelFields.some(field=>conflict.id==='field:'+field)&&!conflict.resolved))warnings.push('标签码存在冲突，选择本次使用的标签后再下达。');
 draft.warnings=unique(warnings);return {draft,doc,conflicts,warnings:unique(warnings)};
}
