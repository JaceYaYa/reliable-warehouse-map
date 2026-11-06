// Only read numeric cells under identified headers. OCR text order is not a table schema.
const tidy=value=>String(value||'').normalize('NFKC').replace(/\s/g,'');
function wordsFrom(node,out=[]){
 if(!node||typeof node!=='object')return out;
 if(Array.isArray(node)){for(const child of node)wordsFrom(child,out);return out}
 if(Array.isArray(node.words)){for(const word of node.words)if(word?.bbox&&typeof word.text==='string')out.push(word);return out}
 for(const key of ['blocks','paragraphs','lines'])if(Array.isArray(node[key]))wordsFrom(node[key],out);
 return out;
}
function groupLines(words){
 const lines=[];
 for(const word of words.sort((a,b)=>(a.bbox.y0+a.bbox.y1)-(b.bbox.y0+b.bbox.y1)||a.bbox.x0-b.bbox.x0)){
  const box=word.bbox;if(![box.x0,box.x1,box.y0,box.y1].every(Number.isFinite)||box.x1<=box.x0||box.y1<=box.y0)continue;
  const center=(box.y0+box.y1)/2,height=box.y1-box.y0;
  let line=lines.find(line=>Math.abs(line.center-center)<=Math.min(line.height,height)*.45);
  if(!line){line={center,height,words:[]};lines.push(line)}line.words.push(word);
 }
 return lines.map(line=>({...line,words:line.words.sort((a,b)=>a.bbox.x0-b.bbox.x0)}));
}
function headerSpans(line){
 const target={inboundNo:'箱类型号',perCarton:'箱内产品数量',boxes:'出库箱数',shipUnits:'出库产品数'},spans={};
 for(let start=0;start<line.words.length;start++)for(let end=start;end<Math.min(line.words.length,start+8);end++){
  const text=line.words.slice(start,end+1).map(word=>tidy(word.text)).join('');
  for(const [field,label]of Object.entries(target))if(text===label)spans[field]={x0:line.words[start].bbox.x0,x1:line.words[end].bbox.x1};
 }
 return Object.keys(spans).length===4?spans:null;
}
export function parseCartonScreenshot({text='',blocks=[]}={}){
 const lines=groupLines(wordsFrom(blocks)),headers=lines.map(line=>({line,spans:headerSpans(line)})).filter(entry=>entry.spans);
 const warnings=[],rows=[];
 if(headers.length!==1){if(/IB[A-Z0-9-]{6,50}|箱内产品数量|出库箱数/i.test(text))warnings.push('截图箱型明细表的列位置未确认，请核对原图并手动填写件数。');return {rows,warnings}}
 const {line:header,spans}=headers[0],center=field=>(spans[field].x0+spans[field].x1)/2;
 const columns=['perCarton','boxes','shipUnits'];
 if(!(center('inboundNo')<center('perCarton')&&center('perCarton')<center('boxes')&&center('boxes')<center('shipUnits'))){return {rows:[],warnings:['截图箱型明细表的列顺序不明确，请人工核对。']}}
 const width=Math.min(center('boxes')-center('perCarton'),center('shipUnits')-center('boxes'));
 for(const line of lines.filter(line=>line.center>header.center+header.height*.5)){
  const boxWords=line.words.filter(word=>word.bbox.x0<spans.inboundNo.x1+width*.6);
  const joined=boxWords.map(word=>tidy(word.text)).join('').toUpperCase();
  const exact=joined.match(/IB[A-Z0-9-]{6,50}/),suspect=joined.match(/(?:1B|\|B)[A-Z0-9-]{6,50}/);
  const match=exact||suspect;if(!match)continue;
  const raw=joined.replace(/^[^A-Z0-9|]+/,'').replace(/[^A-Z0-9-]+$/,'');
  const suggestion=exact?exact[0]:'IB'+suspect[0].slice(2);
  const ambiguous=raw!==suggestion;
  const row={inboundNo:ambiguous?raw:suggestion,...(ambiguous?{suggestedInboundNo:suggestion,needsConfirmation:true}:{})};let good=true;
  if(ambiguous)warnings.push('截图箱号 '+raw+' 可能识字有误，请对照 PDF 确认 '+suggestion+'。');
  for(let index=0;index<columns.length;index++){
   const field=columns[index],left=index?(center(columns[index-1])+center(field))/2:center(field)-width*.5;
   const right=index<columns.length-1?(center(field)+center(columns[index+1]))/2:center(field)+width*.5;
   const cell=line.words.filter(word=>{const x=(word.bbox.x0+word.bbox.x1)/2;return x>left&&x<right}).map(word=>tidy(word.text)).join('');
   if(!/^\d+$/.test(cell)||!Number.isSafeInteger(Number(cell))||Number(cell)<(field==='shipUnits'?0:1)){good=false;break}
   row[field]=field==='boxes'?Number(cell):cell;
  }
  if(good)rows.push(row);else warnings.push(row.inboundNo+'：截图件数或箱数单元格不明确，未自动填写此行。');
 }
 if(!rows.length&&!warnings.length)warnings.push('截图表头已识别，但没有可确认的完整箱型行。');
 return {rows,warnings};
}
