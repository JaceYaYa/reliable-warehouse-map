import {isLayerStoragePricing} from '../../../../lib/storage-pricing-basis';
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../../../../db";
import { auditLogs, storageFeeSettlements } from "../../../../db/schema";
import { recordAudit } from "../../../../lib/audit";
import { withJsonErrors } from "../../../../lib/api-json";
import { requireUser } from "../../../../lib/auth";
import { calculateStorageFee, chinaTodayDate } from "../../../../lib/pricing";

type PricingChange = {
  id?: unknown;
  version?: unknown;
  ratePerM3Day?: unknown;
  freeDays?: unknown;
  outboundDate?: unknown;
  volumePerUnitM3?: unknown;
  feeUsd?: unknown;
};

function identityValues(body: PricingChange) {
  const id = Number(body.id);
  const version = Number(body.version);
  if (!Number.isInteger(id) || id <= 0) return { error: "缺少待结算记录编号" } as const;
  if (!Number.isInteger(version) || version < 0) return { error: "待结算记录版本无效，请刷新后重试" } as const;
  return { id, version } as const;
}

function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

function pricingValues(body: PricingChange, item: typeof storageFeeSettlements.$inferSelect) {
  const ratePerM3Day = Number(body.ratePerM3Day);
  const freeDays = Number(body.freeDays);
  const outboundDate = String(body.outboundDate ?? item.outboundAt.slice(0, 10)).trim();
  const currentVolumePerUnitM3 = item.billingMode === "box" ? item.boxVolumeM3 : item.itemVolumeM3;
  const volumePerUnitM3 = body.volumePerUnitM3 === undefined || body.volumePerUnitM3 === null || body.volumePerUnitM3 === ""
    ? currentVolumePerUnitM3
    : Number(body.volumePerUnitM3);
  const feeUsd = body.feeUsd === undefined || body.feeUsd === null || body.feeUsd === ""
    ? null
    : Number(body.feeUsd);
  if (!Number.isFinite(ratePerM3Day) || ratePerM3Day < 0) return { error: "单价必须是大于或等于 0 的数字" } as const;
  if (!Number.isFinite(volumePerUnitM3) || volumePerUnitM3 <= 0) return { error: "每件或每箱体积必须是大于 0 的数字" } as const;
  if (!Number.isFinite(freeDays) || freeDays < 0 || !Number.isInteger(freeDays)) return { error: "免租天数必须是大于或等于 0 的整数" } as const;
  if (!validDate(outboundDate)) return { error: "出库日期格式不正确" } as const;
  if (outboundDate < item.inboundDate.slice(0, 10)) return { error: "出库日期不能早于入库日期" } as const;
  if (outboundDate > chinaTodayDate()) return { error: "出库日期不能晚于今天" } as const;
  if (feeUsd !== null && (!Number.isFinite(feeUsd) || feeUsd < 0 || feeUsd > 1_000_000_000)) {
    return { error: "整段确认总价必须是大于或等于 0 的有效数字" } as const;
  }
  return { ratePerM3Day, freeDays, outboundDate, volumePerUnitM3, feeUsd } as const;
}

function recalculated(
  item: typeof storageFeeSettlements.$inferSelect,
  ratePerM3Day: number,
  freeDays: number,
  outboundDate: string,
  volumePerUnitM3: number,
  feeUsd: number | null,
) {
  const itemVolumeM3 = item.billingMode === "item" ? volumePerUnitM3 : item.itemVolumeM3;
  const boxVolumeM3 = item.billingMode === "box" ? volumePerUnitM3 : item.boxVolumeM3;
  const calc = calculateStorageFee({
    inboundDate: item.inboundDate,
    endDate: outboundDate,
    billingMode: item.billingMode,
    quantity: item.quantity,
    boxes: item.boxes,
    itemVolumeM3,
    boxVolumeM3,
    rateUsdM3Day: ratePerM3Day,
    freeDays,
  });
  return {
    outboundAt: `${outboundDate}${item.outboundAt.slice(10) || "T00:00:00.000Z"}`,
    rateUsdM3Day: calc.rateUsdM3Day,
    itemVolumeM3,
    boxVolumeM3,
    freeDays: calc.freeDays,
    storageDays: calc.storageDays,
    billableDays: calc.billableDays,
    totalVolumeM3: calc.totalVolumeM3,
    feeUsd: feeUsd ?? calc.feeUsd,
    version: item.version + 1,
  };
}

async function pendingItem(id: number) {
  const [item] = await getDb().select().from(storageFeeSettlements)
    .where(eq(storageFeeSettlements.id, id)).limit(1);
  if (!item) return { error: Response.json({ error: "待结算记录不存在" }, { status: 404 }) };
  if (item.inboundSource !== "return") return { error: Response.json({ error: "只有退货出库记录可以结算" }, { status: 400 }) };
  if (item.settlementStatus !== "pending") return { error: Response.json({ error: "该记录已经结算，不能再次修改" }, { status: 409 }) };
  return { item };
}

async function cancellableItem(id: number) {
  const [item] = await getDb().select().from(storageFeeSettlements)
    .where(eq(storageFeeSettlements.id, id)).limit(1);
  if (!item) return { error: Response.json({ error: "出库计价记录不存在" }, { status: 404 }) };
  if (item.inboundSource !== "return") return { error: Response.json({ error: "只有退货出库记录可以取消计价" }, { status: 400 }) };
  if (item.settlementStatus === "cancelled") return { error: Response.json({ error: "该记录已经取消计价，无需重复取消" }, { status: 409 }) };
  if (item.settlementStatus !== "pending" && item.settlementStatus !== "settled") {
    return { error: Response.json({ error: "该记录状态异常，请刷新后重试" }, { status: 409 }) };
  }
  return { item };
}

async function cancelledItem(id: number) {
  const [item] = await getDb().select().from(storageFeeSettlements)
    .where(eq(storageFeeSettlements.id, id)).limit(1);
  if (!item) return { error: Response.json({ error: "出库计价记录不存在" }, { status: 404 }) };
  if (item.inboundSource !== "return") return { error: Response.json({ error: "只有退货出库记录可以恢复计价" }, { status: 400 }) };
  if (item.settlementStatus !== "cancelled") return { error: Response.json({ error: "该记录未被取消，无需恢复" }, { status: 409 }) };
  return { item };
}

export async function PATCH(request: Request) {
  return withJsonErrors(async () => {
    const auth = await requireUser(request,"pricing.manage"); if (auth.error) return auth.error!;
    if(await isLayerStoragePricing())return Response.json({error:"托层计价已启用，旧件/箱费用仅供归档查询，不能修改、确认、取消或恢复"},{status:409,headers:{"cache-control":"no-store"}});
    const body = await request.json() as PricingChange;
    const identity = identityValues(body);
    if ("error" in identity) return Response.json({ error: identity.error }, { status: 400 });
    const found = await pendingItem(identity.id); if ("error" in found) return found.error!;
    const item = found.item;
    const values = pricingValues(body, item);
    if ("error" in values) return Response.json({ error: values.error }, { status: 400 });
    const [updated] = await getDb().update(storageFeeSettlements)
      .set(recalculated(item, values.ratePerM3Day, values.freeDays, values.outboundDate, values.volumePerUnitM3, values.feeUsd))
      .where(and(
        eq(storageFeeSettlements.id, identity.id),
        eq(storageFeeSettlements.settlementStatus, "pending"),
        eq(storageFeeSettlements.version, identity.version),
      ))
      .returning();
    if (!updated) return Response.json({ error: "该记录刚刚被修改或结算，请刷新后重试" }, { status: 409 });
    await recordAudit(
      auth.user!,
      "修改出库计价",
      "仓储费结算",
      String(updated.id),
      `${updated.customerName || "未填写客户"}｜${updated.product}｜计价出库日 ${updated.outboundAt.slice(0, 10)}｜${updated.billingMode === "box" ? "每箱" : "每件"}体积 ${updated.billingMode === "box" ? updated.boxVolumeM3 : updated.itemVolumeM3}m³｜单价 $${updated.rateUsdM3Day}/m³/天｜免租 ${updated.freeDays} 天｜整段确认价 $${updated.feeUsd}`,
    );
    return Response.json({ ok: true, item: updated });
  }, "待结算费用保存失败，请稍后重试");
}

export async function POST(request: Request) {
  return withJsonErrors(async () => {
    const auth = await requireUser(request,"pricing.manage"); if (auth.error) return auth.error!;
    if(await isLayerStoragePricing())return Response.json({error:"托层计价已启用，旧件/箱费用仅供归档查询，不能修改、确认、取消或恢复"},{status:409,headers:{"cache-control":"no-store"}});
    const body = await request.json() as PricingChange;
    const identity = identityValues(body);
    if ("error" in identity) return Response.json({ error: identity.error }, { status: 400 });
    const found = await pendingItem(identity.id); if ("error" in found) return found.error!;
    const item = found.item;
    const values = pricingValues(body, item);
    if ("error" in values) return Response.json({ error: values.error }, { status: 400 });
    const settledAt = new Date().toISOString();
    const [updated] = await getDb().update(storageFeeSettlements)
      .set({
        ...recalculated(item, values.ratePerM3Day, values.freeDays, values.outboundDate, values.volumePerUnitM3, values.feeUsd),
        settlementStatus: "settled",
        settledAt,
        settledBy: auth.user!.displayName,
      })
      .where(and(
        eq(storageFeeSettlements.id, identity.id),
        eq(storageFeeSettlements.settlementStatus, "pending"),
        eq(storageFeeSettlements.version, identity.version),
      ))
      .returning();
    if (!updated) return Response.json({ error: "该记录刚刚被修改或结算，请刷新后重试" }, { status: 409 });
    await recordAudit(
      auth.user!,
      "确认出库计价",
      "仓储费结算",
      String(updated.id),
      `${updated.customerName || "未填写客户"}｜${updated.product}｜${updated.billingMode === "box" ? "每箱" : "每件"}体积 ${updated.billingMode === "box" ? updated.boxVolumeM3 : updated.itemVolumeM3}m³｜费用 $${updated.feeUsd}｜结算人 ${updated.settledBy}`,
    );
    return Response.json({ ok: true, item: updated });
  }, "仓储费结算失败，请稍后重试");
}


export async function DELETE(request: Request) {
  return withJsonErrors(async () => {
    const auth = await requireUser(request,"pricing.manage"); if (auth.error) return auth.error!;
    if(await isLayerStoragePricing())return Response.json({error:"托层计价已启用，旧件/箱费用仅供归档查询，不能修改、确认、取消或恢复"},{status:409,headers:{"cache-control":"no-store"}});
    const identity = identityValues(await request.json() as PricingChange);
    if ("error" in identity) return Response.json({ error: identity.error }, { status: 400 });
    const found = await cancellableItem(identity.id); if ("error" in found) return found.error!;
    const item = found.item;
    const db = getDb();
    const targetCondition = and(
      eq(storageFeeSettlements.id, identity.id),
      eq(storageFeeSettlements.settlementStatus, item.settlementStatus),
      eq(storageFeeSettlements.version, identity.version),
    );
    const operationId = `cancel-pricing:${identity.id}:${crypto.randomUUID()}`;
    const stamp = new Date().toISOString();
    const summary = `${item.customerName || "未填写客户"}｜${item.product}｜取消前 ${item.settlementStatus === "settled" ? "已确认" : "待确认"}｜整段价格 $${item.feeUsd}｜仅从计价队列归档，保留真实出库和库存记录`;
    const auditInsert = db.insert(auditLogs).select(db.select({
      id: sql<number>`null`.as("id"),
      userId: sql<number>`${auth.user!.id}`.as("user_id"),
      userName: sql<string>`${auth.user!.displayName}`.as("user_name"),
      action: sql<string>`'取消出库计价'`.as("action"),
      entityType: sql<string>`'仓储费结算'`.as("entity_type"),
      entityId: sql<string>`${String(identity.id)}`.as("entity_id"),
      operationId: sql<string>`${operationId}`.as("operation_id"),
      summary: sql<string>`${summary}`.as("summary"),
      beforeSnapshot: sql<string | null>`null`.as("before_snapshot"),
      afterSnapshot: sql<string | null>`null`.as("after_snapshot"),
      createdAt: sql<string>`${stamp}`.as("created_at"),
    }).from(storageFeeSettlements).where(targetCondition)).returning({ id: auditLogs.id });
    const update = db.update(storageFeeSettlements)
      .set({
        settlementStatus: "cancelled",
        version: item.version + 1,
      })
      .where(targetCondition)
      .returning();
    const [auditResult, updateResult] = await db.batch([auditInsert, update]);
    const updated = updateResult[0];
    if (!auditResult[0] || !updated) return Response.json({ error: "该记录刚刚被修改，请刷新后重试" }, { status: 409 });
    return Response.json({ ok: true, item: updated });
  }, "取消出库计价失败，请稍后重试");
}

export async function PUT(request: Request) {
  return withJsonErrors(async () => {
    const auth = await requireUser(request,"pricing.manage"); if (auth.error) return auth.error!;
    if(await isLayerStoragePricing())return Response.json({error:"托层计价已启用，旧件/箱费用仅供归档查询，不能修改、确认、取消或恢复"},{status:409,headers:{"cache-control":"no-store"}});
    const identity = identityValues(await request.json() as PricingChange);
    if ("error" in identity) return Response.json({ error: identity.error }, { status: 400 });
    const found = await cancelledItem(identity.id); if ("error" in found) return found.error!;
    const item = found.item;
    const restoredStatus = item.settledAt ? "settled" : "pending";
    const db = getDb();
    const targetCondition = and(
      eq(storageFeeSettlements.id, identity.id),
      eq(storageFeeSettlements.settlementStatus, "cancelled"),
      eq(storageFeeSettlements.version, identity.version),
    );
    const operationId = `restore-pricing:${identity.id}:${crypto.randomUUID()}`;
    const stamp = new Date().toISOString();
    const summary = `${item.customerName || "未填写客户"}｜${item.product}｜恢复为${restoredStatus === "settled" ? "已确认" : "待确认"}｜整段价格 $${item.feeUsd}｜未改变真实出库和库存记录`;
    const auditInsert = db.insert(auditLogs).select(db.select({
      id: sql<number>`null`.as("id"),
      userId: sql<number>`${auth.user!.id}`.as("user_id"),
      userName: sql<string>`${auth.user!.displayName}`.as("user_name"),
      action: sql<string>`'恢复出库计价'`.as("action"),
      entityType: sql<string>`'仓储费结算'`.as("entity_type"),
      entityId: sql<string>`${String(identity.id)}`.as("entity_id"),
      operationId: sql<string>`${operationId}`.as("operation_id"),
      summary: sql<string>`${summary}`.as("summary"),
      beforeSnapshot: sql<string | null>`null`.as("before_snapshot"),
      afterSnapshot: sql<string | null>`null`.as("after_snapshot"),
      createdAt: sql<string>`${stamp}`.as("created_at"),
    }).from(storageFeeSettlements).where(targetCondition)).returning({ id: auditLogs.id });
    const update = db.update(storageFeeSettlements)
      .set({
        settlementStatus: restoredStatus,
        version: item.version + 1,
      })
      .where(targetCondition)
      .returning();
    const [auditResult, updateResult] = await db.batch([auditInsert, update]);
    const updated = updateResult[0];
    if (!auditResult[0] || !updated) return Response.json({ error: "该记录刚刚被修改，请刷新后重试" }, { status: 409 });
    return Response.json({ ok: true, item: updated });
  }, "恢复出库计价失败，请稍后重试");
}
