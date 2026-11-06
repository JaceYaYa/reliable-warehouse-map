import { sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { getDb } from "../../../../../db";
import { auditLogs, pricingCatalogItems } from "../../../../../db/schema";
import { requireUser } from "../../../../../lib/auth";
import { withJsonErrors } from "../../../../../lib/api-json";
import { catalogIdentity, normalizeCatalogInput } from "../../../../../lib/pricing";

const batchTuple = (queries: BatchItem<"sqlite">[]) => queries as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]];
const MAX_IMPORT_BATCH_SIZE = 30;

const excludedCatalogValue = {
  partnerName: sql`excluded.partner_name`, customerName: sql`excluded.customer_name`, product: sql`excluded.product`,
  sku: sql`excluded.sku`, fnsku: sql`excluded.fnsku`, barcode: sql`excluded.barcode`, defaultBillingMode: sql`excluded.default_billing_mode`,
  itemLengthCm: sql`excluded.item_length_cm`, itemWidthCm: sql`excluded.item_width_cm`, itemHeightCm: sql`excluded.item_height_cm`, itemVolumeM3: sql`excluded.item_volume_m3`,
  boxLengthCm: sql`excluded.box_length_cm`, boxWidthCm: sql`excluded.box_width_cm`, boxHeightCm: sql`excluded.box_height_cm`, boxVolumeM3: sql`excluded.box_volume_m3`,
  rateUsdM3Day: sql`excluded.rate_usd_m3_day`, freeDays: sql`excluded.free_days`, active: sql`excluded.active`,
  updatedBy: sql`excluded.updated_by`, updatedAt: sql`excluded.updated_at`,
};

export async function POST(request: Request) {
  return withJsonErrors(async () => {
    const auth = await requireUser(request,"pricing.manage"); if (auth.error) return auth.error;
    let body: { items?: Record<string, unknown>[] } | Record<string, unknown>[];
    try {
      body = await request.json() as typeof body;
    } catch {
      return Response.json({ ok: false, error: "上传的目录数据格式不正确" }, { status: 400 });
    }
    const input = Array.isArray(body) ? body : body.items;
    if (!Array.isArray(input) || !input.length) return Response.json({ ok: false, error: "没有可导入的目录货物" }, { status: 400 });
    if (input.length > MAX_IMPORT_BATCH_SIZE) {
      return Response.json({ ok: false, error: `单批最多导入${MAX_IMPORT_BATCH_SIZE}条目录货物，请使用页面上传以自动分批` }, { status: 400 });
    }
    const normalized: Array<ReturnType<typeof normalizeCatalogInput> & { identityKey: string }> = [];
    for (const [index, raw] of input.entries()) {
      const item = normalizeCatalogInput(raw);
      if (!item.product) return Response.json({ ok: false, error: `第${index + 1}条缺少产品名称` }, { status: 400 });
      normalized.push({ ...item, identityKey: catalogIdentity(item) });
    }
    // Last occurrence wins inside one workbook; the database unique key and
    // upsert target provide the same guarantee across concurrent requests.
    const uniqueItems = [...new Map(normalized.map(item => [item.identityKey, item])).values()];
    const db = getDb(), existing = await db.select({ identityKey: pricingCatalogItems.identityKey }).from(pricingCatalogItems);
    const existingKeys = new Set(existing.map(item => item.identityKey));
    const now = new Date().toISOString(), imported = uniqueItems.filter(item => !existingKeys.has(item.identityKey)).length, updated = uniqueItems.length - imported;
    const operationId = crypto.randomUUID(), queries: BatchItem<"sqlite">[] = uniqueItems.map(item => {
      const value = { ...item, updatedBy: auth.user!.displayName, createdAt: now, updatedAt: now };
      return db.insert(pricingCatalogItems).values(value)
        .onConflictDoUpdate({ target: pricingCatalogItems.identityKey, set: excludedCatalogValue });
    });
    queries.push(db.insert(auditLogs).values({ userId: auth.user!.id, userName: auth.user!.displayName, action: "导入计价目录", entityType: "计价目录", entityId: "batch", operationId, summary: `新增${imported}条｜更新${updated}条｜表内重复${normalized.length - uniqueItems.length}条`, createdAt: now }));
    await db.batch(batchTuple(queries));
    return Response.json({ ok: true, imported, updated, duplicates: normalized.length - uniqueItems.length, total: normalized.length, unique: uniqueItems.length });
  }, "合作商家目录导入失败，请检查表格后重试");
}
