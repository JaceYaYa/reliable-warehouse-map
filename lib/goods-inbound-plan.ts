import {palletCountValue,palletLabel} from "./pallet";
import {warehouseTodayDate} from './warehouse-time';
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { settings } from "../db/schema";
import { GoodsFlowError,assertGoodsBalance,goodsInteger,materializeGoods,type GoodsStock } from "./goods-flow";
import { goodsAudit,goodsFinish,goodsOperation,goodsPalletModeWrites,goodsStockInsert,loadGoodsContext } from "./goods-store";
import { loadLocationAliases } from "./location-alias-store";
import { resolveLocationAlias } from "./location-aliases";
import { locationCodeKey } from "./location-code";
import { mergeRequiredWarehouseZones,type WarehouseZoneRecord } from "./warehouse-layout";
import { stockProductDetails } from "./stock-product";
import {goodsProductSpec,goodsProductVolume,parseGoodsProductSpec} from "./goods-product-spec";
import {parseInventoryUnit} from "./inventory-unit";
import {DEFAULT_PRICING_SETTINGS,normalizePricingSettings,PRICING_DEFAULTS_KEY} from "./pricing";
import {parseProductBarcodes} from "./product-barcodes";
const text=(v:unknown,max=500)=>{const s=String(v??"").trim();if(s.length>max)throw new GoodsFlowError("填写内容过长",400);return s;};
const nonnegative=(v:unknown,label:string)=>{if((typeof v!=="number"&&typeof v!=="string")||String(v).trim()===""||!Number.isFinite(Number(v))||Number(v)<0)throw new GoodsFlowError(`${label}必须是大于或等于 0 的数字`,400);return Number(v);};
export async function prepareGoodsInbound(context:Awaited<ReturnType<typeof loadGoodsContext>>,body:Record<string,unknown>,user:{id:number;displayName:string},idem:{id:string;fingerprint:string;documentId?:string;documentNumber?:string;kind?:"convert";cartonConversion?:{before:unknown;after:unknown}}) {
  const choice=context.choices.find(c=>c.key===body.key);if(!choice||body.expectedRevision!==context.stored.revision)throw new GoodsFlowError("货物列表已变化，请刷新核对；填写仍保留");
  if(choice.review)throw new GoodsFlowError(choice.reason);
  const expected=body.members as {id:number;version:number}[];if(!Array.isArray(expected)||expected.length!==choice.members.length||choice.members.some(r=>!expected.some(x=>x.id===r.id&&x.version===r.version)))throw new GoodsFlowError("已有货物库存已变化，请刷新核对");
  const unit=parseInventoryUnit(body.inventoryUnit);
  const receipt=body.receipt as Record<string,unknown>;if(!receipt||!Array.isArray(body.placements)||!body.placements.length||body.placements.length>100)throw new GoodsFlowError("请填写入库资料，并选择 1 至 100 个库位",400);
  let combinedBarcode:string|undefined;if(receipt.barcodes!==undefined){try{combinedBarcode=parseProductBarcodes(receipt.barcodes);}catch(e){throw new GoodsFlowError(e instanceof Error?e.message:"条码资料无效",400);}}
  const inboundDate=text(receipt.inboundDate),date=new Date(`${inboundDate}T00:00:00Z`),today=warehouseTodayDate();if(!/^\d{4}-\d{2}-\d{2}$/.test(inboundDate)||!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==inboundDate||inboundDate>today)throw new GoodsFlowError("入库日期无效或晚于今天",400);
  const source=text(receipt.inboundSource);if(!["domestic","return","unspecified"].includes(source))throw new GoodsFlowError("入库来源无效",400);
  // Old drafts can retain packaging counts. Return piece receipts never create packaging inventory.
  const pieceOnlyReturn=source==='return'&&unit!=='box'&&idem.kind!=='convert';
  const condition=text(receipt.productCondition);if(!["","good","damaged"].includes(condition))throw new GoodsFlowError("品相无效",400);
  let productSpec=choice.productSpec??goodsProductSpec(choice.members);
  // Known product measurements are authoritative; the receipt cannot override dimensions or prices.
  if(!goodsProductVolume(productSpec)){
    if(receipt.productSpec){try{productSpec=parseGoodsProductSpec(receipt.productSpec,false);}catch(e){throw new GoodsFlowError(e instanceof Error?e.message:"产品尺寸无效",400);}}
    else if(receipt.billingMode!==undefined){
      // Compatibility for saved receipts from earlier versions which only carried volume.
      if(!["item","box"].includes(text(receipt.billingMode)))throw new GoodsFlowError("产品体积单位无效",400);
      productSpec={...productSpec,billingMode:text(receipt.billingMode) as "item"|"box",itemVolumeM3:nonnegative(receipt.itemVolumeM3??0,"每件立方"),boxVolumeM3:nonnegative(receipt.boxVolumeM3??0,"每箱立方")};
    }
  }
  const mode=productSpec.billingMode,itemVolumeM3=productSpec.itemVolumeM3,boxVolumeM3=productSpec.boxVolumeM3;
  const [pricingRow]=await getDb().select().from(settings).where(eq(settings.key,PRICING_DEFAULTS_KEY));
  let defaults={...DEFAULT_PRICING_SETTINGS} as {defaultRatePerM3Day:number;defaultFreeDays:number};
  if(pricingRow){try{defaults=normalizePricingSettings(JSON.parse(pricingRow.value));}catch{throw new GoodsFlowError("仓储计价设置异常，请到仓储计价检查",500);}}
  const storageRateUsd=defaults.defaultRatePerM3Day,freeDays=defaults.defaultFreeDays;
  const [zonesRow]=await getDb().select().from(settings).where(eq(settings.key,"warehouse_zones"));if(!zonesRow)throw new GoodsFlowError("库位尚未设置，请先建立库位");
  const zones=JSON.parse(zonesRow.value);if(!Array.isArray(zones))throw new GoodsFlowError("地图资料异常，请联系管理员",500);const codes=mergeRequiredWarehouseZones(zones as WarehouseZoneRecord[]).flatMap(z=>z.codes),aliases=await loadLocationAliases();
  const stamp=new Date().toISOString(),beforeCategory=choice.categoryId?context.state.categories.find(c=>c.id===choice.categoryId)!:null,category=beforeCategory?JSON.parse(JSON.stringify(beforeCategory)):materializeGoods(choice,stamp);if(beforeCategory)assertGoodsBalance(category,context.rows);
  category.productSpec=productSpec;
  const inboundSku=choice.sku,requestedSku=text(receipt.sku??'');
  if(requestedSku&&requestedSku!==inboundSku)throw new GoodsFlowError("入库只能继承产品 SKU；请通过产品旁的修改选项统一修改所有库位 SKU");
  const highId=Math.max(0,...context.rows.map(r=>r.id)),rows:GoodsStock[]=[];
  for(const [index,raw] of (body.placements as Record<string,unknown>[]).entries()){
    if(!raw||typeof raw!=="object")throw new GoodsFlowError("库位填写无效",400);const requested=resolveLocationAlias(text(raw.locationCode),aliases),matches=codes.filter(code=>locationCodeKey(code)===locationCodeKey(requested));if(matches.length!==1)throw new GoodsFlowError(`库位 ${requested||"未选择"} 不存在或有重复，请重新选择`,400);
    const quantity=goodsInteger(raw.quantity,"入库件数"),boxes=pieceOnlyReturn?0:goodsInteger(raw.boxes,"入库箱数"),layerCount=goodsInteger(raw.layerCount,"存放层数",1);if(unit==="box"&&(quantity!==0||boxes<=0))throw new GoodsFlowError("箱库存入库件数必须为 0、箱数必须大于 0",400);if((unit==="item"||pieceOnlyReturn)&&quantity<=0)throw new GoodsFlowError("件库存入库件数必须大于 0",400);if(!quantity&&!boxes)throw new GoodsFlowError("每个入库库位必须有件数或箱数",400);
    const strict=receipt.requirePlacementDetails===true,placementCondition=text(strict?raw.productCondition:raw.productCondition??condition);
    if(!(strict?["good","damaged"]:["","good","damaged"]).includes(placementCondition))throw new GoodsFlowError(strict?"请为每个库位选择正品或残次品":"品相无效",400);
    const details=stockProductDetails({product:category.product,productPrefix:text(strict?raw.productPrefix:raw.productPrefix??receipt.productPrefix),productCondition:placementCondition});
    let placementBarcode:string|undefined;if(raw.barcodes!==undefined){try{placementBarcode=parseProductBarcodes(raw.barcodes);}catch(e){throw new GoodsFlowError(e instanceof Error?e.message:"库位条码资料无效",400);}}
    const aliasesBarcode=placementBarcode??combinedBarcode;
    const effectiveDate=idem.kind==='convert'&&raw.inboundDate!==undefined?text(raw.inboundDate):inboundDate;
    if(!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)||!Number.isFinite(Date.parse(effectiveDate))||new Date(effectiveDate).toISOString().slice(0,10)!==effectiveDate||effectiveDate>today)throw new GoodsFlowError("原库位入库日期无效",400);
    const effectiveOrder=idem.kind==='convert'&&raw.inboundOrder!==undefined?text(raw.inboundOrder):text(receipt.inboundOrder);
    const palletCount=palletCountValue(raw.palletCount,1);if(!Number.isFinite(palletCount))throw new GoodsFlowError("托盘数格式不正确，可填写 1、1/3、0.5",400);
    const row:GoodsStock={id:highId+index+1,locationCode:matches[0],product:details.name,productPrefix:details.prefix,productCondition:details.condition,customerName:category.customerName,sku:inboundSku,fnsku:aliasesBarcode===undefined?text(receipt.fnsku??choice.members[0]?.fnsku??""):"",barcode:aliasesBarcode??text(receipt.barcode??category.barcode),inboundDate:effectiveDate,inboundOrder:effectiveOrder,totalQuantity:quantity,totalBoxes:boxes,inventoryUnit:unit==="box"?"box":"item",inventoryReviewDecision:unit==="box"?"confirm":"",palletCount,palletManual:raw.palletManual===true||(raw.palletManual===undefined&&palletCount!==1),palletLabel:palletLabel(palletCount,String(raw.palletCount??"")),layerCount,inboundSource:source,billingMode:mode,itemVolumeM3,boxVolumeM3,storageRateUsd,freeDays,catalogItemId:null,note:text(raw.note??receipt.note,20000),updatedBy:user.displayName,updatedAt:stamp,version:0};rows.push(row);category.stockIds.push(row.id);category.lots.push({id:crypto.randomUUID(),stockId:row.id,quantity,boxes,snapshot:{...row}});
  }
  if(body.quantity!==undefined&&goodsInteger(body.quantity,'本次总件数')!==rows.reduce((n,r)=>n+r.totalQuantity,0)||!pieceOnlyReturn&&body.boxes!==undefined&&goodsInteger(body.boxes,'本次总箱数')!==rows.reduce((n,r)=>n+r.totalBoxes,0))throw new GoodsFlowError('各库位入库合计与本次总数量不一致',400);
  if(source==='return'){
    if(pieceOnlyReturn&&mode==='box')throw new GoodsFlowError('此退货件库存当前按箱计费，请先在仓储计价核对为按件后再入库；本次未入库',400);
    if(unit==='box'&&mode!=='box')throw new GoodsFlowError("此退货产品当前按件计价，无法由箱数推算件数；请先在仓储计价核对产品计价资料后再按箱入库",400);
    const totalCount=rows.reduce((n,r)=>n+(mode==='box'?r.totalBoxes:r.totalQuantity),0);
    if(!totalCount)throw new GoodsFlowError(`退货按${mode==='box'?'箱':'件'}计费时，${mode==='box'?'箱数':'件数'}必须大于 0，请核对计价方式`,400);
    // Physical receiving is independent of missing measurements. pricingReview below keeps fees pending.
  }
  category.sku||=inboundSku;
  // Receipt aliases belong to the new physical rows. Product search aggregates those rows separately.
  const state={categories:[...context.state.categories.filter(c=>c.id!==category.id),category]},result={ok:true,...(idem.kind==="convert"?{operationId:idem.id}:{}),...(idem.cartonConversion?{cartonConversion:idem.cartonConversion}:{}),customerName:category.customerName,...(idem.documentId?{documentId:idem.documentId,documentNumber:idem.documentNumber}:{}),categoryId:category.id,key:`category:${category.id}`,stocks:rows,pricingReview:source==="return"&&((mode==="item"&&!itemVolumeM3)||(mode==="box"&&!boxVolumeM3))};
  const zoneGuard=env.DB.prepare("INSERT INTO goods_transaction_guards(id,valid) VALUES (?,CASE WHEN EXISTS(SELECT 1 FROM settings WHERE key='warehouse_zones' AND value=?) THEN 1 ELSE 0 END)").bind(`${idem.id}:zones`,zonesRow.value);
  const queries=[zoneGuard,...rows.map(goodsStockInsert),...goodsPalletModeWrites(rows),goodsAudit(user,idem.id,idem.kind??"inbound",category.product,`${idem.documentNumber?`系统单号 ${idem.documentNumber}｜`:""}${category.product}｜客户 ${category.customerName}｜${idem.kind==='convert'?'箱库存转换成产品库存，原入库日期 '+inboundDate:'货物入库'}｜数量 +${rows.reduce((n,r)=>n+r.totalQuantity,0)}｜箱数 +${rows.reduce((n,r)=>n+r.totalBoxes,0)}｜${rows.length} 个库位记录`,[],rows,stamp),goodsOperation({id:idem.id,kind:idem.kind??"inbound",categoryId:category.id,fingerprint:idem.fingerprint,beforeCategory,afterCategory:category,beforeRows:[],afterRows:rows,settlementIds:[],result,stamp}),goodsFinish(`${idem.id}:zones`)];return {queries,state,result,rows:result.stocks};
}
