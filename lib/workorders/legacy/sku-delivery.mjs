const structuredClone = value => JSON.parse(JSON.stringify(value));
// By-SKU PDFs carry units, not cartons. Keep each outbound/SKU identity intact.
const unique=values=>[...new Set(values.filter(v=>v!==''&&v!==undefined&&v!==null))];
const clean=value=>String(value??'').normalize('NFKC').trim();
const codes=text=>unique(clean(text).match(/\bOBC[A-Z0-9-]{6,40}\b/gi)||[]).map(v=>v.toUpperCase());
const count=value=>/^\d+$/.test(clean(value))&&Number.isSafeInteger(Number(value))?Number(value):null;
export const deliveryRowKey=row=>row.orderNo?row.orderNo+'|'+row.sku:row.inboundNo;
export const deliveryRowLabel=row=>row.orderNo?row.orderNo+(row.sku?' · '+row.sku:''):row.inboundNo;
export function parseSkuDelivery(grouped){
 const orders=[],rows=[],warnings=[];
 for(const page of grouped){
  const text=page.lines.map(l=>l.text).join('\n'),ids=codes(text);
  if(!/Packing\s*List/i.test(text)||!/By\s*SKU/i.test(text)||ids.length!==1)throw new Error('按 SKU 清单每页需有一个明确出库单号，请核对 PDF 是否混入其他文件。');
  const value=label=>{for(const line of page.lines){const m=line.text.match(new RegExp(label+'\\s*:\\s*(.*)','i'));if(m)return m[1].trim()}return ''};
  const orderNo=ids[0],header=page.lines.findIndex(l=>/\bSKU\b/.test(l.text)&&/Item\s*Name/.test(l.text)&&/\bQty\b/.test(l.text));
  if(header<0)throw new Error(orderNo+' 第'+page.page+'页缺少 SKU 数量表，请核对。');
  const columns=page.lines[header].items,at=pattern=>columns.find(i=>pattern.test(i.text.trim()))?.x;
  const xs=[at(/^No\.$/),at(/^SKU$/),at(/^Barcode$/),at(/^Item\s*Name$/),at(/^Qty$/)];
  if(xs.some(x=>!Number.isFinite(x)))throw new Error(orderNo+' 的 SKU 表格列无法确认。');
  const edges=xs.slice(1).map((x,i)=>(x+xs[i])/2),pageRows=[];
  for(const line of page.lines.slice(header+1)){
   const cells=xs.map((_,i)=>line.items.filter(item=>{const x=item.x+item.width/2;return x>=(i?edges[i-1]:0)&&x<(i<edges.length?edges[i]:Infinity)}).map(item=>item.text).join('').trim());
   if(!/^\d+$/.test(cells[0]))continue;
   if(!cells[1]||!/^[A-Z0-9][A-Z0-9._-]+$/i.test(cells[1])||!count(cells[4]))throw new Error(orderNo+' 的 SKU 或出货件数无法确认，请核对原文件。');
   pageRows.push({id:orderNo+'|'+cells[1],orderNo,inboundNo:'',sku:cells[1],product:cells[3],boxes:'',perCarton:'',shipUnits:String(count(cells[4])),plannedUnits:count(cells[4]),remainderAction:'',locations:[],page:page.page,lineNo:cells[0]});
  }
  if(!pageRows.length)throw new Error(orderNo+' 没有可读取的产品明细。');
  const start=page.lines.findIndex(l=>/^Notes\s*:/i.test(l.text));
  const requirements=start>=0?page.lines.slice(start,header).map((l,i)=>i===0?l.text.replace(/^Notes\s*:\s*/i,''):l.text).join('\n'):'';
  const declaredUnits=count(value('Total Picks')),declaredSku=count(value('Total SKU')),customer=value('Client');
  let order=orders.find(o=>o.orderNo===orderNo);
  if(!order){order={orderNo,customer,declaredUnits,declaredSku,requirements,destination:value('Destination Type')};orders.push(order)}
  else if(order.declaredUnits!==declaredUnits||order.customer!==customer||order.requirements!==requirements)throw new Error(orderNo+' 的不同页表头不一致，请核对重复或缺页。');
  for(const row of pageRows){if(rows.some(r=>r.id===row.id))throw new Error(orderNo+' 的 SKU 重复出现，请移除重复页或核对明细，不会重复相加。');rows.push(row)}
 }
 if(rows.length>100)throw new Error('按 SKU 明细超过100行，请分批处理。');
 if(unique(orders.map(o=>o.customer)).length>1)throw new Error('PDF 含不同客户的出库单，请按客户分开整理。');
 if(unique(orders.map(o=>o.requirements)).length>1)throw new Error('这些出库单的 PDF 操作要求不同，请按相同要求分批整理，避免把某单要求应用到所有单。');
 for(const order of orders){const items=rows.filter(r=>r.orderNo===order.orderNo),sum=items.reduce((n,r)=>n+r.plannedUnits,0);if(sum!==order.declaredUnits||items.length!==order.declaredSku)warnings.push(order.orderNo+'：表头总件数 / SKU 种数与明细不一致，请核对是否缺页。')}
 const products=unique(rows.map(r=>r.product)),skus=unique(rows.map(r=>r.sku)),requirements=unique(orders.map(o=>o.requirements)).join('\n');
 return {mode:'sku',orderNo:orders.map(o=>o.orderNo).join('、'),orders,rows,customer:orders[0].customer,product:products.length===1?products[0]:'',sku:skus.length===1?skus[0]:'',requirements,newBarcode:requirements.match(/(?:更换为|替换为)\s*([A-Z0-9-]{6,40})/)?.[1]||'',hold:false,warnings,text:grouped.map(p=>p.lines.map(l=>l.text).join('\n')).join('\n\n')};
}
export function combineSkuDocuments(documents){
 const base=structuredClone(documents[0]);
 for(const doc of documents.slice(1)){
  if(doc.mode!=='sku')throw new Error('按 SKU 和按箱清单请分开整理，避免把件数当箱数。');
  if(doc.customer!==base.customer)throw new Error('不同客户的清单请分开整理。');
  if(doc.requirements!==base.requirements)throw new Error('不同 PDF 的操作要求不同，请按相同要求分批整理。');
  for(const order of doc.orders){const existing=base.orders.find(o=>o.orderNo===order.orderNo),items=doc.rows.filter(r=>r.orderNo===order.orderNo);
   if(existing){const stable=rows=>JSON.stringify(rows.map(r=>[r.sku,r.shipUnits,r.product]).sort());if(stable(base.rows.filter(r=>r.orderNo===order.orderNo))!==stable(items)||existing.requirements!==order.requirements)throw new Error(order.orderNo+' 在不同 PDF 中内容不一致，请核对。');base.warnings.push(order.orderNo+' 重复清单已按同一单计数一次。');continue}
   base.orders.push(structuredClone(order));base.rows.push(...structuredClone(items));
  }
  base.warnings.push(...doc.warnings);base.text+='\n\n'+doc.text;
 }
 base.orderNo=base.orders.map(o=>o.orderNo).join('、');base.requirements=unique(base.orders.map(o=>o.requirements)).join('\n');
 const skus=unique(base.rows.map(r=>r.sku)),products=unique(base.rows.map(r=>r.product));base.sku=skus.length===1?skus[0]:'';base.product=products.length===1?products[0]:'';
 if(base.rows.length>100)throw new Error('整批明细超过100行，请分批处理。');
 return {doc:base,text:'',warnings:base.warnings};
}
export function applyPacking(doc,per){
 const n=count(per);if(!n||n>10000000)throw new Error('每箱件数请填写大于0的整数。');
 for(const row of doc.rows){row.perCarton=String(n);const ship=count(row.shipUnits);row.boxes=ship!==null&&ship>0&&ship%n===0?ship/n:'';row.quantityConfirmation=null}
}
export function mergeSkuSources({doc,sources,resolutions}){
 const conflicts=[],warnings=[...doc.warnings],values=new Map(),allowed=new Set(doc.orders.map(o=>o.orderNo)),active=[];
 const hard=(id,label)=>conflicts.push({id,label,options:[],resolved:false});
 const add=(id,value,label)=>{if(clean(value)==='')return;const list=values.get(id)||[];list.push({value:clean(value),label});values.set(id,list)};
 const choose=(id,label,fallback='')=>{const list=values.get(id)||[],options=unique(list.map(x=>x.value)).map(value=>({value,label:list.filter(x=>x.value===value).map(x=>x.label).join(' / ')+'：'+value}));if(!options.length)return fallback;if(options.length===1)return options[0].value;const selected=Number.isInteger(resolutions[id])?options[resolutions[id]]:options.find(o=>o.value===resolutions[id]);conflicts.push({id,label,options,resolved:!!selected});return selected?.value??fallback};
 for(const row of doc.rows)add('row:'+row.id+':shipUnits',row.shipUnits,'领星 PDF');
 for(const order of doc.orders)for(const m of order.requirements.matchAll(/(?:更换为|替换为)\s*([A-Z0-9-]{6,40})/g))add('field:newBarcode',m[1],order.orderNo);
 for(const source of sources){
  const ids=codes(source.raw),outside=ids.filter(id=>!allowed.has(id));
  if(outside.length){hard('source:'+source.id+':orderNo',source.label+'含本批 PDF 之外的出库单 '+outside.join('、')+'，请补齐清单或修正来源。');continue}
  if(ids.length&&ids.length<allowed.size&&(/需要|更换|贴|装箱|暂不|不得|禁止|拍照|检查/.test(source.draft.requirements)||source.allBarcodes.length)){hard('source:'+source.id+':scope',source.label+'的操作要求只关联了部分出库单，请分批整理或明确整批适用后补齐单号。');continue}
  if(/\bIB[A-Z0-9-]{6,50}\b/i.test(source.raw)){hard('source:'+source.id+':inboundNo',source.label+'含入库箱号，按 SKU PDF 没有入库箱号可供对应，请在库位核对后填写。');continue}
  if(source.draft.sku&&!doc.rows.some(r=>r.sku===source.draft.sku)){hard('source:'+source.id+':sku',source.label+'的 SKU 与 PDF 明细不同，请核对。');continue}
  active.push(source);
  for(const field of ['product','customer','newBarcode'])if(field!=='newBarcode')add('field:'+field,source.draft[field],source.label);
  for(const barcode of source.allBarcodes)add('field:newBarcode',barcode,source.label);
  for(const line of source.raw.split('\n')){
   const ids=codes(line),per=line.match(/每\s*箱\s*(\d+)\s*(?:个|件|套|台)/)?.[1]||line.match(/(\d+)\s*(?:个|件|套|台)\s*[/／]\s*箱/)?.[1];
   if(per&&!ids.length)add('packing:perCarton',per,source.label);
   if(ids.length===1){const candidates=doc.rows.filter(r=>r.orderNo===ids[0]);if(candidates.length!==1){if(/\d+\s*(?:个|件|箱)/.test(line))hard('source:'+source.id+':row',ids[0]+' 有多个 SKU，请在明细中逐项填写数量。');continue}
    const row=candidates[0],tail=line.slice(line.indexOf(ids[0])+ids[0].length),boxes=tail.match(/(?:^|[\s：:])(\d+)\s*箱/)?.[1],ship=tail.match(/(?:共|合计|出货)\s*(\d+)\s*(?:个|件|套|台)/)?.[1]||tail.match(/^\s*(\d+)\s*(?:个|件|套|台)/)?.[1];
    if(per)add('row:'+row.id+':perCarton',per,source.label);if(boxes)add('row:'+row.id+':boxes',boxes,source.label);if(ship)add('row:'+row.id+':shipUnits',ship,source.label);
   }
  }
 }
 const globalPer=choose('packing:perCarton','本批每箱件数');
 for(const row of doc.rows){row.shipUnits=choose('row:'+row.id+':shipUnits',row.orderNo+' 出货件数');row.perCarton=choose('row:'+row.id+':perCarton',row.orderNo+' 每箱件数',globalPer);row.boxes=choose('row:'+row.id+':boxes',row.orderNo+' 箱数');const per=count(row.perCarton),ship=count(row.shipUnits);if(!row.boxes&&per&&ship&&ship%per===0)row.boxes=ship/per}
 const total=doc.rows.reduce((n,r)=>n+Number(r.shipUnits||0),0);
 for(const source of active){const match=source.raw.match(/(?:^|\n)\s*(?:数量|总数量|合计|总共|总计)\s*[：:]?\s*(\d+)\s*(?:个|件|套|台)/);if(!match)continue;const ids=codes(source.raw),selected=ids.length?doc.rows.filter(r=>ids.includes(r.orderNo)):doc.rows,expected=selected.reduce((n,r)=>n+Number(r.shipUnits||0),0);if(selected.every(r=>r.shipUnits!=='')&&Number(match[1])!==expected)hard('source:'+source.id+':total',source.label+'总件数 '+match[1]+' 与对应出库单合计 '+expected+' 不一致，请核对数量归属。')}
 add('field:customer',doc.customer,'领星 PDF');
 const draft={...sources[0]?.draft,type:'transfer',orderNo:doc.orderNo,inboundNo:'',quantity:'',location:'',customer:choose('field:customer','客户',doc.customer),sku:doc.sku,product:choose('field:product','产品显示名称',doc.product),newBarcode:choose('field:newBarcode','新产品条码'),requirements:'',hold:doc.hold};
 if(!doc.sku&&draft.product){hard('sources:product-scope','PDF 含多个 SKU，消息中的产品名不能应用到所有明细，请按产品分批整理。');draft.product=''}
 if(draft.product!==doc.product&&doc.product)warnings.push('产品显示名称采用消息；PDF 原名称：'+doc.product+'。请核对为同款，库位仍按 SKU 查询。');
 const instructions=active.flatMap(s=>s.raw.split('\n')).map(line=>line.replace(/[@＠]\S+(?:\s+海外仓\s*-\s*[\w-]+)?/g,'').trim()).filter(line=>/需要|换|贴|装箱|包装|不区分|不得|禁止|暂不|等待|放行|拍照|清点|检查|注意|弃置|发货|发FBA|发\s+FBA/.test(line)&&!codes(line).length&&!/^数量\s*[:：]/.test(line));
 const requirements=unique([doc.requirements,...instructions].flatMap(s=>String(s).split('\n')));
 const candidates=unique((values.get('field:newBarcode')||[]).map(x=>x.value));
 draft.requirements=requirements.map(line=>{if(candidates.length>1){if(!draft.newBarcode&&candidates.some(c=>line.includes(c)))return '';for(const code of candidates)line=line.replaceAll(code,draft.newBarcode)}return line}).filter(Boolean).join('\n');
 draft.title=('备货中转出库 · '+(draft.product||doc.orders.length+'个出库单')).slice(0,160);
 Object.assign(doc,{product:draft.product,customer:draft.customer,newBarcode:draft.newBarcode,requirements:draft.requirements,extraRequirements:''});
 warnings.push('本批 '+doc.orders.length+' 个出库单，'+total+' 件；按 SKU 清单未提供箱数和入库号，装箱规格需补充，库位按 SKU / 产品查询后确认。');
 draft.warnings=unique(warnings);return {doc,draft,conflicts,warnings:unique(warnings)};
}
export function skuDeliveryBody(doc,issues,onHold){
 const lines=[onHold?'暂不出库：中转出库':'中转出库','业务：',...[doc.requirements,doc.extraRequirements].filter(Boolean).join('\n').split('\n').filter(Boolean).map((v,i)=>(i+1)+'. '+v),'','产品：'+(doc.product||'按下方 SKU 明细'),...(doc.sku?['SKU：'+doc.sku]:[])];
 const locations=unique(doc.rows.flatMap(r=>(r.locations||[]).map(s=>s.locationCode))),inbound=unique(doc.rows.flatMap(r=>(r.locations||[]).map(s=>s.inboundOrder)).filter(v=>/^IB[A-Z0-9-]+$/i.test(v||'')));
 lines.push('🟦产品位于：'+(locations.join(' + ')||'待确认'),'🟩入库单号为：'+(inbound.join('、')||'待库位核对（本 PDF 未提供）'),'⬜出库单号为：');
 for(const row of doc.rows){const boxes=count(row.boxes),per=count(row.perCarton),ship=count(row.shipUnits);lines.push(row.orderNo+(doc.sku?'':' · '+row.sku+' · '+row.product)+' '+(boxes?boxes+'箱 ':'箱数待补充 ')+(per?per+'个/箱 ':'')+(ship!==null?'共'+ship+'个':'件数待核对')+(row.locations.length?'；位于 '+row.locations.map(s=>s.locationCode).join(' + '):''))}
 const allUnits=doc.rows.every(r=>count(r.shipUnits)!==null),allBoxes=doc.rows.every(r=>count(r.boxes)>0);lines.push('总共'+(allUnits?doc.rows.reduce((n,r)=>n+Number(r.shipUnits),0)+'个':'件数待核对')+(allBoxes?'，'+doc.rows.reduce((n,r)=>n+Number(r.boxes),0)+'箱':''));
 if(issues.length)lines.push('','⚠️待核对：',...compactSkuIssues(doc,issues).map(v=>'- '+v));return lines.join('\n');
}
export function compactSkuIssues(doc,issues){
 const groups=new Map();
 for(const issue of issues){const row=doc.rows.find(r=>issue.startsWith(deliveryRowLabel(r)+'：')||issue.startsWith(r.orderNo+'：')),message=row?issue.slice(issue.indexOf('：')+1):issue;const list=groups.get(message)||[];if(row)list.push(row.orderNo);groups.set(message,list)}
 return [...groups].map(([message,ids])=>ids.length?(unique(ids).length===doc.orders.length?'本批各单':unique(ids).join('、'))+'：'+message:message);
}
