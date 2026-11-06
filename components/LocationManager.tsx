"use client";
import { useEffect, useRef, useState } from "react";
import { createLocationEditor, planLocationEdits, type LocationEditorZone } from "../lib/location-editor";
import type { WarehouseZoneRecord } from "../lib/warehouse-layout";

export function LocationManager({ zones, onClose, onSave }: {
  zones: WarehouseZoneRecord[];
  onClose: () => void;
  onSave: (zones: WarehouseZoneRecord[], renames: Record<string, string>) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [draft, setDraft] = useState(() => createLocationEditor(zones));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);
  const sequence = useRef(0);
  const inputs = useRef(new Map<string, HTMLInputElement>());
  const focusNext = useRef<string | null>(null);
  useEffect(() => {
    if (!focusNext.current) return;
    const input = inputs.current.get(focusNext.current);
    input?.focus(); input?.scrollIntoView({ block: "nearest" });
    focusNext.current = null;
  }, [draft]);
  const nextId = () => `editor-${Date.now()}-${++sequence.current}`;
  const updateZone = (id: string, update: (zone: LocationEditorZone) => LocationEditorZone) => {
    setDraft(current => current.map(zone => zone.id === id ? update(zone) : zone));
    setError("");
  };
  const save = async () => {
    if (inFlight.current) return;
    inFlight.current = true; setSaving(true); setError("");
    try {
      const plan = planLocationEdits(draft);
      const result = await onSave(plan.zones, plan.renames);
      if (!result.ok) setError(result.error || "保存失败，请重试；填写内容已保留");
    } catch (error) { setError(error instanceof Error ? error.message : "保存失败，请重试；填写内容已保留"); }
    finally { inFlight.current = false; setSaving(false); }
  };
  return <section className="config-modal" role="dialog" aria-modal="true" aria-labelledby="location-manager-title" aria-busy={saving}>
    <div className="config-head"><div><p>WAREHOUSE MAP</p><h2 id="location-manager-title">区域与库位管理</h2><span>修改编号即为改名，原有货物和地图位置会保留。</span></div><button aria-label="关闭库位管理" disabled={saving} onClick={onClose}>×</button></div>
    <div className="zone-editor-list">{draft.map((zone, index) => <article className="zone-editor" key={zone.id}>
      <div className="zone-editor-head"><b>区域 {index + 1}</b><button disabled={saving} onClick={() => { setDraft(current => current.filter(item => item.id !== zone.id)); setError(""); }}>删除区域</button></div>
      <label>区域名称<input disabled={saving} value={zone.title} onChange={event => updateZone(zone.id, item => ({ ...item, title: event.target.value }))}/></label>
      <div className="location-editor-caption">库位编号</div>
      <div className="location-editor-rows">{zone.rows.map((row, rowIndex) => <div className="location-editor-row" key={row.id}>
        <input ref={input => { if (input) inputs.current.set(row.id, input); else inputs.current.delete(row.id); }} aria-label={`${zone.title} 库位 ${rowIndex + 1}`} disabled={saving} value={row.code} placeholder="填写库位编号" onChange={event => updateZone(zone.id, item => ({ ...item, rows: item.rows.map(candidate => candidate.id === row.id ? { ...candidate, code: event.target.value } : candidate) }))}/>
        <button type="button" disabled={saving} aria-label={`删除库位 ${row.code || rowIndex + 1}`} onClick={() => updateZone(zone.id, item => ({ ...item, rows: item.rows.filter(candidate => candidate.id !== row.id) }))}>删除</button>
      </div>)}</div>
      <button className="add-location" disabled={saving} onClick={() => { const id = nextId(); focusNext.current = id; updateZone(zone.id, item => ({ ...item, rows: [...item.rows, { id, code: "" }] })); }}>＋ 新增库位</button>
    </article>)}</div>
    {error && <div className="location-editor-error" role="alert">{error}</div>}
    <div className="config-actions"><button className="add-zone" disabled={saving} onClick={() => { const id = nextId(), rowId = nextId(); focusNext.current = rowId; setDraft(current => [...current, { id, title: "新区域", codes: [], layout: {}, rows: [{ id: rowId, code: "" }] }]); setError(""); }}>＋ 新增区域</button><div><button className="cancel" disabled={saving} onClick={onClose}>取消</button><button className="save-layout" disabled={saving} onClick={save}>{saving ? "保存中…" : "保存库位"}</button></div></div>
  </section>;
}
