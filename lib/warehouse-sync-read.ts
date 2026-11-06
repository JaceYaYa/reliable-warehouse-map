import {STOCK_PALLET_SETTINGS_SQL,STOCK_PALLET_AUDITS_SQL,projectStockPallets} from './stock-pallets.ts';
import { redactMovementSnapshotPricing } from "./movement-display.ts";
import { hasPermission, effectivePermissions, redactWarehousePricing, type PermissionUser } from "./permissions.ts";
import { mergeRequiredWarehouseZonesForCanvas, normalizeWarehouseCanvasSize, DEFAULT_WAREHOUSE_CANVAS_SIZE } from "./warehouse-canvas.ts";
import { SYNC_RESOURCES, type SyncPayload, type SyncUsage, type SyncVersions } from "./warehouse-sync.ts";
import { locationMapRevision } from "./location-map-revision.ts";

// Keep the measured scope explicit: only these data queries, not authentication,
// other requests, or Cloudflare's account-wide billable usage.
type QueryDb = { prepare: (sql: string) => { bind: (...values: unknown[]) => { all: () => Promise<{ results: Record<string, unknown>[]; meta?: { rows_read?: number; rows_written?: number } }> } } };
const camelRow = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()), value]));
const actions = "'入库','出库','移库','库存修改','删除','恢复','箱件收货','箱件出库','箱件认领改单','箱件删除','撤销箱件操作'";

export function createSyncReader(db: QueryDb) {
  const usage: SyncUsage = { rowsRead: 0, rowsWritten: 0, queries: 0 };
  async function rows(sql: string, values: unknown[] = []) {
    const result = await db.prepare(sql).bind(...values).all();
    usage.queries++;
    usage.rowsRead = usage.rowsRead !== null && typeof result.meta?.rows_read === "number" ? usage.rowsRead + result.meta.rows_read : null;
    usage.rowsWritten = usage.rowsWritten !== null && typeof result.meta?.rows_written === "number" ? usage.rowsWritten + result.meta.rows_written : null;
    return result.results;
  }
  return {
    usage,
    async versions(viewerKey: string): Promise<SyncVersions> {
      const versions = await rows("SELECT resource, revision FROM warehouse_sync_versions");
      if (versions.length !== 3) throw new Error("同步版本表尚未初始化");
      return Object.fromEntries(versions.map(row => [String(row.resource), `${viewerKey}:${row.revision}`]));
    },
    async stocks() { const raw=(await rows("SELECT * FROM stocks ORDER BY updated_at DESC")).map(camelRow),settings=await rows(STOCK_PALLET_SETTINGS_SQL),audits=await rows(STOCK_PALLET_AUDITS_SQL);return {stocks:projectStockPallets(raw as never[],{settings:settings as Array<{key:string;value:string}>,audits})}; },
    async locations() {
      const stored = await rows("SELECT key, value FROM settings WHERE key IN ('warehouse_zones','warehouse_map_canvas')");
      const canvasRow = stored.find(row => row.key === "warehouse_map_canvas"), zoneRow = stored.find(row => row.key === "warehouse_zones");
      let canvas = { ...DEFAULT_WAREHOUSE_CANVAS_SIZE };
      try { if (canvasRow) canvas = normalizeWarehouseCanvasSize(JSON.parse(String(canvasRow.value))); } catch { /* Match the legacy location endpoint's canvas fallback. */ }
      return { canvas, zones: zoneRow ? mergeRequiredWarehouseZonesForCanvas(JSON.parse(String(zoneRow.value)), canvas) : null, revision: await locationMapRevision(zoneRow ? String(zoneRow.value) : "", canvasRow ? String(canvasRow.value) : "") };
    },
    async recent(input: string | PermissionUser) {
      const viewer=typeof input === "string"?{role:input}:input;
      if(!hasPermission(viewer,"records.view"))return {logs:[],restoredIds:[],canRestore:false,canRestoreDeletedStocks:false};
      const logs = (await rows(`SELECT * FROM audit_logs INDEXED BY audit_logs_recent_sync_idx WHERE action IN (${actions}) ORDER BY id DESC LIMIT 1`)).map(camelRow);
      const latest = logs[0];
      if(latest?.entityType==='箱件收货'&&latest.operationId){
        const [operation]=await rows('SELECT * FROM carton_operations WHERE id=?',[latest.operationId]);
        const [current]=operation?await rows('SELECT * FROM carton_receipts WHERE id=?',[operation.receipt_id]):[];
        const permission=operation?.kind==='inbound'?'stock.inbound':operation?.kind==='outbound'?'stock.outbound':operation?.kind==='discard'?'stock.delete':'stock.edit';
        let matches=false;try{const expected=JSON.parse(String(operation?.after_snapshot||'null')),actual=current?camelRow(current):null;matches=!!expected&&!!actual&&Object.keys(expected).every(key=>expected[key]===actual[key]);}catch{/* damaged snapshot is read only */}
        latest.canRestore=hasPermission(viewer,'stock.restore')&&hasPermission(viewer,permission)&&matches&&!operation?.restored_at&&operation?.kind!=='restore';
      }
      const restored = latest && !["恢复","撤销箱件操作"].includes(String(latest.action))
        ? await rows("SELECT entity_id FROM audit_logs WHERE entity_id = ? AND action = '恢复' LIMIT 1", [String(latest.id)]) : [];
      const visibleLogs: Record<string,unknown>[] = hasPermission(viewer,"pricing.manage") ? logs : logs.map(log => ({ ...log, beforeSnapshot: redactMovementSnapshotPricing(log.beforeSnapshot as string | null), afterSnapshot: redactMovementSnapshotPricing(log.afterSnapshot as string | null) }));
      return { logs: visibleLogs.map(log=>{if(!String(log.entityType).startsWith("箱件"))return log;try{const value=JSON.parse(String(log.afterSnapshot||log.beforeSnapshot||"null")),p=typeof value?.placements==="string"?JSON.parse(value.placements):value?.placements;return {...log,entityId:[...new Set((p||[]).map((x:{locationCode:string})=>x.locationCode))].join("、")}}catch{return log}}), restoredIds: restored.map(row => Number(row.entity_id)), canRestore: hasPermission(viewer,"stock.restore"), canRestoreDeletedStocks: hasPermission(viewer,"stock.delete") && hasPermission(viewer,"stock.restore") };
    },
  };
}

export async function readWarehouseSync(db: QueryDb, viewer: NonNullable<SyncPayload["viewer"]>, params: URLSearchParams): Promise<SyncPayload> {
  const reader = createSyncReader(db);
  // Read the version before the data, so a concurrent write is checked again on
  // the next poll. Never advance a version based on a later database snapshot.
  const versions = await reader.versions(`${viewer.id}:${viewer.role}:${effectivePermissions(viewer).join(",")}`), data: SyncPayload["data"] = {};
  await Promise.all(SYNC_RESOURCES.map(async resource => {
    if (resource === "locations" && params.get("skipLocations") === "1") return;
    if (params.get(resource) === versions[resource]) return;
    data[resource] = resource === "recent" ? await reader.recent(viewer) : resource === "stocks" ? redactWarehousePricing(await reader.stocks(),viewer) : await reader.locations();
  }));
  return { versions, data, viewer, usage: reader.usage };
}
