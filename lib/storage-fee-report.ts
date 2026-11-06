import { asc, eq, like } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { getDb } from "../db";
import { auditLogs, goodsFlowState,goodsOperations, pricingCatalogItems, settings, stocks, storageFeeSettlements } from "../db/schema";
import { goodsBillingStocks,goodsChoices,parseGoodsState } from "./goods-flow";
import {parseAssociationState} from './inventory-associations';
import {validateCorrectionOperation} from './goods-correction';
import {
  CUSTOMER_PRICING_KEY_PREFIX,
  customerPricingProfiles,
  effectiveCustomerPricing,
} from "./customer-pricing";
import {
  calculateStorageFee,
  calculateStorageFeeForPeriod,
  chinaTodayDate,
  normalizeInboundSource,
  resolveStorageBillingPeriod,
} from "./pricing";

export type StorageFeeReportRow = {
  key: string;
  status: "open" | "pending" | "settled" | "cancelled" | "corrected";
  inventoryStatus: "in_stock" | "outbound" | "corrected";
  settlementStatus: "pending" | "settled" | "cancelled" | null;
  stockId: number;
  settlementId: number | null;
  locationCode: string;
  inboundSource: "domestic" | "return" | "unspecified";
  chargeable: boolean;
  pricingReview?: boolean;
  pricingReviewReason?: string;
  billingMode: "item" | "box";
  productName: string;
  currentProductKey?:string;
  currentProductName?:string;
  sku: string;
  fnsku: string;
  barcode: string;
  inboundOrder: string;
  note: string;
  customerName: string;
  inboundDate: string;
  endDate: string;
  quantity: number;
  boxes: number;
  count: number;
  itemVolumeM3: number;
  boxVolumeM3: number;
  volumePerCountM3: number;
  totalVolumeM3: number;
  ratePerM3Day: number;
  freeDays: number;
  customerRateOverride: number | null;
  customerFreeDaysOverride: number | null;
  customerPricingApplied: boolean;
  storageDays: number;
  billableDays: number;
  feeUsd: number;
  periodStart: string;
  periodEndExclusive: string;
  periodStorageDays: number;
  periodBillableDays: number;
  chargeStartDate: string;
  periodFeeUsd: number;
  settledAt: string | null;
  settledBy: string;
  version: number;
};

export type StorageFeeReportInput = {
  asOf?: string;
  fromMonth?: string;
  toMonth?: string;
  source?: string;
  q?: string;
  status?: string;
  settlementStatus?: string;
  inventoryStatus?: string;
  customer?: string;
  customers?: string[];
  applyCustomerPricing?: boolean;
};

function normalizeInventoryStatus(value: string | undefined) {
  if (["open", "in_stock", "in-stock", "current"].includes(value || "")) return "in_stock" as const;
  if (["outbound", "out", "closed"].includes(value || "")) return "outbound" as const;
  if(value==='corrected')return 'corrected' as const;
  return "all" as const;
}

function normalizeSettlementStatus(value: string | undefined) {
  if (value === "pending" || value === "settled" || value === "cancelled" || value === "history") return value;
  return "all" as const;
}

function includesSettlementStatus(
  filter: ReturnType<typeof normalizeSettlementStatus>,
  status: Exclude<StorageFeeReportRow["settlementStatus"], null>,
) {
  if (filter === "all") return status !== "cancelled";
  if (filter === "history") return status === "settled" || status === "cancelled";
  return filter === status;
}

const roundedSum = (rows: StorageFeeReportRow[], field: "totalVolumeM3" | "feeUsd" | "periodFeeUsd", digits: number) =>
  Number(rows.reduce((sum, row) => sum + row[field], 0).toFixed(digits));

const batchTuple = (queries: BatchItem<"sqlite">[]) => queries as [
  BatchItem<"sqlite">,
  ...BatchItem<"sqlite">[],
];

function chargeStartDate(inboundDate: string, freeDays: number) {
  const [year, month, day] = inboundDate.slice(0, 10).split("-").map(Number);
  if (![year, month, day].every(Number.isFinite)) return "";
  return new Date(Date.UTC(year, month - 1, day) + Math.max(0, Math.floor(freeDays)) * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

function openStockTouchesPeriod(inboundDate: string, period: {
  periodStart: string;
  requestedPeriodEndExclusive: string;
}, today: string) {
  return period.periodStart <= today
    && inboundDate < period.requestedPeriodEndExclusive
    && inboundDate <= today;
}

function outboundStockTouchesPeriod(inboundDate: string, outboundDate: string, period: {
  periodStart: string;
  requestedPeriodEndExclusive: string;
}, today: string) {
  return period.periodStart <= today
    && inboundDate < period.requestedPeriodEndExclusive
    && outboundDate >= period.periodStart;
}

export async function buildStorageFeeReport(input: StorageFeeReportInput = {}) {
  const today = chinaTodayDate();
  const requestedAsOf = /^\d{4}-\d{2}-\d{2}$/.test(input.asOf || "") ? input.asOf! : today;
  const asOf = requestedAsOf > today ? today : requestedAsOf;
  const hasBillingPeriod = input.fromMonth !== undefined || input.toMonth !== undefined;
  const period = hasBillingPeriod
    ? resolveStorageBillingPeriod({ fromMonth: input.fromMonth, toMonth: input.toMonth, today: asOf })
    : {
        fromMonth: "",
        toMonth: "",
        periodStart: "",
        periodEndExclusive: asOf,
        requestedPeriodEndExclusive: asOf,
      };
  const source = input.source === "domestic" || input.source === "return" ? input.source : "all";
  const legacyStatus = input.status === "open" || input.status === "pending" || input.status === "settled" || input.status === "cancelled" || input.status === "history"
    ? input.status
    : "all";
  const inventoryStatus = normalizeInventoryStatus(input.inventoryStatus ?? (legacyStatus === "open" ? "open" : undefined));
  const settlementStatus = normalizeSettlementStatus(input.settlementStatus ?? (legacyStatus !== "open" ? legacyStatus : undefined));
  const customers = [...new Set((input.customers ?? [input.customer || ""]).map(name => name.trim()).filter(Boolean))];
  const customer = customers.join("、");
  const q = (input.q || "").trim().toLowerCase();
  // Customer rules are a monthly invoice layer. They must never rewrite the
  // stock/settlement snapshots. Historical cutoff projections are read-only.
  const applyCustomerPricing = hasBillingPeriod && input.applyCustomerPricing === true;
  const db = getDb();
  // Stock rows and outbound settlements are two views of the same inventory
  // lifecycle. Read them in one D1 batch so a concurrent outbound transaction
  // cannot make the report count the same goods twice or omit them entirely.
  const [openStocksResult, settlementsResult, catalogItemsResult, customerSettingsResult, outboundNotesResult,goodsStateResult,goodsOperationsResult,associationResult] = await db.batch(batchTuple([
    db.select().from(stocks).orderBy(asc(stocks.locationCode), asc(stocks.id)),
    db.select().from(storageFeeSettlements).orderBy(asc(storageFeeSettlements.outboundAt), asc(storageFeeSettlements.id)),
    db.select({ id: pricingCatalogItems.id, sku: pricingCatalogItems.sku }).from(pricingCatalogItems),
    db.select({ key: settings.key, value: settings.value }).from(settings)
      .where(like(settings.key, `${CUSTOMER_PRICING_KEY_PREFIX}%`)),
    db.select({ operationId: auditLogs.operationId, beforeSnapshot: auditLogs.beforeSnapshot }).from(auditLogs)
      .innerJoin(storageFeeSettlements, eq(auditLogs.operationId, storageFeeSettlements.operationId))
      .where(eq(auditLogs.action, "出库")),
    db.select().from(goodsFlowState),
    db.select({result:goodsOperations.result,kind:goodsOperations.kind,restoredAt:goodsOperations.restoredAt,id:goodsOperations.id,beforeRows:goodsOperations.beforeRows,afterRows:goodsOperations.afterRows}).from(goodsOperations),
    db.select().from(settings).where(eq(settings.key,'inventory_associations_v1')),
  ]));
  const physicalStocks=openStocksResult as Array<typeof stocks.$inferSelect>;
  const flow=((goodsStateResult??[]) as {value:string}[])[0];
  const currentIdentity=new Map(goodsChoices(physicalStocks,parseAssociationState(((associationResult??[]) as {value:string}[])[0]?.value??''),flow?parseGoodsState(flow.value):{categories:[]},true).flatMap(c=>c.members.map(s=>[s.id,{currentProductKey:c.key,currentProductName:c.product}] as const)));
  const openStocks: Array<typeof stocks.$inferSelect & {goodsLotId?:string;correctionEndDate?:string;correctionId?:string}> = flow?goodsBillingStocks(physicalStocks,parseGoodsState(flow.value)):physicalStocks.map(s=>({...s,goodsLotId:undefined as string|undefined}));
  for(const op of (goodsOperationsResult??[]) as {id:string;kind:string;result:string;restoredAt:string|null;beforeRows:string;afterRows:string}[]){if(op.kind!=='correction'||op.restoredAt)continue;const result=validateCorrectionOperation(op);for(const [index,segment] of result.closedAllocations.entries())openStocks.push({...segment.snapshot,totalQuantity:segment.quantity,totalBoxes:segment.boxes,correctionEndDate:segment.effectiveDate,correctionId:`${op.id}:${index}`});}
  const settlements = settlementsResult as Array<typeof storageFeeSettlements.$inferSelect>;
  const catalogItems = catalogItemsResult as Array<{ id: number; sku: string }>;
  const outboundNotes = new Map<string, string>();
  for(const op of (goodsOperationsResult??[]) as {result:string}[]) {try {const result=JSON.parse(op.result);for(const allocation of result.billingAllocations||[])if(typeof allocation.operationId==='string'&&typeof allocation.note==='string')outboundNotes.set(allocation.operationId,allocation.note);}catch{/* Historical rows without goods allocation details keep their original note fallback. */}}
  for (const row of outboundNotesResult as Array<{ operationId: string | null; beforeSnapshot: string | null }>) {
    if (!row.operationId) continue;
    try {
      const snapshot = JSON.parse(row.beforeSnapshot || "null");
      if (snapshot && typeof snapshot.note === "string") outboundNotes.set(row.operationId, snapshot.note);
    } catch { /* Missing historical snapshots must not borrow current stock notes. */ }
  }
  const skuByCatalogId = new Map(catalogItems.map(item => [item.id, item.sku]));
  const profiles = applyCustomerPricing
    ? customerPricingProfiles(customerSettingsResult as Array<{ key: string; value: string }>)
    : new Map();
  const rows: StorageFeeReportRow[] = [];

  for (const stock of openStocks) {
    const corrected=!!stock.correctionEndDate&&stock.correctionEndDate<=asOf,rowInventoryStatus=corrected?'corrected':'in_stock',endDate=corrected?stock.correctionEndDate!:asOf;
    if (inventoryStatus !== 'all' && inventoryStatus!==rowInventoryStatus || settlementStatus !== "all") continue;
    const inboundSource = normalizeInboundSource(stock.inboundSource);
    if (source !== "all" && source !== inboundSource) continue;
    if (customers.length && !customers.includes(stock.customerName)) continue;
    if (stock.inboundDate > asOf) continue;
    if (hasBillingPeriod && !(corrected?outboundStockTouchesPeriod(stock.inboundDate,endDate,period,asOf):openStockTouchesPeriod(stock.inboundDate, period, asOf))) continue;
    const effectivePricing = effectiveCustomerPricing({
      customerName: stock.customerName,
      inboundDate: stock.inboundDate,
      recordRatePerM3Day: stock.storageRateUsd,
      recordFreeDays: stock.freeDays,
      profiles,
    });
    const legacyCalc = calculateStorageFee({
      inboundDate: stock.inboundDate, endDate, billingMode: stock.billingMode,
      quantity: stock.totalQuantity, boxes: stock.totalBoxes, itemVolumeM3: stock.itemVolumeM3,
      boxVolumeM3: stock.boxVolumeM3, rateUsdM3Day: effectivePricing.ratePerM3Day, freeDays: effectivePricing.freeDays,
    });
    const periodCalc = hasBillingPeriod
      ? calculateStorageFeeForPeriod({
          inboundDate: stock.inboundDate,
          ...(corrected?{endDateExclusive:endDate}:{}),
          fromMonth: period.fromMonth,
          toMonth: period.toMonth,
          today: asOf,
          billingMode: stock.billingMode,
          quantity: stock.totalQuantity,
          boxes: stock.totalBoxes,
          itemVolumeM3: stock.itemVolumeM3,
          boxVolumeM3: stock.boxVolumeM3,
          rateUsdM3Day: effectivePricing.ratePerM3Day,
          freeDays: effectivePricing.freeDays,
        })
      : {
          periodStart: stock.inboundDate,
          periodEndExclusive: endDate,
          periodStorageDays: legacyCalc.storageDays,
          periodBillableDays: legacyCalc.billableDays,
          chargeStartDate: chargeStartDate(stock.inboundDate, legacyCalc.freeDays),
          periodFeeUsd: legacyCalc.feeUsd,
        };
    const chargeable = inboundSource === "return";
    const row: StorageFeeReportRow = {
      key: stock.correctionId?`correction-${stock.correctionId}`:stock.goodsLotId?`goods-lot-${stock.goodsLotId}`:`stock-${stock.id}`, status: corrected?'corrected':"open", inventoryStatus: rowInventoryStatus, settlementStatus: null,
      stockId: stock.id, settlementId: null, locationCode: stock.locationCode, inboundSource, chargeable,
      billingMode: legacyCalc.billingMode, productName: stock.product,
      ...currentIdentity.get(stock.id),
      sku: stock.sku || (stock.catalogItemId ? skuByCatalogId.get(stock.catalogItemId) || "" : ""), fnsku: stock.fnsku || "", barcode: stock.barcode,
      inboundOrder: stock.inboundOrder, note: stock.note, customerName: stock.customerName, inboundDate: stock.inboundDate,
      endDate, quantity: stock.totalQuantity, boxes: stock.totalBoxes, count: legacyCalc.count,
      itemVolumeM3: stock.itemVolumeM3, boxVolumeM3: stock.boxVolumeM3,
      volumePerCountM3: legacyCalc.volumePerCountM3, totalVolumeM3: legacyCalc.totalVolumeM3,
      ratePerM3Day: legacyCalc.rateUsdM3Day, freeDays: legacyCalc.freeDays, storageDays: legacyCalc.storageDays,
      customerRateOverride: effectivePricing.customerRateOverride,
      customerFreeDaysOverride: effectivePricing.customerFreeDaysOverride,
      customerPricingApplied: effectivePricing.customerPricingApplied,
      billableDays: legacyCalc.billableDays, feeUsd: chargeable ? legacyCalc.feeUsd : 0,
      periodStart: periodCalc.periodStart, periodEndExclusive: periodCalc.periodEndExclusive,
      periodStorageDays: periodCalc.periodStorageDays, periodBillableDays: periodCalc.periodBillableDays,
      chargeStartDate: periodCalc.chargeStartDate, periodFeeUsd: chargeable ? periodCalc.periodFeeUsd : 0,
      settledAt: null, settledBy: "", version: stock.version,
    };
    if (!q || Object.values(row).some(value => String(value).toLowerCase().includes(q))) rows.push(row);
  }

  for (const settlement of settlements) {
    if(inventoryStatus==='corrected')continue;
    const inboundSource = normalizeInboundSource(settlement.inboundSource);
    if (source !== "all" && source !== inboundSource) continue;
    const rowSettlementStatus = settlement.settlementStatus === "pending"
      ? "pending"
      : settlement.settlementStatus === "cancelled" ? "cancelled" : "settled";
    const outboundDate = settlement.outboundAt.slice(0, 10);
    // Units shipped after the requested cutoff were still present then. Add
    // their saved cost quantities to the remaining lots, without touching the
    // actual shipment date or its confirmed fee snapshot.
    const inStockAtCutoff = outboundDate > asOf && rowSettlementStatus !== "cancelled";
    if (inStockAtCutoff) {
      if (inventoryStatus === "outbound" || settlementStatus !== "all") continue;
    } else if (inventoryStatus === "in_stock" || !includesSettlementStatus(settlementStatus, rowSettlementStatus)) {
      continue;
    }
    if (customers.length && !customers.includes(settlement.customerName)) continue;
    if (settlement.inboundDate > asOf) continue;
    if (hasBillingPeriod) {
      if (!(inStockAtCutoff
        ? openStockTouchesPeriod(settlement.inboundDate, period, asOf)
        : outboundStockTouchesPeriod(settlement.inboundDate, outboundDate, period, asOf))) continue;
    } else if (outboundDate > asOf && !inStockAtCutoff) {
      // Cancelled future charges do not recreate active billing inventory.
      continue;
    }
    const effectivePricing = effectiveCustomerPricing({
      customerName: settlement.customerName,
      inboundDate: settlement.inboundDate,
      recordRatePerM3Day: settlement.rateUsdM3Day,
      recordFreeDays: settlement.freeDays,
      // An outbound row is explicitly reviewed before confirmation. Its saved
      // rate/free days therefore take priority over the customer's default
      // rule; changing a customer default must not silently rewrite a confirmed
      // historical outbound charge.
      profiles: inStockAtCutoff ? profiles : new Map(),
    });
    const inventoryEndDate = inStockAtCutoff ? asOf : outboundDate;
    const cutoffCalc = calculateStorageFee({
      inboundDate: settlement.inboundDate, endDate: inventoryEndDate,
      billingMode: settlement.billingMode, quantity: settlement.quantity, boxes: settlement.boxes,
      itemVolumeM3: settlement.itemVolumeM3, boxVolumeM3: settlement.boxVolumeM3,
      rateUsdM3Day: effectivePricing.ratePerM3Day, freeDays: effectivePricing.freeDays,
    });
    const periodCalc = hasBillingPeriod
      ? calculateStorageFeeForPeriod({
          inboundDate: settlement.inboundDate,
          endDateExclusive: inventoryEndDate,
          fromMonth: period.fromMonth,
          toMonth: period.toMonth,
          today: asOf,
          billingMode: settlement.billingMode,
          quantity: settlement.quantity,
          boxes: settlement.boxes,
          itemVolumeM3: settlement.itemVolumeM3,
          boxVolumeM3: settlement.boxVolumeM3,
          rateUsdM3Day: effectivePricing.ratePerM3Day,
          freeDays: effectivePricing.freeDays,
        })
      : {
          periodStart: settlement.inboundDate,
          periodEndExclusive: inventoryEndDate,
          periodStorageDays: inStockAtCutoff ? cutoffCalc.storageDays : settlement.storageDays,
          periodBillableDays: inStockAtCutoff ? cutoffCalc.billableDays : settlement.billableDays,
          chargeStartDate: chargeStartDate(settlement.inboundDate, settlement.freeDays),
          periodFeeUsd: inStockAtCutoff ? cutoffCalc.feeUsd : settlement.feeUsd,
        };
    // A settlement that happened after a historical billing period still
    // represents stock that was physically present during that period.
    const chargeable = inboundSource === "return";
    const row: StorageFeeReportRow = {
      key: `settlement-${settlement.id}`, status: inStockAtCutoff ? "open" : rowSettlementStatus,
      inventoryStatus: inStockAtCutoff ? "in_stock" : "outbound",
      settlementStatus: inStockAtCutoff ? null : rowSettlementStatus,
      stockId: settlement.stockId, settlementId: inStockAtCutoff ? null : settlement.id,
      locationCode: settlement.locationCode, inboundSource, chargeable,
      billingMode: settlement.billingMode === "box" ? "box" : "item", productName: settlement.product,
      ...currentIdentity.get(settlement.stockId),
      sku: settlement.sku || (settlement.catalogItemId ? skuByCatalogId.get(settlement.catalogItemId) || "" : ""), fnsku: settlement.fnsku || "",
      barcode: settlement.barcode, inboundOrder: settlement.inboundOrder, note: outboundNotes.get(settlement.operationId || "") || "", customerName: settlement.customerName,
      inboundDate: settlement.inboundDate, endDate: inventoryEndDate, quantity: settlement.quantity, boxes: settlement.boxes,
      count: settlement.billingMode === "box" ? settlement.boxes : settlement.quantity,
      itemVolumeM3: settlement.itemVolumeM3, boxVolumeM3: settlement.boxVolumeM3,
      volumePerCountM3: settlement.billingMode === "box" ? settlement.boxVolumeM3 : settlement.itemVolumeM3,
      totalVolumeM3: settlement.totalVolumeM3, ratePerM3Day: effectivePricing.ratePerM3Day,
      freeDays: effectivePricing.freeDays,
      customerRateOverride: effectivePricing.customerRateOverride,
      customerFreeDaysOverride: effectivePricing.customerFreeDaysOverride,
      customerPricingApplied: effectivePricing.customerPricingApplied,
      storageDays: inStockAtCutoff ? cutoffCalc.storageDays : settlement.storageDays,
      billableDays: inStockAtCutoff ? cutoffCalc.billableDays : settlement.billableDays,
      feeUsd: chargeable ? (inStockAtCutoff ? cutoffCalc.feeUsd : settlement.feeUsd) : 0,
      periodStart: periodCalc.periodStart, periodEndExclusive: periodCalc.periodEndExclusive,
      periodStorageDays: periodCalc.periodStorageDays, periodBillableDays: periodCalc.periodBillableDays,
      chargeStartDate: periodCalc.chargeStartDate, periodFeeUsd: chargeable ? periodCalc.periodFeeUsd : 0,
      settledAt: inStockAtCutoff ? null : settlement.settledAt,
      settledBy: inStockAtCutoff ? "" : settlement.settledBy || "", version: settlement.version,
    };
    if (!q || Object.values(row).some(value => String(value).toLowerCase().includes(q))) rows.push(row);
  }

  // Preserve historical confirmed snapshots. Unknown measurements are explicit review items,
  // while numeric zero remains only the storage representation of an unpriced fee.
  for(const row of rows){
    row.pricingReview=row.chargeable&&row.settlementStatus!=='settled'&&!(row.volumePerCountM3>0);
    row.pricingReviewReason=row.pricingReview?'计价资料待核对（缺少有效体积）':'';
  }
  const openRows = rows.filter(row => row.inventoryStatus === "in_stock");
  const outboundRows = rows.filter(row => row.inventoryStatus === "outbound");
  const pendingRows = outboundRows.filter(row => row.settlementStatus === "pending");
  const settledRows = outboundRows.filter(row => row.settlementStatus === "settled");
  const cancelledRows = outboundRows.filter(row => row.settlementStatus === "cancelled");
  const activeRows = rows.filter(row => row.settlementStatus !== "cancelled");
  const activeOutboundRows = outboundRows.filter(row => row.settlementStatus !== "cancelled");
  const summary = {
    asOf, fromMonth: period.fromMonth, toMonth: period.toMonth,
    periodStart: period.periodStart, periodEndExclusive: period.periodEndExclusive,
    requestedPeriodEndExclusive: period.requestedPeriodEndExclusive,
    source, status: legacyStatus, inventoryStatus, settlementStatus, customer, rows: rows.length,
    pricingReviewRows: rows.filter(row=>row.pricingReview).length,
    openRows: openRows.length, inStockRows: openRows.length, outboundRows: outboundRows.length,
    pendingRows: pendingRows.length, settledRows: settledRows.length, cancelledRows: cancelledRows.length,
    openVolumeM3: roundedSum(openRows, "totalVolumeM3", 8),
    outboundVolumeM3: roundedSum(outboundRows, "totalVolumeM3", 8),
    pendingVolumeM3: roundedSum(pendingRows, "totalVolumeM3", 8),
    settledVolumeM3: roundedSum(settledRows, "totalVolumeM3", 8),
    cancelledVolumeM3: roundedSum(cancelledRows, "totalVolumeM3", 8),
    openFeeUsd: roundedSum(openRows, "feeUsd", 6),
    pendingFeeUsd: roundedSum(pendingRows, "feeUsd", 6),
    settledFeeUsd: roundedSum(settledRows, "feeUsd", 6),
    cancelledFeeUsd: roundedSum(cancelledRows, "feeUsd", 6),
    totalFeeUsd: roundedSum(activeRows, "feeUsd", 6),
    openPeriodFeeUsd: roundedSum(openRows, "periodFeeUsd", 6),
    inStockPeriodFeeUsd: roundedSum(openRows, "periodFeeUsd", 6),
    outboundPeriodFeeUsd: roundedSum(activeOutboundRows, "periodFeeUsd", 6),
    pendingPeriodFeeUsd: roundedSum(pendingRows, "periodFeeUsd", 6),
    settledPeriodFeeUsd: roundedSum(settledRows, "periodFeeUsd", 6),
    cancelledPeriodFeeUsd: roundedSum(cancelledRows, "periodFeeUsd", 6),
    totalPeriodFeeUsd: roundedSum(activeRows, "periodFeeUsd", 6),
    customerPricingRows: rows.filter(row => row.customerPricingApplied).length,
  };
  return {
    summary,
    rows,
    openItems: openRows,
    inStockItems: openRows,
    outboundItems: outboundRows,
    pendingItems: pendingRows,
    settledItems: settledRows,
    cancelledItems: cancelledRows,
  };
}
