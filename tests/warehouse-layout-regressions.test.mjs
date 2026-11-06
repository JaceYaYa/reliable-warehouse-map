import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  actualWarehouseLayout,
  LEGACY_WAREHOUSE_MAP_WIDTH,
  LEGACY_WAREHOUSE_MAP_HEIGHT,
  mergeRequiredWarehouseZones,
  migrateLegacyLayoutBox,
  migrateV5LayoutBox,
  migrateV6LayoutBox,
  migrateV7LayoutBox,
  NEW_PALLET_CAPACITY,
  NEW_PALLET_CAPACITY_VERSION,
  newWarehouseAisleSpecs,
  newWarehouseZoneSpecs,
  normalizeWarehouseZone,
  normalizeWarehouseZones,
  requiredZoneSpecs,
  requiredWarehouseFeatures,
  V5_WAREHOUSE_MAP_HEIGHT,
  V5_WAREHOUSE_MAP_WIDTH,
  V6_WAREHOUSE_MAP_HEIGHT,
  V6_WAREHOUSE_MAP_WIDTH,
  V7_WAREHOUSE_MAP_HEIGHT,
  V7_WAREHOUSE_MAP_WIDTH,
  WAREHOUSE_LAYOUT_VERSION,
  WAREHOUSE_MAP_HEIGHT,
  WAREHOUSE_MAP_WIDTH,
  WAREHOUSE_TOP_EXTENSION,
} from "../lib/warehouse-layout.ts";
import { calculateCapacityStatus } from "../lib/stock-transfer.ts";
import { summarizeNewZonePalletAvailability } from "../lib/warehouse-capacity.ts";

test("pallet availability counts only the four new warehouse zones", () => {
  const zones = mergeRequiredWarehouseZones([]);
  const summary = summarizeNewZonePalletAvailability(zones, [
    { locationCode: "A1", palletCount: 6, totalBoxes: 10 },
    { locationCode: "A1通道", palletCount: 2, totalBoxes: 10 },
    { locationCode: "D1通道", palletCount: 2, totalBoxes: 10 },
    { locationCode: "L1", palletCount: 2, totalBoxes: 10 },
  ]);
  assert.deepEqual(summary.map(zone => [zone.label, zone.remainingPallets]), [
    ["A区", 76], ["B区", 68], ["C区", 68], ["D区", 60],
  ]);
  assert.ok(summary.every(zone => zone.unconfiguredLocations === 0));
});

test("pallet availability sums multiple stocks and keeps fractional free space", () => {
  const zones = [{ id: "NEW_A", codes: ["新A1", "新A2"], layout: { 新A1: { capacityPallets: 2 }, 新A2: { capacityPallets: 2 } } }];
  const stocks = [
    { locationCode: "新A1", palletCount: 1, totalBoxes: 3 },
    { locationCode: "新A1", palletCount: 0.5, totalBoxes: 2 },
  ];
  const before = structuredClone({ zones, stocks });
  assert.equal(summarizeNewZonePalletAvailability(zones, stocks)[0].remainingPallets, 2.5);
  assert.deepEqual({ zones, stocks }, before);
  assert.equal(summarizeNewZonePalletAvailability(zones, [...stocks, { locationCode: "新A2", palletCount: 1, totalBoxes: 1 }])[0].remainingPallets, 1.5);
});

test("full and overloaded locations do not cancel another location's free pallets", () => {
  const zones = [{ id: "NEW_B", codes: ["新B1", "新B2", "新B3"], layout: {
    新B1: { capacityPallets: 2 }, 新B2: { capacityPallets: 2, capacityBoxes: 10 }, 新B3: { capacityPallets: 2 },
  } }];
  const summary = summarizeNewZonePalletAvailability(zones, [
    { locationCode: "新B1", palletCount: 5, totalBoxes: 5 },
    { locationCode: "新B2", palletCount: 1, totalBoxes: 10 },
  ]);
  assert.equal(summary[1].remainingPallets, 2);
});

test("unlimited or missing pallet capacity stays unknown instead of becoming an empty slot", () => {
  const zones = [{ id: "NEW_C", codes: ["新C1", "新C2", "新C3"], layout: {
    新C1: { capacityPallets: 2 }, 新C2: { capacityPallets: 0 }, 新C3: { capacityBoxes: 10 },
  } }];
  const summary = summarizeNewZonePalletAvailability(zones, []);
  assert.equal(summary[2].remainingPallets, 2);
  assert.equal(summary[2].unconfiguredLocations, 2);
  assert.equal(summary[2].locationCount, 3);
  assert.equal(summary[3].locationCount, 0);
  const fullBoxes = summarizeNewZonePalletAvailability(zones, [{ locationCode: "新C3", palletCount: 1, totalBoxes: 10 }]);
  assert.equal(fullBoxes[2].remainingPallets, 2);
  assert.equal(fullBoxes[2].unconfiguredLocations, 1);
});

const expectedNewZones = [
  ["NEW_A", "新A", 38],
  ["NEW_B", "新B", 34],
  ["NEW_C", "新C", 34],
  ["NEW_D", "新D", 30],
];

const previousNewZoneRowY = [48, 188, 328, 468];
const compactNewZoneRowY = [48, 168, 288, 408];

function canonicalNewZoneAtSize(spec, width, height, rowYs = previousNewZoneRowY) {
  const zoneIndex = newWarehouseZoneSpecs.findIndex(zone => zone.id === spec.id);
  const rowY = rowYs[zoneIndex];
  const slotWidthPx = 2.28 / 100 * LEGACY_WAREHOUSE_MAP_WIDTH;
  const slotHeightPx = 3.55 / 100 * LEGACY_WAREHOUSE_MAP_HEIGHT;
  const marginPx = 48;
  const rightX = width - marginPx - slotWidthPx;
  const stepPx = (rightX - marginPx) / 37;
  const layout = Object.fromEntries(spec.codes.map(code => {
    const number = Number(code.slice(2));
    return [code, {
      x: (rightX - (number - 1) * stepPx) / width * 100,
      y: rowY / height * 100,
      w: slotWidthPx / width * 100,
      h: slotHeightPx / height * 100,
    }];
  }));
  const lastX = rightX - (spec.codes.length - 1) * stepPx;
  const left = Math.max(0, lastX - 24);
  const right = Math.min(width, rightX + slotWidthPx + 24);
  const currentFeatures = new Map(requiredWarehouseFeatures(spec.id).map(feature => [feature.id, feature]));
  const box = currentFeatures.get(`required-${spec.id}-box`);
  const label = currentFeatures.get(`required-${spec.id}-label`);
  const features = [
    { ...box, x: left / width * 100, y: (rowY - 36) / height * 100, w: (right - left) / width * 100, h: 112 / height * 100 },
    { ...label, x: (left + 8) / width * 100, y: (rowY - 28) / height * 100, w: 100 / width * 100, h: 27 / height * 100 },
  ];
  return { layout, features };
}

function canonicalV5NewZone(spec) {
  const zoneIndex = newWarehouseZoneSpecs.findIndex(zone => zone.id === spec.id);
  const rowY = previousNewZoneRowY[zoneIndex];
  const slotHeight = 3.55 / 100 * LEGACY_WAREHOUSE_MAP_HEIGHT / V5_WAREHOUSE_MAP_HEIGHT * 100;
  const layout = Object.fromEntries(spec.codes.map(code => {
    const number = Number(code.slice(2));
    return [code, { x: 1.1 + (38 - number) * 2.48, y: rowY / V5_WAREHOUSE_MAP_HEIGHT * 100, w: 2.28, h: slotHeight }];
  }));
  const currentFeatures = new Map(requiredWarehouseFeatures(spec.id).map(feature => [feature.id, feature]));
  return {
    layout,
    features: [
      { ...currentFeatures.get(`required-${spec.id}-box`), x: .55, y: (rowY - 36) / V5_WAREHOUSE_MAP_HEIGHT * 100, w: 96.9, h: 112 / V5_WAREHOUSE_MAP_HEIGHT * 100 },
      { ...currentFeatures.get(`required-${spec.id}-label`), x: .72, y: (rowY - 28) / V5_WAREHOUSE_MAP_HEIGHT * 100, w: 2.9, h: 27 / V5_WAREHOUSE_MAP_HEIGHT * 100 },
    ],
  };
}

const expectedOldZones = [
  ["A", Array.from({ length: 44 }, (_, i) => `A${i + 1}`)],
  ["B", Array.from({ length: 27 }, (_, i) => `B${i + 1}`)],
  ["C", Array.from({ length: 5 }, (_, i) => `C${i + 1}`)],
  ["L", Array.from({ length: 10 }, (_, i) => `L${i + 1}`)],
  ["O", Array.from({ length: 13 }, (_, i) => `办公室${i + 1}`)],
  ["T", Array.from({ length: 18 }, (_, i) => `T${i + 1}`)],
  ["S", Array.from({ length: 8 }, (_, i) => `二仓${i + 1}`)],
  ["Y", Array.from({ length: 8 }, (_, i) => `Y-${i + 1}`)],
  ["R", ["库房操作室1", "库房操作室2"]],
];

test("new warehouse zones contain 136 unique locations", () => {
  assert.equal(newWarehouseZoneSpecs.length, 4);
  for (const [index, [id, prefix, count]] of expectedNewZones.entries()) {
    const zone = newWarehouseZoneSpecs[index];
    assert.equal(zone.id, id);
    assert.deepEqual(zone.codes, Array.from({ length: count }, (_, i) => `${prefix}${i + 1}`));
  }

  const newCodes = newWarehouseZoneSpecs.flatMap(zone => zone.codes);
  const oldSpecs = requiredZoneSpecs.filter(zone => !zone.id.startsWith("NEW_"));
  assert.deepEqual(oldSpecs.map(zone => [zone.id, zone.codes]), expectedOldZones);
  assert.equal(oldSpecs.flatMap(zone => zone.codes).length, 135);
  const allCodes = requiredZoneSpecs.flatMap(zone => zone.codes);
  assert.equal(newCodes.length, 136);
  assert.equal(allCodes.length, 271);
  assert.equal(new Set(newCodes).size, 136);
  assert.equal(new Set(allCodes).size, allCodes.length);
});

test("channel zones stay dormant on fresh maps without a saved channel area", () => {
  const merged = mergeRequiredWarehouseZones([]);
  assert.equal(merged.some(zone => newWarehouseAisleSpecs.some(aisle => aisle.id === zone.id)), false);
  assert.equal(requiredZoneSpecs.some(zone => zone.codes.some(code => code.endsWith("通道"))), false);
  assert.equal(merged.flatMap(zone => zone.codes).length, 136);
});

test("a saved legacy A channel area upgrades in place and creates an aligned independent D channel area", () => {
  const defaults = mergeRequiredWarehouseZones([]);
  const savedNewA = defaults.find(zone => zone.id === "NEW_A");
  const savedNewD = defaults.find(zone => zone.id === "NEW_D");
  const dTop = 24.111;
  const savedDLayout = Object.fromEntries(savedNewD.codes.map(code => [code, { ...savedNewD.layout[code], y: dTop }]));
  savedDLayout["新D31"] = { x: 6.3573, y: dTop, w: .91, h: 2.05, capacityPallets: 7, capacityBoxes: 31, customField: "saved-d31" };
  savedDLayout["新D32"] = { x: 4.82465, y: dTop, w: .91, h: 2.05, capacityPallets: 8, capacityBoxes: 32, customField: "saved-d32" };
  const productionNewD = { ...savedNewD, codes: [...savedNewD.codes, "新D31", "新D32"], layout: savedDLayout };
  const a1Template = { x: savedNewA.layout["新A1"].x, y: 150 / WAREHOUSE_MAP_HEIGHT * 100, w: .88, h: 1.96, capacityPallets: 1, capacityBoxes: 12, groupId: "saved-a-row", groupLocked: true, customField: "keep-a1" };
  const a2Saved = { ...a1Template, x: savedNewA.layout["新A2"].x, capacityBoxes: 19, customField: "keep-a2" };
  const a3Misplaced = { x: 61, y: 62, w: 1.1, h: 1.2, capacityPallets: 4, capacityBoxes: 33, groupId: "reclaimed-a3", customField: "keep-a3" };
  const legacyAisle = {
    id: "production-zone-13",
    title: "新A通道",
    codes: ["A1通道", "A2通道", "A通道备用位"],
    layout: {
      "A1通道": a1Template,
      "A2通道": a2Saved,
      "A通道备用位": { x: 70, y: 71, w: 2, h: 3, capacityBoxes: 55, customField: "keep-extra" },
    },
    features: [{ id: "saved-aisle-feature", type: "box", label: "保留通道框", color: "#123456", x: 1, y: 2, w: 3, h: 4 }],
    mapBox: { x: 81, y: 82, w: 8, h: 9 },
    layoutVersion: WAREHOUSE_LAYOUT_VERSION,
    customZoneField: "keep-zone",
  };
  const misplaced = {
    id: "MISC",
    title: "其他区域",
    codes: ["A3通道", "保留自定义位"],
    layout: { "A3通道": a3Misplaced, "保留自定义位": { x: 73, y: 74, w: 2, h: 2, capacityBoxes: 8 } },
    features: [],
    layoutVersion: WAREHOUSE_LAYOUT_VERSION,
  };
  const input = defaults.map(zone => zone.id === "NEW_D" ? productionNewD : zone).concat(legacyAisle, misplaced);
  const merged = mergeRequiredWarehouseZones(input);
  const aSpec = newWarehouseAisleSpecs.find(spec => spec.id === "AISLE_A");
  const dSpec = newWarehouseAisleSpecs.find(spec => spec.id === "AISLE_D");
  const aZone = merged.find(zone => zone.id === legacyAisle.id);
  const dZone = merged.find(zone => zone.id === dSpec.id);
  const mergedNewA = merged.find(zone => zone.id === "NEW_A");
  const mergedNewD = merged.find(zone => zone.id === "NEW_D");

  assert.equal(aZone.title, "A通道");
  assert.deepEqual(aZone.codes.slice(0, aSpec.codes.length), aSpec.codes);
  assert.ok(aZone.codes.includes("A通道备用位"));
  assert.deepEqual(aZone.layout["A1通道"], a1Template);
  assert.deepEqual(aZone.layout["A2通道"], a2Saved);
  assert.deepEqual(aZone.layout["A3通道"], a3Misplaced);
  assert.equal(aZone.layout["A4通道"].x, mergedNewA.layout["新A4"].x);
  assert.equal(aZone.layout["A4通道"].y, a1Template.y);
  assert.equal(aZone.layout["A4通道"].w, a1Template.w);
  assert.equal(aZone.layout["A4通道"].h, a1Template.h);
  assert.equal(aZone.layout["A4通道"].capacityPallets, a1Template.capacityPallets);
  assert.equal(aZone.layout["A4通道"].capacityBoxes, a1Template.capacityBoxes);
  assert.deepEqual(aZone.features, legacyAisle.features);
  assert.deepEqual(aZone.mapBox, legacyAisle.mapBox);
  assert.equal(aZone.customZoneField, "keep-zone");

  assert.equal(dZone.title, "D通道");
  assert.deepEqual(dZone.codes, dSpec.codes);
  assert.deepEqual(dZone.features, []);
  assert.equal(dZone.layout["D1通道"].x, mergedNewD.layout["新D1"].x);
  assert.ok(Math.abs(dZone.layout["D1通道"].y - (dTop - 100 / WAREHOUSE_MAP_HEIGHT * 100)) < 1e-9);
  assert.equal(dZone.layout["D1通道"].w, a1Template.w);
  assert.equal(dZone.layout["D1通道"].h, a1Template.h);
  assert.equal(dZone.layout["D1通道"].capacityPallets, a1Template.capacityPallets);
  assert.equal(dZone.layout["D1通道"].capacityBoxes, a1Template.capacityBoxes);
  assert.equal(dZone.layout["D31通道"].x, savedDLayout["新D31"].x);
  assert.equal(dZone.layout["D32通道"].x, savedDLayout["新D32"].x);
  assert.deepEqual(mergedNewD.layout["新D31"], savedDLayout["新D31"]);
  assert.deepEqual(mergedNewD.layout["新D32"], savedDLayout["新D32"]);
  assert.equal(mergedNewA.codes.some(code => code.endsWith("通道")), false);
  assert.equal(mergedNewD.codes.some(code => code.endsWith("通道")), false);
  for (const [zone, spec] of [[aZone, aSpec], [dZone, dSpec]]) {
    for (let i = 0; i < spec.codes.length; i += 1) for (let j = i + 1; j < spec.codes.length; j += 1) {
      const first = zone.layout[spec.codes[i]], second = zone.layout[spec.codes[j]];
      const overlaps = first.x < second.x + second.w && first.x + first.w > second.x && first.y < second.y + second.h && first.y + first.h > second.y;
      assert.equal(overlaps, false, `${spec.codes[i]} must not overlap ${spec.codes[j]}`);
    }
  }
  const newABottom = Math.max(...savedNewA.codes.map(code => mergedNewA.layout[code].y + mergedNewA.layout[code].h));
  const aChannelTop = Math.min(...aSpec.codes.map(code => aZone.layout[code].y));
  const dChannelBottom = Math.max(...dSpec.codes.map(code => dZone.layout[code].y + dZone.layout[code].h));
  const newDTop = Math.min(...savedNewD.codes.map(code => mergedNewD.layout[code].y));
  assert.ok(newABottom < aChannelTop, "A channel row must stay below new A locations");
  assert.ok(dChannelBottom < newDTop, "D channel row must stay above new D locations");
  assert.deepEqual(merged.find(zone => zone.id === "MISC").codes, ["保留自定义位"]);
  assert.equal(new Set(merged.flatMap(zone => zone.codes)).size, merged.flatMap(zone => zone.codes).length);
  assert.deepEqual(mergeRequiredWarehouseZones(merged), merged);
  const normalized = normalizeWarehouseZones(input);
  assert.deepEqual(normalized.find(zone => zone.id === legacyAisle.id).layout["A4通道"], aZone.layout["A4通道"]);
  assert.deepEqual(normalized.find(zone => zone.id === dSpec.id).layout["D1通道"], dZone.layout["D1通道"]);
  assert.deepEqual(normalized.find(zone => zone.id === dSpec.id).layout["D31通道"], dZone.layout["D31通道"]);
});

test("an existing D channel template remains authoritative for new D channel boxes", () => {
  const defaults = mergeRequiredWarehouseZones([]);
  const savedNewD = defaults.find(zone => zone.id === "NEW_D");
  const dTop = 24.111;
  const productionNewD = { ...savedNewD, layout: Object.fromEntries(savedNewD.codes.map(code => [code, { ...savedNewD.layout[code], y: dTop }])) };
  const aTemplate = { x: 50, y: 4.166, w: .8, h: 1.8, capacityPallets: 1 };
  const dTemplate = { x: productionNewD.layout["新D1"].x, y: 21.333, w: 1.05, h: 2.15, capacityPallets: 3, capacityBoxes: 27, groupId: "saved-d-template", customField: "keep-d1" };
  const legacyA = { id: "legacy-a", title: "新A通道", codes: ["A1通道"], layout: { "A1通道": aTemplate }, features: [], layoutVersion: WAREHOUSE_LAYOUT_VERSION };
  const savedD = { id: "existing-d", title: "D通道", codes: ["D1通道"], layout: { "D1通道": dTemplate }, features: [{ id: "d-feature", type: "line", label: "保留", x: 1, y: 2, w: 3, h: 4 }], layoutVersion: WAREHOUSE_LAYOUT_VERSION };
  const merged = mergeRequiredWarehouseZones(defaults.map(zone => zone.id === "NEW_D" ? productionNewD : zone).concat(legacyA, savedD));
  const dZone = merged.find(zone => zone.id === savedD.id);
  assert.deepEqual(dZone.layout["D1通道"], dTemplate);
  assert.equal(dZone.layout["D2通道"].x, productionNewD.layout["新D2"].x);
  assert.equal(dZone.layout["D2通道"].y, dTemplate.y);
  assert.equal(dZone.layout["D2通道"].w, dTemplate.w);
  assert.equal(dZone.layout["D2通道"].h, dTemplate.h);
  assert.equal(dZone.layout["D2通道"].capacityPallets, dTemplate.capacityPallets);
  assert.equal(dZone.layout["D2通道"].capacityBoxes, dTemplate.capacityBoxes);
  assert.equal(dZone.layout["D2通道"].groupId, undefined);
  assert.equal(dZone.layout["D2通道"].customField, undefined);
  assert.deepEqual(dZone.features, savedD.features);
});

for (const source of [
  { version: 5, width: V5_WAREHOUSE_MAP_WIDTH, height: V5_WAREHOUSE_MAP_HEIGHT },
  { version: 6, width: V6_WAREHOUSE_MAP_WIDTH, height: V6_WAREHOUSE_MAP_HEIGHT },
  { version: 7, width: V7_WAREHOUSE_MAP_WIDTH, height: V7_WAREHOUSE_MAP_HEIGHT },
]) test(`V${source.version} channel zones inherit the target version, align after one normalization and remain idempotent`, () => {
  const aSpec = newWarehouseZoneSpecs.find(spec => spec.id === "NEW_A");
  const dSpec = newWarehouseZoneSpecs.find(spec => spec.id === "NEW_D");
  const sourceLayout = spec => source.version === 5 ? canonicalV5NewZone(spec).layout : canonicalNewZoneAtSize(spec, source.width, source.height).layout;
  const migrate = box => source.version === 5 ? migrateV5LayoutBox(box) : source.version === 6 ? migrateV6LayoutBox(box) : migrateV7LayoutBox(box);
  const sourceA = sourceLayout(aSpec), sourceD = sourceLayout(dSpec);
  const a1Template = { x: sourceA["新A1"].x + .37, y: sourceA["新A1"].y + 103 / source.height * 100, w: sourceA["新A1"].w * .94, h: sourceA["新A1"].h * .96, capacityPallets: 1, capacityBoxes: 8, groupId: `saved-a1-v${source.version}`, groupLocked: true, customField: "preserve-a1" };
  const a2Template = { ...a1Template, x: sourceA["新A2"].x - .21, capacityBoxes: 9, customField: "preserve-a2" };
  const input = [
    { ...aSpec, layout: sourceA, features: [], layoutVersion: source.version },
    { ...dSpec, layout: sourceD, features: [], layoutVersion: source.version },
    { id: `legacy-a-v${source.version}`, title: "新A通道", codes: ["A1通道", "A2通道"], layout: { "A1通道": a1Template, "A2通道": a2Template }, features: [] },
  ];
  const merged = mergeRequiredWarehouseZones(input);
  const mergedA = merged.find(zone => zone.title === "A通道");
  const mergedD = merged.find(zone => zone.title === "D通道");
  assert.equal(mergedA.layoutVersion, source.version, "an unversioned existing aisle must inherit its target version");
  assert.equal(mergedD.layoutVersion, source.version, "a newly created aisle must inherit its target version");

  const once = normalizeWarehouseZones(input);
  const normalizedA = once.find(zone => zone.title === "A通道");
  const normalizedD = once.find(zone => zone.title === "D通道");
  const normalizedNewA = once.find(zone => zone.id === "NEW_A");
  const normalizedNewD = once.find(zone => zone.id === "NEW_D");
  assert.equal(normalizedA.layoutVersion, WAREHOUSE_LAYOUT_VERSION);
  assert.equal(normalizedD.layoutVersion, WAREHOUSE_LAYOUT_VERSION);
  assert.deepEqual(normalizedA.layout["A1通道"], migrate(a1Template));
  assert.deepEqual(normalizedA.layout["A2通道"], migrate(a2Template));
  for (let number = 3; number <= 38; number += 1) assert.equal(normalizedA.layout[`A${number}通道`].x, normalizedNewA.layout[`新A${number}`].x);
  for (let number = 1; number <= 30; number += 1) assert.equal(normalizedD.layout[`D${number}通道`].x, normalizedNewD.layout[`新D${number}`].x);
  const step = normalizedNewD.layout["新D29"].x - normalizedNewD.layout["新D30"].x;
  assert.ok(Math.abs(normalizedD.layout["D31通道"].x - (normalizedNewD.layout["新D30"].x - step)) < 1e-9);
  assert.ok(Math.abs(normalizedD.layout["D32通道"].x - (normalizedNewD.layout["新D30"].x - step * 2)) < 1e-9);
  assert.ok(Math.abs(normalizedD.layout["D31通道"].y - (normalizedNewD.layout["新D1"].y - 100 / WAREHOUSE_MAP_HEIGHT * 100)) < 1e-9);
  assert.equal(dSpec.codes.length, 30);
  assert.equal(dSpec.codes.includes("新D31"), false);
  assert.equal(dSpec.codes.includes("新D32"), false);
  assert.deepEqual(normalizeWarehouseZones(once), once);
});

for (const source of [
  { version: 5, width: V5_WAREHOUSE_MAP_WIDTH, height: V5_WAREHOUSE_MAP_HEIGHT },
  { version: 6, width: V6_WAREHOUSE_MAP_WIDTH, height: V6_WAREHOUSE_MAP_HEIGHT },
  { version: 7, width: V7_WAREHOUSE_MAP_WIDTH, height: V7_WAREHOUSE_MAP_HEIGHT },
]) test(`V${source.version} keeps a saved D1 channel box while aligning only newly added D channels`, () => {
  const aSpec = newWarehouseZoneSpecs.find(spec => spec.id === "NEW_A");
  const dSpec = newWarehouseZoneSpecs.find(spec => spec.id === "NEW_D");
  const sourceLayout = spec => source.version === 5 ? canonicalV5NewZone(spec).layout : canonicalNewZoneAtSize(spec, source.width, source.height).layout;
  const migrate = box => source.version === 5 ? migrateV5LayoutBox(box) : source.version === 6 ? migrateV6LayoutBox(box) : migrateV7LayoutBox(box);
  const sourceA = sourceLayout(aSpec), sourceD = sourceLayout(dSpec);
  const savedA1 = { x: sourceA["新A1"].x, y: sourceA["新A1"].y + 102 / source.height * 100, w: sourceA["新A1"].w, h: sourceA["新A1"].h, capacityPallets: 1 };
  const savedD1 = { x: sourceD["新D1"].x + .33, y: sourceD["新D1"].y - 99 / source.height * 100, w: sourceD["新D1"].w * .91, h: sourceD["新D1"].h * .95, capacityPallets: 3, capacityBoxes: 17, groupId: `saved-d1-v${source.version}`, groupLocked: true, customField: "preserve-d1" };
  const input = [
    { ...aSpec, layout: sourceA, features: [], layoutVersion: source.version },
    { ...dSpec, layout: sourceD, features: [], layoutVersion: source.version },
    { id: `legacy-a-template-v${source.version}`, title: "新A通道", codes: ["A1通道"], layout: { "A1通道": savedA1 }, features: [] },
    { id: `legacy-d-template-v${source.version}`, title: "D通道", codes: ["D1通道"], layout: { "D1通道": savedD1 }, features: [], layoutVersion: source.version },
  ];
  const once = normalizeWarehouseZones(input);
  const normalizedD = once.find(zone => zone.id === `legacy-d-template-v${source.version}`);
  const normalizedNewD = once.find(zone => zone.id === "NEW_D");
  assert.deepEqual(normalizedD.layout["D1通道"], migrate(savedD1));
  for (let number = 2; number <= 30; number += 1) assert.equal(normalizedD.layout[`D${number}通道`].x, normalizedNewD.layout[`新D${number}`].x);
  assert.deepEqual(normalizeWarehouseZones(once), once);
});

test("all 136 fresh new-zone locations default to a two-pallet capacity", () => {
  const boxes = newWarehouseZoneSpecs.flatMap(zone => Object.values(actualWarehouseLayout(zone.codes)));
  assert.equal(boxes.length, 136);
  assert.ok(boxes.every(box => box.capacityPallets === NEW_PALLET_CAPACITY));

  const created = mergeRequiredWarehouseZones([]).filter(zone => zone.id.startsWith("NEW_"));
  assert.equal(created.length, 4);
  for (const zone of created) {
    assert.equal(zone.newPalletCapacityVersion, NEW_PALLET_CAPACITY_VERSION);
    for (const code of zone.codes) assert.equal(zone.layout[code].capacityPallets, NEW_PALLET_CAPACITY);
  }
});

test("legacy new zones receive the two-pallet capacity once without losing layout or metadata", () => {
  const spec = newWarehouseZoneSpecs[0], fresh = actualWarehouseLayout(spec.codes), first = spec.codes[0], second = spec.codes[1], extra = "新区附加容量测试";
  const firstSaved = { ...fresh[first], x: fresh[first].x + .123, capacityPallets: 0, capacityBoxes: 45, groupId: "capacity-upgrade", groupLocked: true, customField: "keep-me" };
  const secondSaved = { ...fresh[second], capacityPallets: 9, capacityBoxes: 17 };
  const extraSaved = { x: 41, y: 42, w: 3, h: 4, capacityPallets: 7, capacityBoxes: 8, customField: "extra-keep" };
  const legacy = { ...spec, codes: [...spec.codes, extra], layout: { ...fresh, [first]: firstSaved, [second]: secondSaved, [extra]: extraSaved }, features: [], layoutVersion: WAREHOUSE_LAYOUT_VERSION };

  const merged = mergeRequiredWarehouseZones([legacy]).find(zone => zone.id === spec.id);
  assert.equal(merged.newPalletCapacityVersion, NEW_PALLET_CAPACITY_VERSION);
  for (const code of spec.codes) assert.equal(merged.layout[code].capacityPallets, NEW_PALLET_CAPACITY);
  assert.equal(merged.layout[first].x, firstSaved.x);
  assert.equal(merged.layout[first].capacityBoxes, 45);
  assert.equal(merged.layout[first].groupId, "capacity-upgrade");
  assert.equal(merged.layout[first].groupLocked, true);
  assert.equal(merged.layout[first].customField, "keep-me");
  assert.deepEqual(merged.layout[extra], extraSaved);
  assert.equal(legacy.layout[first].capacityPallets, 0, "the upgrade must not mutate its input");

  const normalized = normalizeWarehouseZone(legacy);
  assert.equal(normalized.newPalletCapacityVersion, NEW_PALLET_CAPACITY_VERSION);
  for (const code of spec.codes) assert.equal(normalized.layout[code].capacityPallets, NEW_PALLET_CAPACITY);
  assert.equal(normalized.layout[first].capacityBoxes, 45);
  assert.equal(normalized.layout[first].customField, "keep-me");
  assert.deepEqual(normalized.layout[extra], extraSaved);
  assert.deepEqual(normalizeWarehouseZone(normalized), normalized);
  assert.deepEqual(mergeRequiredWarehouseZones([merged]).find(zone => zone.id === spec.id), merged);
});

test("capacity edits remain authoritative after the new-zone upgrade marker is saved", () => {
  const spec = newWarehouseZoneSpecs[1], fresh = actualWarehouseLayout(spec.codes), first = spec.codes[0], second = spec.codes[1], extra = "新区附加手调容量";
  const marked = {
    ...spec,
    codes: [...spec.codes, extra],
    layout: {
      ...fresh,
      [first]: { ...fresh[first], capacityPallets: 0, capacityBoxes: 20 },
      [second]: { ...fresh[second], capacityPallets: 3 },
      [extra]: { x: 31, y: 32, w: 3, h: 4, capacityPallets: 6 },
    },
    features: [],
    layoutVersion: WAREHOUSE_LAYOUT_VERSION,
    newPalletCapacityVersion: NEW_PALLET_CAPACITY_VERSION,
  };
  const merged = mergeRequiredWarehouseZones([marked]).find(zone => zone.id === spec.id);
  const normalized = normalizeWarehouseZone(marked);
  for (const result of [merged, normalized]) {
    assert.equal(result.layout[first].capacityPallets, 0);
    assert.equal(result.layout[first].capacityBoxes, 20);
    assert.equal(result.layout[second].capacityPallets, 3);
    assert.equal(result.layout[extra].capacityPallets, 6);
    assert.equal(result.newPalletCapacityVersion, NEW_PALLET_CAPACITY_VERSION);
  }
  assert.deepEqual(mergeRequiredWarehouseZones([merged]).find(zone => zone.id === spec.id), merged);
  assert.deepEqual(normalizeWarehouseZone(normalized), normalized);
});

test("a marked new zone fills missing standard layout entries without resetting saved edits", () => {
  const spec = newWarehouseZoneSpecs[2], first = spec.codes[0], second = spec.codes[1], fresh = actualWarehouseLayout(spec.codes);
  const partial = {
    ...spec,
    layout: { [first]: { ...fresh[first], capacityPallets: 0, capacityBoxes: 13, customField: "saved" } },
    features: [],
    layoutVersion: WAREHOUSE_LAYOUT_VERSION,
    newPalletCapacityVersion: NEW_PALLET_CAPACITY_VERSION,
  };
  const merged = mergeRequiredWarehouseZones([partial]).find(zone => zone.id === spec.id);
  const normalized = normalizeWarehouseZone(partial);
  for (const result of [merged, normalized]) {
    assert.equal(Object.keys(result.layout).length, spec.codes.length);
    assert.equal(result.layout[first].capacityPallets, 0);
    assert.equal(result.layout[first].capacityBoxes, 13);
    assert.equal(result.layout[first].customField, "saved");
    assert.equal(result.layout[second].capacityPallets, NEW_PALLET_CAPACITY);
    assert.deepEqual(
      { x: result.layout[second].x, y: result.layout[second].y, w: result.layout[second].w, h: result.layout[second].h },
      { x: fresh[second].x, y: fresh[second].y, w: fresh[second].w, h: fresh[second].h },
    );
  }
});

test("a markerless partial V4 new zone receives all 136 capacities without shifting current fallback geometry", () => {
  const spec = newWarehouseZoneSpecs[0], first = spec.codes[0], second = spec.codes[1], fresh = actualWarehouseLayout(spec.codes);
  const firstSaved = { ...fresh[first], x: fresh[first].x + .25, capacityPallets: 11, capacityBoxes: 27, customField: "v4-partial" };
  const partialV4 = { ...spec, layout: { [first]: firstSaved }, features: [], layoutVersion: 4 };
  const mergedAll = mergeRequiredWarehouseZones([partialV4]), merged = mergedAll.find(zone => zone.id === spec.id);
  const allStandard = mergedAll.filter(zone => zone.id.startsWith("NEW_")).flatMap(zone => newWarehouseZoneSpecs.find(specification => specification.id === zone.id).codes.map(code => zone.layout[code]));
  assert.equal(allStandard.length, 136);
  assert.ok(allStandard.every(box => box.capacityPallets === NEW_PALLET_CAPACITY));
  assert.equal(merged.newPalletCapacityVersion, NEW_PALLET_CAPACITY_VERSION);
  assert.equal(merged.layout[first].x, firstSaved.x);
  assert.equal(merged.layout[first].capacityBoxes, 27);
  assert.equal(merged.layout[first].customField, "v4-partial");
  assert.deepEqual(
    { x: merged.layout[second].x, y: merged.layout[second].y, w: merged.layout[second].w, h: merged.layout[second].h },
    { x: fresh[second].x, y: fresh[second].y, w: fresh[second].w, h: fresh[second].h },
  );

  const normalizedDirect = normalizeWarehouseZone(partialV4), normalizedAfterMerge = normalizeWarehouseZone(merged);
  for (const result of [normalizedDirect, normalizedAfterMerge]) {
    assert.equal(result.layout[first].x, firstSaved.x);
    assert.equal(result.layout[first].capacityPallets, NEW_PALLET_CAPACITY);
    assert.equal(result.layout[first].capacityBoxes, 27);
    assert.equal(result.layout[second].capacityPallets, NEW_PALLET_CAPACITY);
    assert.deepEqual(
      { x: result.layout[second].x, y: result.layout[second].y, w: result.layout[second].w, h: result.layout[second].h },
      { x: fresh[second].x, y: fresh[second].y, w: fresh[second].w, h: fresh[second].h },
    );
  }
  assert.deepEqual(normalizeWarehouseZone(normalizedAfterMerge), normalizedAfterMerge);
});

test("stock movement reads the merged two-pallet limit and reports overflow as a warning", () => {
  const zone = mergeRequiredWarehouseZones([]).find(candidate => candidate.id === "NEW_A"), code = zone.codes[0], box = zone.layout[code];
  assert.equal(box.capacityPallets, NEW_PALLET_CAPACITY);
  const atLimit = calculateCapacityStatus({ locationCode: code, capacityPallets: box.capacityPallets, beforePallets: 1, afterPallets: 2 });
  assert.equal(atLimit.capacity.overPallets, false);
  assert.equal(atLimit.warning, null);
  const overflow = calculateCapacityStatus({ locationCode: code, capacityPallets: box.capacityPallets, beforePallets: 1, afterPallets: 3 });
  assert.equal(overflow.capacity.capacityPallets, NEW_PALLET_CAPACITY);
  assert.equal(overflow.capacity.overPallets, true);
  assert.equal(overflow.capacity.palletOverflow, 1);
  assert.ok(overflow.warning);
});

test("each new zone is one right-to-left horizontal row above the old map", () => {
  const rowLayouts = newWarehouseZoneSpecs.map(zone => actualWarehouseLayout(zone.codes));
  for (const [zoneIndex, zone] of newWarehouseZoneSpecs.entries()) {
    const layout = rowLayouts[zoneIndex];
    const first = layout[zone.codes[0]];
    for (const code of zone.codes) {
      const box = layout[code];
      assert.ok(Math.abs(box.y - first.y) < 1e-9, `${zone.id} must stay on one row`);
      assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.w <= 100 && box.y + box.h <= 100);
    }
    for (let i = 0; i < zone.codes.length - 1; i += 1) {
      const right = layout[zone.codes[i]];
      const left = layout[zone.codes[i + 1]];
      assert.ok(right.x > left.x, `${zone.codes[i]} must be to the right of ${zone.codes[i + 1]}`);
      assert.ok(left.x + left.w < right.x, `${zone.id} locations must not overlap`);
    }
    const area = requiredWarehouseFeatures(zone.id).find(feature => feature.type === "box");
    assert.ok(area);
    const leftEdge = Math.min(...zone.codes.map(code => layout[code].x));
    const rightEdge = Math.max(...zone.codes.map(code => layout[code].x + layout[code].w));
    assert.ok(area.x <= leftEdge && area.x + area.w >= rightEdge, `${zone.id} area must contain its full row`);
  }

  const rowY = rowLayouts.map((layout, index) => layout[newWarehouseZoneSpecs[index].codes[0]].y / 100 * WAREHOUSE_MAP_HEIGHT);
  assert.deepEqual(rowY, compactNewZoneRowY);
  const newestBottom = Math.max(...rowLayouts.flatMap((layout, index) => newWarehouseZoneSpecs[index].codes.map(code => layout[code].y + layout[code].h)));
  const oldSpecs = requiredZoneSpecs.filter(zone => !zone.id.startsWith("NEW_"));
  const oldestTop = Math.min(...oldSpecs.flatMap(zone => Object.values(actualWarehouseLayout(zone.codes)).map(box => box.y)));
  assert.ok(newestBottom < oldestTop, "all four new rows must remain above every old location");
  const newALayout = rowLayouts[0];
  assert.ok(Math.abs(newALayout["新A38"].x / 100 * WAREHOUSE_MAP_WIDTH - 120) < 1e-9);
  assert.ok(Math.abs((newALayout["新A1"].x + newALayout["新A1"].w) / 100 * WAREHOUSE_MAP_WIDTH - 3600) < 1e-9);
  const slotWidth = newALayout["新A1"].w / 100 * WAREHOUSE_MAP_WIDTH;
  const step = (newALayout["新A1"].x - newALayout["新A2"].x) / 100 * WAREHOUSE_MAP_WIDTH;
  assert.ok(step - slotWidth > 14 && step - slotWidth < 15, "compact row gap should stay near 14.44px");
  assert.ok(WAREHOUSE_MAP_WIDTH - 3600 >= 2400, "new rows must leave a large unused area on the right");
});

test("the wider canvas keeps all 271 default locations in place without collision repairs", () => {
  const defaults = requiredZoneSpecs.map(zone => ({
    ...zone,
    layout: actualWarehouseLayout(zone.codes),
    features: requiredWarehouseFeatures(zone.id),
    layoutVersion: WAREHOUSE_LAYOUT_VERSION,
  }));
  const normalized = normalizeWarehouseZones(defaults);
  assert.equal(normalized.flatMap(zone => zone.codes).length, 271);
  for (const zone of normalized) {
    const original = defaults.find(candidate => candidate.id === zone.id);
    for (const code of zone.codes) assert.deepEqual(zone.layout[code], original.layout[code], `${code} must not be moved by collision repair`);
  }
});

test("V4 map coordinates move down without changing their physical size", () => {
  assert.equal(LEGACY_WAREHOUSE_MAP_WIDTH, 3400);
  assert.equal(V5_WAREHOUSE_MAP_WIDTH, 3400);
  assert.equal(V5_WAREHOUSE_MAP_HEIGHT, 2700);
  assert.equal(V6_WAREHOUSE_MAP_WIDTH, 4000);
  assert.equal(V6_WAREHOUSE_MAP_HEIGHT, 2700);
  assert.equal(V7_WAREHOUSE_MAP_WIDTH, 4800);
  assert.equal(V7_WAREHOUSE_MAP_HEIGHT, 2700);
  assert.equal(WAREHOUSE_MAP_WIDTH, 6000);
  assert.equal(WAREHOUSE_MAP_HEIGHT, 3600);
  assert.ok(WAREHOUSE_MAP_HEIGHT > LEGACY_WAREHOUSE_MAP_HEIGHT);
  assert.equal(WAREHOUSE_TOP_EXTENSION, 600);
  assert.equal(WAREHOUSE_TOP_EXTENSION, V5_WAREHOUSE_MAP_HEIGHT - LEGACY_WAREHOUSE_MAP_HEIGHT);
  assert.notEqual(WAREHOUSE_TOP_EXTENSION, WAREHOUSE_MAP_HEIGHT - LEGACY_WAREHOUSE_MAP_HEIGHT);
  assert.equal(WAREHOUSE_LAYOUT_VERSION, 8);

  const before = { x: 12.5, y: 20, w: 3.25, h: 4, capacityPallets: 9, groupId: "saved-group" };
  const after = migrateLegacyLayoutBox(before);
  assert.equal(after.capacityPallets, 9);
  assert.equal(after.groupId, "saved-group");
  assert.ok(Math.abs(after.x / 100 * WAREHOUSE_MAP_WIDTH - before.x / 100 * LEGACY_WAREHOUSE_MAP_WIDTH) < 1e-9);
  assert.ok(Math.abs(after.w / 100 * WAREHOUSE_MAP_WIDTH - before.w / 100 * LEGACY_WAREHOUSE_MAP_WIDTH) < 1e-9);
  assert.ok(Math.abs(after.y / 100 * WAREHOUSE_MAP_HEIGHT - (before.y / 100 * LEGACY_WAREHOUSE_MAP_HEIGHT + WAREHOUSE_TOP_EXTENSION)) < 1e-9);
  assert.ok(Math.abs(after.h / 100 * WAREHOUSE_MAP_HEIGHT - before.h / 100 * LEGACY_WAREHOUSE_MAP_HEIGHT) < 1e-9);
});

test("V5 maps expand once while preserving every saved pixel and field", () => {
  const saved = { x: 72, y: 31, w: 8, h: 9, capacityBoxes: 44, groupId: "v5-group", groupLocked: true };
  const feature = { id: "v5-feature", type: "box", label: "V5区域", color: "#246810", ...saved };
  const mapBox = { x: 15, y: 16, w: 17, h: 18 };
  const zone = { id: "V5", title: "V5地图", codes: ["V5库位"], layout: { V5库位: saved }, features: [feature], mapBox, layoutVersion: 5 };
  const normalized = normalizeWarehouseZone(zone);
  assert.deepEqual(normalized.layout["V5库位"], migrateV5LayoutBox(saved));
  assert.deepEqual(normalized.features[0], migrateV5LayoutBox(feature));
  assert.deepEqual(normalized.mapBox, migrateV5LayoutBox(mapBox));
  assert.ok(Math.abs(normalized.layout["V5库位"].x / 100 * WAREHOUSE_MAP_WIDTH - saved.x / 100 * V5_WAREHOUSE_MAP_WIDTH) < 1e-9);
  assert.ok(Math.abs(normalized.layout["V5库位"].y / 100 * WAREHOUSE_MAP_HEIGHT - saved.y / 100 * V5_WAREHOUSE_MAP_HEIGHT) < 1e-9);
  assert.ok(Math.abs(normalized.layout["V5库位"].w / 100 * WAREHOUSE_MAP_WIDTH - saved.w / 100 * V5_WAREHOUSE_MAP_WIDTH) < 1e-9);
  assert.ok(Math.abs(normalized.layout["V5库位"].h / 100 * WAREHOUSE_MAP_HEIGHT - saved.h / 100 * V5_WAREHOUSE_MAP_HEIGHT) < 1e-9);
  assert.equal(normalized.layoutVersion, WAREHOUSE_LAYOUT_VERSION);
  assert.deepEqual(normalizeWarehouseZone(normalized), normalized);
});

test("V6 maps expand once while preserving all four geometry fields in pixels", () => {
  const saved = { x: 72, y: 31, w: 1, h: 1, capacityPallets: 12, capacityBoxes: 44, groupId: "v6-group", groupLocked: true };
  const feature = { id: "v6-feature", type: "box", label: "V6区域", color: "#135790", ...saved, customField: "feature-metadata" };
  const mapBox = { x: 15, y: 16, w: 17, h: 18, groupId: "v6-map-box" };
  const zone = { id: "V6", title: "V6地图", codes: ["V6库位"], layout: { V6库位: saved }, features: [feature], mapBox, layoutVersion: 6 };
  const normalized = normalizeWarehouseZone(zone);
  assert.deepEqual(normalized.layout["V6库位"], migrateV6LayoutBox(saved));
  assert.deepEqual(normalized.features[0], migrateV6LayoutBox(feature));
  assert.deepEqual(normalized.mapBox, migrateV6LayoutBox(mapBox));
  assert.ok(Math.abs(normalized.layout["V6库位"].x / 100 * WAREHOUSE_MAP_WIDTH - saved.x / 100 * V6_WAREHOUSE_MAP_WIDTH) < 1e-9);
  assert.ok(Math.abs(normalized.layout["V6库位"].y / 100 * WAREHOUSE_MAP_HEIGHT - saved.y / 100 * V6_WAREHOUSE_MAP_HEIGHT) < 1e-9);
  assert.ok(Math.abs(normalized.layout["V6库位"].w / 100 * WAREHOUSE_MAP_WIDTH - saved.w / 100 * V6_WAREHOUSE_MAP_WIDTH) < 1e-9);
  assert.ok(Math.abs(normalized.layout["V6库位"].h / 100 * WAREHOUSE_MAP_HEIGHT - saved.h / 100 * V6_WAREHOUSE_MAP_HEIGHT) < 1e-9);
  assert.equal(normalized.features[0].customField, "feature-metadata");
  assert.equal(normalized.layoutVersion, WAREHOUSE_LAYOUT_VERSION);
  assert.deepEqual(normalizeWarehouseZone(normalized), normalized);
});

test("V7 maps expand once while preserving locations, features, map boxes and metadata in pixels", () => {
  const saved = { x: 72, y: 31, w: 1, h: 1, capacityPallets: 12, capacityBoxes: 44, groupId: "v7-group", groupLocked: true, customField: "location-metadata" };
  const feature = { id: "v7-feature", type: "box", label: "V7区域", color: "#246802", ...saved, customField: "feature-metadata" };
  const mapBox = { x: 15, y: 16, w: 17, h: 18, groupId: "v7-map-box", customField: "map-metadata" };
  const normalized = normalizeWarehouseZone({ id: "V7", title: "V7地图", codes: ["V7库位"], layout: { V7库位: saved }, features: [feature], mapBox, layoutVersion: 7 });
  assert.deepEqual(normalized.layout["V7库位"], migrateV7LayoutBox(saved));
  assert.deepEqual(normalized.features[0], migrateV7LayoutBox(feature));
  assert.deepEqual(normalized.mapBox, migrateV7LayoutBox(mapBox));
  assert.ok(Math.abs(normalized.layout["V7库位"].x / 100 * WAREHOUSE_MAP_WIDTH - saved.x / 100 * V7_WAREHOUSE_MAP_WIDTH) < 1e-9);
  assert.ok(Math.abs(normalized.layout["V7库位"].y / 100 * WAREHOUSE_MAP_HEIGHT - saved.y / 100 * V7_WAREHOUSE_MAP_HEIGHT) < 1e-9);
  assert.ok(Math.abs(normalized.layout["V7库位"].w / 100 * WAREHOUSE_MAP_WIDTH - saved.w / 100 * V7_WAREHOUSE_MAP_WIDTH) < 1e-9);
  assert.ok(Math.abs(normalized.layout["V7库位"].h / 100 * WAREHOUSE_MAP_HEIGHT - saved.h / 100 * V7_WAREHOUSE_MAP_HEIGHT) < 1e-9);
  assert.equal(normalized.layout["V7库位"].customField, "location-metadata");
  assert.equal(normalized.features[0].customField, "feature-metadata");
  assert.equal(normalized.mapBox.customField, "map-metadata");
  assert.equal(normalized.layoutVersion, WAREHOUSE_LAYOUT_VERSION);
  assert.deepEqual(normalizeWarehouseZone(normalized), normalized);
});

test("saved V5 canonical new rows reflow into the fixed compact V8 block while preserving metadata", () => {
  const spec = newWarehouseZoneSpecs[0];
  const oldSlotHeight = 3.55 / 100 * LEGACY_WAREHOUSE_MAP_HEIGHT / V5_WAREHOUSE_MAP_HEIGHT * 100;
  const oldLayout = Object.fromEntries(spec.codes.map(code => {
    const number = Number(code.slice(2));
    return [code, { x: 1.1 + (38 - number) * 2.48, y: 48 / V5_WAREHOUSE_MAP_HEIGHT * 100, w: 2.28, h: oldSlotHeight }];
  }));
  oldLayout["新A1"] = { ...oldLayout["新A1"], capacityPallets: 12, capacityBoxes: 66, groupId: "saved-new-row", groupLocked: true };
  oldLayout["新区附加1"] = { x: 45, y: 24, w: 3, h: 4, capacityBoxes: 5 };
  const oldRequired = [
    { id: "required-NEW_A-box", type: "box", label: "保存的框名", color: "#112233", x: .55, y: 12 / V5_WAREHOUSE_MAP_HEIGHT * 100, w: 96.9, h: 112 / V5_WAREHOUSE_MAP_HEIGHT * 100 },
    { id: "required-NEW_A-label", type: "label", label: "保存的新A名", color: "#223344", x: .72, y: 20 / V5_WAREHOUSE_MAP_HEIGHT * 100, w: 2.9, h: 27 / V5_WAREHOUSE_MAP_HEIGHT * 100 },
  ];
  const customFeature = { id: "custom-v5-new", type: "box", label: "自定义保留", color: "#334455", x: 10, y: 25, w: 12, h: 9 };
  const normalized = normalizeWarehouseZone({
    ...spec,
    codes: [...spec.codes, "新区附加1"],
    layout: oldLayout,
    features: [...oldRequired, customFeature],
    layoutVersion: 5,
  });
  const fresh = actualWarehouseLayout(spec.codes);
  for (const code of spec.codes) {
    const actual = normalized.layout[code];
    const expected = fresh[code];
    assert.deepEqual({ x: actual.x, y: actual.y, w: actual.w, h: actual.h }, { x: expected.x, y: expected.y, w: expected.w, h: expected.h }, `${code} must use the fixed compact V8 row geometry`);
    assert.equal(actual.capacityPallets, NEW_PALLET_CAPACITY);
  }
  assert.equal(normalized.layout["新A1"].capacityPallets, NEW_PALLET_CAPACITY);
  assert.equal(normalized.layout["新A1"].capacityBoxes, 66);
  assert.equal(normalized.layout["新A1"].groupId, "saved-new-row");
  assert.equal(normalized.layout["新A1"].groupLocked, true);
  assert.deepEqual(normalized.layout["新区附加1"], migrateV5LayoutBox(oldLayout["新区附加1"]));
  const freshFeatures = new Map(requiredWarehouseFeatures(spec.id).map(feature => [feature.id, feature]));
  for (const savedFeature of oldRequired) {
    const actual = normalized.features.find(feature => feature.id === savedFeature.id);
    const expectedGeometry = freshFeatures.get(savedFeature.id);
    assert.deepEqual({ x: actual.x, y: actual.y, w: actual.w, h: actual.h }, { x: expectedGeometry.x, y: expectedGeometry.y, w: expectedGeometry.w, h: expectedGeometry.h });
    assert.equal(actual.label, savedFeature.label);
    assert.equal(actual.color, savedFeature.color);
  }
  assert.deepEqual(normalized.features.find(feature => feature.id === customFeature.id), migrateV5LayoutBox(customFeature));
  assert.deepEqual(normalizeWarehouseZone(normalized), normalized);
});

test("untouched V6 canonical new rows reflow into the fixed compact V8 block while preserving metadata", () => {
  const spec = newWarehouseZoneSpecs[0];
  const canonical = canonicalNewZoneAtSize(spec, V6_WAREHOUSE_MAP_WIDTH, V6_WAREHOUSE_MAP_HEIGHT);
  canonical.layout["新A1"] = { ...canonical.layout["新A1"], capacityPallets: 12, capacityBoxes: 66, groupId: "v6-row", groupLocked: true, customField: "location-metadata" };
  const savedFeatures = canonical.features.map(feature => ({ ...feature, label: `${feature.type}-保存名`, color: "#224466", groupId: "v6-feature-group", customField: "feature-metadata" }));
  const customFeature = { id: "custom-v6-new", type: "box", label: "自定义保留", color: "#335577", x: 10, y: 25, w: 12, h: 9, groupLocked: true };
  const extraCode = "新区附加1";
  const extraBox = { x: 45, y: 24, w: 3, h: 4, capacityBoxes: 5 };
  const mapBox = { x: 15, y: 16, w: 17, h: 18, groupId: "saved-map-box" };
  const normalized = normalizeWarehouseZone({
    ...spec,
    codes: [...spec.codes, extraCode],
    layout: { ...canonical.layout, [extraCode]: extraBox },
    features: [...savedFeatures, customFeature],
    mapBox,
    layoutVersion: 6,
  });
  const fresh = actualWarehouseLayout(spec.codes);
  for (const code of spec.codes) {
    const actual = normalized.layout[code];
    const expected = fresh[code];
    assert.deepEqual({ x: actual.x, y: actual.y, w: actual.w, h: actual.h }, { x: expected.x, y: expected.y, w: expected.w, h: expected.h }, `${code} must use the fixed compact V8 row geometry`);
    assert.equal(actual.capacityPallets, NEW_PALLET_CAPACITY);
  }
  assert.equal(normalized.layout["新A1"].capacityPallets, NEW_PALLET_CAPACITY);
  assert.equal(normalized.layout["新A1"].capacityBoxes, 66);
  assert.equal(normalized.layout["新A1"].groupId, "v6-row");
  assert.equal(normalized.layout["新A1"].groupLocked, true);
  assert.equal(normalized.layout["新A1"].customField, "location-metadata");
  assert.deepEqual(normalized.layout[extraCode], migrateV6LayoutBox(extraBox));
  const freshFeatures = new Map(requiredWarehouseFeatures(spec.id).map(feature => [feature.id, feature]));
  for (const savedFeature of savedFeatures) {
    const actual = normalized.features.find(feature => feature.id === savedFeature.id);
    const expectedGeometry = freshFeatures.get(savedFeature.id);
    assert.deepEqual({ x: actual.x, y: actual.y, w: actual.w, h: actual.h }, { x: expectedGeometry.x, y: expectedGeometry.y, w: expectedGeometry.w, h: expectedGeometry.h });
    assert.equal(actual.label, savedFeature.label);
    assert.equal(actual.color, savedFeature.color);
    assert.equal(actual.groupId, savedFeature.groupId);
    assert.equal(actual.customField, savedFeature.customField);
  }
  assert.deepEqual(normalized.features.find(feature => feature.id === customFeature.id), migrateV6LayoutBox(customFeature));
  assert.deepEqual(normalized.mapBox, migrateV6LayoutBox(mapBox));
  assert.deepEqual(normalizeWarehouseZone(normalized), normalized);
});

test("manually adjusted V6 new rows and required features retain their saved pixel geometry", () => {
  const spec = newWarehouseZoneSpecs[1];
  const canonical = canonicalNewZoneAtSize(spec, V6_WAREHOUSE_MAP_WIDTH, V6_WAREHOUSE_MAP_HEIGHT);
  canonical.layout["新B10"] = { ...canonical.layout["新B10"], x: canonical.layout["新B10"].x + .25, capacityBoxes: 19, groupId: "manual-location" };
  canonical.features[0] = { ...canonical.features[0], x: canonical.features[0].x + .5, label: "人工区域框", color: "#abcdef", groupLocked: true };
  canonical.features[1] = { ...canonical.features[1], label: "只改文字", color: "#123456" };
  const normalized = normalizeWarehouseZone({ ...spec, layout: canonical.layout, features: canonical.features, layoutVersion: 6 });
  for (const code of spec.codes) {
    const migrated = migrateV6LayoutBox(canonical.layout[code]);
    assert.deepEqual(
      { x: normalized.layout[code].x, y: normalized.layout[code].y, w: normalized.layout[code].w, h: normalized.layout[code].h },
      { x: migrated.x, y: migrated.y, w: migrated.w, h: migrated.h },
      `${code} must retain its V6 pixel geometry when any row location was manually adjusted`,
    );
    assert.equal(normalized.layout[code].capacityPallets, NEW_PALLET_CAPACITY);
  }
  assert.deepEqual(normalized.features[0], migrateV6LayoutBox(canonical.features[0]));
  const currentLabel = requiredWarehouseFeatures(spec.id).find(feature => feature.id === canonical.features[1].id);
  assert.deepEqual(
    { x: normalized.features[1].x, y: normalized.features[1].y, w: normalized.features[1].w, h: normalized.features[1].h },
    { x: currentLabel.x, y: currentLabel.y, w: currentLabel.w, h: currentLabel.h },
  );
  assert.equal(normalized.features[1].label, "只改文字");
  assert.equal(normalized.features[1].color, "#123456");
  assert.equal(normalized.layout["新B10"].capacityBoxes, 19);
  assert.equal(normalized.layout["新B10"].groupId, "manual-location");
  assert.deepEqual(normalizeWarehouseZone(normalized), normalized);
});

test("manually adjusted V5 new rows and required features retain their saved pixel geometry", () => {
  const spec = newWarehouseZoneSpecs[2];
  const canonical = canonicalV5NewZone(spec);
  canonical.layout["新C2"] = { ...canonical.layout["新C2"], x: canonical.layout["新C2"].x + .25, capacityPallets: 7, groupLocked: true };
  canonical.features[0] = { ...canonical.features[0], y: canonical.features[0].y + .5, label: "V5人工框", color: "#aabbcc" };
  const normalized = normalizeWarehouseZone({ ...spec, layout: canonical.layout, features: canonical.features, layoutVersion: 5 });
  for (const code of spec.codes) {
    const migrated = migrateV5LayoutBox(canonical.layout[code]);
    assert.deepEqual(
      { x: normalized.layout[code].x, y: normalized.layout[code].y, w: normalized.layout[code].w, h: normalized.layout[code].h },
      { x: migrated.x, y: migrated.y, w: migrated.w, h: migrated.h },
      `${code} must retain its V5 pixel geometry when the row was manually adjusted`,
    );
  }
  assert.deepEqual(normalized.features[0], migrateV5LayoutBox(canonical.features[0]));
  const currentLabel = requiredWarehouseFeatures(spec.id).find(feature => feature.id === canonical.features[1].id);
  assert.deepEqual(
    { x: normalized.features[1].x, y: normalized.features[1].y, w: normalized.features[1].w, h: normalized.features[1].h },
    { x: currentLabel.x, y: currentLabel.y, w: currentLabel.w, h: currentLabel.h },
  );
  assert.equal(normalized.layout["新C2"].capacityPallets, NEW_PALLET_CAPACITY);
  assert.equal(normalized.layout["新C2"].groupLocked, true);
  assert.deepEqual(normalizeWarehouseZone(normalized), normalized);
});

test("untouched V7 canonical new rows reflow into the fixed compact V8 block", () => {
  const spec = newWarehouseZoneSpecs[2];
  const canonical = canonicalNewZoneAtSize(spec, V7_WAREHOUSE_MAP_WIDTH, V7_WAREHOUSE_MAP_HEIGHT);
  canonical.layout["新C1"] = { ...canonical.layout["新C1"], capacityBoxes: 33, groupId: "v7-default-row" };
  canonical.features = canonical.features.map(feature => ({ ...feature, label: `保留-${feature.type}`, color: "#556677" }));
  const normalized = normalizeWarehouseZone({ ...spec, layout: canonical.layout, features: canonical.features, layoutVersion: 7 });
  const fresh = actualWarehouseLayout(spec.codes);
  for (const code of spec.codes) {
    const actual = normalized.layout[code];
    const expected = fresh[code];
    assert.deepEqual({ x: actual.x, y: actual.y, w: actual.w, h: actual.h }, { x: expected.x, y: expected.y, w: expected.w, h: expected.h });
    assert.equal(actual.capacityPallets, NEW_PALLET_CAPACITY);
  }
  assert.equal(normalized.layout["新C1"].capacityBoxes, 33);
  assert.equal(normalized.layout["新C1"].groupId, "v7-default-row");
  const freshFeatures = new Map(requiredWarehouseFeatures(spec.id).map(feature => [feature.id, feature]));
  for (const savedFeature of canonical.features) {
    const actual = normalized.features.find(feature => feature.id === savedFeature.id);
    const expected = freshFeatures.get(savedFeature.id);
    assert.deepEqual({ x: actual.x, y: actual.y, w: actual.w, h: actual.h }, { x: expected.x, y: expected.y, w: expected.w, h: expected.h });
    assert.equal(actual.label, savedFeature.label);
    assert.equal(actual.color, savedFeature.color);
  }
  assert.deepEqual(normalizeWarehouseZone(normalized), normalized);
});

test("manually adjusted V7 new rows and required features retain their saved pixel geometry", () => {
  const spec = newWarehouseZoneSpecs[3];
  const canonical = canonicalNewZoneAtSize(spec, V7_WAREHOUSE_MAP_WIDTH, V7_WAREHOUSE_MAP_HEIGHT);
  canonical.layout["新D8"] = { ...canonical.layout["新D8"], x: canonical.layout["新D8"].x + .25, capacityBoxes: 21, groupId: "manual-v7-location" };
  canonical.features[0] = { ...canonical.features[0], x: canonical.features[0].x + .5, label: "V7人工框", color: "#fedcba", groupLocked: true };
  canonical.features[1] = { ...canonical.features[1], label: "V7只改文字" };
  const normalized = normalizeWarehouseZone({ ...spec, layout: canonical.layout, features: canonical.features, layoutVersion: 7 });
  for (const code of spec.codes) {
    const migrated = migrateV7LayoutBox(canonical.layout[code]);
    assert.deepEqual(
      { x: normalized.layout[code].x, y: normalized.layout[code].y, w: normalized.layout[code].w, h: normalized.layout[code].h },
      { x: migrated.x, y: migrated.y, w: migrated.w, h: migrated.h },
      `${code} must retain its V7 pixel geometry when the row was manually adjusted`,
    );
    assert.equal(normalized.layout[code].capacityPallets, NEW_PALLET_CAPACITY);
  }
  assert.deepEqual(normalized.features[0], migrateV7LayoutBox(canonical.features[0]));
  const currentLabel = requiredWarehouseFeatures(spec.id).find(feature => feature.id === canonical.features[1].id);
  assert.deepEqual(
    { x: normalized.features[1].x, y: normalized.features[1].y, w: normalized.features[1].w, h: normalized.features[1].h },
    { x: currentLabel.x, y: currentLabel.y, w: currentLabel.w, h: currentLabel.h },
  );
  assert.equal(normalized.layout["新D8"].capacityBoxes, 21);
  assert.equal(normalized.layout["新D8"].groupId, "manual-v7-location");
  assert.deepEqual(normalizeWarehouseZone(normalized), normalized);
});

test("old saved maps gain the four new zones and migrate once without losing custom data", () => {
  const oldZones = [
    {
      id: "A",
      title: "A区自定义名称",
      codes: ["A1"],
      layout: { A1: { x: 9, y: 12, w: 3, h: 4, capacityPallets: 11 } },
      features: [{ id: "saved-feature", type: "box", label: "保留", color: "#123456", x: 4, y: 5, w: 6, h: 7, groupId: "saved-group" }],
      mapBox: { x: 8, y: 9, w: 10, h: 11 },
      unified: true,
      layoutVersion: 4,
    },
    {
      id: "CUSTOM",
      title: "自定义区域",
      codes: ["自定义1"],
      layout: { 自定义1: { x: 44, y: 55, w: 3, h: 4, capacityBoxes: 88 } },
      features: [],
      unified: true,
      layoutVersion: 4,
    },
  ];

  const merged = mergeRequiredWarehouseZones(oldZones);
  assert.deepEqual(merged.slice(0, 4).map(zone => zone.id), ["NEW_A", "NEW_B", "NEW_C", "NEW_D"]);
  assert.deepEqual(merged.find(zone => zone.id === "A"), oldZones[0]);
  assert.deepEqual(merged.find(zone => zone.id === "CUSTOM"), oldZones[1]);
  assert.deepEqual(mergeRequiredWarehouseZones(merged), merged);
  assert.equal(new Set(merged.flatMap(zone => zone.codes)).size, merged.flatMap(zone => zone.codes).length);

  const normalized = normalizeWarehouseZones(oldZones);
  const savedA = normalized.find(zone => zone.id === "A");
  const savedCustom = normalized.find(zone => zone.id === "CUSTOM");
  assert.deepEqual(savedA.layout.A1, migrateLegacyLayoutBox(oldZones[0].layout.A1));
  assert.deepEqual(savedA.features[0], migrateLegacyLayoutBox(oldZones[0].features[0]));
  assert.deepEqual(savedA.mapBox, migrateLegacyLayoutBox(oldZones[0].mapBox));
  assert.equal(savedA.features[0].label, "保留");
  assert.equal(savedA.features[0].color, "#123456");
  assert.equal(savedA.features[0].groupId, "saved-group");
  assert.equal(savedCustom.layout["自定义1"].capacityBoxes, 88);
  assert.equal(savedCustom.title, "自定义区域");
  assert.equal(savedA.layoutVersion, WAREHOUSE_LAYOUT_VERSION);
  assert.deepEqual(normalizeWarehouseZones(normalized), normalized);
});

test("saved overlapping locations remain pixel-stable until an explicit edit repair", () => {
  const sharedBox = { x: 10, y: 80, w: 4, h: 4, capacityBoxes: 9, groupId: "manual-overlap" };
  const oldZones = [
    { id: "CUSTOM_ONE", title: "Manual one", codes: ["MANUAL-1"], layout: { "MANUAL-1": sharedBox }, features: [], layoutVersion: 7 },
    { id: "CUSTOM_TWO", title: "Manual two", codes: ["MANUAL-2"], layout: { "MANUAL-2": { ...sharedBox, capacityBoxes: 12 } }, features: [], layoutVersion: 7 },
  ];
  const preserved = normalizeWarehouseZones(oldZones);
  const firstExpected = migrateV7LayoutBox(sharedBox);
  const secondExpected = migrateV7LayoutBox(oldZones[1].layout["MANUAL-2"]);
  assert.deepEqual(preserved.find(zone => zone.id === "CUSTOM_ONE").layout["MANUAL-1"], firstExpected);
  assert.deepEqual(preserved.find(zone => zone.id === "CUSTOM_TWO").layout["MANUAL-2"], secondExpected);
  assert.deepEqual(normalizeWarehouseZones(preserved), preserved);

  const repaired = normalizeWarehouseZones(oldZones, { repairSaved: true });
  assert.deepEqual(repaired.find(zone => zone.id === "CUSTOM_ONE").layout["MANUAL-1"], firstExpected);
  assert.notDeepEqual(repaired.find(zone => zone.id === "CUSTOM_TWO").layout["MANUAL-2"], secondExpected);
});

test("the V8 canvas adds only right and bottom blank space around existing locations", () => {
  const oldSpecs = requiredZoneSpecs.filter(zone => !zone.id.startsWith("NEW_"));
  const oldBoxes = oldSpecs.flatMap(zone => Object.values(actualWarehouseLayout(zone.codes)));
  const maxRight = Math.max(...oldBoxes.map(box => (box.x + box.w) / 100 * WAREHOUSE_MAP_WIDTH));
  const maxBottom = Math.max(...oldBoxes.map(box => (box.y + box.h) / 100 * WAREHOUSE_MAP_HEIGHT));
  const minTop = Math.min(...oldBoxes.map(box => box.y / 100 * WAREHOUSE_MAP_HEIGHT));
  const newBottom = Math.max(...newWarehouseZoneSpecs.flatMap(zone => Object.values(actualWarehouseLayout(zone.codes))).map(box => (box.y + box.h) / 100 * WAREHOUSE_MAP_HEIGHT));

  assert.ok(maxRight <= LEGACY_WAREHOUSE_MAP_WIDTH + 1e-9, "old locations must stay inside their original physical width");
  assert.ok(maxBottom <= V5_WAREHOUSE_MAP_HEIGHT + 1e-9, "old locations must stay inside the prior physical height");
  assert.ok(WAREHOUSE_MAP_WIDTH - maxRight > 2600, "the wider canvas must leave substantial blank space on the right");
  assert.ok(WAREHOUSE_MAP_HEIGHT - maxBottom > 900, "the taller canvas must leave substantial blank space at the bottom");
  assert.ok(newBottom < minTop, "the compact new rows must remain inside the historical 600px top extension");
});

test("all older canvas versions move saved features below the new rows exactly once", () => {
  for (const layoutVersion of [3, undefined]) {
    const feature = { id: `legacy-${layoutVersion}`, type: "box", label: "旧区域框", color: "#abcdef", x: 7, y: 8, w: 9, h: 10, groupId: "legacy-group" };
    const mapBox = { x: 17, y: 18, w: 19, h: 20 };
    const zone = {
      id: `LEGACY-${layoutVersion}`,
      title: "旧版区域",
      codes: ["旧库位1"],
      layout: { 旧库位1: { x: 30, y: 4, w: 5, h: 6, capacityBoxes: 27 } },
      features: [feature],
      mapBox,
      layoutVersion,
    };
    const normalized = normalizeWarehouseZone(zone);
    assert.deepEqual(normalized.layout["旧库位1"], migrateLegacyLayoutBox(zone.layout["旧库位1"]));
    assert.deepEqual(normalized.features[0], migrateLegacyLayoutBox(feature));
    assert.deepEqual(normalized.mapBox, migrateLegacyLayoutBox(mapBox));
    assert.equal(normalized.layout["旧库位1"].capacityBoxes, 27);
    assert.equal(normalized.layoutVersion, WAREHOUSE_LAYOUT_VERSION);
    assert.deepEqual(normalizeWarehouseZone(normalized), normalized);
  }
});

test("canonical new zones reclaim conflicting required codes without duplicates", () => {
  const merged = mergeRequiredWarehouseZones([
    {
      id: "CUSTOM",
      title: "旧自定义区",
      codes: ["新A1", "旧自定义1"],
      layout: {
        新A1: { x: 11, y: 22, w: 3, h: 4, capacityPallets: 12 },
        旧自定义1: { x: 40, y: 50, w: 3, h: 4 },
      },
      layoutVersion: 4,
    },
    {
      id: "NEW_A",
      title: "错误的旧新区",
      codes: ["新B1", "新区附加1"],
      layout: {
        新B1: { x: 5, y: 6, w: 3, h: 4 },
        新区附加1: { x: 6, y: 7, w: 3, h: 4 },
      },
      layoutVersion: 5,
    },
  ]);
  const canonicalCodes = merged.filter(zone => zone.id.startsWith("NEW_")).flatMap(zone => zone.codes);
  assert.equal(canonicalCodes.filter(code => code === "新B1").length, 1);
  assert.deepEqual(merged.find(zone => zone.id === "NEW_A").codes, [...newWarehouseZoneSpecs[0].codes, "新区附加1"]);
  assert.deepEqual(merged.find(zone => zone.id === "NEW_B").codes, newWarehouseZoneSpecs[1].codes);
  assert.deepEqual(merged.find(zone => zone.id === "CUSTOM").codes, ["旧自定义1"]);
  assert.equal(new Set(merged.flatMap(zone => zone.codes)).size, merged.flatMap(zone => zone.codes).length);
  const repairedNewA = merged.find(zone => zone.id === "NEW_A");
  assert.equal(repairedNewA.newPalletCapacityVersion, NEW_PALLET_CAPACITY_VERSION);
  assert.ok(newWarehouseZoneSpecs[0].codes.every(code => repairedNewA.layout[code].capacityPallets === NEW_PALLET_CAPACITY));
  assert.equal(repairedNewA.layout["新区附加1"].capacityPallets, undefined);

  const inherited = mergeRequiredWarehouseZones([{
    id: "CUSTOM",
    title: "碰巧使用了新区编号",
    codes: ["新A1"],
    layout: { 新A1: { x: 11, y: 22, w: 3, h: 4, capacityPallets: 12, capacityBoxes: 41 } },
    layoutVersion: 4,
  }]);
  assert.equal(inherited.find(zone => zone.id === "NEW_A").layout["新A1"].capacityPallets, NEW_PALLET_CAPACITY);
  assert.equal(inherited.find(zone => zone.id === "NEW_A").layout["新A1"].capacityBoxes, 41);
  assert.deepEqual(mergeRequiredWarehouseZones(inherited), inherited);
});

test("locations and transfer APIs recognize required zones without rewriting during GET", async () => {
  const [page, locationsRoute, moveRoute, desktopCss, mobileCss, minimapCss] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/locations/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/stocks/move/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/v40.css", import.meta.url), "utf8"),
    readFile(new URL("../app/v43.css", import.meta.url), "utf8"),
    readFile(new URL("../app/minimap.css", import.meta.url), "utf8"),
  ]);

  const getBlock = locationsRoute.slice(locationsRoute.indexOf("export async function GET"), locationsRoute.indexOf("export async function POST"));
  const postBlock = locationsRoute.slice(locationsRoute.indexOf("export async function POST"), locationsRoute.indexOf("export async function PATCH"));
  const patchBlock = locationsRoute.slice(locationsRoute.indexOf("export async function PATCH"));
  assert.match(page, /normalizeWarehouseZonesForCanvas\(zs,warehouseCanvasSize,\{repairSaved\}\)/);
  assert.match(page, /normalizeZones\([^;]+,true\)/s);
  assert.match(page, /--warehouse-map-width/);
  assert.match(page, /--warehouse-map-height/);
  assert.match(page, /thin-zone/);
  assert.match(page, /Math\.max\(\.04,Math\.min\(3,n\)\)/);
  assert.match(page, /useState\(230\)/);
  assert.match(page, /const DEFAULT_MAP_ZOOM=\.55/);
  assert.match(page, /setZoom\(DEFAULT_MAP_ZOOM\)/);
  assert.match(page, /const returnToMap=.*resetView\(\)/s);
  assert.match(page, /defaultMiniMapPosition\(/);
  assert.match(page, /clampWarehousePan\(/);
  assert.match(getBlock, /mergeRequiredWarehouseZonesForCanvas\(/);
  assert.doesNotMatch(getBlock, /\.(?:insert|update)\(/);
  assert.match(postBlock, /mergeRequiredWarehouseZonesForCanvas\(/);
  assert.match(patchBlock, /mergeRequiredWarehouseZonesForCanvas\(/);
  assert.match(moveRoute, /zones = mergeRequiredWarehouseZones\(parsed/);
  assert.match(desktopCss, /width:var\(--warehouse-map-width/);
  assert.match(desktopCss, /height:var\(--warehouse-map-height/);
  assert.match(desktopCss, /aspect-ratio:var\(--warehouse-map-aspect/);
  assert.match(desktopCss, new RegExp(`aspect-ratio:var\\(--warehouse-map-aspect,${WAREHOUSE_MAP_WIDTH} / ${WAREHOUSE_MAP_HEIGHT}\\)`));
  assert.match(mobileCss, new RegExp(`aspect-ratio:var\\(--warehouse-map-aspect,${WAREHOUSE_MAP_WIDTH} / ${WAREHOUSE_MAP_HEIGHT}\\)`));
  assert.match(minimapCss, new RegExp(`aspect-ratio:var\\(--warehouse-map-aspect,${WAREHOUSE_MAP_WIDTH} / ${WAREHOUSE_MAP_HEIGHT}\\)`));
  assert.doesNotMatch(mobileCss, /max-height:190px/);
  assert.match(minimapCss, /mini-zone\.thin-zone/);
  assert.match(mobileCss, /width:min\(100%,230px\)/);
  assert.match(mobileCss, /mini-zone\.thin-zone span\{display:none\}/);
  assert.match(minimapCss, /mini-zone\.thin-zone\{min-height:5px/);
  assert.doesNotMatch(`${desktopCss}\n${mobileCss}\n${minimapCss}`, /3000px|1900px|2700px|4000px|4800px|3400\s*\/\s*2700|4000\s*\/\s*2700|4800\s*\/\s*2700|2600\s*\/\s*1550/);

  const miniStageHeight = 380 * WAREHOUSE_MAP_HEIGHT / WAREHOUSE_MAP_WIDTH;
  assert.ok(miniStageHeight * (112 / WAREHOUSE_MAP_HEIGHT) >= 7, "thin row label must fit inside its minimap box");
});
