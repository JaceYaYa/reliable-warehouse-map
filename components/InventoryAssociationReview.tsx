"use client";
import { useMemo, useState } from "react";
import { inventoryDifferences, inventoryIdentity, type AssociationState, type InventoryCandidate } from "../lib/inventory-associations";
import type { InventoryGroup, InventoryStock } from "../lib/inventory-groups";
import { InventoryRecordCard } from "./InventoryRecordCard";
import type { InventoryRecordSave } from "../lib/inventory-record-edit";
import styles from "./InventoryWorkspace.module.css";
import {commonMatchedProduct,matchedProductParts} from "../lib/product-match";
import {stockProductDetails} from "../lib/stock-product";
import {InventoryProductName} from "./InventoryProductName";

type Props<T extends InventoryStock> = {
  groups: InventoryGroup<T>[]; filtered: InventoryGroup<T>[]; candidates: InventoryCandidate<T>[];
  state: AssociationState; canEdit: boolean; canManageProduct?:boolean; canConvert?:boolean; ready: boolean; onState: (state: AssociationState) => void;
  onRefresh: () => Promise<void>; onOpenStock: (stock: T) => void; onSaveStock: InventoryRecordSave;
};
export function InventoryAssociationReview<T extends InventoryStock>({ groups, filtered, candidates, state, canEdit, canManageProduct=false, canConvert=false, ready, onState, onRefresh, onOpenStock, onSaveStock }: Props<T>) {
  const [keys, setKeys] = useState<string[]>([]), [product, setProduct] = useState(""), [message, setMessage] = useState(""), [busy, setBusy] = useState(false), [confirming, setConfirming] = useState(false), [limit, setLimit] = useState(20);
  const [prefixes,setPrefixes]=useState<Record<number,string>>({});
  const selected = useMemo(() => groups.filter(g => keys.includes(g.key)), [groups, keys]);
  const sameCustomer = selected.length > 0 && !!selected[0].customer && selected.every(g => g.customer === selected[0].customer);
  const obsolete = selected.length !== keys.length;
  const showSelection = () => requestAnimationFrame(() => document.querySelector<HTMLElement>("[data-association-selection]")?.scrollIntoView({ block: "start", behavior: "smooth" }));
  const changes = inventoryDifferences(selected);
  const choose=(next:string[])=>{const chosen=groups.filter(g=>next.includes(g.key));setKeys(next);setProduct(commonMatchedProduct(chosen.flatMap(g=>g.members.map(m=>m.name)))||chosen[0]?.product||"");setPrefixes({})};
  const parts=selected.flatMap(g=>g.members.map(m=>{const part=matchedProductParts({...m.stock,...m.productView,productCondition:stockProductDetails(m.stock).condition},product);return {stock:m.stock,...part,prefix:prefixes[m.stock.id!]??part.prefix}}));
  const select = (g: InventoryGroup<T>) => {
    setConfirming(false); setMessage("");
    if (keys.includes(g.key)) { choose(keys.filter(k => k !== g.key)); return; }
    if (!g.customer) { setMessage("请先在库位记录中补充客户名称，再关联"); return; }
    if (selected.length && selected[0].customer !== g.customer) { setMessage("只能勾选同一客户的货物；需要换客户时，请清空勾选"); return; }
    choose([...keys, g.key]);
  };
  const save = async () => {
    if (busy || !ready || !canEdit || obsolete || !sameCustomer || selected.length < 2 || !product.trim()) return;
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/inventory/associations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "link", revision: state.revision, product, groupKeys: keys,annotations:parts.map(p=>({id:p.stock.id,productPrefix:p.prefix})),
        members: selected.flatMap(g => g.members.map(m => ({ id: m.stock.id, identity: inventoryIdentity(m.stock), version: m.stock.version ?? 0 }))) }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "关联保存失败，请刷新后核对");
      onState(data.state); setKeys([]); setConfirming(false); setProduct(""); setMessage("已确认关联，可以在库存列表查看汇总。原库位、数量、日期和备注均已保留。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "关联保存失败，请稍后重试"); }
    finally { setBusy(false); }
  };
  const exclude = async (chosen: InventoryGroup<T>[]) => {
    if (busy || !ready || !canEdit || chosen.length !== 2) return;
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/inventory/associations", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"exclude",revision:state.revision,groupKeys:chosen.map(g=>g.key),members:chosen.flatMap(g=>g.members.map(m=>({id:m.stock.id,identity:inventoryIdentity(m.stock),version:m.stock.version??0})))})});
      const data=await response.json();if(!response.ok)throw new Error(data.error||"核对保存失败");onState(data.state);setKeys([]);setConfirming(false);setMessage("已标记不是同款，此对不再推荐。库存仍正常显示；选错可到“核对记录”撤回。");
    } catch(error) {setMessage(error instanceof Error?error.message:"核对保存失败，请重试")} finally {setBusy(false)}
  };
  const card = (g: InventoryGroup<T>, selectable = true) => <article className={styles.compareCard} key={g.key} data-compare-group={g.key}>
    <div className={styles.compareHeading}>{selectable && canEdit && <input type="checkbox" aria-label={`勾选货物 ${g.product} ${g.locations.join("、")}`} checked={keys.includes(g.key)} disabled={busy || !ready} onChange={() => select(g)} />}
      <div><strong><InventoryProductName group={g}/></strong><span>{g.customer || "客户未填写"}</span></div></div>
    <dl><div><dt>SKU</dt><dd>{g.sku || "未填写"}</dd></div><div><dt>产品条形码</dt><dd>{g.barcode || "未填写"}</dd></div><div><dt>库存</dt><dd>{g.quantity.toLocaleString("zh-CN")} 件 / {g.boxes.toLocaleString("zh-CN")} 箱</dd></div><div><dt>库位 / 记录</dt><dd>{g.locations.join("、")} · {g.members.length}条</dd></div></dl>
    <small>{g.reason}</small>
    <details className={styles.compareDetails}><summary>查看 {g.members.length} 条原始记录</summary>{g.members.map((m, i) => <InventoryRecordCard key={m.stock.id??i} stock={m.stock} productView={m.productView} canEdit={canEdit} canManageProduct={canManageProduct} canConvert={canConvert} onSave={onSaveStock} onOpenStock={onOpenStock}/>)}</details>
  </article>;
  return <section className={styles.reviewWorkspace} aria-label="疑似同款核对">
    <p>条形码可以不同，SKU 不同时请重点确认。请核对型号、颜色和规格后关联；未推荐的货物也可以搜索后手动勾选。</p>
    {!canEdit && <p className={styles.feedback}>当前账号可以查看，确认或撤销关联需要“库存校正”权限。</p>}
    <div className={styles.selectionBar}><strong>已选 {selected.length} 组{selected.length ? ` · ${selected[0].customer}` : ""}</strong><button type="button" disabled={busy || !keys.length} onClick={() => { setKeys([]); setConfirming(false); setMessage(""); }}>清空勾选</button>
      <button type="button" disabled={busy} onClick={() => { setKeys([]); setConfirming(false); void onRefresh(); }}>刷新关联</button>
      {canEdit && <><button type="button" disabled={busy || !ready || obsolete || !sameCustomer || selected.length !== 2} onClick={()=>void exclude(selected)}>不是同款，不再提醒</button><button type="button" className={styles.primary} disabled={busy || !ready || obsolete || !sameCustomer || selected.length < 2} onClick={() => { setConfirming(true); showSelection(); }}>核对所选货物</button></>}</div>
    {obsolete && <p role="alert" className={styles.feedback}>所选货物已变化，请清空后重新勾选。</p>}
    {message && <p role="status" className={styles.feedback}>{message}</p>}
    {selected.length > 0 && <div className={styles.selectionPreview} data-association-selection><h3>{confirming ? "确认这些是同款商品" : "所选货物对比"}</h3><div className={styles.compareGrid}>{selected.map(g => card(g, false))}</div>
      {changes.length > 0 && <p className={styles.differences}>需要核对：{changes.join("、")}。请勿把不同型号、颜色或规格关联为同款。</p>}
      {confirming && <div className={styles.confirmBar}><label>产品名称（共同部分）<input aria-label="统一产品名称" value={product} maxLength={500} onChange={e => setProduct(e.target.value)} disabled={busy} /></label>
        <div className={styles.splitPreview} role="region" aria-label="产品和附加标记预览"><p>不同部分放入附加标记，确认后用黄色显示。可以逐条调整。</p>{parts.map(p=><div key={p.stock.id}><small>{p.stock.locationCode} · 第 {p.stock.layerCount} 层 · 原名称：{p.stock.product}</small><strong><span className="product-attention">{[p.condition==="damaged"?"残次品":p.condition==="good"?"正品":"",p.prefix].filter(Boolean).length>0&&`（${[p.condition==="damaged"?"残次品":p.condition==="good"?"正品":"",p.prefix].filter(Boolean).join(" · ")}）`}</span>{product}</strong><label>附加标记<input aria-label={`附加标记 ${p.stock.id}`} value={p.prefix} maxLength={2000} disabled={busy} onChange={e=>setPrefixes(current=>({...current,[p.stock.id!]:e.target.value}))}/></label></div>)}</div>
        <p>将汇总 {selected.reduce((n, g) => n + g.quantity, 0).toLocaleString("zh-CN")} 件、{selected.reduce((n, g) => n + g.boxes, 0).toLocaleString("zh-CN")} 箱。每条原始记录独立保留，当前仓储计价不变。</p>
        <button type="button" className={styles.primary} disabled={busy || !product.trim() || obsolete || !sameCustomer} onClick={() => void save()}>{busy ? "保存中…" : "确认同款并关联"}</button><button type="button" disabled={busy} onClick={() => setConfirming(false)}>返回核对</button></div>}
    </div>}
    <h3>系统推荐 · {candidates.length} 对</h3>
    {candidates.slice(0, limit).map(c => <section className={styles.candidate} key={c.key} data-inventory-candidate={c.key}><div className={styles.candidateHeading}><b>{c.reason}</b>{canEdit && <div className={styles.candidateActions}><button type="button" disabled={busy || !ready} onClick={()=>void exclude([c.left,c.right])}>不是同款，不再提醒</button><button type="button" disabled={busy || !ready} onClick={() => { choose([c.left.key, c.right.key]); setConfirming(false); setMessage(""); showSelection(); }}>选择这两组核对</button></div>}</div>
      {c.differences.length > 0 && <p className={styles.differences}>{c.differences.join("、")}</p>}<div className={styles.compareGrid}>{card(c.left)}{card(c.right)}</div></section>)}
    {!candidates.length && <p className={styles.empty}>当前筛选没有推荐；这不代表已经找齐，可以在下面搜索并手动勾选。</p>}
    {candidates.length > limit && <button type="button" className={styles.more} onClick={() => setLimit(limit + 20)}>再显示20对推荐</button>}
    <h3>手动勾选货物 · 当前筛选 {filtered.length} 组</h3>
    <div className={styles.compareGrid}>{filtered.slice(0, limit).map(g => card(g))}</div>
    {filtered.length > limit && <button type="button" className={styles.more} onClick={() => setLimit(limit + 20)}>再显示20组货物</button>}
  </section>;
}
