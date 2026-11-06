import type {CartonReceipt} from './carton-flow';
import type {GoodsChoice} from './goods-flow';
import {cartonWarehouseSearchRecords,searchWarehouseRecords,normalizeWarehouseSearch} from './warehouse-search';

export function hasExactCartonIdentifier(receipts:readonly CartonReceipt[],query:string){
 const q=normalizeWarehouseSearch(query);if(!q)return false;
 return receipts.some(r=>[r.inboundOrder,r.originalOrder,...r.orderHistory.map(h=>h.number),...r.placements.filter(p=>p.boxes>0).flatMap(p=>[p.marker,p.details?.inboundOrder,p.details?.sku??p.product?.sku,...(p.details?.barcodes??[])])].some(v=>normalizeWarehouseSearch(v)===q));
}

export function hasDirectGoodsIdentifier(choice:GoodsChoice,query:string){
 const q=normalizeWarehouseSearch(query);if(!q)return false;
 const values=[choice.product,choice.sku,choice.barcode,...choice.members.flatMap(r=>[r.product,r.sku,r.fnsku,r.barcode,r.inboundOrder,r.locationCode,r.productPrefix])];
 return values.some(v=>String(v??'').split(' / ').some(value=>normalizeWarehouseSearch(value)===q));
}

/** Keep receipt identity distinct from product stock IDs and retain all its placements. */
export function searchOutboundCartons(receipts:readonly CartonReceipt[],query:string,merchantScope=''){
 const scope=merchantScope.trim().toLocaleLowerCase();
 const scoped=scope?receipts.map(r=>{const placements=r.placements.filter(p=>(p.details?.customerName??r.customerName).toLocaleLowerCase().includes(scope));return {...r,placements,totalBoxes:placements.reduce((sum,p)=>sum+p.boxes,0)};}):receipts;
 const rows=cartonWarehouseSearchRecords(scoped);
 const matches=searchWarehouseRecords(rows,query);
 const seen=new Set<string>();
 return matches.flatMap(match=>{if(seen.has(match.receipt.id))return [];seen.add(match.receipt.id);return [match.receipt];});
}
