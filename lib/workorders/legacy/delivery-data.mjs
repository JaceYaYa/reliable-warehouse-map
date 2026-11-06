import {parseSkuDelivery,skuDeliveryBody,deliveryRowLabel} from './sku-delivery.mjs';
// Lingxing's text PDF is parsed by columns. Never interpret Custom Box Barcode as unit quantity.
export function pdfLines(pages){
 return pages.map((page,index)=>{
  const lines=[];
  for(const item of page.items.filter(i=>typeof i.str==='string'&&i.str.trim())){
   const x=item.transform[4],y=item.transform[5];let line=lines.find(l=>Math.abs(l.y-y)<2.6);
   if(!line){line={y,items:[]};lines.push(line)}line.items.push({text:item.str,x,width:item.width||0});
  }
  return {page:index+1,width:page.width,lines:lines.sort((a,b)=>b.y-a.y).map(l=>({...l,items:l.items.sort((a,b)=>a.x-b.x),text:l.items.sort((a,b)=>a.x-b.x).map(i=>i.text).join(' ').trim()}))};
 });
}
const clean=s=>String(s||'').normalize('NFKC').trim();
export const matchKey=s=>clean(s).toUpperCase().replace(/\s/g,'');
const escape=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
export function deliveryOnHold(doc){
 if(doc.hold)return true;
 return [doc.requirements,doc.extraRequirements].filter(Boolean).join('\n').split(/[；;。\n]/).some(clause=>{
  const whole=/(?:整单|本单|此单|全部货物).{0,8}(?:暂不出库|暂停出库|不出库|不发货)/.test(clause);
  if(whole)return true;if(/尾数|余数|剩余|余货|多出来/.test(clause))return false;
  return /(?:暂(?:时)?不|暂停|暂缓|禁止)(?:进行)?(?:出库|发货)|(?:暂无|没有|未收到).{0,6}面单/.test(clause);
 });
}
export function deliveryNeedsLabels(doc,attachments=[]){return /标签|换标|面单|箱唛/.test([doc.requirements,doc.extraRequirements].filter(Boolean).join('\n'))&&!attachments.length}
export function parseDelivery(pages){
 const grouped=pdfLines(pages),text=grouped.map(p=>p.lines.map(l=>l.text).join('\n')).join('\n\n');
 if(/Packing\s*List/i.test(text)&&/By\s*SKU/i.test(text))return parseSkuDelivery(grouped);
 if(!/Packing\s*List/i.test(text)||!/By\s*Carton/i.test(text))throw new Error('这版支持领星 Packing List 按箱工单（By Carton）。此文件格式不同，请保留原文人工核对。');
 const orders=[...new Set(text.match(/\bOBC[A-Z0-9-]{6,40}\b/g)||[])];
 if(orders.length!==1)throw new Error('需要一份只含一个出库单号的领星工单。');
 const value=label=>{for(const p of grouped)for(const l of p.lines){const m=l.text.match(new RegExp('(?:'+label+')\\s*[:：]\\s*(.*)','i'));if(m)return m[1].trim()}return ''};
 const rows=[],warnings=[];let notes=[];
 for(const p of grouped){
  const header=p.lines.findIndex(l=>/Box\s*Type/i.test(l.text)&&/Qty/i.test(l.text));
  if(header<0)continue;
  const h=p.lines[header],columns=h.items;
  const xBox=columns.find(i=>/Box\s*Type/i.test(i.text))?.x;
  const xCustom=columns.find(i=>/Custom/i.test(i.text))?.x;
  const xQty=columns.find(i=>/^Qty$/i.test(i.text.trim()))?.x;
  if([xBox,xCustom,xQty].some(v=>!Number.isFinite(v)))throw new Error('无法识别箱型表格列，请核对原文件，不会把条码列当数量。');
  const edges=[(xBox+xCustom)/2,(xCustom+xQty)/2];
  // The PDF uses centered column headings; data may be wider than its heading.
  for(const l of p.lines.slice(header+1)){
   const ib=l.text.match(/\bIB[A-Z0-9-]{6,50}\b/);
   if(!ib)continue;
   const quantity=l.items.filter(i=>i.x>edges[1]).map(i=>i.text).join('').trim();
   if(!/^\d+$/.test(quantity)||Number(quantity)<1)throw new Error('箱型 '+ib[0]+' 的 Qty 无法确认，请核对 PDF。');
   rows.push({id:'pdf-row-'+rows.length,inboundNo:ib[0],boxes:Number(quantity),perCarton:'',shipUnits:'',remainderAction:'',product:'',sku:'',locations:[],page:p.page});
  }
  const noteIndex=p.lines.findIndex(l=>/^Notes\s*:/i.test(l.text));
  if(noteIndex>=0&&noteIndex<header)notes.push(...p.lines.slice(noteIndex,header).map((l,i)=>i===0?l.text.replace(/^Notes\s*:\s*/i,''):l.text));
 }
 if(!rows.length||rows.length>100)throw new Error('未找到可确认的入库箱型明细，或明细超过100行，请分单处理。');
 const declaredBoxes=Number(value('Total Picks')),declaredTypes=Number(value('Total Box Types'));
 const actual=rows.reduce((n,r)=>n+r.boxes,0);
 if(!Number.isSafeInteger(declaredBoxes)||declaredBoxes!==actual)warnings.push('PDF 总箱数与明细不一致或无法读取：表头 '+(declaredBoxes||'未知')+'，明细 '+actual+'。');
 if(declaredTypes&&declaredTypes!==new Set(rows.map(r=>r.inboundNo)).size)warnings.push('PDF 箱型种数与明细不一致，请核对是否缺页。');
 const requirements=[...new Set(notes)].join('\n').trim();
 const newBarcode=requirements.match(/(?:更换为|替换为|新标签|换标为)\s*([A-Z0-9-]{6,40})/)?.[1]||'';
 return {orderNo:orders[0],customer:value('Client'),outboundType:value('Outbound Type'),destination:value('Destination Type'),declaredBoxes,declaredTypes,requirements,newBarcode,product:'',sku:'',hold:false,rows,warnings,text};
}
export function rankStock(row,stock,document){
 const key=matchKey(row.inboundNo),rawFields=[stock.inboundOrder,stock.product].filter(Boolean),exact=!!key&&rawFields.some(v=>matchKey(v)===key);
 const contains=!!key&&rawFields.some(v=>new RegExp('(?:^|[^A-Z0-9-])'+escape(key)+'(?:$|[^A-Z0-9-])').test(matchKey(v)));
 const base=key.replace(/-C\d+$/,'');
 const family=base!==key&&rawFields.some(v=>matchKey(v).includes(base));
 const sku=matchKey(row.sku||document.sku),skuExact=sku&&matchKey(stock.sku)===sku;
 const name=matchKey(row.product||document.product),nameExact=name&&matchKey(stock.product)===name;
 const nameSimilar=name&&name.length>=4&&(matchKey(stock.product).includes(name)||name.includes(matchKey(stock.product)))&&matchKey(stock.product).length>=4;
 const score=exact?100:contains?90:skuExact?80:family?65:nameExact?60:nameSimilar?40:10;
 const reason=exact?'入库箱号完全一致':contains?'记录含完整箱号':skuExact?'SKU完全一致':family?'同一入库批次，箱型需核对':nameExact?'产品名一致':nameSimilar?'产品名相近':'关键词相关，需人工核对';
 const alerts=[];if(document.customer&&stock.customerName&&matchKey(document.customer)!==matchKey(stock.customerName))alerts.push('客户名称不同：PDF '+document.customer+' / 库位 '+stock.customerName);
 if(Number(stock.totalBoxes)<row.boxes)alerts.push('库存箱数 '+stock.totalBoxes+' 小于本单 '+row.boxes+' 箱');
 if(!exact&&!contains)alerts.push(key?'未按完整箱号匹配，请核对具体批次与箱型':'PDF 未提供入库号，请核对具体入库批次和库位');
 return {stock,score,reason,alerts};
}
export function deliveryIssues(doc){
 const issues=[...(doc.warnings||[])];
 if(doc.mode==='sku'){
  if(!doc.requirements?.trim())issues.push('操作要求待补充');
  for(const row of doc.rows){const label=deliveryRowLabel(row),boxes=Number(row.boxes),per=Number(row.perCarton),ship=Number(row.shipUnits);
   if(!row.locations?.length)issues.push(label+'：库位待确认');
   if(row.locations?.length>1)issues.push(label+'：多个库位，请核对每处取货数量');
   if(row.shipUnits===''||!Number.isSafeInteger(ship)||ship<0)issues.push(label+'：出货件数待核对');
   if(!Number.isSafeInteger(boxes)||boxes<1)issues.push(label+'：箱数待补充，请填写装箱规格');
   if(!Number.isSafeInteger(per)||per<1)issues.push(label+'：每箱件数待补充');
   if(boxes>0&&per>0&&ship!==boxes*per)issues.push(label+'：箱数 × 每箱件数与出货件数不一致，请核对尾箱或装箱数量');
   if(per>0&&ship>0&&ship%per!==0)issues.push(label+'：件数不能按每箱规格整除，请人工核对尾箱');
  }return [...new Set(issues)];
 }
 if(!doc.product.trim())issues.push('产品名称待补充，PDF 未提供');
 if(!doc.requirements.trim())issues.push('操作要求待补充');
 for(const row of doc.rows){
  if(!row.locations?.length)issues.push(row.inboundNo+'：库位待确认');
  if(row.locations?.length>1)issues.push(row.inboundNo+'：多个库位，请在业务中说明每个位置取几箱');
  const per=row.perCarton===''?null:Number(row.perCarton),ship=row.shipUnits===''?null:Number(row.shipUnits);
  if(per===null||ship===null)issues.push(row.inboundNo+'：每箱件数 / 本次出货件数待补充');
  if(per!==null&&(!Number.isSafeInteger(per)||per<1)||ship!==null&&(!Number.isSafeInteger(ship)||ship<0))issues.push(row.inboundNo+'：件数必须为有效整数');
  if(per!==null&&ship!==null){const stock=per*row.boxes;if(ship>stock)issues.push(row.inboundNo+'：出货件数超过所取箱内件数');else if(ship<stock&&!row.remainderAction.trim())issues.push(row.inboundNo+'：剩余 '+(stock-ship)+' 个如何处理待补充')}
 }
 return [...new Set(issues)];
}
export function deliveryBody(doc){
 if(doc.mode==='sku')return skuDeliveryBody(doc,deliveryIssues(doc),deliveryOnHold(doc));
 const locations=doc.rows.filter(r=>r.locations.length).map(r=>r.locations.map(s=>s.locationCode).join(' + ')+`（${r.inboundNo}，本单合计取${r.boxes}箱${r.locations.length>1?'，各库位分配待核对':''}）`);
 const requirements=[doc.requirements,doc.extraRequirements||''].filter(Boolean).join('\n');
 const lines=[deliveryOnHold(doc)?'暂不出库：中转出库':'中转出库','业务：',...requirements.split('\n').filter(Boolean).map((v,i)=>(i+1)+'. '+v),'','产品：'+(doc.product||'待补充'),...(doc.sku?['SKU：'+doc.sku]:[]),'🟦产品位于：'+(locations.join('；')||'待确认'),'🟩入库单号为：'];
 for(const row of doc.rows){let value=row.inboundNo+' '+row.boxes+'箱';
  if(row.perCarton!=='')value+=' 每箱'+row.perCarton+'个 箱内共'+(row.boxes*Number(row.perCarton))+'个';else value+=' 每箱件数待补充';
  if(row.shipUnits!=='')value+=' 本次出货'+row.shipUnits+'个';else value+=' 出货件数待补充';
  if(row.perCarton!==''&&row.shipUnits!==''){const remainder=row.boxes*Number(row.perCarton)-Number(row.shipUnits);if(remainder>0)value+='；余'+remainder+'个：'+(row.remainderAction||'处理方式待补充')}
  lines.push(value);
 }
 const all=doc.rows.every(r=>r.shipUnits!==''&&Number.isSafeInteger(Number(r.shipUnits))&&Number(r.shipUnits)>=0),total=doc.rows.reduce((n,r)=>n+Number(r.shipUnits||0),0);
 lines.push('⬜出库单号为：',doc.orderNo+' '+doc.rows.reduce((n,r)=>n+r.boxes,0)+'箱 '+(all?'共'+total+'个':'总件数待补充'));
 const issues=deliveryIssues(doc);if(issues.length)lines.push('','⚠️待核对：',...issues.map(v=>'- '+v));
 if(doc.rows.some(r=>r.locations.length))lines.push('','库位参考：'+(doc.fetchedAt||'本次查询')+'，仅为查询快照，未预占或扣减库存。');
 return lines.join('\n');
}
