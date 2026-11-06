import { count, eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { pricingCatalogItems } from "../../../../../db/schema";
import { recordAudit } from "../../../../../lib/audit";
import { withJsonErrors } from "../../../../../lib/api-json";
import { requireUser } from "../../../../../lib/auth";

export async function POST(request: Request) {
  return withJsonErrors(async () => {
    const auth = await requireUser(request,"pricing.manage"); if (auth.error) return auth.error;
    const body = await request.json() as { confirm?: unknown };
    if (body.confirm !== "CLEAR_ACTIVE_CATALOG") {
      return Response.json({ error: "缺少清空目录确认信息" }, { status: 400 });
    }
    const db = getDb();
    const [{ total }] = await db.select({ total: count() }).from(pricingCatalogItems)
      .where(eq(pricingCatalogItems.active, 1));
    const cleared = Number(total || 0);
    if (cleared) {
      await db.update(pricingCatalogItems).set({
        active: 0,
        updatedBy: auth.user!.displayName,
        updatedAt: new Date().toISOString(),
      }).where(eq(pricingCatalogItems.active, 1));
    }
    await recordAudit(
      auth.user!,
      "清空计价目录",
      "计价目录",
      "all-active",
      `停用 ${cleared} 条当前有效目录；库存和历史结算引用均保留`,
    );
    return Response.json({ ok: true, cleared });
  }, "产品目录清空失败，请稍后重试");
}
