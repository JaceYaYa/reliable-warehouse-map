import {palletCountValue,palletCountExceeds,palletRemaining} from './pallet';
import type {GoodsPick} from './goods-operation-draft';
import type {GoodsChoice, GoodsStock} from "./goods-flow";
import {stockProductDetails} from "./stock-product";
import {searchWarehouseRecords,isApproximateWarehouseSearchMatch,allowsLiteralWarehouseSearchFallback} from './warehouse-search';

export type GoodsOperationMode = "inbound" | "outbound";
export type PickCondition = "all" | "good" | "damaged" | "unmarked";
export type GoodsImportRow = {line:number;input:string;quantity:number;boxes:number;choice?:GoodsChoice;error:string};
const identity=(value:string)=>value.normalize("NFKC").trim().replace(/\s+/g," ").toLowerCase();
const codes=(choice:GoodsChoice)=>[choice.sku,choice.barcode,...choice.members.flatMap(row=>[row.sku,row.fnsku,row.barcode])].filter(Boolean).flatMap(code=>code.split(" / ")).map(identity);
export function operationChoices(choices:readonly GoodsChoice[],customer:string,mode:GoodsOperationMode){
  return choices.filter(choice=>(!customer.trim()||choice.customerName===customer.trim())&&(mode==="inbound"||choice.quantity>0||choice.boxes>0));
}
/** Prefer exact identifiers. Ambiguous product names stay ambiguous even when one row has no SKU. */
export function exactOperationMatches(choices:readonly GoodsChoice[],input:string){
  const token=identity(input);if(!token)return [];
  const exactCodes=choices.filter(choice=>codes(choice).includes(token));
  if(exactCodes.length)return exactCodes;
  return choices.filter(choice=>[choice.product,...choice.members.map(row=>stockProductDetails(row).name)].some(name=>identity(name)===token));
}
export function parseGoodsImport(text:string,choices:readonly GoodsChoice[],customer:string,mode:GoodsOperationMode,existingKeys:readonly string[]=[]):GoodsImportRow[]{
  const eligible=operationChoices(choices,customer,mode),existing=new Set(existingKeys);
  const rows=text.split(/\r?\n/).map((line,index)=>({line,index})).filter(({line})=>line.trim()).map(({line,index}):GoodsImportRow=>{
    const parts=line.includes("\t")?line.split("\t"):line.split(/\s*\|\s*/);
    const input=parts[0]?.trim()??"",quantity=Number(parts[1]),boxes=parts.length>2?Number(parts[2]):0;
    const row:GoodsImportRow={line:index+1,input,quantity,boxes,error:""};
    if(parts.length<2||parts.length>3||!input||parts[1]?.trim()===""||parts[2]?.trim()===""||!Number.isSafeInteger(quantity)||!Number.isSafeInteger(boxes)||quantity<0||boxes<0||(!quantity&&!boxes)){row.error="每行填写货物、件数、箱数；数量须为非负整数，至少一项大于 0";return row;}
    const matches=exactOperationMatches(eligible,input);
    if(!matches.length){row.error="未找到对应货物，请核对名称或新建货物";return row;}
    if(matches.length>1){row.error=`找到 ${matches.length} 项货物，请用 SKU 或条形码明确选择`;return row;}
    row.choice=matches[0];
    if(row.choice.review)row.error=row.choice.reason;
    else if(existing.has(row.choice.key))row.error="已在本单，原填写已保留；请直接修改该货物";
    return row;
  });
  const totals=new Map<string,{quantity:number;boxes:number}>();
  for(const row of rows)if(row.choice&&!row.error){const previous=totals.get(row.choice.key)??{quantity:0,boxes:0};totals.set(row.choice.key,{quantity:previous.quantity+row.quantity,boxes:previous.boxes+row.boxes});}
  for(const row of rows)if(row.choice&&!row.error){const total=totals.get(row.choice.key)!;if(!Number.isSafeInteger(total.quantity)||!Number.isSafeInteger(total.boxes))row.error="同一货物合计数量过大，请核对";else if(mode==="outbound"&&(total.quantity>row.choice.quantity||total.boxes>row.choice.boxes))row.error="合计出库数量超过该货物可用库存";}
  return rows;
}
export function importedGoods(rows:readonly GoodsImportRow[]){
  const result=new Map<string,{choice:GoodsChoice;quantity:number;boxes:number}>();
  for(const row of rows)if(row.choice&&!row.error){const existing=result.get(row.choice.key);if(existing){existing.quantity+=row.quantity;existing.boxes+=row.boxes;}else result.set(row.choice.key,{choice:row.choice,quantity:row.quantity,boxes:row.boxes});}
  return [...result.values()];
}
export function matchesPickCondition(stock:GoodsStock,condition:PickCondition){
  const actual=stockProductDetails(stock).condition;
  if(condition==="all")return true;
  return condition==="unmarked"?!actual:actual===condition;
}
export function remainingPick(stock:GoodsStock,total:{quantity:number;boxes:number},allocatedElsewhere:{quantity:number;boxes:number}){
  return {quantity:String(Math.min(stock.totalQuantity,Math.max(0,total.quantity-allocatedElsewhere.quantity))),boxes:String(Math.min(stock.totalBoxes,Math.max(0,total.boxes-allocatedElsewhere.boxes)))};
}

function literalOperationSearch(c:GoodsChoice,input:string){const tokens=input.normalize('NFKC').trim().toLowerCase().split(/\s+/).filter(Boolean);return tokens.length>0&&tokens.every(t=>[c.product,c.customerName,c.sku,c.barcode,...c.members.flatMap(r=>[r.product,r.productPrefix,r.productCondition,r.sku,r.fnsku,r.barcode,r.customerName,r.note,r.inboundOrder,r.locationCode])].join(' ').normalize('NFKC').toLowerCase().includes(t));}
export function isApproximateOperationSearchMatch(c:GoodsChoice,input:string){return !exactOperationMatches([c],input).length&&!(allowsLiteralWarehouseSearchFallback(input)&&literalOperationSearch(c,input))&&isApproximateWarehouseSearchMatch(c,input);}
export function searchOperationChoices(choices:readonly GoodsChoice[],input:string,mode:GoodsOperationMode){
 if(!input.trim())return [];
 const eligible=choices.filter(c=>mode==='inbound'||c.quantity>0||c.boxes>0),records=eligible.flatMap(choice=>[{...choice,choice},...choice.members.map(row=>({...row,product:choice.product,customerName:choice.customerName,choice}))]);
 const ranked=searchWarehouseRecords(records,input,{fuzzyLimit:records.length}).map(record=>record.choice),legacy=allowsLiteralWarehouseSearchFallback(input)?eligible.filter(c=>literalOperationSearch(c,input)):[];
 const seen=new Set<string>();let near=0;
 return [...ranked,...legacy].filter(c=>{if(seen.has(c.key))return false;seen.add(c.key);return !isApproximateOperationSearchMatch(c,input)||near++<12;});
}

import type {GoodsLineInput} from './goods-operation-draft';
export type OutboundAllocationAction='outbound'|'staging';
type OutboundTask=GoodsLineInput&{choice:GoodsChoice};
export const outboundTaskKey=(line:OutboundTask)=>line.lineId??line.choice.key;
const count=(value:string|undefined)=>Number.isSafeInteger(Number(value))&&Number(value)>=0?Number(value):0;
const validCount=(v:string)=>typeof v==='string'&&v.trim()!==''&&Number.isSafeInteger(Number(v))&&Number(v)>=0;
export function outboundPalletDeduction(row:Pick<GoodsStock,'totalQuantity'|'totalBoxes'|'palletCount'|'inboundSource'>,pick:GoodsPick|undefined,action:OutboundAllocationAction='outbound'):number{
 if(!pick||(!count(pick.quantity)&&!count(pick.boxes)))return 0;
 const full=count(pick.quantity)===row.totalQuantity&&(count(pick.boxes)===row.totalBoxes||(action==='outbound'&&row.inboundSource==='return'&&row.totalQuantity>0));
 return full?row.palletCount:row.palletCount-palletRemaining(row.palletCount,palletCountValue(pick.pallets));
}
/** Reservations belong to a task, not to the shared product snapshot. */
export function availableOutboundMembers(line:OutboundTask,lines:readonly OutboundTask[],action:OutboundAllocationAction='outbound'):GoodsStock[]{
 return line.choice.members.filter(row=>!line.allowedStockIds||line.allowedStockIds.includes(row.id)).map(row=>{let quantity=row.totalQuantity,boxes=row.totalBoxes,pallets=0;for(const other of lines)if(outboundTaskKey(other)!==outboundTaskKey(line)){quantity-=count(other.picks[row.id]?.quantity);boxes-=count(other.picks[row.id]?.boxes);pallets+=outboundPalletDeduction(row,other.picks[row.id],action);}return {...row,totalQuantity:Math.max(0,quantity),totalBoxes:Math.max(0,boxes),palletCount:palletRemaining(row.palletCount,pallets)};});
}
export function outboundTaskConflict(line:OutboundTask,lines:readonly OutboundTask[],action:OutboundAllocationAction='outbound'):string{
 if(line.allowedStockIds&&Object.entries(line.picks).some(([id,p])=>(count(p.quantity)||count(p.boxes))&&!line.allowedStockIds!.includes(Number(id))))return '分配库位不属于本条待出库任务，请重新分配';
 for(const other of lines)if(other.choice.key===line.choice.key||Object.keys(other.picks).some(id=>line.choice.members.some(r=>r.id===Number(id)))){if(!validCount(other.quantity)||!validCount(other.boxes)||Object.values(other.picks).some(p=>!validCount(p.quantity)||!validCount(p.boxes)))return '请核对各单数量及库位分配，须为非负整数';}
 for(const other of lines)for(const [id,p] of Object.entries(other.picks)){const row=line.choice.members.find(r=>r.id===Number(id));if(!row)continue;const value=palletCountValue(p.pallets);if(!Number.isFinite(value)||palletCountExceeds(value,row.palletCount)||value>0&&!count(p.quantity)&&!count(p.boxes))return '请核对各库位出库托盘数，须为非负数且不超过可用托盘';}
 const siblings=lines.filter(l=>l.choice.key===line.choice.key);
 if(siblings.reduce((s,l)=>s+count(l.quantity),0)>line.choice.quantity||siblings.reduce((s,l)=>s+count(l.boxes),0)>line.choice.boxes)return '同产品各单合计数量超过可用库存';
 for(const row of line.choice.members){const picks=lines.map(l=>l.picks[row.id]);if(palletCountExceeds(picks.reduce((s,p)=>s+outboundPalletDeduction(row,p,action),0),row.palletCount))return `${row.locationCode} 库位被多条任务重复分配托盘，合计超过可用托盘`;if(picks.reduce((s,p)=>s+count(p?.quantity),0)>row.totalQuantity||picks.reduce((s,p)=>s+count(p?.boxes),0)>row.totalBoxes)return `${row.locationCode} 库位被多条任务重复分配，合计超过可用库存`;}
 return '';
}
const plain=(value:string)=>value.replace(/[\r\n\x00-\x1f]/g,' ').trim();
export function formatOutboundTaskMessage(line:OutboundTask,_date:string,_index:number,lines:readonly OutboundTask[],action:OutboundAllocationAction='outbound'):string{
 const valid=validCount;
 if(line.choice.review)throw Error(line.choice.reason||'货物资料待核对');
 if(!valid(line.quantity)||!valid(line.boxes)||(!count(line.quantity)&&!count(line.boxes)))throw Error('请先填写有效计划数量');
 const conflict=outboundTaskConflict(line,lines,action);if(conflict)throw Error(conflict);
 if(Object.keys(line.picks).some(id=>!line.choice.members.some(row=>row.id===Number(id))))throw Error('库位分配资料已变化，请重新分配');
 if(Object.values(line.picks).some(p=>!valid(p.quantity)||!valid(p.boxes)))throw Error('库位分配数量须为非负整数');
 let quantity=0,boxes=0;
 const picks=Object.entries(line.picks).filter(([,p])=>count(p.quantity)||count(p.boxes)).map(([id,p])=>{const row=line.choice.members.find(r=>r.id===Number(id));if(!row||!valid(p.quantity)||!valid(p.boxes)||count(p.quantity)>row.totalQuantity||count(p.boxes)>row.totalBoxes)throw Error('库位分配无效或超过可用库存');quantity+=count(p.quantity);boxes+=count(p.boxes);return{row,p};}).sort((a,b)=>a.row.inboundDate.localeCompare(b.row.inboundDate)||a.row.id-b.row.id);
 if(quantity!==count(line.quantity)||boxes!==count(line.boxes)||!picks.length)throw Error('库位分配合计与计划数量不一致，请分配完成后再复制');
 const amount=(q:number,b:number)=>[q?`${q}个`:'',b?`${b}箱`:''].filter(Boolean).join('、');
 const grouped=new Map<string,{location:string;layer:number;quantity:number;boxes:number}>();
 for(const {row,p} of picks){const location=plain(row.locationCode),layer=row.layerCount||1,key=JSON.stringify([location,layer]),group=grouped.get(key)??{location,layer,quantity:0,boxes:0};group.quantity+=count(p.quantity);group.boxes+=count(p.boxes);grouped.set(key,group);}
 const locations=[...grouped.values()].map(group=>`${group.location} ${group.layer}层（拿${amount(group.quantity,group.boxes)}）`);
 return `产品位于：${locations.join('+')}`;
}
import {normalizeReturnPackagingLines} from './return-packaging';
export type GoodsStagingTask={id:string;lineId:string;outboundOrder:string;product:string;customerName:string;key:string;stagedAt?:string;members:GoodsStock[];quantity:number;boxes:number};
/** Finishing commits the actual allocation totals; closing only retains manual inputs. */
export function completeOutboundAllocation<T extends OutboundTask>(line:T,lines:readonly T[],action:OutboundAllocationAction='outbound'):T{
 if(Object.values(line.picks).some(p=>!validCount(p.quantity)||!validCount(p.boxes)))throw Error('库位分配数量须为非负整数');
 if(Object.keys(line.picks).some(id=>!line.choice.members.some(row=>row.id===Number(id))||(line.allowedStockIds&&!line.allowedStockIds.includes(Number(id)))))throw Error('所选库位不属于本条待出库任务，请重新分配');
 const candidates=lines.map(other=>outboundTaskKey(other)===outboundTaskKey(line)?line:other);
 const normalized=action==='outbound'?normalizeReturnPackagingLines(candidates,'outbound'):candidates;
 const actual=normalized.find(other=>outboundTaskKey(other)===outboundTaskKey(line))??line;
 const total=Object.values(actual.picks).reduce((sum,p)=>({quantity:sum.quantity+Number(p.quantity),boxes:sum.boxes+Number(p.boxes)}),{quantity:0,boxes:0});
 if(!Number.isSafeInteger(total.quantity)||!Number.isSafeInteger(total.boxes)||(!total.quantity&&!total.boxes))throw Error('请至少分配一项有效数量');
 const done={...actual,quantity:String(total.quantity),boxes:String(total.boxes),autoPlacement:false};
 const conflict=outboundTaskConflict(done,normalized.map(other=>outboundTaskKey(other)===outboundTaskKey(done)?done:other),action);if(conflict)throw Error(conflict);
 for(const row of availableOutboundMembers(done,normalized,action)) {const p=done.picks[row.id];if(p&&(Number(p.quantity)>row.totalQuantity||Number(p.boxes)>row.totalBoxes))throw Error(`${row.locationCode} 分配数量超过可用库存`);}
 return done;
}
export function clearOutboundAllocation<T extends OutboundTask>(line:T):T{return {...line,picks:{},autoPlacement:false};}
/** One task stays one order; no partial addition when the visible selection exceeds the document limit. */
export function planStagedTaskAddition(tasks:readonly GoodsStagingTask[],lines:readonly OutboundTask[]){
 const added=new Set(lines.map(l=>l.stagingTaskId).filter(Boolean)),seen=new Set<string>();
 const result=tasks.filter(task=>!added.has(task.id)&&!seen.has(task.id)&&!!seen.add(task.id)).map(task=>{
  let quantity=0,boxes=0;const picks:Record<number,{quantity:string;boxes:string}>={};
  for(const row of task.members){let q=row.totalQuantity,b=row.totalBoxes;for(const line of lines){const p=line.picks[row.id];if(!p)continue;if(!validCount(p.quantity)||!validCount(p.boxes))throw Error('当前草稿分配数量无效，请先核对');q-=Number(p.quantity);b-=Number(p.boxes);}
   if(q<0||b<0)throw Error('当前草稿重复占用待出库库存，请先核对');if(q||b){picks[row.id]={quantity:String(q),boxes:String(b)};quantity+=q;boxes+=b;}}
  return {task,quantity,boxes,picks};
 }).filter(plan=>plan.quantity||plan.boxes);
 if(lines.length+result.length>25)throw Error(`本单最多 25 项，目前还可加入 ${Math.max(0,25-lines.length)} 项；请勾选部分待出库任务分批加入`);
 return result;
}
