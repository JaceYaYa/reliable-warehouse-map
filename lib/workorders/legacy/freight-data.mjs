const structuredClone = value => JSON.parse(JSON.stringify(value));
import {combineSkuDocuments} from './sku-delivery.mjs';
const text=v=>String(v??'').trim(),key=v=>text(v).replace(/\s/g,'').toLowerCase();
const integer=v=>v!==''&&v!==null&&v!==undefined&&Number.isSafeInteger(Number(v))&&Number(v)>=0?Number(v):null;
const column=(headers,names)=>headers.findIndex(h=>names.some(n=>key(h)===key(n)));
export function parseFreightSheets(sheets,{quantityMode='unknown'}={}){
 const records=[],warnings=[];let ambiguous=false;
 for(const sheet of sheets){
  const headerIndex=sheet.rows.findIndex(row=>column(row,['Outbound/出库单号','出库单号','Outbound'])>=0&&column(row,['Box type No/箱类型号','箱类型号','箱型','Box Type'])>=0);if(headerIndex<0)continue;
  const headers=sheet.rows[headerIndex],cols={order:column(headers,['Outbound/出库单号','出库单号','Outbound']),ib:column(headers,['Box type No/箱类型号','箱类型号','箱型','Box Type']),boxes:column(headers,['Outbound Qty/出库箱数','出库箱数','箱数']),actual:column(headers,['Actual Outbound Qty/实际出库箱数','实际出库箱数']),customer:column(headers,['Client/客户','客户','Client']),sku:column(headers,['SKU']),product:column(headers,['Product Name/产品名称','产品名称','产品','品名']),qty:column(headers,['Qty/数量','数量','Qty']),per:column(headers,['箱内产品数量','每箱数量','每箱件数']),total:column(headers,['出库产品数','总数量','总件数','行总数量'])};
  if(cols.boxes<0)throw new Error('表格缺少出库箱数列，请保留文件并人工填写。');
  for(let n=headerIndex+1;n<sheet.rows.length;n++){
   const source=sheet.rows[n];if(!source.some(v=>text(v)))continue;const orderNo=text(source[cols.order]).toUpperCase(),inboundNo=text(source[cols.ib]).toUpperCase();
   if(!/^OBC[A-Z0-9-]{6,40}$/.test(orderNo)||!/^IB[A-Z0-9-]{6,50}$/.test(inboundNo))throw new Error(sheet.name+' 第'+(n+1)+'行单号或箱型号不完整，请核对。');
   const boxes=integer(source[cols.boxes]);if(!boxes)throw new Error(inboundNo+' 出库箱数需为大于0的整数。');
   let perCarton=cols.per>=0?integer(source[cols.per]):null,shipUnits=cols.total>=0?integer(source[cols.total]):null;
   const rawQuantity=cols.qty>=0?integer(source[cols.qty]):null;
   if(rawQuantity!==null&&perCarton===null&&shipUnits===null){ambiguous=true;if(quantityMode==='perCarton')perCarton=rawQuantity;else if(quantityMode==='total')shipUnits=rawQuantity}
   if(perCarton!==null&&shipUnits===null)shipUnits=perCarton*boxes;
   if(perCarton===null&&shipUnits!==null){if(shipUnits%boxes===0)perCarton=shipUnits/boxes;else warnings.push(inboundNo+'：'+shipUnits+'件 ÷ '+boxes+'箱不能整除，请核对是否混装或有尾箱，不填写统一每箱件数。')}
   if(perCarton!==null&&shipUnits!==null&&perCarton*boxes!==shipUnits)warnings.push(inboundNo+'：每箱件数与本行合计不一致，请核对。');
   records.push({id:'excel-'+records.length,orderNo,inboundNo,boxes,perCarton:perCarton===null?'':String(perCarton),shipUnits:shipUnits===null?'':String(shipUnits),remainderAction:'',locations:[],customer:cols.customer>=0?text(source[cols.customer]):'',sku:cols.sku>=0?text(source[cols.sku]):'',product:cols.product>=0?text(source[cols.product]):'',rawQuantity,actualBoxes:cols.actual>=0?source[cols.actual]:null,sheet:sheet.name,row:n+1});
  }
 }
 if(!records.length)throw new Error('未识别到领星按箱出库数据表，可作为附件保留，或粘贴表内文字。');
 if(records.length>100)throw new Error('一次最多100行箱型，请按工单分开导出。');
 if(new Set(records.map(r=>r.orderNo)).size!==1)throw new Error('表格含多个出库单号，请按单号分别导出。');
 if(new Set(records.map(r=>r.inboundNo)).size!==records.length)throw new Error('同一箱型有多行数据，可能是混装或重复，请核对后按箱型整理。');
 const facts=field=>[...new Set(records.map(r=>r[field]).filter(Boolean))];
 if(facts('sku').length>1)warnings.push('表格含多个 SKU，请逐个箱型核对产品，不能合并为同一产品。');
 if(facts('customer').length>1)throw new Error('同一出库单出现不同客户，请先核对表格。');
 const doc={orderNo:records[0].orderNo,customer:facts('customer')[0]||'',product:facts('product').length===1?facts('product')[0]:'',sku:facts('sku').length===1?facts('sku')[0]:'',newBarcode:'',requirements:'',extraRequirements:'',hold:false,rows:records,warnings,declaredBoxes:records.reduce((n,r)=>n+r.boxes,0),text:records.map(r=>[r.orderNo,r.inboundNo,r.boxes+'箱','SKU '+r.sku,'原数量列 '+(r.rawQuantity??'未填')].join(' · ')).join('\n')};
 return {doc,ambiguous,needsQuantityMode:ambiguous&&!['perCarton','total'].includes(quantityMode),records,warnings};
}
export function combineDocuments(documents){
 if(documents.some(doc=>doc.mode==='sku')){if(documents.some(doc=>doc.mode!=='sku'))throw new Error('按 SKU 和按箱清单请分开整理，避免混淆箱数与件数。');return combineSkuDocuments(documents)}
 if(!documents.length)return {doc:null,text:'',warnings:[]};const base=structuredClone(documents[0]),lines=[],warnings=[];
 for(const [index,doc]of documents.entries()){
  if(doc.orderNo!==base.orderNo)throw new Error('资料含不同出库单号：'+base.orderNo+' / '+doc.orderNo+'。请移除不属于本单的文件。');
  if(doc.rows.some(r=>!base.rows.some(b=>b.inboundNo===r.inboundNo))||base.rows.some(r=>!doc.rows.some(b=>b.inboundNo===r.inboundNo)))throw new Error('PDF 与表格的箱型明细不一致，请核对是否缺行或拿错资料。');
  if(index===0)continue;
  if(doc.product)lines.push('产品：'+doc.product);if(doc.sku)lines.push('SKU：'+doc.sku);
  // Equivalent customer name/code order is only formatting, not a learned alias.
  if(doc.customer&&doc.customer!==base.customer){const parts=s=>text(s).normalize('NFKC').match(/[\p{L}\p{N}]+/gu)?.sort().join('|');if(!base.customer)base.customer=doc.customer;else if(parts(doc.customer)!==parts(base.customer))lines.push('客户：'+doc.customer)}
  for(const row of doc.rows)lines.push(row.inboundNo+' '+row.boxes+'箱'+(row.perCarton!==''?' 每箱'+row.perCarton+'个':'')+(row.shipUnits!==''?' 出货'+row.shipUnits+'个':''));
  if(doc.requirements)lines.push(doc.requirements);warnings.push(...doc.warnings||[]);
 }
 base.warnings=[...new Set([...(base.warnings||[]),...warnings])];return {doc:base,text:lines.join('\n'),warnings};
}
