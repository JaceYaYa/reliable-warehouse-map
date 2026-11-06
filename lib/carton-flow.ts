/** Physical receiving cartons; product is an explicit reference snapshot, never product stock. */
export type CartonPlacementDetails={product?:string;sku?:string;customerName?:string;inboundDate?:string;inboundSource?:"domestic"|"return"|"unspecified";productCondition?:""|"good"|"damaged";inboundOrder?:string;barcodes?:string[]};
export type CartonPlacement={palletCount?:number;palletManual?:boolean;palletAutomatic?:boolean;palletProjection?:import('./carton-pallets').CartonPalletProjection;details?:CartonPlacementDetails;key:string;locationCode:string;layerCount:number;boxes:number;marker:string;note?:string;product?:{key:string;name:string;sku:string;customerName:string}};
export const cartonPalletCount=(placement:Pick<CartonPlacement,'boxes'|'palletCount'>)=>placement.palletCount??(placement.boxes>0?1:0);
export const cartonPalletTotal=(placements:readonly CartonPlacement[])=>placements.reduce((sum,p)=>sum+cartonPalletCount(p),0);
export type CartonOrderHistory={number:string;changedAt:string;changedBy:number};
export type CartonReceipt={id:string;inboundOrder:string;originalOrder:string;orderHistory:CartonOrderHistory[];customerName:string;inboundDate:string;placements:CartonPlacement[];note:string;version:number;createdBy:number;createdAt:string;updatedBy:number;updatedAt:string;totalBoxes:number;status:'pending'|'claimed';pricingStatus:'pending'};
export const cartonTotal=(placements:readonly CartonPlacement[])=>placements.reduce((sum,p)=>sum+p.boxes,0);
