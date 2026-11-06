"use client";
import {warehouseTimestamp} from '../../lib/warehouse-time';
import {useState} from 'react';
import {RecordFilters} from '../RecordFilters';
import {emptyRecordFilters,matchesRecordDate} from '../../lib/record-filters';
type Event={id:string;action:string;userName:string;summary?:string;createdAt:string};
const actionNames:Record<string,string>={create:'创建工单',edit:'编辑草稿',dispatch:'下达',start:'开始执行',complete:'员工确认完成',cancel:'取消',reopen:'重新打开'};
const actionName=(action:string)=>actionNames[action]||action;
export function WorkorderHistory({events}:{events:readonly Event[]}){
 const [filters,setFilters]=useState(emptyRecordFilters),[applied,setApplied]=useState(emptyRecordFilters);
 const visible=events.filter(event=>(!applied.action||actionName(event.action)===applied.action)&&(!applied.operator||event.userName===applied.operator)&&matchesRecordDate(event.createdAt,applied)&&(!applied.q||`${event.action} ${event.userName} ${event.summary||''}`.toLocaleLowerCase().includes(applied.q.trim().toLocaleLowerCase())));
 const invalid=!!(applied.from&&applied.to&&applied.from>applied.to);
 return <section className="wo-events" aria-label="工单历史"><h3>工单历史</h3><details className="wo-history-filters"><summary>筛选工单历史 · {visible.length} / {events.length} 条</summary><RecordFilters value={filters} onChange={setFilters} onApply={()=>setApplied({...filters})} onReset={()=>{setFilters(emptyRecordFilters());setApplied(emptyRecordFilters());}} actions={[...new Set(events.map(event=>actionName(event.action)))]} operators={[...new Set(events.map(event=>event.userName))]} location={false} customer={false} searchLabel="搜索工单历史"/><small className="wo-muted">按操作发生日期筛选（美东纽约时间）。</small></details>{invalid?<p role="alert">开始日期不能晚于结束日期。</p>:visible.length?visible.map(event=><div className="wo-event" key={event.id}><time>{warehouseTimestamp(event.createdAt)}</time><b>{event.userName}</b><strong title={event.action}>{actionName(event.action)}</strong>{event.summary&&<span>{event.summary}</span>}</div>):<p>没有符合条件的工单历史，原记录仍保留。</p>}</section>;
}
