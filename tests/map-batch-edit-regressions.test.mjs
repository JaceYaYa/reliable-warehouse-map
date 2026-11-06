import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  MIN_LOCATION_HEIGHT_PX,
  MIN_LOCATION_WIDTH_PX,
  alignSelectedLocations,
  resizeSelectedLocations,
  summarizeSelectedLocationSizes,
} from "../lib/map-batch-edit.ts";

const location = (key, box) => ({ key: `location:${key}`, kind: "location", box });
const feature = (key, box) => ({ key: `feature:${key}`, kind: "feature", box });
const applyPatch = (item, result) => ({ ...item.box, ...(result.patches[item.key] || {}) });

test("typed world-pixel width and height convert independently and ignore map features", () => {
  const items = [
    location("A1", { x: 10, y: 20, w: 1, h: 1, capacityPallets: 2, groupId: "g1", custom: "keep" }),
    location("A2", { x: 30, y: 40, w: 3, h: 4, capacityBoxes: 18 }),
    feature("area", { x: 5, y: 5, w: 50, h: 50, label: "保留区域", color: "#123456" }),
  ];
  const result = resizeSelectedLocations(items, "120", "72", 6000, 3600);

  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.equal(result.locationCount, 2);
  assert.equal(result.ignoredCount, 1);
  assert.deepEqual(result.patches, {
    "location:A1": { w: 2, h: 2 },
    "location:A2": { w: 2, h: 2 },
  });
  assert.deepEqual(applyPatch(items[0], result), {
    x: 10, y: 20, w: 2, h: 2, capacityPallets: 2, groupId: "g1", custom: "keep",
  });
  assert.deepEqual(applyPatch(items[2], result), items[2].box);
  assert.deepEqual(resizeSelectedLocations(items, "120", "72", 6000, 3600).patches, result.patches);
});

test("width-only and height-only edits preserve the other dimension", () => {
  const items = [location("B1", { x: 10, y: 10, w: 2, h: 3 })];
  const width = resizeSelectedLocations(items, "180", "", 6000, 3600);
  const height = resizeSelectedLocations(items, "", "108", 6000, 3600);
  assert.deepEqual(applyPatch(items[0], width), { x: 10, y: 10, w: 3, h: 3 });
  assert.deepEqual(applyPatch(items[0], height), { x: 10, y: 10, w: 2, h: 3 });
  assert.equal(height.changed, false, "applying an existing height must be a no-op");
});

test("selected locations report current pixel sizes and identify mixed dimensions", () => {
  const uniform = summarizeSelectedLocationSizes([
    location("S1", { x: 1, y: 1, w: 2, h: 2 }),
    location("S2", { x: 5, y: 5, w: 2 + 1e-10, h: 2 }),
    feature("label", { x: 0, y: 0, w: 10, h: 10 }),
  ], 6000, 3600);
  assert.equal(uniform.locationCount, 2);
  assert.equal(uniform.ignoredCount, 1);
  assert.deepEqual(uniform.width, {
    min: 120, max: 120, distinctCount: 1, uniform: true, label: "120px（统一）",
  });
  assert.deepEqual(uniform.height, {
    min: 72, max: 72, distinctCount: 1, uniform: true, label: "72px（统一）",
  });

  const mixed = summarizeSelectedLocationSizes([
    location("S1", { x: 1, y: 1, w: 2, h: 2 }),
    location("S2", { x: 5, y: 5, w: 3, h: 2 }),
  ], 6000, 3600);
  assert.equal(mixed.width.label, "混合 120–180px（2种）");
  assert.equal(mixed.height.label, "72px（统一）");

  const empty = summarizeSelectedLocationSizes([
    feature("label", { x: 0, y: 0, w: 10, h: 10 }),
  ], 6000, 3600);
  assert.equal(empty.locationCount, 0);
  assert.equal(empty.ignoredCount, 1);
  assert.equal(empty.width.label, "—");
  assert.equal(summarizeSelectedLocationSizes([
    location("S1", { x: 1, y: 1, w: 2, h: 2 }),
  ], 0, 3600).height.label, "—");
});

test("resize rejects invalid, locked and out-of-bounds batches atomically", () => {
  const base = [
    location("C1", { x: 98, y: 20, w: 1, h: 2 }),
    location("C2", { x: 40, y: 40, w: 1, h: 2 }),
  ];
  for (const [width, height] of [["", ""], ["0", ""], ["abc", ""], ["", "Infinity"]]) {
    const result = resizeSelectedLocations(base, width, height, 6000, 3600);
    assert.equal(result.ok, false);
    assert.deepEqual(result.patches, {});
  }
  const tooWide = resizeSelectedLocations(base, "180", "", 6000, 3600);
  assert.equal(tooWide.ok, false);
  assert.match(tooWide.error, /右边界/);
  assert.deepEqual(tooWide.patches, {});

  const locked = resizeSelectedLocations([
    ...base,
    feature("locked-frame", { x: 0, y: 0, w: 10, h: 10, groupLocked: true }),
  ], "120", "72", 6000, 3600);
  assert.equal(locked.ok, false);
  assert.match(locked.error, /锁定/);
  assert.deepEqual(locked.patches, {});
  assert.equal(MIN_LOCATION_WIDTH_PX, 64);
  assert.equal(MIN_LOCATION_HEIGHT_PX, 58);
});

test("row and column alignment preserve the existing grid instead of collapsing it", () => {
  const items = [
    location("R1C1", { x: 10, y: 10, w: 2, h: 2, custom: 1 }),
    location("R1C2", { x: 20, y: 10.25, w: 2, h: 2, custom: 2 }),
    location("R2C1", { x: 10.15, y: 20.2, w: 2, h: 2, custom: 3 }),
    location("R2C2", { x: 20.1, y: 20, w: 2, h: 2, custom: 4 }),
    location("R3C1", { x: 9.9, y: 30.1, w: 2, h: 2, custom: 5 }),
    location("R3C2", { x: 19.85, y: 30, w: 2, h: 2, custom: 6 }),
    feature("frame", { x: 1, y: 1, w: 90, h: 90 }),
  ];
  const horizontal = alignSelectedLocations(items, "horizontal", 6000, 3600);
  const vertical = alignSelectedLocations(items, "vertical", 6000, 3600);
  assert.equal(horizontal.ok, true);
  assert.equal(horizontal.locationCount, 6);
  assert.deepEqual(items.slice(0, 6).map(item => applyPatch(item, horizontal).y), [10, 10, 20, 20, 30, 30]);
  assert.deepEqual(items.slice(0, 6).map(item => applyPatch(item, horizontal).x), items.slice(0, 6).map(item => item.box.x));
  assert.deepEqual(items.slice(0, 6).map(item => applyPatch(item, vertical).x), [9.9, 19.85, 9.9, 19.85, 9.9, 19.85]);
  assert.deepEqual(items.slice(0, 6).map(item => applyPatch(item, vertical).y), items.slice(0, 6).map(item => item.box.y));
  assert.deepEqual(applyPatch(items[1], horizontal), { x: 20, y: 10, w: 2, h: 2, custom: 2 });
  assert.deepEqual(horizontal.patches[items[1].key], { y: 10 });
  assert.deepEqual(applyPatch(items[6], horizontal), items[6].box);
  assert.deepEqual(
    alignSelectedLocations([...items].reverse(), "horizontal", 6000, 3600).patches,
    horizontal.patches,
    "alignment must not depend on selection order",
  );
  const alignedItems = items.map(item => item.kind === "location"
    ? { ...item, box: applyPatch(item, horizontal) }
    : item);
  assert.equal(alignSelectedLocations(alignedItems, "horizontal", 6000, 3600).changed, false);
});

test("large locations cannot absorb a nearby row or column of small locations", () => {
  const items = [
    location("small-1", { x: 10, y: 10, w: 2, h: 2 }),
    location("small-2", { x: 10.2, y: 10.2, w: 2, h: 2 }),
    location("large-1", { x: 13, y: 13, w: 20, h: 20 }),
    location("large-2", { x: 13.2, y: 13.2, w: 20, h: 20 }),
  ];
  const rows = alignSelectedLocations(items, "horizontal", 6000, 3600);
  const columns = alignSelectedLocations(items, "vertical", 6000, 3600);
  assert.deepEqual(items.map(item => applyPatch(item, rows).y), [10, 10, 13, 13]);
  assert.deepEqual(items.map(item => applyPatch(item, columns).x), [10, 10, 13, 13]);
});

test("alignment rejects locked or too-small selections and repeated alignment is a no-op", () => {
  const one = [location("E1", { x: 5, y: 5, w: 2, h: 2 })];
  assert.equal(alignSelectedLocations(one, "horizontal", 6000, 3600).ok, false);
  const locked = alignSelectedLocations([
    ...one,
    location("E2", { x: 10, y: 5, w: 2, h: 2, groupLocked: true }),
  ], "horizontal", 6000, 3600);
  assert.equal(locked.ok, false);
  assert.deepEqual(locked.patches, {});
  const lockedFeature = alignSelectedLocations([
    ...one,
    location("E2", { x: 10, y: 5.2, w: 2, h: 2 }),
    feature("hidden-area", { x: 0, y: 0, w: 20, h: 20, groupLocked: true }),
  ], "horizontal", 6000, 3600);
  assert.equal(lockedFeature.ok, false);
  assert.deepEqual(lockedFeature.patches, {});
  const aligned = alignSelectedLocations([
    ...one,
    location("E2", { x: 10, y: 5, w: 2, h: 2 }),
  ], "horizontal", 6000, 3600);
  assert.equal(aligned.ok, true);
  assert.equal(aligned.changed, false);

  const separateColumns = [
    location("C1", { x: 10, y: 10, w: 2, h: 2 }),
    location("C2", { x: 10.8, y: 20, w: 2, h: 2 }),
    location("C3", { x: 11.6, y: 30, w: 2, h: 2 }),
  ];
  const stableBands = alignSelectedLocations(separateColumns, "vertical", 6000, 3600);
  assert.deepEqual(separateColumns.map(item => applyPatch(item, stableBands).x), [10, 10, 11.6]);
  assert.equal(alignSelectedLocations(separateColumns, "vertical", 0, 3600).ok, false);
});

test("the map editor wires responsive batch controls to the pure geometry helpers", async () => {
  const [page, css, pkg, manager] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/resize.css", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../components/LocationManager.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(page, /resizeSelectedLocations\(selectedMapDetails/);
  assert.match(page, /summarizeSelectedLocationSizes\(selectedMapDetails,warehouseCanvasSize\.width,warehouseCanvasSize\.height\)/);
  assert.match(page, /setBatchLocationSize\(\{width:\"\",height:\"\"\}\)/);
  assert.match(page, /alignSelectedLocations\(selectedMapDetails,direction,warehouseCanvasSize\.width,warehouseCanvasSize\.height\)/);
  assert.match(page, /kind===\"location\"/);
  assert.match(page, /features!\.map\(f=>\(\{key:`feature:/);
  assert.match(page, /visibleMapItems=\(source=zones\)=>allMapItems\(source\)\.filter\(item=>item\.kind===\"location\"\|\|item\.featureType===\"label\"\|\|item\.featureType===\"box\"\|\|item\.featureType===\"line\"\)/);
  assert.match(page, /others=visibleMapItems\(\)\.filter/);
  assert.match(page, /className=\"map-batchbar\"/);
  assert.match(page, /className=\"map-batch-summary\"/);
  assert.match(page, /所选当前尺寸/);
  assert.match(page, /新宽度（px）/);
  assert.match(page, /新高度（px）/);
  assert.match(page, /step=\"0\.01\"/);
  assert.match(page, /按行对齐/);
  assert.match(page, /按列对齐/);
  assert.match(page, /aria-pressed=\{selectionMode\}/);
  assert.match(page, /mapSaveInFlight=useRef\(false\)/);
  assert.match(page, /if\(mapEdit\|\|mapLayoutDirty\)throw Error\("地图布局尚未保存/);
  assert.match(page, /blocked=\{capacitySaveBlocked\}/);
  assert.match(page, /if\(!result\.changed\).*?return\}if\(patchMapItems/s);
  assert.match(page, /drag\.current\?\.kind===\"location\"\|\|multiDrag\.current\)\)\{mapDirty\.current=true;setMapLayoutDirty\(true\);setZones\(zs=>normalizeZones\(zs,true\)\)\}/);
  assert.match(manager, /className="config-modal"[^>]*aria-busy=\{saving\}/);
  assert.match(manager, /className="save-layout" disabled=\{saving\}/);
  assert.match(css, /\.map-batchbar/);
  assert.match(css, /@media\(max-width:760px\)/);
  assert.match(css, /@media\(max-width:650px\)/);
  assert.match(css, /@media\(max-width:480px\)/);
  assert.match(css, /\.map-batch-summary/);
  assert.match(css, /max-height:none/);
  assert.match(pkg, /tests\/map-batch-edit-regressions\.test\.mjs/);
});
