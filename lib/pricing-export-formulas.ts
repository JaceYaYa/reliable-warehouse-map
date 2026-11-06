export const detailFormulaHeaders = [
  "计费数量",
  "总体积m³",
  "日均仓储费USD",
  "账期仓储费USD",
] as const;

export const detailTotalHeaders = [
  "件数",
  "箱数",
  ...detailFormulaHeaders,
] as const;

export type DetailFormulaHeader = (typeof detailFormulaHeaders)[number];
export type DetailTotalHeader = (typeof detailTotalHeaders)[number];

export type NumericFormulaCell = {
  t: "n";
  v: number;
  f: string;
};

function excelColumn(index: number) {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error("Excel列索引无效");
  let value = index + 1;
  let result = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function cellRef(headers: readonly string[], header: string, rowNumber: number) {
  const columnIndex = headers.indexOf(header);
  if (columnIndex < 0) throw new Error(`Excel明细缺少“${header}”列`);
  if (!Number.isSafeInteger(rowNumber) || rowNumber < 1) throw new Error("Excel行号无效");
  return `${excelColumn(columnIndex)}${rowNumber}`;
}

function numericFormulaCell(value: number, formula: string): NumericFormulaCell {
  return { t: "n", v: value, f: formula };
}

/**
 * Build formula cells keyed by their A1 addresses. Column references are
 * resolved from the current header order so exports stay correct if columns
 * are moved later.
 */
export function buildDetailFormulaCells(
  headers: readonly string[],
  rowNumber: number,
  cachedValues: Record<DetailFormulaHeader, number>,
) {
  const billingCount = cellRef(headers, "计费数量", rowNumber);
  const billingMode = cellRef(headers, "计费方式", rowNumber);
  const quantity = cellRef(headers, "件数", rowNumber);
  const boxes = cellRef(headers, "箱数", rowNumber);
  const unitVolume = cellRef(headers, "每件/箱立方米", rowNumber);
  const totalVolume = cellRef(headers, "总体积m³", rowNumber);
  const rate = cellRef(headers, "费率USD/m³/天", rowNumber);
  const dailyFee = cellRef(headers, "日均仓储费USD", rowNumber);
  const billableDays = cellRef(headers, "账期计费天数", rowNumber);
  const inboundSource = cellRef(headers, "入库类型", rowNumber);
  const periodFee = cellRef(headers, "账期仓储费USD", rowNumber);

  return {
    [billingCount]: numericFormulaCell(
      cachedValues["计费数量"],
      `IF(${billingMode}="按箱",${boxes},${quantity})`,
    ),
    [totalVolume]: numericFormulaCell(
      cachedValues["总体积m³"],
      `ROUND(${billingCount}*${unitVolume},8)`,
    ),
    [dailyFee]: numericFormulaCell(
      cachedValues["日均仓储费USD"],
      `ROUND(${totalVolume}*${rate},6)`,
    ),
    [periodFee]: numericFormulaCell(
      cachedValues["账期仓储费USD"],
      `IF(${inboundSource}="退货入库",ROUND(${totalVolume}*${rate}*${billableDays},6),0)`,
    ),
  } satisfies Record<string, NumericFormulaCell>;
}

/** Return an empty map when there are no detail rows, avoiding invalid ranges. */
export function buildDetailTotalFormulaCells(
  headers: readonly string[],
  dataStartRow: number,
  dataEndRow: number,
  totalRowNumber: number,
  cachedValues: Record<DetailTotalHeader, number>,
) {
  if (dataEndRow < dataStartRow) return {};
  const formulas: Record<string, NumericFormulaCell> = {};
  for (const header of detailTotalHeaders) {
    const start = cellRef(headers, header, dataStartRow);
    const end = cellRef(headers, header, dataEndRow);
    const total = cellRef(headers, header, totalRowNumber);
    formulas[total] = numericFormulaCell(cachedValues[header], `SUM(${start}:${end})`);
  }
  return formulas;
}
