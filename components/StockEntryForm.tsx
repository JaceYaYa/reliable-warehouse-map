"use client";
import {warehouseCalendarDays,warehouseTodayDate} from '../lib/warehouse-time';
import { useEffect,useState,type ReactNode,type WheelEvent } from "react";
import { type StockPricingDraft } from "./pricing";
import "./stock-entry-form.css";
import type { MessageReferenceStock } from "../lib/inbound-message";
import { stockProductDetails } from "../lib/stock-product";
import { ProductAnnotations } from "./ProductAnnotations";
import { CustomerNameInput } from "./CustomerNameInput";

export type StockEntryValue = MessageReferenceStock & {
  inboundOrder: string; note: string; palletManual?:boolean; palletAutomatic?:boolean; palletLabel?: string; catalogItemId?: number | string | null;
};
type Props = {
  value: StockEntryValue; onChange: (patch: Partial<StockEntryValue>) => void;
  customerNames?:readonly string[];
  sourceSelection?: StockPricingDraft["sourceType"]; storedSource?: StockPricingDraft["sourceType"];
  onSourceSelectionChange?: (source: StockPricingDraft["sourceType"]) => void;
  catalogPickerKey: string | number; defaultRate: number; defaultFreeDays: number;
  onScan: () => void; onSave: () => void; onClear?: () => void; onOutbound?: () => void; onMove?: () => void;
  fieldsDisabled?: boolean; saving?: boolean; disabled?: boolean; saveDisabled?: boolean; moveBusy?: boolean; beforeActions?: ReactNode;
};
const sourceLabel = (source: StockPricingDraft["sourceType"]) => source === "return" ? "退货" : source === "domestic" ? "国内" : "无";
const suppressNumberWheel = (event: WheelEvent<HTMLInputElement>) => { if (document.activeElement === event.currentTarget) event.currentTarget.blur(); };

export function StockEntryForm({ value: editing, onChange: changeEditing, customerNames=[], sourceSelection, storedSource, onSourceSelectionChange, catalogPickerKey, defaultRate, defaultFreeDays, onScan, onSave, onClear, onOutbound, onMove, fieldsDisabled = false, saving = false, disabled = false, saveDisabled = false, moveBusy = false, beforeActions }: Props) {
  const details=stockProductDetails(editing);
  const changeProduct=(patch:Partial<StockEntryValue>)=>changeEditing({product:details.name,productPrefix:details.prefix,productCondition:details.condition,...patch});
  const [now,setNow]=useState(()=>Date.now());
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),60000);return()=>clearInterval(timer)},[]);
  const days = warehouseCalendarDays(editing.inboundDate,warehouseTodayDate(new Date(now)));
  return <div className="stock-entry-form"><fieldset className="stock-entry-fields" disabled={disabled || saving || fieldsDisabled}>
    <div className="storage-duration"><span>入库时长</span><strong>{days} 天</strong><small>从 {editing.inboundDate || "未填写日期"} 起自动计算 · 状态：{sourceLabel(storedSource ?? editing.inboundSource)}</small></div>
    <label>来源<select value={sourceSelection ?? editing.inboundSource} onChange={e=>{const source=e.target.value as StockPricingDraft["sourceType"];onSourceSelectionChange?.(source);changeEditing({inboundSource:source});}}><option value="return">退货</option><option value="domestic">国内</option><option value="unspecified">无</option></select></label>
    <div className="form-grid"><label>入库日期<input type="date" value={editing.inboundDate} onChange={e => changeEditing({ inboundDate: e.target.value })}/></label><label>客户名称<CustomerNameInput value={editing.customerName} onChange={name=>changeEditing({customerName:name})} customerNames={customerNames} disabled={disabled||saving||fieldsDisabled}/></label><label className="wide">产品<input value={details.name} onChange={e => changeProduct({ product: e.target.value })}/></label><ProductAnnotations prefix={details.prefix} condition={details.condition} onChange={changeProduct}/><label className="wide">SKU<input value={editing.sku ?? ""} onChange={e => changeEditing({ sku: e.target.value })}/></label><label className="wide">产品条形码<div className="barcode-entry"><input value={editing.barcode} onChange={e => changeEditing({ barcode: e.target.value })} placeholder="扫码枪可直接扫描"/><button type="button" onClick={onScan}>▣ 扫码</button></div></label><label className="wide">入库单号<input value={editing.inboundOrder} onChange={e => changeEditing({ inboundOrder: e.target.value })}/></label><label>总数量<input className="warehouse-number-input" type="number" value={editing.totalQuantity} onWheel={suppressNumberWheel} onChange={e => changeEditing({ totalQuantity: +e.target.value })}/></label><label>总箱数<input className="warehouse-number-input" type="number" value={editing.totalBoxes} onWheel={suppressNumberWheel} onChange={e => changeEditing({ totalBoxes: +e.target.value })}/></label></div><div className="stock-layer-field"><label>托盘数<input type="text" inputMode="decimal" value={editing.palletLabel??String(editing.palletCount??1)} onChange={e=>changeEditing({palletLabel:e.target.value,palletManual:true})} placeholder="默认1"/></label><label>存放层数<input className="warehouse-number-input" type="number" min="1" step="1" value={editing.layerCount} onWheel={suppressNumberWheel} onChange={e => changeEditing({ layerCount: +e.target.value })}/></label></div><label className="note">备注<textarea aria-label="备注" value={editing.note} onChange={e => changeEditing({ note: e.target.value })}/></label>
    </fieldset>{beforeActions}
    <div className="actions stock-actions"><button type="button" className="clear" onClick={onClear} disabled={disabled || saving || moveBusy || !editing.id || !onClear}>全部出库</button><button type="button" className="outbound" onClick={onOutbound} disabled={disabled || !editing.id || saving || moveBusy || !onOutbound}>出库</button><button type="button" className="move-stock" onClick={onMove} disabled={disabled || !editing.id || saving || moveBusy || !onMove}>移动货物</button><button type="button" className="save" onClick={onSave} disabled={disabled || saving || saveDisabled}>{saving ? "保存中…" : editing.id ? "保存修改" : "确认入库"}</button></div>
  </div>;
}
