import {redactWarehousePricing,type PermissionUser} from './permissions';
import { env } from "cloudflare:workers";
import { locationCodeKey } from "./location-code";
import { TransferValidationError } from "./stock-transfer";

export type MoveReplayIntent = { requestId: string; actorId: number; fingerprint: string };
type MoveInput = {
  requestId?: unknown; id?: unknown; expectedVersion?: unknown; targetLocation?: unknown;
  mode?: unknown; quantity?: unknown; boxes?: unknown; pallets?: unknown;
  sourceRemainingLayerCount?: unknown; targetLayerCount?: unknown;
};

/** Normalize transport representations, while preserving every supplied move parameter. */
export function moveReplayIntent(body: MoveInput, actorId: number): MoveReplayIntent | null {
  if (body.requestId === undefined) return null;
  if (typeof body.requestId !== "string" || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(body.requestId)) {
    throw new TransferValidationError("请求编号无效，请重新打开移库表单", 400);
  }
  const numeric = (value: unknown) => value === undefined || value === null ? null : Number.isFinite(Number(value)) ? Number(value) : String(value);
  const fingerprint = JSON.stringify({
    id: numeric(body.id), expectedVersion: numeric(body.expectedVersion),
    targetLocation: locationCodeKey(body.targetLocation), mode: body.mode,
    quantity: numeric(body.quantity), boxes: numeric(body.boxes), pallets: numeric(body.pallets),
    sourceRemainingLayerCount: numeric(body.sourceRemainingLayerCount), targetLayerCount: numeric(body.targetLayerCount),
  });
  return { requestId: body.requestId, actorId, fingerprint };
}

export async function readMoveReplay(intent: MoveReplayIntent | null,user?:PermissionUser): Promise<Response | null> {
  if (!intent) return null;
  const row = await env.DB.prepare("SELECT actor_id,fingerprint,response_json,response_status FROM wms_move_requests WHERE request_id=?")
    .bind(intent.requestId).first<{ actor_id: number; fingerprint: string; response_json: string | null; response_status: number | null }>();
  if (!row) return null;
  if (row.actor_id !== intent.actorId || row.fingerprint !== intent.fingerprint) {
    return Response.json({ error: "该请求编号已用于另一项移库，请重新填写提交" }, { status: 409 });
  }
  if (!row.response_json || row.response_status !== 200) {
    return Response.json({ error: "该移库请求尚未完成，请保留填写并重试" }, { status: 409 });
  }
  return Response.json(redactWarehousePricing(JSON.parse(row.response_json),user));
}

/** This claim MUST precede the goods guard and all writes in the same transactional D1 batch. */
export function moveReplayClaim(intent: MoveReplayIntent | null, operationId: string, stamp: string) {
  return intent ? [env.DB.prepare("INSERT INTO wms_move_requests(request_id,actor_id,fingerprint,operation_id,created_at) VALUES (?,?,?,?,?)")
    .bind(intent.requestId, intent.actorId, intent.fingerprint, operationId, stamp)] : [];
}

/**
 * Capture the exact successful result while the stock/audit/goods transaction is still open.
 * Read rows from this operation's audit snapshot, including the assigned split destination ID.
 * An absent audit produces invalid JSON, failing the ledger CHECK and rolling everything back.
 */
export function moveReplayComplete(intent: MoveReplayIntent | null, operationId: string, targetLocation: string, capacityLayers: number) {
  if (!intent) return [];
  return [env.DB.prepare(`WITH
    target_layers AS (
      SELECT DISTINCT CASE WHEN layer_count > 0 THEN layer_count ELSE 1 END AS layer
      FROM stocks WHERE location_code = ? ORDER BY layer
    ),
    usage AS (
      SELECT COALESCE(json_group_array(layer),'[]') AS layers, COUNT(*) AS occupied,
        COALESCE(SUM(CASE WHEN layer <= ? THEN 1 ELSE 0 END),0) AS in_range,
        COALESCE(MAX(CASE WHEN layer > ? THEN 1 ELSE 0 END),0) AS exceeds
      FROM target_layers
    ),
    limits AS (SELECT ? AS capacity),
    result AS (
      SELECT json_object(
        'ok',json('true'), 'mode',json_extract(a.after_snapshot,'$.mode'),
        'source',json(CASE WHEN json_extract(a.after_snapshot,'$.mode')='all' THEN 'null' ELSE json_extract(a.after_snapshot,'$.rows[0]') END),
        'destination',json(CASE WHEN json_extract(a.after_snapshot,'$.mode')='all' THEN json_extract(a.after_snapshot,'$.rows[0]') ELSE json_extract(a.after_snapshot,'$.rows[1]') END),
        'capacity',json_object(
          'layers',json(u.layers), 'occupied',u.occupied, 'inRange',u.in_range,
          'remaining',CASE WHEN l.capacity=0 THEN NULL ELSE MAX(0,l.capacity-u.in_range) END,
          'unlimited',json(CASE WHEN l.capacity=0 THEN 'true' ELSE 'false' END),
          'over',json(CASE WHEN l.capacity<>0 AND u.exceeds=1 THEN 'true' ELSE 'false' END),
          'full',json(CASE WHEN l.capacity<>0 AND u.in_range=l.capacity THEN 'true' ELSE 'false' END),
          'state',CASE WHEN u.occupied=0 THEN 'empty' WHEN l.capacity=0 THEN 'unlimited' WHEN u.exceeds=1 THEN 'over' WHEN u.in_range=l.capacity THEN 'full' ELSE 'used' END
        ),
        'warning',CASE WHEN l.capacity<>0 AND u.exceeds=1 THEN '目标库位存在超出 '||CAST(l.capacity AS INTEGER)||' 层的货物，已允许移动' ELSE NULL END
      ) AS response
      FROM audit_logs a CROSS JOIN usage u CROSS JOIN limits l WHERE a.operation_id = ?
    )
    UPDATE wms_move_requests SET response_json=COALESCE((SELECT response FROM result),''),response_status=200
    WHERE request_id=? AND actor_id=? AND fingerprint=? AND operation_id=?
    RETURNING response_json,response_status`)
    .bind(targetLocation, capacityLayers, capacityLayers, capacityLayers, operationId, intent.requestId, intent.actorId, intent.fingerprint, operationId)];
}
