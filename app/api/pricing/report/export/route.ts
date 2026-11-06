import {isLayerStoragePricing} from "../../../../../lib/storage-pricing-basis";
import * as XLSX from "xlsx";
import { requireUser } from "../../../../../lib/auth";
import { withJsonErrors } from "../../../../../lib/api-json";
import { buildStorageFeeReport, type StorageFeeReportRow } from "../../../../../lib/storage-fee-report";
import { inboundSourceLabel, InvalidStorageBillingPeriodError } from "../../../../../lib/pricing";
import {
  buildDetailFormulaCells,
  buildDetailTotalFormulaCells,
  detailTotalHeaders,
  type DetailFormulaHeader,
  type DetailTotalHeader,
} from "../../../../../lib/pricing-export-formulas";

const detailHeaders = [
  "库存状态", "计价状态", "库位", "入库类型", "客户", "SKU", "产品名称", "条形码", "入库单号",
  "入库日期", "出库日期", "修正生效日期", "账期开始", "账期截止", "实际计费开始", "计价来源",
  "计费方式", "件数", "箱数", "计费数量", "每件/箱立方米", "总体积m³", "费率USD/m³/天", "日均仓储费USD",
  "免租天数", "账期存放天数", "账期计费天数", "账期仓储费USD",
];

const detailColumnWidths: Record<string, number> = {
  "库存状态": 10, "计价状态": 10, "库位": 10, "入库类型": 12, "客户": 20, "产品名称": 34,
  "SKU": 18, "条形码": 20, "入库单号": 20, "入库日期": 12, "出库日期": 12, "账期开始": 12,
  "账期截止": 12, "实际计费开始": 14, "计价来源": 16, "计费方式": 10,
  "件数": 10, "箱数": 10, "计费数量": 11, "每件/箱立方米": 16, "总体积m³": 14,
  "费率USD/m³/天": 18, "日均仓储费USD": 16, "免租天数": 11, "账期存放天数": 14,
  "账期计费天数": 14, "账期仓储费USD": 16,
};

function includedPeriodEnd(periodStart: string, periodEndExclusive: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(periodStart) || !/^\d{4}-\d{2}-\d{2}$/.test(periodEndExclusive) || periodStart >= periodEndExclusive) return "";
  const [year, month, day] = periodEndExclusive.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day) - 86_400_000).toISOString().slice(0, 10);
}

function detailValue(row: StorageFeeReportRow) {
  return {
    "库存状态": row.inventoryStatus === "in_stock" ? "在库" : row.inventoryStatus==='corrected'?'库存修正':"已出库",
    "计价状态": row.pricingReview ? "计价资料待核对" : row.settlementStatus === "pending" ? "待确认" : row.settlementStatus === "settled" ? "已确认" : "",
    "库位": row.locationCode,
    "入库类型": `${inboundSourceLabel(row.inboundSource)}入库`,
    "客户": row.customerName,
    "产品名称": row.productName,
    "SKU": row.sku,
    "条形码": row.barcode,
    "入库单号": row.inboundOrder,
    "入库日期": row.inboundDate,
    "出库日期": row.inventoryStatus === "outbound" ? row.endDate : "",
    "修正生效日期":row.inventoryStatus==='corrected'?row.endDate:"",
    "账期开始": row.periodStart,
    "账期截止": includedPeriodEnd(row.periodStart, row.periodEndExclusive),
    "实际计费开始": row.chargeStartDate,
    "计价来源": row.customerPricingApplied ? "客户专属规则" : "货物记录",
    "计费方式": row.billingMode === "box" ? "按箱" : "按件",
    "件数": row.quantity,
    "箱数": row.boxes,
    "计费数量": row.count,
    "每件/箱立方米": row.volumePerCountM3,
    "总体积m³": row.totalVolumeM3,
    "费率USD/m³/天": row.ratePerM3Day,
    "日均仓储费USD": row.pricingReview ? "待核对" : Number((row.totalVolumeM3 * row.ratePerM3Day).toFixed(6)),
    "免租天数": row.freeDays,
    "账期存放天数": row.periodStorageDays,
    "账期计费天数": row.periodBillableDays,
    "账期仓储费USD": row.pricingReview ? "待核对" : row.periodFeeUsd,
  };
}

function sum(rows: StorageFeeReportRow[], value: (row: StorageFeeReportRow) => number, digits: number) {
  return Number(rows.reduce((total, row) => total + value(row), 0).toFixed(digits));
}

function detailFormulaValues(row: StorageFeeReportRow): Record<DetailFormulaHeader, number> {
  return {
    "计费数量": row.count,
    "总体积m³": row.totalVolumeM3,
    "日均仓储费USD": Number((row.totalVolumeM3 * row.ratePerM3Day).toFixed(6)),
    "账期仓储费USD": row.periodFeeUsd,
  };
}

function detailTotalValues(rows: StorageFeeReportRow[]): Record<DetailTotalHeader, number> {
  return {
    "件数": sum(rows, row => row.quantity, 3),
    "箱数": sum(rows, row => row.boxes, 3),
    "计费数量": sum(rows, row => row.count, 3),
    "总体积m³": sum(rows, row => row.totalVolumeM3, 8),
    "日均仓储费USD": sum(rows, row => row.totalVolumeM3 * row.ratePerM3Day, 6),
    "账期仓储费USD": sum(rows, row => row.periodFeeUsd, 6),
  };
}

function detailDataRows(rows: StorageFeeReportRow[]) {
  return rows.map(row => {
    const values = detailValue(row) as Record<string, string | number>;
    return detailHeaders.map(header => values[header] ?? "");
  });
}

function detailTotalRow(rows: StorageFeeReportRow[]) {
  const values = detailTotalValues(rows);
  const cells = Array.from({ length: detailHeaders.length }, () => "" as string | number);
  cells[0] = "合计";
  for (const header of detailTotalHeaders) cells[detailHeaders.indexOf(header)] = values[header];
  return cells;
}

function applyDetailFormulas(sheet: XLSX.WorkSheet, rows: StorageFeeReportRow[], dataStartRow: number) {
  rows.forEach((row, index) => {
    if(row.pricingReview)return;
    Object.assign(sheet, buildDetailFormulaCells(detailHeaders, dataStartRow + index, detailFormulaValues(row)));
  });
  if (rows.length === 0) return;
  const dataEndRow = dataStartRow + rows.length - 1;
  const totalRowNumber = dataEndRow + 1;
  Object.assign(sheet, buildDetailTotalFormulaCells(
    detailHeaders,
    dataStartRow,
    dataEndRow,
    totalRowNumber,
    detailTotalValues(rows),
  ));
}

function detailSheet(rows: StorageFeeReportRow[], unconfirmed = false) {
  const dataRows = detailDataRows(rows);
  if (unconfirmed) for (const [index,cells] of dataRows.entries()) cells[detailHeaders.indexOf("计价状态")] = rows[index].pricingReview ? "计价资料待核对" : "未确认";
  const sheetRows: Array<Array<string | number>> = [
    detailHeaders,
    ...dataRows,
    ...(rows.length ? [detailTotalRow(rows)] : []),
  ];
  const sheet = XLSX.utils.aoa_to_sheet(sheetRows);
  applyDetailFormulas(sheet, rows, 2);
  if(rows.some(row=>row.pricingReview))for(const header of ['日均仓储费USD','账期仓储费USD']){
    sheet[XLSX.utils.encode_cell({r:rows.length+1,c:detailHeaders.indexOf(header)})]={t:'s',v:'待核对'};
  }
  sheet["!cols"] = detailHeaders.map(header => ({ wch: detailColumnWidths[header] || 14 }));
  if (unconfirmed) {
    sheet["!autofilter"] = { ref: `A1:${XLSX.utils.encode_col(detailHeaders.length - 1)}${rows.length + 1}` };
    for (let index = 0; index <= rows.length; index++) {
      for (const header of ["日均仓储费USD", "账期仓储费USD"]) {
        const cell = sheet[XLSX.utils.encode_cell({ r: index + 1, c: detailHeaders.indexOf(header) })];
        if (cell) cell.z = '"$"#,##0.00';
      }
    }
  }
  return sheet;
}

function unconfirmedSummarySheet(inStock: StorageFeeReportRow[], outbound: StorageFeeReportRow[], meta: {
  customer: string; fromMonth: string; toMonth: string; inventoryFilter: string;
}) {
  const sheet = XLSX.utils.aoa_to_sheet([
    ["未确认费用汇总"],
    ["客户", meta.customer, "账期", `${meta.fromMonth} 至 ${meta.toMonth}`, "库存范围", meta.inventoryFilter],
    ["仅供核对；资料缺失的金额与合计待核对；出库仅含待确认记录，不改变确认状态。"],
    ["分类", "记录数", "总体积m³", "账期仓储费USD"],
    ["在库（未确认）", inStock.length, sum(inStock, row => row.totalVolumeM3, 8), sum(inStock, row => row.periodFeeUsd, 6)],
    ["出库（未确认）", outbound.length, sum(outbound, row => row.totalVolumeM3, 8), sum(outbound, row => row.periodFeeUsd, 6)],
    ["合计", inStock.length + outbound.length, sum([...inStock, ...outbound], row => row.totalVolumeM3, 8), sum([...inStock, ...outbound], row => row.periodFeeUsd, 6)],
  ]);
  for (const [index, rows, name] of [[5, inStock, "在库（未确认）"], [6, outbound, "出库（未确认）"]] as const) {
    for (const [target, header] of [["C", "总体积m³"], ["D", "账期仓储费USD"]] as const) {
      const column = XLSX.utils.encode_col(detailHeaders.indexOf(header));
      sheet[`${target}${index}`].f = rows.length ? `SUM('${name}'!${column}2:${column}${rows.length + 1})` : "0";
    }
  }
  for (const column of ["B", "C", "D"]) sheet[`${column}7`].f = `SUM(${column}5:${column}6)`;
  for(const [index,rows] of [[5,inStock],[6,outbound],[7,[...inStock,...outbound]]] as const){
    if(rows.some(row=>row.pricingReview))sheet[`D${index}`]={t:'s',v:'待核对'};
  }
  for (const row of [5, 6, 7]) sheet[`D${row}`].z = '"$"#,##0.00';
  sheet["!cols"] = [{ wch: 25 }, { wch: 22 }, { wch: 22 }, { wch: 25 }, { wch: 14 }, { wch: 18 }];
  sheet["!merges"] = [XLSX.utils.decode_range("A1:F1"), XLSX.utils.decode_range("A3:F3")];
  return sheet;
}

function invoiceDetailSheet(rows: StorageFeeReportRow[], meta: {
  customer: string;
  fromMonth: string;
  toMonth: string;
  inventoryFilter: string;
  excludedPendingRows: number;
}) {
  const detailRows = detailDataRows(rows);
  const sheetRows: Array<Array<string | number>> = [
    ["客户仓储费账单明细"],
    ["客户", meta.customer || "全部客户", "账期", `${meta.fromMonth} 至 ${meta.toMonth}`, "库存范围", meta.inventoryFilter],
    ["计价说明", "在库与已确认出库计入正式账单；待确认出库另列未确认工作表", "待确认未计入正式账单", meta.excludedPendingRows],
    ["每一行对应一个具体产品/批次；合计金额以本表最后一行为准。"],
    detailHeaders,
    ...detailRows,
    ...(rows.length ? [detailTotalRow(rows)] : []),
  ];
  const sheet = XLSX.utils.aoa_to_sheet(sheetRows);
  applyDetailFormulas(sheet, rows, 6);
  sheet["!cols"] = detailHeaders.map(header => ({ wch: detailColumnWidths[header] || 14 }));
  sheet["!merges"] = [
    XLSX.utils.decode_range(`A1:${XLSX.utils.encode_col(detailHeaders.length - 1)}1`),
    XLSX.utils.decode_range(`A4:${XLSX.utils.encode_col(detailHeaders.length - 1)}4`),
  ];
  const headerRow = 5;
  const lastDetailRow = headerRow + detailRows.length;
  sheet["!autofilter"] = { ref: `A${headerRow}:${XLSX.utils.encode_col(detailHeaders.length - 1)}${lastDetailRow}` };
  return sheet;
}

export async function GET(request: Request) {
  return withJsonErrors(async () => {
    const auth = await requireUser(request,"pricing.manage"); if (auth.error) return auth.error;
    if(await isLayerStoragePricing())return Response.json({error:"当前按托层计价，请从仓储计价页面查看或导出托层报告",reportUrl:"/api/pricing/layers/report",exportUrl:"/api/pricing/layers/export"},{status:409,headers:{"cache-control":"no-store"}});
    const params = new URL(request.url).searchParams;
    const hasBillingPeriod = params.has("fromMonth") || params.has("toMonth");
    const customers = [...new Set(params.getAll("customer").map(name => name.trim()).filter(Boolean))];
    if (hasBillingPeriod && customers.length === 0) {
      return Response.json(
        { ok: false, error: "请先选择客户，再生成本期账单" },
        { status: 400, headers: { "cache-control": "no-store" } },
      );
    }
    try {
      const report = await buildStorageFeeReport({
        asOf: params.get("asOf") || undefined,
        fromMonth: hasBillingPeriod && params.has("fromMonth") ? params.get("fromMonth")! : undefined,
        toMonth: hasBillingPeriod && params.has("toMonth") ? params.get("toMonth")! : undefined,
        source: params.get("source") || "return",
        // Preserve old direct download links: without an explicit month range,
        // the endpoint remains an outbound, confirmed-only lifetime export.
        status: hasBillingPeriod ? params.get("status") || undefined : "settled",
        settlementStatus: hasBillingPeriod ? params.get("settlementStatus") || undefined : "settled",
        inventoryStatus: hasBillingPeriod ? params.get("inventoryStatus") || undefined : "outbound",
        customers,
        q: params.get("q") || undefined,
        applyCustomerPricing: hasBillingPeriod,
      });
      const inventoryFilter = report.summary.inventoryStatus === "in_stock"
        ? "仅在库"
        : report.summary.inventoryStatus === "outbound" ? "仅已出库" : "全部";
      // A customer-facing invoice must not freeze an amount that can still be
      // changed in the pending settlement workflow. Current-stock rows can be
      // billed for the selected month; outbound rows require confirmed pricing.
      const unconfirmedInStockRows=report.inStockItems;
      const inStockRows = report.inStockItems.filter(row=>!row.pricingReview);
      const missingBasisRows=report.rows.filter(row=>row.pricingReview);
      const outboundRows = report.outboundItems.filter(row => row.settlementStatus === "settled");
      const correctedRows=report.rows.filter(row=>row.inventoryStatus==='corrected'&&!row.pricingReview);
      const excludedPendingRows = report.outboundItems.filter(row => row.settlementStatus === "pending");
      const invoiceRows = [...inStockRows, ...outboundRows].concat(correctedRows).sort((left, right) =>
        (left.sku || left.productName).localeCompare(right.sku || right.productName, "zh-CN")
        || left.productName.localeCompare(right.productName, "zh-CN")
        || left.inboundDate.localeCompare(right.inboundDate)
        || left.locationCode.localeCompare(right.locationCode, "zh-CN"));
      if (hasBillingPeriod && invoiceRows.length === 0 && excludedPendingRows.length === 0 && missingBasisRows.length===0) {
        return Response.json(
          { ok: false, error: "当前客户、账期和库存状态下没有可导出明细" },
          { status: 400, headers: { "cache-control": "no-store" } },
        );
      }
      const summarySheet = XLSX.utils.json_to_sheet([{
        "账期开始月份": report.summary.fromMonth,
        "账期结束月份": report.summary.toMonth,
        "账期计算开始": report.summary.periodStart,
        "实际计费截止": includedPeriodEnd(report.summary.periodStart, report.summary.periodEndExclusive),
        "客户": report.summary.customer || "全部客户",
        "库存状态筛选": inventoryFilter,
        "出库计价状态": "仅已确认（待确认另列工作表）",
        "客户专属规则": invoiceRows.some(row => row.customerPricingApplied) ? "已应用" : "按货物记录",
        "在库记录数": inStockRows.length,
        "已出库已确认记录数": outboundRows.length,
        "库存修正记录数":correctedRows.length,
        "库存修正账期仓储费USD":sum(correctedRows,row=>row.periodFeeUsd,6),
        "待确认未计入正式账单记录数": excludedPendingRows.length,
        "计价资料待核对记录数":missingBasisRows.length,
        "在库总体积m³": sum(inStockRows, row => row.totalVolumeM3, 8),
        "已出库总体积m³": sum(outboundRows, row => row.totalVolumeM3, 8),
        "在库账期仓储费USD": sum(inStockRows, row => row.periodFeeUsd, 6),
        "已出库账期仓储费USD": sum(outboundRows, row => row.periodFeeUsd, 6),
        "账期仓储费合计USD": sum(invoiceRows, row => row.periodFeeUsd, 6),
      }]);
      summarySheet["!cols"] = Array.from({ length: 16 }, () => ({ wch: 21 }));
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, invoiceDetailSheet(invoiceRows, {
        customer: report.summary.customer,
        fromMonth: report.summary.fromMonth,
        toMonth: report.summary.toMonth,
        inventoryFilter,
        excludedPendingRows: excludedPendingRows.length,
      }), "客户账单明细");
      XLSX.utils.book_append_sheet(workbook, summarySheet, "汇总");
      if(correctedRows.length)XLSX.utils.book_append_sheet(workbook,detailSheet(correctedRows),'库存修正仓储费');
      if (report.summary.inventoryStatus !== "outbound") {
        XLSX.utils.book_append_sheet(workbook, detailSheet(inStockRows), "在库仓储费");
      }
      if (report.summary.inventoryStatus !== "in_stock") {
        XLSX.utils.book_append_sheet(workbook, detailSheet(outboundRows), "已出库仓储费");
      }
      if (hasBillingPeriod) {
        XLSX.utils.book_append_sheet(workbook, unconfirmedSummarySheet(unconfirmedInStockRows, excludedPendingRows, {
          customer: report.summary.customer, fromMonth: report.summary.fromMonth,
          toMonth: report.summary.toMonth, inventoryFilter,
        }), "汇总（未确认）");
        XLSX.utils.book_append_sheet(workbook, detailSheet(excludedPendingRows, true), "出库（未确认）");
        XLSX.utils.book_append_sheet(workbook, detailSheet(unconfirmedInStockRows, true), "在库（未确认）");
      }
      const file = XLSX.write(workbook, { type: "array", bookType: "xlsx", compression: true });
      return new Response(file, {
        headers: {
          "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "content-disposition": hasBillingPeriod
            ? `attachment; filename="storage-fees-${report.summary.fromMonth}-to-${report.summary.toMonth}-${report.summary.inventoryStatus}.xlsx"`
            : `attachment; filename="settled-storage-fees-${report.summary.asOf}.xlsx"`,
          "cache-control": "no-store",
        },
      });
    } catch (error) {
      if (error instanceof InvalidStorageBillingPeriodError) {
        return Response.json(
          { ok: false, error: error.message },
          { status: 400, headers: { "cache-control": "no-store" } },
        );
      }
      throw error;
    }
  }, "仓储费表格下载失败，请稍后重试");
}
