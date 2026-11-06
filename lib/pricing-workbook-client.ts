"use client";

import {
  extractCatalogItems,
  type PricingCatalogItem,
} from "../components/pricing-types";
import {
  prepareCatalogRow,
  type WorkbookRow,
} from "./pricing-workbook";

const IMPORT_BATCH_SIZE = 30;

async function responsePayload(response: Response, fallback: string) {
  const raw = await response.text();
  let payload: Record<string, unknown> = {};
  if (raw.trim()) {
    try {
      payload = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new Error(`${fallback}：服务器回复格式异常`);
    }
  }
  if (!response.ok) {
    throw new Error(typeof payload.error === "string" ? payload.error : fallback);
  }
  return payload;
}

const headerHints = [
  "产品", "商品", "sku", "条码", "客户", "商家", "尺寸", "长度", "宽度", "高度", "体积", "箱", "包装",
];

function text(value: unknown) {
  return String(value ?? "").trim();
}

function headerScore(row: unknown[]) {
  const values = row.map(text).filter(Boolean);
  const combined = values.join(" ").toLocaleLowerCase();
  return values.length * 0.05 + headerHints.reduce(
    (score, hint) => score + (combined.includes(hint) ? 1 : 0),
    0,
  );
}

function rowsFromMatrix(matrix: unknown[][]) {
  const candidates = matrix.slice(0, 20);
  let headerIndex = -1;
  let best = 0;
  candidates.forEach((row, index) => {
    const score = headerScore(row);
    if (row.filter((value) => text(value)).length >= 2 && score > best) {
      headerIndex = index;
      best = score;
    }
  });
  if (headerIndex < 0) {
    headerIndex = matrix.findIndex((row) => row.filter((value) => text(value)).length >= 2);
  }
  if (headerIndex < 0) return [];

  const headers = matrix[headerIndex].map((value, index) => text(value) || `未命名列${index + 1}`);
  return matrix.slice(headerIndex + 1).flatMap((row) => {
    const item = Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ""]));
    return Object.values(item).some((value) => text(value)) ? [item] : [];
  });
}

export async function readPricingWorkbook(file: File): Promise<WorkbookRow[]> {
  const XLSX = await import("xlsx");
  const workbook = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: false });
  return workbook.SheetNames.flatMap((sheetName) => {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) return [];
    const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      defval: "",
      raw: false,
    });
    return rowsFromMatrix(matrix);
  });
}

export async function importPricingWorkbook(
  file: File,
  defaultRatePerM3Day = 0.7,
): Promise<PricingCatalogItem[]> {
  const fallbackRate = Number.isFinite(defaultRatePerM3Day) && defaultRatePerM3Day >= 0
    ? defaultRatePerM3Day
    : 0.7;
  const rows = (await readPricingWorkbook(file))
    .map((row) => prepareCatalogRow(row, fallbackRate))
    .filter((row): row is WorkbookRow => !!row);
  if (!rows.length) throw new Error("Excel 中没有找到可导入的货物数据");

  let imported = 0;
  let updated = 0;
  for (let index = 0; index < rows.length; index += IMPORT_BATCH_SIZE) {
    const response = await fetch("/api/pricing/catalog/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: rows.slice(index, index + IMPORT_BATCH_SIZE) }),
    });
    const payload = await responsePayload(response, `Excel 第 ${index + 1} 行附近导入失败`);
    imported += Number(payload.imported || 0);
    updated += Number(payload.updated || 0);
  }

  const refresh = await fetch("/api/pricing/catalog?limit=500", { cache: "no-store" });
  const payload = await responsePayload(
    refresh,
    `目录已写入（新增 ${imported}，更新 ${updated}），但刷新失败`,
  );
  return extractCatalogItems(payload);
}
