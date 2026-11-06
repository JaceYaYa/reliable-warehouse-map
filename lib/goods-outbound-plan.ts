import {loadStagingTasks} from './goods-staging';
import { env } from "cloudflare:workers";
import { GoodsFlowError,goodsInteger,materializeGoods,planGoodsOutbound } from "./goods-flow";
import { goodsPalletModeWrites,goodsAudit,goodsOperation,goodsStockUpdate,goodsFinish,loadGoodsContext } from "./goods-store";
import { calculateStorageFee,chinaTodayDate } from "./pricing";
import { stockProductLabel } from "./stock-product";
import {outboundCustomerPricing} from './goods-outbound-customer-pricing';
import {isLayerStoragePricing} from './storage-pricing-basis';
export function goodsOutboundDate(value:unknown):string {
  const day=value===undefined?chinaTodayDate():value;
  if(typeof day!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(day))throw new GoodsFlowError("出库日期无效或晚于今天",400);
  const date=new Date(`${day}T00:00:00Z`);
  if(!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==day||day>chinaTodayDate())throw new GoodsFlowError("出库日期无效或晚于今天",400);
  return day;
}
export async function prepareGoodsOutbound(context:Awaited<ReturnType<typeof loadGoodsContext>>,body:Record<string,unknown>,user:{id:number;displayName:string},idem:{id:string;fingerprint:string;documentId?:string;documentNumber?:string},snapshot=context) {
  const choice=context.choices.find(c=>c.key===body.key);if(!choice||body.expectedRevision!==context.stored.revision)throw new GoodsFlowError("货物列表已变化，请刷新核对；填写仍保留");
  if(choice.review)throw new GoodsFlowError(choice.reason);
  const originalChoice=snapshot.choices.find(c=>c.key===body.key);
  const expected=body.members as {id:number;version:number}[];if(!originalChoice||!Array.isArray(expected)||expected.length!==originalChoice.members.length||originalChoice.members.some(r=>!expected.some(x=>x&&x.id===r.id&&x.version===r.version)))throw new GoodsFlowError("已有货物库存已变化，请刷新核对");
  const selected=body.selected as {id:number;version:number;quantity?:unknown;boxes?:unknown;pallets?:unknown}[];if(!Array.isArray(selected)||selected.some(r=>!r||typeof r!=='object'))throw new GoodsFlowError("请选择出库库位",400);
  let stagingTaskId:string|undefined;
  if(body.stagingTaskId!==undefined){
    if(typeof body.stagingTaskId!=='string'||!body.stagingTaskId.trim())throw new GoodsFlowError('待出库任务编号无效，请重新加入任务',400);
    const task=(await loadStagingTasks(snapshot)).find(task=>task.id===body.stagingTaskId);
    if(!task||task.key!==body.key||!task.members.length||selected.some(ref=>!task.members.some(row=>row.id===ref.id)))throw new GoodsFlowError('所选实物不属于这条待出库任务，请刷新并重新分配',409);
    stagingTaskId=task.id;
  }
  // Client versions always describe the original snapshot. Only rebase them
  // after validating it, so one line cannot hide a stale reference in another.
  for(const ref of selected){const row=originalChoice.members.find(r=>r.id===ref.id);if(!row)throw new GoodsFlowError("所选库位不属于当前货物，请刷新重试");if(row.version!==ref.version)throw new GoodsFlowError("所选库位库存已变化，填写仍保留，请刷新核对");}
  const effectiveSelected=selected.map(ref=>({...ref,version:context.rows.find(r=>r.id===ref.id)!.version}));
  if(body.outboundOrder!==undefined&&(typeof body.outboundOrder!=='string'||body.outboundOrder.length>500))throw new GoodsFlowError("出库单号格式不正确或超过 500 字",400);
  const outboundOrder=typeof body.outboundOrder==='string'?body.outboundOrder.trim():'',lineId=typeof body.lineId==='string'?body.lineId.trim():undefined;
  const stamp=new Date().toISOString(),outboundDate=goodsOutboundDate(body.outboundDate),outboundAt=`${outboundDate}T23:59:59.000Z`,beforeCategory=choice.categoryId?context.state.categories.find(c=>c.id===choice.categoryId)!:null,category=beforeCategory??materializeGoods(choice,stamp),plan=planGoodsOutbound(category,context.rows,effectiveSelected,goodsInteger(body.quantity,"出库件数"),goodsInteger(body.boxes,"出库箱数"),stamp,user.displayName),settlements=[],billingAllocations=[];
  for(const row of [...plan.before,...plan.allocations.map(a=>a.lot.snapshot)])if(row.inboundDate>outboundDate)throw new GoodsFlowError(`出库日期不能早于 ${row.inboundDate} 的实物入库或计价批次日期；本次不会扣货`,400);
  const layerPricing=await isLayerStoragePricing(),customerPricing=!layerPricing&&plan.allocations.some(a=>a.lot.snapshot.inboundSource==='return')?await outboundCustomerPricing(category.customerName):null;
  // Physical/FIFO snapshots already contain complete undo evidence. Layer mode
  // needs no unit-based fee rows, including zero-valued technical settlements.
  if(!layerPricing)for(const [index,allocation] of plan.allocations.entries()){
    const row=allocation.lot.snapshot,chargeable=row.inboundSource==="return";
    // Item billing uses pieces only; packaging boxes carry movement evidence, never inferred pieces.
    if(chargeable&&row.inventoryUnit==='box'&&allocation.boxes>0&&allocation.quantity===0&&row.billingMode!=='box')throw new GoodsFlowError(`${row.inboundDate} 独立箱库存仍按件计价，请先在仓储计价核对计费方式；本次不会扣货`,400);
    // Missing volume is a pending pricing issue, never a physical movement prerequisite.
    const pricing=chargeable&&customerPricing?customerPricing.forLot(row):{ratePerM3Day:row.storageRateUsd,freeDays:row.freeDays};
    const calculation=calculateStorageFee({inboundDate:row.inboundDate,endDate:outboundAt.slice(0,10),billingMode:row.billingMode,quantity:allocation.quantity,boxes:allocation.boxes,itemVolumeM3:row.itemVolumeM3,boxVolumeM3:row.boxVolumeM3,rateUsdM3Day:pricing.ratePerM3Day,freeDays:pricing.freeDays}),operationId=`${idem.id}:cost:${index}`;
    settlements.push(env.DB.prepare(`INSERT INTO storage_fee_settlements (stock_id,operation_id,catalog_item_id,location_code,inbound_source,billing_mode,product,sku,fnsku,barcode,inbound_order,customer_name,inbound_date,outbound_at,quantity,boxes,item_volume_m3,box_volume_m3,rate_usd_m3_day,free_days,storage_days,billable_days,total_volume_m3,fee_usd,settlement_status,settled_at,settled_by,version,previous_inbound_source,previous_billing_mode,previous_item_volume_m3,previous_box_volume_m3,previous_storage_rate_usd,previous_free_days,previous_catalog_item_id,stock_updated_at_before,stock_updated_at_after,operated_by,created_at) VALUES (${Array.from({length:39},()=>"?").join(",")})`).bind(row.id,operationId,row.catalogItemId,row.locationCode,row.inboundSource,row.billingMode,stockProductLabel(row),row.sku,row.fnsku,row.barcode,row.inboundOrder,category.customerName,row.inboundDate,outboundAt,allocation.quantity,allocation.boxes,row.itemVolumeM3,row.boxVolumeM3,pricing.ratePerM3Day,pricing.freeDays,calculation.storageDays,calculation.billableDays,calculation.totalVolumeM3,chargeable?calculation.feeUsd:0,chargeable?"pending":"settled",chargeable?null:stamp,chargeable?null:user.displayName,0,row.inboundSource,row.billingMode,row.itemVolumeM3,row.boxVolumeM3,row.storageRateUsd,row.freeDays,row.catalogItemId,row.updatedAt,stamp,user.displayName,stamp));
    billingAllocations.push({operationId,stockId:row.id,inboundDate:row.inboundDate,quantity:allocation.quantity,boxes:allocation.boxes,note:row.note});
  }
  const state={categories:[...context.state.categories.filter(c=>c.id!==category.id),plan.category]},result={ok:true,...(layerPricing?{pricingBasis:'layer'}:{}),...(stagingTaskId?{stagingTaskId}:{}),outboundDate,quantity:plan.quantity,pallets:plan.pallets,boxes:plan.boxes,automaticClearedBoxes:plan.automaticClearedBoxes,...(outboundOrder?{outboundOrder}:{}),...(lineId?{lineId}:{}),customerName:category.customerName,...(idem.documentId?{documentId:idem.documentId,documentNumber:idem.documentNumber}:{}),key:`category:${category.id}`,categoryId:category.id,stocks:plan.after,billingAllocations,pricingReview:!layerPricing&&plan.allocations.some(a=>a.lot.snapshot.inboundSource==='return'&&!((a.lot.snapshot.billingMode==='box'?a.lot.snapshot.boxVolumeM3:a.lot.snapshot.itemVolumeM3)>0))},dates=[...new Set(plan.allocations.map(a=>a.lot.snapshot.inboundDate))].join("、");
  const queries=[...(customerPricing?[customerPricing.guard(`${idem.id}:customer-pricing`)]:[]),...plan.after.map(goodsStockUpdate),...goodsPalletModeWrites(plan.after),...settlements,goodsAudit(user,idem.id,"outbound",category.product,`${idem.documentNumber?`系统单号 ${idem.documentNumber}｜`:""}${outboundOrder?`出库单号 ${outboundOrder}｜`:""}${category.product}｜客户 ${category.customerName}｜货物出库｜出库日期 ${outboundDate}｜数量 -${body.quantity}｜箱数 -${plan.boxes}｜托盘 -${plan.pallets}｜实物库位 ${plan.before.map(r=>r.locationCode).join("、")}｜计价先进先出批次 ${dates}｜${layerPricing?'托层计价，不生成旧件/箱出库账单':'退货费用待确认'}`,plan.before,plan.after,stamp),goodsOperation({id:idem.id,kind:"outbound",categoryId:category.id,fingerprint:idem.fingerprint,beforeCategory,afterCategory:plan.category,beforeRows:plan.before,afterRows:plan.after,settlementIds:billingAllocations.map(a=>a.operationId),result,stamp}),...(customerPricing?[goodsFinish(`${idem.id}:customer-pricing`)]:[])];return {queries,state,result,rows:result.stocks};
}
