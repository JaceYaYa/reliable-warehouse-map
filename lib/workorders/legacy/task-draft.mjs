// Parse current task facts; preserve uncertain OCR and explicit restrictions.
export const DRAFT_FIELDS=['title','orderNo','inboundNo','customer','product','sku','fnsku','quantity','location','returnAddress','newBarcode','transparentBarcode','labelGap','requirements'];
export const TYPE_LABELS={general:'通用工单',transfer:'备货中转出库',returns:'退货清点 / 入库'};
export function normalizeOcr(text){return String(text).replace(/([\u3400-\u9fff])[^\S\r\n]+(?=[\u3400-\u9fff])/g,'$1').trim()}
const valueAfter=(text,names)=>{
 const re=new RegExp('(?:'+names+')\\s*(?:为|是)?\\s*[：:]\\s*(.*)','i');
 for(const line of text.split(/\r?\n/)){const m=line.match(re);if(m&&m.index<=6&&m[1].trim())return m[1].trim()}return '';
};
const code=text=>String(text||'').replace(/\s+/g,'').replace(/[;；，,。]+$/,'');
const unique=values=>[...new Set(values.filter(Boolean))];
const stripNumber=line=>line.replace(/^(?:业务|操作要求|清点要求)\s*[：:]\s*/,'').replace(/^\d+\s*[.．、]\s*/,'').trim();
const HOLD=/(?:暂(?:时)?不|禁止|不要|不得|勿|不能|暂缓|不)(?:进行)?(?:出库|发货|发出)|(?:没有|暂无|未收到|等|待).{0,12}面单/;
const PLACEHOLDER=/\{\{[^{}]+\}\}|【[^】]*待(?:补充|替换)[^】]*】/;
function quantityText(text){
 const parts=[];
 for(const line of text.split(/\r?\n/)){
  if(/(?:位于|库位|货位|位置)/.test(line)||/\.pdf\b/i.test(line))continue;
  const named=line.match(/^(?:[🟦🟩⬜\s]*)(?:数量|总数量|合计|共|总计)\s*[：:=＝]?\s*(.*)$/u);
  if(named&&/\d\s*(?:箱|个|套|件|台)/.test(named[1]))parts.push(named[1].trim());
  else if(/^\s*OBC[A-Z0-9-]+\s+/i.test(line)){const tail=line.replace(/^\s*OBC[A-Z0-9-]+\s+/i,'').trim();if(/\d\s*(?:箱|个|套|件|台)/.test(tail))parts.push(tail)}
  else if(/^\s*(?:每\s*箱\s*\d|\d+\s*(?:个|套|件|台)\s*[/／]\s*箱)/.test(line))parts.push(line.trim());
 }
 const distinct=unique(parts);
 return distinct.filter((p,i)=>!distinct.some((other,j)=>j!==i&&other.length>p.length&&p.match(/\d+\s*(?:箱|个|套|件|台)/g)?.every(v=>(other.match(/\d+\s*(?:箱|个|套|件|台)/g)||[]).map(x=>x.replace(/\s/g,'')).includes(v.replace(/\s/g,''))))).join('；');
}
export function quantityAudit(quantity){
 const text=String(quantity||''),boxes=unique([...text.matchAll(/(\d+(?:\.\d+)?)\s*箱/g)].map(m=>m[1]));
 const pm=[...text.matchAll(/每\s*箱\s*(\d+(?:\.\d+)?)\s*(个|套|件|台)|(?:^|[^\d.])(\d+(?:\.\d+)?)\s*(个|套|件|台)\s*[/／]\s*箱/g)];
 const per=unique(pm.map(m=>m[1]||m[3]));
 const tm=[...text.matchAll(/(\d+(?:\.\d+)?)\s*(个|套|件|台)/g)].filter(m=>!pm.some(p=>m.index>=p.index&&m.index<p.index+p[0].length));
 const totals=unique(tm.map(m=>m[1])),issues=[],unit=tm[0]?.[2]||pm[0]?.[2]||pm[0]?.[4]||'个';
 if(boxes.length>1||per.length>1||totals.length>1)issues.push('数量有多组不同数值，请核对是否属于同一批产品。');
 if(boxes.length===1&&per.length===1&&totals.length===1){const expected=Number(boxes[0])*Number(per[0]);if(Math.abs(expected-Number(totals[0]))>0.000001)issues.push('数量不一致：'+boxes[0]+'箱 × '+per[0]+unit+'/箱 = '+expected+unit+'，与填写的'+totals[0]+unit+'不符。请核对原始数据。')}
 return {boxes:boxes[0]||'',perCarton:per[0]||'',total:totals[0]||'',issues};
}
export function extractDraft(source,requestedType='auto'){
 const text=String(source||'').trim(),orders=unique(text.match(/\bOBC[A-Z0-9-]{6,40}\b/gi)||[]);
 const detected=/中转出库|备货中转/.test(text)?'transfer':/退货|退件/.test(text)?'returns':'general';
 const type=requestedType==='auto'?detected:TYPE_LABELS[requestedType]?requestedType:'general';
 let original=text.replace(/[@＠][\w\u3400-\u9fff-]+/g,'').trim();
 const orderStart=original.search(/(?:出库单号|出库单|订单号|单号)\s*[：:；;]?\s*OBC/i);
 if(/^\d{1,2}[:：]\d{2}\s*\n/.test(original)&&orderStart>0)original=original.slice(orderStart);
 const product=valueAfter(text,'产品名称|产品|品名').replace(/\s*(?:数量|库位)\s*[：:].*$/,'').trim();
 const location=valueAfter(text,'产品位于|产品位置|库位|货位|位置|位于')||text.match(/(?:位于|放在|放到)\s*([A-Z]\d+(?:[-－]\d+)?\s*(?:[一二三四五六七八九十\d]+\s*层)?(?:\s*\+\s*[A-Z]\d+\s*[一二三四五六七八九十\d]+\s*层)?)/i)?.[1]||'';
 const inboundNo=code(valueAfter(text,'入库单号|入库单')||text.match(/\bIB[A-Z0-9-]{6,40}\b/i)?.[0]||'');
 const label=valueAfter(text,'新产品条码|新条码|新条形码|新条形|新\\s*FNSKU')||text.match(/(?:贴|换|更换)\s*新?\s*(?:产品)?条(?:形(?:码)?|码)\s*[：:]?\s*([A-Z0-9][A-Z0-9-]{5,40})/i)?.[1]||'';
 const transparent=valueAfter(text,'新透明标签|透明标签码')||text.match(/(?:贴|换|更换)\s*新?透明标签\s*[：:]?\s*(\d{6,30})/)?.[1]||'';
 const labelGap=valueAfter(text,'标签间距')||text.match(/(?:距离|间距)\s*(?:不超过|不得超过|不大于|≤|小于等于)?\s*(\d+(?:\.\d+)?\s*(?:cm|mm|厘米|毫米))/i)?.[1]||'';
 const requirements=[];
 for(let line of original.split(/\r?\n/).map(v=>v.trim().replace(/^[\s>🟦🟩⬜🟠]+/u,''))){
  if(!line||/^\d{1,2}[:：]\d{2}$/.test(line)||/\.pdf\b|\b(?:KB|MB)\s*$/i.test(line)||/微信电脑版/.test(line))continue;
  if(/^(?:[图国和\s]*)(?:产品名称|产品|品名|产品位于|产品位置|库位|货位|位置|位于|客户|货主|入库单号|入库单|退货地址|退件地址|SKU|FNSKU|新产品条码|新透明标签|标签间距)\s*(?:为|是)?\s*[：:]/i.test(line))continue;
  if(/^(?:数量|总数量|合计|共|总计)\s*[：:=＝]?\s*\d/.test(line)||/^\s*OBC[A-Z0-9-]+\s+\d+\s*箱/i.test(line))continue;
  line=line.replace(/(?:出库单号|出库单|订单号|单号)\s*(?:为)?\s*[：:；;]?\s*OBC[A-Z0-9-]+/gi,'').replace(/^\s*OBC[A-Z0-9-]+\s*/i,'').replace(/^(?:出库单号|出库单|订单号|单号)\s*(?:为)?\s*[：:；;]?\s*$/,'').replace(/麻烦操作一下[，,]?|麻烦[，,]?/g,'').trim().replace(/^[，,；;\s]+/,'');
  if(!line||/^(?:⏸\s*)?(?:暂不出库\s*[·：:]\s*)?备货中转出库$/.test(line)||/^(?:图和|图|和)?\s*暂不出库\s*[：:]\s*中转出库\s*[：:]?$/.test(line)||/^(?:备货)?中转出库\s*[：:]?$/.test(line))continue;
  line=stripNumber(line);if(line)requirements.push(line);
 }
 const generalLabel=/分拣/.test(text)?'分拣':/换.{0,8}标|更换.{0,8}标/.test(text)?'换标':/弃置|销毁/.test(text)?'弃置':/出库|一件代发/.test(text)?'出库':'操作';
 const draft={type,title:((type==='general'?generalLabel+'工单':TYPE_LABELS[type])+(product?' · '+product:orders.length===1?' · '+orders[0]:'')).slice(0,160),orderNo:orders.join('、'),inboundNo,customer:valueAfter(text,'客户|货主'),product,sku:valueAfter(text,'^SKU'),fnsku:code(valueAfter(text,'FNSKU')),quantity:quantityText(text),location,returnAddress:valueAfter(text,'退货地址|退件地址'),newBarcode:code(label),transparentBarcode:code(transparent),labelGap,requirements:requirements.join('\n'),hold:HOLD.test(text),warnings:[]};
 if(orders.length>1)draft.warnings.push('检测到多个单号，请核对每条要求对应的单号；本次生成一张工单。');
 if(/不|勿|禁止|无需|暂|等.{0,12}再/.test(text))draft.warnings.push('消息含限制或等待条件，请逐句核对，未满足条件前不要放行。');
 if(/\.pdf\b/i.test(text))draft.warnings.push('识别到了附件文件名；截图中的文件名不代表实际文件已上传。');
 if(HOLD.test(text)&&!HOLD.test(draft.requirements))draft.requirements=['暂不出库。',draft.requirements].filter(Boolean).join('\n');
 return draft;
}
export function draftIssues(draft){
 const issues=[...quantityAudit(draft.quantity).issues];
 if(draft.inboundNo&&!/^IB[A-Z0-9-]{6,40}$/i.test(draft.inboundNo))issues.push('入库单号可能识字有误，请对照原图核对：'+draft.inboundNo);
 if(draft.newBarcode&&!/^[A-Z0-9-]{6,40}$/i.test(draft.newBarcode))issues.push('新产品条码格式待核对。');
 if(draft.transparentBarcode&&!/^\d{6,30}$/.test(draft.transparentBarcode))issues.push('透明标签码格式待核对，请保留前导0。');
 if(/[A-Z]\s*\d+.*\+.*[A-Z]\s*\d+.*(?:拿|取)\s*\d+\s*箱/i.test(draft.location))issues.push('有多个库位和取货箱数，请核对每个库位分别拿多少箱。');
 if(PLACEHOLDER.test(draft.requirements||''))issues.push('范例中还有待替换内容，请填写或删除不适用的要求。');
 return issues;
}
export function missingFields(draft,hasFiles=false){
 const missing=[];for(const [key,label]of [['product','产品'],['quantity','数量'],['location','库位']])if(!draft[key]?.trim())missing.push(label);
 if(draft.type==='transfer'){if(!draft.inboundNo)missing.push('入库单号');if(!draft.orderNo)missing.push('出库单号')}
 if(/标|二维码/.test(draft.requirements||'')&&!hasFiles)missing.push('标签文件（如本单需要换标）');
 if(!draft.requirements?.trim())missing.push('操作要求');return missing;
}
export function draftStatus(draft,missing=[]){if(draftIssues(draft).length)return '待核对';if(draft.hold||HOLD.test(draft.requirements||''))return '暂不出库';return missing.length?'待补充':'待执行'}
export function draftBody(draft,missing=missingFields(draft)){
 const req=draft.requirements?.trim()||'待补充',show=(label,key)=>label+'：'+(draft[key]?.trim()||'待补充');let body;
 if(draft.type==='transfer'){
  body=[draft.hold||HOLD.test(req)?'⏸ 暂不出库 · 备货中转出库':'备货中转出库','业务：',...req.split('\n').filter(Boolean).map((v,i)=>(i+1)+'. '+stripNumber(v)),'',show('产品','product'),...(draft.sku?[show('SKU','sku')]:[]),show('🟦产品位于','location'),show('🟩入库单号','inboundNo'),show('⬜出库单号','orderNo'),show('数量','quantity')];
  for(const [label,key] of [['新产品条码','newBarcode'],['新透明标签','transparentBarcode'],['标签间距','labelGap']])if(draft[key])body.push(show(label,key));
 }else if(draft.type==='returns')body=[show('客户','customer'),show('产品','product'),show('SKU','sku'),show('FNSKU','fnsku'),show('退货地址','returnAddress'),show('🟦位于','location'),show('数量','quantity'),'','清点 / 入库要求：',req];
 else body=[...['orderNo','customer','product','quantity','location'].map((k,i)=>show(['单号','客户','产品','数量','库位'][i],k)),...(draft.sku?[show('SKU','sku')]:[]),...(draft.inboundNo?[show('入库单号','inboundNo')]:[]),'','操作要求：',req];
 const issues=draftIssues(draft);if(issues.length)body.push('','⚠️待核对：',...issues.map(i=>'- '+i));
 if(missing.length)body.push('','待补充：'+missing.join('、'),'资料补齐并核对后再操作。');return body.join('\n');
}
