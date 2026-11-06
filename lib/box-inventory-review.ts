import type { GoodsStock } from './goods-flow';
import {parseStockSnapshot,snapshotFields} from './stock-transfer';
import {assertStockInventoryUnit} from './inventory-unit';
export const BOX_REVIEW_KEY='box_inventory_reviews_v1';
export type BoxDecision='confirm'|'retain';
export type BoxReview={id:string;requestId:string;fingerprint:string;stockId:number;product:string;customerName:string;locationCode:string;inboundDate:string;boxes:number;decision:BoxDecision;beforeUnit:string;beforeDecision:string;afterVersion:number;afterStock?:GoodsStock;createdBy:string;createdAt:string;revertedAt?:string;revertedBy?:string};
export type BoxReviewState={revision:number;reviews:BoxReview[];undoRequests:{requestId:string;fingerprint:string}[]};
export const emptyBoxReviews=():BoxReviewState=>({revision:0,reviews:[],undoRequests:[]});
export function parseBoxReviews(raw?:string|null):BoxReviewState{
 if(!raw)return emptyBoxReviews();const state=JSON.parse(raw) as BoxReviewState;
 if(!state||!Number.isSafeInteger(state.revision)||state.revision<0||!Array.isArray(state.reviews)||!Array.isArray(state.undoRequests)||state.reviews.some(r=>!r||!['confirm','retain'].includes(r.decision)||!Number.isSafeInteger(r.stockId)||r.stockId<1||!Number.isSafeInteger(r.afterVersion)||r.afterVersion<0||!Number.isSafeInteger(r.boxes)||r.boxes<=0||!['item','box'].includes(r.beforeUnit)||!['','confirm','retain'].includes(r.beforeDecision)||['id','requestId','fingerprint','product','customerName','locationCode','inboundDate','createdBy','createdAt'].some(k=>typeof r[k as keyof BoxReview]!=='string')||(r.revertedAt!==undefined&&typeof r.revertedAt!=='string')||(r.revertedBy!==undefined&&typeof r.revertedBy!=='string'))||state.undoRequests.some(r=>!r||typeof r.requestId!=='string'||typeof r.fingerprint!=='string')||new Set(state.reviews.map(r=>r.id)).size!==state.reviews.length||new Set([...state.reviews,...state.undoRequests].map(r=>r.requestId)).size!==state.reviews.length+state.undoRequests.length)throw new Error('箱库存核对记录格式不正确');if(state.reviews.some(r=>!validBoxReviewPostimage(r)))throw new Error('箱库存核对的库存身份快照格式不正确');return state;
}
export function validBoxReviewPostimage(review:BoxReview){
 if(review.afterStock===undefined)return true; // Old history remains readable; unsafe undo is disabled below.
 try{const row=parseStockSnapshot(JSON.stringify(review.afterStock));if(!row||Object.keys(snapshotFields(row)).some(key=>!Object.hasOwn(review.afterStock!,key)))return false;assertStockInventoryUnit(row);return row.id===review.stockId&&row.version===review.afterVersion&&row.updatedAt===review.createdAt&&Number.isFinite(Date.parse(row.updatedAt))&&row.updatedBy===review.createdBy&&row.product===review.product&&row.customerName===review.customerName&&row.locationCode===review.locationCode&&row.inboundDate===review.inboundDate&&row.totalBoxes===review.boxes&&row.totalQuantity===0&&row.inventoryUnit===(review.decision==='confirm'?'box':'item')&&row.inventoryReviewDecision===review.decision}catch{return false}
}
export const matchesBoxReviewPostimage=(row:GoodsStock,review:BoxReview)=>!!review.afterStock&&validBoxReviewPostimage(review)&&JSON.stringify(snapshotFields(row))===JSON.stringify(snapshotFields(review.afterStock));
export const pendingBoxRecord=(row:Pick<GoodsStock,'totalQuantity'|'totalBoxes'> & {inventoryUnit?:string;inventoryReviewDecision?:string})=>row.totalQuantity===0&&row.totalBoxes>0&&(row.inventoryUnit??'item')==='item'&&!row.inventoryReviewDecision;
export const boxInventoryLabel=(rows:readonly {inventoryUnit?:string}[])=>rows.every(r=>r.inventoryUnit==='box')?'已确认箱库存':rows.some(r=>r.inventoryUnit==='box')?'混合库存（件 / 箱）':'件库存';
