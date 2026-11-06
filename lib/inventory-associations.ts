import {isBoxInventoryStock} from './inventory-groups';
import { groupInventory, type InventoryGroup, type InventoryStock } from "./inventory-groups";
import { stockProductDetails, splitProductPrefix } from "./stock-product";
import {commonMatchedProduct, matchedProductParts} from "./product-match";
import {productBarcodeOverlap,splitProductBarcodes} from "./product-barcodes";

export const INVENTORY_ASSOCIATIONS_KEY = "inventory_associations_v1";
export type InventoryAssociation = {
  id: string; product: string; customer: string; createdAt: string; createdBy: string;
  members: { stockId: number; identity: string; productPrefix?: string }[];
};
export type ReviewGroup = { product: string; members: { stockId: number; identity: string }[] };
export type InventoryReview = {
  id: string; action: "link" | "exclude" | "unlink"; customer: string; product: string;
  groups: ReviewGroup[]; createdAt: string; createdBy: string;
  before: InventoryAssociation[]; after: InventoryAssociation[];
  revertedAt?: string; revertedBy?: string;
};
export type AssociationState = { revision: number; associations: InventoryAssociation[]; reviews?: InventoryReview[] };
export const emptyAssociationState = (): AssociationState => ({ revision: 0, associations: [] });
const clean = (s = "") => s.normalize("NFKC").trim().replace(/\s+/g, " ");
export const inventoryIdentity = (s: InventoryStock) => JSON.stringify([clean(s.customerName), stockProductDetails(s).name, clean(s.sku), ""]);
function canonicalIdentity(identity:string) {
  try {const values=JSON.parse(identity);if(!Array.isArray(values)||values.length!==4||values.some(v=>typeof v!=="string"))return identity;values[1]=splitProductPrefix(values[1]).name;values[3]="";return JSON.stringify(values)}catch{return identity}
}
function memberMatches(stock:InventoryStock, association:InventoryAssociation, member:InventoryAssociation["members"][number]) {
  if(inventoryIdentity(stock)===canonicalIdentity(member.identity))return true;
  // Saving the displayed common name/marker is an ordinary normalization of this explicitly matched record.
  if(member.productPrefix===undefined||stockProductDetails(stock).name!==splitProductPrefix(association.product).name)return false;
  try{const old=JSON.parse(canonicalIdentity(member.identity));return old[0]===clean(stock.customerName)&&old[2]===clean(stock.sku)}catch{return false}
}
export function parseAssociationState(value?: string | null): AssociationState {
  if (!value) return emptyAssociationState();
  const state = JSON.parse(value) as AssociationState;
  if (!Number.isSafeInteger(state.revision) || state.revision < 0 || !Array.isArray(state.associations) || state.associations.some(a =>
    !a || typeof a.id !== "string" || typeof a.product !== "string" || typeof a.customer !== "string" || !Array.isArray(a.members) ||
    a.members.some(m => !Number.isSafeInteger(m.stockId) || m.stockId <= 0 || typeof m.identity !== "string" || (m.productPrefix !== undefined && typeof m.productPrefix !== "string")))) throw new Error("关联记录格式不正确");
  if (state.reviews !== undefined && (!Array.isArray(state.reviews) || state.reviews.some(r =>
    !r || typeof r.id !== "string" || !["link", "exclude", "unlink"].includes(r.action) || typeof r.customer !== "string" || typeof r.product !== "string" || typeof r.createdAt !== "string" || typeof r.createdBy !== "string" ||
    !Array.isArray(r.groups) || r.groups.some(g => !g || typeof g.product !== "string" || !Array.isArray(g.members) || g.members.some(m => !Number.isSafeInteger(m.stockId) || m.stockId <= 0 || typeof m.identity !== "string")) ||
    !Array.isArray(r.before) || !Array.isArray(r.after) || (r.revertedAt !== undefined && typeof r.revertedAt !== "string") ||
    [...r.before, ...r.after].some(a => !a || typeof a.id !== "string" || typeof a.product !== "string" || typeof a.customer !== "string" || !Array.isArray(a.members) || a.members.some(m => !Number.isSafeInteger(m.stockId) || m.stockId <= 0 || typeof m.identity !== "string" || (m.productPrefix !== undefined && typeof m.productPrefix !== "string")))
  ))) throw new Error("核对记录格式不正确");
  return state;
}

export const reviewGroup = <T extends InventoryStock>(group: InventoryGroup<T>): ReviewGroup => ({product: group.product, members: group.members.map(m => ({stockId: m.stock.id!, identity: inventoryIdentity(m.stock)}))});
const memberSignature = (group: ReviewGroup) => JSON.stringify(group.members.map(m => [m.stockId, canonicalIdentity(m.identity)]).sort((a, b) => Number(a[0]) - Number(b[0])));
/** Decisions cover exactly the reviewed records; changed identities or new members require a fresh review. */
export function excludedInventoryPair<T extends InventoryStock>(left: InventoryGroup<T>, right: InventoryGroup<T>, state: AssociationState) {
  const excluded=(state.reviews || []).filter(r=>r.action==="exclude"&&!r.revertedAt);
  if (!excluded.length) return false;
  const pair = [memberSignature(reviewGroup(left)), memberSignature(reviewGroup(right))].sort();
  return excluded.some(r => r.customer === left.customer && JSON.stringify(r.groups.map(memberSignature).sort()) === JSON.stringify(pair));
}
/** Older manual links remain visible and reversible even before review history was introduced. */
export function inventoryReviewHistory(state: AssociationState): InventoryReview[] {
  const reviews = state.reviews || [], known = new Set(reviews.flatMap(r => r.after.map(a => a.id)));
  const legacy = state.associations.filter(a => !known.has(a.id)).map(a => ({id: `legacy:${a.id}`, action: "link" as const, customer: a.customer, product: a.product, groups: [{product: a.product, members: a.members}], createdAt: a.createdAt || "", createdBy: a.createdBy || "原记录", before: [], after: [a]}));
  return [...reviews, ...legacy].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export function canUndoInventoryReview(review: InventoryReview, state: AssociationState) {
  if (review.revertedAt) return false;
  if (review.action === "exclude") return true;
  const ids = new Set([...review.groups.flatMap(g => g.members.map(m => m.stockId)), ...review.before.flatMap(a => a.members.map(m => m.stockId))]);
  const current = state.associations.filter(a => a.members.some(m => ids.has(m.stockId)));
  const canonical = (rules: InventoryAssociation[]) => JSON.stringify([...rules].sort((a, b) => a.id.localeCompare(b.id)));
  return canonical(current) === canonical(review.after);
}

/** Human associations overlay the original rows; inventory and billing rows are never rewritten. */
export function associatedInventory<T extends InventoryStock>(stocks: readonly T[], state: AssociationState): InventoryGroup<T>[] {
  const groups = groupInventory(stocks);
  const parent = groups.map((_, i) => i), byStock = new Map<number, number>();
  groups.forEach((g, i) => g.members.forEach(m => { if (m.stock.id) byStock.set(m.stock.id, i); }));
  const find = (i: number): number => parent[i] === i ? i : (parent[i] = find(parent[i]));
  const active: InventoryAssociation[] = [], stale = new Set<number>();
  for (const association of state.associations) {
    const members = association.members.filter(m => byStock.has(m.stockId));
    if (members.some(m => {
      const stock = groups[byStock.get(m.stockId)!].members.find(n => n.stock.id === m.stockId)!.stock;
      return !memberMatches(stock,association,m) || clean(stock.customerName) !== association.customer;
    })) { members.forEach(m => stale.add(byStock.get(m.stockId)!)); continue; }
    const indexes = members.map(m => byStock.get(m.stockId)!);
    if(new Set(indexes.map(i=>isBoxInventoryStock(groups[i].members[0].stock))).size>1){indexes.forEach(i=>stale.add(i));continue;}
    if (!indexes.length) continue;
    active.push(association);
    indexes.slice(1).forEach(i => { parent[find(i)] = find(indexes[0]); });
  }
  const buckets = new Map<number, number[]>();
  groups.forEach((_, i) => { const root = find(i); buckets.set(root, [...(buckets.get(root) || []), i]); });
  return [...buckets.values()].map(indexes => {
    const originals = indexes.map(i => groups[i]);
    const members = originals.flatMap(g => g.members).sort((a, b) => a.stock.inboundDate.localeCompare(b.stock.inboundDate) || (a.stock.id || 0) - (b.stock.id || 0));
    const ids = new Set(members.map(m => m.stock.id));
    const rules = active.filter(a => a.members.some(m => ids.has(m.stockId)));
    const outdated = indexes.some(i => stale.has(i));
    if (!rules.length) return { ...originals[0], associationIds: outdated ? state.associations.filter(a => !active.includes(a) && a.members.some(m => ids.has(m.stockId))).map(a => a.id) : undefined,
      review: originals[0].review || outdated, reason: outdated ? "关联后商品资料已修改，请重新核对" : originals[0].reason };
    const unique = (key: "sku" | "barcode") => [...new Set(members.map(m => clean(m.stock[key])).filter(Boolean))];
    let product = splitProductPrefix(rules.at(-1)!.product).name;
    // Older links defaulted to the first full name; derive the shared body for those without replacing a custom display name.
    if (rules.every(r=>r.members.every(m=>m.productPrefix===undefined)) && members.some(m=>stockProductDetails(m.stock).name===product)) product=commonMatchedProduct(members.map(m=>stockProductDetails(m.stock).name))||product;
    const displayed = members.map(m=>{const parts=matchedProductParts(m.stock,product),saved=rules.flatMap(r=>r.members).findLast(row=>row.stockId===m.stock.id&&row.productPrefix!==undefined);const normalized=saved&&inventoryIdentity(m.stock)!==canonicalIdentity(saved.identity);const prefix=normalized?parts.prefix:saved?.productPrefix??parts.prefix;const label=[parts.condition==="damaged"?"残次品":parts.condition==="good"?"正品":"",prefix].filter(Boolean).join(" · ");return {...m,name:product,prefix:label,productView:{product,productPrefix:prefix}}});
    return { ...originals[0], key: `manual:${rules.map(r => r.id).sort().join(",")}`, product,
      members:displayed, sku: unique("sku").join(" / "), barcode: splitProductBarcodes(...members.flatMap(m=>[m.stock.fnsku,m.stock.barcode])).join(" / "),
      quantity: members.reduce((n, m) => n + m.stock.totalQuantity, 0), boxes: members.reduce((n, m) => n + m.stock.totalBoxes, 0),
      damagedQuantity: members.filter(m => m.damaged).reduce((n, m) => n + m.stock.totalQuantity, 0),
      locations: [...new Set(members.map(m => m.stock.locationCode))].sort((a, b) => a.localeCompare(b, "zh-CN", { numeric: true })),
      reason: outdated ? "已人工关联；部分资料已修改，请核对" : "已人工确认同款", review: outdated,
      boxOnly: originals.every(g => g.boxOnly), associationIds: rules.map(r => r.id),
    };
  }).sort((a, b) => a.customer.localeCompare(b.customer, "zh-CN") || a.product.localeCompare(b.product, "zh-CN", { numeric: true }));
}

const compact = (s: string) => clean(s).toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
function similarity(a: string, b: string) {
  if (a === b) return 1;
  if (Math.min(a.length, b.length) < 5) return 0;
  const grams = (s: string) => new Set(Array.from({ length: s.length - 1 }, (_, i) => s.slice(i, i + 2)));
  const x = grams(a), y = grams(b), overlap = [...x].filter(g => y.has(g)).length;
  return (2 * overlap) / (x.size + y.size);
}
export type InventoryCandidate<T extends InventoryStock> = { key: string; left: InventoryGroup<T>; right: InventoryGroup<T>; reason: string; differences: string[]; score: number };
export function inventoryDifferences<T extends InventoryStock>(groups: readonly InventoryGroup<T>[]) {
  const fields = [["产品名称", (g: InventoryGroup<T>) => g.members.map(m => m.name)], ["SKU", (g: InventoryGroup<T>) => g.members.map(m => clean(m.stock.sku)).filter(Boolean)]] as const;
  const differences = fields.filter(([, values]) => new Set(groups.flatMap(values)).size > 1).map(([label]) => `${label}不同`);
  for (const [key, label] of [["sku", "SKU"]] as const) {
    const values = groups.flatMap(g => g.members.map(m => clean(m.stock[key])));
    if (values.some(Boolean) && values.some(v => !v)) differences.push(`${label}部分未填写`);
  }
  return differences;
}
export function inventoryCandidates<T extends InventoryStock>(groups: readonly InventoryGroup<T>[], state: AssociationState = emptyAssociationState()): InventoryCandidate<T>[] {
  const candidates: InventoryCandidate<T>[] = [];
  const excluded=new Set((state.reviews||[]).filter(r=>r.action==="exclude"&&!r.revertedAt).map(r=>JSON.stringify(r.groups.map(memberSignature).sort())));
  const signatures=excluded.size?groups.map(g=>memberSignature(reviewGroup(g))):[];
  for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length; j++) {
    const left = groups[i], right = groups[j];
    if (isBoxInventoryStock(left.members[0].stock)!==isBoxInventoryStock(right.members[0].stock)) continue;
    if (!left.customer || left.customer !== right.customer || left.boxOnly || right.boxOnly || [left, right].some(g => g.reason === "产品名称不明确，单独保留")) continue;
    if (excluded.size && excluded.has(JSON.stringify([signatures[i],signatures[j]].sort()))) continue;
    const sameCode = (key: "sku" | "barcode") => key==="barcode"?productBarcodeOverlap(left.members.flatMap(m=>[m.stock.fnsku,m.stock.barcode]),right.members.flatMap(m=>[m.stock.fnsku,m.stock.barcode])):left.members.some(a=>clean(a.stock.sku)&&right.members.some(b=>clean(a.stock.sku)===clean(b.stock.sku)));
    // Different explicit model numbers are not fuzzy-name recommendations. The user can still search and select them.
    const score = Math.max(...left.members.flatMap(a => right.members.map(b => {
      const x = compact(a.name), y = compact(b.name);
      if (JSON.stringify(x.match(/\d+/g) || []) !== JSON.stringify(y.match(/\d+/g) || [])) return 0;
      return similarity(x, y);
    })));
    if (!sameCode("sku") && !sameCode("barcode") && score < 0.84) continue;
    candidates.push({ key: `${left.key}|${right.key}`, left, right, score,
      reason: sameCode("sku") ? "SKU相同" : sameCode("barcode") ? "产品条形码相同" : score === 1 ? "主体名称相同，写法或编号不同" : "名称相近，请核对型号、颜色和规格",
      differences: inventoryDifferences([left, right]),
    });
  }
  return candidates.sort((a, b) => b.score - a.score || a.left.product.localeCompare(b.left.product, "zh-CN"));
}
