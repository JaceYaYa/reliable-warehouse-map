import { locationCodeKey } from "./location-code.ts";
import type { WarehouseZoneRecord } from "./warehouse-layout.ts";

export type LocationEditorRow = { id: string; originalCode?: string; code: string };
export type LocationEditorZone = WarehouseZoneRecord & { rows: LocationEditorRow[] };
export function createLocationEditor(zones: readonly WarehouseZoneRecord[]): LocationEditorZone[] {
  return zones.map(zone => ({ ...zone, rows: zone.codes.map(code => ({ id: `${zone.id}:${code}`, originalCode: code, code })) }));
}

export function planLocationEdits(draft: readonly LocationEditorZone[]) {
  if (!draft.length) throw new Error("至少保留一个区域");
  const seen = new Set<string>(), renames: Record<string, string> = {};
  const zones = draft.map(zone => {
    if (!zone.rows.length) throw new Error(`${zone.title || "新区域"}：请添加库位，或删除这个区域`);
    const codes = zone.rows.map(row => {
      const code = row.code.trim();
      if (!code) throw new Error(`${zone.title || "新区域"}：库位编号不能为空`);
      const key = locationCodeKey(code);
      if (seen.has(key)) throw new Error(`库位编号重复：${code}`);
      seen.add(key);
      if (row.originalCode && row.originalCode !== code) renames[row.originalCode] = code;
      return code;
    });
    const { rows, ...saved } = zone;
    const layout = Object.fromEntries(rows.flatMap((row, index) => {
      const box = row.originalCode ? zone.layout?.[row.originalCode] : undefined;
      return box ? [[codes[index], { ...box }]] : [];
    }));
    return { ...saved, title: zone.title.trim() || "未命名区域", codes, layout, locationCodesVersion: 1 };
  });
  return { zones, renames };
}
