import {palletLabel} from "./pallet";
import {GoodsFlowError,assertGoodsBalance,goodsInteger,materializeGoods,parseGoodsState,type GoodsCategory,type GoodsChoice,type GoodsStock} from './goods-flow';
import {goodsOutboundDate} from './goods-outbound-plan';
import type {CorrectionPricing} from './goods-correction-pricing';
export type CorrectionSegment={lotId:string;quantity:number;boxes:number;snapshot:GoodsStock;effectiveDate:string};
/** Validate durable correction evidence before restore or report projection. */
export function validateCorrectionOperation(op:{result:string;beforeRows:string;afterRows:string;beforeCategory?:string|null;afterCategory?:string}){
 const fail=()=>{throw new GoodsFlowError('库存数据修正记录不完整或数量不一致，请核对备份',400)};
 const result=JSON.parse(op.result),before=JSON.parse(op.beforeRows),after=JSON.parse(op.afterRows);
 const validDay=(d:unknown)=>typeof d==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(d)&&Number.isFinite(Date.parse(d+'T00:00:00Z'))&&new Date(d+'T00:00:00Z').toISOString().slice(0,10)===d;
 if(!result||result.inventoryQuantityCorrection!==true||!validDay(result.effectiveDate)||!Array.isArray(result.closedAllocations)||!Array.isArray(before)||!Array.isArray(after)||before.length!==1||after.length!==1||before[0].id!==after[0].id)fail();
 if(op.beforeCategory)parseGoodsState(op.beforeCategory);if(op.afterCategory)parseGoodsState(op.afterCategory);
 for(const row of [...before,...after])for(const key of ['totalQuantity','totalBoxes'])if(!Number.isSafeInteger(row[key])||row[key]<0)fail();
 let quantity=0,boxes=0;
 for(const segment of result.closedAllocations){const s=segment?.snapshot;if(!s||typeof segment.lotId!=='string'||segment.effectiveDate!==result.effectiveDate||!Number.isSafeInteger(segment.quantity)||segment.quantity<0||!Number.isSafeInteger(segment.boxes)||segment.boxes<0||!segment.quantity&&!segment.boxes||!validDay(s.inboundDate)||s.inboundDate>segment.effectiveDate)fail();
  for(const key of ['locationCode','product','customerName','sku','barcode','fnsku','inboundOrder','note','updatedAt','updatedBy'])if(typeof s[key]!=='string')fail();
  for(const key of ['id','totalQuantity','totalBoxes','freeDays','version','layerCount'])if(!Number.isSafeInteger(s[key])||s[key]<0)fail();
  for(const key of ['itemVolumeM3','boxVolumeM3','storageRateUsd'])if(typeof s[key]!=='number'||!Number.isFinite(s[key])||s[key]<0)fail();
  if(!['return','domestic','unspecified'].includes(s.inboundSource)||!['item','box'].includes(s.billingMode)||s.inventoryUnit==='box'&&s.totalQuantity!==0)fail();quantity+=segment.quantity;boxes+=segment.boxes;
 }
 if(quantity!==Math.max(0,before[0].totalQuantity-after[0].totalQuantity)||boxes!==Math.max(0,before[0].totalBoxes-after[0].totalBoxes))fail();return result as {inventoryQuantityCorrection:true;effectiveDate:string;closedAllocations:CorrectionSegment[]};
}
export function correctionCategory(choice:GoodsChoice,category:GoodsCategory|undefined,stamp:string){
 if(category)return structuredClone(category);
 const result=materializeGoods(choice,stamp);result.lots.forEach(l=>{l.id=`legacy-${l.stockId}`});return result;
}
export function planGoodsCorrection(category:GoodsCategory,rows:readonly GoodsStock[],body:Record<string,unknown>,stamp:string,userName:string,productPricing?:CorrectionPricing){
 assertGoodsBalance(category,rows);
 const id=goodsInteger(body.stockId,'库位货物编号',1),row=rows.find(r=>r.id===id);
 if(!row||!category.stockIds.includes(id))throw new GoodsFlowError('这条记录不属于当前货物');
 if(body.confirmed!==true)throw new GoodsFlowError('请核对数量和数据生效日期后确认修正',400);
 if(typeof body.effectiveDate!=='string'||!body.effectiveDate)throw new GoodsFlowError('请选择数据生效日期',400);
 const date=goodsOutboundDate(body.effectiveDate),quantity=goodsInteger(body.newQuantity,'修正后件数'),boxes=goodsInteger(body.newBoxes,'修正后箱数');
 if(row.inventoryUnit==='box'&&quantity!==0)throw new GoodsFlowError('箱库存不填写件数，不会自动换算',400);
 const dq=quantity-row.totalQuantity,db=boxes-row.totalBoxes;
 if(!dq&&!db)throw new GoodsFlowError('数量没有变化，请直接修改其他资料',400);
 const automatic=body.pricingSource==='product';
 const next=structuredClone(category),selected=!automatic&&body.lotId?next.lots.find(l=>l.id===body.lotId):undefined;
 if(!automatic&&body.lotId&&!selected)throw new GoodsFlowError('所选原计价批次已变化，请刷新核对');
 let q=Math.max(0,-dq),b=Math.max(0,-db);const closed:CorrectionSegment[]=[];
 const candidates=(selected?[selected]:next.lots).slice().sort((a,b)=>a.snapshot.inboundDate.localeCompare(b.snapshot.inboundDate)||a.stockId-b.stockId||a.id.localeCompare(b.id));
 for(const lot of candidates){const takeQ=Math.min(q,lot.quantity),takeB=Math.min(b,lot.boxes);if(!takeQ&&!takeB)continue;
  if(lot.snapshot.inboundDate>date)throw new GoodsFlowError(`数据生效日期不能早于 ${lot.snapshot.inboundDate} 的原计价批次`,400);
  closed.push({lotId:lot.id,quantity:takeQ,boxes:takeB,snapshot:{...lot.snapshot},effectiveDate:date});lot.quantity-=takeQ;lot.boxes-=takeB;q-=takeQ;b-=takeB;
 }
 if(q||b)throw new GoodsFlowError('所选原批次余量不足，请选择其他批次或按原批次先进先出',400);
 if(dq>0||db>0){if(automatic&&!productPricing)throw new GoodsFlowError('请先核对产品资料和仓储计价设置',400);if(!automatic&&!selected)throw new GoodsFlowError('增加数量时请选择沿用计价参数的原入库批次',400);const original=automatic?row:selected!.snapshot;if(date<original.inboundDate)throw new GoodsFlowError(automatic?'数据生效日期不能早于当前货物入库日':'数据生效日期不能早于所选原批次入库日',400);
  const snapshot={...original,...(automatic?productPricing:{}),id:row.id,locationCode:row.locationCode,inboundDate:date,totalQuantity:Math.max(0,dq),totalBoxes:Math.max(0,db),customerName:category.customerName};
  if(automatic&&snapshot.inboundSource==='return'&&row.inventoryUnit==='box'&&snapshot.billingMode!=='box')throw new GoodsFlowError('此退货箱库存当前按件计费，请先在仓储计价核对计费方式后再修正箱数',400);
  next.lots.push({id:crypto.randomUUID(),stockId:row.id,quantity:Math.max(0,dq),boxes:Math.max(0,db),snapshot});
 }
 const after={...row,totalQuantity:quantity,totalBoxes:boxes,...(!quantity&&!boxes?{palletCount:0,palletLabel:palletLabel(0)}:{}),version:row.version+1,updatedAt:stamp,updatedBy:userName};
 assertGoodsBalance(next,rows.map(r=>r.id===id?after:r));return {category:next,before:row,after,closed,date,dq,db};
}
