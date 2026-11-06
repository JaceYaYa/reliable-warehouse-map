import { hasPermission } from "../../../lib/permissions";
import { layerCapacity } from "../../../lib/layer-capacity";
import { GoodsFlowError } from "../../../lib/goods-flow";
import { LAYER_PRICING_KEY } from "../../../lib/layer-storage";
import { changeLocationLayerVolume, changeLocationLayerVolumes, locationLayerConfig, locationLayerVolume, saveLocationCapacity } from "../../../lib/location-layer-volume";
import { eq, inArray, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { getDb } from "../../../db";
import { settings, stocks as stockRecords, storageFeeSettlements, warehouseSyncVersions,cartonReceipts,cartonOperations,auditLogs } from "../../../db/schema";
import { recordAudit } from "../../../lib/audit";
import { requireUser, requireWriteUser } from "../../../lib/auth";
import {
  DEFAULT_WAREHOUSE_CANVAS_SIZE,
  mergeRequiredWarehouseZonesForCanvas,
  normalizeWarehouseCanvasSize,
  validateWarehouseCanvasContent,
  validateWarehouseCanvasSize,
  WAREHOUSE_CANVAS_SETTINGS_KEY,
  type WarehouseCanvasSize,
} from "../../../lib/warehouse-canvas";
import type { WarehouseZoneRecord } from "../../../lib/warehouse-layout";

import { isLocationRenameConflict, LOCATION_ALIASES_KEY, composeLocationAliases, parseLocationAliases, resolveLocationAlias } from "../../../lib/location-aliases";
import { locationCodeKey } from "../../../lib/location-code";
import { locationMapRevision } from "../../../lib/location-map-revision";
import {remapSnapshotLocations} from '../../../lib/location-aliases';
import {remapCartonRowSnapshot} from '../../../lib/carton-location';
import type {CartonPlacement} from '../../../lib/carton-flow';

const ZONES_SETTINGS_KEY = "warehouse_zones";
const batchTuple = (queries: BatchItem<"sqlite">[]) => queries as [
  BatchItem<"sqlite">,
  ...BatchItem<"sqlite">[],
];

function canvasFromSetting(value?: string | null): WarehouseCanvasSize {
  if (!value) return { ...DEFAULT_WAREHOUSE_CANVAS_SIZE };
  try {
    return normalizeWarehouseCanvasSize(JSON.parse(value));
  } catch {
    return { ...DEFAULT_WAREHOUSE_CANVAS_SIZE };
  }
}

export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  try {
    const db = getDb();
    const storedRows = await db
      .select()
      .from(settings)
      .where(inArray(settings.key, [ZONES_SETTINGS_KEY, WAREHOUSE_CANVAS_SETTINGS_KEY, LOCATION_ALIASES_KEY, LAYER_PRICING_KEY]));
    const zoneRow = storedRows.find(row => row.key === ZONES_SETTINGS_KEY);
    const canvasRow = storedRows.find(row => row.key === WAREHOUSE_CANVAS_SETTINGS_KEY);
    const canvas = canvasFromSetting(canvasRow?.value);
    const zones = zoneRow
      ? mergeRequiredWarehouseZonesForCanvas(
          JSON.parse(zoneRow.value) as WarehouseZoneRecord[],
          canvas,
        )
      : null;
    const layerVolume=locationLayerVolume(locationLayerConfig(storedRows.find(row=>row.key===LAYER_PRICING_KEY)?.value),zones??[],parseLocationAliases(storedRows.find(row=>row.key===LOCATION_ALIASES_KEY)?.value));
    return Response.json({ zones, canvas, revision: await locationMapRevision(zoneRow?.value, canvasRow?.value), layerVolume });
  } catch (error) { if (isLocationRenameConflict(error)) return Response.json({ error: "库位名称已更新或库存刚有变化，请刷新重试" }, { status: 409 });
    return Response.json(
      { error: error instanceof Error ? error.message : "读取失败" },
      { status: error instanceof GoodsFlowError ? error.status : 500 },
    );
  }
}

export async function POST(request: Request) {
  const auth = await requireUser(request,"map.edit");
  if (auth.error) return auth.error;
  try {
    const payload = await request.json() as {
      zones?: unknown;
      renames?: Record<string, string>;
      canvas?: unknown;
      expectedRevision?: string;
    };
    if (!Array.isArray(payload.zones) || !payload.zones.length) {
      return Response.json({ error: "至少保留一个区域" }, { status: 400 });
    }

    const db = getDb();
    const storedRows = await db.select().from(settings).where(inArray(settings.key, [ZONES_SETTINGS_KEY, WAREHOUSE_CANVAS_SETTINGS_KEY, LOCATION_ALIASES_KEY]));
    const storedCanvas = storedRows.find(row => row.key === WAREHOUSE_CANVAS_SETTINGS_KEY);
    const previousZones: WarehouseZoneRecord[] = JSON.parse(storedRows.find(row => row.key === ZONES_SETTINGS_KEY)?.value || "[]");
    const previousAliases = parseLocationAliases(storedRows.find(row => row.key === LOCATION_ALIASES_KEY)?.value);
    const previousCanvas = canvasFromSetting(storedCanvas?.value);
    const currentRevision = await locationMapRevision(storedRows.find(row => row.key === ZONES_SETTINGS_KEY)?.value, storedCanvas?.value);
    if (payload.expectedRevision !== currentRevision) return Response.json({ error: "地图已更新，请关闭库位管理并刷新页面后重新编辑；本次未保存" }, { status: 409 });
    if (payload.zones.some(zone => !zone || typeof zone.id !== "string" || !zone.id.trim() || typeof zone.title !== "string" || !Array.isArray(zone.codes) || !zone.codes.length || zone.codes.some((code: unknown) => typeof code !== "string" || !code.trim()))) return Response.json({ error: "每个区域至少保留一个库位，编号不能为空" }, { status: 400 });
    if (new Set(payload.zones.map(zone => zone.id)).size !== payload.zones.length) return Response.json({ error: "区域编号不能重复" }, { status: 400 });
    if(payload.zones.some(zone=>Object.values(zone.layout??{}).some(box=>box&&typeof box==="object"&&"capacityLayers" in box&&(!Number.isSafeInteger(box.capacityLayers)||Number(box.capacityLayers)<0))))return Response.json({error:"最大层数须为大于或等于0的整数"},{status:400});
    const submittedCodes = payload.zones.flatMap(zone => zone.codes);
    if (new Set(submittedCodes.map(locationCodeKey)).size !== submittedCodes.length) return Response.json({ error: "库位编号不能重复" }, { status: 400 });
    const hasCanvas = Object.prototype.hasOwnProperty.call(payload, "canvas");
    const canvasResult = hasCanvas
      ? validateWarehouseCanvasSize(payload.canvas)
      : { ok: true as const, size: previousCanvas };
    if (!canvasResult.ok) {
      return Response.json({ error: canvasResult.error }, { status: 400 });
    }

    const mergedZones = mergeRequiredWarehouseZonesForCanvas(
      (payload.zones as WarehouseZoneRecord[]).map(zone => ({ ...zone, codes: zone.codes.map(code => code.trim()), locationCodesVersion: 1 })),
      canvasResult.size,
    );
    const contentResult = validateWarehouseCanvasContent(mergedZones, canvasResult.size);
    if (!contentResult.ok) {
      return Response.json(
        { error: contentResult.error, minimumCanvas: contentResult.minimum },
        { status: 400 },
      );
    }

    if (payload.renames !== undefined && (!payload.renames || typeof payload.renames !== "object" || Array.isArray(payload.renames) || Object.entries(payload.renames).some(([from, to]) => !from.trim() || typeof to !== "string" || !to.trim()))) return Response.json({ error: "库位改名格式不正确" }, { status: 400 });
    const renames = payload.renames && typeof payload.renames === "object"
      ? payload.renames
      : {};
    const renameEntries = Object.entries(renames).filter(
      ([from, to]) => from.trim() && to.trim() && from !== to,
    );
    if(!hasPermission(auth.user!,"capacity.edit")){
      for(const zone of mergedZones)for(const code of zone.codes){
        const oldCode=renameEntries.find(([,to])=>to===code)?.[0]??code;
        const previous=previousZones.find(z=>z.codes.includes(oldCode));
        if(previous&&layerCapacity(previous.layout?.[oldCode],oldCode)!==layerCapacity(zone.layout?.[code],code))return Response.json({error:"修改容量还需要层数容量设置权限"},{status:403});
      }
    }
    const oldCodes = previousZones.flatMap(zone => zone.codes), nextCodes = mergedZones.flatMap(zone => zone.codes);
    if (new Set(nextCodes.map(locationCodeKey)).size !== nextCodes.length) return Response.json({ error: "库位编号不能重复" }, { status: 400 });
    const aliasSourceKeys = new Set(Object.keys(previousAliases).map(locationCodeKey));
    // An old name may be restored to the same physical bin, but never recycled
    // for an unrelated bin: past records and stale clients still refer to it.
    if (nextCodes.some(code => aliasSourceKeys.has(locationCodeKey(code)) && !renameEntries.some(([from, to]) => to === code && locationCodeKey(resolveLocationAlias(code, previousAliases)) === locationCodeKey(from)))) return Response.json({ error: "该编号曾属于其他库位，请使用新编号，或直接将原库位改回这个名称" }, { status: 409 });
    if (renameEntries.some(([from, to]) => nextCodes.some(code => locationCodeKey(code) === locationCodeKey(from) && code !== to))) return Response.json({ error: "改名后不能保留原库位编号" }, { status: 409 });
    const sourceKeys = new Set(renameEntries.map(([from]) => locationCodeKey(from)));
    const removedCodes = oldCodes.filter(code => !nextCodes.some(next => locationCodeKey(next) === locationCodeKey(code)) && !sourceKeys.has(locationCodeKey(code)));
    const targetKeys = renameEntries.map(([, to]) => locationCodeKey(to));
    if (new Set(targetKeys).size !== targetKeys.length || renameEntries.some(([from, to]) => !oldCodes.includes(from) || !nextCodes.includes(to) || oldCodes.some(code => locationCodeKey(code) === locationCodeKey(to) && code !== from))) return Response.json({ error: "库位改名冲突，请刷新地图后核对" }, { status: 409 });
    let stockRevision = "";
    const cartonRows=(renameEntries.length||removedCodes.length)?await db.select().from(cartonReceipts):[];
    // One bound parameter keeps the concurrency guard below D1's per-query
    // parameter limit when many unrelated receipt records already exist.
    const cartonStamp=cartonRows.slice().sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0).map(row=>JSON.stringify([row.id,row.version,row.placements])).join('|');
    const cartonUnchanged=(renameEntries.length||removedCodes.length)?sql`COALESCE((SELECT group_concat(signature,'|') FROM (SELECT json_array(id,version,placements) AS signature FROM carton_receipts ORDER BY id)),'')=${cartonStamp}`:sql`1`;
    if (renameEntries.length || removedCodes.length) {
      const [revision] = await db.select().from(warehouseSyncVersions).where(eq(warehouseSyncVersions.resource, "stocks"));
      stockRevision = revision?.revision ?? "";
      const occupied = [...await db.select({ locationCode: stockRecords.locationCode }).from(stockRecords),...cartonRows.flatMap(row=>(JSON.parse(row.placements) as CartonPlacement[]).filter(p=>p.boxes>0).map(p=>({locationCode:resolveLocationAlias(p.locationCode,previousAliases)})))];
      if (occupied.some(stock => targetKeys.includes(locationCodeKey(stock.locationCode)) && !sourceKeys.has(locationCodeKey(stock.locationCode)))) return Response.json({ error: "目标库位已有货物，不能通过改名合并库位" }, { status: 409 });
      const occupiedRemoved = removedCodes.filter(code => occupied.some(stock => locationCodeKey(code) === locationCodeKey(stock.locationCode)));
      if (occupiedRemoved.length) return Response.json({ error: `库位还有货物：${occupiedRemoved.join("、")}，请先移走货物再删除` }, { status: 409 });
    }
    const aliases = composeLocationAliases(previousAliases, Object.fromEntries(renameEntries), nextCodes);
    const stamp = Date.now();
    const updatedAt = new Date().toISOString();
    const zoneValue = JSON.stringify(mergedZones);
    const savedZoneValue = sql<string>`CASE WHEN
      COALESCE((SELECT value FROM settings WHERE key = ${ZONES_SETTINGS_KEY}), '') = ${storedRows.find(row => row.key === ZONES_SETTINGS_KEY)?.value ?? ""}
      AND COALESCE((SELECT value FROM settings WHERE key = ${WAREHOUSE_CANVAS_SETTINGS_KEY}), '') = ${storedCanvas?.value ?? ""}
      AND (${removedCodes.length && !renameEntries.length ? 0 : 1} OR COALESCE((SELECT revision FROM warehouse_sync_versions WHERE resource = 'stocks'), '') = ${stockRevision})
      AND (${renameEntries.length?sql`1`:cartonUnchanged})
      THEN ${zoneValue} ELSE NULL END`;
    const canvasValue = JSON.stringify(canvasResult.size);
    const queries: BatchItem<"sqlite">[] = [];
    if (renameEntries.length) {
      // Check names under the same transaction as the rename, including concurrent receiving.
      const targetValues = sql.join(renameEntries.map(([, to]) => sql`${to}`), sql`, `);
      const guardedValue = sql<string>`CASE WHEN NOT EXISTS (SELECT 1 FROM stocks WHERE location_code IN (${targetValues}))
        AND (${cartonUnchanged})
        AND COALESCE((SELECT revision FROM warehouse_sync_versions WHERE resource = 'stocks'), '') = ${stockRevision}
        AND COALESCE((SELECT value FROM settings WHERE key = ${ZONES_SETTINGS_KEY}), '') = ${storedRows.find(row => row.key === ZONES_SETTINGS_KEY)?.value ?? ""}
        AND COALESCE((SELECT value FROM settings WHERE key = ${LOCATION_ALIASES_KEY}), '') = ${storedRows.find(row => row.key === LOCATION_ALIASES_KEY)?.value ?? ""}
        THEN ${JSON.stringify(aliases)} ELSE NULL END`;
      queries.push(db.insert(settings).values({ key: LOCATION_ALIASES_KEY, value: guardedValue, updatedAt }).onConflictDoUpdate({ target: settings.key, set: { value: guardedValue, updatedAt } }));
    }

    for (const [index, [from]] of renameEntries.entries()) {
      queries.push(
        db.update(stockRecords).set({ locationCode: `__rename_${stamp}_${index}__` }).where(eq(stockRecords.locationCode, from)),
        db.update(storageFeeSettlements).set({ locationCode: `__rename_${stamp}_${index}__` }).where(eq(storageFeeSettlements.locationCode, from)),
      );
    }
    for (const [index, [, to]] of renameEntries.entries()) {
      queries.push(
        db.update(stockRecords).set({ locationCode: to }).where(eq(stockRecords.locationCode, `__rename_${stamp}_${index}__`)),
        db.update(storageFeeSettlements).set({ locationCode: to }).where(eq(storageFeeSettlements.locationCode, `__rename_${stamp}_${index}__`)),
      );
    }
    if(renameEntries.length){
      const cartonAliases=Object.fromEntries(renameEntries);
      for(const row of cartonRows)queries.push(db.update(cartonReceipts).set({placements:remapSnapshotLocations(row.placements,cartonAliases)!}).where(eq(cartonReceipts.id,row.id)));
      for(const op of await db.select().from(cartonOperations))queries.push(db.update(cartonOperations).set({beforeSnapshot:remapCartonRowSnapshot(op.beforeSnapshot,cartonAliases),afterSnapshot:remapCartonRowSnapshot(op.afterSnapshot,cartonAliases),result:remapSnapshotLocations(op.result,cartonAliases)!}).where(eq(cartonOperations.id,op.id)));
      for(const log of await db.select().from(auditLogs).where(inArray(auditLogs.entityType,['箱件收货','箱件原操作'])))queries.push(db.update(auditLogs).set({beforeSnapshot:remapCartonRowSnapshot(log.beforeSnapshot,cartonAliases),afterSnapshot:remapCartonRowSnapshot(log.afterSnapshot,cartonAliases)}).where(eq(auditLogs.id,log.id)));
    }
    queries.push(
      db.insert(settings)
        .values({ key: ZONES_SETTINGS_KEY, value: savedZoneValue, updatedAt })
        .onConflictDoUpdate({ target: settings.key, set: { value: savedZoneValue, updatedAt } }),
      db.insert(settings)
        .values({ key: WAREHOUSE_CANVAS_SETTINGS_KEY, value: canvasValue, updatedAt })
        .onConflictDoUpdate({ target: settings.key, set: { value: canvasValue, updatedAt } }),
    );
    await db.batch(batchTuple(queries));

    const canvasChanged = previousCanvas.width !== canvasResult.size.width
      || previousCanvas.height !== canvasResult.size.height;
    const renameSummary = renameEntries.length
      ? `，改名 ${renameEntries.map(([from, to]) => `${from}→${to}`).join("、")}`
      : "";
    const canvasSummary = canvasChanged
      ? `，白色区域 ${canvasResult.size.width}×${canvasResult.size.height}px`
      : "";
    await recordAudit(
      auth.user!,
      "保存地图",
      "仓库布局",
      "warehouse",
      `保存 ${mergedZones.length} 个区域${renameSummary}${canvasSummary}`,
    );
    return Response.json({ zones: mergedZones, canvas: canvasResult.size, updatedAt, revision: await locationMapRevision(zoneValue, canvasValue) });
  } catch (error) { if (isLocationRenameConflict(error)) return Response.json({ error: "库位名称已更新或库存刚有变化，请刷新重试" }, { status: 409 });
    return Response.json(
      { error: error instanceof Error ? error.message : "保存失败" },
      { status: 500 },
    );
  }
}

export async function PATCH(request: Request) {
  const auth = await requireWriteUser(request,"capacity.edit");
  if (auth.error) return auth.error;
  try {
    const body = await request.json() as {
      locationCode?: string;
      capacityLayers?: number;
      expectedRevision?: string;
      layerVolumeM3?: number|null;
      layerVolumes?: Array<{layer:number;volumeM3:number|null}>;
      expectedLayerRevision?: number;
    };
    if(!body||typeof body!=="object"||Array.isArray(body)||Object.keys(body).some(key=>!["locationCode","capacityLayers","expectedRevision","layerVolumeM3","layerVolumes","expectedLayerRevision"].includes(key)))return Response.json({error:"库位容量提交格式不正确"},{status:400});
    let locationCode = typeof body.locationCode==="string"?body.locationCode.trim():"";
    const capacityLayers = Number(body.capacityLayers);
    if (!Number.isSafeInteger(capacityLayers) || capacityLayers < 0) return Response.json({error:"最大层数须为大于或等于0的整数"},{status:400});
    if (!locationCode) return Response.json({ error: "缺少库位编号" }, { status: 400 });

    const db = getDb();
    const storedRows = await db
      .select()
      .from(settings)
      .where(inArray(settings.key, [ZONES_SETTINGS_KEY, WAREHOUSE_CANVAS_SETTINGS_KEY, LOCATION_ALIASES_KEY, LAYER_PRICING_KEY]));
    const aliases=parseLocationAliases(storedRows.find(row => row.key === LOCATION_ALIASES_KEY)?.value);
    locationCode = resolveLocationAlias(locationCode, aliases);
    const row = storedRows.find(candidate => candidate.key === ZONES_SETTINGS_KEY);
    if (!row) return Response.json({ error: "仓库地图尚未建立" }, { status: 404 });
    const canvasRow = storedRows.find(candidate => candidate.key === WAREHOUSE_CANVAS_SETTINGS_KEY);
    if(body.expectedRevision!==await locationMapRevision(row.value,canvasRow?.value))return Response.json({error:"地图或容量已更新，请刷新后重试"},{status:409});
    const canvas = canvasFromSetting(canvasRow?.value);
    const zones = mergeRequiredWarehouseZonesForCanvas(
      JSON.parse(row.value) as WarehouseZoneRecord[],
      canvas,
    );
    const zone = zones.find(candidate => candidate.codes?.some(code=>locationCodeKey(code)===locationCodeKey(locationCode)));
    if (!zone) return Response.json({ error: "没有找到该库位" }, { status: 404 });
    locationCode=zone.codes.find(code=>locationCodeKey(code)===locationCodeKey(locationCode))!;
    const config=locationLayerConfig(storedRows.find(row=>row.key===LAYER_PRICING_KEY)?.value);
    const previousLayerVolume=locationLayerVolume(config,zones,aliases);
    const hasVolume=Object.hasOwn(body,"layerVolumeM3");
    const hasLayers=Object.hasOwn(body,"layerVolumes");
    if(hasLayers&&hasVolume)throw new GoodsFlowError('默认体积和单层体积请分别提交',400);
    const nextConfig=hasVolume?changeLocationLayerVolume(config,locationCode,body.layerVolumeM3,body.expectedLayerRevision,aliases):hasLayers?changeLocationLayerVolumes(config,locationCode,body.layerVolumes,body.expectedLayerRevision,aliases):config;
    const layerVolume=locationLayerVolume(nextConfig,zones,aliases);
    const previousCapacity=layerCapacity(zone.layout?.[locationCode],locationCode);
    zone.layout = zone.layout || {};
    zone.layout[locationCode] = {
      ...(zone.layout[locationCode] || {}),
      capacityLayers,
    };
    const value = JSON.stringify(zones);
    const updatedAt = new Date().toISOString();
    const physicalSnapshot=(capacity:number,volume:typeof layerVolume)=>({schema:"location-capacity-v1",locationCode,capacityLayers:capacity,layerVolumeM3:volume.defaults[locationCode]??null,layerRevision:volume.revision,layerVolumes:volume.locations[locationCode]?.overrides});
    await saveLocationCapacity(db.$client,auth.user!,{
      expected:[ZONES_SETTINGS_KEY,WAREHOUSE_CANVAS_SETTINGS_KEY,LOCATION_ALIASES_KEY,LAYER_PRICING_KEY].map(key=>({key,row:storedRows.find(row=>row.key===key)??null})),
      zoneValue:value,...(nextConfig!==config?{layerValue:JSON.stringify(nextConfig)}:{}),updatedAt,locationCode,
      summary:`最大层数 ${capacityLayers || "不限"}${hasLayers?`，修改 ${body.layerVolumes!.length} 层托盘体积`:""}${hasVolume?`，每层默认体积 ${body.layerVolumeM3===null?"恢复默认":`${body.layerVolumeM3} m³`}`:""}`,
      before:physicalSnapshot(previousCapacity,previousLayerVolume),after:physicalSnapshot(capacityLayers,layerVolume),
    });
    return Response.json({
      zones,
      canvas,
      updatedAt,
      revision: await locationMapRevision(value, canvasRow?.value),
      layerVolume,
    });
  } catch (error) {
    if(isLocationRenameConflict(error)||/CHECK constraint failed:.*goods|CHECK constraint failed: valid/i.test(String(error)))return Response.json({error:"地图、容量或托层配置刚有变化，本次未保存；请刷新后重试"},{status:409});
    return Response.json(
      { error: error instanceof Error ? error.message : "容量保存失败" },
      { status: error instanceof GoodsFlowError ? error.status : error instanceof SyntaxError?400:500 },
    );
  }
}
