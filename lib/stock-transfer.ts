import type { stocks } from "../db/schema.ts";
import { locationCodeKey } from "./location-code.ts";
import { palletLabel, palletCountValue, palletCountExceeds, palletRemaining } from "./pallet.ts";

export type StockRow = typeof stocks.$inferSelect & {palletManual?:boolean;palletAutomatic?:boolean;palletRawCount?:number;palletRawLabel?:string};
export type MoveMode = "all" | "partial";

export type TransferAmounts = {
  quantity: number;
  boxes: number;
  pallets: number;
};

export type TransferPlan = {
  mode: MoveMode;
  moved: TransferAmounts;
  sourceAfter: StockRow | null;
  destinationAfter: StockRow;
};

export type StockTransferEnvelope = {
  kind: "stock-transfer";
  snapshotVersion: 1;
  operationId: string;
  mode: MoveMode;
  sourceLocation: string;
  targetLocation: string;
  rows: StockRow[];
};

export type CapacityStatus = {
  locationCode: string;
  capacityBoxes: number;
  capacityPallets: number;
  beforeBoxes: number;
  beforePallets: number;
  afterBoxes: number;
  afterPallets: number;
  overBoxes: boolean;
  overPallets: boolean;
  boxOverflow: number;
  palletOverflow: number;
};

export class TransferValidationError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "TransferValidationError";
    this.status = status;
  }
}

const roundPallets = (value: number) => Math.max(0, Number(value.toFixed(8)));

function nonNegativeInteger(value: unknown, label: string) {
  const parsed = Number(value ?? 0);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new TransferValidationError(`${label}必须是大于或等于0的整数`);
  }
  return parsed;
}

function nonNegativePallets(value: unknown) {
  const parsed = palletCountValue(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new TransferValidationError("移动托盘数格式不正确，可填写 1、1/3、1/4、0.5");
  }
  return parsed;
}

function positiveLayerCount(value: unknown, fallback: number, label: string) {
  if (value === undefined || value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new TransferValidationError(`${label}必须是大于或等于1的整数`);
  }
  return parsed;
}

export function planStockTransfer(input: {
  before: StockRow;
  targetLocation: string;
  mode: MoveMode;
  ignorePallets?: boolean;
  quantity?: unknown;
  boxes?: unknown;
  pallets?: unknown;
  sourceRemainingLayerCount?: unknown;
  targetLayerCount?: unknown;
  userName: string;
  stamp: string;
}): TransferPlan {
  const { before, targetLocation, mode, userName, stamp } = input;
  if (!targetLocation.trim()) throw new TransferValidationError("请选择目标库位");
  if (locationCodeKey(targetLocation) === locationCodeKey(before.locationCode)) throw new TransferValidationError("目标库位不能与当前库位相同");

  if (mode === "all") {
    const targetLayerCount = positiveLayerCount(input.targetLayerCount, before.layerCount, "目标库位层数");
    const destinationAfter: StockRow = {
      ...before,
      locationCode: targetLocation,
      layerCount: targetLayerCount,
      updatedBy: userName,
      updatedAt: stamp,
      version: before.version + 1,
    };
    return {
      mode,
      moved: {
        quantity: before.totalQuantity,
        boxes: before.totalBoxes,
        pallets: before.palletCount,
      },
      sourceAfter: null,
      destinationAfter,
    };
  }

  if (mode !== "partial") throw new TransferValidationError("移动方式无效");
  const quantity = nonNegativeInteger(input.quantity, "移动件数");
  const boxes = nonNegativeInteger(input.boxes, "移动箱数");
  let pallets = nonNegativePallets(input.pallets);
  const sourceRemainingLayerCount = positiveLayerCount(input.sourceRemainingLayerCount, before.layerCount, "来源剩余层数");
  const targetLayerCount = positiveLayerCount(input.targetLayerCount, before.layerCount, "目标库位层数");
  if (quantity === 0 && boxes === 0) {
    throw new TransferValidationError("移动件数或箱数至少填写一项");
  }
  if (quantity > before.totalQuantity || boxes > before.totalBoxes || palletCountExceeds(pallets,before.palletCount)) {
    throw new TransferValidationError("移动数量不能超过当前库存");
  }

  const nextQuantity = before.totalQuantity - quantity;
  const nextBoxes = before.totalBoxes - boxes;
  const nextPallets = palletRemaining(before.palletCount,pallets);
  pallets=before.palletCount-nextPallets;
  if (nextQuantity === 0 && nextBoxes === 0) {
    throw new TransferValidationError("本次已包含全部库存，请选择整批移动");
  }

  // Return-stock billing must remain valid on both sides after a split. A whole
  // move does not split the pricing basis and is therefore always allowed.
  if (before.inboundSource === "return") {
    if (before.billingMode === "box") {
      if (boxes <= 0 || nextBoxes <= 0) {
        throw new TransferValidationError("退货按箱计费库存部分移动时，原库位和目标库位都必须保留箱数；如需全部移动请选择整批移动");
      }
    } else if (quantity <= 0 || nextQuantity <= 0) {
      throw new TransferValidationError("退货按件计费库存部分移动时，原库位和目标库位都必须保留件数；如需全部移动请选择整批移动");
    }
  }

  const sourceAfter: StockRow = {
    ...before,
    totalQuantity: nextQuantity,
    totalBoxes: nextBoxes,
    palletCount: nextPallets,
    palletLabel: palletLabel(nextPallets),
    ...(before.palletManual!==undefined||before.palletAutomatic!==undefined?{palletManual:true,palletAutomatic:false,palletRawCount:nextPallets,palletRawLabel:palletLabel(nextPallets)}:{}),
    layerCount: sourceRemainingLayerCount,
    updatedBy: userName,
    updatedAt: stamp,
    version: before.version + 1,
  };
  const destinationAfter: StockRow = {
    ...before,
    id: 0,
    locationCode: targetLocation,
    totalQuantity: quantity,
    totalBoxes: boxes,
    palletCount: pallets,
    palletLabel: palletLabel(pallets),
    ...(before.palletManual!==undefined||before.palletAutomatic!==undefined?{palletManual:true,palletAutomatic:false,palletRawCount:pallets,palletRawLabel:palletLabel(pallets)}:{}),
    layerCount: targetLayerCount,
    updatedBy: userName,
    updatedAt: stamp,
    version: 0,
  };
  return { mode, moved: { quantity, boxes, pallets }, sourceAfter, destinationAfter };
}

export function calculateCapacityStatus(input: {
  locationCode: string;
  capacityBoxes?: unknown;
  capacityPallets?: unknown;
  beforeBoxes?: unknown;
  beforePallets?: unknown;
  afterBoxes?: unknown;
  afterPallets?: unknown;
}) {
  const finite = (value: unknown) => {
    const number = Number(value ?? 0);
    return Number.isFinite(number) && number > 0 ? number : 0;
  };
  const nonNegative = (value: unknown) => {
    const number = Number(value ?? 0);
    return Number.isFinite(number) ? Math.max(0, number) : 0;
  };
  const capacityBoxes = finite(input.capacityBoxes);
  const capacityPallets = finite(input.capacityPallets);
  const beforeBoxes = nonNegative(input.beforeBoxes);
  const beforePallets = nonNegative(input.beforePallets);
  const afterBoxes = nonNegative(input.afterBoxes);
  const afterPallets = nonNegative(input.afterPallets);
  const overBoxes = capacityBoxes > 0 && afterBoxes > capacityBoxes;
  const overPallets = capacityPallets > 0 && afterPallets > capacityPallets + 1e-9;
  const status: CapacityStatus = {
    locationCode: input.locationCode,
    capacityBoxes,
    capacityPallets,
    beforeBoxes,
    beforePallets,
    afterBoxes,
    afterPallets,
    overBoxes,
    overPallets,
    boxOverflow: overBoxes ? afterBoxes - capacityBoxes : 0,
    palletOverflow: overPallets ? roundPallets(afterPallets - capacityPallets) : 0,
  };
  const exceeded = [
    overBoxes ? `箱数 ${afterBoxes}/${capacityBoxes}` : "",
    overPallets ? `托盘 ${palletLabel(afterPallets)}/${palletLabel(capacityPallets)}` : "",
  ].filter(Boolean);
  return {
    capacity: status,
    warning: exceeded.length ? `目标库位 ${input.locationCode} 移动后将超过容量：${exceeded.join("，")}` : null,
  };
}

export const snapshotFields = (row: StockRow): StockRow => ({
  ...(row.palletManual===undefined?{}:{palletManual:row.palletManual,palletAutomatic:row.palletAutomatic,palletRawCount:row.palletRawCount,palletRawLabel:row.palletRawLabel}),
  id: row.id,
  locationCode: row.locationCode,
  inboundDate: row.inboundDate,
  product: row.product,
  productPrefix: row.productPrefix ?? "", productCondition: row.productCondition ?? "", inventoryUnit:row.inventoryUnit??"item",inventoryReviewDecision:row.inventoryReviewDecision??"",
  sku: row.sku ?? "", fnsku: row.fnsku ?? "",
  barcode: row.barcode,
  inboundOrder: row.inboundOrder,
  totalQuantity: row.totalQuantity,
  totalBoxes: row.totalBoxes,
  customerName: row.customerName,
  palletCount: row.palletCount,
  palletLabel: row.palletLabel,
  layerCount: row.layerCount,
  inboundSource: row.inboundSource,
  billingMode: row.billingMode,
  itemVolumeM3: row.itemVolumeM3,
  boxVolumeM3: row.boxVolumeM3,
  storageRateUsd: row.storageRateUsd,
  freeDays: row.freeDays,
  catalogItemId: row.catalogItemId,
  note: row.note,
  updatedBy: row.updatedBy,
  updatedAt: row.updatedAt,
  version: row.version,
});

export const serializeStockSnapshot = (row: StockRow | null) => JSON.stringify(row ? snapshotFields(row) : null);

export function parseStockSnapshot(raw: string | null): StockRow | null | undefined {
  if (raw === null) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<StockRow> | null;
    if (value === null) return null;
    if (!isStockRow(value)) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

export function makeTransferEnvelope(input: {
  operationId: string;
  mode: MoveMode;
  sourceLocation: string;
  targetLocation: string;
  rows: StockRow[];
}): StockTransferEnvelope {
  return {
    kind: "stock-transfer",
    snapshotVersion: 1,
    operationId: input.operationId,
    mode: input.mode,
    sourceLocation: input.sourceLocation,
    targetLocation: input.targetLocation,
    rows: input.rows.map(snapshotFields),
  };
}

export function parseTransferEnvelope(raw: string | null): StockTransferEnvelope | undefined {
  if (raw === null) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<StockTransferEnvelope>;
    if (
      value.kind !== "stock-transfer" ||
      value.snapshotVersion !== 1 ||
      (value.mode !== "all" && value.mode !== "partial") ||
      typeof value.operationId !== "string" ||
      typeof value.sourceLocation !== "string" ||
      typeof value.targetLocation !== "string" ||
      !Array.isArray(value.rows) ||
      value.rows.length < 1 ||
      value.rows.length > 2 ||
      !value.rows.every(isStockRow)
    ) return undefined;
    return value as StockTransferEnvelope;
  } catch {
    return undefined;
  }
}

export function matchesStockSnapshot(current: StockRow, expected: StockRow) {
  const left = snapshotFields(current), right = snapshotFields(expected);
  return (Object.keys(left) as Array<keyof StockRow>).every((key) => {
    const a = left[key], b = right[key];
    return typeof a === "number" && typeof b === "number"
      ? Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 1e-9
      : a === b;
  });
}

export const restoreValues = (snapshot: StockRow, userName: string, stamp: string, version: number) => ({
  locationCode: snapshot.locationCode,
  inboundDate: snapshot.inboundDate,
  product: snapshot.product,
  productPrefix: snapshot.productPrefix ?? "", productCondition: snapshot.productCondition ?? "", inventoryUnit:snapshot.inventoryUnit??"item",inventoryReviewDecision:snapshot.inventoryReviewDecision??"",
  sku: snapshot.sku ?? "", fnsku: snapshot.fnsku ?? "",
  barcode: snapshot.barcode,
  inboundOrder: snapshot.inboundOrder,
  totalQuantity: snapshot.totalQuantity,
  totalBoxes: snapshot.totalBoxes,
  customerName: snapshot.customerName,
  palletCount: snapshot.palletAutomatic?snapshot.palletRawCount??1:snapshot.palletCount,
  palletLabel: snapshot.palletAutomatic?snapshot.palletRawLabel??snapshot.palletLabel:snapshot.palletLabel,
  layerCount: snapshot.layerCount,
  inboundSource: snapshot.inboundSource,
  billingMode: snapshot.billingMode,
  itemVolumeM3: snapshot.itemVolumeM3,
  boxVolumeM3: snapshot.boxVolumeM3,
  storageRateUsd: snapshot.storageRateUsd,
  freeDays: snapshot.freeDays,
  catalogItemId: snapshot.catalogItemId,
  note: snapshot.note,
  updatedBy: userName,
  updatedAt: stamp,
  version,
});

function isStockRow(value: unknown): value is StockRow {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<StockRow>;
  const stringKeys = [
    "locationCode", "inboundDate", "product", "barcode", "inboundOrder", "customerName", "palletLabel",
    "inboundSource", "billingMode", "note", "updatedBy", "updatedAt",
  ] as const;
  const numberKeys = [
    "id", "totalQuantity", "totalBoxes", "palletCount", "layerCount", "itemVolumeM3", "boxVolumeM3",
    "storageRateUsd", "freeDays", "version",
  ] as const;
  const integerKeys = ["id", "totalQuantity", "totalBoxes", "layerCount", "freeDays", "version"] as const;
  return (row.sku === undefined || typeof row.sku === "string") && (row.fnsku === undefined || typeof row.fnsku === "string") && stringKeys.every((key) => typeof row[key] === "string") &&
    numberKeys.every((key) => typeof row[key] === "number" && Number.isFinite(row[key])) &&
    integerKeys.every((key) => Number.isInteger(row[key])) &&
    (row.catalogItemId === null || Number.isInteger(row.catalogItemId));
}
