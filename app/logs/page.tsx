"use client";
import {warehouseTimestamp} from '../../lib/warehouse-time';
import { useEffect, useRef, useState } from "react";
/* eslint-disable @next/next/no-html-link-for-pages -- Native return links avoid the Vinext client React shim and preserve a full reload. */
import {RecordFilters} from "../../components/RecordFilters";
import {emptyRecordFilters,recordFilterQuery,type RecordFilters as FilterValues} from "../../lib/record-filters";

type Log = { id: number; userName: string; action: string; entityType: string; entityId: string; summary: string; createdAt: string; canRestore?:boolean; restoreReason?:string };
type Pagination = { page: number; pageSize: number; total: number; totalPages: number };

export default function LogsPage() {
 const [logs, setLogs] = useState<Log[]>([]), [filters,setFilters]=useState<FilterValues>(emptyRecordFilters), [filterOptions,setFilterOptions]=useState<{actions:string[];operators:string[]}>({actions:[],operators:[]}), [loading, setLoading] = useState(true), [error, setError] = useState(""), [pagination, setPagination] = useState<Pagination>({ page: 1, pageSize: 50, total: 0, totalPages: 1 });
 const [confirmId,setConfirmId]=useState<number|null>(null),[restoringId,setRestoringId]=useState<number|null>(null),[message,setMessage]=useState("");
 const restoring=useRef(false);
 const reading = useRef(false), lastRead = useRef({ filters: emptyRecordFilters(), page: 1 });
 const load = async (f = filters, page = 1) => {
  if (reading.current) return;
  reading.current = true; lastRead.current = { filters: {...f}, page }; setLoading(true); setError("");
  try {
   const r = await fetch(`/api/audit?${recordFilterQuery(f)}&page=${page}&pageSize=50`, { cache: "no-store" }), d = await r.json();
   if (!r.ok) throw new Error(d.error || "管理记录读取失败");
   setLogs(d.logs); setFilterOptions(d.filterOptions||{actions:[],operators:[]}); setPagination(d.pagination);
  } catch (reason) { setError(reason instanceof SyntaxError ? "返回的数据格式异常，请重试。" : reason instanceof TypeError ? "网络连接失败，搜索内容已保留，请重试。" : reason instanceof Error ? reason.message : "记录读取失败，请重试。"); }
  finally { reading.current = false; setLoading(false); }
 };
 useEffect(() => {
  const timer = window.setTimeout(() => { void load(emptyRecordFilters(), 1); }, 0);
  return () => window.clearTimeout(timer);
  // Initial read only; search and pagination explicitly select later queries.
  // eslint-disable-next-line react-hooks/exhaustive-deps
 }, []);
 const restore=async(log:Log)=>{if(restoring.current||reading.current||!log.canRestore)return;restoring.current=true;setRestoringId(log.id);setMessage("");try{const r=await fetch("/api/audit/restore",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:log.id})}),d=await r.json();if(!r.ok)throw new Error(d.error||"撤销失败");setConfirmId(null);setMessage("已撤销，原记录和撤销痕迹均保留");await load(lastRead.current.filters,pagination.page);}catch(e){setMessage(e instanceof TypeError||e instanceof SyntaxError?"撤销结果尚未确认，请重新读取记录核对，避免重复撤销":e instanceof Error?e.message:"撤销失败，请重试");}finally{restoring.current=false;setRestoringId(null);}};
 return <main className="logs-page" aria-busy={loading||restoringId!==null}>
  <header><div><p>WAREHOUSE AUDIT</p><h1>管理操作记录</h1><span>仅老板和管理员可查看</span></div><a href="/">← 返回库位地图</a></header>
  <RecordFilters value={filters} onChange={setFilters} onApply={()=>void load(filters,1)} onReset={()=>{const next=emptyRecordFilters();setFilters(next);void load(next,1);}} disabled={loading||restoringId!==null} actions={filterOptions.actions} operators={filterOptions.operators} status searchLabel="搜索管理操作记录"/>
  {message&&<p className="backup-message" role="status">{message}<button disabled={loading||restoringId!==null} onClick={()=>void load(lastRead.current.filters,pagination.page)}>刷新记录</button></p>}
  {error ? <div className="log-empty" role="alert"><p>{error}</p><button type="button" disabled={loading} onClick={() => void load(lastRead.current.filters, lastRead.current.page)}>重新读取记录</button></div> : loading ? <div className="log-empty" role="status">正在读取管理记录…</div> : logs.length === 0 ? <div className="log-empty">暂无管理操作记录</div> : <>
   <section className="log-table audit-restore-table"><div className="log-row log-head"><span>时间</span><span>操作人员</span><span>操作</span><span>对象</span><span>具体说明</span><span>撤销</span></div>{logs.map(l => <article className="log-row" key={l.id}><time>{warehouseTimestamp(l.createdAt)}</time><b>{l.userName}</b><strong>{l.action}</strong><span>{l.entityType} · {l.entityId}</span><p>{l.summary || "—"}</p><div>{l.canRestore?(confirmId===l.id?<div className="record-undo-confirm"><span>确认撤销？</span><button disabled={loading||restoringId!==null} onClick={()=>void restore(l)}>{restoringId===l.id?"撤销中…":"确认撤销"}</button><button disabled={restoringId!==null} onClick={()=>setConfirmId(null)}>取消</button></div>:<button disabled={loading||restoringId!==null} onClick={()=>setConfirmId(l.id)}>撤销</button>):<small className="record-undo-state">{l.restoreReason||"仅查看"}</small>}</div></article>)}</section>
   <nav className="record-pagination" aria-label="管理记录分页"><button disabled={loading || restoringId!==null || pagination.page <= 1} onClick={() => void load(lastRead.current.filters, pagination.page - 1)}>上一页</button><span>第 {pagination.page} / {pagination.totalPages} 页 · 共 {pagination.total} 条</span><button disabled={loading || restoringId!==null || pagination.page >= pagination.totalPages} onClick={() => void load(lastRead.current.filters, pagination.page + 1)}>下一页</button></nav>
  </>}
 </main>;
}
