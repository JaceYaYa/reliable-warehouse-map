import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  TransferValidationError,
  calculateCapacityStatus,
  makeTransferEnvelope,
  parseTransferEnvelope,
  planStockTransfer,
} from "../lib/stock-transfer.ts";
import { locationCodeKey, matchingLocationCodes } from "../lib/location-code.ts";

const fixture = (patch = {}) => ({
  id: 17,
  locationCode: "A1",
  inboundDate: "2026-06-18",
  product: "X2X 黑色真空机",
  barcode: "X2X-001",
  inboundOrder: "IB-20260618",
  totalQuantity: 100,
  totalBoxes: 10,
  customerName: "QT",
  palletCount: 2.5,
  palletLabel: "2.5",
  layerCount: 3,
  inboundSource: "return",
  billingMode: "item",
  itemVolumeM3: 0.0043,
  boxVolumeM3: 0.043,
  storageRateUsd: 0.7,
  freeDays: 5,
  catalogItemId: 99,
  note: "原批次备注",
  updatedBy: "原操作人",
  updatedAt: "2026-08-01T00:00:00.000Z",
  version: 7,
  ...patch,
});

const plan = (before, patch = {}) => planStockTransfer({
  before,
  targetLocation: "B16",
  mode: "partial",
  quantity: 30,
  boxes: 4,
  pallets: "1/2",
  userName: "测试员工",
  stamp: "2026-08-06T05:00:00.000Z",
  ...patch,
});

test("whole transfer keeps the stock identity, history, source and pricing", () => {
  const before = fixture();
  const result = planStockTransfer({
    before,
    targetLocation: "B16",
    mode: "all",
    userName: "测试员工",
    stamp: "2026-08-06T05:00:00.000Z",
  });

  assert.equal(result.mode, "all");
  assert.equal(result.sourceAfter, null);
  assert.deepEqual(result.moved, { quantity: 100, boxes: 10, pallets: 2.5 });
  assert.equal(result.destinationAfter.id, before.id);
  assert.equal(result.destinationAfter.locationCode, "B16");
  assert.equal(result.destinationAfter.version, before.version + 1);
  for (const key of [
    "inboundDate", "product", "barcode", "inboundOrder", "customerName", "layerCount",
    "inboundSource", "billingMode", "itemVolumeM3", "boxVolumeM3", "storageRateUsd",
    "freeDays", "catalogItemId", "note", "totalQuantity", "totalBoxes", "palletCount",
  ]) {
    assert.equal(result.destinationAfter[key], before[key], `${key} should be preserved`);
  }
});

test("whole transfer can set the destination layer while omitted legacy fields preserve it", () => {
  const before = fixture();
  const customized = planStockTransfer({
    before,
    targetLocation: "B16",
    mode: "all",
    targetLayerCount: 5,
    userName: "测试员工",
    stamp: "2026-08-06T05:00:00.000Z",
  });
  const legacy = planStockTransfer({
    before,
    targetLocation: "B16",
    mode: "all",
    userName: "测试员工",
    stamp: "2026-08-06T05:00:00.000Z",
  });

  assert.equal(customized.destinationAfter.layerCount, 5);
  assert.equal(legacy.destinationAfter.layerCount, before.layerCount);
});

test("partial transfer conserves all three stock counts and preserves pricing on both rows", () => {
  const before = fixture();
  const result = plan(before);

  assert.equal(result.mode, "partial");
  assert.deepEqual(result.moved, { quantity: 30, boxes: 4, pallets: 0.5 });
  assert.ok(result.sourceAfter);
  assert.equal(result.sourceAfter.id, before.id);
  assert.equal(result.destinationAfter.id, 0);
  assert.equal(result.sourceAfter.totalQuantity + result.destinationAfter.totalQuantity, before.totalQuantity);
  assert.equal(result.sourceAfter.totalBoxes + result.destinationAfter.totalBoxes, before.totalBoxes);
  assert.equal(result.sourceAfter.palletCount + result.destinationAfter.palletCount, before.palletCount);
  for (const key of [
    "inboundDate", "product", "barcode", "inboundOrder", "customerName", "layerCount",
    "inboundSource", "billingMode", "itemVolumeM3", "boxVolumeM3", "storageRateUsd",
    "freeDays", "catalogItemId", "note",
  ]) {
    assert.equal(result.sourceAfter[key], before[key], `source ${key} should be preserved`);
    assert.equal(result.destinationAfter[key], before[key], `destination ${key} should be preserved`);
  }
});

test("partial transfer independently sets source remaining and destination layers", () => {
  const before = fixture();
  const customized = plan(before, { sourceRemainingLayerCount: 2, targetLayerCount: 1 });
  const legacy = plan(before);

  assert.equal(customized.sourceAfter.layerCount, 2);
  assert.equal(customized.destinationAfter.layerCount, 1);
  assert.equal(legacy.sourceAfter.layerCount, before.layerCount);
  assert.equal(legacy.destinationAfter.layerCount, before.layerCount);
});

test("transfer layer edits require positive safe integers", () => {
  const before = fixture();
  const invalidValues = ["", 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "not-a-layer"];
  for (const value of invalidValues) {
    assert.throws(
      () => planStockTransfer({
        before,
        targetLocation: "B16",
        mode: "all",
        targetLayerCount: value,
        userName: "测试员工",
        stamp: "2026-08-06T05:00:00.000Z",
      }),
      (error) => error instanceof TransferValidationError && error.message === "目标库位层数必须是大于或等于1的整数",
    );
    assert.throws(
      () => plan(before, { sourceRemainingLayerCount: value }),
      (error) => error instanceof TransferValidationError && error.message === "来源剩余层数必须是大于或等于1的整数",
    );
  }

  const whole = planStockTransfer({
    before,
    targetLocation: "B16",
    mode: "all",
    sourceRemainingLayerCount: 0,
    targetLayerCount: 2,
    userName: "测试员工",
    stamp: "2026-08-06T05:00:00.000Z",
  });
  assert.equal(whole.destinationAfter.layerCount, 2);
});

test("future positive layer counts remain intact across whole and partial transfers", () => {
  for (const layerCount of [3, 4, 10, 27]) {
    const before = fixture({ layerCount });
    const whole = planStockTransfer({
      before,
      targetLocation: "B16",
      mode: "all",
      targetLayerCount: layerCount,
      userName: "测试员工",
      stamp: "2026-08-06T05:00:00.000Z",
    });
    const partial = plan(before, {
      sourceRemainingLayerCount: layerCount,
      targetLayerCount: layerCount,
    });

    assert.equal(whole.destinationAfter.layerCount, layerCount);
    assert.equal(partial.sourceAfter.layerCount, layerCount);
    assert.equal(partial.destinationAfter.layerCount, layerCount);
  }
});

test("partial mode cannot silently represent a whole transfer", () => {
  const before = fixture();
  assert.throws(
    () => plan(before, { quantity: 100, boxes: 10, pallets: 2.5 }),
    TransferValidationError,
  );
});

test("transfer rejects an empty target and the current location", () => {
  const before = fixture();
  assert.throws(
    () => planStockTransfer({ before, targetLocation: " ", mode: "all", userName: "测试员工", stamp: "2026-08-06T05:00:00.000Z" }),
    (error) => error instanceof TransferValidationError && error.message === "请选择目标库位",
  );
  assert.throws(
    () => planStockTransfer({ before, targetLocation: "A1", mode: "all", userName: "测试员工", stamp: "2026-08-06T05:00:00.000Z" }),
    (error) => error instanceof TransferValidationError && error.message === "目标库位不能与当前库位相同",
  );
  assert.throws(
    () => planStockTransfer({ before, targetLocation: "Ａ１", mode: "all", userName: "测试员工", stamp: "2026-08-06T05:00:00.000Z" }),
    (error) => error instanceof TransferValidationError && error.message === "目标库位不能与当前库位相同",
  );
  assert.equal(locationCodeKey(" 新ａ１ "), "新A1");
  assert.deepEqual(matchingLocationCodes(["A1", "B16", "新A1"], " 新ａ１ "), ["新A1"]);
});

test("return item billing keeps a positive item basis on both sides", () => {
  const before = fixture({ billingMode: "item" });
  assert.throws(() => plan(before, { quantity: 0, boxes: 1, pallets: 0 }), TransferValidationError);
  assert.throws(() => plan(before, { quantity: 100, boxes: 1, pallets: 0 }), TransferValidationError);
  assert.doesNotThrow(() => plan(before, { quantity: 30, boxes: 0, pallets: 0 }));
});

test("return box billing keeps a positive box basis on both sides", () => {
  const before = fixture({ billingMode: "box" });
  assert.throws(() => plan(before, { quantity: 1, boxes: 0, pallets: 0 }), TransferValidationError);
  assert.throws(() => plan(before, { quantity: 1, boxes: 10, pallets: 0 }), TransferValidationError);
  assert.doesNotThrow(() => plan(before, { quantity: 0, boxes: 4, pallets: 0 }));
});

test("zero capacity is unlimited and reaching a limit is not an overflow", () => {
  const unlimited = calculateCapacityStatus({
    locationCode: "B16",
    capacityBoxes: 0,
    capacityPallets: 0,
    beforeBoxes: 100,
    beforePallets: 20,
    afterBoxes: 1000,
    afterPallets: 200,
  });
  assert.equal(unlimited.warning, null);
  assert.equal(unlimited.capacity.overBoxes, false);
  assert.equal(unlimited.capacity.overPallets, false);

  const atLimit = calculateCapacityStatus({
    locationCode: "B16",
    capacityBoxes: 20,
    capacityPallets: 4,
    beforeBoxes: 10,
    beforePallets: 2,
    afterBoxes: 20,
    afterPallets: 4,
  });
  assert.equal(atLimit.warning, null);
  assert.equal(atLimit.capacity.overBoxes, false);
  assert.equal(atLimit.capacity.overPallets, false);
});

test("capacity overflow returns a warning instead of a validation failure", () => {
  const result = calculateCapacityStatus({
    locationCode: "B16",
    capacityBoxes: 20,
    capacityPallets: 4,
    beforeBoxes: 18,
    beforePallets: 3.75,
    afterBoxes: 24,
    afterPallets: 4.5,
  });
  assert.ok(result.warning);
  assert.equal(result.capacity.overBoxes, true);
  assert.equal(result.capacity.overPallets, true);
  assert.equal(result.capacity.boxOverflow, 4);
  assert.equal(result.capacity.palletOverflow, 0.5);
});

test("transfer envelopes round-trip both rows with pricing history intact", () => {
  const before = fixture();
  const transfer = plan(before);
  const envelope = makeTransferEnvelope({
    operationId: "move-test-1",
    mode: "partial",
    sourceLocation: "A1",
    targetLocation: "B16",
    rows: [transfer.sourceAfter, { ...transfer.destinationAfter, id: 18 }],
  });
  const parsed = parseTransferEnvelope(JSON.stringify(envelope));

  assert.ok(parsed);
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[0].locationCode, "A1");
  assert.equal(parsed.rows[1].locationCode, "B16");
  assert.equal(parsed.rows[1].inboundDate, before.inboundDate);
  assert.equal(parsed.rows[1].inboundSource, before.inboundSource);
  assert.equal(parsed.rows[1].storageRateUsd, before.storageRateUsd);
  assert.equal(parsed.rows[1].freeDays, before.freeDays);
  assert.equal(parsed.rows[1].layerCount, before.layerCount);
});

test("move route, movement history and UI retain transfer safety invariants", async () => {
  const [moveRoute, movementsRoute, stocksRoute, stocksImportRoute, page, backups] = await Promise.all([
    readFile(new URL("../app/api/stocks/move/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/movements/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/stocks/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/stocks/import/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/backups/route.ts", import.meta.url), "utf8"),
  ]);

  assert.match(moveRoute, /requireWriteUser\(request,"stock.move"\)/);
  assert.match(moveRoute, /planStockTransfer/);
  assert.match(moveRoute, /sourceRemainingLayerCount: body\.sourceRemainingLayerCount/);
  assert.match(moveRoute, /targetLayerCount: body\.targetLayerCount/);
  assert.match(moveRoute, /makeTransferEnvelope/);
  assert.match(moveRoute, /"移库",\s*"库位"/);
  assert.match(moveRoute, /before_snapshot/);
  assert.match(moveRoute, /after_snapshot/);
  assert.match(moveRoute, /warning/);
  assert.match(moveRoute, /id = \? AND version = \? AND updated_at = \? AND location_code = \?/);
  assert.match(moveRoute, /inbound_source,billing_mode,item_volume_m3,box_volume_m3,[\s\S]*storage_rate_usd,free_days,catalog_item_id/);
  assert.match(moveRoute, /SET location_code = \?, layer_count = \?/);
  assert.match(moveRoute, /SET total_quantity = \?, total_boxes = \?, pallet_count = \?, pallet_label = \?,[\s\S]*layer_count = \?/);
  assert.match(moveRoute, /ABS\(pallet_count - \?\) < 0\.000000001 AND layer_count = \?/);
  assert.match(moveRoute, /目标层数/);
  assert.match(moveRoute, /return Response\.json\(redactWarehousePricing\(\{ ok: true, mode, source, destination, capacity, warning \},auth\.user!\)\)/);
  assert.doesNotMatch(moveRoute, /storageFeeSettlements|storage_fee_settlements|calculateStorageFee|settlementValue/);

  assert.match(movementsRoute, /"移库"/);
  assert.match(movementsRoute, /operationsOnly\?\["入库","出库","移库","箱件收货","箱件出库"\]/);
  assert.match(movementsRoute, /parseTransferEnvelope/);
  assert.match(movementsRoute, /await auditLocationCondition\(location\)/);
  assert.match(movementsRoute, /log\.action===?"移库"|log\.action\s*===\s*"移库"/);
  assert.match(stocksRoute, /已有货物不能通过保存修改更换库位/);
  assert.match(stocksRoute, /Number\.isSafeInteger\(layerCount\)/);
  assert.match(stocksRoute, /层数必须是大于或等于1的整数/);
  assert.match(stocksImportRoute, /Number\.isSafeInteger\(layerCount\)/);
  assert.match(stocksImportRoute, /第\$\{index \+ 1\}条层数必须是大于或等于1的整数/);

  assert.match(page, /fetch\("\/api\/stocks\/move"/);
  assert.match(page, /setMoveMode\("all"\)/);
  assert.match(page, /moveCapacityMessage/);
  assert.match(page, /仍可继续移动/);
  assert.match(page, /moveTargetCodes=Array\.from\(new Map\(moveAllCodes\.filter\(code=>locationCodeKey\(code\)!==moveSourceKey\)/);
  assert.match(page, /<input[^>]*list="move-target-location-codes" value=\{moveTarget\}/);
  assert.match(page, /<datalist id="move-target-location-codes">\{moveTargetCodes\.map/);
  assert.doesNotMatch(page, /className="move-target-select">目标库位<select/);
  assert.match(page, /moveTargetMatches=matchingLocationCodes\(moveAllCodes,moveTarget\)/);
  assert.match(page, /locationCodeKey\(target\)===locationCodeKey\(source\.locationCode\)/);
  assert.match(page, /value=\{moveForm\.sourceRemainingLayerCount\}/);
  assert.match(page, /value=\{moveForm\.targetLayerCount\}/);
  assert.match(page, /targetLayerCount,\.\.\.\(moveMode==="partial"\?\{sourceRemainingLayerCount\}:\{\}\)/);
  assert.match(page, /目标库位层数必须是大于或等于1的整数/);
  assert.match(page, /来源剩余层数必须是大于或等于1的整数/);
  assert.match(page, /Number\.isSafeInteger\(editing\.layerCount\)/);
  assert.match(moveRoute, /locationCodeKey\(code\) === key/);
  assert.match(moveRoute, /存在重复，请联系管理员处理/);
  assert.match(page, /disabled=\{moveBusy\|\|\(!movePending&&!moveTargetCode\)\}/);
  assert.match(page, /\{moveSource\.layerCount\|\|1\}<\/b> 层/);
  assert.match(page, /\{s\.layerCount\|\|1\}层/);
  assert.match(page, /\{editing\.layerCount\|\|1\} 层/);
  const confirmButton = page.match(/<button[^>]*onClick=\{confirmMove\}[^>]*>[\s\S]*?<\/button>/)?.[0] ?? "";
  assert.ok(confirmButton, "move confirmation button should be rendered");
  assert.doesNotMatch(confirmButton, /moveOverBoxes|moveOverPallets|moveCapacityMessage/);

  assert.match(backups, /version:9/);
  assert.match(backups, /x\.beforeSnapshot\?\?null/);
  assert.match(backups, /x\.afterSnapshot\?\?null/);
});
