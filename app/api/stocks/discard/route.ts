import { goodsInventoryWritePlan } from "../../../../lib/goods-inventory-guard";
import { goodsResponseError } from "../../../../lib/goods-store";
import { and, eq, exists, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { getDb } from "../../../../db";
import { auditLogs, stocks } from "../../../../db/schema";
import { requireUser } from "../../../../lib/auth";
import { palletLabel } from "../../../../lib/pallet";
import {discardManagedGoods} from '../../../../lib/goods-discard';

const batchTuple = (queries: BatchItem<"sqlite">[]) => queries as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]];

export async function DELETE(request: Request) {
 try {
  const auth = await requireUser(request,"stock.delete"); if (auth.error) return auth.error;
  let payload: { id?: unknown; expectedVersion?: unknown;requestId?:unknown };
  try { payload = await request.json() as { id?: unknown; expectedVersion?: unknown;requestId?:unknown }; }
  catch { return Response.json({ error: "删除请求格式不正确" }, { status: 400 }); }

  const id = Number(payload.id), expectedVersion = Number(payload.expectedVersion);
  if (!Number.isSafeInteger(id) || id <= 0) return Response.json({ error: "缺少货物编号" }, { status: 400 });
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) return Response.json({ error: "货物版本无效，请刷新后重试" }, { status: 400 });
  const managed=await discardManagedGoods({id,expectedVersion,requestId:payload.requestId},auth.user!);if(managed)return managed;

  const db = getDb(), [before] = await db.select().from(stocks).where(eq(stocks.id, id)).limit(1);
  if (!before) return Response.json({ error: "货物不存在或已经被删除" }, { status: 404 });
  if (before.version !== expectedVersion) return Response.json({ error: "该库存刚刚被其他账号修改，请刷新后重试" }, { status: 409 });

  const goods=await goodsInventoryWritePlan([{before,after:null}],"delete");
  const operationId = `delete-stock:${before.id}:${crypto.randomUUID()}`, stamp = new Date().toISOString();
  const summary = `${before.product}｜删除货物｜单号 ${before.inboundOrder || "—"}｜原库存 ${before.totalQuantity}件/${before.totalBoxes}箱/${palletLabel(before.palletCount, before.palletLabel)}托｜不计入出入库`;
  const targetCondition = and(eq(stocks.id, before.id), eq(stocks.version, expectedVersion), eq(stocks.updatedAt, before.updatedAt));
  const auditGate = exists(db.select({ id: auditLogs.id }).from(auditLogs).where(eq(auditLogs.operationId, operationId)));
  const auditInsert = db.insert(auditLogs).select(db.select({
    id: sql<number>`null`.as("id"),
    userId: sql<number>`${auth.user!.id}`.as("user_id"),
    userName: sql<string>`${auth.user!.displayName}`.as("user_name"),
    action: sql<string>`'删除'`.as("action"),
    entityType: sql<string>`'库位'`.as("entity_type"),
    entityId: sql<string>`${before.locationCode}`.as("entity_id"),
    operationId: sql<string>`${operationId}`.as("operation_id"),
    summary: sql<string>`${summary}`.as("summary"),
    beforeSnapshot: sql<string>`${JSON.stringify(before)}`.as("before_snapshot"),
    afterSnapshot: sql<string>`${JSON.stringify(null)}`.as("after_snapshot"),
    createdAt: sql<string>`${stamp}`.as("created_at"),
  }).from(stocks).where(targetCondition)).returning({ id: auditLogs.id });

  const results = await db.batch(batchTuple([
    ...goods.drizzleGuard,
    auditInsert,
    db.delete(stocks).where(and(targetCondition, auditGate)).returning({ id: stocks.id }),
    ...goods.drizzleAfterQueries,
  ]));
  if (!(results[goods.drizzleGuard.length] as unknown[])?.length || !(results[goods.drizzleGuard.length+1] as unknown[])?.length) {
    await db.delete(auditLogs).where(eq(auditLogs.operationId, operationId));
    return Response.json({ error: "该库存刚刚被其他账号修改，请刷新后重试" }, { status: 409 });
  }
  return Response.json({ ok: true, deletedId: before.id });
 }catch(error){return goodsResponseError(error);}
}
