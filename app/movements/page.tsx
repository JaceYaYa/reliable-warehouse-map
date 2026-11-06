"use client";
import {warehouseTimestamp} from '../../lib/warehouse-time';
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import "./MovementRestoreDialog.css";

import {RecordFilters} from "../../components/RecordFilters";
import {emptyRecordFilters,recordFilterQuery,type RecordFilters as FilterValues} from "../../lib/record-filters";

type Log = { id: number; userName: string; action: string; entityType: string; entityId: string; summary: string; createdAt: string; canRestore?:boolean; restoreReason?:string };
type Pagination = { page: number; pageSize: number; total: number; totalPages: number };

export default function MovementsPage() {
 const [logs, setLogs] = useState<Log[]>([]), [restored, setRestored] = useState<number[]>([]), [canRestore, setCanRestore] = useState(false), [canRestoreDeletedStocks, setCanRestoreDeletedStocks] = useState(false), [restoringId, setRestoringId] = useState<number | null>(null), [filters,setFilters]=useState<FilterValues>(emptyRecordFilters), [filterOptions,setFilterOptions]=useState<{actions:string[];operators:string[]}>({actions:[],operators:[]}), [loading, setLoading] = useState(true), [error, setError] = useState(""), [pagination, setPagination] = useState<Pagination>({ page: 1, pageSize: 50, total: 0, totalPages: 1 });
 const [restoreTarget,setRestoreTarget]=useState<Log|null>(null);
 const reading = useRef(false), restoring = useRef(false), lastRead = useRef({ filters: emptyRecordFilters(), page: 1 });
 const load = async (f = filters, page = 1) => {
  if (reading.current) return;
  reading.current = true; lastRead.current = { filters: {...f}, page }; setLoading(true); setError("");
  try {
   const r = await fetch(`/api/movements?${recordFilterQuery(f)}&page=${page}&pageSize=50`, { cache: "no-store" }), d = await r.json();
   if (!r.ok) throw new Error(d.error || "出入库记录读取失败");
   setLogs(d.logs); setFilterOptions(d.filterOptions||{actions:[],operators:[]}); setRestored(d.restoredIds || []); setCanRestore(d.canRestore === true); setCanRestoreDeletedStocks(d.canRestoreDeletedStocks === true); setPagination(d.pagination);
  } catch (reason) { setError(reason instanceof SyntaxError ? "返回的数据格式异常，请重试。" : reason instanceof TypeError ? "网络连接失败，搜索内容已保留，请重试。" : reason instanceof Error ? reason.message : "记录读取失败，请重试。"); }
  finally { reading.current = false; setLoading(false); }
 };
 useEffect(() => {
  const timer = window.setTimeout(() => { void load(emptyRecordFilters(), 1); }, 0);
  return () => window.clearTimeout(timer);
  // Initial load only; later loads are explicit search, restore or pagination actions.
  // eslint-disable-next-line react-hooks/exhaustive-deps
 }, []);
 const canRestoreLog = (log: Log) => canRestore && log.canRestore!==false && (log.action !== "删除" || canRestoreDeletedStocks);
 const restore = async (log: Log) => {
  if (restoring.current || reading.current || !canRestoreLog(log)) return;
  restoring.current = true; setRestoringId(log.id); setError("");
  try {
   const r = await fetch("/api/movements", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: log.id }) }), d = await r.json();
   if (!r.ok) { setError(d.error || "恢复失败，请刷新记录后核对。"); return; }
   setRestoreTarget(null); await load(lastRead.current.filters, pagination.page);
  } catch { setError("恢复结果尚未确认，请先重新读取记录核对，避免重复恢复。"); }
  finally { restoring.current = false; setRestoringId(null); }
 };
 return <main className="logs-page movements-page" aria-busy={loading||restoringId!==null}><header><div><p>INBOUND & OUTBOUND</p><h1>出入库记录</h1><span>{canRestore ? "可查看并恢复有权限的误操作" : "仅可搜索和查看记录"}</span></div><Link href="/">← 返回库位地图</Link></header><RecordFilters value={filters} onChange={setFilters} onApply={()=>void load(filters,1)} onReset={()=>{const next=emptyRecordFilters();setFilters(next);void load(next,1);}} disabled={loading||restoringId!==null} actions={filterOptions.actions} operators={filterOptions.operators} status searchLabel="搜索出入库记录"/>{error ? <div className="log-empty" role="alert"><p>{error}</p><button type="button" disabled={loading||restoringId!==null} onClick={()=>void load(lastRead.current.filters,lastRead.current.page)}>重新读取记录</button></div> : loading ? <div className="log-empty" role="status">正在读取出入库记录…</div> : logs.length === 0 ? <div className="log-empty">暂无出入库记录</div> : <><section className="log-table movement-restore-table"><div className="log-row log-head"><span>时间</span><span>操作人员</span><span>类型</span><span>库位</span><span>产品、单号及数量变化</span><span>操作</span></div>{logs.map(log => <article className="log-row" key={log.id}><time>{warehouseTimestamp(log.createdAt)}</time><b>{log.userName}</b><strong className={log.action.includes("出库") ? "outbound" : log.action === "移库" ? "moved" : log.action === "删除" ? "deleted" : log.action === "恢复" ? "restored" : "inbound"}>{log.action}</strong><span>{log.entityType.startsWith("箱件")?"箱库存":log.entityId}</span><p>{log.summary || "—"}</p><div>{!canRestoreLog(log) ? <small>{log.restoreReason||(log.action === "删除" ? "无恢复权限" : "仅浏览")}</small> : log.action === "恢复" ? <small>恢复记录</small> : restored.includes(log.id) ? <small>已恢复</small> : <button disabled={loading||restoringId !== null} onClick={() => {setError("");setRestoreTarget(log)}}>{restoringId === log.id ? "恢复中…" : "恢复"}</button>}</div></article>)}</section><nav className="record-pagination"><button disabled={loading||restoringId!==null||pagination.page <= 1} onClick={() => load(lastRead.current.filters, pagination.page - 1)}>上一页</button><span>第 {pagination.page} / {pagination.totalPages} 页 · 共 {pagination.total} 条</span><button disabled={loading||restoringId!==null||pagination.page >= pagination.totalPages} onClick={() => load(lastRead.current.filters, pagination.page + 1)}>下一页</button></nav></>}{restoreTarget&&<div className="movement-restore-backdrop"><section className="movement-restore-dialog" role="dialog" aria-modal="true" aria-label="确认恢复操作" aria-busy={restoringId!==null}><h2>确认恢复操作</h2><p><strong>{restoreTarget.action} · {restoreTarget.entityId}</strong></p><p>{restoreTarget.summary}</p><p>系统会按这条原记录反向调整库存，并保留恢复痕迹。仅打开此窗口不会修改数据。</p>{error&&<p role="alert">{error}</p>}<footer><button type="button" autoFocus aria-label="关闭恢复确认" disabled={restoringId!==null} onClick={()=>setRestoreTarget(null)}>取消</button><button type="button" disabled={loading||restoringId!==null} onClick={()=>void restore(restoreTarget)}>{restoringId!==null?"恢复中…":"确认恢复"}</button></footer></section></div>}</main>;
}
