import { and, asc, eq, like, or, sql } from "drizzle-orm";
import { getDb } from "../../../../db";
import { pricingCatalogItems } from "../../../../db/schema";
import { recordAudit } from "../../../../lib/audit";
import { withJsonErrors } from "../../../../lib/api-json";
import { requireUser } from "../../../../lib/auth";
import { catalogIdentity, normalizeCatalogInput } from "../../../../lib/pricing";

function present(item: typeof pricingCatalogItems.$inferSelect) {
  return { ...item, productName: item.product, ratePerM3Day: item.rateUsdM3Day };
}

export async function GET(request: Request) {
  return withJsonErrors(async () => {
    const params = new URL(request.url).searchParams;
    const warehouseLookup = params.get("warehouseLookup") === "1";
    const auth = await requireUser(request, warehouseLookup ? false : "pricing.manage"); if (auth.error) return auth.error;
    const q = (params.get("q") || "").trim(), includeInactive = params.get("includeInactive") === "1";
    const limit = Math.max(1, Math.min(500, Number(params.get("limit")) || 100));
    const requestedPage = Math.max(1, Math.floor(Number(params.get("page")) || 1));
    const rawOffset = params.get("offset"), parsedOffset = Number(rawOffset);
    const offset = rawOffset !== null && Number.isFinite(parsedOffset) ? Math.max(0, Math.floor(parsedOffset)) : (requestedPage - 1) * limit;
    const search = q ? or(
      like(pricingCatalogItems.product, `%${q}%`), like(pricingCatalogItems.sku, `%${q}%`),
      like(pricingCatalogItems.fnsku, `%${q}%`), like(pricingCatalogItems.barcode, `%${q}%`), like(pricingCatalogItems.customerName, `%${q}%`),
      like(pricingCatalogItems.partnerName, `%${q}%`),
    ) : undefined;
    const query = getDb().select().from(pricingCatalogItems)
      .where(and(includeInactive ? undefined : eq(pricingCatalogItems.active, 1), search));
    const rows = q
      ? await query.orderBy(
        sql<number>`case when lower(${pricingCatalogItems.sku}) = lower(${q}) or lower(${pricingCatalogItems.fnsku}) = lower(${q}) or lower(${pricingCatalogItems.barcode}) = lower(${q}) then 0 else 1 end`,
        asc(pricingCatalogItems.product),
        asc(pricingCatalogItems.sku),
      ).limit(limit).offset(offset)
      : await query.orderBy(asc(pricingCatalogItems.product), asc(pricingCatalogItems.sku)).limit(limit).offset(offset);
    return Response.json({ ok: true, items: rows.map(item => warehouseLookup ? {
      id: item.id, partnerName: item.partnerName, customerName: item.customerName,
      product: item.product, productName: item.product, sku: item.sku, fnsku: item.fnsku, barcode: item.barcode,
      defaultBillingMode: item.defaultBillingMode, itemVolumeM3: item.itemVolumeM3, boxVolumeM3: item.boxVolumeM3,
      active: item.active,
    } : present(item)), pagination: { limit, offset, page: Math.floor(offset / limit) + 1, nextOffset: offset + rows.length } });
  }, "合作商家目录读取失败，请稍后重试");
}

export async function POST(request: Request) {
  return withJsonErrors(async () => {
    const auth = await requireUser(request,"pricing.manage"); if (auth.error) return auth.error;
    const raw = await request.json() as Record<string, unknown>, normalized = normalizeCatalogInput(raw);
    if (!normalized.product) return Response.json({ ok: false, error: "产品名称不能为空" }, { status: 400 });
    const now = new Date().toISOString(), identityKey = catalogIdentity(normalized);
    const updateValue = { ...normalized, identityKey, updatedBy: auth.user!.displayName, updatedAt: now };
    const [item] = await getDb().insert(pricingCatalogItems).values({ ...updateValue, createdAt: now })
      .onConflictDoUpdate({ target: pricingCatalogItems.identityKey, set: updateValue }).returning();
    await recordAudit(auth.user!, "新增或更新计价目录", "计价目录", String(item.id), `${item.product}｜${item.sku || item.barcode || "无编码"}`);
    return Response.json({ ok: true, item: present(item) });
  }, "合作商家目录保存失败，请稍后重试");
}

export async function PATCH(request: Request) {
  return withJsonErrors(async () => {
    const auth = await requireUser(request,"pricing.manage"); if (auth.error) return auth.error;
    const raw = await request.json() as Record<string, unknown>, id = Number(raw.id || 0);
    if (!id) return Response.json({ ok: false, error: "缺少目录编号" }, { status: 400 });
    const db = getDb(), [before] = await db.select().from(pricingCatalogItems).where(eq(pricingCatalogItems.id, id));
    if (!before) return Response.json({ ok: false, error: "目录货物不存在" }, { status: 404 });
    const normalized = normalizeCatalogInput({ ...before, ...raw, productName: raw.productName ?? raw.product ?? before.product, ratePerM3Day: raw.ratePerM3Day ?? raw.rateUsdM3Day ?? before.rateUsdM3Day });
    if (!normalized.product) return Response.json({ ok: false, error: "产品名称不能为空" }, { status: 400 });
    const identityKey = catalogIdentity(normalized), [identityOwner] = await db.select({ id: pricingCatalogItems.id }).from(pricingCatalogItems).where(eq(pricingCatalogItems.identityKey, identityKey)).limit(1);
    if (identityOwner && identityOwner.id !== id) return Response.json({ ok: false, error: "相同SKU、条码或产品身份的目录货物已经存在" }, { status: 409 });
    const now = new Date().toISOString(), updateValue = { ...normalized, identityKey, updatedBy: auth.user!.displayName, updatedAt: now };
    let item: typeof pricingCatalogItems.$inferSelect;
    try {
      [item] = await db.insert(pricingCatalogItems).values({ id, ...updateValue, createdAt: before.createdAt })
        .onConflictDoUpdate({ target: pricingCatalogItems.id, set: updateValue }).returning();
    } catch (error) {
      if (error instanceof Error && /unique|constraint/i.test(error.message)) return Response.json({ ok: false, error: "相同SKU、条码或产品身份的目录货物已经存在" }, { status: 409 });
      throw error;
    }
    await recordAudit(auth.user!, "修改计价目录", "计价目录", String(id), `${before.product} → ${item.product}`);
    return Response.json({ ok: true, item: present(item) });
  }, "合作商家目录修改失败，请稍后重试");
}

export async function DELETE(request: Request) {
  return withJsonErrors(async () => {
    const auth = await requireUser(request,"pricing.manage"); if (auth.error) return auth.error;
    const id = Number(new URL(request.url).searchParams.get("id") || 0);
    if (!id) return Response.json({ ok: false, error: "缺少目录编号" }, { status: 400 });
    const db = getDb(), [before] = await db.select().from(pricingCatalogItems).where(eq(pricingCatalogItems.id, id));
    if (!before) return Response.json({ ok: false, error: "目录货物不存在" }, { status: 404 });
    await db.update(pricingCatalogItems).set({ active: 0, updatedBy: auth.user!.displayName, updatedAt: new Date().toISOString() }).where(eq(pricingCatalogItems.id, id));
    await recordAudit(auth.user!, "停用计价目录", "计价目录", String(id), before.product);
    return Response.json({ ok: true });
  }, "合作商家目录删除失败，请稍后重试");
}
