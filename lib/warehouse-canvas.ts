import {
  mergeRequiredWarehouseZones,
  normalizeWarehouseZone,
  normalizeWarehouseZones,
  WAREHOUSE_LAYOUT_VERSION,
  type LayoutBox,
  type WarehouseZoneRecord,
} from "./warehouse-layout.ts";

export type WarehouseCanvasSize = { width: number; height: number };
export type WarehousePan = { x: number; y: number };
export type WarehouseViewportSize = { width: number; height: number };
export type WarehouseMiniMapPosition = { left: number; top: number };

export type WarehouseCanvasContentBounds = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
  itemCount: number;
  invalidCount: number;
};

export type WarehouseCanvasSizeValidation =
  | { ok: true; size: WarehouseCanvasSize }
  | { ok: false; error: string };

export type WarehouseCanvasContentValidation =
  | {
      ok: true;
      size: WarehouseCanvasSize;
      bounds: WarehouseCanvasContentBounds;
      minimum: WarehouseCanvasSize;
    }
  | {
      ok: false;
      error: string;
      size: WarehouseCanvasSize;
      bounds: WarehouseCanvasContentBounds;
      minimum: WarehouseCanvasSize;
    };

export type WarehouseCanvasResizeValidation =
  | {
      ok: true;
      size: WarehouseCanvasSize;
      minimum: WarehouseCanvasSize;
      bounds: WarehouseCanvasContentBounds;
      zones: WarehouseZoneRecord[];
    }
  | {
      ok: false;
      error: string;
      minimum: WarehouseCanvasSize;
      bounds: WarehouseCanvasContentBounds;
    };

export const DEFAULT_WAREHOUSE_CANVAS_SIZE: WarehouseCanvasSize = Object.freeze({
  width: 6000,
  height: 3600,
});

export const MIN_WAREHOUSE_CANVAS_WIDTH = 800;
export const MIN_WAREHOUSE_CANVAS_HEIGHT = 600;
export const MAX_WAREHOUSE_CANVAS_WIDTH = 20000;
export const MAX_WAREHOUSE_CANVAS_HEIGHT = 12000;
export const WAREHOUSE_CANVAS_SETTINGS_KEY = "warehouse_map_canvas";

const EPSILON = 1e-7;
const PRECISION = 1e12;

function numericDimension(value: unknown) {
  if (typeof value === "string" && !value.trim()) return Number.NaN;
  return Number(value);
}

export function validateWarehouseCanvasSize(input: unknown): WarehouseCanvasSizeValidation {
  if (!input || typeof input !== "object") {
    return { ok: false, error: "请填写地图白色区域的宽度和高度" };
  }
  const candidate = input as Partial<WarehouseCanvasSize>;
  const width = numericDimension(candidate.width);
  const height = numericDimension(candidate.height);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) {
    return { ok: false, error: "地图宽度和高度必须是整数" };
  }
  if (width < MIN_WAREHOUSE_CANVAS_WIDTH || width > MAX_WAREHOUSE_CANVAS_WIDTH) {
    return {
      ok: false,
      error: `地图宽度请输入 ${MIN_WAREHOUSE_CANVAS_WIDTH}–${MAX_WAREHOUSE_CANVAS_WIDTH}px`,
    };
  }
  if (height < MIN_WAREHOUSE_CANVAS_HEIGHT || height > MAX_WAREHOUSE_CANVAS_HEIGHT) {
    return {
      ok: false,
      error: `地图高度请输入 ${MIN_WAREHOUSE_CANVAS_HEIGHT}–${MAX_WAREHOUSE_CANVAS_HEIGHT}px`,
    };
  }
  return { ok: true, size: { width, height } };
}

export function normalizeWarehouseCanvasSize(
  input: unknown,
  fallback: WarehouseCanvasSize = DEFAULT_WAREHOUSE_CANVAS_SIZE,
): WarehouseCanvasSize {
  const parsed = validateWarehouseCanvasSize(input);
  if (parsed.ok) return parsed.size;
  const safeFallback = validateWarehouseCanvasSize(fallback);
  return safeFallback.ok ? safeFallback.size : { ...DEFAULT_WAREHOUSE_CANVAS_SIZE };
}

function scaled(value: number, ratio: number) {
  return Math.round(value * ratio * PRECISION) / PRECISION;
}

function resizeBox<T extends LayoutBox>(
  box: T,
  widthRatio: number,
  heightRatio: number,
): T {
  return {
    ...box,
    x: scaled(box.x, widthRatio),
    y: scaled(box.y, heightRatio),
    w: scaled(box.w, widthRatio),
    h: scaled(box.h, heightRatio),
  };
}

/**
 * Re-express percentage geometry on a differently sized canvas while keeping
 * every element's physical pixel position and size anchored to the top-left.
 */
export function resizeWarehouseZonesForCanvas(
  zones: WarehouseZoneRecord[],
  from: WarehouseCanvasSize,
  to: WarehouseCanvasSize,
): WarehouseZoneRecord[] {
  const source = validateWarehouseCanvasSize(from);
  const target = validateWarehouseCanvasSize(to);
  if (!source.ok) throw new RangeError(source.error);
  if (!target.ok) throw new RangeError(target.error);
  const widthRatio = source.size.width / target.size.width;
  const heightRatio = source.size.height / target.size.height;
  return zones.map(zone => ({
    ...zone,
    layout: zone.layout
      ? Object.fromEntries(
          Object.entries(zone.layout).map(([code, box]) => [
            code,
            resizeBox(box, widthRatio, heightRatio),
          ]),
        )
      : zone.layout,
    features: zone.features?.map(feature => resizeBox(feature, widthRatio, heightRatio)),
    mapBox: zone.mapBox ? resizeBox(zone.mapBox, widthRatio, heightRatio) : zone.mapBox,
  }));
}

function warehouseZonesToCanonicalCanvas(
  zones: WarehouseZoneRecord[],
  canvas: WarehouseCanvasSize,
) {
  return zones.map(zone => zone.layoutVersion === WAREHOUSE_LAYOUT_VERSION
    ? resizeWarehouseZonesForCanvas(
        [zone],
        canvas,
        DEFAULT_WAREHOUSE_CANVAS_SIZE,
      )[0]
    : zone);
}

/**
 * Required warehouse geometry is authored in the canonical 6000x3600 space.
 * Convert custom-canvas percentages there before merging, then convert the
 * complete result back so missing required locations keep their pixel shape.
 */
export function mergeRequiredWarehouseZonesForCanvas(
  zones: WarehouseZoneRecord[],
  canvas: WarehouseCanvasSize,
): WarehouseZoneRecord[] {
  const sizeResult = validateWarehouseCanvasSize(canvas);
  if (!sizeResult.ok) throw new RangeError(sizeResult.error);
  const size = sizeResult.size;
  const canonical = warehouseZonesToCanonicalCanvas(zones, size);
  const merged = mergeRequiredWarehouseZones(canonical);
  return merged.map(zone => zone.layoutVersion === WAREHOUSE_LAYOUT_VERSION
    ? resizeWarehouseZonesForCanvas(
        [zone],
        DEFAULT_WAREHOUSE_CANVAS_SIZE,
        size,
      )[0]
    : zone);
}

export function normalizeWarehouseZonesForCanvas(
  zones: WarehouseZoneRecord[],
  canvas: WarehouseCanvasSize,
  options: { repairSaved?: boolean } = {},
): WarehouseZoneRecord[] {
  const sizeResult = validateWarehouseCanvasSize(canvas);
  if (!sizeResult.ok) throw new RangeError(sizeResult.error);
  const size = sizeResult.size;
  const canonical = warehouseZonesToCanonicalCanvas(zones, size);
  const normalized = normalizeWarehouseZones(canonical, options);
  return resizeWarehouseZonesForCanvas(
    normalized,
    DEFAULT_WAREHOUSE_CANVAS_SIZE,
    size,
  );
}

export function normalizeWarehouseZoneForCanvas(
  zone: WarehouseZoneRecord,
  canvas: WarehouseCanvasSize,
): WarehouseZoneRecord {
  const sizeResult = validateWarehouseCanvasSize(canvas);
  if (!sizeResult.ok) throw new RangeError(sizeResult.error);
  const size = sizeResult.size;
  const canonical = warehouseZonesToCanonicalCanvas([zone], size)[0];
  const normalized = normalizeWarehouseZone(canonical);
  return resizeWarehouseZonesForCanvas(
    [normalized],
    DEFAULT_WAREHOUSE_CANVAS_SIZE,
    size,
  )[0];
}

function mapBoxes(zones: WarehouseZoneRecord[]) {
  return zones.flatMap(zone => [
    ...Object.values(zone.layout ?? {}),
    ...(zone.features ?? []),
    ...(zone.unified === false && zone.mapBox ? [zone.mapBox] : []),
  ]);
}

export function warehouseCanvasContentBounds(
  zones: WarehouseZoneRecord[],
  canvas: WarehouseCanvasSize,
): WarehouseCanvasContentBounds {
  const size = normalizeWarehouseCanvasSize(canvas);
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  let itemCount = 0;
  let invalidCount = 0;
  for (const box of mapBoxes(zones)) {
    if (
      ![box.x, box.y, box.w, box.h].every(Number.isFinite)
      || box.w < 0
      || box.h < 0
    ) {
      invalidCount += 1;
      continue;
    }
    const boxLeft = box.x / 100 * size.width;
    const boxTop = box.y / 100 * size.height;
    const boxRight = (box.x + box.w) / 100 * size.width;
    const boxBottom = (box.y + box.h) / 100 * size.height;
    left = Math.min(left, boxLeft);
    top = Math.min(top, boxTop);
    right = Math.max(right, boxRight);
    bottom = Math.max(bottom, boxBottom);
    itemCount += 1;
  }
  if (!itemCount) left = top = right = bottom = 0;
  return {
    left,
    top,
    right,
    bottom,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
    itemCount,
    invalidCount,
  };
}

export function validateWarehouseCanvasContent(
  zones: WarehouseZoneRecord[],
  canvas: WarehouseCanvasSize,
): WarehouseCanvasContentValidation {
  const sizeResult = validateWarehouseCanvasSize(canvas);
  const size = sizeResult.ok ? sizeResult.size : normalizeWarehouseCanvasSize(canvas);
  const bounds = warehouseCanvasContentBounds(zones, size);
  const minimum = {
    width: Math.max(MIN_WAREHOUSE_CANVAS_WIDTH, Math.ceil(Math.max(0, bounds.right))),
    height: Math.max(MIN_WAREHOUSE_CANVAS_HEIGHT, Math.ceil(Math.max(0, bounds.bottom))),
  };
  if (!sizeResult.ok) return { ok: false, error: sizeResult.error, size, bounds, minimum };
  if (bounds.invalidCount) {
    return { ok: false, error: "地图中存在无效的库位或区域尺寸", size, bounds, minimum };
  }
  const horizontalOutside = bounds.left < -EPSILON || bounds.right > size.width + EPSILON;
  const verticalOutside = bounds.top < -EPSILON || bounds.bottom > size.height + EPSILON;
  if (horizontalOutside || verticalOutside) {
    const directions = [horizontalOutside ? "宽度" : "", verticalOutside ? "高度" : ""]
      .filter(Boolean)
      .join("和");
    return {
      ok: false,
      error: `地图${directions}不足，会裁掉现有库位或地图元素`,
      size,
      bounds,
      minimum,
    };
  }
  return { ok: true, size, bounds, minimum };
}

export function validateWarehouseCanvasResize(
  zones: WarehouseZoneRecord[],
  from: WarehouseCanvasSize,
  to: WarehouseCanvasSize,
): WarehouseCanvasResizeValidation {
  const sourceResult = validateWarehouseCanvasSize(from);
  const targetResult = validateWarehouseCanvasSize(to);
  const source = sourceResult.ok ? sourceResult.size : normalizeWarehouseCanvasSize(from);
  const bounds = warehouseCanvasContentBounds(zones, source);
  const minimum = {
    width: Math.max(MIN_WAREHOUSE_CANVAS_WIDTH, Math.ceil(Math.max(0, bounds.right))),
    height: Math.max(MIN_WAREHOUSE_CANVAS_HEIGHT, Math.ceil(Math.max(0, bounds.bottom))),
  };
  if (!sourceResult.ok) return { ok: false, error: sourceResult.error, minimum, bounds };
  if (!targetResult.ok) return { ok: false, error: targetResult.error, minimum, bounds };
  const currentContent = validateWarehouseCanvasContent(zones, source);
  if (!currentContent.ok) {
    return { ok: false, error: currentContent.error, minimum, bounds };
  }
  const widthTooSmall = targetResult.size.width < minimum.width;
  const heightTooSmall = targetResult.size.height < minimum.height;
  if (widthTooSmall || heightTooSmall) {
    const requirements = [widthTooSmall ? `宽度至少 ${minimum.width}px` : "", heightTooSmall ? `高度至少 ${minimum.height}px` : ""]
      .filter(Boolean)
      .join("，");
    return {
      ok: false,
      error: `白色地图区域过小，${requirements}，否则会裁掉现有内容`,
      minimum,
      bounds,
    };
  }
  return {
    ok: true,
    size: targetResult.size,
    minimum,
    bounds,
    zones: resizeWarehouseZonesForCanvas(zones, source, targetResult.size),
  };
}

function finiteOr(value: number, fallback: number) {
  return Number.isFinite(value) ? value : fallback;
}

function clampPanAxis(position: number, viewport: number, world: number) {
  if (viewport <= 0) return position;
  const next = world <= viewport
    ? (viewport - world) / 2
    : Math.max(viewport - world, Math.min(0, position));
  return Math.round(next * 1e9) / 1e9;
}

export function clampWarehousePan(
  pan: WarehousePan,
  zoom: number,
  viewport: WarehouseViewportSize,
  canvas: WarehouseCanvasSize,
): WarehousePan {
  const size = normalizeWarehouseCanvasSize(canvas);
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const viewportWidth = Math.max(0, finiteOr(viewport.width, 0));
  const viewportHeight = Math.max(0, finiteOr(viewport.height, 0));
  const x = finiteOr(pan.x, 0);
  const y = finiteOr(pan.y, 0);
  return {
    x: clampPanAxis(x, viewportWidth, size.width * safeZoom),
    y: clampPanAxis(y, viewportHeight, size.height * safeZoom),
  };
}

function miniMapAxisRange(viewport: number, panel: number, inset: number) {
  if (viewport >= panel + inset * 2) return { min: inset, max: viewport - panel - inset };
  return { min: 0, max: Math.max(0, viewport - panel) };
}

export function clampMiniMapPosition(
  position: WarehouseMiniMapPosition,
  viewport: WarehouseViewportSize,
  panel: WarehouseViewportSize,
  options: { inset?: number } = {},
): WarehouseMiniMapPosition {
  const inset = Math.max(0, finiteOr(options.inset ?? 14, 14));
  const viewportWidth = Math.max(0, finiteOr(viewport.width, 0));
  const viewportHeight = Math.max(0, finiteOr(viewport.height, 0));
  const panelWidth = Math.max(0, finiteOr(panel.width, 0));
  const panelHeight = Math.max(0, finiteOr(panel.height, 0));
  const horizontal = miniMapAxisRange(viewportWidth, panelWidth, inset);
  const vertical = miniMapAxisRange(viewportHeight, panelHeight, inset);
  return {
    left: Math.max(horizontal.min, Math.min(horizontal.max, finiteOr(position.left, horizontal.min))),
    top: Math.max(vertical.min, Math.min(vertical.max, finiteOr(position.top, vertical.min))),
  };
}

export function defaultMiniMapPosition(
  viewport: WarehouseViewportSize,
  panel: WarehouseViewportSize,
  options: { inset?: number } = {},
): WarehouseMiniMapPosition {
  const inset = Math.max(0, finiteOr(options.inset ?? 14, 14));
  return clampMiniMapPosition(
    { left: inset, top: finiteOr(viewport.height, 0) - finiteOr(panel.height, 0) - inset },
    viewport,
    panel,
    { inset },
  );
}
