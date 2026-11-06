"use client";
import { useId } from "react";
import { stockProductDetails, type ProductCondition, type StockProduct } from "../lib/stock-product";
import "./product-annotations.css";

export function StockProductName({stock}:{stock:StockProduct}) {
  const {name,label}=stockProductDetails(stock);
  return <>{label&&<span className="product-attention">（{label}）</span>}{name||"未命名货物"}</>;
}
export function ProductAnnotations({prefix,condition,onChange,disabled=false}:{prefix:string;condition:string;onChange:(patch:{productPrefix?:string;productCondition?:ProductCondition})=>void;disabled?:boolean}) {
  const id=useId();
  return <div className="product-annotations">
    <fieldset className="product-condition" disabled={disabled}><legend className="annotation-legend">产品状态</legend><div>
      <label><input type="radio" name={`${id}-condition`} checked={condition==="good"} onChange={()=>onChange({productCondition:"good"})}/>正品</label>
      <label><input type="radio" name={`${id}-condition`} checked={condition==="damaged"} onChange={()=>onChange({productCondition:"damaged"})}/>残次品</label>
      {condition&&<button type="button" aria-label="清除产品状态" title="清除产品状态" onClick={()=>onChange({productCondition:""})}>×</button>}
    </div></fieldset>
    <label className="product-prefix" htmlFor={`${id}-prefix`}>附加标记<input id={`${id}-prefix`} value={prefix} maxLength={500} disabled={disabled} placeholder="例如 #11-12、左侧、编号A" onChange={e=>onChange({productPrefix:e.target.value})}/></label>
  </div>;
}
