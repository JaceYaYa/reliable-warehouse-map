"use client";
import {readBackupFile} from '../../lib/backup-file-client';
import {warehouseTimestamp} from '../../lib/warehouse-time';
import { useEffect,useRef,useState } from "react";
import {RecordFilters} from "../../components/RecordFilters";
import {emptyRecordFilters,matchesRecordDate,type RecordFilters as FilterValues} from "../../lib/record-filters";
import {prepareWarehouseHistoryBackup,warehouseNeedsHistoryChunks,warehouseHistoryResumePlan,warehouseCoreCounts,verifyWarehouseCoreCounts,type WarehouseCoreCounts} from "../../lib/warehouse-history-chunks";
type HistoryUpload={signature:string;id:string;core:File;chunks:unknown[][];expected:WarehouseCoreCounts;counts:WarehouseCoreCounts|null;coreStarted:boolean;auditExpected:number};
type Backup={key:string;size:number;uploaded:string;kind:string;createdBy?:string;recordCount?:number;uncompressedSize?:number};
export default function BackupsPage(){
 const[list,setList]=useState<Backup[]>([]),[message,setMessage]=useState(""),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[loadError,setLoadError]=useState(""),[confirm,setConfirm]=useState(""),[importText,setImportText]=useState(""),[pendingImport,setPendingImport]=useState<unknown[]|null>(null),file=useRef<HTMLInputElement>(null),operation=useRef(false),reading=useRef(false);
 const [storage,setStorage]=useState<{totalBytes:number;uncompressedCount:number;compressionSavedBytes:number}|null>(null);
 const [filters,setFilters]=useState<FilterValues>(emptyRecordFilters),[applied,setApplied]=useState<FilterValues>(emptyRecordFilters);
 const [warehouseAvailable,setWarehouseAvailable]=useState(false),[warehouseOnly,setWarehouseOnly]=useState(false);
 const historyUpload=useRef<HistoryUpload|null>(null),[historyProgress,setHistoryProgress]=useState(""),[historyRetry,setHistoryRetry]=useState(false);
 const payload=async(response:Response)=>{const data=await response.json();if(!response.ok)throw new Error(data.error||"操作未完成，请重试");return data};
 const failure=(reason:unknown,fallback:string)=>reason instanceof SyntaxError||reason instanceof TypeError?fallback:reason instanceof Error?reason.message:fallback;
 const runBackup=async(body:Record<string,unknown>)=>{
  const post=async(value:Record<string,unknown>)=>payload(await fetch('/api/backups',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)}));
  let result=await post(body);
  while(result.pending&&result.backupJob){
   const job=result.backupJob;setMessage(`正在生成备份：已读取 ${job.count} 条记录，${(Number(job.bytes||0)/1024/1024).toFixed(2)} MB；${job.phase==='finalizing'?'正在压缩核验':'分段读取中，可在中断后重试继续'}。`);
   result=await post({action:'backup-step',jobId:job.id});
  }
  return result;
 };
 const load=async()=>{if(reading.current)return;reading.current=true;setLoading(true);setLoadError("");try{const d=await payload(await fetch("/api/backups",{cache:"no-store"}));setList(d.backups);setStorage(d.storage??null);setWarehouseAvailable(d.warehouseImportAvailable===true)}catch(reason){setLoadError(failure(reason,"备份列表读取失败，请检查连接后重试。"))}finally{reading.current=false;setLoading(false)}};
 useEffect(()=>{if(operation.current)return;operation.current=true;setBusy(true);void(async()=>{try{let checked,totalFreed=0,converted=0;do{checked=await runBackup({action:"auto"});if(checked.cleanup){totalFreed+=Number(checked.cleanup.freedBytes||0);if(checked.cleanup.verified)converted++;setMessage(`正在无损压缩历史备份：已处理 ${converted} 份，释放 ${(totalFreed/1024/1024).toFixed(2)} MB。原件仅在内容核对一致后删除。`);}}while(checked.cleanupNext);if(checked.verified)setMessage("每周备份已保存并核验。");if(checked.paused)setMessage(`${converted?`旧备份已无损压缩 ${converted} 份，释放 ${(totalFreed/1024/1024).toFixed(2)} MB。`:''}自动备份暂时暂停；完成一次手动备份验证后恢复每周检查。`);}catch(reason){setMessage(failure(reason,"自动维护未完成，未核验的旧备份原件已保留，可稍后重试。"))}finally{await load();operation.current=false;setBusy(false)}})()
// Automatic maintenance runs only when this page is first opened.
// eslint-disable-next-line react-hooks/exhaustive-deps
},[]);
 const create=async()=>{if(operation.current||reading.current)return;operation.current=true;setBusy(true);setMessage("正在开始备份…");try{const saved=await runBackup({action:'create'});if(!saved.verified||!saved.key)throw new Error("备份文件未确认保存，请刷新核对");setMessage(`手动备份已保存并核验${saved.pruned?`，已清理 ${saved.pruned} 份旧备份`:""}${saved.warning?`；${saved.warning}`:""}`);await load()}catch(reason){setMessage(failure(reason,"备份尚未完成；已读取的进度保留，请再次点击生成备份继续。"))}finally{operation.current=false;setBusy(false)}};
 const restore=async()=>{
  if(operation.current||reading.current)return;
  const f=file.current?.files?.[0];
  if(!f)return setMessage("请先选择备份文件");
  if(confirm!=="恢复备份")return setMessage("请输入“恢复备份”确认");
  if(!warehouseOnly&&!window.confirm("恢复会覆盖当前库存、地图、账号和记录，确认继续？"))return;
  operation.current=true;setBusy(true);setHistoryProgress("");setMessage("正在先备份当前数据并执行恢复…");
  try{
   let result;
   const decoded=await readBackupFile(f);
   if(!warehouseOnly&&decoded.file.size>50*1024*1024)throw new Error('这份备份的历史记录较大，请勾选“仅同步仓储数据，保留本站账号与登录”分段导入；账号请在目标站单独管理。');
   if(warehouseOnly){
    setMessage("正在本地校验备份并准备分段历史…");
    const text=decoded.text,parsed:unknown=decoded.source;
    if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))throw new Error("备份文件格式不正确");
    const source=parsed as Record<string,unknown>;
    if(Number(source.version)>=5&&warehouseNeedsHistoryChunks(source)){
     const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));
     const signature=Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
     if(historyUpload.current?.signature!==signature){
      const id=crypto.randomUUID(),prepared=prepareWarehouseHistoryBackup(source,id);
      const core=new File([JSON.stringify(prepared.core)],f.name,{type:'application/json'});if(core.size>50*1024*1024)throw new Error('基础数据仍超过50MB，尚未开始导入，请保留文件联系管理员分段处理。');
      historyUpload.current={signature,id,core,chunks:prepared.chunks,expected:warehouseCoreCounts(prepared.core),auditExpected:Number(prepared.core.warehouseAuditExpected||0),counts:null,coreStarted:false};
     }
     const job=historyUpload.current!;
     const current=await payload(await fetch('/api/backups',{cache:'no-store'}));
     let history=current.warehouseHistory;
     let plan=warehouseHistoryResumePlan(history,job.id,job.chunks,current.warehouseCoreBusy===true);
     if(!plan.uploadCore)job.counts=verifyWarehouseCoreCounts(history.counts,job.expected)||job.counts;
     if(plan.uploadCore){
      setMessage("正在备份当前数据并同步库存、库位及业务记录…");
      const form=new FormData();form.append('file',job.core);form.append('confirm',confirm);form.append('warehouseOnly','1');form.append('historyImportId',job.id);form.append('historyExpected',String(job.chunks.reduce((sum,rows)=>sum+rows.length,0)));if(job.auditExpected)form.append('historyAuditExpected',String(job.auditExpected));
      job.coreStarted=true;setHistoryRetry(true);
      result=await payload(await fetch('/api/backups',{method:'PUT',body:form}));
      history=result.history;plan=warehouseHistoryResumePlan(history,job.id,job.chunks);
      if(plan.uploadCore)throw new Error('核心数据恢复结果尚未确认，请保留文件后重试，系统会先核对进度。');
      job.counts=verifyWarehouseCoreCounts(result.counts??history.counts,job.expected);
     }
     setMessage("核心数据已接收，正在分段同步操作历史…");
     while(!plan.complete){
      const index=plan.nextIndex;
      setHistoryProgress(`操作历史：${history.received} / ${history.total} 条（第 ${index+1} / ${job.chunks.length} 段）`);
      const response=await payload(await fetch('/api/backups',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'warehouse-history',importId:job.id,index,rows:job.chunks[index]})}));
      history=response.history;plan=warehouseHistoryResumePlan(history,job.id,job.chunks);
      if(plan.uploadCore||plan.nextIndex!==index+1)throw new Error('操作历史接收结果尚未确认，请保留文件后重试，系统会先核对进度。');
     }
     setHistoryProgress(`操作历史：${history.received} / ${history.total} 条，已全部接收`);
     setConfirm('');
     setMessage(job.counts?`仓储数据同步完成：${job.counts.stocks}条产品库存、${job.counts.cartonReceipts}条箱库存、${history.received}条操作历史；本站账号和登录保留。`:'历史恢复完成，库存条数待重新核对；测试账号和登录保留。');
     await load();return;
    }
   }
   const form=new FormData();form.append("file",decoded.file);form.append("confirm",confirm);if(warehouseOnly)form.append('warehouseOnly','1');
   result=await payload(await fetch("/api/backups",{method:"PUT",body:form}));
   if(warehouseOnly){setConfirm('');setMessage(`仓储数据同步完成：${result.counts.stocks}条产品库存、${result.counts.cartonReceipts}条箱库存；测试账号和登录保留。`);await load();}
   else{alert("恢复完成，请重新登录");location.href="/"}
  }catch(reason){setMessage(failure(reason,warehouseOnly?"同步结果尚未确认，所选文件已保留。请再次点击同步，系统会先核对进度再继续。":"恢复结果尚未确认，请重新打开网站核对数据，避免重复恢复。"));}
  finally{operation.current=false;setBusy(false)}
 };
 const preparePaperImport=()=>{if(operation.current)return;let parsed:unknown;try{parsed=JSON.parse(importText)}catch{return setMessage("批量导入内容不是有效JSON")};const records=Array.isArray(parsed)?parsed:(parsed&&typeof parsed==="object"&&"records" in parsed?(parsed as {records:unknown}).records:null);if(!Array.isArray(records)||!records.length)return setMessage("没有可导入的库存记录");setPendingImport(records);setMessage(`已校验到 ${records.length} 条记录，请在下方确认写入。`)};
 const importPaper=async()=>{if(operation.current||!pendingImport?.length)return;operation.current=true;setBusy(true);setMessage("正在校验并导入纸质库存…");try{const d=await payload(await fetch("/api/stocks/import",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({records:pendingImport})}));setMessage(`纸质库存已导入：新增${d.imported}条，校正${d.updated}条，跳过重复${d.skipped}条`);setImportText("");setPendingImport(null)}catch(reason){setMessage(failure(reason,"导入结果尚未确认，填写内容已保留，请先到库存或记录中核对。"))}finally{operation.current=false;setBusy(false)}}; const label=(b:Backup)=>b.kind==="weekly"?"最新每周自动备份":b.kind==="daily"?"每日自动备份":b.kind==="monthly"?"每月长期备份":b.kind==="before-restore"?"恢复前保护备份":b.kind==="archive"?"年度历史记录归档":"手动备份";
 const visible=list.filter(b=>(!applied.action||label(b)===applied.action)&&(!applied.operator||(b.createdBy||"未记录")===applied.operator)&&matchesRecordDate(b.uploaded,applied)&&b.key.toLowerCase().includes(applied.q.toLowerCase()));
 // This admin-only recovery screen intentionally uses a plain anchor so a restore can force a full application reload.
 // eslint-disable-next-line @next/next/no-html-link-for-pages
 return <main className="backup-page" aria-busy={busy||loading}><header><div><p>DATA PROTECTION</p><h1>备份、归档与恢复</h1><span>按账号授权操作</span></div><a href="/">← 返回库位地图</a></header><section className="backup-summary"><div><b>自动保留策略</b><span>纽约时间每周首次打开备份恢复页时更新，自动备份只保留最新一份。新备份全部压缩保存；旧的每日和每月备份可在历史列表压缩下载。手动备份保留100份，恢复前备份保留20份。</span></div><button onClick={create} disabled={busy||loading}>立即生成手动备份</button></section>{storage&&<p>备份占用 {(storage.totalBytes/1024/1024).toFixed(2)} MB · 未压缩 {storage.uncompressedCount} 份 · 已通过无损压缩节省 {(storage.compressionSavedBytes/1024/1024).toFixed(2)} MB</p>}{message&&<p className="backup-message" role="status" aria-live="polite">{message}</p>}{historyProgress&&<p role="status" aria-live="polite">{historyProgress}</p>}<section className="paper-import-box"><div><h2>纸质库存批量导入</h2><p>仅用于正式迁移和后续批量补录。系统会校验2026年日期、校正同一纸质标签并跳过完全重复记录。</p></div><textarea disabled={busy} aria-label="纸质库存批量导入JSON" value={importText} onChange={e=>{setImportText(e.target.value);setPendingImport(null)}} placeholder='粘贴 {"records":[...]} 或记录数组'/><button onClick={preparePaperImport} disabled={busy||!importText.trim()}>校验并导入</button>{pendingImport&&<div className="paper-import-confirm"><b>确认写入 {pendingImport.length} 条纸质库存？</b><span>系统会自动跳过完全重复记录；导入结果会写入操作日志。</span><div><button type="button" className="cancel" onClick={()=>setPendingImport(null)} disabled={busy}>取消</button><button type="button" onClick={importPaper} disabled={busy}>确认导入{pendingImport.length}条</button></div></div>}</section><section className="backup-grid"><div className="backup-list"><h2>历史备份与归档</h2><RecordFilters value={filters} onChange={setFilters} onApply={()=>setApplied({...filters})} onReset={()=>{setFilters(emptyRecordFilters());setApplied(emptyRecordFilters());}} disabled={busy||loading} actions={[...new Set(list.map(label))]} operators={[...new Set(list.map(b=>b.createdBy||"未记录"))]} location={false} customer={false} searchLabel="搜索备份文件名"/><button type="button" disabled={busy||loading} onClick={()=>void load()}>刷新备份列表</button>{loadError?<div role="alert"><p>{loadError}</p><button type="button" disabled={busy||loading} onClick={()=>void load()}>重新读取备份</button></div>:loading?<p role="status">正在读取备份列表…</p>:visible.length===0?<p>{list.length?"没有符合条件的备份":"暂无备份"}</p>:visible.map(b=><article key={b.key}><div><b>{label(b)}</b><span>{b.createdBy||"未记录"} · {warehouseTimestamp(b.uploaded)} · {(b.size/1024/1024).toFixed(2)} MB{b.key.endsWith(".gz")?"（压缩后）":"（未压缩）"}{b.recordCount?` · ${b.recordCount}条记录`:""}</span></div><a href={`/api/backups?download=${encodeURIComponent(b.key)}&compressed=1`}>下载压缩备份</a></article>)}</div><div className="restore-box"><h2>上传并恢复</h2>{warehouseAvailable&&<label><input type="checkbox" checked={warehouseOnly} disabled={busy} onChange={event=>setWarehouseOnly(event.target.checked)}/>仅同步仓储数据，保留本站账号与登录</label>}<p>整库恢复需要全部操作权限。支持本系统下载的完整备份 JSON 或 JSON.gz 压缩文件。历史归档用于保存和查阅旧记录，不用于整库恢复。</p><input disabled={busy} aria-label="选择完整备份文件" ref={file} type="file" accept="application/json,application/gzip,.json,.json.gz,.gz"/><label>输入“恢复备份”确认<input disabled={busy} value={confirm} onChange={e=>setConfirm(e.target.value)} placeholder="恢复备份"/></label><button onClick={restore} disabled={busy||loading}>{warehouseOnly?(historyRetry?'继续同步并核对进度':'确认同步仓储数据'):'上传并恢复数据'}</button><small>备份包含箱件收货、工单与附件索引；旧版备份中没有的箱件收货数据会清空。附件原文件不会包含在备份中，跨站交接需另行迁移。大备份请勾选“仅同步仓储数据”分段导入；整库恢复的未压缩文件上限50MB。整库恢复后所有登录会话失效，需要重新登录；仅同步仓储数据会保留本站账号与登录。</small></div></section></main>
}


