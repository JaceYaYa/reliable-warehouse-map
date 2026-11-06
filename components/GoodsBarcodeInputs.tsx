"use client";
import {splitProductBarcodes} from '../lib/product-barcodes';
export const barcodeInputs=splitProductBarcodes;
export function GoodsBarcodeInputs({value,onChange,disabled=false}:{value:readonly string[];onChange:(value:string[])=>void;disabled?:boolean}){
 const codes=value.length?value:[''];
 return <div className="goods-barcode-inputs"><div className="goods-barcode-heading"><span>FNSKU / 产品条形码</span><button type="button" disabled={disabled||codes.length>=20} aria-label="添加条码" onClick={()=>onChange([...codes,''])}>＋</button></div>{codes.map((code,index)=><div className="goods-barcode-row" key={index}><input aria-label={`FNSKU / 产品条形码 ${index+1}`} value={code} maxLength={500} disabled={disabled} placeholder="输入或扫描条码" onChange={e=>onChange(codes.map((old,i)=>i===index?e.target.value:old))}/>{codes.length>1&&<button type="button" aria-label={`移除条码 ${index+1}`} disabled={disabled} onClick={()=>onChange(codes.filter((_,i)=>i!==index))}>×</button>}</div>)}</div>;
}
