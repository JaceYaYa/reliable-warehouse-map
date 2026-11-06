import { locationCodeKey } from "./location-code.ts";

export type MovementDisplayRecord = {
  canRestore?: boolean;
  id: number;
  userName: string;
  action: string;
  entityId: string;
  summary: string;
  beforeSnapshot?: string | null;
  afterSnapshot?: string | null;
  createdAt: string;
};

type StockDisplaySnapshot = {
  locationCode?: unknown;
  inboundSource?: unknown;
  billingMode?: unknown;
  itemVolumeM3?: unknown;
  boxVolumeM3?: unknown;
  storageRateUsd?: unknown;
  freeDays?: unknown;
  layerCount?: unknown;
};

const PRIVATE_PRICING_FIELDS = new Set(["storageRateUsd", "freeDays"]);

function redactPrivatePricing(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactPrivatePricing);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !PRIVATE_PRICING_FIELDS.has(key)).map(([key, item]) => [key, redactPrivatePricing(item)]));
}

export function redactMovementSnapshotPricing(raw: string | null) {
  if (raw === null) return null;
  try {
    return JSON.stringify(redactPrivatePricing(JSON.parse(raw)));
  } catch {
    return null;
  }
}

function stockSnapshot(movement: MovementDisplayRecord): StockDisplaySnapshot | null {
  for (const raw of [movement.afterSnapshot, movement.beforeSnapshot]) {
    if (!raw) continue;
    try {
      const value = JSON.parse(raw) as StockDisplaySnapshot & { rows?: StockDisplaySnapshot[]; targetLocation?: unknown };
      if (value && Array.isArray(value.rows) && value.rows.length) {
        const targetKey = typeof value.targetLocation === "string" ? locationCodeKey(value.targetLocation) : "";
        const destination = targetKey
          ? value.rows.find((row) => typeof row.locationCode === "string" && locationCodeKey(row.locationCode) === targetKey)
          : undefined;
        return destination ?? value.rows[0] ?? null;
      }
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch {
      // A damaged legacy snapshot should not hide an otherwise valid fallback.
    }
  }
  return null;
}

function sourceLabel(value: unknown) {
  return value === "return" ? "退货" : value === "domestic" ? "国内" : value === "unspecified" ? "无" : "";
}

export function movementInventoryDetails(movement: MovementDisplayRecord, showPrivatePricing = false) {
  // Outbound pricing is selected for that operation and may differ from the
  // remaining/before stock snapshot. Do not present guessed details here.
  if (movement.action === "出库") return "";
  const stock = stockSnapshot(movement);
  if (!stock) return "";

  const parts: string[] = [], source = sourceLabel(stock.inboundSource);
  if (source) parts.push(source);
  if (stock.billingMode === "item" || stock.billingMode === "box") {
    const byBox = stock.billingMode === "box";
    const volume = Number(byBox ? stock.boxVolumeM3 : stock.itemVolumeM3);
    parts.push(byBox ? "按箱" : "按件", Number.isFinite(volume) && volume > 0 ? `${volume} m³/${byBox ? "箱" : "件"}` : "体积未填写");
  }
  if (showPrivatePricing && typeof stock.storageRateUsd === "number" && Number.isFinite(stock.storageRateUsd)) {
    parts.push(`$${stock.storageRateUsd.toFixed(2)}/m³/天`);
  }
  if (showPrivatePricing && typeof stock.freeDays === "number" && Number.isFinite(stock.freeDays)) {
    parts.push(`免租 ${Math.max(0, stock.freeDays)} 天`);
  }
  if (typeof stock.layerCount === "number" && Number.isFinite(stock.layerCount)) {
    parts.push(`${Math.max(1, stock.layerCount)} 层`);
  }
  return parts.join(" · ");
}
