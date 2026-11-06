import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  DEFAULT_WAREHOUSE_CANVAS_SIZE,
  MAX_WAREHOUSE_CANVAS_HEIGHT,
  MAX_WAREHOUSE_CANVAS_WIDTH,
  MIN_WAREHOUSE_CANVAS_HEIGHT,
  MIN_WAREHOUSE_CANVAS_WIDTH,
  WAREHOUSE_CANVAS_SETTINGS_KEY,
  clampMiniMapPosition,
  clampWarehousePan,
  defaultMiniMapPosition,
  mergeRequiredWarehouseZonesForCanvas,
  normalizeWarehouseCanvasSize,
  normalizeWarehouseZoneForCanvas,
  normalizeWarehouseZonesForCanvas,
  resizeWarehouseZonesForCanvas,
  validateWarehouseCanvasContent,
  validateWarehouseCanvasResize,
  validateWarehouseCanvasSize,
  warehouseCanvasContentBounds,
} from "../lib/warehouse-canvas.ts";
import {
  actualWarehouseLayout,
  requiredWarehouseFeatures,
  requiredZoneSpecs,
  WAREHOUSE_LAYOUT_VERSION,
} from "../lib/warehouse-layout.ts";

const close = (actual, expected, message) => {
  assert.ok(Math.abs(actual - expected) < 1e-7, `${message}: ${actual} !== ${expected}`);
};

const sampleZones = () => [{
  id: "CUSTOM",
  title: "自定义区",
  codes: ["X1"],
  layoutVersion: WAREHOUSE_LAYOUT_VERSION,
  layout: {
    X1: {
      x: 10,
      y: 20,
      w: 5,
      h: 10,
      capacityPallets: 2,
      capacityBoxes: 18,
      groupId: "rack-group",
      groupLocked: true,
      customField: "keep-location",
    },
  },
  features: [{
    id: "frame",
    type: "box",
    label: "保留框",
    color: "#123456",
    x: 40,
    y: 25,
    w: 10,
    h: 20,
    customField: "keep-feature",
  }],
  mapBox: { x: 70, y: 60, w: 5, h: 5, customField: "keep-map-box" },
  unified: false,
  customZoneField: "keep-zone",
}];

test("canvas size validation falls back safely while accepting bounded integer input", () => {
  assert.deepEqual(DEFAULT_WAREHOUSE_CANVAS_SIZE, { width: 6000, height: 3600 });
  assert.equal(WAREHOUSE_CANVAS_SETTINGS_KEY, "warehouse_map_canvas");
  assert.deepEqual(validateWarehouseCanvasSize({ width: "8000", height: "4800" }), {
    ok: true,
    size: { width: 8000, height: 4800 },
  });
  for (const value of [
    null,
    {},
    { width: 1.5, height: 1000 },
    { width: MIN_WAREHOUSE_CANVAS_WIDTH - 1, height: 1000 },
    { width: 1000, height: MIN_WAREHOUSE_CANVAS_HEIGHT - 1 },
    { width: MAX_WAREHOUSE_CANVAS_WIDTH + 1, height: 1000 },
    { width: 1000, height: MAX_WAREHOUSE_CANVAS_HEIGHT + 1 },
  ]) assert.equal(validateWarehouseCanvasSize(value).ok, false);
  assert.deepEqual(normalizeWarehouseCanvasSize({ width: 0, height: 0 }), {
    width: 6000,
    height: 3600,
  });
  assert.deepEqual(
    normalizeWarehouseCanvasSize({}, { width: 9000, height: 5000 }),
    { width: 9000, height: 5000 },
  );
});

test("resizing a canvas preserves every physical pixel and metadata without mutation", () => {
  const source = sampleZones();
  const before = structuredClone(source);
  const target = { width: 12000, height: 7200 };
  const resized = resizeWarehouseZonesForCanvas(
    source,
    DEFAULT_WAREHOUSE_CANVAS_SIZE,
    target,
  );

  assert.deepEqual(source, before, "the source layout must remain untouched");
  assert.notEqual(resized, source);
  assert.notEqual(resized[0].layout.X1, source[0].layout.X1);
  assert.equal(resized[0].customZoneField, "keep-zone");
  assert.equal(resized[0].layout.X1.customField, "keep-location");
  assert.equal(resized[0].features[0].customField, "keep-feature");
  assert.equal(resized[0].mapBox.customField, "keep-map-box");
  assert.equal(resized[0].layout.X1.capacityPallets, 2);
  assert.equal(resized[0].layout.X1.groupLocked, true);

  for (const key of ["x", "w"]) {
    close(
      resized[0].layout.X1[key] / 100 * target.width,
      source[0].layout.X1[key] / 100 * DEFAULT_WAREHOUSE_CANVAS_SIZE.width,
      `location ${key} pixels`,
    );
    close(
      resized[0].features[0][key] / 100 * target.width,
      source[0].features[0][key] / 100 * DEFAULT_WAREHOUSE_CANVAS_SIZE.width,
      `feature ${key} pixels`,
    );
  }
  for (const key of ["y", "h"]) {
    close(
      resized[0].layout.X1[key] / 100 * target.height,
      source[0].layout.X1[key] / 100 * DEFAULT_WAREHOUSE_CANVAS_SIZE.height,
      `location ${key} pixels`,
    );
    close(
      resized[0].mapBox[key] / 100 * target.height,
      source[0].mapBox[key] / 100 * DEFAULT_WAREHOUSE_CANVAS_SIZE.height,
      `map box ${key} pixels`,
    );
  }

  const roundTrip = resizeWarehouseZonesForCanvas(
    resized,
    target,
    DEFAULT_WAREHOUSE_CANVAS_SIZE,
  );
  assert.deepEqual(roundTrip, source);
  assert.throws(
    () => resizeWarehouseZonesForCanvas(source, { width: 0, height: 0 }, target),
    RangeError,
  );
});

test("content bounds include locations, features and map boxes and prevent clipping", () => {
  const zones = sampleZones();
  const bounds = warehouseCanvasContentBounds(zones, DEFAULT_WAREHOUSE_CANVAS_SIZE);
  assert.deepEqual(bounds, {
    left: 600,
    top: 720,
    right: 4500,
    bottom: 2340,
    width: 3900,
    height: 1620,
    itemCount: 3,
    invalidCount: 0,
  });
  assert.deepEqual(validateWarehouseCanvasContent(zones, DEFAULT_WAREHOUSE_CANVAS_SIZE), {
    ok: true,
    size: DEFAULT_WAREHOUSE_CANVAS_SIZE,
    bounds,
    minimum: { width: 4500, height: 2340 },
  });

  const rejected = validateWarehouseCanvasResize(
    zones,
    DEFAULT_WAREHOUSE_CANVAS_SIZE,
    { width: 4499, height: 2339 },
  );
  assert.equal(rejected.ok, false);
  assert.deepEqual(rejected.minimum, { width: 4500, height: 2340 });
  assert.match(rejected.error, /宽度至少 4500px/);
  assert.match(rejected.error, /高度至少 2340px/);

  const accepted = validateWarehouseCanvasResize(
    zones,
    DEFAULT_WAREHOUSE_CANVAS_SIZE,
    { width: 5000, height: 3000 },
  );
  assert.equal(accepted.ok, true);
  assert.deepEqual(accepted.size, { width: 5000, height: 3000 });
  close(accepted.zones[0].mapBox.x / 100 * 5000, 4200, "accepted map-box x");
  close(accepted.zones[0].mapBox.w / 100 * 5000, 300, "accepted map-box width");

  const outside = sampleZones();
  outside[0].layout.X1.x = -1;
  const invalid = validateWarehouseCanvasContent(outside, DEFAULT_WAREHOUSE_CANVAS_SIZE);
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /会裁掉/);
});

test("hidden unified-zone map boxes do not block validation or canvas resizing", () => {
  const defaultZones = normalizeWarehouseZonesForCanvas(
    requiredZoneSpecs.map((zone, index) => ({
      ...zone,
      layout: actualWarehouseLayout(zone.codes),
      features: requiredWarehouseFeatures(zone.id),
      unified: true,
      layoutVersion: WAREHOUSE_LAYOUT_VERSION,
      mapBox: {
        x: 3 + index % 3 * 32,
        y: 5 + Math.floor(index / 3) * 43,
        w: 28,
        h: 36,
      },
    })),
    DEFAULT_WAREHOUSE_CANVAS_SIZE,
  );
  assert.ok(defaultZones.length >= 13);
  assert.ok(
    defaultZones.some(zone => (zone.mapBox?.y ?? 0) + (zone.mapBox?.h ?? 0) > 100),
    "the legacy overview fallback includes map boxes beyond the unified world",
  );
  assert.equal(
    defaultZones.every(zone => zone.unified === true),
    true,
    "the complete default map is rendered directly, not through map boxes",
  );
  assert.equal(
    validateWarehouseCanvasContent(defaultZones, DEFAULT_WAREHOUSE_CANVAS_SIZE).ok,
    true,
  );
  const grown = validateWarehouseCanvasResize(
    defaultZones,
    DEFAULT_WAREHOUSE_CANVAS_SIZE,
    { width: 7000, height: 4200 },
  );
  assert.equal(grown.ok, true);
  assert.equal(grown.zones.length, defaultZones.length);
});

test("custom-canvas merge and normalization generate required geometry in canonical pixels", () => {
  const customCanvas = { width: 12000, height: 7200 };
  const customOnly = resizeWarehouseZonesForCanvas(
    sampleZones(),
    DEFAULT_WAREHOUSE_CANVAS_SIZE,
    customCanvas,
  );
  const merged = mergeRequiredWarehouseZonesForCanvas(customOnly, customCanvas);
  const newA = merged.find(zone => zone.id === "NEW_A");
  assert.ok(newA, "a missing required zone must be created");
  const expectedA1 = actualWarehouseLayout(["新A1"])["新A1"];
  const actualA1 = newA.layout["新A1"];
  close(actualA1.x / 100 * customCanvas.width, expectedA1.x / 100 * 6000, "new A1 x");
  close(actualA1.w / 100 * customCanvas.width, expectedA1.w / 100 * 6000, "new A1 width");
  close(actualA1.y / 100 * customCanvas.height, expectedA1.y / 100 * 3600, "new A1 y");
  close(actualA1.h / 100 * customCanvas.height, expectedA1.h / 100 * 3600, "new A1 height");

  const partialNewA = resizeWarehouseZonesForCanvas([{
    id: "NEW_A",
    title: "新A区",
    codes: ["新A1"],
    layoutVersion: WAREHOUSE_LAYOUT_VERSION,
    layout: { 新A1: actualWarehouseLayout(["新A1"])["新A1"] },
  }], DEFAULT_WAREHOUSE_CANVAS_SIZE, customCanvas);
  const normalized = normalizeWarehouseZonesForCanvas(partialNewA, customCanvas);
  const completedNewA = normalized.find(zone => zone.id === "NEW_A");
  assert.ok(completedNewA.layout["新A2"], "normalization must fill a missing required code");
  const expectedA2 = actualWarehouseLayout(["新A2"])["新A2"];
  close(
    completedNewA.layout["新A2"].x / 100 * customCanvas.width,
    expectedA2.x / 100 * 6000,
    "new A2 x",
  );
  close(
    completedNewA.layout["新A2"].w / 100 * customCanvas.width,
    expectedA2.w / 100 * 6000,
    "new A2 width",
  );

  const single = normalizeWarehouseZoneForCanvas(partialNewA[0], customCanvas);
  assert.equal(single.id, "NEW_A");
  assert.equal(single.codes.length, 1, "single-zone normalization must not merge other zones");
  close(
    single.layout["新A1"].x / 100 * customCanvas.width,
    expectedA1.x / 100 * 6000,
    "single-zone A1 x",
  );

  const legacy = [{
    id: "LEGACY",
    title: "旧版区域",
    codes: ["旧库位"],
    layoutVersion: 7,
    layout: { 旧库位: { x: 20, y: 30, w: 4, h: 5 } },
  }];
  const legacyMerged = mergeRequiredWarehouseZonesForCanvas(legacy, customCanvas);
  const savedLegacy = legacyMerged.find(zone => zone.id === "LEGACY");
  assert.deepEqual(
    savedLegacy.layout["旧库位"],
    legacy[0].layout["旧库位"],
    "legacy percentages must remain in their source coordinate system until normalization",
  );
  const legacyNormalized = normalizeWarehouseZonesForCanvas(legacyMerged, customCanvas);
  const migratedLegacy = legacyNormalized.find(zone => zone.id === "LEGACY");
  close(
    migratedLegacy.layout["旧库位"].x / 100 * customCanvas.width,
    20 / 100 * 4800,
    "legacy x migrates exactly once before custom-canvas scaling",
  );
});

test("pan clamping never exposes space beyond the white canvas", () => {
  const canvas = { width: 6000, height: 3600 };
  assert.deepEqual(
    clampWarehousePan(
      { x: 500, y: -9999 },
      0.55,
      { width: 1200, height: 700 },
      canvas,
    ),
    { x: 0, y: -1280 },
  );
  assert.deepEqual(
    clampWarehousePan(
      { x: -9999, y: 500 },
      0.55,
      { width: 1200, height: 700 },
      canvas,
    ),
    { x: -2100, y: 0 },
  );
  assert.deepEqual(
    clampWarehousePan(
      { x: -900, y: 400 },
      0.1,
      { width: 1200, height: 700 },
      canvas,
    ),
    { x: 300, y: 170 },
    "a canvas smaller than the viewport stays centered on each axis",
  );
  assert.deepEqual(
    clampWarehousePan(
      { x: 17, y: 23 },
      0.55,
      { width: 0, height: 0 },
      canvas,
    ),
    { x: 17, y: 23 },
    "measurement startup must not reset the user's pan",
  );
});

test("the minimap starts at bottom-left and remains entirely inside the viewport", () => {
  const viewport = { width: 1200, height: 700 };
  const panel = { width: 380, height: 278 };
  assert.deepEqual(defaultMiniMapPosition(viewport, panel), { left: 14, top: 408 });
  assert.deepEqual(
    clampMiniMapPosition({ left: 5000, top: -20 }, viewport, panel),
    { left: 806, top: 14 },
  );
  assert.deepEqual(
    defaultMiniMapPosition({ width: 300, height: 200 }, panel),
    { left: 0, top: 0 },
    "an oversized panel pins to the viewport origin instead of escaping",
  );
  assert.deepEqual(
    clampMiniMapPosition(
      { left: 0, top: 0 },
      viewport,
      panel,
      { inset: 20 },
    ),
    { left: 20, top: 20 },
  );
});

test("locations API persists canvas separately and returns it from every operation", async () => {
  const route = await readFile(new URL("../app/api/locations/route.ts", import.meta.url), "utf8");
  assert.match(route, /WAREHOUSE_CANVAS_SETTINGS_KEY/);
  assert.match(route, /mergeRequiredWarehouseZonesForCanvas/);
  assert.match(route, /validateWarehouseCanvasContent/);
  assert.ok(
    (route.match(/inArray\(settings\.key, \[ZONES_SETTINGS_KEY, WAREHOUSE_CANVAS_SETTINGS_KEY(?:, LOCATION_ALIASES_KEY)?(?:, LAYER_PRICING_KEY)?\]\)/g) ?? []).length >= 2,
    "zones and canvas must be read together so their coordinate systems cannot be mixed",
  );
  assert.doesNotMatch(route, /Promise\.all\(\[\s*db\.select\(\)\.from\(settings\)/s);
  assert.match(route, /await db\.batch\(batchTuple\(queries\)\)/);
  assert.match(route, /return Response\.json\(\{ zones, canvas, revision:/);
  assert.match(route, /return Response\.json\(\{ zones: mergedZones, canvas: canvasResult\.size, updatedAt, revision:/);
  assert.match(route, /canvas,\s*updatedAt,/s);
  assert.doesNotMatch(route, /JSON\.stringify\(\{\s*zones,\s*canvas/s);
});

test("the page wires custom canvas sizing, bounded navigation and a bottom-left minimap", async () => {
  const [page, minimapCss, resizeCss] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/minimap.css", import.meta.url), "utf8"),
    readFile(new URL("../app/resize.css", import.meta.url), "utf8"),
  ]);
  assert.match(page, /const DEFAULT_MAP_ZOOM=\.55/);
  assert.match(page, /useState\(DEFAULT_MAP_ZOOM\)/);
  assert.match(page, /zoomRef=useRef\(DEFAULT_MAP_ZOOM\)/);
  assert.match(page, /setZoom\(DEFAULT_MAP_ZOOM\)/);
  assert.match(page, /const returnToMap=.*resetView\(\)/s);
  assert.match(page, /defaultMiniMapPosition\(viewport,panel/);
  assert.match(page, /miniResetPending\.current=false/);
  assert.ok((page.match(/clampWarehousePan\(/g) ?? []).length >= 6, "every navigation path should share the pan boundary helper");
  assert.match(page, /validateWarehouseCanvasResize\(zones,warehouseCanvasSize,requested\)/);
  assert.match(page, /JSON\.stringify\(\{zones:next,renames,canvas:warehouseCanvasSize,expectedRevision:mapRevision\.current\}\)/);
  assert.match(page, /--warehouse-map-width":`\$\{warehouseCanvasSize\.width\}px`/);
  assert.match(page, /--warehouse-map-height":`\$\{warehouseCanvasSize\.height\}px`/);
  assert.match(page, /className="canvas-size-editor"/);
  assert.match(page, /宽度（px）/);
  assert.match(page, /高度（px）/);
  assert.match(minimapCss, /\.warehouse-canvas\{[^}]*background:#fff!important;[^}]*background-image:none!important/s);
  assert.match(minimapCss, /\.warehouse-canvas:before\{display:none!important\}/);
  assert.match(minimapCss, /\.map-world\{background:#fff!important\}/);
  assert.match(resizeCss, /\.canvas-size-editor\{/);
});
