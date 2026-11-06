import type { InventoryStock } from "./inventory-groups";
import { stockProductDetails } from "./stock-product";

export const RECORD_TEXT_FIELDS = ["product", "productPrefix", "productCondition", "customerName", "sku", "barcode", "inboundDate", "inboundOrder", "note", "inboundSource"] as const;
export const RECORD_NUMBER_FIELDS = ["totalQuantity", "totalBoxes", "layerCount"] as const;
export type InventoryRecordDraft = Record<typeof RECORD_TEXT_FIELDS[number] | typeof RECORD_NUMBER_FIELDS[number], string>;
export type InventoryRecordPatch = Partial<InventoryRecordDraft> & { id: number; expectedVersion: number };
export type InventoryRecordSave = (patch: InventoryRecordPatch) => Promise<{ ok: boolean; error?: string }>;
export type InventoryBatchPatch = { records: {id:number;expectedVersion:number}[]; product?:string;customerName?:string;requestId?:string;confirmed?:boolean };
export type InventoryBatchSave = (patch:InventoryBatchPatch)=>Promise<{ok:boolean;error?:string;status?:number}>;

export function recordDraft(stock: InventoryStock): InventoryRecordDraft {
  const details=stockProductDetails(stock);
  return {
    product: details.name, productPrefix:details.prefix, productCondition:details.condition, customerName: stock.customerName, sku: stock.sku || "", barcode: stock.barcode || "",
    inboundDate: stock.inboundDate, inboundOrder: stock.inboundOrder || "", note: stock.note || "", inboundSource: stock.inboundSource || "unspecified",
    totalQuantity: String(stock.totalQuantity), totalBoxes: String(stock.totalBoxes), layerCount: String(stock.layerCount || 1),
  };
}
export function recordPatch(stock: InventoryStock, draft: InventoryRecordDraft): { patch?: InventoryRecordPatch; error?: string } {
  if (!stock.id) return { error: "这条库存记录没有有效编号" };
  if (!draft.product.trim()) return { error: "请填写产品名称" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.inboundDate)) return { error: "请填写有效的入库日期" };
  for (const key of RECORD_NUMBER_FIELDS) {
    const min = key === "layerCount" ? 1 : 0;
    if (!draft[key].trim() || !Number.isSafeInteger(Number(draft[key])) || Number(draft[key]) < min) return { error: key === "layerCount" ? "层数必须是大于或等于1的整数" : "件数和箱数必须是大于或等于0的整数，不能为空" };
  }
  const original = recordDraft(stock), patch: InventoryRecordPatch = { id: stock.id, expectedVersion: stock.version ?? 0 };
  for (const key of [...RECORD_TEXT_FIELDS, ...RECORD_NUMBER_FIELDS]) if (draft[key] !== original[key]) patch[key] = draft[key];
  if (Object.keys(patch).length === 2) return { error: "没有修改内容" };
  // Persist the separate legacy annotations with the canonical name on the first correction.
  if (stock.product!==draft.product || stock.productPrefix!==draft.productPrefix || stock.productCondition!==draft.productCondition) {
    patch.product=draft.product;patch.productPrefix=draft.productPrefix;patch.productCondition=draft.productCondition;
  }
  return { patch };
}
