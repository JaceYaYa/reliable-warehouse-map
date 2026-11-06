export type InboundSource = "domestic" | "return" | "unspecified";
export type BillingMode = "item" | "box";

export const PRICING_DEFAULTS_KEY = "pricing_defaults";
export const DEFAULT_PRICING_SETTINGS = {
  defaultRatePerM3Day: 0.7,
  defaultFreeDays: 0,
} as const;

export type PricingSettings = {
  defaultRatePerM3Day: number;
  defaultFreeDays: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const round = (value: number, digits = 8) => Number(value.toFixed(digits));

export function numberValue(value: unknown, fallback = 0) {
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  const text = String(value ?? "").trim().replaceAll(",", "");
  if (!text) return fallback;
  const fraction = text.match(/^(-?\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
  if (fraction) {
    const denominator = Number(fraction[2]);
    return denominator ? Number(fraction[1]) / denominator : fallback;
  }
  const parsed = Number(text.replace(/[^\d.+-]/g, ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function normalizePricingSettings(
  value: unknown,
  fallback: PricingSettings = DEFAULT_PRICING_SETTINGS,
): PricingSettings {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const rate = numberValue(source.defaultRatePerM3Day, fallback.defaultRatePerM3Day);
  const freeDays = numberValue(source.defaultFreeDays, fallback.defaultFreeDays);
  return {
    defaultRatePerM3Day: Number.isFinite(rate) && rate >= 0 ? rate : fallback.defaultRatePerM3Day,
    defaultFreeDays: Number.isFinite(freeDays) && freeDays >= 0
      ? Math.floor(freeDays)
      : fallback.defaultFreeDays,
  };
}

export function normalizeInboundSource(value: unknown): InboundSource {
  const text = String(value ?? "").trim().toLowerCase();
  if (["return", "returned", "return_inbound", "退货", "退货回来", "退货入库", "退货出库"].includes(text)) return "return";
  if (["none", "unspecified", "未选择", "不选择", "无"].includes(text)) return "unspecified";
  return "domestic";
}

export function inboundSourceLabel(value: unknown) {
  const source = normalizeInboundSource(value);
  return source === "return" ? "退货" : source === "domestic" ? "国内" : "未选择";
}

export function normalizeBillingMode(value: unknown): BillingMode {
  const text = String(value ?? "").trim().toLowerCase();
  return ["box", "carton", "箱", "箱子", "按箱", "按箱计价"].includes(text) ? "box" : "item";
}

export function billingModeForAvailableStock(
  current: unknown,
  quantity: unknown,
  boxes: unknown,
): BillingMode {
  const normalized = normalizeBillingMode(current);
  const availableQuantity = Math.max(0, numberValue(quantity));
  const availableBoxes = Math.max(0, numberValue(boxes));
  if (availableQuantity <= 0 && availableBoxes > 0) return "box";
  if (availableBoxes <= 0 && availableQuantity > 0) return "item";
  return normalized;
}

export function volumeFromCm(length: unknown, width: unknown, height: unknown) {
  const l = Math.max(0, numberValue(length)), w = Math.max(0, numberValue(width)), h = Math.max(0, numberValue(height));
  return l && w && h ? round((l * w * h) / 1_000_000) : 0;
}

function dateOnly(value: string | Date) {
  if (value instanceof Date) return chinaTodayDate(value);
  const text = String(value || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : chinaTodayDate(new Date(value));
}

function utcDay(value: string | Date) {
  const [year, month, day] = dateOnly(value).split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

export function calculateStorageFee(input: {
  inboundDate: string;
  endDate?: string;
  billingMode?: unknown;
  quantity?: unknown;
  boxes?: unknown;
  itemVolumeM3?: unknown;
  boxVolumeM3?: unknown;
  rateUsdM3Day?: unknown;
  freeDays?: unknown;
}) {
  const endDate = input.endDate || chinaTodayDate();
  const storageDays = Math.max(0, Math.floor((utcDay(endDate) - utcDay(input.inboundDate)) / DAY_MS));
  const freeDays = Math.max(0, Math.floor(numberValue(input.freeDays)));
  const billableDays = Math.max(0, storageDays - freeDays);
  const billingMode = normalizeBillingMode(input.billingMode);
  const count = Math.max(0, billingMode === "box" ? numberValue(input.boxes) : numberValue(input.quantity));
  const volumePerCountM3 = Math.max(0, billingMode === "box" ? numberValue(input.boxVolumeM3) : numberValue(input.itemVolumeM3));
  const rateUsdM3Day = Math.max(0, numberValue(input.rateUsdM3Day, 0.7));
  const totalVolumeM3 = round(count * volumePerCountM3);
  const feeUsd = round(totalVolumeM3 * billableDays * rateUsdM3Day, 6);
  return { billingMode, count, storageDays, freeDays, billableDays, volumePerCountM3, totalVolumeM3, rateUsdM3Day, feeUsd };
}

export type StorageBillingPeriod = {
  fromDate: string;
  toDate: string;
  fromMonth: string;
  toMonth: string;
  periodStart: string;
  periodEndExclusive: string;
  requestedPeriodEndExclusive: string;
};

export class InvalidStorageBillingPeriodError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidStorageBillingPeriodError";
  }
}

const BILLING_MONTH_PATTERN = /^(?!0000)\d{4}-(0[1-9]|1[0-2])$/;
const ISO_DATE_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/;

export function chinaTodayDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = new Map(parts.map(part => [part.type, part.value]));
  return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
}

export function isStorageBillingMonth(value: unknown): value is string {
  return typeof value === "string"
    && BILLING_MONTH_PATTERN.test(value)
    && Number(value.slice(0, 4)) >= 1970;
}

function nextMonthStart(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  return monthNumber === 12
    ? `${year + 1}-01-01`
    : `${year}-${String(monthNumber + 1).padStart(2, "0")}-01`;
}

function validIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function addDays(value: string, days: number) {
  return new Date(utcDay(value) + Math.max(0, Math.floor(days)) * DAY_MS).toISOString().slice(0, 10);
}

function daysBetween(start: string, endExclusive: string) {
  return Math.max(0, Math.floor((utcDay(endExclusive) - utcDay(start)) / DAY_MS));
}

export function resolveStorageBillingPeriod(input: {
  fromDate?: unknown;
  toDate?: unknown;
  fromMonth?: unknown;
  toMonth?: unknown;
  today?: string;
} = {}): StorageBillingPeriod {
  if (input.fromMonth !== undefined && !isStorageBillingMonth(input.fromMonth)) {
    throw new InvalidStorageBillingPeriodError("账单开始月份格式不正确，请使用 YYYY-MM");
  }
  if (input.toMonth !== undefined && !isStorageBillingMonth(input.toMonth)) {
    throw new InvalidStorageBillingPeriodError("账单结束月份格式不正确，请使用 YYYY-MM");
  }
  const today = input.today ?? chinaTodayDate();
  if (!validIsoDate(today)) {
    throw new InvalidStorageBillingPeriodError("账单计算日期格式不正确");
  }
  if (input.fromDate !== undefined || input.toDate !== undefined) {
    if (!validIsoDate(input.fromDate) || !validIsoDate(input.toDate) || input.fromDate < '1970-01-01' || input.toDate > '9999-12-30') {
      throw new InvalidStorageBillingPeriodError("请选择有效的开始和结束日期，格式为 YYYY-MM-DD");
    }
    if (input.fromDate > input.toDate) throw new InvalidStorageBillingPeriodError("账单开始日期不能晚于结束日期");
    const requestedPeriodEndExclusive = addDays(input.toDate, 1);
    return {fromDate:input.fromDate,toDate:input.toDate,fromMonth:input.fromDate.slice(0,7),toMonth:input.toDate.slice(0,7),periodStart:input.fromDate,requestedPeriodEndExclusive,
      periodEndExclusive: requestedPeriodEndExclusive < today ? requestedPeriodEndExclusive : today};
  }
  const currentMonth = today.slice(0, 7);
  const fromMonth = input.fromMonth ?? input.toMonth ?? currentMonth;
  const toMonth = input.toMonth ?? input.fromMonth ?? currentMonth;
  if (fromMonth > toMonth) {
    throw new InvalidStorageBillingPeriodError("账单开始月份不能晚于结束月份");
  }
  const periodStart = `${fromMonth}-01`;
  const requestedPeriodEndExclusive = nextMonthStart(toMonth);
  const cappedEnd = requestedPeriodEndExclusive < today ? requestedPeriodEndExclusive : today;
  return {
    fromMonth,
    toMonth,
    fromDate: periodStart,
    toDate: new Date(utcDay(requestedPeriodEndExclusive) - DAY_MS).toISOString().slice(0, 10),
    periodStart,
    // Storage days are completed 24-hour periods. The current/future month is
    // therefore capped at the start of the current China calendar day.
    periodEndExclusive: cappedEnd < periodStart ? periodStart : cappedEnd,
    requestedPeriodEndExclusive,
  };
}

export function calculateStorageFeeForPeriod(input: {
  inboundDate: string;
  endDateExclusive?: string;
  fromMonth: string;
  toMonth: string;
  today?: string;
  billingMode?: unknown;
  quantity?: unknown;
  boxes?: unknown;
  itemVolumeM3?: unknown;
  boxVolumeM3?: unknown;
  rateUsdM3Day?: unknown;
  freeDays?: unknown;
}) {
  const period = resolveStorageBillingPeriod({
    fromMonth: input.fromMonth,
    toMonth: input.toMonth,
    today: input.today,
  });
  const inboundDate = dateOnly(input.inboundDate);
  const inventoryEndDateExclusive = input.endDateExclusive
    ? dateOnly(input.endDateExclusive)
    : period.periodEndExclusive;
  const periodStorageStart = inboundDate > period.periodStart ? inboundDate : period.periodStart;
  const periodStorageEndExclusive = inventoryEndDateExclusive < period.periodEndExclusive
    ? inventoryEndDateExclusive
    : period.periodEndExclusive;
  const freeDays = Math.max(0, Math.floor(numberValue(input.freeDays)));
  // Free rent is anchored to the original inbound date and never restarts when
  // a later monthly billing period is selected.
  const chargeStartDate = addDays(inboundDate, freeDays);
  const periodChargeStart = chargeStartDate > periodStorageStart ? chargeStartDate : periodStorageStart;
  const periodStorageDays = daysBetween(periodStorageStart, periodStorageEndExclusive);
  const periodBillableDays = daysBetween(periodChargeStart, periodStorageEndExclusive);
  const base = calculateStorageFee({
    inboundDate,
    endDate: periodStorageEndExclusive,
    billingMode: input.billingMode,
    quantity: input.quantity,
    boxes: input.boxes,
    itemVolumeM3: input.itemVolumeM3,
    boxVolumeM3: input.boxVolumeM3,
    rateUsdM3Day: input.rateUsdM3Day,
    freeDays,
  });
  const periodFeeUsd = round(base.totalVolumeM3 * periodBillableDays * base.rateUsdM3Day, 6);
  return {
    ...base,
    ...period,
    inventoryEndDateExclusive,
    periodStorageStart,
    periodStorageEndExclusive,
    chargeStartDate,
    periodStorageDays,
    periodBillableDays,
    periodFeeUsd,
  };
}

type AnyRecord = Record<string, unknown>;

const aliases = {
  partnerName: ["partnerName", "partner", "合作商家", "合作商家名称", "商家"],
  customerName: ["customerName", "customer", "客户", "客户名称"],
  product: ["product", "productName", "name", "title", "产品", "产品名称", "商品", "商品名称", "品名"],
  sku: ["sku", "productSku", "sellerSku", "产品SKU", "商品SKU", "产品编码", "商品编码", "商家编码"],
  fnsku: ["fnsku", "fnSku", "FNSKU"],
  barcode: ["barcode", "barCode", "upc", "ean", "条形码", "产品条形码", "商品条码", "UPC", "EAN", "fnsku", "fnSku", "FNSKU"],
  defaultBillingMode: ["defaultBillingMode", "billingMode", "计费方式", "收费方式"],
  itemLengthCm: ["itemLengthCm", "unitLengthCm", "itemLength", "单件长(cm)", "单件长度(cm)", "单件长", "产品长(cm)"],
  itemWidthCm: ["itemWidthCm", "unitWidthCm", "itemWidth", "单件宽(cm)", "单件宽度(cm)", "单件宽", "产品宽(cm)"],
  itemHeightCm: ["itemHeightCm", "unitHeightCm", "itemHeight", "单件高(cm)", "单件高度(cm)", "单件高", "产品高(cm)"],
  itemDimensions: ["itemDimensions", "unitDimensions", "单件尺寸", "产品尺寸", "商品尺寸"],
  itemVolumeM3: ["itemVolumeM3", "unitVolumeM3", "单件立方米", "单件体积(m³)", "单件体积m3", "产品体积(m³)"],
  boxLengthCm: ["boxLengthCm", "cartonLengthCm", "boxLength", "箱长(cm)", "外箱长(cm)", "箱长"],
  boxWidthCm: ["boxWidthCm", "cartonWidthCm", "boxWidth", "箱宽(cm)", "外箱宽(cm)", "箱宽"],
  boxHeightCm: ["boxHeightCm", "cartonHeightCm", "boxHeight", "箱高(cm)", "外箱高(cm)", "箱高"],
  boxDimensions: ["boxDimensions", "cartonDimensions", "箱子尺寸", "箱规", "外箱尺寸"],
  boxVolumeM3: ["boxVolumeM3", "cartonVolumeM3", "箱子立方米", "箱体积(m³)", "箱体积m3", "外箱体积(m³)"],
  rateUsdM3Day: ["rateUsdM3Day", "ratePerM3Day", "storageRateUsd", "rate", "费率", "仓储费率", "美元/立方米/天"],
  freeDays: ["freeDays", "免租期", "免租天数"],
  active: ["active", "启用", "状态"],
} as const;

function pick(raw: AnyRecord, keys: readonly string[]) {
  for (const key of keys) if (raw[key] !== undefined && raw[key] !== null && String(raw[key]).trim() !== "") return raw[key];
  const normalized = new Map(Object.keys(raw).map(key => [key.trim().toLowerCase().replaceAll(" ", ""), key]));
  for (const key of keys) {
    const original = normalized.get(key.trim().toLowerCase().replaceAll(" ", ""));
    if (original && raw[original] !== undefined && String(raw[original]).trim() !== "") return raw[original];
  }
  return undefined;
}

function dimensions(value: unknown) {
  const text = String(value ?? "").trim();
  const numbers = text.match(/\d+(?:\.\d+)?/g)?.slice(0, 3).map(Number) || [];
  if (numbers.length < 3) return [0, 0, 0] as const;
  const factor = /mm|毫米/i.test(text) ? 0.1 : /m(?:\b|³)|米/i.test(text) && !/cm/i.test(text) ? 100 : 1;
  return [numbers[0] * factor, numbers[1] * factor, numbers[2] * factor] as const;
}

export function normalizeCatalogInput(raw: AnyRecord) {
  const itemSize = dimensions(pick(raw, aliases.itemDimensions));
  const boxSize = dimensions(pick(raw, aliases.boxDimensions));
  const itemLengthCm = Math.max(0, numberValue(pick(raw, aliases.itemLengthCm), itemSize[0]));
  const itemWidthCm = Math.max(0, numberValue(pick(raw, aliases.itemWidthCm), itemSize[1]));
  const itemHeightCm = Math.max(0, numberValue(pick(raw, aliases.itemHeightCm), itemSize[2]));
  const boxLengthCm = Math.max(0, numberValue(pick(raw, aliases.boxLengthCm), boxSize[0]));
  const boxWidthCm = Math.max(0, numberValue(pick(raw, aliases.boxWidthCm), boxSize[1]));
  const boxHeightCm = Math.max(0, numberValue(pick(raw, aliases.boxHeightCm), boxSize[2]));
  const explicitItemVolume = numberValue(pick(raw, aliases.itemVolumeM3));
  const explicitBoxVolume = numberValue(pick(raw, aliases.boxVolumeM3));
  const activeValue = pick(raw, aliases.active);
  return {
    partnerName: String(pick(raw, aliases.partnerName) ?? "").trim(),
    customerName: String(pick(raw, aliases.customerName) ?? "").trim(),
    product: String(pick(raw, aliases.product) ?? "").trim(),
    sku: String(pick(raw, aliases.sku) ?? "").trim(),
    fnsku: String(pick(raw, aliases.fnsku) ?? "").trim(),
    barcode: String(pick(raw, aliases.barcode) ?? "").trim(),
    defaultBillingMode: normalizeBillingMode(pick(raw, aliases.defaultBillingMode)),
    itemLengthCm, itemWidthCm, itemHeightCm,
    itemVolumeM3: round(Math.max(0, explicitItemVolume || volumeFromCm(itemLengthCm, itemWidthCm, itemHeightCm))),
    boxLengthCm, boxWidthCm, boxHeightCm,
    boxVolumeM3: round(Math.max(0, explicitBoxVolume || volumeFromCm(boxLengthCm, boxWidthCm, boxHeightCm))),
    rateUsdM3Day: Math.max(0, numberValue(pick(raw, aliases.rateUsdM3Day), 0.7)),
    freeDays: Math.max(0, Math.floor(numberValue(pick(raw, aliases.freeDays)))),
    active: activeValue === undefined ? 1 : [false, 0, "0", "否", "停用", "disabled"].includes(activeValue as never) ? 0 : 1,
  };
}

export function catalogIdentity(item: { sku?: string; fnsku?: string; barcode?: string; product: string; customerName?: string; partnerName?: string }) {
  // Partner/customer is part of the identity. Different merchants often reuse
  // the same seller SKU, so a globally unique SKU would silently overwrite a
  // different merchant's dimensions and rate during Excel import.
  const owner = (item.partnerName || item.customerName || "").trim().toLowerCase();
  if (item.sku?.trim()) return `owner:${owner}|sku:${item.sku.trim().toLowerCase()}`;
  if (item.barcode?.trim()) return `owner:${owner}|barcode:${item.barcode.trim().toLowerCase()}`;
  if (item.fnsku?.trim()) return `owner:${owner}|fnsku:${item.fnsku.trim().toLowerCase()}`;
  return `owner:${owner}|product:${item.product.trim().toLowerCase()}`;
}
