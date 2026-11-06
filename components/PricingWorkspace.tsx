"use client";

import { Fragment,useEffect, useMemo, useState } from "react";
import {groupPricingProducts} from '../lib/pricing-product-groups';
import styles from "./PricingWorkspace.module.css";
import PricingNumberInput from "./PricingNumberInput";
import {
  PricingReportRow,
  StockSourceType,
} from "./pricing-types";

type PricingWorkspaceProps = {
  canEdit?: boolean;
  canEditStockCustomer?: boolean;
  onStockCustomerSaved?: () => void;
  reportEndpoint?: string;
  exportEndpoint?: string;
  settlementsEndpoint?: string;
  stocksEndpoint?: string;
  settingsEndpoint?: string;
  customerSettingsEndpoint?: string;
  onDefaultsChange?: (settings: PricingSettings) => void;
  onNotice?: (message: string) => void;
};

export type PricingSettings = {
  defaultRatePerM3Day: number;
  defaultFreeDays: number;
};

type SettlementDraft = {
  outboundDate: string;
  volumePerUnitM3: number;
  ratePerM3Day: number;
  freeDays: number;
  feeUsd: number;
  feeIsManual: boolean;
};

type BillingPeriod = {
  fromMonth: string;
  toMonth: string;
};

type InventoryFilter = "all" | "in_stock" | "outbound" | "corrected";
type SettlementHistoryFilter = "all" | "settled" | "cancelled";

type CustomerPricingDraft = {
  ratePerM3Day: string;
  freeDays: string;
  updatedAt?: string;
  updatedBy?: string;
};

const EMPTY_CUSTOMER_PRICING: CustomerPricingDraft = {
  ratePerM3Day: "",
  freeDays: "",
};

const REPORT_PREVIEW_LIMIT = 20;
const DAY_MS = 86_400_000;

const DEFAULT_SETTINGS: PricingSettings = {
  defaultRatePerM3Day: 0.7,
  defaultFreeDays: 0,
};

const currentWarehouseMonth = () => {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value ?? "";
  const month = parts.find((part) => part.type === "month")?.value ?? "";
  return `${year}-${month}`;
};

const currentWarehouseDate = () => {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
};

const utcDate = (value: string) => {
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  return [year, month, day].every(Number.isFinite) ? Date.UTC(year, month - 1, day) : Number.NaN;
};

const settlementFormula = (row: PricingReportRow, draft: Pick<SettlementDraft, "outboundDate" | "volumePerUnitM3" | "ratePerM3Day" | "freeDays">) => {
  const start = utcDate(row.inboundDate);
  const end = utcDate(draft.outboundDate);
  const storageDays = Number.isFinite(start) && Number.isFinite(end)
    ? Math.max(0, Math.floor((end - start) / DAY_MS))
    : 0;
  const freeDays = Math.max(0, Math.trunc(draft.freeDays));
  const billableDays = Math.max(0, storageDays - freeDays);
  const totalVolumeM3 = Number((Math.max(0, row.billedQuantity) * Math.max(0, draft.volumePerUnitM3)).toFixed(8));
  const feeUsd = Number((totalVolumeM3 * Math.max(0, draft.ratePerM3Day) * billableDays).toFixed(6));
  return { storageDays, billableDays, totalVolumeM3, feeUsd };
};

const settlementDraftFor = (row: PricingReportRow): SettlementDraft => {
  const base = {
    outboundDate: row.outboundDate || currentWarehouseDate(),
    volumePerUnitM3: row.volumePerUnitM3,
    ratePerM3Day: row.ratePerM3Day,
    freeDays: row.freeDays,
  };
  const formula = settlementFormula(row, base);
  return {
    ...base,
    feeUsd: row.feeUsd,
    feeIsManual: Math.abs(row.feeUsd - formula.feeUsd) > 0.000001,
  };
};

const monthLabel = (value: string) => {
  const [year, month] = value.split("-");
  return year && month ? `${year}年${Number(month)}月` : value;
};

const safeNumber = (value: unknown, fallback = 0) => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const normalizeReportRow = (raw: Record<string, unknown>, index: number): PricingReportRow => {
  const settlementId = Number(raw.settlementId || 0) || null;
  const status = raw.status === "pending"
    ? "pending"
    : raw.status === "settled" ? "settled" : raw.status === "cancelled" ? "cancelled" : raw.status==='corrected'?'corrected':"open";
  const inventoryStatus = raw.inventoryStatus === "outbound"
    ? "outbound"
    : raw.inventoryStatus==='corrected'?'corrected':raw.inventoryStatus === "in_stock" ? "in_stock" : status === "open" ? "in_stock" : "outbound";
  const settlementStatus = raw.settlementStatus === "pending"
    ? "pending"
    : raw.settlementStatus === "settled"
      ? "settled"
      : raw.settlementStatus === "cancelled"
        ? "cancelled"
        : status === "pending" || status === "settled" || status === "cancelled" ? status : null;
  const stockId = Math.max(0, Math.trunc(safeNumber(raw.stockId ?? (inventoryStatus === "in_stock" ? raw.id : 0))));
  return {
    id: raw.key as string ?? settlementId ?? (stockId || (raw.id ?? index)) as number | string,
    stockId,
    status,
    inventoryStatus,
    settlementStatus,
    settlementId,
    sourceType: (raw.sourceType ?? raw.inboundSource) === "return"
      ? "return"
      : (raw.sourceType ?? raw.inboundSource) === "unspecified" ? "unspecified" : "domestic",
    locationCode: String(raw.locationCode ?? raw.location ?? ""),
    customerName: String(raw.customerName ?? raw.customer ?? ""),
    productName: String(raw.productName ?? raw.product ?? ""),
    currentProductKey:raw.currentProductKey?String(raw.currentProductKey):undefined,
    currentProductName:raw.currentProductName?String(raw.currentProductName):undefined,
    sku: String(raw.sku ?? ""),
    barcode: String(raw.barcode ?? ""),
    inboundOrder: String(raw.inboundOrder ?? ""),
    note: String(raw.note ?? ""),
    inboundDate: String(raw.inboundDate ?? ""),
    correctionDate:inventoryStatus==='corrected'?String(raw.endDate??''):undefined,
    outboundDate: inventoryStatus === "outbound" && (raw.outboundDate || raw.endDate)
      ? String(raw.outboundDate ?? raw.endDate)
      : undefined,
    billingMode: raw.billingMode === "box" ? "box" : "item",
    quantity:safeNumber(raw.quantity),boxes:safeNumber(raw.boxes),
    billedQuantity: safeNumber(raw.count ?? raw.billedQuantity ?? (raw.billingMode === "box" ? raw.boxes : raw.quantity)),
    volumePerUnitM3: safeNumber(raw.volumePerUnitM3 ?? raw.volumePerCountM3 ?? raw.unitVolumeM3),
    totalVolumeM3: safeNumber(raw.totalVolumeM3 ?? raw.volumeM3),
    storageDays: Math.max(0, Math.trunc(safeNumber(raw.storageDays))),
    freeDays: Math.max(0, Math.trunc(safeNumber(raw.freeDays))),
    billableDays: Math.max(0, Math.trunc(safeNumber(raw.billableDays))),
    ratePerM3Day: safeNumber(raw.ratePerM3Day ?? raw.rate, 0.7),
    feeUsd: safeNumber(raw.feeUsd ?? raw.amountUsd ?? raw.fee),
    pricingReview:raw.pricingReview===true,
    pricingReviewReason:String(raw.pricingReviewReason??""),
    customerRateOverride: raw.customerRateOverride === null || raw.customerRateOverride === undefined
      ? null
      : safeNumber(raw.customerRateOverride),
    customerFreeDaysOverride: raw.customerFreeDaysOverride === null || raw.customerFreeDaysOverride === undefined
      ? null
      : Math.max(0, Math.trunc(safeNumber(raw.customerFreeDaysOverride))),
    customerPricingApplied: raw.customerPricingApplied === true,
    periodStart: String(raw.periodStart ?? ""),
    periodEndExclusive: String(raw.periodEndExclusive ?? ""),
    periodStorageDays: Math.max(0, Math.trunc(safeNumber(raw.periodStorageDays ?? raw.storageDays))),
    periodBillableDays: Math.max(0, Math.trunc(safeNumber(raw.periodBillableDays ?? raw.billableDays))),
    chargeStartDate: String(raw.chargeStartDate ?? ""),
    periodFeeUsd: safeNumber(raw.periodFeeUsd ?? raw.feeUsd ?? raw.amountUsd ?? raw.fee),
    settledAt: raw.settledAt ? String(raw.settledAt) : null,
    settledBy: String(raw.settledBy ?? ""),
    version: Math.max(0, Math.trunc(safeNumber(raw.version))),
  };
};

const extractReportRows = (payload: unknown): PricingReportRow[] => {
  const source = payload as Record<string, unknown> | unknown[] | null;
  const rows = Array.isArray(source)
    ? source
    : Array.isArray(source?.rows)
      ? source.rows
      : Array.isArray(source?.report)
        ? source.report
        : [];
  return rows
    .filter((row): row is Record<string, unknown> => !!row && typeof row === "object")
    .map(normalizeReportRow)
    .filter((row) => row.sourceType === "return");
};

const currency = (value: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 }).format(value);

const decimal = (value: number, digits = 6) =>
  new Intl.NumberFormat("zh-CN", { maximumFractionDigits: digits }).format(value);

const warehouseDateTime = (value: string | null) => {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
};

const payloadMessage = (payload: unknown, fallback: string) => {
  if (payload && typeof payload === "object") {
    const source = payload as Record<string, unknown>;
    const message = source.error ?? source.message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return fallback;
};

const fetchPayload = async (input: RequestInfo | URL, init: RequestInit | undefined, fallback: string) => {
  let response: Response;
  try {
    response = await fetch(input, init);
  } catch {
    throw new Error(`${fallback}，请检查网络后重试`);
  }
  const raw = await response.text();
  let payload: unknown = {};
  if (raw.trim()) {
    try {
      payload = JSON.parse(raw) as unknown;
    } catch {
      throw new Error(response.ok ? "服务器返回的数据格式不正确，请刷新后重试" : `${fallback}（状态码 ${response.status}）`);
    }
  }
  if (!response.ok) throw new Error(payloadMessage(payload, `${fallback}（状态码 ${response.status}）`));
  return payload;
};

const extractSettings = (payload: unknown): PricingSettings => {
  const source = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const nested = source.settings && typeof source.settings === "object"
    ? (source.settings as Record<string, unknown>)
    : source;
  return {
    defaultRatePerM3Day: Math.max(0, safeNumber(nested.defaultRatePerM3Day, DEFAULT_SETTINGS.defaultRatePerM3Day)),
    defaultFreeDays: Math.max(0, Math.trunc(safeNumber(nested.defaultFreeDays, DEFAULT_SETTINGS.defaultFreeDays))),
  };
};

const extractCustomerPricing = (payload: unknown): CustomerPricingDraft => {
  const source = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const profile = source.profile && typeof source.profile === "object"
    ? source.profile as Record<string, unknown>
    : source;
  const rawRate = profile.ratePerM3Day;
  const rawFreeDays = profile.freeDays;
  return {
    ratePerM3Day: rawRate === null || rawRate === undefined || String(rawRate).trim() === ""
      ? ""
      : String(rawRate),
    freeDays: rawFreeDays === null || rawFreeDays === undefined || String(rawFreeDays).trim() === ""
      ? ""
      : String(rawFreeDays),
    updatedAt: typeof profile.updatedAt === "string" ? profile.updatedAt : undefined,
    updatedBy: typeof profile.updatedBy === "string" ? profile.updatedBy : undefined,
  };
};

export function PricingWorkspace({
  canEdit = true,
  canEditStockCustomer = false,
  onStockCustomerSaved,
  reportEndpoint = "/api/pricing/report",
  exportEndpoint = "/api/pricing/report/export",
  settlementsEndpoint = "/api/pricing/settlements",
  stocksEndpoint = "/api/stocks",
  settingsEndpoint = "/api/pricing/settings",
  customerSettingsEndpoint = "/api/pricing/customer-settings",
  onDefaultsChange,
  onNotice,
}: PricingWorkspaceProps) {
  const initialMonth = currentWarehouseMonth();
  const [sourceTab, setSourceTab] = useState<Exclude<StockSourceType, "unspecified">>("return");
  const [reportRows, setReportRows] = useState<PricingReportRow[]>([]);
  const [settlementRows, setSettlementRows] = useState<PricingReportRow[]>([]);
  const [historyFilter, setHistoryFilter] = useState<SettlementHistoryFilter>("all");
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [selectedSettlementIds, setSelectedSettlementIds] = useState<string[]>([]);
  const [editingSettlementId, setEditingSettlementId] = useState<number | null>(null);
  const [settlementDraft, setSettlementDraft] = useState<SettlementDraft | null>(null);
  const [editingStockVolume, setEditingStockVolume] = useState<PricingReportRow | null>(null);
  const [stockVolumeDraft, setStockVolumeDraft] = useState(0);
  const [editingCustomer, setEditingCustomer] = useState<PricingReportRow | null>(null);
  const [customerDraft, setCustomerDraft] = useState("");
  const [selectedCustomerRows, setSelectedCustomerRows] = useState<PricingReportRow[]>([]);
  const [batchCustomerRows, setBatchCustomerRows] = useState<PricingReportRow[] | null>(null);
  const [selectedCustomers, setSelectedCustomers] = useState<string[]>([]);
  const selectedCustomer = selectedCustomers.length === 1 ? selectedCustomers[0] : "";
  const [inventoryFilter, setInventoryFilter] = useState<InventoryFilter>("all");
  const [periodDraft, setPeriodDraft] = useState<BillingPeriod>({
    fromMonth: initialMonth,
    toMonth: initialMonth,
  });
  const [appliedPeriod, setAppliedPeriod] = useState<BillingPeriod>({
    fromMonth: initialMonth,
    toMonth: initialMonth,
  });
  const [busyKey, setBusyKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [settings, setSettings] = useState<PricingSettings>(DEFAULT_SETTINGS);
  const [customerPricing, setCustomerPricing] = useState<CustomerPricingDraft>(EMPTY_CUSTOMER_PRICING);
  const [savedCustomerPricing, setSavedCustomerPricing] = useState<CustomerPricingDraft>(EMPTY_CUSTOMER_PRICING);
  const [customerPricingLoading, setCustomerPricingLoading] = useState(false);
  const [reportExpanded, setReportExpanded] = useState(false);

  const announce = (next: string) => {
    setMessage(next);
    setError("");
    onNotice?.(next);
  };

  const chooseCustomers = (next: string[]) => {
    if (customerPricingDirty) { setError("客户计价规则有未保存修改，请先保存后再切换客户"); return; }
    setSelectedCustomers(next);
    setSelectedCustomerRows([]);
    setReportExpanded(false);
    setCustomerPricing({ ...EMPTY_CUSTOMER_PRICING });
    setSavedCustomerPricing({ ...EMPTY_CUSTOMER_PRICING });
    setCustomerPricingLoading(next.length === 1);
  };

  const loadReport = async (period: BillingPeriod = appliedPeriod) => {
    const separator = reportEndpoint.includes("?") ? "&" : "?";
    const monthlyParams = new URLSearchParams({
      source: "return",
      fromMonth: period.fromMonth,
      toMonth: period.toMonth,
      inventoryStatus: "all",
      customerPricing: "1",
    });
    const pendingSettlementParams = new URLSearchParams({
      source: "return",
      inventoryStatus: "outbound",
      settlementStatus: "pending",
      fromMonth: "1970-01",
      toMonth: currentWarehouseMonth(),
    });
    const historySettlementParams = new URLSearchParams({
      source: "return",
      inventoryStatus: "outbound",
      settlementStatus: "history",
      fromMonth: "1970-01",
      toMonth: currentWarehouseMonth(),
    });
    const [monthlyPayload, pendingSettlementPayload, historySettlementPayload] = await Promise.all([
      fetchPayload(
        `${reportEndpoint}${separator}${monthlyParams.toString()}`,
        { cache: "no-store" },
        "本期仓储费读取失败",
      ),
      fetchPayload(
        `${reportEndpoint}${separator}${pendingSettlementParams.toString()}`,
        { cache: "no-store" },
        "待结算费用读取失败",
      ),
      fetchPayload(
        `${reportEndpoint}${separator}${historySettlementParams.toString()}`,
        { cache: "no-store" },
        "计价操作记录读取失败",
      ),
    ]);
    const rows = extractReportRows(monthlyPayload);
    const nextPendingRows = extractReportRows(pendingSettlementPayload);
    const nextHistoryRows = extractReportRows(historySettlementPayload);
    const nextSettlementRows = [...nextPendingRows, ...nextHistoryRows];
    setReportRows(rows);
    setSettlementRows(nextSettlementRows);
    setSelectedSettlementIds((current) => current.filter((id) => nextPendingRows.some((row) => String(row.settlementId) === id)));
  };

  const loadSettings = async () => {
    const payload = await fetchPayload(settingsEndpoint, { cache: "no-store" }, "默认计价设置读取失败");
    const next = extractSettings(payload);
    setSettings(next);
    onDefaultsChange?.(next);
  };

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      Promise.all([loadReport(), loadSettings()])
        .catch((reason) => {
          if (!cancelled) setError(reason instanceof Error ? reason.message : "计价数据读取失败");
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // Initial load only. Parent can remount after authentication changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!selectedCustomer) {
      return () => { cancelled = true; };
    }
    const separator = customerSettingsEndpoint.includes("?") ? "&" : "?";
    fetchPayload(
      `${customerSettingsEndpoint}${separator}${new URLSearchParams({ customer: selectedCustomer }).toString()}`,
      { cache: "no-store" },
      "客户计价规则读取失败",
    ).then((payload) => {
      if (cancelled) return;
      const next = extractCustomerPricing(payload);
      setCustomerPricing(next);
      setSavedCustomerPricing(next);
    }).catch((reason) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : "客户计价规则读取失败");
    }).finally(() => {
      if (!cancelled) setCustomerPricingLoading(false);
    });
    return () => { cancelled = true; };
  }, [customerSettingsEndpoint, selectedCustomer]);

  const pendingRows = useMemo(
    () => settlementRows.filter((row) => row.settlementStatus === "pending"),
    [settlementRows],
  );
  const settledRows = useMemo(
    () => settlementRows.filter((row) => row.settlementStatus === "settled"),
    [settlementRows],
  );
  const cancelledRows = useMemo(
    () => settlementRows.filter((row) => row.settlementStatus === "cancelled"),
    [settlementRows],
  );
  const historyRows = useMemo(
    () => settlementRows.filter((row) => row.settlementStatus === "settled" || row.settlementStatus === "cancelled"),
    [settlementRows],
  );
  const visibleHistoryRows = useMemo(
    () => historyFilter === "all"
      ? historyRows
      : historyRows.filter((row) => row.settlementStatus === historyFilter),
    [historyFilter, historyRows],
  );
  const customerOptions = useMemo(() => [...new Set(reportRows.map((row) => row.customerName).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, "zh-CN")), [reportRows]);
  const visibleReportRows = useMemo(() => reportRows.filter((row) => {
    if (inventoryFilter !== "all" && row.inventoryStatus !== inventoryFilter) return false;
    return selectedCustomers.length === 0 || selectedCustomers.includes(row.customerName);
  }), [inventoryFilter, reportRows, selectedCustomers]);
  const canChangeCustomer = (row: PricingReportRow) => row.inventoryStatus === "in_stock"
    ? canEditStockCustomer && !!row.stockId
    : canEdit && !!row.settlementId && (row.settlementStatus === "pending" || row.settlementStatus === "settled");
  const customerRowKey = (row: PricingReportRow) => row.inventoryStatus === "in_stock" ? "stock:" + row.stockId : "outbound:" + row.settlementId;
  const selectableCustomerRows = visibleReportRows.filter(canChangeCustomer);
  const [expandedPricingProducts,setExpandedPricingProducts]=useState<string[]>([]);
  const pricingProducts=useMemo(()=>groupPricingProducts(visibleReportRows),[visibleReportRows]);
  const displayedPricingProducts=reportExpanded?pricingProducts:pricingProducts.slice(0,REPORT_PREVIEW_LIMIT);
  const displayedReportRows = useMemo(
    () => reportExpanded ? visibleReportRows : visibleReportRows.slice(0, REPORT_PREVIEW_LIMIT),
    [reportExpanded, visibleReportRows],
  );
  const customerPricingDirty = selectedCustomer !== ""
    && (customerPricing.ratePerM3Day !== savedCustomerPricing.ratePerM3Day
      || customerPricing.freeDays !== savedCustomerPricing.freeDays);
  const exportScopeLabel = inventoryFilter === "in_stock"
    ? "在库"
    : inventoryFilter === "outbound" ? "已出库" : inventoryFilter==='corrected'?'库存修正':"全部";
  const inStockCount = useMemo(
    () => visibleReportRows.filter((row) => row.inventoryStatus === "in_stock").length,
    [visibleReportRows],
  );
  const outboundCount = useMemo(
    () => visibleReportRows.filter((row) => row.inventoryStatus === "outbound").length,
    [visibleReportRows],
  );
  const pendingInvoiceCount = useMemo(
    () => visibleReportRows.filter((row) => row.inventoryStatus === "outbound" && row.settlementStatus === "pending").length,
    [visibleReportRows],
  );
  const invoiceEligibleRows = useMemo(
    () => visibleReportRows.filter((row) => !row.pricingReview&&(row.inventoryStatus === "in_stock" || row.settlementStatus === "settled" || row.inventoryStatus==='corrected')),
    [visibleReportRows],
  );
  const periodBillableDays = useMemo(
    () => visibleReportRows.reduce((sum, row) => sum + row.periodBillableDays, 0),
    [visibleReportRows],
  );
  const pricingReviewCount=visibleReportRows.filter(row=>row.pricingReview).length;
  const periodFeeUsd = useMemo(
    () => invoiceEligibleRows.reduce((sum, row) => sum + row.periodFeeUsd, 0),
    [invoiceEligibleRows],
  );
  const pendingPeriodFeeUsd = useMemo(
    () => visibleReportRows
      .filter((row) => !row.pricingReview&&row.inventoryStatus === "outbound" && row.settlementStatus === "pending")
      .reduce((sum, row) => sum + row.periodFeeUsd, 0),
    [visibleReportRows],
  );

  const editingSettlement = useMemo(
    () => settlementRows.find((row) => row.settlementId === editingSettlementId) ?? null,
    [editingSettlementId, settlementRows],
  );
  const editingPreview = editingSettlement && settlementDraft
    ? settlementFormula(editingSettlement, settlementDraft)
    : null;
  const stockVolumePreview = editingStockVolume
    ? Number((Math.max(0, editingStockVolume.billedQuantity) * Math.max(0, stockVolumeDraft)).toFixed(8))
    : 0;

  const requestBodyForSettlement = (row: PricingReportRow, draft = settlementDraftFor(row)) => {
    const formula = settlementFormula(row, draft);
    return {
      id: row.settlementId,
      version: row.version,
      outboundDate: draft.outboundDate,
      volumePerUnitM3: draft.volumePerUnitM3,
      ratePerM3Day: draft.ratePerM3Day,
      freeDays: Math.max(0, Math.trunc(draft.freeDays)),
      feeUsd: draft.feeIsManual ? draft.feeUsd : formula.feeUsd,
    };
  };

  const mutateSettlement = async (
    row: PricingReportRow,
    method: "PATCH" | "POST" | "DELETE" | "PUT",
    draft?: SettlementDraft,
  ) => fetchPayload(
    settlementsEndpoint,
    {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(method === "DELETE" || method === "PUT"
        ? { id: row.settlementId, version: row.version }
        : requestBodyForSettlement(row, draft)),
    },
    method === "DELETE"
      ? "取消出库计价失败"
      : method === "PUT" ? "撤销取消失败" : method === "POST" ? "确认出库计价失败" : "出库计价保存失败",
  );

  const openSettlementEditor = (row: PricingReportRow) => {
    if (row.settlementStatus !== "pending" || !row.settlementId) return;
    setEditingStockVolume(null);
    setEditingSettlementId(row.settlementId);
    setSettlementDraft(settlementDraftFor(row));
    setError("");
  };

  const openStockVolumeEditor = (row: PricingReportRow) => {
    if (row.inventoryStatus !== "in_stock" || !row.stockId) return;
    setEditingSettlementId(null);
    setSettlementDraft(null);
    setEditingStockVolume(row);
    setStockVolumeDraft(row.volumePerUnitM3);
    setError("");
  };

  const saveStockCustomer = async () => {
    const targets = batchCustomerRows ?? (editingCustomer ? [editingCustomer] : []);
    if (!targets.length || !customerDraft.trim()) return;
    const customerName = customerDraft.trim();
    setBusyKey("stock-customer"); setError("");
    let succeeded = 0;
    const failed: PricingReportRow[] = [];
    const failures: string[] = [];
    for (const row of targets) {
      try {
        await fetchPayload(row.inventoryStatus === "in_stock" ? stocksEndpoint : `${settlementsEndpoint}/customer`, {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: row.inventoryStatus === "in_stock" ? row.stockId : row.settlementId, version: row.version, customerName }),
        }, "客户保存失败");
        succeeded += 1;
      } catch (reason) {
        failed.push(row);
        failures.push(row.locationCode + " · " + row.productName + "：" + (reason instanceof Error ? reason.message : "客户保存失败"));
      }
    }
    if (succeeded) {
      onStockCustomerSaved?.();
      setSelectedCustomers(current => current.length ? [...new Set([...current, customerName])] : current);
    }
    setSelectedCustomerRows(failed);
    if (!failed.length || batchCustomerRows) { setEditingCustomer(null); setBatchCustomerRows(null); }
    try { await loadReport(); } catch { failures.push("明细刷新失败，请刷新页面核对"); }
    setBusyKey("");
    if (failures.length) {
      setMessage("已更新 " + succeeded + " 条，失败 " + failed.length + " 条");
      setError(failures.join("；") + (failed.length ? "。失败项仍保留勾选，请核对后重新勾选。" : ""));
    } else {
      announce("已更新 " + succeeded + " 条客户；在库同步到库位，出库保留原计价");
    }
  };

  const saveStockVolumeEditor = async () => {
    if (!editingStockVolume?.stockId) return;
    if (!Number.isFinite(stockVolumeDraft) || stockVolumeDraft <= 0) {
      setError("每件或每箱体积必须是大于 0 的数字");
      return;
    }
    const key = `stock-volume-${editingStockVolume.stockId}`;
    setBusyKey(key);
    setError("");
    try {
      await fetchPayload(
        stocksEndpoint,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: editingStockVolume.stockId,
            [editingStockVolume.billingMode === "box" ? "boxVolumeM3" : "itemVolumeM3"]: stockVolumeDraft,
          }),
        },
        "在库货物体积保存失败",
      );
      await loadReport();
      setEditingStockVolume(null);
      setStockVolumeDraft(0);
      announce("在库货物体积已更新，计价已重新计算");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "在库货物体积保存失败");
    } finally {
      setBusyKey("");
    }
  };

  const saveSettlementEditor = async (settle: boolean) => {
    if (!editingSettlement || !settlementDraft || !editingSettlement.settlementId) return;
    if (!settlementDraft.outboundDate || settlementDraft.outboundDate < editingSettlement.inboundDate) {
      setError("计价出库日期不能早于入库日期");
      return;
    }
    if (settlementDraft.outboundDate > currentWarehouseDate()) {
      setError("计价出库日期不能晚于今天");
      return;
    }
    if (!Number.isFinite(settlementDraft.volumePerUnitM3) || settlementDraft.volumePerUnitM3 <= 0) {
      setError("每件或每箱体积必须是大于 0 的数字");
      return;
    }
    if (settle && !window.confirm("确认后该记录会进入正式月度账单；如需修改，须先取消确认。是否继续？")) return;
    const key = `${settle ? "settle" : "save"}-${editingSettlement.settlementId}`;
    setBusyKey(key);
    setError("");
    try {
      await mutateSettlement(editingSettlement, settle ? "POST" : "PATCH", settlementDraft);
      await loadReport();
      setEditingSettlementId(null);
      setSettlementDraft(null);
      announce(settle ? "该出库计价记录已确认" : "出库日期、体积、费率、免租天数和整段价格已保存");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : settle ? "确认出库计价失败" : "出库计价保存失败");
    } finally {
      setBusyKey("");
    }
  };

  const confirmSettlement = async (row: PricingReportRow) => {
    if (!row.settlementId || !window.confirm(`确认“${row.productName || "未命名货物"}”当前保存的出库计价？确认后会进入正式月度账单。`)) return;
    setBusyKey(`settle-${row.settlementId}`);
    setError("");
    try {
      await mutateSettlement(row, "POST");
      await loadReport();
      announce("该出库计价记录已确认");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "确认出库计价失败");
    } finally {
      setBusyKey("");
    }
  };

  const cancelSettlementPricing = async (row: PricingReportRow) => {
    if (!row.settlementId || row.settlementStatus === "cancelled") return;
    const wasSettled = row.settlementStatus === "settled";
    const warning = wasSettled
      ? "取消后，该商品会从正式计价中移除并进入计价操作记录。真实出库记录和库存不会改变，是否继续？"
      : "取消后，该商品会从待处理列表移除并进入计价操作记录。真实出库记录和库存不会改变，是否继续？";
    if (!window.confirm(warning)) return;
    setBusyKey(`cancel-${row.settlementId}`);
    setError("");
    try {
      await mutateSettlement(row, "DELETE");
      await loadReport();
      announce("已取消该商品的出库计价，可在“计价操作记录”中查看或撤销取消");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "取消出库计价失败");
    } finally {
      setBusyKey("");
    }
  };

  const restoreCancelledSettlement = async (row: PricingReportRow) => {
    if (!row.settlementId || row.settlementStatus !== "cancelled") return;
    const restoredLabel = row.settledAt ? "已确认" : "待确认";
    if (!window.confirm(`撤销取消后，这条记录会恢复为“${restoredLabel}”。是否继续？`)) return;
    setBusyKey(`restore-${row.settlementId}`);
    setError("");
    try {
      await mutateSettlement(row, "PUT");
      await loadReport();
      announce(`已撤销取消，该记录已恢复为“${restoredLabel}”`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "撤销取消失败");
    } finally {
      setBusyKey("");
    }
  };

  const changeSettlementSelection = (id: string, checked: boolean) => {
    setSelectedSettlementIds((current) => checked
      ? [...new Set([...current, id])]
      : current.filter((value) => value !== id));
  };

  const runSettlementBatch = async (action: "confirm" | "cancel") => {
    const targets = pendingRows.filter((row) => !row.pricingReview&&row.settlementId
      && selectedSettlementIds.includes(String(row.settlementId)));
    if (!targets.length) {
      setError("请先选择待处理记录");
      return;
    }
    const warning = action === "confirm"
      ? `确认选中的 ${targets.length} 条出库计价？它们会进入正式月度账单。`
      : `取消选中的 ${targets.length} 条出库计价？它们会从待处理列表移入计价操作记录，真实出库记录和库存不会改变。`;
    if (!window.confirm(warning)) return;
    setBusyKey(`batch-${action}`);
    setError("");
    let succeeded = 0;
    const failures: string[] = [];
    for (const row of targets) {
      try {
        await mutateSettlement(row, action === "confirm" ? "POST" : "DELETE");
        succeeded += 1;
      } catch (reason) {
        failures.push(reason instanceof Error ? reason.message : "操作失败");
      }
    }
    await loadReport().catch(() => undefined);
    setSelectedSettlementIds([]);
    setBusyKey("");
    if (failures.length) {
      setMessage(`已成功 ${succeeded} 条，失败 ${failures.length} 条`);
      setError(failures[0]);
    } else {
      announce(action === "confirm" ? `已确认 ${succeeded} 条出库计价记录` : `已取消 ${succeeded} 条出库计价记录，可在操作记录中查看`);
    }
  };

  const applyBillingPeriod = async () => {
    if (!periodDraft.fromMonth || !periodDraft.toMonth) {
      setError("请选择完整的开始月份和结束月份");
      return;
    }
    if (periodDraft.fromMonth > periodDraft.toMonth) {
      setError("开始月份不能晚于结束月份");
      return;
    }
    setBusyKey("period");
    setLoading(true);
    setError("");
    try {
      await loadReport(periodDraft);
      setAppliedPeriod(periodDraft);
      setSelectedCustomerRows([]);
      setReportExpanded(false);
      announce(`已应用账期：${monthLabel(periodDraft.fromMonth)}至${monthLabel(periodDraft.toMonth)}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "本期仓储费读取失败");
    } finally {
      setBusyKey("");
      setLoading(false);
    }
  };

  const saveCustomerPricing = async () => {
    if (!selectedCustomer) {
      setError("请先选择要设置计价规则的客户");
      return;
    }
    const rateText = customerPricing.ratePerM3Day.trim();
    const rate = rateText ? Number(rateText) : null;
    if (rate !== null && (!Number.isFinite(rate) || rate < 0 || rate > 1_000_000)) {
      setError("客户单价必须是大于或等于0的有效数字，留空则继承货物价格");
      return;
    }
    const freeDaysText = customerPricing.freeDays.trim();
    const freeDays = freeDaysText ? Number(freeDaysText) : null;
    if (freeDays !== null && (!Number.isSafeInteger(freeDays) || freeDays < 0 || freeDays > 36_500)) {
      setError("免租天数必须是0到36500之间的整数，留空则继承货物设置");
      return;
    }
    setBusyKey("customer-settings");
    setError("");
    try {
      const payload = await fetchPayload(
        customerSettingsEndpoint,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            customerName: selectedCustomer,
            ratePerM3Day: rate,
            freeDays,
          }),
        },
        "客户计价规则保存失败",
      );
      const next = extractCustomerPricing(payload);
      setCustomerPricing(next);
      setSavedCustomerPricing(next);
      await loadReport();
      announce(rate === null && next.freeDays === ""
        ? `已清除“${selectedCustomer}”的专属规则，账单将继承各货物价格`
        : `已保存“${selectedCustomer}”的专属计价规则`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "客户计价规则保存失败");
    } finally {
      setBusyKey("");
    }
  };

  const exportReport = () => {
    if (selectedCustomers.length === 0) {
      setError("请先选择要生成本期账单的客户");
      return;
    }
    if (customerPricingLoading) {
      setError("客户计价规则仍在读取，请稍后再生成账单");
      return;
    }
    if (customerPricingDirty) {
      setError("客户计价规则有未保存修改，请先保存后再生成账单");
      return;
    }
    if ((invoiceEligibleRows.length === 0 && pendingInvoiceCount === 0 && pricingReviewCount === 0)) {
      setError("当前客户、账期和库存状态下没有可导出明细");
      return;
    }
    const separator = exportEndpoint.includes("?") ? "&" : "?";
    const params = new URLSearchParams({
      source: "return",
      fromMonth: appliedPeriod.fromMonth,
      toMonth: appliedPeriod.toMonth,
      inventoryStatus: inventoryFilter,
    });
    selectedCustomers.forEach((customer) => params.append("customer", customer));
    window.location.assign(`${exportEndpoint}${separator}${params.toString()}`);
  };

  const saveSettings = async () => {
    setBusyKey("settings");
    setError("");
    try {
      const payload = await fetchPayload(
        settingsEndpoint,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(settings),
        },
        "默认计价设置保存失败",
      );
      const next = extractSettings(payload);
      setSettings(next);
      onDefaultsChange?.(next);
      announce("默认计价设置已保存；现有目录和待结算记录仍保留各自价格");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "默认计价设置保存失败");
    } finally {
      setBusyKey("");
    }
  };

  return (
    <section className={styles.workspace}>
      <header className={styles.hero}>
        <div>
          <p>STORAGE PRICING</p>
          <h2>仓储费计价</h2>
        </div>
        <div className={styles.heroActions}>
          <strong>${decimal(settings.defaultRatePerM3Day, 4)} / m³ / 天</strong>
          <a className={styles.heroLink} href="/pricing/catalog" target="_blank" rel="noreferrer">
            单独打开 Excel 产品目录 ↗
          </a>
        </div>
      </header>

      <nav className={styles.tabs} aria-label="入库来源计价切换">
        <button
          className={sourceTab === "return" ? styles.activeTab : ""}
          type="button"
          onClick={() => setSourceTab("return")}
        >
          退货入库计价
        </button>
        <button
          className={sourceTab === "domestic" ? styles.activeTab : ""}
          type="button"
          onClick={() => setSourceTab("domestic")}
        >
          国内入库
        </button>
      </nav>

      {sourceTab === "domestic" ? (
        <section className={styles.domesticNotice}>
          <h3>国内入库暂不计费</h3>
          <p>系统会保留“国内入库”来源，方便以后启用独立标准；当前不会进入待结算和费用合计。</p>
        </section>
      ) : (
        <>
          <details className={`${styles.domesticNotice} ${styles.defaultSettings}`}>
            <summary>默认计价设置 · ${decimal(settings.defaultRatePerM3Day,4)} / m³ / 天 · 免租 {settings.defaultFreeDays} 天</summary>
            <p>新退货记录默认采用这里的价格；产品目录请在独立页面下载 Excel、修改后重新上传。</p>
            <div className={styles.overrideGrid}>
              <label>
                <span>默认单价（$/m³/天）</span>
                <PricingNumberInput
                  disabled={!canEdit || busyKey === "settings"}
                  value={settings.defaultRatePerM3Day}
                  onValue={(value) => setSettings((current) => ({ ...current, defaultRatePerM3Day: value }))}
                />
              </label>
              <label>
                <span>默认免租天数</span>
                <PricingNumberInput
                  integer
                  disabled={!canEdit || busyKey === "settings"}
                  value={settings.defaultFreeDays}
                  onValue={(value) => setSettings((current) => ({ ...current, defaultFreeDays: value }))}
                />
              </label>
              {canEdit && (
                <div className={styles.panelActions}>
                  <button
                    className={styles.primaryButton}
                    type="button"
                    disabled={busyKey === "settings"}
                    onClick={saveSettings}
                  >
                    {busyKey === "settings" ? "保存中…" : "保存默认设置"}
                  </button>
                </div>
              )}
            </div>
          </details>

          <section className={`${styles.panel} ${styles.billingPanel}`}>
            <div>
              <h3>选择账单月份</h3>
              <p>按客户每月出账；免租天数从实际入库日连续计算，不会因切换账期重新开始；当前月份只计算已经完成的存放日。</p>
            </div>
            <div className={styles.monthFields}>
              <label className={styles.monthField}>
                <span>开始月份</span>
                <input
                  type="month"
                  min="1970-01"
                  max={initialMonth}
                  value={periodDraft.fromMonth}
                  onChange={(event) => setPeriodDraft((current) => ({ ...current, fromMonth: event.target.value }))}
                />
              </label>
              <label className={styles.monthField}>
                <span>结束月份</span>
                <input
                  type="month"
                  min="1970-01"
                  max={initialMonth}
                  value={periodDraft.toMonth}
                  onChange={(event) => setPeriodDraft((current) => ({ ...current, toMonth: event.target.value }))}
                />
              </label>
              <button
                className={styles.primaryButton}
                type="button"
                disabled={loading || !!busyKey}
                onClick={applyBillingPeriod}
              >
                {busyKey === "period" ? "读取中…" : "应用账期"}
              </button>
            </div>
          </section>

          <section className={styles.cards}>
            <article className={styles.statCard}>
              <span>本期在库记录</span>
              <strong>{inStockCount}</strong>
            </article>
            <article className={styles.statCard}>
              <span>本期已出库记录</span>
              <strong>{outboundCount}</strong>
            </article>
            <article className={styles.statCard}>
              <span>累计计费天数</span>
              <strong>{periodBillableDays} 天</strong>
            </article>
            <article className={styles.statCard}>
              <span>本期可出账金额</span>
              <strong>{pricingReviewCount>0&&invoiceEligibleRows.length===0?"待核对":currency(periodFeeUsd)}</strong>{pricingReviewCount>0&&<small>{pricingReviewCount} 条费用待核对，未计入可出账金额</small>}
              {pendingPeriodFeeUsd > 0 && <small>另有待确认 {currency(pendingPeriodFeeUsd)}</small>}
            </article>
          </section>

          {error && <p className={styles.error}>{error}</p>}
          {message && <p className={styles.success}>{message}</p>}

          <section className={styles.panel}>
            <header className={styles.panelHead}>
              <div>
                <h3>仓储费明细 · 产品汇总</h3>
                <p>{monthLabel(appliedPeriod.fromMonth)}至{monthLabel(appliedPeriod.toMonth)}，按产品汇总，同产品各原批次分别按自身日期、数量、体积、费率和免租期计算，展开可核对。</p>
                <p>出库计价按原入库批次先进先出。下表库位和数量属于计价批次；实际取货库位及余量请在库存或货物出库中查看。</p>
              </div>
              <div className={styles.panelActions}>
                <details className={styles.customerPicker}>
                  <summary>{selectedCustomers.length === 0 ? "选择客户（可多选）" : selectedCustomers.join("、")}</summary>
                  <div className={styles.customerChoices} role="group" aria-label="按客户筛选仓储费明细 · 产品汇总">
                    <button type="button" className={styles.secondaryButton} disabled={!!busyKey || selectedCustomers.length === 0} onClick={() => chooseCustomers([])}>清空选择</button>
                    {[...new Set([...customerOptions, ...selectedCustomers])].map((customer) => (
                      <label key={customer}>
                        <input type="checkbox" checked={selectedCustomers.includes(customer)} disabled={!!busyKey}
                          onChange={(event) => chooseCustomers(event.target.checked
                            ? [...selectedCustomers, customer]
                            : selectedCustomers.filter((name) => name !== customer))} />
                        <span>{customer}</span>
                      </label>
                    ))}
                  </div>
                </details>
                <button
                  className={styles.primaryButton}
                  type="button"
                  disabled={selectedCustomers.length === 0 || customerPricingLoading || customerPricingDirty || (invoiceEligibleRows.length === 0 && pendingInvoiceCount === 0 && pricingReviewCount === 0) || !!busyKey}
                  onClick={exportReport}
                >
                  生成本期{exportScopeLabel}账单Excel
                </button>
                {selectedCustomer && customerPricingDirty && (
                  <small className={styles.exportNote}>客户专属规则尚未保存，保存后才能生成账单。</small>
                )}
                {selectedCustomers.length > 0 && pendingInvoiceCount > 0 && (
                  <small className={styles.exportNote}>{pendingInvoiceCount} 条待确认出库将列入未确认工作表，并计算费用。</small>
                )}
                {selectedCustomers.length > 0 && (invoiceEligibleRows.length === 0 && pendingInvoiceCount === 0 && pricingReviewCount === 0) && (
                  <small className={styles.exportNote}>当前筛选没有可导出明细。</small>
                )}
              </div>
            </header>
            <div className={styles.detailFilters}>
              <b>库存状态</b>
              <div className={styles.filterButtons} role="group" aria-label="筛选在库或已出库记录">
                {([
                  ["all", "全部"],
                  ["in_stock", "在库"],
                  ["outbound", "已出库"],
                  ["corrected", "库存修正"],
                ] as const).map(([value, label]) => (
                  <button
                    key={value}
                    className={inventoryFilter === value ? styles.activeFilter : styles.filterButton}
                    type="button"
                    aria-pressed={inventoryFilter === value}
                    onClick={() => { setInventoryFilter(value); setSelectedCustomerRows([]); setReportExpanded(false); }}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className={styles.customerRuleEditor} aria-label="客户专属计价规则">
                <label>
                  <span>客户日费率（$/m³/天）</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    disabled={!selectedCustomer || customerPricingLoading || !!busyKey}
                    placeholder={selectedCustomer ? "空＝继承货物价格" : "先选择客户"}
                    value={customerPricing.ratePerM3Day}
                    onChange={(event) => {
                      const next = event.target.value.trim();
                      if (/^\d*(?:\.\d*)?$/.test(next)) {
                        setCustomerPricing((current) => ({ ...current, ratePerM3Day: next }));
                      }
                    }}
                  />
                </label>
                <label>
                  <span>免租天数</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    min="0"
                    max="36500"
                    step="1"
                    disabled={!selectedCustomer || customerPricingLoading || !!busyKey}
                    placeholder={selectedCustomer ? "空＝继承货物免租天数" : "先选择客户"}
                    value={customerPricing.freeDays}
                    onChange={(event) => {
                      const next = event.target.value.trim();
                      if (/^\d*$/.test(next)) {
                        setCustomerPricing((current) => ({ ...current, freeDays: next }));
                      }
                    }}
                  />
                </label>
                <button
                  className={styles.secondaryButton}
                  type="button"
                  disabled={!selectedCustomer || customerPricingLoading || !!busyKey || !customerPricingDirty}
                  onClick={saveCustomerPricing}
                >
                  {busyKey === "customer-settings" ? "保存中…" : "保存客户规则"}
                </button>
                <small>{selectedCustomer
                  ? "免租天数从每条货物的实际入库日开始连续计算；例如填30天，前30天不计费，第31天起计费。"
                  : selectedCustomers.length > 1 ? "多选时沿用各客户规则；单选可修改价格。" : "选择一个客户后可设置专属价格和免租天数。"}</small>
              </div>
              {(canEditStockCustomer || canEdit) && (
                <div className={styles.customerBatchActions}>
                  <label><input type="checkbox" aria-label="全选当前筛选记录" disabled={!!busyKey || !selectableCustomerRows.length}
                    checked={selectableCustomerRows.length > 0 && selectableCustomerRows.every(row => selectedCustomerRows.some(selected => customerRowKey(selected) === customerRowKey(row)))}
                    onChange={event => setSelectedCustomerRows(event.target.checked ? selectableCustomerRows : [])} />全选当前筛选记录</label>
                  <span>已选 {selectedCustomerRows.length} 条</span>
                  <button type="button" className={styles.secondaryButton} disabled={!!busyKey || !selectedCustomerRows.length}
                    onClick={() => { setEditingCustomer(null); setBatchCustomerRows([...selectedCustomerRows]); setCustomerDraft(""); setError(""); }}>批量修改客户</button>
                  <button type="button" className={styles.tinyButton} disabled={!!busyKey || !selectedCustomerRows.length} onClick={() => setSelectedCustomerRows([])}>清空勾选</button>
                </div>
              )}
              <span className={styles.filterSummary}>
                当前显示 {displayedPricingProducts.length} / {pricingProducts.length} 个产品 · {visibleReportRows.length} 个原批次
              </span>
              {visibleReportRows.length > REPORT_PREVIEW_LIMIT && (
                <button
                  className={styles.collapseButton}
                  type="button"
                  aria-expanded={reportExpanded}
                  aria-controls="monthly-report-body"
                  onClick={() => setReportExpanded((current) => !current)}
                >
                  {reportExpanded ? `收起至前 ${REPORT_PREVIEW_LIMIT} 条` : `展开全部 ${visibleReportRows.length} 条`}
                </button>
              )}
            </div>
            <div className={`${styles.tableWrap} ${styles.monthlyTableWrap}`}>
              <table className={`${styles.reportTable} ${styles.monthlyTable}`}>
                <colgroup>
                  <col className={styles.monthlyStatusColumn} />
                  <col className={styles.monthlyLocationColumn} />
                  <col className={styles.monthlyCustomerColumn} />
                  <col className={styles.monthlyIdentifierColumn} /><col className={styles.monthlyIdentifierColumn} />
                  <col className={styles.monthlyProductColumn} />
                  <col className={styles.monthlyDatesColumn} />
                  <col className={styles.monthlyQuantityColumn} />
                  <col className={styles.monthlyVolumeColumn} />
                  <col className={styles.monthlyDaysColumn} />
                  <col className={styles.monthlyPriceColumn} />
                </colgroup>
                <thead>
                  <tr>
                    <th>状态</th>
                    <th>原批次库位</th>
                    <th>客户</th>
                    <th>SKU</th><th>产品条形码</th><th>产品名称</th>
                    <th>入库 / 出库</th>
                    <th>计价方式 / 数量</th>
                    <th>总体积</th>
                    <th>计费日 / 在库天数</th>
                    <th>计费价格</th>
                  </tr>
                </thead>
                <tbody id="monthly-report-body">
                  {displayedPricingProducts.map(group=><Fragment key={group.key}><tr className={styles.productSummary}><td colSpan={11}><div className={styles.productSummaryContent}><div><b>{group.productName}</b><span>{group.customerName||'商家未填写'} · SKU {group.sku||'无'}</span><small>在库 {group.inStockQuantity}件 / {group.inStockBoxes}箱 · 已出库 {group.outboundQuantity}件 / {group.outboundBoxes}箱 · 修正减少 {group.correctedQuantity}件 / {group.correctedBoxes}箱 · {group.rows.length} 个原计价批次</small></div><div><b>本期 {group.pricingReviewRows?"待核对":currency(group.feeUsd)}</b>{group.pricingReviewRows>0&&<small>已核对 {currency(group.feeUsd)} · 另有 {group.pricingReviewRows} 条待核对</small>}{group.pendingFeeUsd>0&&<small>另有待确认 {currency(group.pendingFeeUsd)}</small>}<button type="button" aria-expanded={expandedPricingProducts.includes(group.key)} onClick={()=>setExpandedPricingProducts(keys=>keys.includes(group.key)?keys.filter(k=>k!==group.key):[...keys,group.key])}>{expandedPricingProducts.includes(group.key)?'收起原批次':'查看原计价批次'}</button></div></div></td></tr>{expandedPricingProducts.includes(group.key)&&group.rows.map((row) => (
                    <tr key={`${row.inventoryStatus}-${String(row.id)}`}>
                      <td data-label="状态">
                        <div className={`${styles.monthlyCellContent} ${styles.statusStack}`}>
                          {canChangeCustomer(row) && <input type="checkbox" aria-label={`勾选货物：${row.locationCode} · ${row.productName}`} disabled={!!busyKey} checked={selectedCustomerRows.some(selected => customerRowKey(selected) === customerRowKey(row))} onChange={event => setSelectedCustomerRows(current => event.target.checked ? [...current.filter(selected => customerRowKey(selected) !== customerRowKey(row)), row] : current.filter(selected => customerRowKey(selected) !== customerRowKey(row)))} />}
                          <span className={`${styles.statusBadge} ${row.inventoryStatus === "in_stock" ? styles.inStockBadge : styles.outboundBadge}`}>
                            {row.inventoryStatus === "in_stock" ? "在库" : row.inventoryStatus==='corrected'?'库存修正':'已出库'}
                          </span>
                          {row.settlementStatus && (
                            <span className={`${styles.settlementBadge} ${row.settlementStatus === "pending" ? styles.pendingBadge : styles.settledBadge}`}>
                              {row.settlementStatus === "pending" ? "待确认" : "已确认"}
                            </span>
                          )}
                        </div>
                      </td>
                      <td data-label="原批次库位"><div className={styles.monthlyCellContent}><b>{row.locationCode || "—"}</b></div></td>
                      <td data-label="客户"><div className={styles.monthlyCellContent}><b>{row.customerName || "未填写客户"}</b>{canChangeCustomer(row) && <button className={styles.tinyButton} type="button" disabled={!!busyKey} aria-label={`修改客户：${row.productName}`} onClick={() => { setBatchCustomerRows(null); setEditingCustomer(row); setCustomerDraft(row.customerName); setError(""); }}>编辑</button>}</div></td>
                      <td data-label="SKU"><div className={styles.monthlyCellContent}>{row.sku || "—"}</div></td><td data-label="产品条形码"><div className={styles.monthlyCellContent}>{row.barcode || "—"}</div></td>
                      <td data-label="产品名称">
                        <div className={`${styles.monthlyCellContent} ${styles.compactStack}`}>
                          <b>{row.productName || "未命名"}</b>
                          <span className={styles.productDetail}><strong>入库单号：</strong>{row.inboundOrder || "—"}</span>
                          <span className={styles.productDetail}><strong>备注：</strong>{row.note || "—"}</span>
                        </div>
                      </td>
                      <td data-label="入库 / 出库">
                        <div className={`${styles.monthlyCellContent} ${styles.compactStack}`}>
                          <span className={styles.compactLine}><b>入</b> {row.inboundDate || "—"}</span>
                          <span className={`${styles.muted} ${styles.compactLine}`}><b>{row.inventoryStatus==='corrected'?'修正':'出'}</b> {row.inventoryStatus==='corrected'?row.correctionDate:row.outboundDate || "仍在库"}</span>
                        </div>
                      </td>
                      <td data-label="计价方式 / 数量">
                        <div className={`${styles.monthlyCellContent} ${styles.compactStack}`}>
                          <b>{row.billingMode === "box" ? "按箱" : "按件"}</b>
                          <span className={styles.muted}>{decimal(row.billedQuantity, 3)}</span>
                        </div>
                      </td>
                      <td data-label="总体积">
                        <div className={`${styles.monthlyCellContent} ${styles.volumeEditCell}`}>
                          <span>{decimal(row.totalVolumeM3)} m³</span>
                          {row.inventoryStatus === "in_stock" && canEdit && (
                            <button className={styles.inlineEditButton} type="button" disabled={!!busyKey} onClick={() => openStockVolumeEditor(row)}>编辑</button>
                          )}
                        </div>
                      </td>
                      <td data-label="计费日 / 在库天数">
                        <div className={`${styles.monthlyCellContent} ${styles.compactStack}`}>
                          <b>计费 {row.periodBillableDays} 天</b>
                          <span className={`${styles.muted} ${styles.compactLine}`} title={row.chargeStartDate ? `${row.chargeStartDate} 起计` : undefined}>在库 {row.periodStorageDays} 天</span>
                        </div>
                      </td>
                      <td data-label="计费价格">
                        <div className={`${styles.monthlyCellContent} ${styles.priceSummary}`}>
                          <div className={styles.priceGrid}>
                            <span><small>日费</small><b>{row.pricingReview?"待核对":currency(row.totalVolumeM3 * row.ratePerM3Day)} / 天</b></span>
                            <span><small>本期</small><b>{row.pricingReview?"待核对":currency(row.periodFeeUsd)}</b></span>
                          </div>
                          <span className={`${styles.muted} ${styles.priceMeta}`}>费率 ${decimal(row.ratePerM3Day, 3)} / m³ / 天 · 免租 {row.freeDays} 天</span>
                          {row.customerPricingApplied && (
                            <span className={styles.customerRuleBadge}>
                              客户规则{row.customerFreeDaysOverride !== null ? ` · 免租 ${row.customerFreeDaysOverride} 天` : ""}
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}</Fragment>)}
                </tbody>
              </table>
              {loading && <p className={styles.emptyState}>正在读取本期仓储费…</p>}
              {!loading && !visibleReportRows.length && <p className={styles.emptyState}>当前账期和筛选条件下没有仓储费记录</p>}
            </div>
          </section>

          <section className={styles.panel}>
            <header className={styles.panelHead}>
              <div>
                <h3>待处理出库计价</h3>
                <p>这里只显示尚未处理的商品。确认后进入正式计价记录；取消后从这里移除，并保留在下方“计价操作记录”中。</p>
              </div>
              <button
                className={styles.secondaryButton}
                type="button"
                disabled={loading}
                onClick={() => {
                  setLoading(true);
                  setError("");
                  loadReport()
                    .catch((reason) => setError(reason instanceof Error ? reason.message : "刷新失败"))
                    .finally(() => setLoading(false));
                }}
              >
                刷新费用
              </button>
            </header>
            <div className={styles.settlementToolbar}>
              <span className={styles.pendingSummary}>待处理 {pendingRows.length} 条</span>
              <label className={styles.selectAllSettlements}>
                <input
                  type="checkbox"
                  checked={pendingRows.length > 0 && pendingRows.every((row) => selectedSettlementIds.includes(String(row.settlementId)))}
                  onChange={(event) => {
                    const visibleIds = pendingRows.map((row) => String(row.settlementId));
                    setSelectedSettlementIds((current) => event.target.checked
                      ? [...new Set([...current, ...visibleIds])]
                      : current.filter((id) => !visibleIds.includes(id)));
                  }}
                />
                选择当前列表（已选 {selectedSettlementIds.length}）
              </label>
              {canEdit && (
                <div className={styles.batchSettlementActions}>
                  <button type="button" disabled={!!busyKey || selectedSettlementIds.length === 0} onClick={() => runSettlementBatch("confirm")}>
                    {busyKey === "batch-confirm" ? "确认中…" : "批量确认出库计价"}
                  </button>
                  <button className={styles.dangerButton} type="button" disabled={!!busyKey || selectedSettlementIds.length === 0} onClick={() => runSettlementBatch("cancel")}>
                    {busyKey === "batch-cancel" ? "取消中…" : "批量取消出库计价"}
                  </button>
                </div>
              )}
            </div>
            <div className={styles.tableWrap}>
              <table className={styles.settlementTable}>
                <thead>
                  <tr>
                    <th>选择</th>
                    <th>计价状态</th>
                    <th>出库 / 库位</th>
                    <th>客户</th>
                    <th>SKU</th><th>产品条形码</th><th>产品名称</th>
                    <th>方式 / 数量</th>
                    <th>总体积</th>
                    <th>计费参数</th>
                    <th>整段确认总价</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {pendingRows.map((row) => (
                      <tr key={String(row.id)}>
                        <td><input type="checkbox" aria-label={`选择 ${row.productName || "未命名货物"}`} disabled={row.pricingReview} checked={selectedSettlementIds.includes(String(row.settlementId))} onChange={(event) => changeSettlementSelection(String(row.settlementId), event.target.checked)} /></td>
                        <td><span className={`${styles.settlementBadge} ${styles.pendingBadge}`}>待处理</span></td>
                        <td>{row.outboundDate || "—"}<br /><span className={styles.muted}>{row.locationCode || "—"}</span></td>
                        <td><b>{row.customerName || "未填写客户"}</b></td>
                        <td>{row.sku || "—"}</td><td>{row.barcode || "—"}</td><td><b>{row.productName || "未命名"}</b></td>
                        <td>{row.billingMode === "box" ? "按箱" : "按件"}<br /><span className={styles.muted}>{decimal(row.billedQuantity, 3)}</span></td>
                        <td>{decimal(row.totalVolumeM3)} m³</td>
                        <td><b>${decimal(row.ratePerM3Day, 4)} / m³ / 天</b><br /><span className={styles.muted}>免 {row.freeDays} 天 · 计费 {row.billableDays} 天</span></td>
                        <td><b className={styles.moneyValue}>{row.pricingReview?"待核对":currency(row.feeUsd)}</b>{row.pricingReview&&<small>{row.pricingReviewReason||"请先核对计价依据"}</small>}</td>
                        <td>
                          <div className={styles.rowActions}>
                            <button className={styles.tinyButton} type="button" disabled={!canEdit || !!busyKey} onClick={() => openSettlementEditor(row)}>编辑</button>
                            <button className={styles.primaryButton} type="button" disabled={!canEdit || !!busyKey || row.pricingReview} onClick={() => confirmSettlement(row)}>{busyKey === `settle-${row.settlementId}` ? "确认中" : "确认出库计价"}</button>
                            <button className={styles.dangerButton} type="button" disabled={!canEdit || !!busyKey} onClick={() => cancelSettlementPricing(row)}>{busyKey === `cancel-${row.settlementId}` ? "取消中" : "取消出库计价"}</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
              {!loading && !pendingRows.length && <p className={styles.emptyState}>当前没有待处理的退货出库计价</p>}
            </div>
          </section>

          <section className={`${styles.panel} ${styles.historyPanel}`}>
            <button
              className={styles.historyToggle}
              type="button"
              aria-expanded={historyExpanded}
              aria-controls="pricing-operation-history"
              onClick={() => setHistoryExpanded((current) => !current)}
            >
              <span>
                <b>计价操作记录</b>
                <small>查看已确认和已取消的商品；误取消时可撤销取消</small>
              </span>
              <span className={styles.historyCounts}>
                已确认 {settledRows.length} · 已取消 {cancelledRows.length}
                <i aria-hidden="true">{historyExpanded ? "收起 ↑" : "展开 ↓"}</i>
              </span>
            </button>
            {historyExpanded && (
              <div id="pricing-operation-history" className={styles.historyContent}>
                <div className={styles.historyFilterBar}>
                  <div className={styles.filterButtons} aria-label="计价操作记录筛选">
                    {([["all", `全部 ${historyRows.length}`], ["settled", `已确认 ${settledRows.length}`], ["cancelled", `已取消 ${cancelledRows.length}`]] as const).map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        className={historyFilter === value ? styles.activeFilter : styles.filterButton}
                        aria-pressed={historyFilter === value}
                        onClick={() => setHistoryFilter(value)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className={styles.tableWrap}>
                  <table className={`${styles.settlementTable} ${styles.historyTable}`}>
                    <thead>
                      <tr>
                        <th>计价状态</th>
                        <th>出库 / 库位</th>
                        <th>客户</th>
                        <th>SKU</th><th>产品条形码</th><th>产品名称</th>
                        <th>方式 / 数量</th>
                        <th>计费参数</th>
                        <th>整段价格</th>
                        <th>记录信息</th>
                        <th>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleHistoryRows.map((row) => {
                        const cancelled = row.settlementStatus === "cancelled";
                        return (
                          <tr key={`history-${String(row.id)}`}>
                            <td>
                              <span className={`${styles.settlementBadge} ${cancelled ? styles.cancelledBadge : styles.settledBadge}`}>
                                {cancelled ? "已取消" : "已确认"}
                              </span>
                            </td>
                            <td>{row.outboundDate || "—"}<br /><span className={styles.muted}>{row.locationCode || "—"}</span></td>
                            <td><b>{row.customerName || "未填写客户"}</b></td>
                            <td>{row.sku || "—"}</td><td>{row.barcode || "—"}</td><td><b>{row.productName || "未命名"}</b></td>
                            <td>{row.billingMode === "box" ? "按箱" : "按件"}<br /><span className={styles.muted}>{decimal(row.billedQuantity, 3)}</span></td>
                            <td><b>${decimal(row.ratePerM3Day, 4)} / m³ / 天</b><br /><span className={styles.muted}>免 {row.freeDays} 天 · 计费 {row.billableDays} 天</span></td>
                            <td><b className={styles.moneyValue}>{row.pricingReview?"待核对":currency(row.feeUsd)}</b>{row.pricingReview&&<small>{row.pricingReviewReason||"请先核对计价依据"}</small>}</td>
                            <td>
                              {cancelled ? (
                                <span className={styles.muted}>取消前：{row.settledAt ? "已确认" : "待确认"}</span>
                              ) : (
                                <><span className={styles.muted}>确认：{warehouseDateTime(row.settledAt)}</span>{row.settledBy && <><br /><span className={styles.muted}>操作人：{row.settledBy}</span></>}</>
                              )}
                            </td>
                            <td>
                              {cancelled ? (
                                <button className={styles.restoreButton} type="button" disabled={!canEdit || !!busyKey} onClick={() => restoreCancelledSettlement(row)}>
                                  {busyKey === `restore-${row.settlementId}` ? "恢复中" : "撤销取消"}
                                </button>
                              ) : (
                                <button className={styles.dangerButton} type="button" disabled={!canEdit || !!busyKey} onClick={() => cancelSettlementPricing(row)}>
                                  {busyKey === `cancel-${row.settlementId}` ? "取消中" : "取消出库计价"}
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {!loading && !visibleHistoryRows.length && <p className={styles.emptyState}>当前筛选下没有计价操作记录</p>}
                </div>
              </div>
            )}
          </section>
          {(editingCustomer || batchCustomerRows) && (
            <div className={styles.settlementModalBackdrop} role="presentation">
              <section className={styles.settlementModal} role="dialog" aria-modal="true" aria-labelledby="stock-customer-title">
                <header><div><h3 id="stock-customer-title">{batchCustomerRows ? "批量修改客户" : "修改客户"}</h3><span>{batchCustomerRows ? `已选 ${batchCustomerRows.length} 条记录` : `${editingCustomer?.locationCode} · ${editingCustomer?.productName}`}</span></div>
                  <button type="button" aria-label="关闭客户编辑" disabled={!!busyKey} onClick={() => { setEditingCustomer(null); setBatchCustomerRows(null); }}>×</button>
                </header>
                <div className={styles.settlementEditGrid}><label><span>客户名称</span>
                  <input autoFocus list="billing-customer-names" maxLength={200} value={customerDraft} disabled={!!busyKey} onChange={event => setCustomerDraft(event.target.value)} />
                </label></div>
                <datalist id="billing-customer-names">{customerOptions.map(name => <option key={name} value={name} />)}</datalist>
                <p className={styles.settlementFormulaNote}>{batchCustomerRows ? `将选中的 ${batchCustomerRows.length} 条记录统一修改为此客户。在库重新计价，出库保留原计价。` : editingCustomer?.inventoryStatus === "outbound" ? "仅修改客户名称，保留出库数量、日期及原计价。" : "仅修改这条在库货物，并按新客户规则重新计价。"}</p>
                {error && <p role="alert">{error}</p>}
                <div className={styles.settlementModalActions}>
                  <button type="button" disabled={!!busyKey} onClick={() => { setEditingCustomer(null); setBatchCustomerRows(null); }}>取消</button>
                  <button className={styles.primaryButton} type="button" disabled={!!busyKey || !customerDraft.trim()} onClick={saveStockCustomer}>{busyKey === "stock-customer" ? "保存中…" : "保存客户"}</button>
                </div>
              </section>
            </div>
          )}
          {editingStockVolume && (
            <div className={styles.settlementModalBackdrop} role="presentation">
              <section className={styles.settlementModal} role="dialog" aria-modal="true" aria-labelledby="stock-volume-editor-title">
                <header>
                  <div>
                    <p>IN-STOCK PRICING</p>
                    <h3 id="stock-volume-editor-title">编辑在库货物体积</h3>
                    <span>{editingStockVolume.customerName || "未填写客户"} · {editingStockVolume.productName || "未命名货物"}</span>
                  </div>
                  <button type="button" aria-label="关闭在库体积编辑" disabled={!!busyKey} onClick={() => { setEditingStockVolume(null); setStockVolumeDraft(0); }}>×</button>
                </header>
                <div className={styles.settlementEditSummary}>
                  <span>库位 {editingStockVolume.locationCode || "—"}</span>
                  <span>{editingStockVolume.billingMode === "box" ? "箱数" : "件数"} {decimal(editingStockVolume.billedQuantity, 3)}</span>
                  <span>总体积 {decimal(stockVolumePreview)} m³</span>
                </div>
                <div className={`${styles.settlementEditGrid} ${styles.singleEditGrid}`}>
                  <label>
                    <span>{editingStockVolume.billingMode === "box" ? "每箱体积（m³）" : "每件体积（m³）"}</span>
                    <PricingNumberInput disabled={!!busyKey} value={stockVolumeDraft} onValue={setStockVolumeDraft} />
                  </label>
                </div>
                <p className={styles.settlementFormulaNote}>保存后会按“{editingStockVolume.billingMode === "box" ? "箱数 × 每箱体积" : "件数 × 每件体积"}”重新计算总体积和本期仓储费。</p>
                <div className={styles.settlementModalActions}>
                  <button type="button" disabled={!!busyKey} onClick={() => { setEditingStockVolume(null); setStockVolumeDraft(0); }}>取消</button>
                  <button className={styles.primaryButton} type="button" disabled={!!busyKey} onClick={saveStockVolumeEditor}>{busyKey.startsWith("stock-volume-") ? "保存中…" : "保存体积"}</button>
                </div>
              </section>
            </div>
          )}
          {editingSettlement && settlementDraft && editingPreview && (
            <div className={styles.settlementModalBackdrop} role="presentation">
              <section className={styles.settlementModal} role="dialog" aria-modal="true" aria-labelledby="settlement-editor-title">
                <header>
                  <div>
                    <p>OUTBOUND PRICING</p>
                    <h3 id="settlement-editor-title">单独编辑出库计价</h3>
                    <span>{editingSettlement.customerName || "未填写客户"} · {editingSettlement.productName || "未命名货物"}</span>
                  </div>
                  <button type="button" aria-label="关闭出库计价编辑" disabled={!!busyKey} onClick={() => { setEditingSettlementId(null); setSettlementDraft(null); }}>×</button>
                </header>
                <div className={styles.settlementEditSummary}>
                  <span>入库 {editingSettlement.inboundDate}</span>
                  <span>库位 {editingSettlement.locationCode || "—"}</span>
                  <span>总体积 {decimal(editingPreview.totalVolumeM3)} m³</span>
                </div>
                <div className={styles.settlementEditGrid}>
                  <label>
                    <span>计价出库日期</span>
                    <input type="date" min={editingSettlement.inboundDate} max={currentWarehouseDate()} value={settlementDraft.outboundDate} disabled={!!busyKey} onChange={(event) => setSettlementDraft((current) => current ? { ...current, outboundDate: event.target.value } : current)} />
                  </label>
                  <label>
                    <span>{editingSettlement.billingMode === "box" ? "每箱体积（m³）" : "每件体积（m³）"}</span>
                    <PricingNumberInput disabled={!!busyKey} value={settlementDraft.volumePerUnitM3} onValue={(value) => setSettlementDraft((current) => current ? { ...current, volumePerUnitM3: value } : current)} />
                  </label>
                  <label>
                    <span>每日每立方米价格（$/m³/天）</span>
                    <PricingNumberInput disabled={!!busyKey} value={settlementDraft.ratePerM3Day} onValue={(value) => setSettlementDraft((current) => current ? { ...current, ratePerM3Day: value } : current)} />
                  </label>
                  <label>
                    <span>免租天数</span>
                    <PricingNumberInput integer disabled={!!busyKey} value={settlementDraft.freeDays} onValue={(value) => setSettlementDraft((current) => current ? { ...current, freeDays: value } : current)} />
                  </label>
                  <label>
                    <span>整段确认总价（USD）</span>
                    <PricingNumberInput disabled={!!busyKey} value={settlementDraft.feeIsManual ? settlementDraft.feeUsd : editingPreview.feeUsd} onValue={(value) => setSettlementDraft((current) => current ? { ...current, feeUsd: value, feeIsManual: true } : current)} />
                    <button className={styles.formulaResetButton} type="button" disabled={!!busyKey || !settlementDraft.feeIsManual} onClick={() => setSettlementDraft((current) => current ? { ...current, feeUsd: editingPreview.feeUsd, feeIsManual: false } : current)}>恢复公式价 {currency(editingPreview.feeUsd)}</button>
                  </label>
                </div>
                <p className={styles.settlementFormulaNote}>总体积 {decimal(editingPreview.totalVolumeM3)} m³；存放 {editingPreview.storageDays} 天 − 免租 {Math.max(0, Math.trunc(settlementDraft.freeDays))} 天 = 计费 {editingPreview.billableDays} 天。整段确认总价可校正，但正式月度账单仍按“总体积 × 每日价格 × 当月计费天数”计算。</p>
                <div className={styles.settlementModalActions}>
                  <button type="button" disabled={!!busyKey} onClick={() => { setEditingSettlementId(null); setSettlementDraft(null); }}>取消</button>
                  <button type="button" disabled={!!busyKey} onClick={() => saveSettlementEditor(false)}>{busyKey.startsWith("save-") ? "保存中…" : "保存修改"}</button>
                  <button className={styles.primaryButton} type="button" disabled={!!busyKey} onClick={() => saveSettlementEditor(true)}>{busyKey.startsWith("settle-") ? "确认中…" : "保存并确认"}</button>
                </div>
              </section>
            </div>
          )}
        </>
      )}
    </section>
  );
}

export default PricingWorkspace;
