"use client";
import {warehouseTodayDate} from '../lib/warehouse-time';
import { useEffect, useRef, useState } from "react";
import { applyMessageReference, editMessageInboundItem, messageDuplicateIds, messageReferenceId, parseInboundMessage, type MessageInboundDraft, type MessageInboundItem, type MessageReferenceStock } from "../lib/inbound-message";
import { StockEntryForm } from "./StockEntryForm";

type Props = {
  open: boolean; onClose: () => void;
  onSave: (draft: MessageInboundDraft) => Promise<{ ok: boolean; error?: string }>;
  onScan: (receive: (code: string) => void) => void;
  locations: string[]; stocks: MessageReferenceStock[]; saving: boolean; scanning: boolean;
  defaultRate: number; defaultFreeDays: number;
};
const today = () => warehouseTodayDate();

export function MessageInboundDialog({ open, onClose, onSave, onScan, locations, stocks, saving, scanning, defaultRate, defaultFreeDays }: Props) {
  const [text, setText] = useState(""), [parsedText, setParsedText] = useState("");
  const [date, setDate] = useState(today), [items, setItems] = useState<MessageInboundItem[]>([]);
  const [errors, setErrors] = useState<string[]>([]), [activeKey, setActiveKey] = useState("");
  const [saved, setSaved] = useState<string[]>([]), [duplicatesAllowed, setDuplicatesAllowed] = useState<string[]>([]);
  const [feedback, setFeedback] = useState<Record<string, string>>({});
  const submitting = useRef(false), edited = useRef(new Set<string>()), completed = useRef(new Set<string>());
  const busy = saving || scanning;
  useEffect(() => {
    if (!open || busy) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented && !(event.target instanceof Element && event.target.closest('[role="combobox"][aria-expanded="true"]'))) onClose(); };
    document.addEventListener("keydown", onKey); return () => document.removeEventListener("keydown", onKey);
  }, [open, busy, onClose]);
  if (!open) return null;
  const update = (key: string, change: (item: MessageInboundItem) => MessageInboundItem) => {
    if (submitting.current || completed.current.has(key) || saved.includes(key)) return;
    edited.current.add(key); setDuplicatesAllowed(keys => keys.filter(value => value !== key));
    setFeedback(values => ({ ...values, [key]: "" }));
    setItems(rows => rows.map(row => row.key === key ? change(row) : row));
  };
  const parse = () => {
    if (busy || submitting.current) return;
    if (items.some(item => edited.current.has(item.key) && !saved.includes(item.key)) && !window.confirm("重新识别会替换当前表单修改，是否继续？")) return;
    const result = parseInboundMessage(text, { locations, stocks, inboundDate: date, defaultRate, defaultFreeDays });
    setItems(result.items); setErrors(result.errors); setActiveKey(result.items[0]?.key || ""); setParsedText(text);
    setDuplicatesAllowed([]); setSaved([]); setFeedback({}); edited.current.clear(); completed.current.clear();
  };
  const item = items.find(row => row.key === activeKey) ?? items[0];
  const done = !!item && saved.includes(item.key), changedMessage = !!items.length && text !== parsedText;
  const duplicate = !!item && !done && messageDuplicateIds(item.draft, stocks, item.receiptIdentifier).length > 0;
  const allowed = !!item && duplicatesAllowed.includes(item.key);
  const needsReference = !!item && item.references.length > 0 && !item.referenceId;
  const validLocation = !!item && locations.includes(item.draft.locationCode);
  const submit = async () => {
    if (!item || done || completed.current.has(item.key) || busy || submitting.current || changedMessage || !validLocation || needsReference) return;
    if (messageDuplicateIds(item.draft, stocks, item.receiptIdentifier).length && !duplicatesAllowed.includes(item.key)) return;
    submitting.current = true; const key = item.key;
    try {
      const result = await onSave({ ...item.draft });
      if (result.ok) { completed.current.add(key); setSaved(keys => [...keys, key]); setFeedback(values => ({ ...values, [key]: "入库成功" })); edited.current.delete(key); }
      else setFeedback(values => ({ ...values, [key]: result.error || "保存失败，填写仍保留" }));
    } catch { setFeedback(values => ({ ...values, [key]: "保存失败，填写仍保留" })); }
    finally { submitting.current = false; }
  };
  const remaining = items.filter(row => !saved.includes(row.key)).length;
  return <div className="modal-backdrop message-inbound-backdrop"><section className="message-inbound-modal" role="dialog" aria-modal="true" aria-labelledby="message-inbound-title">
    <header className="message-inbound-header"><h2 id="message-inbound-title">粘贴消息入库</h2><button className="message-control" type="button" disabled={busy} onClick={onClose}>关闭</button></header>
    <details className="message-inbound-input" open={!items.length}><summary>清点消息{items.length ? " · 查看或重新识别" : ""}</summary>
      <label>消息文字<textarea autoFocus disabled={busy} maxLength={20000} value={text} onChange={event => setText(event.target.value)} placeholder={"粘贴群里的清点文字，例如：\nFBA18XB2J3B3U。DQ入库8箱，放在D20第一层"}/></label>
      <div className="message-inbound-controls"><label>默认入库日期<input disabled={busy} type="date" max={today()} value={date} onChange={event => setDate(event.target.value)}/></label><button className="message-control message-primary" type="button" onClick={parse} disabled={busy || !text.trim() || !date}>{items.length ? "重新识别" : "识别并填写"}</button></div>
    </details>
    {errors.map(error => <p className="message-inbound-warning" role="alert" key={error}>{error}</p>)}
    {items.length > 0 && <div className="message-inbound-results"><p className="message-inbound-count">共 {items.length} 条 · {remaining ? `剩余 ${remaining} 条未入库` : "全部已入库"}</p>
      <nav className="message-inbound-tabs" aria-label="切换入库货物">{items.map((row, index) => <button type="button" className={row.key === item?.key ? "active" : ""} disabled={busy} onClick={() => setActiveKey(row.key)} key={row.key}><b>{index + 1}. {row.draft.product || "未命名货物"}</b><small>{row.draft.locationCode || "选择库位"} · {saved.includes(row.key) ? "已入库" : `${row.draft.totalBoxes}箱`}</small></button>)}</nav>
      {item && <section className="message-inbound-entry" key={item.key}>
        <label className="message-location">当前库位<select disabled={busy || done} value={item.draft.locationCode} onChange={event => update(item.key, row => editMessageInboundItem(row, { locationCode: event.target.value }))}><option value="">选择库位</option>{locations.map(code => <option key={code} value={code}>{code}</option>)}</select></label>
        {item.references.length > 0 && <label className="message-reference">{item.receiptIdentifier ? "已有同批资料" : "已有同款资料"}<select disabled={busy || done} value={item.referenceId} onChange={event => update(item.key, row => event.target.value === "manual" ? { ...row, referenceId: "manual" } : applyMessageReference(row, row.references.find(stock => messageReferenceId(stock) === event.target.value)))}><option value="">选择货物 / 客户</option><option value="manual">自行填写</option>{item.references.map(reference => <option key={messageReferenceId(reference)} value={messageReferenceId(reference)}>{reference.product} · {reference.customerName || "未填客户"} · {reference.locationCode}</option>)}</select></label>}
        {item.quantityUnknown && !item.draft.totalQuantity && <p className="message-inbound-hint">件数未清点，可按箱入库，总数量记 0。</p>}
        {item.rawLocation && item.draft.locationCode && item.rawLocation !== item.draft.locationCode && <p className="message-inbound-hint">{item.rawLocation} → {item.draft.locationCode}</p>}
        <StockEntryForm value={item.draft} customerNames={[...stocks.map(s=>s.customerName),...items.map(row=>row.draft.customerName)]} catalogPickerKey={item.key} defaultRate={defaultRate} defaultFreeDays={defaultFreeDays}
          onChange={patch => update(item.key, row => editMessageInboundItem(row, patch))}
          onScan={() => onScan(code => update(item.key, row => editMessageInboundItem(row, { barcode: code })))}
          saving={saving} disabled={done || scanning} saveDisabled={changedMessage || !validLocation || needsReference || (duplicate && !allowed)} onSave={() => void submit()}
          beforeActions={<>
            {changedMessage && <p className="message-inbound-warning">消息已修改，请重新识别。</p>}
            {item.warnings.filter(warning => !/托盘|0托/.test(warning) && (!item.draft.locationCode || !/库位/.test(warning))).map(warning => <p className="message-inbound-warning" key={warning}>{warning}</p>)}
            {duplicate && <label className="message-inbound-duplicate"><input type="checkbox" checked={allowed} onChange={event => setDuplicatesAllowed(keys => event.target.checked ? [...keys, item.key] : keys.filter(key => key !== item.key))}/>{item.receiptIdentifier ? "已有相同批次编号，确认本次是新增到货，未重复登记" : "已有相同货物、数量和库位，确认这是另一批新入库"}</label>}
          </>}/>
        {feedback[item.key] && <p className={`stock-save-feedback ${done ? "success" : "error"}`} role={done ? "status" : "alert"}>{feedback[item.key]}</p>}
        {done && remaining > 0 && <button className="message-control message-primary message-next" type="button" onClick={() => setActiveKey(items.find(row => !saved.includes(row.key))!.key)}>核对下一条</button>}
      </section>}
    </div>}
  </section></div>;
}
