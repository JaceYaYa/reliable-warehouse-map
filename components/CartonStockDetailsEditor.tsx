"use client";
import {StockDetailFields,type StockDetailFieldValue} from './StockDetailFields';
export function CartonStockDetailsEditor({value,onChange,boxes,onCorrection,disabled=false}:{value:StockDetailFieldValue;onChange:(patch:Partial<StockDetailFieldValue>)=>void;boxes:number;onCorrection:()=>void;disabled?:boolean}){
 return <><StockDetailFields value={value} onChange={onChange} quantity={`${boxes}箱`} onCorrection={onCorrection} disabled={disabled}/><p className="stock-details-help">以上资料仅修改当前库位这条箱库存，其他库位、产品资料和箱数保留。修正箱数通过独立核对操作完成。</p></>;
}
