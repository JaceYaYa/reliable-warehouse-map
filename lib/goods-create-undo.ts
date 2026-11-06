import { env } from "cloudflare:workers";
import { GoodsFlowError, parseGoodsState, type GoodsCategory, type GoodsState } from "./goods-flow";
import { goodsFinish, goodsResponseError } from "./goods-store";
import {hasPermission,type PermissionUser} from './permissions';

export type GoodsCreateAudit = { id: number; action: string; operationId: string | null };
export type GoodsCreateUndoState = { canRestore: boolean; restoreReason: string };
type StoredState = { id: number; revision: number; value: string };
type Operation = {
  id: string; kind: string; category_id: string; fingerprint: string;
  before_category: string | null; after_category: string; before_rows: string;
  after_rows: string; settlement_ids: string; result: string;
  created_at: string; restored_at: string | null;
};
type AuditRow = {
  id: number; user_id: number; user_name: string; action: string; entity_type: string;
  entity_id: string; operation_id: string | null; summary: string;
  before_snapshot: string | null; after_snapshot: string | null; created_at: string;
};
const CREATE_ACTION = "货物类别新增";
const sourceInvalid = "新增记录资料不完整，不能安全撤销，请联系管理员核对";
const usedReason = "该货物类别已有入库、出库或后续操作，请先处理其出入库记录";
const changedReason = "该货物类别资料已发生变化，不能直接撤销原新增记录";
const denied = (restoreReason: string): GoodsCreateUndoState => ({ canRestore: false, restoreReason });

// Compare every stored field, including optional productSpec, without depending on object key order.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
function emptyArray(raw: string) { const value: unknown = JSON.parse(raw); return Array.isArray(value) && value.length === 0; }
function originalCategory(op: Operation): GoodsCategory | null {
  try {
    if (op.kind !== "create" || (op.before_category !== null && JSON.parse(op.before_category) !== null) || !emptyArray(op.before_rows) || !emptyArray(op.after_rows) || !emptyArray(op.settlement_ids)) return null;
    const category = JSON.parse(op.after_category) as GoodsCategory;
    // Validate both legacy categories without productSpec and current ones with dimensions.
    parseGoodsState(JSON.stringify({ categories: [category] }));
    if (category.id !== op.category_id || category.stockIds.length || category.lots.length) return null;
    return category;
  } catch { return null; }
}
function eligibility(log: GoodsCreateAudit, state: GoodsState, operations: readonly Operation[]): GoodsCreateUndoState {
  const op = operations.find(row => row.id === log.operationId);
  if (!op || op.kind !== "create") return denied(sourceInvalid);
  if (op.restored_at) return denied("该新增记录已经撤销");
  const source = originalCategory(op);
  if (!source) return denied(sourceInvalid);
  const current = state.categories.find(category => category.id === op.category_id);
  if (!current) return denied("该货物类别已不存在，不能再次撤销");
  if (current.stockIds.length || current.lots.length || operations.some(row => row.category_id === op.category_id && row.id !== op.id)) return denied(usedReason);
  if (canonical(current) !== canonical(source)) return denied(changedReason);
  return { canRestore: true, restoreReason: "" };
}
async function loadUndoContext(logs: readonly GoodsCreateAudit[]) {
  const ids = [...new Set(logs.map(log => log.operationId).filter((id): id is string => Boolean(id)))];
  const [stateResult, operationResult] = await env.DB.batch([
    env.DB.prepare("SELECT id,revision,value FROM goods_flow_state WHERE id=1"),
    env.DB.prepare("SELECT * FROM goods_operations WHERE id IN (SELECT value FROM json_each(?)) OR category_id IN (SELECT category_id FROM goods_operations WHERE id IN (SELECT value FROM json_each(?)))").bind(JSON.stringify(ids), JSON.stringify(ids)),
  ]);
  const stored = (stateResult.results as StoredState[])[0];
  if (!stored) throw new GoodsFlowError("货物批次数据尚未初始化，请联系管理员", 500);
  parseGoodsState(stored.value);
  // Preserve the exact snapshots rather than normalizing unrelated category fields on undo.
  return { stored, state: JSON.parse(stored.value) as GoodsState, operations: operationResult.results as Operation[] };
}

/** Two batch queries for the whole audit page; callers apply user permissions to these data-only states. */
export async function goodsCreateUndoStates(logs: readonly GoodsCreateAudit[]): Promise<Map<number, GoodsCreateUndoState>> {
  const creates = logs.filter(log => log.action === CREATE_ACTION);
  if (!creates.length) return new Map();
  const context = await loadUndoContext(creates);
  return new Map(creates.map(log => [log.id, eligibility(log, context.state, context.operations)]));
}

/** Null means another management action; the caller may dispatch its own restore handler. */
export async function restoreGoodsCreateAudit(log: GoodsCreateAudit, user: PermissionUser & { id: number; displayName: string }): Promise<Response | null> {
  if (log.action !== CREATE_ACTION) return null;
  try {
    if(!hasPermission(user,'stock.restore')||(!hasPermission(user,'product.manage')&&!hasPermission(user,'stock.inbound')))throw new GoodsFlowError('当前账号没有产品创建的撤销权限',403);
    const sourceLog = await env.DB.prepare("SELECT * FROM audit_logs WHERE id=?").bind(log.id).first<AuditRow>();
    if (!sourceLog || sourceLog.action !== CREATE_ACTION || sourceLog.operation_id !== log.operationId) throw new GoodsFlowError("原管理记录已发生变化，请刷新后重试");
    const context = await loadUndoContext([log]);
    const status = eligibility(log, context.state, context.operations);
    if (!status.canRestore) throw new GoodsFlowError(status.restoreReason);
    const op = context.operations.find(row => row.id === log.operationId)!;
    const category = context.state.categories.find(row => row.id === op.category_id)!;
    const stamp = new Date().toISOString(), restoreId = `restore:audit:${log.id}`;
    const opKeys = Object.keys(op) as (keyof Operation)[];
    const auditKeys = Object.keys(sourceLog) as (keyof AuditRow)[];
    const guard = env.DB.prepare(`INSERT INTO goods_transaction_guards(id,valid) VALUES (?,CASE WHEN
      EXISTS(SELECT 1 FROM goods_flow_state WHERE id=1 AND revision=? AND value=?)
      AND EXISTS(SELECT 1 FROM goods_operations WHERE ${opKeys.map(key => `${key} IS ?`).join(" AND ")})
      AND EXISTS(SELECT 1 FROM audit_logs WHERE ${auditKeys.map(key => `${key} IS ?`).join(" AND ")})
      AND NOT EXISTS(SELECT 1 FROM goods_operations WHERE category_id=? AND id<>?)
      AND NOT EXISTS(SELECT 1 FROM audit_logs WHERE operation_id=?)
      THEN 1 ELSE 0 END)`).bind(restoreId, context.stored.revision, context.stored.value, ...opKeys.map(key => op[key]), ...auditKeys.map(key => sourceLog[key]), op.category_id, op.id, restoreId);
    const next = { ...context.state, categories: context.state.categories.filter(row => row.id !== op.category_id) };
    await env.DB.batch([
      guard,
      env.DB.prepare("UPDATE goods_flow_state SET value=?,revision=revision+1 WHERE id=1").bind(JSON.stringify(next)),
      env.DB.prepare("UPDATE goods_operations SET restored_at=? WHERE id=? AND restored_at IS NULL").bind(stamp, op.id),
      env.DB.prepare("INSERT INTO audit_logs(user_id,user_name,action,entity_type,entity_id,operation_id,summary,before_snapshot,after_snapshot,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .bind(user.id, user.displayName, "撤销货物类别新增", "原记录", String(log.id), restoreId, `撤销原记录 ${log.id}｜${category.product}｜客户 ${category.customerName}｜删除尚未使用的空货物类别`, JSON.stringify({ schema: "goods-create-undo-v1", operationId: op.id, category }), JSON.stringify({ schema: "goods-create-undo-v1", operationId: op.id, category: null }), stamp),
      goodsFinish(restoreId),
    ]);
    return Response.json({ ok: true, restoredAuditId: log.id, categoryId: op.category_id });
  } catch (error) { return goodsResponseError(error); }
}
