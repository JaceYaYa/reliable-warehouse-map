import {warehouseTodayDate} from '../../../../../lib/warehouse-time';
import { asc, eq } from "drizzle-orm";
import * as XLSX from "xlsx";
import { getDb } from "../../../../../db";
import { pricingCatalogItems } from "../../../../../db/schema";
import { withJsonErrors } from "../../../../../lib/api-json";
import { requireUser } from "../../../../../lib/auth";

export async function GET(request: Request) {
  return withJsonErrors(async () => {
    const auth = await requireUser(request,"pricing.manage"); if (auth.error) return auth.error;
    const items = await getDb().select().from(pricingCatalogItems)
      .where(eq(pricingCatalogItems.active, 1))
      .orderBy(asc(pricingCatalogItems.customerName), asc(pricingCatalogItems.product), asc(pricingCatalogItems.sku));
    const rows = items.map((item) => ({
      "合作商家": item.partnerName,
      "客户名称": item.customerName,
      "产品名称": item.product,
      "SKU": item.sku,
      "条形码": item.barcode,
      "计费方式": item.defaultBillingMode === "box" ? "按箱" : "按件",
      "单件长(cm)": item.itemLengthCm,
      "单件宽(cm)": item.itemWidthCm,
      "单件高(cm)": item.itemHeightCm,
      "单件体积(m³)": item.itemVolumeM3,
      "箱长(cm)": item.boxLengthCm,
      "箱宽(cm)": item.boxWidthCm,
      "箱高(cm)": item.boxHeightCm,
      "箱体积(m³)": item.boxVolumeM3,
      "仓储费率": item.rateUsdM3Day,
      "免租天数": item.freeDays,
      "启用": item.active ? "是" : "否",
    }));
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.json_to_sheet(rows, {
      header: [
        "合作商家", "客户名称", "产品名称", "SKU", "条形码", "计费方式",
        "单件长(cm)", "单件宽(cm)", "单件高(cm)", "单件体积(m³)",
        "箱长(cm)", "箱宽(cm)", "箱高(cm)", "箱体积(m³)",
        "仓储费率", "免租天数", "启用",
      ],
    });
    sheet["!cols"] = [18, 18, 30, 20, 20, 12, 13, 13, 13, 16, 13, 13, 13, 16, 15, 12, 10]
      .map((wch) => ({ wch }));
    XLSX.utils.book_append_sheet(workbook, sheet, "合作商家产品目录");
    const file = XLSX.write(workbook, { type: "array", bookType: "xlsx", compression: true });
    const date = warehouseTodayDate();
    return new Response(file, {
      headers: {
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": `attachment; filename="partner-product-catalog-${date}.xlsx"`,
        "cache-control": "no-store",
      },
    });
  }, "合作商家目录下载失败，请稍后重试");
}
