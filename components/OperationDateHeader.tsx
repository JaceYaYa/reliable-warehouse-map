"use client";
import './OperationDateHeader.css';
export function OperationDateHeader({title,label,value,onChange,confirmed,onConfirm,onClose,disabled=false,dateLocked=false}:{title:string;label:string;value:string;onChange:(value:string)=>void;confirmed:boolean;onConfirm:()=>void;onClose:()=>void;disabled?:boolean;dateLocked?:boolean}){
 return <header className="operation-date-header"><div className="operation-date-controls"><label>{label} · 纽约时间<input type="date" value={value} disabled={disabled||dateLocked} onChange={e=>onChange(e.target.value)}/></label><button data-date-confirm type="button" disabled={disabled||!value||confirmed} onClick={onConfirm}>{confirmed?'已确认':'确认'}</button></div><h2>{title}</h2><button className="operation-close" type="button" onClick={onClose} disabled={disabled}>关闭</button></header>;
}
