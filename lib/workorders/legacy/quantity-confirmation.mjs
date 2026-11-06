// Inventory is a read-only snapshot. A confirmation records a human check on the
// work order; it never repairs inventory or authorizes a negative balance.
const count=value=>{
 if(value===null||value===undefined||String(value).trim()==='')return null;
 const n=Number(value);return Number.isSafeInteger(n)&&n>=0?n:null;
};
const id=value=>String(value);
const stocks=row=>row.locations||[];
const uniqueStocks=row=>[...new Map(stocks(row).map(s=>[id(s.stockId),s])).values()];
const rowLabel=row=>row.inboundNo||row.orderNo||row.id||'本行';
const presentCount=value=>{const n=count(value);return n!==null&&n>0?n:null};

export function inventoryQuantityLabel(value,unit=''){
 const n=presentCount(value);
 return n===null?(count(value)===0?'未确认（原记录 0）':'未填写 / 未确认'):n+unit;
}

export function quantitySignature(doc,row){
 const selected=uniqueStocks(row),ids=new Set(selected.map(s=>id(s.stockId)));
 const related=(doc.rows||[]).filter(r=>r===row||stocks(r).some(s=>ids.has(id(s.stockId)))).map(r=>({
  id:r.id||r.inboundNo,inboundNo:r.inboundNo,boxes:r.boxes,perCarton:r.perCarton,shipUnits:r.shipUnits,
  product:r.product,sku:r.sku,
  stocks:uniqueStocks(r).map(s=>({id:s.stockId,version:s.version,updatedAt:s.updatedAt,location:s.locationCode,
   boxes:s.totalBoxes,units:s.totalQuantity,product:s.product,sku:s.sku,customer:s.customerName,inbound:s.inboundOrder})).sort((a,b)=>String(a.id).localeCompare(String(b.id)))
 })).sort((a,b)=>String(a.id).localeCompare(String(b.id)));
 const raw=JSON.stringify({order:doc.orderNo,customer:doc.customer,product:doc.product,sku:doc.sku,related});
 // Compact change detection only, not a security or authorization token.
 let hash=14695981039346656037n;
 for(let i=0;i<raw.length;i++){hash^=BigInt(raw.charCodeAt(i));hash=BigInt.asUintN(64,hash*1099511628211n)}
 return 'quantity-v1:'+hash.toString(16).padStart(16,'0');
}

export function quantityAssessment(doc,row){
 const selected=uniqueStocks(row),reasons=[],issues=[];
 let demandRows=[row];
 if(selected.length===1){const stockId=id(selected[0].stockId);demandRows=(doc.rows||[]).filter(r=>uniqueStocks(r).length===1&&id(uniqueStocks(r)[0].stockId)===stockId)}
 const sumDemand=key=>{const values=demandRows.map(r=>count(r[key]));if(values.some(v=>v===null||(key==='boxes'&&v<1)))return null;const total=values.reduce((a,b)=>a+b,0);return Number.isSafeInteger(total)?total:null};
 const requiredBoxes=sumDemand('boxes'),requiredUnits=sumDemand('shipUnits');
 const sumRecorded=key=>{const values=selected.map(s=>presentCount(s[key]));return !values.length||values.some(v=>v===null)?null:values.reduce((a,b)=>a+b,0)};
 let recordedBoxes=sumRecorded('totalBoxes'),recordedUnits=sumRecorded('totalQuantity');
 // Repeated references must agree on the same snapshot. Never choose the larger
 // availability from two inconsistent copies of a stock record.
 if(selected.length===1&&demandRows.length>1){
  for(const [key,target]of [['totalBoxes','boxes'],['totalQuantity','units']]){
   const values=demandRows.map(r=>presentCount(uniqueStocks(r)[0][key]));
   const value=values.some(v=>v===null)?null:Math.min(...values);
   if(target==='boxes')recordedBoxes=value;else recordedUnits=value;
  }
 }
 const scope=demandRows.length>1?'同一库存记录 #'+selected[0].stockId+' 的 '+demandRows.length+' 行合计':'本行';
 if(!selected.length)issues.push('库位待确认后才能核对可用数量');
 if(requiredBoxes===null||requiredBoxes<1)issues.push('取货箱数待补充为大于 0 的整数');
 if(requiredUnits===null)issues.push('出货件数待补充为不小于 0 的整数');
 if(selected.length){
  if(recordedBoxes===null)reasons.push('库存箱数未填写或为 0，不能视为已确认的可用箱数');
  else if(requiredBoxes!==null&&recordedBoxes<requiredBoxes)reasons.push(scope+'需 '+requiredBoxes+' 箱，库存记录仅 '+recordedBoxes+' 箱');
  if(recordedUnits===null)reasons.push('库存件数未填写或为 0，不能视为已确认的可用件数');
  else if(requiredUnits!==null&&recordedUnits<requiredUnits)reasons.push(scope+'需 '+requiredUnits+' 件，库存记录仅 '+recordedUnits+' 件');
 }
 if(selected.length>1)issues.push('多个库位的取货分配待核对，请明确每个库位取几箱、几件');
 const confirmation=row.quantityConfirmation||{},actualBoxes=count(confirmation.actualBoxes),actualUnits=count(confirmation.actualUnits);
 const signature=quantitySignature(doc,row),confirmed=confirmation.confirmed===true&&confirmation.signature===signature;
 if(reasons.length){
  if(!confirmed)issues.push(...reasons,'请填写现场实际可用箱数、件数并勾选数量已核对');
  else{
   if(actualBoxes===null||actualUnits===null)issues.push('现场实际可用箱数 / 件数必须填写有效整数');
   if(actualBoxes!==null&&requiredBoxes!==null&&actualBoxes<requiredBoxes)issues.push(scope+'需 '+requiredBoxes+' 箱，现场确认仅 '+actualBoxes+' 箱；数量不足，需调整工单或补货');
   if(actualUnits!==null&&requiredUnits!==null&&actualUnits<requiredUnits)issues.push(scope+'需 '+requiredUnits+' 件，现场确认仅 '+actualUnits+' 件；数量不足，需调整工单或补货');
  }
 }
 return {selected,requiredBoxes,requiredUnits,recordedBoxes,recordedUnits,demandCount:demandRows.length,scope,reasons,needsConfirmation:reasons.length>0,confirmed,signature,actualBoxes,actualUnits,issues};
}

export function quantityIssues(doc){
 const rows=doc.rows||[],issues=rows.flatMap(row=>quantityAssessment(doc,row).issues.map(message=>rowLabel(row)+'：'+message));
 const groups=new Map();
 for(const row of rows){const selected=uniqueStocks(row);if(selected.length!==1)continue;const key=id(selected[0].stockId);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row)}
 for(const [stockId,group]of groups){
  if(group.length<2)continue;
  const checked=group.map(row=>quantityAssessment(doc,row)).filter(s=>s.needsConfirmation&&s.confirmed);
  if(checked.length>1&&new Set(checked.map(s=>JSON.stringify([s.actualBoxes,s.actualUnits]))).size>1)issues.push('库存记录 #'+stockId+'：多行填写的现场可用数量不一致，请统一核对同一批库存');
 }
 return [...new Set(issues)];
}

export function quantitySnapshot(doc){
 return (doc.rows||[]).map(row=>({id:row.id,inboundNo:row.inboundNo,boxes:row.boxes,perCarton:row.perCarton,shipUnits:row.shipUnits,
  stocks:uniqueStocks(row).map(s=>({stockId:s.stockId,version:s.version,updatedAt:s.updatedAt,locationCode:s.locationCode,totalBoxes:s.totalBoxes??null,totalQuantity:s.totalQuantity??null})),
  quantityConfirmation:row.quantityConfirmation?{actualBoxes:row.quantityConfirmation.actualBoxes,actualUnits:row.quantityConfirmation.actualUnits,confirmed:row.quantityConfirmation.confirmed===true,signature:row.quantityConfirmation.signature||''}:null,
  checkedSignature:quantitySignature(doc,row)
 }));
}
