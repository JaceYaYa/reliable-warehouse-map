import type { stocks } from "../db/schema";
import { associatedInventory, type AssociationState } from "./inventory-associations";
import { stockProductDetails } from "./stock-product";
import {goodsProductSpec,parseGoodsProductSpec,type GoodsProductSpec} from "./goods-product-spec";
import {splitProductBarcodes} from "./product-barcodes";
import {palletCountValue,palletCountExceeds,palletRemaining,palletLabel} from "./pallet";
import {clearsReturnPackaging} from './return-packaging';

export type GoodsStock = typeof stocks.$inferSelect & {palletManual?:boolean;palletAutomatic?:boolean;palletRawLabel?:string;palletRawCount?:number};
export type GoodsLot = { id: string; stockId: number; quantity: number; boxes: number; snapshot: GoodsStock };
export type GoodsCategory = { id: string; product: string; customerName: string; sku: string; barcode: string; productSpec?:GoodsProductSpec; identityPending?:true; stockIds: number[]; lots: GoodsLot[]; createdAt: string; confirmed: boolean; archived?:boolean };
export type GoodsState = { categories: GoodsCategory[] };
export type GoodsChoice = { source?:'carton';cartonReceiptId?:string;cartonVersion?:number;cartonRefs?:Record<number,{receiptId:string;placementKey:string;version:number}>; key: string; categoryId?: string; product: string; customerName: string; sku: string; barcode: string; productSpec?:GoodsProductSpec; members: GoodsStock[]; quantity: number; boxes: number; review: boolean; reason: string; archived?:boolean; costBatches?:{inboundDate:string;quantity:number;boxes:number;billingMode:string;inboundSource:string;volumeKnown:boolean}[] };
export class GoodsFlowError extends Error { constructor(message: string, public status = 409) { super(message); } }
const clean = (v: string) => v.normalize("NFKC").trim().replace(/\s+/g," ");
const identity = (v: string) => clean(v).toLowerCase().replace(/\bpro\s+max\b/g,"promax");
export const goodsInteger = (v: unknown, label: string, min = 0) => { if ((typeof v !== "number" && typeof v !== "string") || String(v).trim() === "" || !Number.isSafeInteger(Number(v)) || Number(v) < min) throw new GoodsFlowError(`${label}必须是大于或等于 ${min} 的整数`,400); return Number(v); };
export function parseGoodsState(raw: string): GoodsState {
  let state: GoodsState;
  try { state = JSON.parse(raw); } catch { throw new GoodsFlowError("货物批次数据损坏，请联系管理员",500); }
  const allIds = new Set<number>(), cats = new Set<string>(), lots = new Set<string>();
  if (!state || !Array.isArray(state.categories)) throw new GoodsFlowError("货物批次数据损坏，请联系管理员",500);
  for (const c of state.categories) {
    if (!c || typeof c.id!=="string" || cats.has(c.id) || !c.product?.trim() || (typeof c.customerName!=="string"||(!c.customerName.trim()&&c.identityPending!==true)) || !Array.isArray(c.stockIds) || !Array.isArray(c.lots)) throw new GoodsFlowError("货物类别数据损坏，请联系管理员",500);
    if(c.archived!==undefined&&typeof c.archived!=="boolean")throw new GoodsFlowError("产品停用状态损坏",500);
    if(c.archived&&c.lots.some(l=>l.quantity||l.boxes))throw new GoodsFlowError("停用产品仍有库存批次",500);
    cats.add(c.id);
    if(c.productSpec){try{c.productSpec=parseGoodsProductSpec(c.productSpec);}catch{throw new GoodsFlowError("产品尺寸资料损坏，请联系管理员",500);}}
    for (const id of c.stockIds) { if (!Number.isSafeInteger(id) || id<=0 || allIds.has(id)) throw new GoodsFlowError("货物库位关联重复，请联系管理员",500); allIds.add(id); }
    for (const l of c.lots) { if (!l || typeof l.id!=="string" || lots.has(l.id) || !Number.isSafeInteger(l.quantity) || l.quantity<0 || !Number.isSafeInteger(l.boxes) || l.boxes<0 || !l.snapshot || !c.stockIds.includes(l.stockId) || l.snapshot.id!==l.stockId) throw new GoodsFlowError("货物计价批次数据损坏，请联系管理员",500); lots.add(l.id); }
  }
  return state;
}
export function assertGoodsBalance(category: GoodsCategory, rows: readonly GoodsStock[]) {
  const members = category.stockIds.map(id=>rows.find(r=>r.id===id));
  if (members.some(r=>!r)) throw new GoodsFlowError("货物库位记录已被删除，请核对计价批次后重试");
  if (members.some(r=>clean(r!.customerName)!==clean(category.customerName))) throw new GoodsFlowError("该货物的客户归属不一致，请统一修改客户后再操作");
  for (const key of ["quantity","boxes"] as const) {
    const physical = members.reduce((n,r)=>n+goodsInteger(key==="quantity"?r!.totalQuantity:r!.totalBoxes,"库存数量"),0), cost = category.lots.reduce((n,l)=>n+l[key],0);
    if (physical!==cost) throw new GoodsFlowError("实物数量和计价批次数量不一致，请先核对库存校正记录；本次不会扣货");
  }
}
export function goodsChoices(rows: readonly GoodsStock[], associations: AssociationState, state: GoodsState,includeArchived=false): GoodsChoice[] {
  const managed = new Set(state.categories.flatMap(c=>c.stockIds));
  const choices:GoodsChoice[] = state.categories.filter(c=>includeArchived||!c.archived).map(c=>{
    const members=rows.filter(r=>c.stockIds.includes(r.id)); let review=!!c.identityPending||!c.customerName.trim(),reason=c.identityPending?"产品商家或关联待核对；尺寸资料已保存":"已建立货物类别；仓储计价按原始批次先进先出";
    try { assertGoodsBalance(c,rows); } catch(error) {review=true;reason=error instanceof Error?error.message:"请核对货物批次";}
    return {key:`category:${c.id}`,categoryId:c.id,...(c.archived?{archived:true}:{}),product:stockProductDetails({product:c.product}).name,customerName:c.customerName,sku:c.sku,barcode:splitProductBarcodes(c.barcode,...members.flatMap(r=>[r.fnsku,r.barcode])).join(" / "),productSpec:goodsProductSpec(members,c.productSpec),members,quantity:members.reduce((n,r)=>n+r.totalQuantity,0),boxes:members.reduce((n,r)=>n+r.totalBoxes,0),review,reason,costBatches:c.lots.filter(l=>l.quantity||l.boxes).map(l=>({inboundDate:l.snapshot.inboundDate,quantity:l.quantity,boxes:l.boxes,billingMode:l.snapshot.billingMode,inboundSource:l.snapshot.inboundSource,volumeKnown:l.snapshot.inboundSource!=="return"||(l.snapshot.billingMode==="box"?l.snapshot.boxVolumeM3>0:l.snapshot.itemVolumeM3>0)}))};
  });
  for (const g of associatedInventory(rows.filter(r=>!managed.has(r.id)),associations)) choices.push({key:`group:${g.key}`,product:g.product,customerName:g.customer,sku:g.sku,barcode:g.barcode,productSpec:goodsProductSpec(g.members.map(m=>m.stock)),members:g.members.map(m=>m.stock),quantity:g.quantity,boxes:g.boxes,review:g.review||!g.customer,reason:g.reason,costBatches:g.members.map(m=>({inboundDate:m.stock.inboundDate,quantity:m.stock.totalQuantity,boxes:m.stock.totalBoxes,billingMode:m.stock.billingMode,inboundSource:m.stock.inboundSource,volumeKnown:m.stock.inboundSource!=="return"||(m.stock.billingMode==="box"?m.stock.boxVolumeM3>0:m.stock.itemVolumeM3>0)}))});
  return choices.sort((a,b)=>a.customerName.localeCompare(b.customerName,"zh-CN")||a.product.localeCompare(b.product,"zh-CN",{numeric:true}));
}
export function materializeGoods(choice: GoodsChoice, stamp: string,options:{allowPendingIdentity?:boolean}={}): GoodsCategory {
  if (!options.allowPendingIdentity&&(choice.review || !choice.customerName)) throw new GoodsFlowError("这项货物仍需核对名称或编号，请在库存界面先确认关联，不能自动混合出入库");
  const id=crypto.randomUUID();
  return {id,...(options.allowPendingIdentity&&(choice.review||!choice.customerName)?{identityPending:true as const}:{}),product:choice.product,customerName:choice.customerName,sku:choice.sku,barcode:choice.barcode,productSpec:choice.productSpec,stockIds:choice.members.map(r=>r.id),createdAt:stamp,confirmed:choice.reason.includes("人工"),lots:choice.members.map(r=>({id:crypto.randomUUID(),stockId:r.id,quantity:r.totalQuantity,boxes:r.totalBoxes,snapshot:{...r}}))};
}
export function matchingGoodsCategory(state: GoodsState, input: { product: string; customerName: string; sku: string; barcode: string }) {
  return state.categories.find(c=>!c.archived&&identity(c.customerName)===identity(input.customerName)&&identity(c.product)===identity(input.product)&&identity(c.sku)===identity(input.sku));
}
export function planGoodsOutbound(category: GoodsCategory, rows: readonly GoodsStock[], selected: readonly {id:number;version:number;quantity?:unknown;boxes?:unknown;pallets?:unknown}[], quantity: number, boxes: number, stamp: string, userName: string) {
  assertGoodsBalance(category,rows);
  goodsInteger(quantity,"出库件数"); goodsInteger(boxes,"出库箱数");
  if(!quantity&&!boxes)throw new GoodsFlowError("请填写出库件数或箱数",400);
  if(!selected.length||new Set(selected.map(r=>r.id)).size!==selected.length)throw new GoodsFlowError("请选择不重复的出库库位记录",400);
  const explicit=selected.some(r=>r.quantity!==undefined||r.boxes!==undefined);
  if(explicit&&selected.some(r=>r.quantity===undefined||r.boxes===undefined))throw new GoodsFlowError("请分别填写每个库位的出库件数和箱数",400);
  let qtyLeft=quantity,boxLeft=boxes,automaticClearedBoxes=0;const before:GoodsStock[]=[],after:GoodsStock[]=[],physical:{stockId:number;quantity:number;boxes:number;pallets:number}[]=[];
  for(const ref of selected) {
    const row=rows.find(r=>r.id===ref.id);
    if(!row||!category.stockIds.includes(ref.id))throw new GoodsFlowError("所选库位不属于当前货物，请刷新重试");
    if(row.version!==ref.version)throw new GoodsFlowError("所选库位库存已变化，填写仍保留，请刷新核对");
    const q=explicit?goodsInteger(ref.quantity,"库位出库件数"):Math.min(qtyLeft,row.totalQuantity),b=explicit?goodsInteger(ref.boxes,"库位出库箱数"):Math.min(boxLeft,row.totalBoxes);
    if(q>row.totalQuantity||b>row.totalBoxes)throw new GoodsFlowError(`${row.locationCode} 的出库数量超过可用库存`,400);
    if(explicit&&!q&&!b)throw new GoodsFlowError("每条出库分配必须有件数或箱数",400);
    qtyLeft-=q;boxLeft-=b;
    if(!q&&!b)continue;
    const actualBoxes=clearsReturnPackaging(row,q)?row.totalBoxes:b;automaticClearedBoxes+=actualBoxes-b;
    const requestedPallets=palletCountValue(ref.pallets);if(!Number.isFinite(requestedPallets)||palletCountExceeds(requestedPallets,row.palletCount))throw new GoodsFlowError(`${row.locationCode} 的出库托盘数无效或超过现有托盘数`,400);
    const nextQuantity=row.totalQuantity-q,nextBoxes=row.totalBoxes-actualBoxes,nextPallets=nextQuantity===0&&nextBoxes===0?0:palletRemaining(row.palletCount,requestedPallets);
    const automatic=row.palletAutomatic===true&&nextQuantity+nextBoxes>0&&requestedPallets===0;
    before.push(row);after.push({...row,...(row.palletAutomatic===undefined?{}:{palletAutomatic:automatic,palletManual:!automatic,palletRawCount:automatic?row.palletRawCount:nextPallets,palletRawLabel:automatic?row.palletRawLabel:palletLabel(nextPallets)}),totalQuantity:nextQuantity,totalBoxes:nextBoxes,palletCount:nextPallets,palletLabel:palletLabel(nextPallets),updatedBy:userName,updatedAt:stamp,version:row.version+1});physical.push({stockId:row.id,quantity:q,boxes:actualBoxes,pallets:row.palletCount-nextPallets});
  }
  if(qtyLeft||boxLeft)throw new GoodsFlowError(explicit?"各库位出库合计与本次出库总数量不一致":"勾选库位的件数或箱数不足，请增加库位或调整出库数量",400);
  const next=JSON.parse(JSON.stringify(category)) as GoodsCategory,allocations:{lot:GoodsLot;quantity:number;boxes:number}[]=[];qtyLeft=quantity;boxLeft=boxes+automaticClearedBoxes;
  const lots=next.lots.slice().sort((a,b)=>a.snapshot.inboundDate.localeCompare(b.snapshot.inboundDate)||a.stockId-b.stockId||a.id.localeCompare(b.id));
  for(const lot of lots) {const q=Math.min(qtyLeft,lot.quantity),b=Math.min(boxLeft,lot.boxes);qtyLeft-=q;boxLeft-=b;if(!q&&!b)continue;allocations.push({lot:{...lot,snapshot:{...lot.snapshot}},quantity:q,boxes:b});lot.quantity-=q;lot.boxes-=b;}
  if(qtyLeft||boxLeft)throw new GoodsFlowError("计价批次余量不足，请核对货物");
  return {before,after,category:next,physical,allocations,quantity,pallets:physical.reduce((n,p)=>n+p.pallets,0),boxes:boxes+automaticClearedBoxes,automaticClearedBoxes};
}
/** Pricing rows are cost lots, not the physical locations chosen for picking. */
export function goodsBillingStocks(rows: readonly GoodsStock[], state: GoodsState) {
  const managed=new Set(state.categories.flatMap(c=>c.stockIds)); const result=rows.filter(r=>!managed.has(r.id)).map(r=>({...r,goodsLotId:undefined as string|undefined}));
  for(const c of state.categories) {assertGoodsBalance(c,rows);for(const lot of c.lots)if(lot.quantity||lot.boxes){const physical=rows.find(r=>r.id===lot.stockId);result.push({...lot.snapshot,version:physical?.version??lot.snapshot.version,locationCode:physical?.locationCode??lot.snapshot.locationCode,totalQuantity:lot.quantity,totalBoxes:lot.boxes,customerName:c.customerName,goodsLotId:lot.id});}}
  return result;
}
export function normalizedGoodsIdentity(stock:GoodsStock){const d=stockProductDetails(stock);return {product:d.name,customerName:clean(stock.customerName),sku:clean(stock.sku),barcode:clean(stock.barcode)};}

/** Renaming whole categories may join them; retain every original lot, never collapse dates or quantities. */
export function coalesceGoodsCategories(state:GoodsState):GoodsState {
  const categories:GoodsCategory[]=[];
  const compatible=(a:GoodsCategory,b:GoodsCategory)=>!a.archived&&!b.archived&&identity(a.customerName)===identity(b.customerName)&&identity(a.product)===identity(b.product)&&!(a.sku&&b.sku&&a.sku!==b.sku);
  const sorted=state.categories.slice().sort((a,b)=>Number(Boolean(b.sku))-Number(Boolean(a.sku))||a.createdAt.localeCompare(b.createdAt));
  for(const category of sorted){const matches=categories.filter(c=>compatible(c,category));if(matches.length!==1){categories.push({...category,stockIds:[...category.stockIds],lots:[...category.lots]});continue;}const target=matches[0];target.stockIds.push(...category.stockIds);target.lots.push(...category.lots);target.sku||=category.sku;target.barcode=splitProductBarcodes(target.barcode,category.barcode).join(" / ");target.confirmed||=category.confirmed;}
  return {categories};
}
