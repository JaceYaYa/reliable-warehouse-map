import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { parsePalletValue, palletLabel } from "../lib/pallet.ts";

// Exercise the actual page handlers and refresh effect without a browser or live data.
const pageText = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const page = ts.createSourceFile("page.tsx", pageText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const handlers = new Map();
let refreshEffect;
function visit(node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
    handlers.set(node.name.text, node.initializer.getText(page));
  }
  if (ts.isCallExpression(node) && node.expression.getText(page) === "useEffect") {
    const dependencies = node.arguments[1]?.getText(page).replace(/\s/g, "");
    if (dependencies === "[selected,physicalStocks]") refreshEffect = node.arguments[0].getText(page);
  }
  ts.forEachChild(node, visit);
}
visit(page);
assert.ok(refreshEffect, "the stock refresh effect must be covered");
const handlerNames = ["empty", "newStock", "changeEditing", "select", "saveStock"];
for (const name of handlerNames) assert.ok(handlers.has(name), `${name} must be covered`);
const handlerCode = ts.transpileModule([
  ...handlerNames.map(name => `const ${name} = ${handlers.get(name)};`),
  `({ newStock, changeEditing, select, saveStock, refresh: ${refreshEffect} });`,
].join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;

const firstStock = () => ({ id: 1, locationCode: "A1", product: "已有货物", totalQuantity: 10, totalBoxes: 2, layerCount: 1, inboundSource: "return", version: 1 });
function editorHarness() {
  const state = {
    selected: "A1",
    warehouseTodayDate:()=>new Intl.DateTimeFormat("en-CA",{timeZone:"America/New_York"}).format(new Date()),
    setSelectedCarton(){},
    editing: firstStock(),
    stocks: [firstStock(), { ...firstStock(), id: 2, locationCode: "B1", product: "另一库位货物" }],
    get physicalStocks(){return this.stocks.filter(s=>s.totalQuantity>0||s.totalBoxes>0)},
    stockDirty: { current: false },
    canWriteInventory: true,
    get canReceive(){return this.canWriteInventory},
    get canCorrect(){return this.canWriteInventory},
    stockSourceSelection: "return",
    feedback: null,
    notice: "",
    saving: false,
    resizeMode: null,
    zones: [{ id: "A", codes: ["A1"] }, { id: "B", codes: ["B1"] }],
    setEditing(value) { state.editing = typeof value === "function" ? value(state.editing) : value; },
    setStocks(value) { state.stocks = typeof value === "function" ? value(state.stocks) : value; },
    setSelected(value) { state.selected = value; },
    setStockSourceSelection(value) { state.stockSourceSelection = value; },
    setStockSaveFeedback(value) { state.feedback = value; },
    setNotice(value) { state.notice = value; },
    setSaving(value) { state.saving = value; },
    setSelectedFeature() {},
    setResizeMode() {},
    setZoneId() {},
    pricingDraft: value => value,
    parsePalletValue,
    palletLabel,
    sourceStatusLabel: value => value,
    loadRecent: async () => {},
    withWarehouseMutation: operation => operation,
    fetch: async () => { throw new Error("No network in editor regression tests"); },
  };
  return { state, ...runInNewContext(handlerCode, state) };
}

test("adding a blank stock survives repeated background refreshes and late responses", () => {
  const editor = editorHarness();
  editor.newStock();
  const draft = editor.state.editing;
  for (let tick = 0; tick < 4; tick++) {
    editor.state.stocks = editor.state.stocks.map(stock => ({ ...stock, totalQuantity: stock.totalQuantity + 1 }));
    editor.refresh();
    assert.equal(editor.state.editing, draft, "a refresh must not replace the new draft with an existing stock");
    assert.equal(editor.state.editing.id, undefined);
    assert.equal(editor.state.editing.product, "");
  }
  assert.equal(editor.state.stockDirty.current, true);
  assert.equal(editor.state.stockSourceSelection, "unspecified");
});

test("new draft inputs and existing stock edits remain intact during refresh", () => {
  for (const adding of [true, false]) {
    const editor = editorHarness();
    if (adding) editor.newStock();
    editor.changeEditing({ product: "正在填写", totalQuantity: 23, customerName: "测试客户" });
    const draft = editor.state.editing;
    editor.refresh();
    assert.equal(editor.state.editing, draft);
    assert.equal(editor.state.editing.product, "正在填写");
    assert.equal(editor.state.editing.totalQuantity, 23);
  }
});

test("restarting an unsaved draft clears feedback even when both drafts have no id", () => {
  const editor = editorHarness();
  editor.newStock();
  editor.state.feedback = { tone: "error", text: "请填写产品名称" };
  editor.newStock();
  assert.equal(editor.state.feedback, null);
  assert.equal(editor.state.stockDirty.current, true);
});

test("switching locations exits the draft and resumes normal refresh", () => {
  const editor = editorHarness();
  editor.newStock();
  editor.select("B1");
  assert.equal(editor.state.stockDirty.current, false);
  editor.state.stocks[1] = { ...editor.state.stocks[1], totalQuantity: 37 };
  editor.refresh();
  assert.equal(editor.state.editing.id, 2);
  assert.equal(editor.state.editing.totalQuantity, 37);
});

test("a failed save preserves the new draft through the next refresh", async () => {
  const editor = editorHarness();
  editor.newStock();
  editor.changeEditing({ product: "未保存的新货物" });
  editor.state.fetch = async () => ({ ok: false, json: async () => ({ error: "保存失败" }) });
  await editor.saveStock();
  const draft = editor.state.editing;
  editor.refresh();
  assert.equal(editor.state.editing, draft);
  assert.equal(editor.state.editing.id, undefined);
  assert.equal(editor.state.stockDirty.current, true);
  assert.equal(editor.state.feedback.tone, "error");
});

test("a successful save exits draft protection and keeps the newly created stock selected", async () => {
  const editor = editorHarness();
  editor.newStock();
  editor.changeEditing({ product: "新货物" });
  editor.state.fetch = async () => ({ ok: true, json: async () => ({ stock: { ...editor.state.editing, id: 3, version: 1 } }) });
  await editor.saveStock();
  assert.equal(editor.state.stockDirty.current, false);
  assert.equal(editor.state.editing.id, 3);
  editor.state.stocks = editor.state.stocks.map(stock => stock.id === 3 ? { ...stock, totalQuantity: 45 } : stock);
  editor.refresh();
  assert.equal(editor.state.editing.id, 3);
  assert.equal(editor.state.editing.totalQuantity, 45);
});

test("normal initial loading still selects an existing stock", () => {
  const editor = editorHarness();
  editor.state.editing = { locationCode: "A1", product: "" };
  editor.refresh();
  assert.equal(editor.state.editing.id, 1);
  assert.equal(editor.state.editing.product, "已有货物");
});

const messageDraft = (patch = {}) => ({
  locationCode: "B1", inboundDate: "2026-09-14", product: "消息中的货物", sku: "", fnsku: "", barcode: "BAR-123",
  inboundOrder: "IB-123", totalQuantity: 10, totalBoxes: 2, customerName: "客户 DQ",
  palletCount: 1, palletLabel: "1", layerCount: 1, note: "原始清点消息", updatedBy: "",
  inboundSource: "unspecified", billingMode: "item", itemVolumeM3: 0, boxVolumeM3: 0,
  storageRateUsd: 0.7, freeDays: 0, catalogItemId: null, ...patch,
});

test("message confirmation submits edited fields as a new receipt without inherited inventory metadata", async () => {
  const editor = editorHarness();
  const draft = Object.freeze(messageDraft({
    id: 99, version: 17, updatedAt: "2026-08-01T00:00:00Z",
    inboundDate: "2026-09-12", product: "人工核对后的品名", customerName: "核对客户",
    barcode: "SCANNED-456", inboundOrder: "IB-456", totalQuantity: 0, totalBoxes: 8,
    palletCount: 0.5, palletLabel: "1/2", layerCount: 3, note: "箱内未开封，数量未清点",
    inboundSource: "domestic", itemVolumeM3: 0.001, storageRateUsd: 0.5, freeDays: 90,
  }));
  let request;
  editor.state.fetch = async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return { ok: true, json: async () => ({ stock: { ...request.body, id: 3, version: 0 } }) };
  };
  const result = await editor.saveStock(draft);
  assert.equal(result.ok, true);
  assert.equal(request.url, "/api/stocks");
  assert.equal(request.options.method, "POST");
  const { id, version, updatedAt, billingMode, itemVolumeM3, boxVolumeM3, storageRateUsd, freeDays, catalogItemId, ...expected } = draft;
  assert.deepEqual(request.body, expected);
  assert.equal(request.body.palletCount, 0.5);
  assert.equal(request.body.palletLabel, "1/2");
  for (const field of ["billingMode", "itemVolumeM3", "boxVolumeM3", "storageRateUsd", "freeDays", "catalogItemId"]) {
    assert.equal(Object.hasOwn(request.body, field), false, `${field} must remain server-owned during warehouse receiving`);
  }
  assert.equal(draft.id, 99, "removing inherited metadata must not mutate the user's draft");
  assert.equal(editor.state.stocks.find(stock => stock.id === 3)?.totalBoxes, 8);
});

test("successful message confirmation preserves the separate sidebar and its draft protection", async () => {
  for (const dirty of [false, true]) {
    const editor = editorHarness();
    if (dirty) editor.changeEditing({ product: "侧栏正在填写的货物", totalQuantity: 23 });
    const sidebar = editor.state.editing;
    const feedback = editor.state.feedback;
    const source = editor.state.stockSourceSelection;
    editor.state.fetch = async (_url, options) => ({
      ok: true, json: async () => ({ stock: { ...JSON.parse(options.body), id: 3, version: 0 } }),
    });
    const result = await editor.saveStock(messageDraft());
    assert.equal(result.ok, true);
    assert.equal(editor.state.editing, sidebar);
    assert.equal(editor.state.selected, "A1");
    assert.equal(editor.state.stockSourceSelection, source);
    assert.equal(editor.state.feedback, feedback);
    assert.equal(editor.state.stockDirty.current, dirty);
    assert.equal(editor.state.saving, false);
    if (dirty) {
      editor.refresh();
      assert.equal(editor.state.editing, sidebar, "the next synchronization must preserve sidebar edits");
    }
  }
});

for (const failure of ["server", "network"]) {
  test(`a ${failure} failure preserves message input and separate sidebar edits`, async () => {
    const editor = editorHarness();
    editor.changeEditing({ product: "未保存的侧栏货物" });
    const sidebar = editor.state.editing;
    const feedback = editor.state.feedback;
    const stocks = editor.state.stocks;
    const draft = Object.freeze(messageDraft({ totalBoxes: 8, note: "人工补充的备注" }));
    const snapshot = JSON.stringify(draft);
    editor.state.fetch = async () => {
      if (failure === "network") throw new Error("offline");
      return { ok: false, json: async () => ({ error: "服务器拒绝保存" }) };
    };
    const result = await editor.saveStock(draft);
    assert.equal(result.ok, false);
    assert.ok(result.error);
    assert.equal(JSON.stringify(draft), snapshot);
    assert.equal(editor.state.editing, sidebar);
    assert.equal(editor.state.feedback, feedback);
    assert.equal(editor.state.stocks, stocks);
    assert.equal(editor.state.stockDirty.current, true);
    assert.equal(editor.state.saving, false);
    editor.refresh();
    assert.equal(editor.state.editing, sidebar);
  });
}

test("a receipt stays successful when only the subsequent history refresh fails", async () => {
  const editor = editorHarness();
  let requests = 0;
  editor.state.fetch = async (_url, options) => {
    requests++;
    return { ok: true, json: async () => ({ stock: { ...JSON.parse(options.body), id: 3, version: 0 } }) };
  };
  editor.state.loadRecent = async () => { throw new Error("history temporarily unavailable"); };
  const result = await editor.saveStock(messageDraft());
  assert.equal(result.ok, true, "an already saved receipt must not become a retryable failed receipt");
  assert.equal(result.error, undefined);
  assert.equal(requests, 1);
  assert.equal(editor.state.stocks.filter(stock => stock.id === 3).length, 1);
  assert.equal(editor.state.saving, false);
});

for (const [label, patch] of [
  ["empty product", { product: "  " }],
  ["unknown location", { locationCode: "Z999" }],
  ["missing location", { locationCode: "" }],
  ["zero layer", { layerCount: 0 }],
  ["fractional layer", { layerCount: 1.5 }],
  ["non-finite layer", { layerCount: NaN }],
]) {
  test(`message confirmation rejects ${label} before requesting an inventory write`, async () => {
    const editor = editorHarness();
    let requests = 0;
    editor.state.fetch = async () => { requests++; throw new Error("unexpected request"); };
    const result = await editor.saveStock(messageDraft(patch));
    assert.equal(result.ok, false);
    assert.ok(result.error);
    assert.equal(requests, 0);
    assert.equal(editor.state.saving, false);
  });
}

test("message confirmation respects write permission and permits return receiving without measurements", async () => {
  const denied = editorHarness();
  let deniedRequests = 0;
  denied.state.canWriteInventory = false;
  denied.state.fetch = async () => { deniedRequests++; throw new Error("unexpected request"); };
  const rejected = await denied.saveStock(messageDraft({ inboundSource: "return" }));
  assert.equal(rejected.ok, false);
  assert.ok(rejected.error);
  assert.equal(deniedRequests, 0);
  assert.equal(denied.state.saving, false);

  const allowed = editorHarness();
  let body;
  allowed.state.fetch = async (_url, options) => {
    body = JSON.parse(options.body);
    return { ok: true, json: async () => ({ stock: { ...body, id: 3, version: 0 } }) };
  };
  const result = await allowed.saveStock(messageDraft({ inboundSource: "return" }));
  assert.equal(result.ok, true);
  assert.equal(body.inboundSource, "return");
  assert.equal(body.totalQuantity, 10);
  assert.equal(body.palletCount, 1);
  assert.equal(Object.hasOwn(body, "itemVolumeM3"), false);
  assert.equal(Object.hasOwn(body, "storageRateUsd"), false);
  assert.equal(allowed.state.saving, false);
});

test("a second confirmation cannot issue another write while the first receipt is saving", async () => {
  const editor = editorHarness();
  let release;
  let requests = 0;
  editor.state.fetch = async (_url, options) => {
    requests++;
    await new Promise(resolve => { release = resolve; });
    return { ok: true, json: async () => ({ stock: { ...JSON.parse(options.body), id: 3, version: 0 } }) };
  };
  const first = editor.saveStock(messageDraft());
  assert.equal(editor.state.saving, true);
  const second = await editor.saveStock(messageDraft());
  assert.equal(second.ok, false);
  assert.equal(requests, 1);
  release();
  assert.equal((await first).ok, true);
  assert.equal(editor.state.saving, false);
});
