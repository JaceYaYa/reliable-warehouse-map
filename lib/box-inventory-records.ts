import type {CartonReceipt} from './carton-flow';
import {isBoxInventoryStock,type InventoryStock} from './inventory-groups';
import {cartonWarehouseSearchRecords} from './warehouse-search';
import {stockProductDetails} from './stock-product';

export type BoxInventoryReference={kind:'stock';id:number}|{kind:'carton';id:string;placementKey:string};
export type BoxInventoryRecord={
 category:'箱库存';inventoryUnit:'box';reference:BoxInventoryReference;searchKey:string;
 product:string;sku:string;barcode:string;fnsku:string;customerName:string;inboundOrder:string;inboundDate:string;
 locationCode:string;layerCount:number;totalBoxes:number;palletCount:number;productPrefix:string;productCondition?:string;note:string;searchAliases:string;
};

/** One business unit, preserving original identities for guarded writes and history. */
export function boxInventoryRecords(stocks:readonly (InventoryStock&{palletCount?:number})[],receipts:readonly CartonReceipt[]):BoxInventoryRecord[]{
 return [
  ...stocks.filter(s=>isBoxInventoryStock(s)&&s.totalBoxes>0&&Number.isSafeInteger(s.id)&&Number(s.id)>0).map(s=>({
   category:'箱库存' as const,inventoryUnit:'box' as const,reference:{kind:'stock' as const,id:s.id!},searchKey:`stock:${s.id}`,
   product:stockProductDetails(s).name,sku:s.sku||'',barcode:s.barcode||'',fnsku:s.fnsku||'',customerName:s.customerName,
   inboundOrder:s.inboundOrder||'',inboundDate:s.inboundDate,locationCode:s.locationCode,layerCount:s.layerCount||1,
   totalBoxes:s.totalBoxes,palletCount:s.palletCount??1,productPrefix:stockProductDetails(s).prefix,productCondition:stockProductDetails(s).condition,note:s.note||'',searchAliases:''
  })),
  ...cartonWarehouseSearchRecords(receipts).map(r=>({
   category:'箱库存' as const,inventoryUnit:'box' as const,reference:{kind:'carton' as const,id:r.receipt.id,placementKey:r.placementKey},searchKey:r.searchKey,
   product:r.product,sku:r.sku||'',barcode:r.barcode||'',fnsku:'',customerName:r.customerName,...(r.productCondition?{productCondition:r.productCondition}:{}),
   inboundOrder:r.inboundOrder,inboundDate:r.inboundDate,locationCode:r.locationCode,layerCount:r.layerCount,
   totalBoxes:r.totalBoxes,palletCount:r.palletCount,productPrefix:r.productPrefix,note:r.note,searchAliases:r.searchAliases
  }))
 ];
}
