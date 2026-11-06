"use client";
import {useState} from "react";
import type {GoodsChoice} from "../lib/goods-flow";
import {importedGoods,parseGoodsImport,type GoodsOperationMode} from "../lib/goods-operation-input";

type Props={choices:readonly GoodsChoice[];customer:string;mode:GoodsOperationMode;existingKeys:readonly string[];disabled:boolean;onAdd:(rows:ReturnType<typeof importedGoods>)=>void};
export function GoodsBulkAdd({choices,customer,mode,existingKeys,disabled,onAdd}:Props){
  const [text,setText]=useState(""),[preview,setPreview]=useState(false),[message,setMessage]=useState(""),[customerFilter,setCustomerFilter]=useState(customer);
  const rows=preview?parseGoodsImport(text,choices,customerFilter,mode,existingKeys):[],valid=importedGoods(rows),unresolved=rows.filter(row=>row.error).length,overLimit=existingKeys.length+valid.length>25;
  return <details className="goods-bulk"><summary>粘贴多项货物</summary><div className="goods-bulk-body">
    <label>匹配范围<select aria-label="粘贴货物客户范围" value={customerFilter} disabled={disabled} onChange={e=>{setCustomerFilter(e.target.value);setPreview(false);}}><option value="">全部客户</option>{[...new Set(choices.map(c=>c.customerName).filter(Boolean))].map(name=><option key={name}>{name}</option>)}</select></label><label>从 Excel 复制三列：SKU / 条形码 / 产品名称、件数、箱数<textarea aria-label="批量添加货物" disabled={disabled} maxLength={30000} value={text} onChange={event=>{setText(event.target.value);setPreview(false);setMessage("");}} placeholder={"SKU001\t100\t5\n产品名称\t20\t0"}/></label>
    <small>每行一项，按下面的客户范围匹配；也可用「货物 | 件数 | 箱数」。同一货物多行合计，已有草稿不会被覆盖。</small>
    <button type="button" disabled={disabled||!text.trim()} onClick={()=>setPreview(true)}>检查粘贴内容</button>
    {preview&&<><div className="goods-import-preview" role="region" aria-label="粘贴内容核对">{rows.map(row=><div key={row.line} className={row.error?"goods-import-error":"goods-import-ok"}><span>第 {row.line} 行</span><b>{row.choice?`${row.choice.product} · ${row.choice.customerName}`:row.input||"未填货物"}</b><span>{Number.isSafeInteger(row.quantity)?row.quantity:"—"}件 / {Number.isSafeInteger(row.boxes)?row.boxes:"—"}箱</span><small>{row.error||"可添加"}</small></div>)}</div><div className="goods-bulk-actions"><span>{valid.length} 项可添加{unresolved?` · ${unresolved} 行需核对`:""}</span><button type="button" disabled={disabled||!valid.length||overLimit} onClick={()=>{onAdd(valid);const original=text.split(/\r?\n/);setText(rows.filter(row=>row.error).map(row=>original[row.line-1]).join("\n"));setPreview(Boolean(unresolved));setMessage(`已加入 ${valid.length} 项货物${unresolved?`，${unresolved} 行仍保留待核对`:""}，接下来选择实际库位。`);}}>添加已识别 {valid.length} 项</button></div>{overLimit&&<p className="goods-line-error">本单最多 25 项，请分单添加。</p>}</>}
    {message&&<p role="status" className="goods-help">{message}</p>}
  </div></details>;
}
