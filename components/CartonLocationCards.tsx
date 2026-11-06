"use client";
import type {CartonReceipt} from '../lib/carton-flow';
import {StockProductName} from './ProductAnnotations';
import {palletLabel} from '../lib/pallet';
import {SelectableStockCard} from './SelectableStockCard';
import {CartonDiscardButton} from './CartonDiscardButton';
import {cartonPlacementDetails} from '../lib/box-stock-details';
export function CartonLocationCards({receipts,location,storageDays,onOpen,selectedId,selectedKey,canDelete=false,onDeleted}:{receipts:readonly CartonReceipt[];location:string;storageDays:(date:string)=>number;onOpen:(receipt:CartonReceipt,placementKey:string)=>void;selectedId?:string;selectedKey?:string;canDelete?:boolean;onDeleted?:()=>void|Promise<void>}){
 return receipts.flatMap(c=>c.placements.filter(p=>p.locationCode===location&&p.boxes>0).map(p=>{const d=cartonPlacementDetails(c,p);return <div className="stock-tab-row" key={c.id+':'+p.key}><SelectableStockCard active={selectedId===c.id&&selectedKey===p.key} onSelect={()=>onOpen(c,p.key)}><strong className="stock-tab-layer">{p.layerCount}层</strong><span className="stock-tab-product"><StockProductName stock={{product:d.product,productPrefix:d.productPrefix,productCondition:d.productCondition}}/></span><small className="stock-tab-meta">箱库存 · {d.sku&&<>SKU {d.sku} · </>}{p.boxes}箱 · {palletLabel(d.palletCount)}托盘 · 已存{storageDays(d.inboundDate)}天 · 入库 {d.inboundDate} · {d.customerName||'待认领'} · 状态：{d.inboundSource==='return'?'退货':d.inboundSource==='domestic'?'国内':'无'}{p.note?' · 备注：'+p.note:''}</small></SelectableStockCard>{canDelete&&<CartonDiscardButton receipt={c} placementKey={p.key} onDeleted={onDeleted??(()=>{})}/>}</div>;}));
}
