import type {CartonReceipt,CartonPlacement} from './carton-flow';
import {cartonPalletCount} from './carton-flow';
/** Placement overrides describe only this box record, never its linked product master. */
export function cartonPlacementDetails(receipt:CartonReceipt,placement:CartonPlacement){
 const d=placement.details;
 return {palletCount:cartonPalletCount(placement),product:d?.product??placement.product?.name??receipt.inboundOrder,sku:d?.sku??placement.product?.sku??'',customerName:d?.customerName??receipt.customerName,inboundDate:d?.inboundDate??receipt.inboundDate,inboundSource:d?.inboundSource??'unspecified',layerCount:placement.layerCount,productCondition:d?.productCondition??'',productPrefix:placement.marker,inboundOrder:d?.inboundOrder??receipt.inboundOrder,barcodes:[...(d?.barcodes??[])],note:placement.note??receipt.note};
}
