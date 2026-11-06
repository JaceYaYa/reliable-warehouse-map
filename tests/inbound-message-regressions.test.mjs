import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { applyMessageReference, editMessageInboundItem, matchMessageLocations, messageDuplicateIds, parseInboundMessage } from "../lib/inbound-message.ts";

const reference = (patch = {}) => ({ id: 1, locationCode: "新D1", product: "Qtree-X33车载支架（无卡）", customerName: "示例客户", barcode: "",
  totalQuantity: 1528, totalBoxes: 13, palletCount: 1, layerCount: 3, inboundDate: "2026-09-11", inboundSource: "return", billingMode: "item",
  itemVolumeM3: 0.00049074, boxVolumeM3: 0, storageRateUsd: 0.7, freeDays: 0, updatedAt: "2026-09-11T10:00:00Z", ...patch });
const example = "9️⃣退货清点：\n无卡----X33车载支架\n新品共1528个1托（12箱X120个+1箱X88个）\n位于：D1三层\n残次品：15个/箱（外包装破损）\n位于：D1三层";
const defaults = () => ({ inboundDate: "2026-09-14", locations: ["新D1", "新D2", "A1", "新A1"], stocks: [reference(), reference({ id: 2, product: "残次品：Qtree-X33车载支架（无卡）", totalQuantity: 15, totalBoxes: 1, palletCount: 0 })] });
const unopened = (patch = {}) => reference({ id: 824, locationCode: "新D20", product: "IB557715465RS", customerName: "DQ", totalQuantity: 0, totalBoxes: 8, palletCount: 1, layerCount: 1, inboundDate: "2026-09-09", inboundSource: "unspecified", itemVolumeM3: 0, note: "FBA18XB2J3B3U", ...patch });
const unopenedOptions = (stocks = [unopened()]) => ({ inboundDate: "2026-09-14", locations: ["新D20", "新D21"], stocks });
const unopenedMessage = "FBA18XB2J3B3U。 DQ入库8箱，放在D20第一层";

test("an unopened shipment sentence recovers the registered batch without requiring product contents or unit counts", () => {
  const options = unopenedOptions(), before = structuredClone(options);
  const result = parseInboundMessage(unopenedMessage, options);
  assert.deepEqual(result.errors, []); assert.equal(result.items.length, 1);
  const item = result.items[0];
  assert.deepEqual([item.draft.product, item.draft.customerName, item.draft.locationCode, item.draft.layerCount, item.draft.totalQuantity, item.draft.totalBoxes, item.draft.palletCount], ["IB557715465RS", "DQ", "新D20", 1, 0, 8, 1]);
  assert.equal(item.quantityUnknown, true); assert.equal(item.draft.inboundSource, "unspecified");
  assert.equal(item.draft.inboundDate, "2026-09-14"); assert.equal(item.draft.inboundOrder, ""); assert.equal(item.draft.barcode, "");
  assert.equal(Object.hasOwn(item.draft, "id"), false); assert.equal(item.draft.catalogItemId, null);
  assert.match(item.draft.note, /FBA18XB2J3B3U/); assert.match(item.draft.note, /消息未提供件数/);
  assert.deepEqual(item.duplicateIds, [824]); assert.match(item.warnings.join(" "), /沿用同批记录/);
  assert.doesNotMatch(item.warnings.join(" "), /未写件数|填写产品/); assert.deepEqual(options, before);
});

test("unopened receipts accept sentence punctuation, line breaks and explicit customer fields", () => {
  for (const message of ["FBA18XB2J3B3U. DQ入库8箱,放在D20第一层", "FBA18XB2J3B3U\nDQ入库8箱\n放在D20第一层", "FBA18XB2J3B3U。客户：DQ\n8箱\n放在D20第一层", "FBA18XB2J3B3U DQ入库8箱放在D20第一层"]) {
    const result = parseInboundMessage(message, unopenedOptions());
    assert.equal(result.items.length, 1, message); assert.equal(result.items[0].draft.product, "IB557715465RS", message);
    assert.equal(result.items[0].draft.totalBoxes, 8); assert.equal(result.items[0].draft.layerCount, 1);
  }
});

test("a new unopened shipment keeps known boxes and number, with V122 default-one pallet metadata", () => {
  const item = parseInboundMessage(unopenedMessage, unopenedOptions([])).items[0];
  assert.equal(item.draft.product, "FBA18XB2J3B3U"); assert.equal(item.draft.customerName, "DQ");
  assert.equal(item.draft.totalQuantity, 0); assert.equal(item.draft.totalBoxes, 8); assert.equal(item.draft.palletCount, 1);
  assert.equal(item.quantityUnknown, true); assert.equal(item.references.length, 0); assert.deepEqual(item.duplicateIds, []);
  const noNumber = parseInboundMessage("DQ入库8箱，放在D20第一层", unopenedOptions([])).items[0];
  assert.equal(noNumber.draft.product, "未清点货物"); assert.equal(noNumber.draft.totalBoxes, 8);
});

test("receipt lookup uses the full identifier and explicit customer, never nearby or suffixed batches", () => {
  const wrong = ["XFBA18XB2J3B3U", "FBA18XB2J3B3U9", "FBA18XB2J3B3U-C1", "FBA18XB2J3B3U_C1"].map((note, index) => unopened({ id: index + 1, note }));
  wrong.push(unopened({ id: 12, customerName: "DH" }));
  const item = parseInboundMessage(unopenedMessage, unopenedOptions(wrong)).items[0];
  assert.equal(item.references.length, 0); assert.equal(item.draft.product, "FBA18XB2J3B3U"); assert.equal(item.draft.customerName, "DQ");
  for (const field of ["product", "barcode", "inboundOrder", "note"]) {
    const stock = unopened({ note: "", [field]: "FBA18XB2J3B3U" });
    assert.equal(parseInboundMessage(unopenedMessage, unopenedOptions([stock])).items[0].references.length, 1);
  }
});

test("different boxes, location or layer cannot inherit old pallets but still warn about the same batch", () => {
  for (const message of [unopenedMessage.replace("8箱", "7箱"), unopenedMessage.replace("D20", "D21"), unopenedMessage.replace("第一层", "第二层")]) {
    const item = parseInboundMessage(message, unopenedOptions()).items[0];
    assert.equal(item.draft.palletCount, 1); assert.deepEqual(item.duplicateIds, [824]);
  }
  const explicit = parseInboundMessage(unopenedMessage.replace("8箱", "8箱2托"), unopenedOptions()).items[0];
  assert.equal(explicit.draft.palletCount, 2); assert.deepEqual(explicit.duplicateIds, [824]);
  const ambiguous = parseInboundMessage(unopenedMessage, { ...unopenedOptions(), locations: ["D20", "新D20"] }).items[0];
  assert.equal(ambiguous.draft.locationCode, ""); assert.equal(ambiguous.draft.palletCount, 1);
  const selected = parseInboundMessage(unopenedMessage, unopenedOptions()).items[0];
  assert.equal(applyMessageReference({ ...selected, draft: { ...selected.draft, layerCount: 2 } }, unopened()).draft.palletCount, 1);
  assert.equal(applyMessageReference({ ...selected, draft: { ...selected.draft, locationCode: "新D21" } }, unopened()).draft.palletCount, 1);
});

test("an exact unopened batch reference keeps existing condition labels and never copies known unit counts", () => {
  const item = parseInboundMessage(unopenedMessage, unopenedOptions([unopened({ product: "残次品：IB557715465RS（无卡）", totalQuantity: 80 })])).items[0];
  assert.equal(item.draft.product, "残次品：IB557715465RS（无卡）"); assert.equal(item.draft.totalQuantity, 0); assert.equal(item.draft.palletCount, 1);
});

test("multiple unopened receipts keep their own batch, customer and box count", () => {
  const result = parseInboundMessage(unopenedMessage + "\nIB004260801RS-C1。DH入库9箱，放在D20第二层", unopenedOptions([unopened(), unopened({ id: 818, product: "IB559715356RS-C6", note: "", customerName: "DH", totalBoxes: 9, layerCount: 2 })]));
  assert.equal(result.items.length, 2);
  assert.deepEqual(result.items.map(item => [item.draft.product, item.draft.customerName, item.draft.totalBoxes, item.draft.layerCount]), [["IB557715465RS", "DQ", 8, 1], ["IB559715356RS-C6", "DH", 9, 2]]);
});

test("the actual return example keeps physical facts and defaults each new placement to one pallet", () => {
  const options = defaults(), before = structuredClone(options);
  const result = parseInboundMessage(example, options);
  assert.deepEqual(result.errors, []); assert.equal(result.items.length, 2);
  assert.deepEqual(result.items.map(item => [item.draft.product, item.draft.totalQuantity, item.draft.totalBoxes, item.draft.palletCount, item.draft.locationCode, item.draft.layerCount]), [
    ["Qtree-X33车载支架（无卡）", 1528, 13, 1, "新D1", 3], ["残次品：Qtree-X33车载支架（无卡）", 15, 1, 1, "新D1", 3],
  ]);
  for (const item of result.items) {
    assert.equal(item.draft.inboundDate, "2026-09-14"); assert.equal(item.draft.customerName, "示例客户");
    assert.equal(item.draft.itemVolumeM3, 0.00049074); assert.equal(item.draft.inboundSource, "return");
    assert.equal(item.draft.catalogItemId, null); assert.equal(Object.hasOwn(item.draft, "id"), false); assert.deepEqual(item.warnings, []);
  }
  assert.match(result.items[1].draft.note, /外包装破损/); assert.deepEqual(options, before);
});

test("the existing source example is recognized as duplicate stock, even with a different proposed date", () => {
  const result = parseInboundMessage(example, defaults());
  assert.deepEqual(result.items.map(item => item.duplicateIds), [[1], [2]]);
  const otherBatch = { ...result.items[0].draft, totalQuantity: 100 };
  assert.deepEqual(messageDuplicateIds(otherBatch, defaults().stocks), []);
});

test("location matching uses fullwidth/case normalization and never confuses legacy and new aliases", () => {
  assert.deepEqual(matchMessageLocations("ｄ１", ["新D1"]), ["新D1"]);
  assert.deepEqual(matchMessageLocations("A1", ["A1", "新A1", "A1通道"]), ["A1", "新A1"]);
  assert.deepEqual(matchMessageLocations("新A1", ["A1", "新A1"]), ["新A1"]);
  assert.deepEqual(matchMessageLocations("D99", ["新D1"]), []);
  const result = parseInboundMessage("X33车载支架\n新品10个1箱1托\n位于：A1三层", defaults());
  assert.equal(result.items[0].draft.locationCode, ""); assert.equal(result.items[0].locations.length, 2);
});

for (const [location, expectedLayer] of [["D1三层", 3], ["D1 第3层", 3], ["D1 12层", 12], ["D1十二层", 12], ["新D1两层", 2]]) {
  test(`message layer parsing preserves the location number in ${location}`, () => {
    const result = parseInboundMessage(`X33车载支架\n新品10个1箱1托\n位于：${location}`, defaults());
    assert.equal(result.items[0].draft.locationCode, "新D1"); assert.equal(result.items[0].draft.layerCount, expectedLayer);
  });
}

test("pack-only arithmetic and fractional pallets are not replaced by the first per-carton quantity", () => {
  const result = parseInboundMessage("X33车载支架\n新品（2箱×120个+1箱×88个）1/2托\n位于：D1三层", defaults());
  assert.equal(result.items[0].draft.totalQuantity, 328); assert.equal(result.items[0].draft.totalBoxes, 3);
  assert.equal(result.items[0].draft.palletCount, 0.5); assert.equal(result.items[0].draft.palletLabel, "1/2");
});

test("conflicting total and carton arithmetic produces a visible discrepancy instead of silently fixing it", () => {
  const result = parseInboundMessage(example.replace("1528", "1500"), defaults());
  assert.equal(result.items[0].draft.totalQuantity, 1500); assert.match(result.items[0].warnings.join(" "), /1500.*1528.*不一致/);
});

test("unparenthesized carton formulas use their sum, not a per-carton count", () => {
  const result = parseInboundMessage("X33车载支架\n新品2箱×120个+1箱×88个1托\n位于：D1三层", defaults());
  assert.equal(result.items[0].draft.totalQuantity, 328); assert.equal(result.items[0].draft.totalBoxes, 3);
  assert.deepEqual(result.items[0].warnings, []);
});

test("negative counts and zero-denominator pallets cannot silently become positive or zero", () => {
  for (const count of ["-15个1箱", "15个-1托", "15个-1/2托", "15个1/0托", "15个1/0.0托", "1.5个1箱"]) {
    const result = parseInboundMessage(`X33车载支架\n新品${count}\n位于：D1三层`, defaults());
    assert.equal(result.items.length, 0); assert.ok(result.errors.length > 0);
  }
});

test("thousands separators do not truncate receipt totals", () => {
  const result = parseInboundMessage(example.replace("1528", "1,528"), defaults());
  assert.equal(result.items[0].draft.totalQuantity, 1528); assert.deepEqual(result.items[0].warnings, []);
});

test("a condition/product heading and numeric notes do not create extra stock", () => {
  const result = parseInboundMessage("残次品：无卡 X33车载支架\n15个1箱\n位于：D1三层\n备注：其中3个包装破损", defaults());
  assert.equal(result.items.length, 1); assert.equal(result.items[0].draft.product, "残次品：Qtree-X33车载支架（无卡）");
  assert.equal(result.items[0].draft.totalQuantity, 15); assert.match(result.items[0].draft.note, /其中3个/);
});

test("card variants are kept separate and another customer's data is not guessed", () => {
  const options = defaults(); options.stocks = [reference({ id: 3, product: "Qtree-X33车载支架（有卡）" }), reference({ locationCode: "新D2", customerName: "客户甲" }), reference({ id: 4, locationCode: "新D2", customerName: "客户乙" })];
  const result = parseInboundMessage(example, options);
  assert.ok(result.items[0].references.every(stock => !stock.product.includes("有卡")));
  assert.equal(result.items[0].referenceId, ""); assert.equal(result.items[0].draft.customerName, "");
  const selected = applyMessageReference(result.items[1], result.items[1].references[0]);
  assert.equal(selected.draft.customerName, "客户甲"); assert.match(selected.draft.product, /^残次品：.*（无卡）$/);
  assert.equal(selected.draft.palletCount, 1);
});

test("a customer supplied in the message constrains same-product lookup", () => {
  const options = defaults(); options.stocks.push(reference({ id: 5, customerName: "其他客户" }));
  const result = parseInboundMessage("客户：示例客户\n" + example, options);
  assert.equal(result.items[0].draft.customerName, "示例客户"); assert.ok(result.items[0].references.every(stock => stock.customerName === "示例客户"));
});

test("two product headings do not share quantities or location data", () => {
  const result = parseInboundMessage(example + "\n退货清点：\nAB12支架\n新品100个2箱1托\n位于：D2一层", defaults());
  assert.equal(result.items.length, 3); assert.equal(result.items[2].draft.product, "AB12支架");
  assert.equal(result.items[2].draft.totalQuantity, 100); assert.equal(result.items[2].draft.locationCode, "新D2"); assert.equal(result.items[2].draft.layerCount, 1);
});

test("model suffixes and Chinese-only product headings never reuse the preceding product or location", () => {
  const result = parseInboundMessage("X33车载支架\n新品10个1箱1托\n位于：D1三层\nAB12支架\n新品5个1箱1托\n透明饭盒\n新品8个1箱1托\n位于：D2二层", { ...defaults(), stocks: [] });
  assert.deepEqual(result.items.map(item => [item.draft.product, item.draft.totalQuantity, item.draft.locationCode]), [["X33车载支架", 10, "新D1"], ["AB12支架", 5, ""], ["透明饭盒", 8, "新D2"]]);
});

test("customer and order fields after quantities belong to the current receipt", () => {
  const result = parseInboundMessage("无卡 X33车载支架\n新品10个1箱1托\n位于：D1三层\n客户：另一客户\n入库单号：IN-123", defaults());
  assert.equal(result.items[0].draft.customerName, "另一客户"); assert.equal(result.items[0].draft.inboundOrder, "IN-123");
  assert.equal(result.items[0].references.length, 0);
});

test("same-customer card or barcode variants require selection and preserve the selected card", () => {
  const options = defaults(); options.stocks = [reference({ product: "Qtree-X33车载支架（有卡）", barcode: "HAS-CARD" }), reference({ id: 2, barcode: "NO-CARD" })];
  const result = parseInboundMessage("X33车载支架\n新品10个1箱1托\n位于：D1三层", options);
  assert.equal(result.items[0].references.length, 2); assert.equal(result.items[0].referenceId, ""); assert.equal(result.items[0].draft.barcode, "");
  const selected = applyMessageReference(result.items[0], options.stocks[0]);
  assert.equal(selected.draft.barcode, "HAS-CARD"); assert.match(selected.draft.product, /（有卡）$/);
});

test("separate quantity fields and defect subcounts remain one receipt", () => {
  const result = parseInboundMessage("透明饭盒\n数量：10个\n箱数：1箱\n托盘：1托\n位于：D1三层\n其中3个外包装破损", defaults());
  assert.equal(result.items.length, 1);
  assert.deepEqual([result.items[0].draft.totalQuantity, result.items[0].draft.totalBoxes, result.items[0].draft.palletCount], [10, 1, 1]);
  assert.match(result.items[0].draft.note, /其中3个/); assert.deepEqual(result.items[0].warnings, []);
});

test("empty/oversized messages do not create drafts, and source text has no executable path", () => {
  assert.equal(parseInboundMessage("", defaults()).items.length, 0);
  assert.equal(parseInboundMessage("x".repeat(20001), defaults()).items.length, 0);
  const result = parseInboundMessage("<script>alert(1)</script>\n新品10个1箱1托\n位于：D1三层", defaults());
  assert.equal(result.items.length, 1); assert.ok(result.items[0].draft.product.includes("<script>"));
});

test("message receiving hands product matches to the same goods draft without direct stock writes", async () => {
  const [page, dialog] = await Promise.all(["../app/page.tsx", "../components/MessageGoodsDialog.tsx"].map(path => readFile(new URL(path, import.meta.url), "utf8")));
  assert.match(page, /<MessageGoodsDialog/);assert.match(page, /setMessageImport\(data\)/);assert.match(page, /messageImport=\{/);
  assert.match(page, /<StockDetailsPanel value=\{editing\}/);assert.doesNotMatch(page, /<StockEntryForm/);
  assert.doesNotMatch(dialog, /\/api\/stocks/);assert.match(dialog, /onImport/);
});

test("manual receiving edits retain independent fields when unopened occupancy is recalculated", () => {
  const original = parseInboundMessage(unopenedMessage, unopenedOptions()).items[0];
  const edited = editMessageInboundItem(original, { product: "人工核对批次", customerName: "DQ", note: "人工备注", inboundOrder: "IN-NEW", catalogItemId: 9, itemVolumeM3: .2 });
  const moved = editMessageInboundItem(edited, { locationCode: "新D21", layerCount: 2 });
  assert.equal(moved.draft.palletCount, 1);
  for (const field of ["product", "customerName", "note", "inboundOrder", "catalogItemId", "itemVolumeM3"]) assert.equal(moved.draft[field], edited.draft[field], field);
  assert.equal(original.draft.product, "IB557715465RS"); assert.equal(original.draft.palletCount, 1);
  const counted = editMessageInboundItem(edited, { totalQuantity: 30 });
  assert.equal(counted.quantityUnknown, false); assert.equal(counted.draft.totalQuantity, 30);
});

test("manually confirmed pallets survive later box and location edits without stale hints", () => {
  const original = parseInboundMessage(unopenedMessage, unopenedOptions()).items[0];
  const confirmed = editMessageInboundItem(original, { palletLabel: "1/2", palletCount: .5 });
  const moved = editMessageInboundItem(confirmed, { locationCode: "新D21", totalBoxes: 4 });
  assert.equal(moved.draft.palletLabel, "1/2"); assert.equal(moved.draft.palletCount, .5);
  assert.doesNotMatch(moved.warnings.join(" "), /沿用同批记录|未单列托盘数/);
});

test("catalog selection patches compose, while identity edits and reference changes detach the old catalog", () => {
  const original = parseInboundMessage(example, defaults()).items[0];
  const identity = editMessageInboundItem(original, { product: "已选目录产品", barcode: "CATALOG", customerName: "目录客户", catalogItemId: 12 });
  const priced = editMessageInboundItem(identity, { catalogItemId: 12, itemVolumeM3: .5, storageRateUsd: .8 });
  assert.equal(priced.draft.product, "已选目录产品"); assert.equal(priced.draft.catalogItemId, 12);
  const scanned = editMessageInboundItem(priced, { barcode: "SCANNED" });
  assert.equal(scanned.draft.catalogItemId, null); assert.equal(scanned.draft.barcode, "SCANNED");
  const referenced = applyMessageReference(priced, original.references[0]);
  assert.equal(referenced.draft.catalogItemId, null); assert.equal(referenced.draft.product, original.references[0].product);
});

// Execute the dialog's actual callbacks with isolated drafts; no browser or inventory is used.
const { default: ts } = await import("typescript");
const { runInNewContext } = await import("node:vm");
const dialogText = await readFile(new URL("../components/MessageInboundDialog.tsx", import.meta.url), "utf8");
const dialogTree = ts.createSourceFile("MessageInboundDialog.tsx", dialogText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const dialogHandlers = new Map();
function visitDialog(node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) dialogHandlers.set(node.name.text, node.initializer.getText(dialogTree));
  ts.forEachChild(node, visitDialog);
}
visitDialog(dialogTree);
const dialogCode = ts.transpileModule(["submit", "update", "parse"].map(name => `const ${name} = ${dialogHandlers.get(name)};`).join("\n") + "\n({submit, update, parse});", { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
function messageDialogHarness() {
  const item = parseInboundMessage("透明饭盒\n新品10个1箱1托\n位于：D1三层", { ...defaults(), stocks: [] }).items[0];
  const state = { item, items: [item, { ...structuredClone(item), key: "second" }], stocks: [], done: false, busy: false, changedMessage: false, validLocation: true, needsReference: false,
    saved: [], feedback: {}, duplicatesAllowed: [], submitting: { current: false }, completed: { current: new Set() }, edited: { current: new Set() },
    text: example, date: "2026-09-14", locations: defaults().locations, defaultRate: .7, defaultFreeDays: 0,
    messageDuplicateIds, parseInboundMessage, window: { confirm: () => true }, calls: [], onSave: async draft => { state.calls.push(draft); return { ok: true }; },
  };
  for (const [setter, key] of Object.entries({ setSaved: "saved", setFeedback: "feedback", setItems: "items", setDuplicatesAllowed: "duplicatesAllowed", setErrors: "errors", setActiveKey: "activeKey", setParsedText: "parsedText" })) state[setter] = change => { state[key] = typeof change === "function" ? change(state[key]) : change; };
  return { state, ...runInNewContext(dialogCode, state) };
}

test("recognition only fills the form and never saves inventory", () => {
  const dialog = messageDialogHarness(); dialog.parse();
  assert.equal(dialog.state.items.length, 2); assert.equal(dialog.state.activeKey, dialog.state.items[0].key);
  assert.equal(dialog.state.parsedText, example); assert.equal(dialog.state.calls.length, 0);
});

test("editing and scanning target only the chosen message and reset its duplicate consent", () => {
  const dialog = messageDialogHarness(), other = dialog.state.items[0];
  dialog.state.duplicatesAllowed = ["second", other.key];
  dialog.update("second", row => editMessageInboundItem(row, { barcode: "NEW-SCAN", product: "修改后的产品" }));
  assert.equal(dialog.state.items[0], other);
  assert.equal(dialog.state.items[1].draft.barcode, "NEW-SCAN"); assert.equal(dialog.state.items[1].draft.product, "修改后的产品");
  assert.equal(dialog.state.duplicatesAllowed.includes("second"), false); assert.equal(dialog.state.duplicatesAllowed.includes(other.key), true);
  assert.equal(dialog.state.calls.length, 0);
});

test("reparsing preserves corrected forms when replacement is declined", () => {
  const dialog = messageDialogHarness(), before = dialog.state.items;
  dialog.state.edited.current.add(before[0].key); dialog.state.window.confirm = () => false;
  dialog.parse(); assert.equal(dialog.state.items, before); assert.equal(dialog.state.calls.length, 0);
});

test("one confirmation saves the edited draft once even with repeated pending or stale clicks", async () => {
  const dialog = messageDialogHarness(); let finish;
  dialog.state.item.draft.note = "已核对备注";
  dialog.state.onSave = draft => { dialog.state.calls.push(draft); return new Promise(resolve => { finish = resolve; }); };
  const pending = dialog.submit(); await dialog.submit();
  assert.equal(dialog.state.calls.length, 1); assert.equal(dialog.state.calls[0].note, "已核对备注");
  finish({ ok: true }); await pending; await dialog.submit();
  assert.equal(dialog.state.calls.length, 1); assert.equal(dialog.state.saved.length, 1); assert.equal(dialog.state.feedback[dialog.state.item.key], "入库成功");
});

test("failed confirmation retains the edited draft for a later explicit retry", async () => {
  const dialog = messageDialogHarness(), before = dialog.state.item;
  dialog.state.onSave = async () => ({ ok: false, error: "网络中断" });
  await dialog.submit(); assert.equal(dialog.state.item, before); assert.equal(dialog.state.saved.length, 0);
  assert.equal(dialog.state.feedback[before.key], "网络中断"); assert.equal(dialog.state.submitting.current, false);
  dialog.state.onSave = async () => ({ ok: true }); await dialog.submit(); assert.equal(dialog.state.saved.length, 1);
});

test("duplicate and unresolved forms cannot submit until explicitly resolved", async () => {
  const duplicate = messageDialogHarness(); duplicate.state.stocks = [{ ...duplicate.state.item.draft, id: 71 }];
  await duplicate.submit(); assert.equal(duplicate.state.calls.length, 0);
  duplicate.state.duplicatesAllowed = [duplicate.state.item.key]; await duplicate.submit(); assert.equal(duplicate.state.calls.length, 1);
  for (const patch of [{ busy: true }, { changedMessage: true }, { validLocation: false }, { needsReference: true }]) {
    const blocked = messageDialogHarness(); Object.assign(blocked.state, patch); await blocked.submit(); assert.equal(blocked.state.calls.length, 0);
  }
});
