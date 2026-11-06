export type StockSourceType = "return" | "domestic" | "unspecified";

export type BillingMode = "item" | "box";

export type DimensionUnit = "cm" | "inch";

export type PricingCatalogItem = {
  id?: number | string;
  customerName: string;
  productName: string;
  currentProductKey?:string;
  currentProductName?:string;
  sku: string;
  fnsku: string;
  barcode: string;
  billingMode: BillingMode;
  itemLengthCm: number;
  itemWidthCm: number;
  itemHeightCm: number;
  itemVolumeM3: number;
  boxLengthCm: number;
  boxWidthCm: number;
  boxHeightCm: number;
  boxVolumeM3: number;
  ratePerM3Day: number;
  freeDays: number;
  active?: number | boolean;
  updatedAt?: string;
};

export type StockPricingDraft = {
  sourceType: StockSourceType;
  pricingCatalogId?: number | string | null;
  billingMode: BillingMode;
  itemVolumeM3: number;
  boxVolumeM3: number;
  ratePerM3Day: number;
  freeDays: number;
};

export type PricingReportRow = {
  pricingReview?:boolean;
  pricingReviewReason?:string;
  inboundOrder: string;
  note: string;
  id: number | string;
  stockId: number;
  status: "open" | "pending" | "settled" | "cancelled" | "corrected";
  inventoryStatus: "in_stock" | "outbound" | "corrected";
  settlementStatus: null | "pending" | "settled" | "cancelled";
  settlementId: number | null;
  sourceType: StockSourceType;
  locationCode: string;
  customerName: string;
  productName: string;
  currentProductKey?:string;
  currentProductName?:string;
  sku: string;
  barcode: string;
  inboundDate: string;
  outboundDate?: string;
  correctionDate?:string;
  billingMode: BillingMode;
  quantity?:number;
  boxes?:number;
  billedQuantity: number;
  volumePerUnitM3: number;
  totalVolumeM3: number;
  storageDays: number;
  freeDays: number;
  customerRateOverride: number | null;
  customerFreeDaysOverride: number | null;
  customerPricingApplied: boolean;
  billableDays: number;
  ratePerM3Day: number;
  feeUsd: number;
  periodStart: string;
  periodEndExclusive: string;
  periodStorageDays: number;
  periodBillableDays: number;
  chargeStartDate: string;
  periodFeeUsd: number;
  settledAt: string | null;
  settledBy: string;
  version: number;
};

export const DEFAULT_PRICING_RATE = 0.7;

export const blankCatalogItem = (): PricingCatalogItem => ({
  customerName: "",
  productName: "",
  sku: "",
  fnsku: "",
  barcode: "",
  billingMode: "item",
  itemLengthCm: 0,
  itemWidthCm: 0,
  itemHeightCm: 0,
  itemVolumeM3: 0,
  boxLengthCm: 0,
  boxWidthCm: 0,
  boxHeightCm: 0,
  boxVolumeM3: 0,
  ratePerM3Day: DEFAULT_PRICING_RATE,
  freeDays: 0,
  active: 1,
});

const num = (value: unknown, fallback = 0) => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const normalizeCatalogItem = (raw: Record<string, unknown>): PricingCatalogItem => ({
  id: (raw.id ?? raw.catalogId) as number | string | undefined,
  customerName: String(raw.customerName ?? raw.customer ?? raw.partnerName ?? ""),
  productName: String(raw.productName ?? raw.product ?? raw.name ?? ""),
  sku: String(raw.sku ?? raw.productSku ?? raw.sellerSku ?? ""),
  fnsku: String(raw.fnsku ?? raw.fnSku ?? raw.FNSKU ?? ""),
  barcode: String(raw.barcode ?? raw.upc ?? raw.ean ?? ""),
  billingMode: (raw.billingMode ?? raw.defaultBillingMode) === "box" ? "box" : "item",
  itemLengthCm: num(raw.itemLengthCm ?? raw.unitLengthCm),
  itemWidthCm: num(raw.itemWidthCm ?? raw.unitWidthCm),
  itemHeightCm: num(raw.itemHeightCm ?? raw.unitHeightCm),
  itemVolumeM3: num(raw.itemVolumeM3 ?? raw.unitVolumeM3 ?? raw.itemCbm),
  boxLengthCm: num(raw.boxLengthCm ?? raw.cartonLengthCm),
  boxWidthCm: num(raw.boxWidthCm ?? raw.cartonWidthCm),
  boxHeightCm: num(raw.boxHeightCm ?? raw.cartonHeightCm),
  boxVolumeM3: num(raw.boxVolumeM3 ?? raw.cartonVolumeM3 ?? raw.boxCbm),
  ratePerM3Day: num(raw.ratePerM3Day ?? raw.rateUsdM3Day ?? raw.rate, DEFAULT_PRICING_RATE),
  freeDays: Math.max(0, Math.trunc(num(raw.freeDays))),
  active: (raw.active ?? 1) as number | boolean,
  updatedAt: raw.updatedAt ? String(raw.updatedAt) : undefined,
});

export const extractCatalogItems = (payload: unknown): PricingCatalogItem[] => {
  const data = payload as Record<string, unknown> | unknown[] | null;
  const single = !Array.isArray(data) && data
    ? (data.entry ?? data.item ?? data.catalogItem)
    : null;
  const rows = single && typeof single === "object"
    ? [single]
    : Array.isArray(data)
    ? data
    : Array.isArray(data?.items)
      ? data.items
      : Array.isArray(data?.entries)
        ? data.entries
        : Array.isArray(data?.catalogItems)
          ? data.catalogItems
      : Array.isArray(data?.catalog)
        ? data.catalog
        : Array.isArray(data?.rows)
          ? data.rows
          : [];
  return rows
    .filter((row): row is Record<string, unknown> => !!row && typeof row === "object")
    .map(normalizeCatalogItem);
};

export const catalogSearchText = (item: PricingCatalogItem) =>
  [item.productName, item.sku, item.barcode, item.customerName].join(" ").toLocaleLowerCase();

export const dimensionToCentimeters = (value: number, unit: DimensionUnit = "cm") => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return unit === "inch" ? parsed * 2.54 : parsed;
};

export const dimensionFromCentimeters = (value: number, unit: DimensionUnit = "cm") => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return unit === "inch" ? parsed / 2.54 : parsed;
};

export const dimensionsToVolume = (
  length: number,
  width: number,
  height: number,
  unit: DimensionUnit = "cm",
) => {
  const values = [length, width, height].map((value) => dimensionToCentimeters(value, unit));
  if (values.some((value) => !Number.isFinite(value) || value <= 0)) return 0;
  return Number(((values[0] * values[1] * values[2]) / 1_000_000).toFixed(8));
};
