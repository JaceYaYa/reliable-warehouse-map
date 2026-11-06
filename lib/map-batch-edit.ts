export type MapBatchBox = {
  x: number;
  y: number;
  w: number;
  h: number;
  groupLocked?: boolean;
  [key: string]: unknown;
};

export type MapBatchItem = {
  key: string;
  kind: "location" | "feature";
  box: MapBatchBox;
};

export type MapBatchPatch = Partial<Pick<MapBatchBox, "x" | "y" | "w" | "h">>;

export type MapBatchEditResult = {
  ok: boolean;
  changed: boolean;
  locationCount: number;
  ignoredCount: number;
  patches: Record<string, MapBatchPatch>;
  error?: string;
};

export type MapBatchDimensionSummary = {
  min: number | null;
  max: number | null;
  distinctCount: number;
  uniform: boolean;
  label: string;
};

export type MapBatchSizeSummary = {
  locationCount: number;
  ignoredCount: number;
  width: MapBatchDimensionSummary;
  height: MapBatchDimensionSummary;
};

export const MIN_LOCATION_WIDTH_PX = 64;
export const MIN_LOCATION_HEIGHT_PX = 58;

const unchanged = (items: MapBatchItem[], error?: string): MapBatchEditResult => ({
  ok: !error,
  changed: false,
  locationCount: items.filter(item => item.kind === "location").length,
  ignoredCount: items.filter(item => item.kind !== "location").length,
  patches: {},
  error,
});

const selectedLocations = (items: MapBatchItem[]) => items.filter(item => item.kind === "location");

const lockedError = (items: MapBatchItem[]) =>
  items.some(item => item.box.groupLocked) ? "选中内容包含已锁定组合，请先解锁" : "";

const parseOptionalDimension = (
  raw: string,
  label: string,
  minimum: number,
  maximum: number,
) => {
  const value = raw.trim();
  if (!value) return { value: undefined };
  const number = Number(value);
  if (!Number.isFinite(number)) return { error: `${label}请输入有效数字` };
  if (number < minimum || number > maximum) {
    return { error: `${label}请输入 ${minimum}–${maximum}px` };
  }
  return { value: number };
};

const percent = (pixels: number, worldPixels: number) =>
  Math.round((pixels / worldPixels) * 100 * 1e9) / 1e9;

const roundedPixel = (value: number) => Math.round(value * 100) / 100;
const pixelText = (value: number) => Number(value.toFixed(2)).toString();

const summarizeDimension = (values: number[]): MapBatchDimensionSummary => {
  if (!values.length) {
    return { min: null, max: null, distinctCount: 0, uniform: false, label: "—" };
  }
  const unique = [...new Set(values.map(roundedPixel))].sort((a, b) => a - b);
  const min = unique[0];
  const max = unique[unique.length - 1];
  const uniform = unique.length === 1;
  return {
    min,
    max,
    distinctCount: unique.length,
    uniform,
    label: uniform ? `${pixelText(min)}px（统一）` : `混合 ${pixelText(min)}–${pixelText(max)}px（${unique.length}种）`,
  };
};

export function summarizeSelectedLocationSizes(
  items: MapBatchItem[],
  mapWidth: number,
  mapHeight: number,
): MapBatchSizeSummary {
  const locations = selectedLocations(items);
  const validMap = Number.isFinite(mapWidth) && Number.isFinite(mapHeight) && mapWidth > 0 && mapHeight > 0;
  const widths = validMap ? locations.map(item => item.box.w * mapWidth / 100) : [];
  const heights = validMap ? locations.map(item => item.box.h * mapHeight / 100) : [];
  return {
    locationCount: locations.length,
    ignoredCount: items.length - locations.length,
    width: summarizeDimension(widths),
    height: summarizeDimension(heights),
  };
}

export function resizeSelectedLocations(
  items: MapBatchItem[],
  widthInput: string,
  heightInput: string,
  mapWidth: number,
  mapHeight: number,
): MapBatchEditResult {
  const locations = selectedLocations(items);
  if (!locations.length) return unchanged(items, "请先框选至少一个库位");
  const locked = lockedError(items);
  if (locked) return unchanged(items, locked);
  if (!Number.isFinite(mapWidth) || !Number.isFinite(mapHeight) || mapWidth <= 0 || mapHeight <= 0) {
    return unchanged(items, "地图尺寸无效，请刷新后重试");
  }

  const parsedWidth = parseOptionalDimension(widthInput, "宽度", MIN_LOCATION_WIDTH_PX, mapWidth);
  if (parsedWidth.error) return unchanged(items, parsedWidth.error);
  const parsedHeight = parseOptionalDimension(heightInput, "高度", MIN_LOCATION_HEIGHT_PX, mapHeight);
  if (parsedHeight.error) return unchanged(items, parsedHeight.error);
  if (parsedWidth.value === undefined && parsedHeight.value === undefined) {
    return unchanged(items, "请填写宽度或高度");
  }

  const width = parsedWidth.value === undefined ? undefined : percent(parsedWidth.value, mapWidth);
  const height = parsedHeight.value === undefined ? undefined : percent(parsedHeight.value, mapHeight);
  for (const item of locations) {
    if (width !== undefined && item.box.x + width > 100 + 1e-9) {
      return unchanged(items, `${item.key.slice("location:".length)} 调整后会超出地图右边界`);
    }
    if (height !== undefined && item.box.y + height > 100 + 1e-9) {
      return unchanged(items, `${item.key.slice("location:".length)} 调整后会超出地图下边界`);
    }
  }

  const patches: Record<string, MapBatchPatch> = {};
  for (const item of locations) {
    const patch: MapBatchPatch = {};
    if (width !== undefined && Math.abs(item.box.w - width) > 1e-9) patch.w = width;
    if (height !== undefined && Math.abs(item.box.h - height) > 1e-9) patch.h = height;
    if (Object.keys(patch).length) patches[item.key] = patch;
  }
  return {
    ok: true,
    changed: Object.keys(patches).length > 0,
    locationCount: locations.length,
    ignoredCount: items.length - locations.length,
    patches,
  };
}

type AlignmentMetric = {
  item: MapBatchItem;
  coordinatePx: number;
  secondaryPx: number;
  crossSizePx: number;
};

export function alignSelectedLocations(
  items: MapBatchItem[],
  direction: "horizontal" | "vertical",
  mapWidth: number,
  mapHeight: number,
): MapBatchEditResult {
  const locations = selectedLocations(items);
  if (locations.length < 2) return unchanged(items, "请至少框选两个库位再对齐");
  const locked = lockedError(items);
  if (locked) return unchanged(items, locked);
  if (!Number.isFinite(mapWidth) || !Number.isFinite(mapHeight) || mapWidth <= 0 || mapHeight <= 0) {
    return unchanged(items, "地图尺寸无效，请刷新后重试");
  }

  const metrics: AlignmentMetric[] = locations.map(item => direction === "horizontal"
    ? {
        item,
        coordinatePx: item.box.y * mapHeight / 100,
        secondaryPx: item.box.x * mapWidth / 100,
        crossSizePx: item.box.h * mapHeight / 100,
      }
    : {
        item,
        coordinatePx: item.box.x * mapWidth / 100,
        secondaryPx: item.box.y * mapHeight / 100,
        crossSizePx: item.box.w * mapWidth / 100,
      });
  metrics.sort((a, b) =>
    a.coordinatePx - b.coordinatePx ||
    a.secondaryPx - b.secondaryPx ||
    a.item.key.localeCompare(b.item.key, "zh-CN", { numeric: true }));

  const bands: Array<{ startPx: number; anchorSizePx: number; metrics: AlignmentMetric[] }> = [];
  for (const metric of metrics) {
    const current = bands[bands.length - 1];
    const tolerancePx = current
      ? Math.max(2, Math.min(current.anchorSizePx, metric.crossSizePx) * .5)
      : 0;
    if (!current || metric.coordinatePx - current.startPx > tolerancePx + 1e-6) {
      bands.push({ startPx: metric.coordinatePx, anchorSizePx: metric.crossSizePx, metrics: [metric] });
    } else {
      current.metrics.push(metric);
    }
  }

  const patches: Record<string, MapBatchPatch> = {};
  for (const band of bands) {
    if (band.metrics.length < 2) continue;
    const target = direction === "horizontal"
      ? percent(band.startPx, mapHeight)
      : percent(band.startPx, mapWidth);
    for (const metric of band.metrics) {
      const current = direction === "horizontal" ? metric.item.box.y : metric.item.box.x;
      if (Math.abs(current - target) <= 1e-9) continue;
      patches[metric.item.key] = direction === "horizontal" ? { y: target } : { x: target };
    }
  }
  return {
    ok: true,
    changed: Object.keys(patches).length > 0,
    locationCount: locations.length,
    ignoredCount: items.length - locations.length,
    patches,
  };
}
