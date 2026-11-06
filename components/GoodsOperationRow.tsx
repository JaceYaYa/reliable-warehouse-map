"use client";
import {palletCountValue,palletLabel} from '../lib/pallet';
import {useState,type ReactNode} from 'react';
import type {GoodsChoice} from '../lib/goods-flow';
import {goodsStockLabel,type GoodsLineInput,type GoodsReceipt} from '../lib/goods-operation-draft';
import {GoodsNumberInput} from './GoodsNumberInput';
import {GoodsAllocationDialog} from './GoodsAllocationDialog';

type Props={line:GoodsLineInput&{choice:GoodsChoice};mode:'inbound'|'outbound';index:number;disabled:boolean;children:ReactNode;allocation:ReactNode;error:string;onCount:(field:'quantity'|'boxes',value:string)=>void;onUnit:(value:'item'|'box')=>void;onReceipt:(patch:Partial<GoodsReceipt>)=>void;onRemove:()=>void;onCompleteAllocation?:()=>string;onClearAllocation?:()=>void;onDuplicate?:()=>void;onCopy?:()=>void;onOrderChange?:(value:string)=>void};
export function GoodsOperationRow({line:l,mode,index,disabled,children,allocation,error,onCount,onUnit,onReceipt,onRemove,onCompleteAllocation,onClearAllocation,onDuplicate,onCopy,onOrderChange}:Props){
 const [expanded,setExpanded]=useState(false),[allocationOpen,setAllocationOpen]=useState(false),inbound=mode==='inbound',box=inbound?l.inventoryUnit==='box':l.choice.members.length>0&&l.choice.members.every(r=>r.inventoryUnit==='box');
 const taskMembers=l.allowedStockIds?l.choice.members.filter(row=>l.allowedStockIds!.includes(row.id)):l.choice.members;
 const pieceOnlyReturn=inbound&&!box&&l.receipt.inboundSource==='return';
 const slots=inbound?l.placements.filter(p=>p.locationCode).map(p=>`${p.locationCode} · 第 ${p.layerCount||1} 层`):Object.entries(l.picks).filter(([,p])=>Number(p.quantity)>0||Number(p.boxes)>0).map(([id])=>{const row=l.choice.members.find(r=>String(r.id)===id);return row?goodsStockLabel(row):'库位资料待核对';});
 const summary=slots.length===0?'待选择':slots.length===1?slots[0]:`${slots.length} 处分配 · ${[...new Set(slots.map(s=>s.split(' · ')[0]))].join('、')}`;
 const quantity=(field:'quantity'|'boxes',label:string)=><label>{label}<GoodsNumberInput min="0" step="1" value={l[field]} onChange={e=>onCount(field,e.target.value)}/></label>;
 return <fieldset className={`goods-line goods-row goods-row-${mode}${box?' goods-row-box':''}`} data-goods-line={l.lineId??l.choice.key} disabled={disabled}>
 <div className="goods-row-main">
 <div className="goods-row-product"><b>{index+1} · {l.choice.product}</b><small>{l.choice.customerName}</small>{l.stagingTaskId&&<small className="goods-staged-tag">待出库任务</small>}<small>{l.stagingTaskId?'本任务 ':'在库 '}{l.stagingTaskId?(box?taskMembers.reduce((sum,row)=>sum+row.totalBoxes,0)+'箱':taskMembers.reduce((sum,row)=>sum+row.totalQuantity,0)+'件 / '+taskMembers.reduce((sum,row)=>sum+row.totalBoxes,0)+'箱'):(box?l.choice.boxes+'箱':l.choice.quantity+'件 / '+l.choice.boxes+'箱')} · {palletLabel(taskMembers.reduce((sum,r)=>sum+palletCountValue(r.palletCount,1),0))}托盘</small>{!inbound&&<label className="goods-outbound-order">出库单号（选填）<input aria-label={`第${index+1}单出库单号`} maxLength={200} value={l.outboundOrder??''} onChange={e=>onOrderChange?.(e.target.value)}/></label>}</div>
 {inbound&&<label>库存单位<select aria-label="入库库存单位" value={l.inventoryUnit} onChange={e=>onUnit(e.target.value as 'item'|'box')}><option value="item">件</option><option value="box">箱</option></select></label>}
 {!box&&quantity('quantity',inbound?'实收件数':'计划出库件数')}{!pieceOnlyReturn&&quantity('boxes',inbound?(box?'实收箱数':'包装箱数（选填）'):'计划出库箱数')}
 {inbound&&<label className={!l.receipt.inboundSource?'goods-source-missing':undefined}>来源<select aria-label="入库来源" aria-invalid={!l.receipt.inboundSource} value={l.receipt.inboundSource} onChange={e=>onReceipt({inboundSource:e.target.value})}><option value="">待选择</option><option value="return">退货</option><option value="domestic">国内</option><option value="unspecified">无</option></select></label>}
 <div className="goods-row-location-group"><div className="goods-location-display"><span className="goods-field-caption">库位</span><span aria-label={inbound?'已选入库库位':'已选出库库位'} className="goods-location-summary" title={slots.join('；')||'点击 ＋ 分配库位'}>{summary}</span><small className="goods-pallet-summary">{inbound?`入库 ${palletLabel(l.placements.reduce((sum,p)=>sum+palletCountValue(p.palletCount,1),0))} 托盘`:`在库 ${palletLabel(taskMembers.reduce((sum,r)=>sum+r.palletCount,0))} 托盘 · 出库托盘在分配内填写`}</small></div><button type="button" className="goods-allocation-plus" aria-label={'分配'+(inbound?'入库':'出库')+'库位 '+l.choice.product} onClick={()=>setAllocationOpen(true)}>＋</button></div>
 <div className="goods-row-actions">{inbound?<button type="button" aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}>{expanded?'收起':'展开'}</button>:<>{!l.stagingTaskId&&<button type="button" onClick={onDuplicate}>再加一单</button>}<button type="button" onClick={onCopy}>复制取货消息</button></>}<button type="button" className="goods-row-remove" aria-label={'移除此项货物 '+l.choice.product} onClick={onRemove}>移除</button></div>
 </div>{inbound&&<div className="goods-row-extra" hidden={!expanded}>{children}</div>}{error&&<p className="goods-line-error">{error}</p>}
 <GoodsAllocationDialog open={allocationOpen} mode={mode} product={l.choice.product} customer={l.choice.customerName} disabled={disabled} onClose={()=>setAllocationOpen(false)} onComplete={onCompleteAllocation} onClear={onClearAllocation}>{allocation}</GoodsAllocationDialog>
 </fieldset>;
}
