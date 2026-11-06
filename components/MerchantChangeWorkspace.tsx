"use client";

import {useCallback,useEffect,useRef,useState} from 'react';
import {CustomerNameInput} from './CustomerNameInput';
import './MerchantChangeWorkspace.css';

type MerchantRecord={id:string;kind:'stock'|'carton'|'history';customerName:string;product:string;sku:string;locationCode:string;layer:number|null;inboundDate:string|null;outboundDate:string|null;quantity:number;boxes:number};
type MerchantChangeSummary={id:string;createdAt:string;summary:string;canUndo:boolean;reason?:string};
type Directory={customers:string[];records:MerchantRecord[];revision:string;changes?:MerchantChangeSummary[]};
type Preview={previewToken:string;targetCustomerName:string;affected:{stocks:number;cartons:number;history:number};customers:Array<{name:string;beforeFee:number|null;afterFee:number|null;beforePending:number|boolean;afterPending:number|boolean}>;period:{fromDate?:string;toDate?:string;fromMonth:string;toMonth:string};notices:string[]};
type Props={period:{fromDate?:string;toDate?:string;fromMonth:string;toMonth:string};asOf?:string;onClose:()=>void;onSaved:(target:string)=>void};
const endpoint='/api/pricing/merchants';
const searchKey=(value:string)=>value.normalize('NFKC').trim().toLocaleLowerCase();
const money=(value:number|null)=>typeof value==='number'&&Number.isFinite(value)?`$${value.toFixed(2)}`:'待核对';
const kindName={stock:'库存',carton:'箱记录',history:'历史出库'};
const message=(cause:unknown)=>cause instanceof Error?cause.message:'操作失败，请重试';
async function request<T>(url:string,options:RequestInit={}):Promise<T>{
 const response=await fetch(url,{...options,cache:'no-store'});
 let value;try{value=await response.json();}catch{throw Error('服务器返回资料不完整，请重试');}
 if(!response.ok)throw Error(typeof value?.error==='string'?value.error:`请求失败（${response.status}），请重试`);
 return value as T;
}
function validDirectory(value:Directory){if(!value||!Array.isArray(value.customers)||typeof value.revision!=='string'||!value.revision||!Array.isArray(value.records))throw Error('客户目录资料不完整，请重试');return value;}
function validPreview(value:Preview){if(!value||!value.previewToken||!value.targetCustomerName||!value.affected||!Array.isArray(value.customers)||!Array.isArray(value.notices)||!value.period)throw Error('变更预览资料不完整，请重新预览');return value;}

export function MerchantChangeWorkspace({period,asOf,onClose,onSaved}:Props){
 const [mode,setMode]=useState<'customers'|'records'>('customers');
 const [directory,setDirectory]=useState<Directory|null>(null),[directoryLoading,setDirectoryLoading]=useState(true),[directoryError,setDirectoryError]=useState(''),[reload,setReload]=useState(0);
 const [sources,setSources]=useState<string[]>([]),[customerSearch,setCustomerSearch]=useState(''),[target,setTarget]=useState('');
 const [recordCustomer,setRecordCustomer]=useState(''),[rows,setRows]=useState<MerchantRecord[]>([]),[rowsLoading,setRowsLoading]=useState(false),[rowsError,setRowsError]=useState(''),[rowReload,setRowReload]=useState(0),[query,setQuery]=useState(''),[page,setPage]=useState(0);
 const [selected,setSelected]=useState<Record<string,MerchantRecord>>({});
 const [preview,setPreview]=useState<{value:Preview;fingerprint:string}|null>(null),[busy,setBusy]=useState<'preview'|'save'|'undo'|''>(''),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [saved,setSaved]=useState<{changeId:string;target:string}|null>(null),[undoChoice,setUndoChoice]=useState<string|null>(null),[refreshTarget,setRefreshTarget]=useState<string|null>(null);
 const editSerial=useRef(0),requestBusy=useRef(false),recordSequence=useRef(0),acceptedRevision=useRef<string|null>(null),mounted=useRef(true),dialog=useRef<HTMLDivElement>(null);
 const selectedIds=Object.keys(selected).sort(),targetName=target.trim(),knownCustomer=recordCustomer==='__unclaimed__'||!!directory?.customers.includes(recordCustomer);
 const fingerprint=JSON.stringify([mode,[...sources].sort(),selectedIds,targetName,directory?.revision,period.fromDate,period.toDate,period.fromMonth,period.toMonth,asOf,customerSearch,recordCustomer,query]);
 const currentPreview=preview?.fingerprint===fingerprint?preview.value:null;
 const locked=busy==='save'||busy==='undo'||!!saved;
 const filteredRows=rows.filter(row=>[row.id,row.customerName,row.product,row.sku,row.locationCode,kindName[row.kind]].some(value=>searchKey(value||'').includes(searchKey(query))));
 const filteredCustomers=(directory?.customers??[]).filter(name=>searchKey(name).includes(searchKey(customerSearch)));
 const allFilteredSelected=filteredRows.length>0&&filteredRows.every(row=>!!selected[row.id]);
 const pageCount=Math.max(1,Math.ceil(filteredRows.length/50)),visibleRows=filteredRows.slice(page*50,page*50+50);
 const validDates=period.fromDate&&period.toDate?/^\d{4}-\d{2}-\d{2}$/.test(period.fromDate)&&/^\d{4}-\d{2}-\d{2}$/.test(period.toDate)&&period.fromDate<=period.toDate:undefined;
 const validMonths=/^\d{4}-(0[1-9]|1[0-2])$/.test(period.fromMonth)&&/^\d{4}-(0[1-9]|1[0-2])$/.test(period.toMonth)&&period.fromMonth<=period.toMonth;
 const canPreview=!!directory&&!directoryLoading&&!directoryError&&!!targetName&&(validDates??validMonths)&&(mode==='customers'?sources.length>0&&!sources.includes(targetName):selectedIds.length>0);
 const invalidate=useCallback(()=>{editSerial.current++;setPreview(null);setError('');setNotice('');},[]);
 const adoptDirectory=useCallback((value:Directory)=>{
  if(acceptedRevision.current!==null&&acceptedRevision.current!==value.revision){
   invalidate();setSources([]);setSelected({});setNotice('客户归属资料已更新，已清空原选择。请重新选择记录或客户并预览。');
  }
  acceptedRevision.current=value.revision;setDirectory(value);
 },[invalidate]);
 const refreshDirectory=()=>{invalidate();setDirectoryLoading(true);setDirectoryError('');setReload(value=>value+1);};
 useEffect(()=>{
  mounted.current=true;
  const previous=typeof document!=='undefined'?document.activeElement:null;
  dialog.current?.focus();
  return()=>{mounted.current=false;if(typeof HTMLElement!=='undefined'&&previous instanceof HTMLElement)previous.focus();};
 },[]);
 useEffect(()=>{
  const controller=new AbortController();
  void request<Directory>(endpoint,{signal:controller.signal}).then(validDirectory).then(value=>{if(!controller.signal.aborted){adoptDirectory(value);setDirectoryLoading(false);setDirectoryError('');}}).catch(cause=>{if(!controller.signal.aborted){setDirectoryError(message(cause));setDirectoryLoading(false);}});
  return()=>controller.abort();
 },[reload,adoptDirectory]);
 useEffect(()=>{
  if(mode!=='records'||!knownCustomer)return;
  const controller=new AbortController(),sequence=++recordSequence.current;
  void request<Directory>(`${endpoint}?${new URLSearchParams({customer:recordCustomer})}`,{signal:controller.signal}).then(validDirectory).then(value=>{
   if(!controller.signal.aborted&&sequence===recordSequence.current){setRows(value.records);adoptDirectory(value);setRowsLoading(false);setRowsError('');}
  }).catch(cause=>{if(!controller.signal.aborted&&sequence===recordSequence.current){setRowsError(message(cause));setRowsLoading(false);}});
  return()=>controller.abort();
 },[mode,recordCustomer,knownCustomer,rowReload,adoptDirectory]);
 const chooseMode=(next:'customers'|'records')=>{if(locked||next===mode)return;invalidate();recordSequence.current++;setMode(next);setRows([]);setRowsLoading(next==='records'&&knownCustomer);setRowsError('');setPage(0);};
 const chooseRecordCustomer=(name:string)=>{if(locked)return;invalidate();recordSequence.current++;setRecordCustomer(name);setRows([]);setRowsError('');setPage(0);setRowsLoading(name==='__unclaimed__'||!!directory?.customers.includes(name));};
 const body=()=>({mode,...(mode==='customers'?{sources:[...sources].sort()}:{records:selectedIds}),targetCustomerName:targetName,expectedRevision:directory!.revision,...(period.fromDate&&period.toDate?{fromDate:period.fromDate,toDate:period.toDate}:{fromMonth:period.fromMonth,toMonth:period.toMonth}),...(asOf?{asOf}:{})});
 const previewChange=async()=>{
  if(requestBusy.current||!canPreview||saved)return;
  requestBusy.current=true;setBusy('preview');setError('');setPreview(null);const serial=editSerial.current,snapshot=fingerprint;
  try{const value=validPreview(await request<Preview>(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body())}));if(mounted.current&&serial===editSerial.current)setPreview({value,fingerprint:snapshot});}
  catch(cause){if(mounted.current&&serial===editSerial.current)setError(message(cause));}
  finally{requestBusy.current=false;if(mounted.current)setBusy('');}
 };
 const saveChange=async()=>{
  if(requestBusy.current||!currentPreview||!canPreview||saved)return;
  requestBusy.current=true;setBusy('save');setError('');
  try{
   const value=await request<Preview&{saved:boolean;changeId:string}>(endpoint,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({...body(),previewToken:currentPreview.previewToken})});
   if(!value.saved||!value.changeId)throw Error('保存结果待核对，请刷新后查询调整记录');
   if(mounted.current){setSaved({changeId:value.changeId,target:value.targetCustomerName});setPreview(null);setNotice('已保存客户调整，可在离开前安全撤销。');}
  }catch(cause){if(mounted.current){setError(message(cause));setPreview(null);setDirectoryLoading(true);setReload(value=>value+1);}}
  finally{requestBusy.current=false;if(mounted.current)setBusy('');}
 };
 const undo=async(changeId:string)=>{
  if(requestBusy.current)return;requestBusy.current=true;setBusy('undo');setError('');
  try{
   const value=await request<{ok:boolean}>(endpoint,{method:'DELETE',headers:{'content-type':'application/json'},body:JSON.stringify({changeId})});
   if(!value.ok)throw Error('撤销结果待核对，请刷新后查询调整记录');
   if(mounted.current){invalidate();acceptedRevision.current=null;setRefreshTarget(saved?.target??'');setSaved(null);setUndoChoice(null);setSources([]);setSelected({});setRows([]);setRecordCustomer('');setMode('customers');setNotice('已撤销客户调整。');setDirectoryLoading(true);setReload(value=>value+1);}
  }catch(cause){if(mounted.current)setError(message(cause));}
  finally{requestBusy.current=false;if(mounted.current)setBusy('');}
 };
 const finish=()=>{if(requestBusy.current)return;if(saved)onSaved(saved.target);else if(refreshTarget!==null)onSaved(refreshTarget);else onClose();};
 const toggleRecord=(row:MerchantRecord,checked:boolean)=>{if(locked)return;invalidate();setSelected(current=>{const next={...current};if(checked)next[row.id]=row;else delete next[row.id];return next;});};

 return <div className="merchant-change-backdrop"><div ref={dialog} className="merchant-change-dialog" role="dialog" aria-modal="true" aria-labelledby="merchant-change-title" tabIndex={-1} onKeyDown={event=>{
  if(event.key==='Escape'&&!requestBusy.current){event.stopPropagation();finish();}
  if(event.key==='Tab'){const controls=dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),summary,[tabindex="0"]');if(!controls?.length)return;const first=controls[0],last=controls[controls.length-1];if(event.shiftKey&&(document.activeElement===first||document.activeElement===dialog.current)){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}
 }}>
  <header className="mc-heading"><div><h3 id="merchant-change-title">调整客户归属</h3><p>{period.fromDate??period.fromMonth} 至 {period.toDate??period.toMonth} · 预览本期可计算费用</p></div><button type="button" onClick={finish} disabled={!!busy} aria-label="关闭客户调整">关闭</button></header>
  <div className="mc-body">
   <p className="mc-policy">调整保留日期、件箱数量、SKU 和实物库位；使用目标客户的费率与免租期。原确认账单仅归档，保留原客户名称和金额；确认不代表收款，本期占层费用照常重算。</p>
   <div className="mc-modes" role="group" aria-label="客户调整方式"><button type="button" aria-pressed={mode==='customers'} disabled={locked} onClick={()=>chooseMode('customers')}>按客户全部合并</button><button type="button" aria-pressed={mode==='records'} disabled={locked} onClick={()=>chooseMode('records')}>选择记录调整</button></div>
   {directoryLoading&&<p className="mc-muted" role="status">正在读取客户目录…</p>}
   {directoryError&&<div className="mc-error" role="alert">{directoryError} <button type="button" onClick={refreshDirectory} disabled={!!busy}>重试目录</button></div>}
   {mode==='customers'?<section className="mc-scope" aria-label="全部合并范围">
    <div className="mc-section-heading"><strong>选择原客户</strong><span>已选 {sources.length} 个客户</span></div>
    <p className="mc-muted">合并所选客户的全部当前库存、箱记录和历史出库；日期范围只限定费用预览。</p>
    <input aria-label="搜索原客户" placeholder="搜索客户名称" value={customerSearch} disabled={locked} onChange={event=>{invalidate();setCustomerSearch(event.target.value);}}/>
    <div className="mc-customers">{filteredCustomers.map(name=><label key={name}><input type="checkbox" aria-label={`合并客户 ${name}`} checked={sources.includes(name)} disabled={locked} onChange={event=>{invalidate();setSources(current=>event.target.checked?[...new Set([...current,name])]:current.filter(value=>value!==name));}}/><span>{name}</span></label>)}{directory&&!directoryLoading&&!filteredCustomers.length&&<p className="mc-muted">没有匹配的客户</p>}</div>
    {sources.length>0&&<p className="mc-selected-names">已选：{sources.join('、')} <button type="button" disabled={locked} onClick={()=>{invalidate();setSources([]);}}>清空客户选择</button></p>}
   </section>:<section className="mc-scope" aria-label="指定记录范围">
    <div className="mc-record-filters"><label><span>记录所属客户</span><CustomerNameInput label="记录所属客户" value={recordCustomer==='__unclaimed__'?'':recordCustomer} customerNames={directory?.customers??[]} disabled={locked||directoryLoading} placeholder={recordCustomer==='__unclaimed__'?'已选择未认领记录':'先搜索并选择已有客户'} onChange={chooseRecordCustomer}/></label><button type="button" aria-pressed={recordCustomer==='__unclaimed__'} disabled={locked||directoryLoading} onClick={()=>chooseRecordCustomer('__unclaimed__')}>未认领</button><label className="mc-record-search"><span>搜索记录</span><input aria-label="搜索记录" placeholder="货物 / SKU / 库位 / 记录编号" value={query} disabled={locked} onChange={event=>{invalidate();setQuery(event.target.value);setPage(0);}}/></label></div>
    <div className="mc-section-heading"><span>已选 {selectedIds.length} 条 · 本客户筛选 {filteredRows.length} 条</span>{selectedIds.length>0&&<button type="button" disabled={locked} onClick={()=>{invalidate();setSelected({});}}>清空记录选择</button>}</div>
    {!knownCustomer&&<p className="mc-muted">请先选择客户，再勾选当前库存、箱记录或历史出库。</p>}
    {rowsLoading&&<p className="mc-muted" role="status">正在读取所选客户记录…</p>}
    {rowsError&&<div className="mc-error" role="alert">{rowsError} <button type="button" disabled={!!busy} onClick={()=>{invalidate();setRowsLoading(true);setRowsError('');setRowReload(value=>value+1);}}>重试记录</button></div>}
    {knownCustomer&&!rowsLoading&&!rowsError&&<><label className="mc-select-all"><input type="checkbox" aria-label="全选当前筛选记录" checked={allFilteredSelected} disabled={locked||!filteredRows.length} onChange={event=>{if(locked)return;invalidate();setSelected(current=>{const next={...current};for(const row of filteredRows){if(event.target.checked)next[row.id]=row;else delete next[row.id];}return next;});}}/>全选当前筛选记录 <small>仅影响筛选结果，保留其他客户的选择</small></label>
     {filteredRows.length?<div className="mc-table-wrap"><table className="mc-record-table"><thead><tr><th>选择</th><th>类型 / 货物</th><th>库位 / 层</th><th>日期</th><th>数量</th></tr></thead><tbody>{visibleRows.map(row=><tr key={row.id} className={selected[row.id]?'is-selected':undefined}><td data-label="选择"><input type="checkbox" aria-label={`选择记录 ${row.id}`} checked={!!selected[row.id]} disabled={locked} onChange={event=>toggleRecord(row,event.target.checked)}/></td><td data-label="类型 / 货物"><strong>{row.product||'货物待补充'}</strong><span>{kindName[row.kind]} · {row.customerName||'未认领'}</span><small>SKU：{row.sku||'无'}</small><details className="mc-record-details"><summary>查看记录编号</summary><small>{row.id}</small></details></td><td data-label="库位 / 层"><span>{row.locationCode||'库位待核对'}{row.layer!==null?` / 第 ${row.layer} 层`:''}</span></td><td data-label="日期"><span>入库 {row.inboundDate||'待核对'}</span>{row.kind==='history'&&<span>出库 {row.outboundDate||'待核对'}</span>}</td><td data-label="数量"><span>{row.quantity} 件</span><span>{row.boxes} 箱</span></td></tr>)}</tbody></table></div>:<p className="mc-muted">没有符合条件的记录</p>}
     {pageCount>1&&<div className="mc-pagination"><button type="button" disabled={page===0} onClick={()=>setPage(value=>value-1)}>上一页</button><span>第 {page+1} / {pageCount} 页</span><button type="button" disabled={page+1>=pageCount} onClick={()=>setPage(value=>value+1)}>下一页</button></div>}
    </>}
    {selectedIds.length>0&&<details className="mc-selection"><summary>查看已选 {selectedIds.length} 条（跨客户保留）</summary>{selectedIds.map(id=><div key={id}><span>{selected[id].customerName||'未认领'} · {selected[id].product||'货物待补充'} · {selected[id].locationCode||'库位待核对'}<small>{id}</small></span><button type="button" aria-label={`移除选择 ${id}`} disabled={locked} onClick={()=>toggleRecord(selected[id],false)}>移除</button></div>)}</details>}
   </section>}
   <div className="mc-target"><label><span>目标客户</span><CustomerNameInput label="目标客户" value={target} customerNames={directory?.customers??[]} disabled={locked||directoryLoading} placeholder="搜索已有客户或填写新名称" onChange={value=>{invalidate();setTarget(value);}}/></label><p className="mc-muted">{mode==='customers'?'所选原客户的全部记录归入目标客户。':'只调整已勾选记录，不合并其他同名客户记录。'}</p></div>
   {mode==='customers'&&sources.includes(targetName)&&<p className="mc-error" role="alert">目标客户也在原客户选择中，请取消该项勾选。</p>}
   {!validMonths&&<p className="mc-error" role="alert">费用预览月份无效，请关闭后重新选择计价期间。</p>}
   {currentPreview&&<section className="mc-preview" aria-label="客户归属变更预览"><h4>预览 → {currentPreview.targetCustomerName}</h4><p>库存 {currentPreview.affected.stocks} · 箱记录 {currentPreview.affected.cartons} · 历史出库 {currentPreview.affected.history}</p><p className="mc-muted">{currentPreview.period.fromDate??currentPreview.period.fromMonth} 至 {currentPreview.period.toDate??currentPreview.period.toMonth} 本期可计算费用，按客户汇总</p><table className="mc-fee-table"><thead><tr><th>客户</th><th>调整前</th><th>调整后</th></tr></thead><tbody>{currentPreview.customers.map(customer=><tr key={customer.name}><td>{customer.name||'未认领'}</td><td><span>{money(customer.beforeFee)}</span>{!!customer.beforePending&&<small>待核对{typeof customer.beforePending==='number'?` ${customer.beforePending} 项`:''}</small>}</td><td><span>{money(customer.afterFee)}</span>{!!customer.afterPending&&<small>待核对{typeof customer.afterPending==='number'?` ${customer.afterPending} 项`:''}</small>}</td></tr>)}</tbody></table>{currentPreview.notices.length>0&&<ul>{currentPreview.notices.map((value,index)=><li key={index}>{value}</li>)}</ul>}<p className="mc-muted">原确认账单仅归档，保留原客户名称和金额；确认不代表收款，本期占层费用照常重算。请核对范围后确认保存。</p></section>}
   {error&&<p className="mc-error" role="alert">{error}</p>}
   {notice&&<p className="mc-success" role="status">{notice}</p>}
   {saved&&<div className="mc-saved-actions"><button type="button" disabled={!!busy} onClick={()=>void undo(saved.changeId)}>撤销本次调整</button><small>后续有依赖变更时，系统会拒绝撤销并说明原因。</small></div>}
   {!saved&&!!directory?.changes?.length&&<details className="mc-recent"><summary>最近客户调整 · {directory.changes.length} 条</summary>{directory.changes.map(change=><div key={change.id}><span>{change.summary}<small>{change.createdAt}</small>{!change.canUndo&&<small>{change.reason||'已有后续依赖，不能安全撤销'}</small>}</span>{change.canUndo&&(undoChoice===change.id?<span><button type="button" disabled={!!busy} onClick={()=>void undo(change.id)}>确认撤销此调整</button><button type="button" disabled={!!busy} onClick={()=>setUndoChoice(null)}>取消撤销</button></span>:<button type="button" disabled={!!busy} onClick={()=>{invalidate();setUndoChoice(change.id);}}>撤销此调整</button>)}</div>)}</details>}
  </div>
  <footer className="mc-footer"><span>{busy==='preview'?'正在计算变更预览…':busy==='save'?'正在保存，请稍候…':busy==='undo'?'正在核查并撤销…':saved?'已保存':mode==='customers'?`已选 ${sources.length} 个原客户`:`已选 ${selectedIds.length} 条记录`}</span><div>{saved?<button type="button" className="mc-primary" disabled={!!busy} onClick={finish}>完成并查看目标客户</button>:<><button type="button" disabled={!!busy} onClick={finish}>取消</button>{currentPreview?<button type="button" className="mc-primary" disabled={!!busy||!canPreview} onClick={()=>void saveChange()}>确认保存</button>:<button type="button" className="mc-primary" disabled={!!busy||!canPreview} onClick={()=>void previewChange()}>预览变更</button>}</>}</div></footer>
 </div></div>;
}
