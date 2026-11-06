import {loadStockPalletMetadata,projectStockPallets} from '../../../../lib/stock-pallets';
import {activeStagingStockIds} from '../../../../lib/goods-staging';
import {redactWarehousePricing} from '../../../../lib/permissions';
import { goodsInventoryWritePlan,goodsPartialMovePlan } from "../../../../lib/goods-inventory-guard";
import { GoodsFlowError } from "../../../../lib/goods-flow";
import { goodsResponseError } from "../../../../lib/goods-store";
import { layerUsage, layerCapacity } from "../../../../lib/layer-capacity";
import { loadLocationAliases } from "../../../../lib/location-alias-store";
import { isLocationRenameConflict, resolveLocationAlias } from "../../../../lib/location-aliases";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { settings, stocks } from "../../../../db/schema";
import { requireWriteUser } from "../../../../lib/auth";
import { locationCodeKey } from "../../../../lib/location-code";
import { palletLabel } from "../../../../lib/pallet";
import { moveReplayIntent, readMoveReplay, moveReplayClaim, moveReplayComplete, type MoveReplayIntent } from "../../../../lib/stock-move-replay";
import { mergeRequiredWarehouseZones,type WarehouseZoneRecord } from "../../../../lib/warehouse-layout";
import {
  calculateCapacityStatus,
  makeTransferEnvelope,
  MoveMode,
  planStockTransfer,
  StockRow,
  TransferValidationError,
} from "../../../../lib/stock-transfer";

type MoveRequest = {
  requestId?: unknown;
  id?: unknown;
  expectedVersion?: unknown;
  targetLocation?: unknown;
  mode?: unknown;
  quantity?: unknown;
  boxes?: unknown;
  pallets?: unknown;
  sourceRemainingLayerCount?: unknown;
  targetLayerCount?: unknown;
};

const sourcePredicate = "id = ? AND version = ? AND updated_at = ? AND location_code = ?";

function stockFromSqlRow(value: Record<string, unknown>): StockRow {
  return {
    id: Number(value.id),
    locationCode: String(value.location_code ?? ""),
    inboundDate: String(value.inbound_date ?? ""),
    product: String(value.product ?? ""), productPrefix:String(value.product_prefix??""),productCondition:String(value.product_condition??""),
    sku: String(value.sku ?? ""), fnsku: String(value.fnsku ?? ""),
    barcode: String(value.barcode ?? ""),
    inboundOrder: String(value.inbound_order ?? ""),
    totalQuantity: Number(value.total_quantity ?? 0),
    totalBoxes: Number(value.total_boxes ?? 0),
    inventoryUnit: String(value.inventory_unit ?? 'item'),
    inventoryReviewDecision: String(value.inventory_review_decision ?? ''),
    customerName: String(value.customer_name ?? ""),
    palletCount: Number(value.pallet_count ?? 0),
    palletLabel: String(value.pallet_label ?? ""),
    layerCount: Number(value.layer_count ?? 1),
    inboundSource: String(value.inbound_source ?? "domestic"),
    billingMode: String(value.billing_mode ?? "item"),
    itemVolumeM3: Number(value.item_volume_m3 ?? 0),
    boxVolumeM3: Number(value.box_volume_m3 ?? 0),
    storageRateUsd: Number(value.storage_rate_usd ?? 0.7),
    freeDays: Number(value.free_days ?? 0),
    catalogItemId: value.catalog_item_id === null || value.catalog_item_id === undefined ? null : Number(value.catalog_item_id),
    note: String(value.note ?? ""),
    updatedBy: String(value.updated_by ?? ""),
    updatedAt: String(value.updated_at ?? ""),
    version: Number(value.version ?? 0),
  };
}

function firstSqlRow(result: unknown) {
  const rows = result && typeof result === "object"
    ? (result as { results?: Array<Record<string, unknown>> }).results
    : undefined;
  return rows?.[0] ?? null;
}

async function targetLocationDetails(requested: string) {
  requested = resolveLocationAlias(requested, await loadLocationAliases());
  const [row] = await getDb().select().from(settings).where(eq(settings.key, "warehouse_zones")).limit(1);
  if (!row) throw new TransferValidationError("仓库地图尚未建立，无法选择目标库位", 409);
  let zones: WarehouseZoneRecord[];
  try {
    const parsed = JSON.parse(row.value) as unknown;
    if (!Array.isArray(parsed)) throw new Error("invalid zones");
    zones = mergeRequiredWarehouseZones(parsed as WarehouseZoneRecord[]);
  } catch {
    throw new TransferValidationError("仓库地图数据异常，请联系管理员", 409);
  }
  const key = locationCodeKey(requested), matches: Array<{ zone: WarehouseZoneRecord; code: string }> = [];
  for (const zone of zones) {
    if (!Array.isArray(zone.codes)) continue;
    for (const code of zone.codes) if (typeof code === "string" && locationCodeKey(code) === key) matches.push({ zone, code });
  }
  if (matches.length > 1) throw new TransferValidationError(`库位编号 ${requested} 存在重复，请联系管理员处理`, 409);
  if (matches.length === 1) {
    const { zone, code } = matches[0], layout = zone.layout?.[code] ?? {};
    return { locationCode: code, capacityLayers: layerCapacity(layout,code) };
  }
  throw new TransferValidationError(`没有找到目标库位 ${requested}`, 404);
}

async function usageAt(locationCode: string) {
  const rows = await getDb().select({ boxes: stocks.totalBoxes, pallets: stocks.palletCount })
    .from(stocks).where(eq(stocks.locationCode, locationCode));
  return rows.reduce((total, row) => ({
    boxes: total.boxes + row.boxes,
    pallets: Number((total.pallets + row.pallets).toFixed(8)),
  }), { boxes: 0, pallets: 0 });
}

function operationSummary(before: StockRow, targetLocation: string, plan: ReturnType<typeof planStockTransfer>) {
  const layerSummary = plan.mode === "all"
    ? `层数 ${before.layerCount} → ${plan.destinationAfter.layerCount}`
    : `来源层数 ${before.layerCount} → ${plan.sourceAfter!.layerCount}｜目标层数 ${plan.destinationAfter.layerCount}`;
  return `${before.product}｜${before.locationCode} → ${targetLocation}｜${plan.mode === "all" ? "整批移动" : "部分移动"}｜数量 ${plan.moved.quantity}｜箱数 ${plan.moved.boxes}｜${layerSummary}｜单号 ${before.inboundOrder || "—"}`;
}

export async function POST(request: Request) {
  const auth = await requireWriteUser(request,"stock.move");
  if (auth.error) return auth.error;

  let replayIntent: MoveReplayIntent | null = null;
  try {
    const body = await request.json() as MoveRequest;
    replayIntent = moveReplayIntent(body, auth.user!.id);
    const replay = await readMoveReplay(replayIntent,auth.user!);
    if (replay) return replay;
    const id = Number(body.id);
    const expectedVersion = Number(body.expectedVersion);
    const requestedTarget = String(body.targetLocation ?? "").trim();
    const mode = body.mode as MoveMode;
    if (!Number.isSafeInteger(id) || id <= 0) return Response.json({ error: "货物编号无效" }, { status: 400 });
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) return Response.json({ error: "库存版本无效，请刷新后重试" }, { status: 400 });
    if (!requestedTarget) return Response.json({ error: "请选择目标库位" }, { status: 400 });
    if (mode !== "all" && mode !== "partial") return Response.json({ error: "移动方式无效" }, { status: 400 });

    const db = getDb();
    const palletMetadata=await loadStockPalletMetadata(db.$client);
    const before = projectStockPallets(await db.select().from(stocks),palletMetadata).find(row=>row.id===id);
    if (!before) {
      const replay = await readMoveReplay(replayIntent,auth.user!);
      if (replay) return replay;
      return Response.json({ error: "货物不存在" }, { status: 404 });
    }
    if (before.version !== expectedVersion) {
      const replay = await readMoveReplay(replayIntent,auth.user!);
      if (replay) return replay;
      return Response.json({ error: "该库存刚刚被其他账号修改，请刷新后重试" }, { status: 409 });
    }
    if(mode==='partial'&&(await activeStagingStockIds()).has(id))return Response.json({error:'这条实物已移库待出库，不能部分移库拆分；请先撤销备货或完成出库。整批移库可保留任务。'},{status:409});
    const target = await targetLocationDetails(requestedTarget);
    const stamp = new Date().toISOString();
    const operationId = crypto.randomUUID();
    const replayClaim = moveReplayClaim(replayIntent, operationId, stamp);
    const replayComplete = moveReplayComplete(replayIntent, operationId, target.locationCode, target.capacityLayers);
    const plan = planStockTransfer({
      before,
      targetLocation: target.locationCode,
      mode,
      quantity: body.quantity,
      boxes: body.boxes,
      pallets: body.pallets,
      sourceRemainingLayerCount: body.sourceRemainingLayerCount,
      targetLayerCount: body.targetLayerCount,
      userName: auth.user!.displayName,
      stamp,
    });
    const beforeUsage = await usageAt(target.locationCode);
    const entityId = `${before.locationCode} → ${target.locationCode}`;
    const summary = operationSummary(before, target.locationCode, plan);
    const beforeEnvelope = makeTransferEnvelope({
      operationId, mode, sourceLocation: before.locationCode, targetLocation: target.locationCode, rows: [before],
    });

    let source: StockRow | null;
    let destination: StockRow;
    if (mode === "all") {
      const afterEnvelope = makeTransferEnvelope({
        operationId, mode, sourceLocation: before.locationCode, targetLocation: target.locationCode,
        rows: [plan.destinationAfter],
      });
      const goods=await goodsInventoryWritePlan([{before,after:plan.destinationAfter}],"move",{expectedPalletSettings:palletMetadata.settings});
      const results = await env.DB.batch([
        ...replayClaim,
        ...goods.guard,
        env.DB.prepare(`UPDATE stocks
          SET location_code = ?, layer_count = ?, pallet_count=?,pallet_label=?, updated_by = ?, updated_at = ?, version = version + 1
          WHERE ${sourcePredicate}
          RETURNING *`).bind(
          target.locationCode, plan.destinationAfter.layerCount,before.palletCount,palletLabel(before.palletCount), auth.user!.displayName, stamp,
          before.id, before.version, before.updatedAt, before.locationCode,
        ),
        env.DB.prepare(`INSERT INTO audit_logs
          (user_id,user_name,action,entity_type,entity_id,operation_id,summary,before_snapshot,after_snapshot,created_at)
          SELECT ?,?,?,?,?,?,?,?,?,?
          FROM stocks
          WHERE id = ? AND version = ? AND updated_at = ? AND location_code = ? AND layer_count = ?
          RETURNING id`).bind(
          auth.user!.id, auth.user!.displayName, "移库", "库位", entityId, operationId, summary,
          JSON.stringify(beforeEnvelope), JSON.stringify(afterEnvelope), stamp,
          before.id, before.version + 1, stamp, target.locationCode, plan.destinationAfter.layerCount,
        ),
        env.DB.prepare("INSERT INTO settings(key,value,updated_at) VALUES (?,'true',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").bind('pallet_manual:stock:'+before.id,stamp),
        ...goods.afterQueries,
        ...replayComplete,
      ]);
      const movedRow = firstSqlRow(results[replayClaim.length+goods.guard.length]);
      const auditRow = firstSqlRow(results[replayClaim.length+goods.guard.length+1]);
      if (!movedRow || !auditRow) {
        return Response.json({ error: "该库存刚刚被其他账号修改，请刷新后重试" }, { status: 409 });
      }
      destination = stockFromSqlRow(movedRow);
      source = null;
    } else {
      const sourceAfter = plan.sourceAfter!;
      const goods=await goodsPartialMovePlan(before,{locationCode:target.locationCode,updatedAt:stamp,layerCount:plan.destinationAfter.layerCount},operationId,palletMetadata.settings);
      const afterTemplate = makeTransferEnvelope({
        operationId, mode, sourceLocation: before.locationCode, targetLocation: target.locationCode,
        rows: [sourceAfter, plan.destinationAfter],
      });
      const results = await env.DB.batch([
        ...replayClaim,
        ...goods.guard,
        env.DB.prepare(`INSERT INTO stocks
          (location_code,inbound_date,product,product_prefix,product_condition,sku,fnsku,barcode,inbound_order,total_quantity,total_boxes,customer_name,
           pallet_count,pallet_label,layer_count,inbound_source,billing_mode,item_volume_m3,box_volume_m3,
           storage_rate_usd,free_days,catalog_item_id,note,updated_by,updated_at,version,inventory_unit,inventory_review_decision)
          SELECT ?,inbound_date,product,product_prefix,product_condition,sku,fnsku,barcode,inbound_order,?,?,customer_name,?,?,?,inbound_source,
           billing_mode,item_volume_m3,box_volume_m3,storage_rate_usd,free_days,catalog_item_id,note,?,?,0,inventory_unit,inventory_review_decision
          FROM stocks
          WHERE ${sourcePredicate}
          RETURNING *`).bind(
          target.locationCode, plan.moved.quantity, plan.moved.boxes, plan.moved.pallets,
          palletLabel(plan.moved.pallets), plan.destinationAfter.layerCount, auth.user!.displayName, stamp,
          before.id, before.version, before.updatedAt, before.locationCode,
        ),
        env.DB.prepare(`UPDATE stocks
          SET total_quantity = ?, total_boxes = ?, pallet_count = ?, pallet_label = ?,
              layer_count = ?, updated_by = ?, updated_at = ?, version = version + 1
          WHERE ${sourcePredicate}
          RETURNING *`).bind(
          sourceAfter.totalQuantity, sourceAfter.totalBoxes, sourceAfter.palletCount, sourceAfter.palletLabel,
          sourceAfter.layerCount, auth.user!.displayName, stamp,
          before.id, before.version, before.updatedAt, before.locationCode,
        ),
        env.DB.prepare(`INSERT INTO audit_logs
          (user_id,user_name,action,entity_type,entity_id,operation_id,summary,before_snapshot,after_snapshot,created_at)
          SELECT ?,?,?,?,?,?,?,?,json_set(?, '$.rows[1].id', last_insert_rowid()),?
          FROM stocks
          WHERE id = ? AND version = ? AND updated_at = ? AND location_code = ?
            AND total_quantity = ? AND total_boxes = ? AND ABS(pallet_count - ?) < 0.000000001 AND layer_count = ?
            AND EXISTS (
              SELECT 1 FROM stocks
              WHERE id = last_insert_rowid() AND location_code = ? AND updated_at = ?
                AND total_quantity = ? AND total_boxes = ? AND ABS(pallet_count - ?) < 0.000000001 AND layer_count = ?
            )
          RETURNING id`).bind(
          auth.user!.id, auth.user!.displayName, "移库", "库位", entityId, operationId, summary,
          JSON.stringify(beforeEnvelope), JSON.stringify(afterTemplate), stamp,
          before.id, before.version + 1, stamp, before.locationCode,
          sourceAfter.totalQuantity, sourceAfter.totalBoxes, sourceAfter.palletCount, sourceAfter.layerCount,
          target.locationCode, stamp, plan.moved.quantity, plan.moved.boxes, plan.moved.pallets, plan.destinationAfter.layerCount,
        ),
        env.DB.prepare("INSERT INTO settings(key,value,updated_at) SELECT 'pallet_manual:stock:'||json_extract(after_snapshot,'$.rows[1].id'),'true',? FROM audit_logs WHERE operation_id=? ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").bind(stamp,operationId),
        ...goods.afterQueries,
        ...replayComplete,
      ]);
      const destinationRow = firstSqlRow(results[replayClaim.length+goods.guard.length]);
      const sourceRow = firstSqlRow(results[replayClaim.length+goods.guard.length+1]);
      const auditRow = firstSqlRow(results[replayClaim.length+goods.guard.length+2]);
      if (!destinationRow || !sourceRow || !auditRow) {
        return Response.json({ error: "该库存刚刚被其他账号修改，请刷新后重试" }, { status: 409 });
      }
      destination = stockFromSqlRow(destinationRow);
      source = stockFromSqlRow(sourceRow);
    }

    if (replayIntent) {
      const persisted = await readMoveReplay(replayIntent,auth.user!);
      if (persisted) return persisted;
      throw new Error("移库结果未保存，请保留填写并重试");
    }
    const afterUsage = await usageAt(target.locationCode);
    const targetStocks=await db.select({layerCount:stocks.layerCount}).from(stocks).where(eq(stocks.locationCode,target.locationCode));
    const capacity=layerUsage(targetStocks,target.capacityLayers),warning=capacity.over?`目标库位存在超出 ${target.capacityLayers} 层的货物，已允许移动`:null;
    return Response.json(redactWarehousePricing({ ok: true, mode, source, destination, capacity, warning },auth.user!));
  } catch (error) {
    // A competing identical request may have committed between our initial read and batch.
    // Its unique claim aborts our entire batch; return the winner before classifying stale guards.
    if (replayIntent) {
      const replay = await readMoveReplay(replayIntent,auth.user!);
      if (replay) return replay;
    }
    if(error instanceof GoodsFlowError||/goods_transaction_guards|CHECK constraint failed: valid|wms_move_request_complete/.test(String(error)))return goodsResponseError(error); if (isLocationRenameConflict(error)) return Response.json({ error: "库位名称已更新或库存刚有变化，请刷新重试" }, { status: 409 });
    if (error instanceof TransferValidationError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    const message = error instanceof Error ? error.message : "移动失败";
    if (/audit_logs_operation_id_idx|audit_logs\.operation_id|UNIQUE constraint failed/i.test(message)) {
      return Response.json({ error: "该移动操作已经处理，请刷新库存" }, { status: 409 });
    }
    return Response.json({ error: message }, { status: 500 });
  }
}
