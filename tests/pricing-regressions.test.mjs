import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  billingModeForAvailableStock,
  calculateStorageFeeForPeriod,
  inboundSourceLabel,
  InvalidStorageBillingPeriodError,
  normalizeInboundSource,
  resolveStorageBillingPeriod,
} from "../lib/pricing.ts";
import {
  customerPricingKey,
  effectiveCustomerPricing,
  parseCustomerPricingProfile,
} from "../lib/customer-pricing.ts";
import { movementInventoryDetails, redactMovementSnapshotPricing } from "../lib/movement-display.ts";
import { prepareCatalogRow } from "../lib/pricing-workbook.ts";
import {
  dimensionFromCentimeters,
  dimensionToCentimeters,
  dimensionsToVolume,
} from "../components/pricing-types.ts";

test("inventory source keeps legacy values and supports no selection", () => {
  assert.equal(normalizeInboundSource("return"), "return");
  assert.equal(normalizeInboundSource("domestic"), "domestic");
  assert.equal(normalizeInboundSource("unspecified"), "unspecified");
  assert.equal(inboundSourceLabel("unspecified"), "未选择");
  assert.equal(normalizeInboundSource("legacy-or-empty"), "domestic");
});

test("new inventory defaults to none while outbound keeps the stored status", async () => {
  const [page, entryForm, fields, stocksRoute] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/StockEntryForm.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/ReturnPricingFields.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/stocks/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(page, /const empty=.*inboundSource:"unspecified"/);
  assert.match(page, /const sourceStatusLabel=.*"退货".*"国内".*"无"/);
  const outboundDraft = page.match(/const outboundDraft=.*?;\r?\n/)?.[0] ?? "";
  assert.match(outboundDraft, /\.\.\.pricingDraft\(stock\)/);
  assert.doesNotMatch(outboundDraft, /sourceType:/);
  assert.match(page, /setOutboundForm\(outboundDraft\(editing,full\)\)/);
  assert.match(page, /useState<Stock\["inboundSource"\]>\("unspecified"\)/);
  assert.match(page, /<StockDetailsPanel value=\{editing\}/);
  assert.match(entryForm, /value=\{sourceSelection \?\? editing\.inboundSource\}/);
  assert.match(page, /状态：\{sourceStatusLabel\(s\.inboundSource\)\}/);
  assert.match(entryForm, /状态：\{sourceLabel\(storedSource \?\? editing\.inboundSource\)\}/);
  assert.match(fields, /checked=\{isUnspecified\}/);
  assert.match(fields, /aria-label="选择无"/);
  assert.match(stocksRoute, /\.\.\.pricing, inboundSource: before\.inboundSource/);
});

test("monthly storage fee uses one continuous free-rent window", () => {
  const february = calculateStorageFeeForPeriod({
    inboundDate: "2026-01-29",
    fromMonth: "2026-02",
    toMonth: "2026-02",
    today: "2026-03-01",
    billingMode: "item",
    quantity: 10,
    itemVolumeM3: 0.1,
    rateUsdM3Day: 0.7,
    freeDays: 5,
  });
  assert.equal(february.periodStart, "2026-02-01");
  assert.equal(february.periodEndExclusive, "2026-03-01");
  assert.equal(february.chargeStartDate, "2026-02-03");
  assert.equal(february.periodStorageDays, 28);
  assert.equal(february.periodBillableDays, 26);
  assert.equal(february.periodFeeUsd, 18.2);

  const stillFree = calculateStorageFeeForPeriod({
    inboundDate: "2026-01-29",
    fromMonth: "2026-01",
    toMonth: "2026-01",
    today: "2026-03-01",
    billingMode: "item",
    quantity: 10,
    itemVolumeM3: 0.1,
    rateUsdM3Day: 0.7,
    freeDays: 5,
  });
  assert.equal(stillFree.periodStorageDays, 3);
  assert.equal(stillFree.periodBillableDays, 0);
  assert.equal(stillFree.periodFeeUsd, 0);
});

test("customer pricing keeps zero as a valid rate and applies free-rent days from inbound", () => {
  const profile = parseCustomerPricingProfile(JSON.stringify({
    customerName: " QT ",
    ratePerM3Day: 0,
    freeDays: 30,
  }));
  const profiles = new Map([[profile.customerName, profile]]);
  const effective = effectiveCustomerPricing({
    customerName: "QT",
    inboundDate: "2026-07-20",
    recordRatePerM3Day: 0.7,
    recordFreeDays: 3,
    profiles,
  });
  assert.equal(customerPricingKey(" QT "), "pricing_customer_override:QT");
  assert.equal(effective.ratePerM3Day, 0);
  assert.equal(effective.freeDays, 30);
  assert.equal(effective.customerFreeDaysOverride, 30);
  assert.equal(effective.customerPricingApplied, true);
  const zeroFreeDays = effectiveCustomerPricing({
    customerName: "QT",
    inboundDate: "2026-07-20",
    recordRatePerM3Day: 0.7,
    recordFreeDays: 9,
    profiles: new Map([["QT", parseCustomerPricingProfile(JSON.stringify({ customerName: "QT", freeDays: 0 }))]]),
  });
  assert.equal(zeroFreeDays.freeDays, 0);
  assert.equal(zeroFreeDays.customerFreeDaysOverride, 0);

  const august = calculateStorageFeeForPeriod({
    inboundDate: "2026-07-20",
    fromMonth: "2026-08",
    toMonth: "2026-08",
    today: "2026-09-01",
    quantity: 1,
    itemVolumeM3: 1,
    rateUsdM3Day: 1,
    freeDays: effective.freeDays,
  });
  assert.equal(august.chargeStartDate, "2026-08-19");
  assert.equal(august.periodBillableDays, 13);
});

test("monthly storage fee respects outbound, leap-year, today, and invalid-period boundaries", () => {
  const outbound = calculateStorageFeeForPeriod({
    inboundDate: "2026-01-01",
    endDateExclusive: "2026-02-10",
    fromMonth: "2026-02",
    toMonth: "2026-02",
    today: "2026-03-01",
    billingMode: "box",
    boxes: 2,
    boxVolumeM3: 0.5,
    rateUsdM3Day: 1,
    freeDays: 0,
  });
  assert.equal(outbound.periodStorageDays, 9);
  assert.equal(outbound.periodBillableDays, 9);
  assert.equal(outbound.periodFeeUsd, 9);

  const leapYear = calculateStorageFeeForPeriod({
    inboundDate: "2028-02-01",
    fromMonth: "2028-02",
    toMonth: "2028-02",
    today: "2028-03-01",
    quantity: 1,
    itemVolumeM3: 1,
    rateUsdM3Day: 1,
  });
  assert.equal(leapYear.periodStorageDays, 29);

  const currentMonth = calculateStorageFeeForPeriod({
    inboundDate: "2026-01-01",
    fromMonth: "2026-08",
    toMonth: "2026-08",
    today: "2026-08-26",
    quantity: 1,
    itemVolumeM3: 1,
    rateUsdM3Day: 1,
  });
  assert.equal(currentMonth.periodEndExclusive, "2026-08-26");
  assert.equal(currentMonth.periodStorageDays, 25);

  const sameDay = calculateStorageFeeForPeriod({
    inboundDate: "2026-08-20",
    endDateExclusive: "2026-08-20",
    fromMonth: "2026-08",
    toMonth: "2026-08",
    today: "2026-08-26",
    quantity: 1,
    itemVolumeM3: 1,
    rateUsdM3Day: 1,
  });
  assert.equal(sameDay.periodStorageDays, 0);
  assert.equal(sameDay.periodBillableDays, 0);
  assert.equal(sameDay.periodFeeUsd, 0);

  assert.throws(
    () => resolveStorageBillingPeriod({ fromMonth: "2026-09", toMonth: "2026-08", today: "2026-08-26" }),
    InvalidStorageBillingPeriodError,
  );
  assert.throws(
    () => resolveStorageBillingPeriod({ fromMonth: "2026-13", toMonth: "2026-13", today: "2026-08-26" }),
    InvalidStorageBillingPeriodError,
  );
  assert.throws(
    () => resolveStorageBillingPeriod({ fromMonth: "1969-12", toMonth: "1969-12", today: "2026-08-26" }),
    InvalidStorageBillingPeriodError,
  );
});

test("pricing workspace exposes a unified monthly list and separate customer and product columns", async () => {
  const [workspace, styles, reportRoute, exportRoute, report, customerSettingsRoute] = await Promise.all([
    readFile(new URL("../components/PricingWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/PricingWorkspace.module.css", import.meta.url), "utf8"),
    readFile(new URL("../app/api/pricing/report/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/pricing/report/export/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/storage-fee-report.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/pricing/customer-settings/route.ts", import.meta.url), "utf8"),
  ]);
  assert.equal((workspace.match(/type="month"/g) ?? []).length, 2);
  assert.match(workspace, /fromMonth: period\.fromMonth/);
  assert.match(workspace, /toMonth: period\.toMonth/);
  assert.match(workspace, /\["in_stock", "在库"\]/);
  assert.match(workspace, /\["outbound", "已出库"\]/);
  assert.match(workspace, /<th>客户<\/th>\s*<th>SKU<\/th><th>产品条形码<\/th><th>产品名称<\/th>/);
  assert.doesNotMatch(workspace, /<th>客户 \/ 产品<\/th>/);
  assert.match(workspace, /periodFeeUsd/);
  assert.match(workspace, /生成本期\{exportScopeLabel\}账单Excel/);
  assert.match(workspace, /pendingInvoiceCount/);
  assert.match(workspace, /invoiceEligibleRows\.length === 0/);
  assert.match(workspace, /待确认出库将列入未确认工作表/);
  assert.match(workspace, /row\.inventoryStatus === "in_stock" \|\| row\.settlementStatus === "settled"/);
  assert.match(workspace, /本期可出账金额/);
  assert.match(workspace, /customerPricing: "1"/);
  assert.match(workspace, /REPORT_PREVIEW_LIMIT = 20/);
  assert.match(workspace, /displayedPricingProducts\.map/);
  assert.match(workspace, /aria-controls="monthly-report-body"/);
  assert.match(workspace, /<tbody id="monthly-report-body">/);
  assert.match(workspace, /<span>免租天数<\/span>/);
  assert.match(workspace, /<span>免租天数<\/span>[\s\S]*?type="number"[\s\S]*?step="1"/);
  assert.match(workspace, /例如填30天，前30天不计费，第31天起计费/);
  assert.doesNotMatch(workspace, /免租日期|免租截止日期/);
  assert.match(exportRoute, /"免租天数"/);
  assert.doesNotMatch(exportRoute, /免租日期|免租截止日期/);
  assert.match(exportRoute, /"账期计算开始"/);
  assert.match(workspace, /保存客户规则/);
  assert.equal((workspace.match(/styles\.monthlyCellContent/g) ?? []).length, 11);
  assert.match(styles, /\.monthlyTable/);
  assert.match(styles, /data-label/);
  assert.match(styles, /\.monthlyCellContent\s*\{[\s\S]*?min-width:\s*0;[\s\S]*?overflow-wrap:\s*anywhere;/);
  assert.match(styles, /\.exportNote/);
  assert.match(styles, /\.customerRuleEditor/);
  assert.match(styles, /\.collapseButton/);
  assert.match(workspace, /单独编辑出库计价/);
  assert.match(workspace, /编辑在库货物体积/);
  assert.match(workspace, /stocksEndpoint = "\/api\/stocks"/);
  assert.match(workspace, /volumePerUnitM3: draft\.volumePerUnitM3/);
  assert.match(workspace, /每箱体积（m³）/);
  assert.match(workspace, /每件体积（m³）/);
  assert.match(workspace, /计价出库日期/);
  assert.match(workspace, /每日每立方米价格/);
  assert.match(workspace, /整段确认总价/);
  assert.match(workspace, /批量确认出库计价/);
  assert.match(workspace, /批量取消出库计价/);
  assert.match(workspace, /真实出库记录和库存不会改变/);
  assert.match(workspace, /const targets = pendingRows\.filter/);
  assert.match(workspace, /settlementStatus: "pending"/);
  assert.match(workspace, /settlementStatus: "history"/);
  assert.match(workspace, /待处理出库计价/);
  assert.match(workspace, /计价操作记录/);
  assert.match(workspace, /aria-expanded=\{historyExpanded\}/);
  assert.match(workspace, /aria-controls="pricing-operation-history"/);
  assert.match(workspace, /已确认 \{settledRows\.length\} · 已取消 \{cancelledRows\.length\}/);
  assert.match(workspace, /撤销取消/);
  assert.match(workspace, /method: "PATCH" \| "POST" \| "DELETE" \| "PUT"/);
  assert.match(workspace, /for \(const row of targets\)/);
  assert.match(workspace, /已成功 \$\{succeeded\} 条，失败 \$\{failures\.length\} 条/);
  assert.match(styles, /\.settlementToolbar/);
  assert.match(styles, /\.settlementModal/);
  assert.match(reportRoute, /fromMonth: params\.has\("fromMonth"\)/);
  assert.match(reportRoute, /inventoryStatus: params\.get\("inventoryStatus"\)/);
  assert.match(report, /inventoryStatus: "in_stock"/);
  assert.match(report, /inventoryStatus: inStockAtCutoff \? "in_stock" : "outbound"/);
  assert.match(report, /periodCalc\.periodFeeUsd/);
  assert.match(report, /const hasBillingPeriod = input\.fromMonth !== undefined \|\| input\.toMonth !== undefined/);
  assert.match(report, /await db\.batch\(batchTuple\(/);
  assert.match(report, /customerSettingsResult/);
  assert.match(report, /const applyCustomerPricing = hasBillingPeriod && input\.applyCustomerPricing === true/);
  assert.match(report, /profiles: inStockAtCutoff \? profiles : new Map\(\)/);
  assert.match(report, /settlement\.settlementStatus === "cancelled" \? "cancelled" : "settled"/);
  assert.match(report, /if \(filter === "all"\) return status !== "cancelled"/);
  assert.match(report, /if \(filter === "history"\) return status === "settled" \|\| status === "cancelled"/);
  assert.match(report, /const activeRows = rows\.filter\(row => row\.settlementStatus !== "cancelled"\)/);
  assert.match(report, /billableDays: inStockAtCutoff \? cutoffCalc\.billableDays : settlement\.billableDays/);
  assert.match(report, /feeUsd: chargeable \? \(inStockAtCutoff \? cutoffCalc\.feeUsd : settlement\.feeUsd\) : 0/);
  assert.match(report, /else if \(outboundDate > asOf && !inStockAtCutoff\)/);
  assert.doesNotMatch(report, /periodStorageDays\s*>\s*0/);
  assert.match(exportRoute, /"在库仓储费"/);
  assert.match(exportRoute, /"已出库仓储费"/);
  assert.match(exportRoute, /"客户账单明细"/);
  assert.match(exportRoute, /每一行对应一个具体产品\/批次/);
  assert.match(exportRoute, /applyCustomerPricing: hasBillingPeriod/);
  assert.match(exportRoute, /report\.inStockItems/);
  assert.match(exportRoute, /report\.outboundItems/);
  assert.match(exportRoute, /report\.outboundItems\.filter\(row => row\.settlementStatus === "settled"\)/);
  assert.match(exportRoute, /excludedPendingRows/);
  assert.match(exportRoute, /const invoiceRows = \[\.\.\.inStockRows, \.\.\.outboundRows\]/);
  assert.match(exportRoute, /if \(hasBillingPeriod && customers.length === 0\)/);
  assert.match(exportRoute, /if \(hasBillingPeriod && invoiceRows\.length === 0 && excludedPendingRows\.length === 0 && missingBasisRows\.length===0\)/);
  assert.match(exportRoute, /report\.summary\.inventoryStatus !== "outbound"/);
  assert.match(exportRoute, /report\.summary\.inventoryStatus !== "in_stock"/);
  assert.match(exportRoute, /待确认未计入正式账单记录数/);
  assert.match(exportRoute, /const hasBillingPeriod = params\.has\("fromMonth"\) \|\| params\.has\("toMonth"\)/);
  assert.match(exportRoute, /status: hasBillingPeriod \? params\.get\("status"\) \|\| undefined : "settled"/);
  assert.match(exportRoute, /inventoryStatus: hasBillingPeriod \? params\.get\("inventoryStatus"\) \|\| undefined : "outbound"/);
  assert.match(exportRoute, /settled-storage-fees-\$\{report\.summary\.asOf\}\.xlsx/);
  assert.match(customerSettingsRoute, /requireUser\(request,"pricing.manage"\)/);
  assert.match(customerSettingsRoute, /ratePerM3Day === null/);
  assert.match(customerSettingsRoute, /Number\.isSafeInteger\(freeDays\)/);
  assert.doesNotMatch(customerSettingsRoute, /freeUntilDate/);
  assert.match(customerSettingsRoute, /saveAuditedPricingSetting/);
});

test("saving a renamed catalog product keeps the selected return source", async () => {
  const [page, entryForm, stocksRoute] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/StockEntryForm.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/stocks/route.ts", import.meta.url), "utf8"),
  ]);
  const stockSync = page.match(/useEffect\(\(\)=>\{if\(stockDirty\.current\)return;.*?\},\[selected,physicalStocks\]\);/)?.[0] ?? "";
  const saveStock = page.match(/const saveStock=withWarehouseMutation\(async\(messageDraft\?:MessageInboundDraft\):Promise<\{ok:boolean;error\?:string\}>=>\{[\s\S]*?\r?\n \}\);(?=\r?\n const newStock)/)?.[0] ?? "";
  assert.ok(stockSync);
  assert.ok(saveStock);
  assert.doesNotMatch(stockSync, /setStockSourceSelection/);
  assert.doesNotMatch(saveStock, /setStockSourceSelection\("unspecified"\)/);
  assert.match(saveStock, /setStockSourceSelection\(d\.stock\.inboundSource\)/);
  assert.match(page, /identityChanged&&patch\.catalogItemId===undefined\?\{catalogItemId:null\}:\{\}/);
  assert.match(entryForm, /changeEditing\(\{inboundSource:source\}\)/);
  assert.match(entryForm, /onSourceSelectionChange\?\.\(source\)/);
  assert.match(page, /<StockDetailsPanel value=\{editing\} onChange=\{changeEditing\}/);
  assert.match(stocksRoute, /field\(payload, "inboundSource", "sourceType"\) \?\? before\?\.inboundSource/);
});

test("new returns stay item billed while explicit legacy box records remain compatible", async () => {
  const [page, entryForm, styles] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/StockEntryForm.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/multi-stock.css", import.meta.url), "utf8"),
  ]);
  assert.equal(billingModeForAvailableStock("item", 0, 40), "box");
  assert.equal(billingModeForAvailableStock("box", 74, 0), "item");
  assert.equal(billingModeForAvailableStock("box", 74, 13), "box");
  assert.doesNotMatch(page, /billingModeForAvailableStock/);
  assert.doesNotMatch(entryForm, /billingModeForAvailableStock/);
  assert.doesNotMatch(entryForm, /ReturnPricingFields/); // Financial mode is retained server-side, not edited while receiving.
  assert.doesNotMatch(page, /returnPricingError/); // Missing dimensions cannot block physical receiving.
  assert.match(page, /const fail=\(message:string\)=>\{setNotice\(message\);if\(!messageDraft\)setStockSaveFeedback\(\{tone:"error",text:message\}\);return \{ok:false,error:message\}\}/);
  assert.match(page, /保存成功，当前状态：\$\{sourceStatusLabel\(d\.stock\.inboundSource\)\}/);
  assert.match(page, /catch\{return fail\("保存失败，请检查网络后重试，当前填写仍保留"\)\}/);
  assert.match(page, /if\(!r\.ok\|\|!d\.stock\)return fail\(d\.error\|\|"保存失败，内容仍保留"\)/);
  assert.match(page, /finally\{setSaving\(false\)\}/);
  assert.match(page, /className=\{`stock-save-feedback \$\{stockSaveFeedback\.tone\}`\}/);
  assert.match(styles, /\.stock-save-feedback\.error/);
});

test("latest warehouse operation follows the full movement history", async () => {
  const [page, movementsRoute] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/movements/route.ts", import.meta.url), "utf8"),
  ]);
  const reader = await readFile(new URL("../lib/warehouse-sync-read.ts", import.meta.url), "utf8");
  assert.match(page, /const loadRecent=load/);
  assert.match(page, /fetch\("\/api\/sync\?"/);
  assert.match(reader, /'入库','出库','移库','库存修改','删除','恢复'/);
  assert.match(reader, /ORDER BY id DESC LIMIT 1/);
  assert.doesNotMatch(reader, /operationsOnly|count\(\*\)/i);
  assert.match(page, /const canUndoRecent=.*recentMovement\.action!=="恢复".*recentMovement\.action!=="删除"\|\|canDeleteInventory/);
  assert.match(page, /\{canUndoRecent&&<button onClick=\{undoRecent\}/);
  assert.match(page, /recentMovement\?\.action==="库存修改"\?"update"/);
  assert.match(page, /movementInventoryDetails\(recentMovement,allowed\("pricing.manage"\)\)/);
  assert.match(page, /className="recent-pricing"/);
  assert.match(movementsRoute, /\["入库","出库","移库","库存修改","删除","恢复","箱件收货","箱件出库","箱件认领改单","箱件删除","撤销箱件操作"\]/);
  assert.match(movementsRoute, /hasPermission\(a\.user!,"pricing.manage"\)\?logs:logs\.map/);
  assert.match(movementsRoute, /redactMovementSnapshotPricing\(log\.beforeSnapshot\)/);
  assert.match(movementsRoute, /return Response\.json\(\{logs:visibleLogs/);
});

test("saving an existing stock is a correction while outbound stays explicit", async () => {
  const route = await readFile(new URL("../app/api/stocks/route.ts", import.meta.url), "utf8");
  const postStart = route.indexOf("export async function POST");
  const deleteStart = route.indexOf("export async function DELETE");
  const patchStart = route.indexOf("export async function PATCH");
  const postHandler = route.slice(postStart, deleteStart);
  const deleteHandler = route.slice(deleteStart, patchStart);
  const patchHandler = route.slice(patchStart);

  assert.ok(postStart >= 0 && deleteStart > postStart && patchStart > deleteStart);
  assert.match(postHandler, /const action = before \? "库存修改" : "入库"/);
  assert.match(postHandler, /库存校正/);
  assert.match(postHandler, /数量 \$\{before\.totalQuantity\}→\$\{value\.totalQuantity\}/);
  assert.match(postHandler, /return Response\.json\(redactWarehousePricing\(\{ stock:projected, settlement: null,dateDisplayOnly:goods\.dateDisplayOnly \},auth\.user!\)\)/);
  assert.doesNotMatch(postHandler, /settlementValue\(/);
  assert.doesNotMatch(postHandler, /insert\(storageFeeSettlements\)/);
  assert.match(deleteHandler, /settlementValue\(/);
  assert.match(deleteHandler, /auditValue\([\s\S]*?"出库"/);
  assert.match(patchHandler, /settlementValue\(/);
  assert.match(patchHandler, /auditValue\([\s\S]*?"出库"/);
});

test("warehouse quantity fields hide spinners and ignore focused wheel changes", async () => {
  const [page, entryForm, styles] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/StockEntryForm.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/multi-stock.css", import.meta.url), "utf8"),
  ]);
  const formGrid = entryForm.match(/<div className="form-grid">([\s\S]*?)<\/div><div className="stock-layer-field">/)?.[1] ?? "";

  assert.equal((formGrid.match(/type="number"/g) ?? []).length, 2);
  assert.equal((page.match(/className="warehouse-number-input"/g) ?? []).length, 2);
  assert.equal((entryForm.match(/className="warehouse-number-input"/g) ?? []).length, 3);
  assert.equal((page.match(/onWheel=\{suppressNumberWheel\}/g) ?? []).length, 2);
  assert.equal((entryForm.match(/onWheel=\{suppressNumberWheel\}/g) ?? []).length, 3);
  assert.match(page, /const suppressNumberWheel=.*document\.activeElement===event\.currentTarget.*event\.currentTarget\.blur\(\)/s);
  assert.match(entryForm, /const suppressNumberWheel = .*document\.activeElement === event\.currentTarget.*event\.currentTarget\.blur\(\)/);
  assert.match(formGrid, /<label>总数量<input className="warehouse-number-input" type="number"[^>]*onWheel=\{suppressNumberWheel\}/);
  assert.match(formGrid, /<label>总箱数<input className="warehouse-number-input" type="number"[^>]*onWheel=\{suppressNumberWheel\}/);
  assert.match(entryForm, /<label>存放层数<input className="warehouse-number-input" type="number"[^>]*onWheel=\{suppressNumberWheel\}/);
  assert.match(await readFile(new URL("../components/LocationCapacityCard.tsx", import.meta.url), "utf8"), /最大层数<input type="text" inputMode="numeric"/);
  assert.match(page, /本次出库件数<input autoFocus className="warehouse-number-input" type="number"[^>]*onWheel=\{suppressNumberWheel\}/);
  assert.match(page, /本次出库箱数<input className="warehouse-number-input" type="number"[^>]*onWheel=\{suppressNumberWheel\}/);
  assert.match(styles, /\.warehouse-number-input\[type="number"\]\{appearance:textfield;-moz-appearance:textfield\}/);
  assert.match(styles, /::-webkit-inner-spin-button/);
  assert.match(styles, /::-webkit-outer-spin-button/);
  assert.match(styles, /-webkit-appearance:none/);
  assert.doesNotMatch(styles, /(^|\})input\[type="number"\]/m);
});

test("monthly pricing rows use compact groups without desktop horizontal scrolling", async () => {
  const [workspace, styles] = await Promise.all([
    readFile(new URL("../components/PricingWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/PricingWorkspace.module.css", import.meta.url), "utf8"),
  ]);
  assert.match(styles, /\.monthlyTable\s*\{[\s\S]*?min-width:\s*0;[\s\S]*?table-layout:\s*fixed;[\s\S]*?width:\s*100%;/);
  assert.doesNotMatch(styles, /\.monthlyTable\s*\{[^}]*max-content;/);
  assert.match(styles, /\.compactStack,[\s\S]*?display:\s*grid;/);
  assert.match(styles, /\.priceGrid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(workspace, /<th>计费日 \/ 在库天数<\/th>/);
  assert.match(workspace, /<th>计费价格<\/th>/);
  assert.doesNotMatch(workspace, /<th>本期费用<\/th>/);
  assert.match(workspace, /styles\.compactStack/);
  assert.match(workspace, /styles\.priceGrid/);
  const tablet = styles.slice(styles.indexOf("@media (max-width: 1200px)"), styles.indexOf("@media (max-width: 900px)"));
  assert.match(tablet, /\.monthlyTable\s*\{[\s\S]*?display:\s*block;[\s\S]*?width:\s*100%;/);
  assert.match(tablet, /\.monthlyTable colgroup\s*\{\s*display:\s*none;/);
  assert.match(tablet, /\.monthlyTable thead\s*\{\s*display:\s*none;/);
  const mobile = styles.slice(styles.indexOf("@media (max-width: 760px)"));
  assert.doesNotMatch(mobile, /\.monthlyTable\s*\{[^}]*max-content;/);
});

test("manual return dimensions reset with catalog selection and clear incomplete volume", async () => {
  const fields = await readFile(new URL("../components/ReturnPricingFields.tsx", import.meta.url), "utf8");
  assert.match(fields, /setCatalogRevision\(\(current\) => current \+ 1\)/);
  assert.match(fields, /key=\{`\$\{String\(catalogPickerKey\)\}:\$\{value\.pricingCatalogId \?\? "none"\}:\$\{catalogRevision\}`\}/);
  assert.match(fields, /const volumeM3 = dimensionsToVolume[\s\S]*?onVolume\(volumeM3\);/);
  assert.doesNotMatch(fields, /if \(volumeM3 > 0\) onVolume/);
});

test("manual dimension calculator supports cm and inch without conversion drift", () => {
  assert.equal(dimensionsToVolume(10, 20, 30), 0.006);
  assert.equal(dimensionsToVolume(10, 20, 30, "inch"), 0.09832238);
  assert.equal(dimensionsToVolume(1, 1, 1, "inch"), 0.00001639);
  assert.equal(dimensionsToVolume(0, 20, 30, "cm"), 0);
  const centimeters = dimensionToCentimeters(12.345678, "inch");
  assert.equal(dimensionFromCentimeters(centimeters, "inch"), 12.345678);
});

test("latest operation details preserve privacy and avoid outbound snapshot guesses", () => {
  const stock = {
    inboundSource: "return", billingMode: "item", itemVolumeM3: 0.0043, boxVolumeM3: 0.043,
    storageRateUsd: 0.7, freeDays: 5, layerCount: 3,
  };
  const movement = {
    id: 1, userName: "员工", action: "入库", entityId: "A1", summary: "", createdAt: "2026-08-08T00:00:00.000Z",
    beforeSnapshot: null, afterSnapshot: JSON.stringify(stock),
  };
  assert.equal(movementInventoryDetails(movement), "退货 · 按件 · 0.0043 m³/件 · 3 层");
  assert.equal(movementInventoryDetails(movement, true), "退货 · 按件 · 0.0043 m³/件 · $0.70/m³/天 · 免租 5 天 · 3 层");

  const transfer = { ...movement, action: "移库", afterSnapshot: JSON.stringify({ kind: "stock-transfer", rows: [stock] }) };
  assert.equal(movementInventoryDetails(transfer), "退货 · 按件 · 0.0043 m³/件 · 3 层");

  const partialTransfer = {
    ...movement,
    action: "移库",
    afterSnapshot: JSON.stringify({
      kind: "stock-transfer",
      targetLocation: "B16",
      rows: [
        { ...stock, locationCode: "A1", layerCount: 2 },
        { ...stock, locationCode: "B16", layerCount: 1 },
      ],
    }),
  };
  assert.equal(movementInventoryDetails(partialTransfer), "退货 · 按件 · 0.0043 m³/件 · 1 层");

  const outbound = { ...movement, action: "出库", afterSnapshot: "null", beforeSnapshot: JSON.stringify(stock) };
  assert.equal(movementInventoryDetails(outbound, true), "");

  const legacy = { ...movement, afterSnapshot: "{broken", beforeSnapshot: JSON.stringify({ layerCount: 2 }) };
  assert.equal(movementInventoryDetails(legacy, true), "2 层");

  const redacted = JSON.parse(redactMovementSnapshotPricing(JSON.stringify({ ...stock, nested: { storageRateUsd: 8, freeDays: 30, layerCount: 4 } })));
  assert.equal(redacted.storageRateUsd, undefined);
  assert.equal(redacted.freeDays, undefined);
  assert.equal(redacted.nested.storageRateUsd, undefined);
  assert.equal(redacted.nested.freeDays, undefined);
  assert.equal(redacted.inboundSource, "return");
  assert.equal(redacted.itemVolumeM3, 0.0043);
  assert.equal(redacted.layerCount, 3);
  assert.equal(redacted.nested.layerCount, 4);
  assert.equal(redactMovementSnapshotPricing("{broken"), null);
});

test("catalog list no longer emits SQLite ORDER BY 0", async () => {
  const route = await readFile(new URL("../app/api/pricing/catalog/route.ts", import.meta.url), "utf8");
  assert.doesNotMatch(route, /sql<number>`0`/);
  assert.match(route, /const rows = q[\s\S]*asc\(pricingCatalogItems\.product\)/);
});

test("pricing workbook import stays below the safe D1 batch size", async () => {
  const client = await readFile(new URL("../lib/pricing-workbook-client.ts", import.meta.url), "utf8");
  const route = await readFile(new URL("../app/api/pricing/catalog/import/route.ts", import.meta.url), "utf8");
  assert.match(client, /IMPORT_BATCH_SIZE = 30/);
  assert.match(route, /MAX_IMPORT_BATCH_SIZE = 30/);
});

test("five-column OMS row parses without SKU", () => {
  const parsed = prepareCatalogRow({
    "Customer/客户": "示例商家-DH(8003004)",
    "Product Name/产品名称": "自行车充气泵-BL10-A",
    "OMS Length/OMS长": "1.969",
    "OMS Width/OMS宽": "1.339",
    "OMS Height/OMS高": "2.992",
  }, 0.7);

  assert.ok(parsed);
  assert.equal(parsed.customerName, "示例商家-DH(8003004)");
  assert.equal(parsed.partnerName, "示例商家-DH(8003004)");
  assert.equal(parsed.productName, "自行车充气泵-BL10-A");
  assert.equal(parsed.sku, "");
  assert.deepEqual(
    [parsed.itemLengthCm, parsed.itemWidthCm, parsed.itemHeightCm],
    [5.0013, 3.4011, 7.5997],
  );
  assert.equal(parsed.itemVolumeM3, 0.00012927);
  assert.equal(parsed.ratePerM3Day, 0.7);
});

test("partial OMS-looking row is not treated as OMS without SKU", () => {
  const ordinary = {
    "Product Name/产品名称": "普通目录货物",
    "OMS Length/OMS长": "10",
    "宽度": "20",
    "高度": "30",
  };

  assert.strictEqual(prepareCatalogRow(ordinary, 0.7), ordinary);
});

test("legacy SKU-based OMS recognition remains compatible", () => {
  const parsed = prepareCatalogRow({
    SKU: "LEGACY-001",
    "Product Name/产品名称": "旧格式目录货物",
    "OMS Length/OMS长": "10",
  }, 0.7);

  assert.ok(parsed);
  assert.equal(parsed.sku, "LEGACY-001");
  assert.equal(parsed.productName, "旧格式目录货物");
});

test("catalog clear is confirmed, soft, and excluded from normal export", async () => {
  const [clearRoute, exportRoute] = await Promise.all([
    readFile(new URL("../app/api/pricing/catalog/clear/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/pricing/catalog/export/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(clearRoute, /requireUser\(request,"pricing.manage"\)/);
  assert.match(clearRoute, /CLEAR_ACTIVE_CATALOG/);
  assert.match(clearRoute, /update\(pricingCatalogItems\)[\s\S]*active: 0/);
  assert.doesNotMatch(clearRoute, /delete\(pricingCatalogItems\)/);
  assert.match(exportRoute, /where\(eq\(pricingCatalogItems\.active, 1\)\)/);
});

test("manual return settlement preserves history and uses optimistic updates", async () => {
  const [migration, schema, stocksRoute, settlementRoute, report, exportRoute, backups, movements] = await Promise.all([
    readFile(new URL("../drizzle/0008_manual_storage_settlement.sql", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/stocks/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/pricing/settlements/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/storage-fee-report.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/pricing/report/export/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/backups/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/movements/route.ts", import.meta.url), "utf8"),
  ]);

  assert.match(migration, /settlement_status.*DEFAULT 'settled'/);
  assert.match(migration, /settled_at.*created_at/);
  assert.match(schema, /settlementStatus: text\("settlement_status"\)/);
  assert.match(schema, /version: integer\("version"\)/);
  assert.match(stocksRoute, /settlementStatus: chargeable \? "pending" : "settled"/);
  assert.match(settlementRoute, /calculateStorageFee/);
  assert.match(settlementRoute, /eq\(storageFeeSettlements\.settlementStatus, "pending"\)/);
  assert.match(settlementRoute, /eq\(storageFeeSettlements\.version, identity\.version\)/);
  assert.match(settlementRoute, /settlementStatus: "settled"/);
  assert.match(settlementRoute, /outboundDate\?: unknown/);
  assert.match(settlementRoute, /feeUsd\?: unknown/);
  assert.match(settlementRoute, /volumePerUnitM3\?: unknown/);
  assert.match(settlementRoute, /item\.billingMode === "item" \? volumePerUnitM3 : item\.itemVolumeM3/);
  assert.match(settlementRoute, /item\.billingMode === "box" \? volumePerUnitM3 : item\.boxVolumeM3/);
  assert.match(settlementRoute, /outboundDate < item\.inboundDate\.slice\(0, 10\)/);
  assert.match(settlementRoute, /outboundDate > chinaTodayDate\(\)/);
  assert.match(settlementRoute, /"修改出库计价"/);
  assert.match(settlementRoute, /"确认出库计价"/);
  assert.match(settlementRoute, /取消出库计价/);
  assert.match(settlementRoute, /恢复出库计价/);
  assert.match(settlementRoute, /settlementStatus: "cancelled"/);
  assert.match(settlementRoute, /const restoredStatus = item\.settledAt \? "settled" : "pending"/);
  assert.match(settlementRoute, /export async function PUT/);
  assert.match(settlementRoute, /await db\.batch\(\[auditInsert, update\]\)/);
  assert.doesNotMatch(settlementRoute, /settlementStatus: "cancelled"[\s\S]{0,180}settledAt: null/);
  assert.doesNotMatch(settlementRoute, /delete\(storageFeeSettlements\)/);
  assert.doesNotMatch(settlementRoute, /\bstocks\b/);
  assert.match(report, /pendingItems: pendingRows/);
  assert.match(report, /cancelledItems: cancelledRows/);
  assert.match(report, /value === "pending" \|\| value === "settled" \|\| value === "cancelled" \|\| value === "history"/);
  assert.match(report, /if \(filter === "all"\) return status !== "cancelled"/);
  assert.match(report, /if \(filter === "history"\) return status === "settled" \|\| status === "cancelled"/);
  assert.match(exportRoute, /fromMonth: hasBillingPeriod && params\.has\("fromMonth"\)/);
  assert.match(exportRoute, /inventoryStatus: hasBillingPeriod \? params\.get\("inventoryStatus"\) \|\| undefined : "outbound"/);
  assert.match(exportRoute, /customers,/);
  assert.match(backups, /version:9/);
  assert.match(backups, /\[1,2,3,4,5,6,7,8,9\]/);
  assert.match(backups, /\["pending","settled","cancelled"\]\.includes/);
  assert.match(movements, /费用已经结算，不能恢复库存/);
  assert.match(movements, /eq\(storageFeeSettlements\.version,row\.version\)/);
  assert.match(movements, /inArray\(storageFeeSettlements\.settlementStatus,\["pending","cancelled"\]\)/);
  assert.match(movements, /guardedRestoreAuditUserId/);
  assert.match(movements, /出库计价状态刚刚发生变化，不能恢复库存/);
});

test("cancelled outbound pricing is archived, excluded from bills, and can be restored safely", async () => {
  const [settlementRoute, report, exportRoute, backups, movements, workspace, types] = await Promise.all([
    readFile(new URL("../app/api/pricing/settlements/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/storage-fee-report.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/pricing/report/export/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/backups/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/movements/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../components/PricingWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/pricing-types.ts", import.meta.url), "utf8"),
  ]);

  const authIndex = settlementRoute.indexOf('requireUser(request,"pricing.manage")');
  const deleteIndex = settlementRoute.indexOf("export async function DELETE");
  const deleteBodyIndex = settlementRoute.indexOf("request.json()", deleteIndex);
  const putIndex = settlementRoute.indexOf("export async function PUT");
  const putBodyIndex = settlementRoute.indexOf("request.json()", putIndex);
  assert.ok(authIndex >= 0);
  assert.ok(deleteIndex >= 0 && deleteBodyIndex > deleteIndex);
  assert.ok(putIndex >= 0 && putBodyIndex > putIndex);
  assert.match(settlementRoute, /item\.settlementStatus !== "pending" && item\.settlementStatus !== "settled"/);
  assert.match(settlementRoute, /eq\(storageFeeSettlements\.settlementStatus, item\.settlementStatus\)/);
  assert.match(settlementRoute, /eq\(storageFeeSettlements\.settlementStatus, "cancelled"\)/);
  assert.match(settlementRoute, /eq\(storageFeeSettlements\.version, identity\.version\)/);
  assert.match(settlementRoute, /cancel-pricing:/);
  assert.match(settlementRoute, /restore-pricing:/);
  assert.match(settlementRoute, /仅从计价队列归档，保留真实出库和库存记录/);
  assert.match(settlementRoute, /未改变真实出库和库存记录/);

  assert.match(report, /settlementStatus: "pending" \| "settled" \| "cancelled" \| null/);
  assert.match(report, /settlement\.settlementStatus === "cancelled" \? "cancelled" : "settled"/);
  assert.match(report, /const cancelledRows = outboundRows\.filter\(row => row\.settlementStatus === "cancelled"\)/);
  assert.match(report, /totalFeeUsd: roundedSum\(activeRows/);
  assert.match(report, /totalPeriodFeeUsd: roundedSum\(activeRows/);
  assert.match(exportRoute, /report\.outboundItems\.filter\(row => row\.settlementStatus === "settled"\)/);
  assert.doesNotMatch(exportRoute, /settlementStatus === "cancelled"[^\n]*invoiceRows/);
  assert.match(backups, /restoredSettlementStatus/);
  assert.match(backups, /"cancelled"/);

  assert.match(movements, /restorableSettlementCondition/);
  assert.match(movements, /returning\(\{id:storageFeeSettlements\.id\}\)/);
  assert.match(movements, /settlementDeleteIndex>=0&&!drizzleBatchHasRow/);
  assert.match(workspace, /const pendingRows = useMemo/);
  assert.match(workspace, /row\.settlementStatus === "settled" \|\| row\.settlementStatus === "cancelled"/);
  assert.match(workspace, /取消后从这里移除/);
  assert.match(workspace, /restoreCancelledSettlement/);
  assert.match(workspace, /恢复为“\$\{restoredLabel\}”/);
  assert.match(types, /settlementStatus: null \| "pending" \| "settled" \| "cancelled"/);
});

test("pricing Excel detail formulas use current header positions and keep cached values", async () => {
  const [XLSX, formulas] = await Promise.all([
    import("xlsx"),
    import("../lib/pricing-export-formulas.ts"),
  ]);
  const headers = [
    "计费数量", "计费方式", "账期仓储费USD", "件数", "总体积m³", "箱数",
    "日均仓储费USD", "费率USD/m³/天", "每件/箱立方米", "账期计费天数", "入库类型",
  ];
  const detailCells = formulas.buildDetailFormulaCells(headers, 2, {
    "计费数量": 4,
    "总体积m³": 2,
    "日均仓储费USD": 1.4,
    "账期仓储费USD": 14,
  });
  const totalValues = {
    "件数": 10,
    "箱数": 4,
    "计费数量": 4,
    "总体积m³": 2,
    "日均仓储费USD": 1.4,
    "账期仓储费USD": 14,
  };
  const totalCells = formulas.buildDetailTotalFormulaCells(headers, 2, 2, 3, totalValues);
  assert.equal(detailCells.A2.f, 'IF(B2="按箱",F2,D2)');
  assert.equal(detailCells.E2.f, "ROUND(A2*I2,8)");
  assert.equal(detailCells.G2.f, "ROUND(E2*H2,6)");
  assert.equal(detailCells.C2.f, 'IF(K2="退货入库",ROUND(E2*H2*J2,6),0)');
  assert.deepEqual(formulas.buildDetailTotalFormulaCells(headers, 2, 1, 2, totalValues), {});

  const sheet = XLSX.utils.aoa_to_sheet([
    headers,
    [4, "按箱", 14, 10, 2, 4, 1.4, 0.7, 0.5, 10, "退货入库"],
    [4, "", 14, 10, 2, 4, 1.4, "", "", "", ""],
  ]);
  Object.assign(sheet, detailCells, totalCells);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "公式验证");
  const file = XLSX.write(workbook, { type: "array", bookType: "xlsx" });
  const reopened = XLSX.read(file, { type: "array", cellFormula: true });
  const reopenedSheet = reopened.Sheets["公式验证"];
  assert.equal(reopenedSheet.A2.f, 'IF(B2="按箱",F2,D2)');
  assert.equal(reopenedSheet.A2.v, 4);
  assert.equal(reopenedSheet.E2.f, "ROUND(A2*I2,8)");
  assert.equal(reopenedSheet.E2.v, 2);
  assert.equal(reopenedSheet.C2.f, 'IF(K2="退货入库",ROUND(E2*H2*J2,6),0)');
  assert.equal(reopenedSheet.C2.v, 14);
  assert.equal(reopenedSheet.A3.f, "SUM(A2:A2)");
  assert.equal(reopenedSheet.A3.v, 4);
});
