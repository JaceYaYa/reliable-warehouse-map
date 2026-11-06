import {isLayerStoragePricing} from '../../../../../lib/storage-pricing-basis';
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { auditLogs, storageFeeSettlements } from "../../../../../db/schema";
import { requireUser } from "../../../../../lib/auth";
import { withJsonErrors } from "../../../../../lib/api-json";

// Correct the billing customer without rewriting outbound facts or confirmed prices.
export async function PUT(request: Request) {
  return withJsonErrors(async () => {
    const auth = await requireUser(request, "pricing.manage"); if (auth.error) return auth.error;
    if(await isLayerStoragePricing())return Response.json({error:"托层计价已启用，旧件/箱费用仅供归档查询，不能修改、确认、取消或恢复"},{status:409,headers:{"cache-control":"no-store"}});
    const body = await request.json();
    const { id, version } = body;
    const customerName = typeof body.customerName === "string" ? body.customerName.trim() : "";
    if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(version) || version < 0 || !customerName || customerName.length > 200) {
      return Response.json({ error: "请选择出库记录并填写有效客户名称（最多200字）" }, { status: 400 });
    }
    const db = getDb();
    const [item] = await db.select().from(storageFeeSettlements).where(eq(storageFeeSettlements.id, id));
    if (!item) return Response.json({ error: "出库计价记录不存在" }, { status: 404 });
    if (item.inboundSource !== "return" || !["pending", "settled"].includes(item.settlementStatus)) {
      return Response.json({ error: "仅支持修改待确认或已确认的退货出库记录" }, { status: 409 });
    }
    if (item.version !== version) return Response.json({ error: "该出库记录已有变化，请刷新后重新勾选" }, { status: 409 });
    if (item.customerName === customerName) return Response.json({ item });
    const condition = and(eq(storageFeeSettlements.id, id), eq(storageFeeSettlements.version, version), eq(storageFeeSettlements.settlementStatus, item.settlementStatus));
    const after = { ...item, customerName, version: version + 1 };
    const summary = `${item.product}｜客户 ${item.customerName || "未填写"}→${customerName}｜保留出库数量、日期及原计价`;
    const operationId = `settlement-customer:${id}:${crypto.randomUUID()}`;
    // Both the audit and mutation share the same condition and D1 transaction.
    const auditInsert = db.insert(auditLogs).select(db.select({
      id: sql<number>`null`.as("id"),
      userId: sql<number>`${auth.user!.id}`.as("user_id"),
      userName: sql<string>`${auth.user!.displayName}`.as("user_name"),
      action: sql<string>`'修改出库客户'`.as("action"),
      entityType: sql<string>`'仓储费结算'`.as("entity_type"),
      entityId: sql<string>`${String(id)}`.as("entity_id"),
      operationId: sql<string>`${operationId}`.as("operation_id"),
      summary: sql<string>`${summary}`.as("summary"),
      beforeSnapshot: sql<string>`${JSON.stringify(item)}`.as("before_snapshot"),
      afterSnapshot: sql<string>`${JSON.stringify(after)}`.as("after_snapshot"),
      createdAt: sql<string>`${new Date().toISOString()}`.as("created_at"),
    }).from(storageFeeSettlements).where(condition)).returning({ id: auditLogs.id });
    const [audit, updated] = await db.batch([
      auditInsert,
      db.update(storageFeeSettlements).set({ customerName, version: version + 1 }).where(condition).returning(),
    ]);
    if (!audit[0] || !updated[0]) return Response.json({ error: "该出库记录已有变化，请刷新后重新勾选" }, { status: 409 });
    return Response.json({ item: updated[0] });
  }, "出库客户保存失败，请稍后重试");
}
