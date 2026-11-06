import {isLayerStoragePricing} from "../../../../lib/storage-pricing-basis";
import { requireUser } from "../../../../lib/auth";
import { withJsonErrors } from "../../../../lib/api-json";
import { buildStorageFeeReport } from "../../../../lib/storage-fee-report";
import { InvalidStorageBillingPeriodError } from "../../../../lib/pricing";

export async function GET(request: Request) {
  return withJsonErrors(async () => {
    const auth = await requireUser(request,"pricing.manage"); if (auth.error) return auth.error;
    if(await isLayerStoragePricing())return Response.json({error:"当前按托层计价，请从仓储计价页面查看或导出托层报告",reportUrl:"/api/pricing/layers/report",exportUrl:"/api/pricing/layers/export"},{status:409,headers:{"cache-control":"no-store"}});
    const params = new URL(request.url).searchParams;
    try {
      return Response.json(await buildStorageFeeReport({
        asOf: params.get("asOf") || undefined,
        fromMonth: params.has("fromMonth") ? params.get("fromMonth")! : undefined,
        toMonth: params.has("toMonth") ? params.get("toMonth")! : undefined,
        source: params.get("source") || undefined,
        status: params.get("status") || undefined,
        settlementStatus: params.get("settlementStatus") || undefined,
        inventoryStatus: params.get("inventoryStatus") || undefined,
        customers: params.getAll("customer"),
        q: params.get("q") || undefined,
        applyCustomerPricing: params.get("customerPricing") === "1",
      }));
    } catch (error) {
      if (error instanceof InvalidStorageBillingPeriodError) {
        return Response.json(
          { ok: false, error: error.message },
          { status: 400, headers: { "cache-control": "no-store" } },
        );
      }
      throw error;
    }
  }, "仓储费明细读取失败，请稍后重试");
}
