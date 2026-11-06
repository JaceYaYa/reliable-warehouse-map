import {GoodsFlowError} from './goods-flow';
/** Missing unit belongs to legacy callers; provided units are never coerced. */
export function parseInventoryUnit(value:unknown):'item'|'box'|undefined{
 if(value===undefined)return undefined;
 if(typeof value!=='string'||(value!=='item'&&value!=='box'))throw new GoodsFlowError('请选择件库存或箱库存；库存单位必须是 item 或 box 字符串',400);
 return value;
}
/** Physical box inventory has no inferred piece count, including import/restore paths. */
export function assertStockInventoryUnit(row:{inventoryUnit?:unknown;totalQuantity?:unknown}){
 if(parseInventoryUnit(row.inventoryUnit)==='box'&&row.totalQuantity!==0)throw new GoodsFlowError('箱库存件数必须为 0；不能由箱数推算或恢复件数',400);
}
