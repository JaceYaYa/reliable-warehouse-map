import { splitProductPrefix, stockProductDetails } from "./stock-product";
import {commonMatchedProduct,matchedProductParts} from "./product-match";
import {productBarcodeOverlap,splitProductBarcodes} from "./product-barcodes";
export type InventoryStock = {
  inventoryUnit?:string; inventoryReviewDecision?:string; id?: number; product: string; productPrefix?: string; productCondition?: string; customerName: string; sku?: string; fnsku?:string; barcode?: string;
  totalQuantity: number; totalBoxes: number; locationCode: string; layerCount: number;
  inboundDate: string; inboundOrder?: string; note?: string; inboundSource?: string; version?: number;
};
export type InventoryMember<T extends InventoryStock> = { stock: T; name: string; prefix: string; damaged: boolean; productView?:{product:string;productPrefix:string} };
export type InventoryGroup<T extends InventoryStock> = {
  key: string; product: string; customer: string; sku: string; barcode: string;
  members: InventoryMember<T>[]; quantity: number; boxes: number; damagedQuantity: number;
  locations: string[]; reason: string; review: boolean; boxOnly: boolean; associationIds?: string[];
};
const clean = (v?: string) => (v || "").normalize("NFKC").trim().replace(/\s+/g, " ");
const nameKey = (v: string) => clean(v).toLowerCase().replace(/\bpro\s+max\b/g, "promax");

// Only operational prefixes are removed. Colour, model, card and package variants stay in the name.
export function splitInventoryPrefix(value: string) {
  const {name,prefix,damaged}=splitProductPrefix(value);
  return {name,prefix,damaged};
}
const orderOnly = (name: string) => /^(?:(?:\S+\s*)?入库货物\s*)?(?:IB\d+[A-Z0-9-]*|FBA[A-Z0-9]+)$/i.test(name);
const unknownName = (name: string) => !name || /^(?:未知|未开箱|待确认|未命名|不详)(?:产品|商品|货物|箱)?$/.test(name);

export const isBoxInventoryStock=(stock:InventoryStock)=>stock.inventoryUnit==="box"||(!stock.inventoryUnit&&stock.totalQuantity===0&&stock.totalBoxes>0);

/** Derived associations: original rows, IDs, quantities and dates are never rewritten. */
export function groupInventory<T extends InventoryStock>(stocks: readonly T[]): InventoryGroup<T>[] {
  type Cluster = {customer: string; sku: string; barcode: string; members: InventoryMember<T>[]; reason: string; review: boolean};
  const clusters: Cluster[] = [];
  const rows = stocks.map(stock => {const details=stockProductDetails(stock);return {stock,name:details.name,prefix:details.label,damaged:details.damaged}}).sort((a,b) => (a.stock.id || 0) - (b.stock.id || 0));
  const add = (row: InventoryMember<T>, reason = "", review = false) => {
    const c: Cluster = {customer: clean(row.stock.customerName), sku: clean(row.stock.sku), barcode: clean(row.stock.barcode), members: [row], reason, review};
    clusters.push(c); return c;
  };
  const candidates = (row: InventoryMember<T>, byName = false) => {
    const customer = clean(row.stock.customerName), sku = clean(row.stock.sku);
    return clusters.filter(c => c.customer === customer && !c.review && isBoxInventoryStock(c.members[0].stock)===isBoxInventoryStock(row.stock) &&
      !(sku && c.sku && sku !== c.sku) &&
      (byName ? c.members.some(m => nameKey(m.name) === nameKey(row.name)) : sku && c.sku === sku));
  };
  const attach = (c: Cluster, row: InventoryMember<T>) => {c.members.push(row); c.sku ||= clean(row.stock.sku); c.barcode ||= clean(row.stock.barcode);};
  const eligible = rows.filter(row => {
    if (!clean(row.stock.customerName)) {add(row, "客户未填写，单独保留", true); return false;}
    return true;
  });
  // SKU anchors come first. Barcodes describe each batch and do not split the same SKU.
  for (const row of eligible.filter(r => clean(r.stock.sku))) {
    const match = candidates(row).find(c => c.sku === clean(row.stock.sku));
    if (match) attach(match,row); else add(row);
  }
  const withoutSku=eligible.filter(r=>!clean(r.stock.sku)).sort((a,b)=>Number(Boolean(clean(b.stock.barcode)))-Number(Boolean(clean(a.stock.barcode)))||(a.stock.id||0)-(b.stock.id||0));
  for (const row of withoutSku) {
    if(unknownName(row.name)){add(row,"产品名称不明确，单独保留",true);continue;}
    // A clear name is sufficient when it has one compatible SKU (or none), even across barcodes.
    const named=candidates(row,true);
    if(named.length===1){attach(named[0],row);continue;}
    // A real barcode may resolve an ambiguous SKU, but never override a different product name.
    const identified=named.filter(c=>c.members.some(m=>productBarcodeOverlap([row.stock.fnsku,row.stock.barcode],[m.stock.fnsku,m.stock.barcode])));
    if(identified.length===1){attach(identified[0],row);continue;}
    const skuConflict=new Set(named.map(c=>c.sku).filter(Boolean)).size>1;
    if(skuConflict){add(row,"同名货物的 SKU 不同，单独保留",true);continue;}
    add(row);
  }
  return clusters.map(c => {
    const members = c.members.slice().sort((a,b) => a.stock.inboundDate.localeCompare(b.stock.inboundDate) || (a.stock.id || 0) - (b.stock.id || 0));
    const named = members.find(m => !orderOnly(m.name)) || members[0];
    const boxOnly = members.every(m => orderOnly(m.name));
    const conflict = clusters.some(other => other !== c && other.customer === c.customer && c.members.some(m => other.members.some(n => nameKey(m.name) === nameKey(n.name))) &&
      (c.sku && other.sku && c.sku !== other.sku));
    const sameName=members.every(m=>nameKey(m.name)===nameKey(named.name)),barcodes=splitProductBarcodes(...members.flatMap(m=>[m.stock.fnsku,clean(m.stock.barcode)]));
    const reason = c.reason || (conflict ? "同名但 SKU 不同，分别保留" : boxOnly ? "按相同单号关联；箱内产品未登记" : c.sku ? "按相同 SKU 关联" : sameName ? "按同客户、同产品名称关联" : "按相同条码关联");
    const product=(c.sku&&!sameName?commonMatchedProduct(members.map(m=>m.name)):"")||named.name||"未命名货物";
    const displayed=c.sku&&!sameName?members.map(m=>{const parts=matchedProductParts(m.stock,product);return {...m,name:product,prefix:parts.label,productView:{product,productPrefix:parts.prefix}}}):members;
    return {key: `${c.customer}:${c.sku}:${c.barcode}:${members.map(m=>m.stock.id).sort((a,b)=>(a||0)-(b||0)).join(",")}`, product, customer: c.customer,
      sku:c.sku, barcode:barcodes.join(" / "), members:displayed, quantity:members.reduce((n,m)=>n+m.stock.totalQuantity,0), boxes:members.reduce((n,m)=>n+m.stock.totalBoxes,0),
      damagedQuantity:members.filter(m=>m.damaged).reduce((n,m)=>n+m.stock.totalQuantity,0), locations:[...new Set(members.map(m=>m.stock.locationCode))].sort((a,b)=>a.localeCompare(b, "zh-CN", {numeric:true})), reason, review:c.review || Boolean(conflict), boxOnly};
  }).sort((a,b)=>a.customer.localeCompare(b.customer,"zh-CN") || a.product.localeCompare(b.product,"zh-CN",{numeric:true}));
}

export function filterInventory<T extends InventoryStock>(groups: readonly InventoryGroup<T>[], mode: "product"|"box", customer: string | readonly string[], query: string, status = "all") {
  const q = nameKey(query);
  const customers=typeof customer==="string"?customer?[customer]:[]:customer;
  return groups.filter(g => (!customers.length || customers.includes(g.customer) || (customers.includes("__missing__") && !g.customer)) &&
    (status === "all" || (status === "linked" ? g.members.length > 1 : status === "review" ? g.review : g.members.length === 1)) &&
    (mode === "box" ? g.members.every(m=>isBoxInventoryStock(m.stock)) : g.members.every(m=>!isBoxInventoryStock(m.stock))) && (!q || [g.product,g.customer,g.sku,g.barcode,...g.members.flatMap(m=>[m.stock.product,m.prefix,m.stock.inboundOrder||"",m.stock.locationCode,m.stock.note||""])].some(v=>nameKey(v).includes(q))));
}

/** Physical views exclude exhausted rows; history and cost references retain them. */
export function physicalInventoryStocks<T extends {totalQuantity:number;totalBoxes:number}>(stocks:readonly T[]):T[]{return stocks.filter(s=>s.totalQuantity>0||s.totalBoxes>0);}
/** A label only describes the group if shared by all active members. */
export function inventorySharedLabels(group:InventoryGroup<InventoryStock>):string[]{const members=group.members.filter(m=>m.stock.totalQuantity>0||m.stock.totalBoxes>0);if(!members.length)return [];const first=members[0].prefix;return first&&members.every(m=>m.prefix===first)?[first]:[];}
