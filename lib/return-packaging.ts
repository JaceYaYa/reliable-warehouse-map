import type {GoodsStock} from './goods-flow';
import type {GoodsLineInput} from './goods-operation-draft';
import type {GoodsChoice} from './goods-flow';

export function clearsReturnPackaging(row:Pick<GoodsStock,'inboundSource'|'inventoryUnit'|'totalQuantity'>,quantity:number){
 return row.inboundSource==='return'&&row.inventoryUnit!=='box'&&quantity>0&&quantity===row.totalQuantity;
}

/** Derive visible draft quantities without changing pending request bodies or stored manual inputs. */
export function normalizeReturnPackagingLines<T extends GoodsLineInput&{choice:GoodsChoice}>(lines:T[],mode:'inbound'|'outbound'):T[]{
 if(mode==='inbound')return lines.map(line=>line.receipt.inboundSource==='return'&&line.inventoryUnit!=='box'?{...line,boxes:'0',placements:line.placements.map(p=>({...p,boxes:'0'}))}:line);
 const remaining=new Map<number,{quantity:number;boxes:number}>();
 return lines.map(line=>{
  let extra=0;const picks={...line.picks};
  for(const [id,pick] of Object.entries(picks)){
   const row=line.choice.members.find(r=>r.id===Number(id));if(!row)continue;
   const available=remaining.get(row.id)??{quantity:row.totalQuantity,boxes:row.totalBoxes};
   const q=Number(pick.quantity),b=Number(pick.boxes);
   if(!pick.quantity.trim()||!pick.boxes.trim()||!Number.isSafeInteger(q)||!Number.isSafeInteger(b)||q<0||b<0||q>available.quantity||b>available.boxes)continue;
   const boxes=clearsReturnPackaging({...row,totalQuantity:available.quantity},q)?available.boxes:b;
   extra+=boxes-b;picks[id]={...pick,boxes:String(boxes)};
   remaining.set(row.id,{quantity:available.quantity-q,boxes:available.boxes-boxes});
  }
  return extra?{...line,picks,boxes:String(Number(line.boxes)+extra)}:line;
 });
}
