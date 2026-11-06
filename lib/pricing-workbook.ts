export type WorkbookRow = Record<string, unknown>;

const OMP_HEADERS = {
  sku: "SKU",
  barcode: "Product Code/产品条码",
  customer: "Customer/客户",
  product: "Product Name/产品名称",
  sizeUnit: "SIZE UNIT/尺寸单位",
  omsLength: "OMS Length/OMS长",
  omsWidth: "OMS Width/OMS宽",
  omsHeight: "OMS Height/OMS高",
  wmsSizeUnit: "WMS SIZE UNIT/WMS尺寸单位",
  wmsLength: "WMS Length/WMS长",
  wmsWidth: "WMS Width/WMS宽",
  wmsHeight: "WMS Height/WMS高",
} as const;

function text(value: unknown) {
  return String(value ?? "").trim();
}

function number(value: unknown) {
  const parsed = Number(text(value).replaceAll(",", ""));
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function lengthToCm(value: number, unit: string) {
  const normalized = unit.trim().toLocaleLowerCase();
  if (/^(in|inch|inches)$/.test(normalized) || normalized.includes("英寸")) return value * 2.54;
  if (/^(mm|millimeter|millimeters)$/.test(normalized) || normalized.includes("毫米")) return value / 10;
  if (/^(m|meter|meters)$/.test(normalized) || normalized === "米") return value * 100;
  return value;
}

export function isOmpRow(row: WorkbookRow) {
  const hasCoreHeaders = OMP_HEADERS.product in row && OMP_HEADERS.omsLength in row;
  const hasAllOmsDimensions = OMP_HEADERS.omsWidth in row && OMP_HEADERS.omsHeight in row;
  return hasCoreHeaders && (OMP_HEADERS.sku in row || hasAllOmsDimensions);
}

function prepareOmpRow(row: WorkbookRow, defaultRatePerM3Day: number): WorkbookRow | null {
  const productName = text(row[OMP_HEADERS.product]);
  const sku = text(row[OMP_HEADERS.sku]);
  const barcode = text(row[OMP_HEADERS.barcode]) || text(row.FNSKU ?? row.fnsku ?? row.fnSku);
  if (!productName && !sku && !barcode) return null;

  const wmsDimensions = [
    number(row[OMP_HEADERS.wmsLength]),
    number(row[OMP_HEADERS.wmsWidth]),
    number(row[OMP_HEADERS.wmsHeight]),
  ];
  const omsDimensions = [
    number(row[OMP_HEADERS.omsLength]),
    number(row[OMP_HEADERS.omsWidth]),
    number(row[OMP_HEADERS.omsHeight]),
  ];
  const useWms = wmsDimensions.every((value) => value > 0);
  const source = useWms ? wmsDimensions : omsDimensions;
  const unit = text(row[useWms ? OMP_HEADERS.wmsSizeUnit : OMP_HEADERS.sizeUnit]) || "in";
  const [itemLengthCm, itemWidthCm, itemHeightCm] = source.map((value) => lengthToCm(value, unit));
  const itemVolumeM3 = itemLengthCm && itemWidthCm && itemHeightCm
    ? Number(((itemLengthCm * itemWidthCm * itemHeightCm) / 1_000_000).toFixed(8))
    : 0;

  return {
    customerName: text(row[OMP_HEADERS.customer]),
    partnerName: text(row[OMP_HEADERS.customer]),
    productName,
    sku,
    barcode,
    defaultBillingMode: "item",
    itemLengthCm: Number(itemLengthCm.toFixed(4)),
    itemWidthCm: Number(itemWidthCm.toFixed(4)),
    itemHeightCm: Number(itemHeightCm.toFixed(4)),
    itemVolumeM3,
    boxLengthCm: 0,
    boxWidthCm: 0,
    boxHeightCm: 0,
    boxVolumeM3: 0,
    ratePerM3Day: defaultRatePerM3Day,
    freeDays: 0,
  };
}

export function prepareCatalogRow(
  row: WorkbookRow,
  defaultRatePerM3Day: number,
): WorkbookRow | null {
  if (isOmpRow(row)) return prepareOmpRow(row, defaultRatePerM3Day);
  return row;
}
