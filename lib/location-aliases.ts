import { locationCodeKey } from "./location-code.ts";
import type { WarehouseZoneRecord } from "./warehouse-layout.ts";

export const LOCATION_ALIASES_KEY = "warehouse_location_aliases";
export type LocationAliases = Record<string, string>;
export function isLocationRenameConflict(error: unknown) {
  let current = error;
  for (let depth = 0; current && depth < 6; depth++) {
    if (/库位名称已更新|NOT NULL constraint failed: settings\.value/.test(String(current))) return true;
    current = typeof current === "object" && current !== null && "cause" in current ? current.cause : null;
  }
  return false;
}
export function parseLocationAliases(value?: string | null): LocationAliases {
  if (!value) return {};
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("库位更名记录格式不正确");
  const aliases = Object.fromEntries(Object.entries(parsed).map(([from, to]) => {
    if (!from.trim() || typeof to !== "string" || !to.trim()) throw new Error("库位更名记录格式不正确");
    return [from, to];
  }));
  for (const from of Object.keys(aliases)) resolveLocationAlias(from, aliases);
  return aliases;
}
export function resolveLocationAlias(value: string, aliases: LocationAliases) {
  const lookup = new Map(Object.entries(aliases).map(([from, to]) => [locationCodeKey(from), to]));
  let code = value.trim(); const seen = new Set<string>();
  while (lookup.has(locationCodeKey(code))) {
    const key = locationCodeKey(code); if (seen.has(key)) throw new Error("库位更名记录循环，请联系管理员");
    seen.add(key); code = lookup.get(key)!;
  }
  return code;
}
export function composeLocationAliases(previous: LocationAliases, renames: LocationAliases, activeCodes: readonly string[]) {
  const result = Object.fromEntries([...Object.entries(previous).map(([from, to]) => [from, renames[to] ?? to]), ...Object.entries(renames)]);
  const active = new Set(activeCodes.map(locationCodeKey));
  for (const from of Object.keys(result)) if (active.has(locationCodeKey(from)) || result[from] === from) delete result[from];
  return Object.fromEntries(Object.keys(result).map(from => [from, resolveLocationAlias(from, result)]));
}
export function remapSnapshotLocations(raw: string | null | undefined, aliases: LocationAliases) {
  if (!raw) return raw;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return raw; }
  {
    const remap = (row: unknown): unknown => {
      if(Array.isArray(row))return row.map(remap);
      if (!row || typeof row !== "object") return row;
      const next = { ...row } as Record<string, unknown>;
      for (const key of ["locationCode", "sourceLocation", "targetLocation"]) if (typeof next[key] === "string") next[key] = resolveLocationAlias(next[key] as string, aliases);
      for(const [key,value] of Object.entries(next))if(value&&typeof value==="object")next[key]=remap(value);
      return next;
    };
    return JSON.stringify(remap(value));
  }
}
export function remapWarehouseZones(zones: readonly WarehouseZoneRecord[], renames: LocationAliases) {
  const output = zones.map(zone => ({ ...zone, ...(/^NEW_[ABCD]$/.test(zone.id) || zone.codes.some(code => renames[code]) ? { locationCodesVersion: 1 } : {}),
    codes: zone.codes.map(code => renames[code] ?? code),
    layout: zone.layout ? Object.fromEntries(Object.entries(zone.layout).map(([code, box]) => [renames[code] ?? code, { ...box }])) : zone.layout,
  }));
  const keys = output.flatMap(zone => zone.codes.map(locationCodeKey));
  if (new Set(keys).size !== keys.length) throw new Error("改名后库位编号重复，请先处理同名库位");
  return output;
}
function reconcileConfirmedB3(zones: readonly WarehouseZoneRecord[]) {
  const sourceZone = zones.find(zone => zone.id === "NEW_B" && zone.codes.includes("新B3"));
  const canonicalZone = zones.find(zone => zone.codes.includes("B3"));
  if (!sourceZone || !canonicalZone) return zones;
  const savedBox = canonicalZone.layout?.B3;
  return zones.map(zone => {
    if (zone !== sourceZone && zone !== canonicalZone) return zone;
    const layout = { ...zone.layout }; delete layout.B3;
    if (zone === sourceZone && savedBox) layout["新B3"] = { ...savedBox };
    return { ...zone, codes: zone.codes.filter(code => code !== "B3"), layout };
  });
}
export function planNewZonePrefixRemoval(zones: readonly WarehouseZoneRecord[], occupiedCodes: readonly string[], confirmedB3 = false) {
  const renames: LocationAliases = {};
  for (const zone of zones) if (/^NEW_[ABCD]$/.test(zone.id)) for (const code of zone.codes) if (/^新[ABCD]\d+$/.test(code)) renames[code] = code.slice(1);
  const sourceKeys = new Set(Object.keys(renames).map(locationCodeKey));
  const otherKeys = new Set([...zones.flatMap(zone => zone.codes), ...occupiedCodes].filter(code => !sourceKeys.has(locationCodeKey(code))).map(locationCodeKey));
  if (confirmedB3 && occupiedCodes.some(code => locationCodeKey(code) === "新B3")) throw new Error("新B3已有货物，请先核对");
  const conflicts = Object.values(renames).filter(code => otherKeys.has(locationCodeKey(code)) && !(confirmedB3 && code === "B3"));
  if (conflicts.length) throw new Error(`以下库位已存在，不能合并：${[...new Set(conflicts)].join("、")}`);
  const nextZones = remapWarehouseZones(confirmedB3 ? reconcileConfirmedB3(zones) : zones, renames).map(zone => /^NEW_[ABCD]$/.test(zone.id) ? {
    ...zone, title: zone.title.replace(/^新([ABCD])区/, "$1区").replace(/ · 新库位$/, " · 库位"),
    features: zone.features?.map(feature => ({ ...feature, label: feature.label.replace(/^新([ABCD])区$/, "$1区") })),
  } : zone);
  return { zones: nextZones, renames };
}
export function upgradeBackupLocationNames<T extends { stocks: Record<string, unknown>[]; settings: Record<string, unknown>[]; storageFeeSettlements?: Record<string, unknown>[];goodsFlowState?:Record<string,unknown>[];goodsOperations?:Record<string,unknown>[] }>(data: T, currentAliases: LocationAliases, options: { inPlace?: boolean } = {}): T {
  const backupAliases = parseLocationAliases(String(data.settings.find(row => row.key === LOCATION_ALIASES_KEY)?.value ?? "{}"));
  // Current names win when a bin has been renamed back since this backup.
  // Keeping the old reverse edge would create B1 -> 新B1 -> B1.
  const currentNames = new Set(Object.values(currentAliases).map(code => locationCodeKey(resolveLocationAlias(code, currentAliases))));
  const aliases = { ...Object.fromEntries(Object.entries(backupAliases).filter(([from]) => !currentNames.has(locationCodeKey(from))).map(([from, to]) => [from, resolveLocationAlias(to, currentAliases)])), ...currentAliases };
  if (!Object.keys(aliases).length) return data;
  const zoneRow = data.settings.find(row => row.key === "warehouse_zones");
  let zones: WarehouseZoneRecord[] | undefined = zoneRow ? JSON.parse(String(zoneRow.value)) : undefined;
  const confirmedB3 = resolveLocationAlias("新B3", currentAliases) === resolveLocationAlias("B3", currentAliases);
  const emptyB3Duplicate = confirmedB3 && !data.stocks.some(row => locationCodeKey(String(row.locationCode ?? "")) === "新B3");
  if (zones && emptyB3Duplicate) zones = [...reconcileConfirmedB3(zones)];
  const renames = Object.fromEntries((zones?.flatMap(zone => zone.codes) ?? []).map(code => [code, resolveLocationAlias(code, aliases)]).filter(([from, to]) => from !== to));
  const sources = [...new Set([...(zones?.flatMap(zone => zone.codes) ?? []), ...data.stocks.map(row => String(row.locationCode ?? "")), ...(data.storageFeeSettlements ?? []).map(row => String(row.locationCode ?? ""))].filter(Boolean))];
  const destinations = new Map<string, string>();
  for (const from of sources) {
    const target = locationCodeKey(resolveLocationAlias(from, aliases)), previous = destinations.get(target);
    if (previous && locationCodeKey(previous) !== locationCodeKey(from) && !(emptyB3Duplicate && ["新B3", "B3"].includes(previous) && ["新B3", "B3"].includes(from))) throw new Error(`备份库位冲突：${previous} 与 ${from}，请先核对`);
    destinations.set(target, from);
  }
  const nextZones = zones ? remapWarehouseZones(zones, renames) : undefined;
  const stamp = new Date().toISOString();
  const nextSettings = data.settings.filter(row => row.key !== LOCATION_ALIASES_KEY).map(row => row.key === "warehouse_zones" && nextZones ? { ...row, value: JSON.stringify(nextZones) } : row);
  nextSettings.push({ key: LOCATION_ALIASES_KEY, value: JSON.stringify(aliases), updatedAt: stamp });
  const mapRow = (row: Record<string, unknown>) => typeof row.locationCode === "string" ? { ...row, locationCode: resolveLocationAlias(row.locationCode, aliases) } : row;
  // Restore owns its parsed backup, so release each old history row as it is upgraded.
  const project = (rows: Record<string, unknown>[], map: (row: Record<string, unknown>) => Record<string, unknown>) => {
    if (!options.inPlace) return rows.map(map);
    for (let index=0;index<rows.length;index++) rows[index]=map(rows[index]);
    return rows;
  };
  const flow=data.goodsFlowState&&project(data.goodsFlowState,row=>({...row,value:remapSnapshotLocations(String(row.value),aliases)}));
  const operations=data.goodsOperations&&project(data.goodsOperations,row=>({...row,...Object.fromEntries(["beforeCategory","afterCategory","beforeRows","afterRows","result"].map(key=>[key,remapSnapshotLocations(row[key] as string|null|undefined,aliases)]))}));
  const upgraded = { stocks: project(data.stocks,mapRow), settings: nextSettings, ...(data.storageFeeSettlements ? { storageFeeSettlements: project(data.storageFeeSettlements,mapRow) } : {}),...(flow?{goodsFlowState:flow}:{}),...(operations?{goodsOperations:operations}:{}) };
  return options.inPlace ? Object.assign(data,upgraded) : { ...data,...upgraded };
}
