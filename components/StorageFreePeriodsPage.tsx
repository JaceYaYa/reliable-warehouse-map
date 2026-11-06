'use client';
import {useEffect,useRef,useState} from 'react';
import {palletLabel} from '../lib/pallet';
import {hasPermission} from '../lib/permissions';
import type {StorageFreePeriodRow,StorageFreePeriodsResult,StorageFreePeriodStatus} from '../lib/storage-free-periods';
import {UnclaimedCustomerPicker} from './UnclaimedCustomerPicker';
import './StorageFreePeriodsPage.css';
type Gate='loading'|'ready'|'signed-out'|'denied'|'error';
const statusLabel={expired:'已到期',near:'临近到期',free:'免租中',review:'待核对'};
const reasonLabel:Record<string,string>={'unclaimed-customer':'客户归属待补充','invalid-inbound-date':'实际入库日期待核对','invalid-free-days':'客户或默认免租天数待核对','invalid-date-range':'免租日期超出可查询范围'};
function remainingLabel(row:StorageFreePeriodRow){if(row.status==='review')return '待核对';if(row.status==='expired')return row.daysOverdue===0?'今日开始计费':`已超期 ${row.daysOverdue} 天`;return `剩余 ${row.daysRemaining} 天`;}
export function StorageFreePeriodsPage(){
 const [gate,setGate]=useState<Gate>('loading'),[error,setError]=useState(''),[customers,setCustomers]=useState<string[]>([]),[unclaimedCount,setUnclaimedCount]=useState(0),[directoryReload,setDirectoryReload]=useState(0);
 const [customer,setCustomer]=useState(''),[q,setQ]=useState(''),[status,setStatus]=useState<'all'|StorageFreePeriodStatus>('all'),[data,setData]=useState<StorageFreePeriodsResult|null>(null),[queryError,setQueryError]=useState(''),[queryLoading,setQueryLoading]=useState(false),[reload,setReload]=useState(0),[page,setPage]=useState(1),[pageSize,setPageSize]=useState(25);
 const requestSequence=useRef(0);
 useEffect(()=>{
  let active=true;const controller=new AbortController();
  void(async()=>{try{
   const response=await fetch('/api/auth/me',{cache:'no-store',signal:controller.signal});if(!active)return;
   if(response.status===401){setGate('signed-out');return;}if(!response.ok)throw Error('权限检查失败，请重试');
   const auth=await response.json();if(!active)return;if(!hasPermission(auth.user,'pricing.manage')){setGate('denied');return;}
   const result=await fetch('/api/pricing/customers',{cache:'no-store',signal:controller.signal});if(!active)return;
   if(result.status===401){setGate('signed-out');return;}if(result.status===403){setGate('denied');return;}
   const payload=await result.json();if(!active)return;if(!result.ok)throw Error(payload.error||'客户目录读取失败，请重试');
   if(!Array.isArray(payload.customers)||payload.customers.some((name:unknown)=>typeof name!=='string')||!Number.isInteger(payload.unclaimedCount)||payload.unclaimedCount<0)throw Error('客户目录返回资料不完整，请重试');
   setCustomers(payload.customers);setUnclaimedCount(payload.unclaimedCount);setGate('ready');
  }catch(problem){if(active&&!controller.signal.aborted){setError(problem instanceof Error?problem.message:'客户目录读取失败，请重试');setGate('error');}}})();
  return()=>{active=false;controller.abort();};
 },[directoryReload]);
 useEffect(()=>{
  if(gate!=='ready'||!customer)return;
  let active=true;const controller=new AbortController(),sequence=++requestSequence.current;
  const current=()=>active&&sequence===requestSequence.current;
  void(async()=>{try{
   const query=customer==='__unclaimed__'?'unclaimed=1':new URLSearchParams({customer}).toString();
   const response=await fetch(`/api/pricing/free-periods?${query}`,{cache:'no-store',signal:controller.signal});if(!current())return;
   if(response.status===401){setGate('signed-out');return;}if(response.status===403){setGate('denied');return;}
   const payload=await response.json();if(!current())return;if(!response.ok)throw Error(payload.error||'免租到期查询失败，请重试');
   if(!Array.isArray(payload.rows)||!payload.summary)throw Error('免租查询返回资料不完整，请重试');
   setData(payload);
  }catch(problem){if(current()&&!controller.signal.aborted)setQueryError(problem instanceof Error?problem.message:'免租到期查询失败，请重试');}
  finally{if(current())setQueryLoading(false);}})();
  return()=>{active=false;controller.abort();};
 },[gate,customer,reload]);
 const chooseCustomer=(value:string)=>{requestSequence.current++;setCustomer(value);setData(null);setQueryError('');setQueryLoading(Boolean(value));setQ('');setStatus('all');setPage(1);};
 const refresh=()=>{if(customer){setData(null);setQueryError('');setQueryLoading(true);setReload(n=>n+1);}else{setGate('loading');setError('');setDirectoryReload(n=>n+1);}};
 // Native navigation follows the existing pricing page convention.
 // eslint-disable-next-line @next/next/no-html-link-for-pages
 const back=<a href="/?pricing=1">← 返回计价</a>;
 if(gate!=='ready')return <main className="storage-free-periods"><section className="sfp-gate" aria-live="polite"><h1>{gate==='loading'?'正在读取客户目录…':gate==='signed-out'?'请先登录':gate==='denied'?'无权访问免租到期查询':'免租到期查询失败'}</h1><p>{gate==='error'?error:gate==='signed-out'?'请返回库位图登录老板账号。':gate==='denied'?'此页面仅老板可访问。':'正在检查计价权限。'}</p>{gate==='error'&&<button type="button" onClick={refresh}>重试</button>}{back}</section></main>;
 const needle=q.trim().toLocaleLowerCase(),matched=(data?.rows??[]).filter(row=>!needle||[row.customerName||'未认领',row.productName,row.sku,row.locationCode,row.inboundDate].some(value=>String(value).toLocaleLowerCase().includes(needle)));
 const visible=matched.filter(row=>status==='all'||row.status===status),pageCount=Math.max(1,Math.ceil(visible.length/pageSize)),currentPage=Math.min(page,pageCount),rows=visible.slice((currentPage-1)*pageSize,currentPage*pageSize);
 const counts={expired:matched.filter(r=>r.status==='expired').length,near:matched.filter(r=>r.status==='near').length,review:matched.filter(r=>r.status==='review').length};
 const selectStatus=(value:typeof status)=>{setStatus(value);setPage(1);};
 return <main className="storage-free-periods"><header className="sfp-header"><div><span className="sfp-eyebrow">仓储计价 · 货物查询</span><h1>免租到期查询</h1>{data&&<p>纽约日期 {data.asOf} · 提前 {data.nearDays} 天显示临近到期</p>}</div><nav>{back}<button type="button" onClick={refresh} disabled={queryLoading}>刷新资料</button></nav></header>
 <section className="sfp-filters" aria-label="查询筛选"><label>客户<select aria-label="客户" value={customer} onChange={event=>chooseCustomer(event.target.value)}><option value="">请先选择客户</option>{customers.map(name=><option key={name} value={name}>{name}</option>)}<option value="__unclaimed__">未认领（{unclaimedCount} 条）</option></select></label>{customer&&<><label className="sfp-search">搜索货物<input type="search" aria-label="搜索货物" placeholder="产品、SKU或库位" value={q} onChange={event=>{setQ(event.target.value);setPage(1);}}/></label><label>到期状态<select aria-label="到期状态" value={status} onChange={event=>selectStatus(event.target.value as typeof status)}><option value="all">全部货物</option><option value="expired">已到期</option><option value="near">{data?.nearDays??7} 天内到期</option><option value="review">待核对</option><option value="free">免租中</option></select></label><button type="button" onClick={()=>chooseCustomer('')}>清除筛选</button></>}</section>
 {!customer?<section className="sfp-empty">请先选择客户，再查询该客户的免租到期资料。</section>:<>
 <p className="sfp-explanation">{data?.arrivalPolicy==='batch'?'各到仓批次按自己的入库日独立计算免租；同层旧货已到期，新货仍可免租。托数沿用当前记录及自动分配结果。':'同客户同层按最早仍在库批次的入库日起算免租；旧批次清空后切换到下一批次。实际入库日保留各货物原始日期。'}</p>
 {queryLoading&&<p role="status">正在读取所选客户的货物…</p>}{queryError&&<div className="sfp-error" role="alert">{queryError}<button type="button" onClick={()=>{setQueryLoading(true);setQueryError('');setReload(n=>n+1);}}>重试查询</button></div>}
 {data&&<><section className="sfp-counts" aria-label="到期概览"><button type="button" className="expired" aria-pressed={status==='expired'} onClick={()=>selectStatus('expired')}>已到期 <b>{counts.expired}</b></button><button type="button" className="near" aria-pressed={status==='near'} onClick={()=>selectStatus('near')}>{data.nearDays} 天内到期 <b>{counts.near}</b></button><button type="button" className="review" aria-pressed={status==='review'} onClick={()=>selectStatus('review')}>待核对 <b>{counts.review}</b></button></section>
 <div className="sfp-result-note" aria-live="polite">共 {visible.length} 条货物记录</div>
 {!visible.length?<section className="sfp-empty">{data.rows.length?'没有符合条件的货物，请调整筛选。':'暂无在库货物。'}</section>:<><div className="sfp-table-scroll" role="region" aria-label="免租到期货物明细" tabIndex={0}><table className="sfp-table"><thead><tr><th>库位 / 层</th><th>产品 / SKU</th><th>托数</th><th>实际入库日</th><th>{data.arrivalPolicy==='batch'?'批次免租起算日':'层计费起算入库日'}</th><th>免租天数</th><th>最后免租日</th><th>开始计费日</th><th>到期状态 / 剩余</th>{customer==='__unclaimed__'&&<th>客户认领</th>}</tr></thead><tbody>{rows.map(row=><tr key={row.id}><td>{row.locationCode||'待补充'} / 第 {row.layer} 层{(row.billingLocationCode&&row.billingLocationCode!==row.locationCode||row.billingLayer!==undefined&&row.billingLayer!==row.layer)&&<small className="sfp-billing-source">按 {row.billingLocationCode||row.locationCode} 第{row.billingLayer??row.layer}层计价</small>}</td><td className="sfp-product"><span>{row.productName||'产品名称待补充'}</span><span className="sfp-sku">SKU：{row.sku||'无'}</span><small>{row.kind==='carton'?'箱库存':'产品库存'}</small></td><td>{typeof row.palletCount==='number'?`${palletLabel(row.palletCount)} 托`:'待核对'}{row.estimatedPallets&&<small>估算</small>}</td><td>{row.inboundDate||'待补充'}</td><td>{row.billingInboundDate||'待核对'}</td><td>{row.freeDays===null?'待核对':row.freeDays===0?'无免租期':`${row.freeDays} 天`}</td><td>{row.freeDays===0?'无免租期':row.freeUntilDate||'待核对'}</td><td>{row.chargeStartDate||'待核对'}</td><td title={row.reviewReasons.map(reason=>reasonLabel[reason]||'货物资料待核对').join('；')}><span className={`sfp-status ${row.status}`}>{statusLabel[row.status]}</span> {remainingLabel(row)}</td>{customer==='__unclaimed__'&&<td><UnclaimedCustomerPicker recordId={row.id} customers={customers} onSaved={()=>{setData(null);setQueryLoading(true);setUnclaimedCount(n=>Math.max(0,n-1));setReload(n=>n+1);}}/></td>}</tr>)}</tbody></table></div><nav className="sfp-pagination" aria-label="明细分页"><label>每页<select aria-label="每页条数" value={pageSize} onChange={event=>{setPageSize(Number(event.target.value));setPage(1);}}><option value={25}>25 条</option><option value={50}>50 条</option></select></label><span>第 {currentPage} / {pageCount} 页</span><button type="button" disabled={currentPage===1} onClick={()=>setPage(n=>Math.max(1,n-1))}>上一页</button><button type="button" disabled={currentPage===pageCount} onClick={()=>setPage(n=>n+1)}>下一页</button></nav></>}
 </>}
 </>}
 </main>;
}
