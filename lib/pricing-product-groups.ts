import {stockProductDetails} from './stock-product';
type Row={pricingReview?:boolean;currentProductKey?:string;currentProductName?:string;productName:string;customerName:string;sku:string;inventoryStatus?:string;settlementStatus?:string|null;quantity?:number;boxes?:number;periodFeeUsd:number;locationCode?:string};
/** Summaries never collapse original dates, modes, rates or correction segments. */
export function groupPricingProducts<T extends Row>(rows:readonly T[]){
 const groups=new Map<string,{key:string;productName:string;customerName:string;sku:string;rows:T[];feeUsd:number;pendingFeeUsd:number;pricingReviewRows:number;inStockQuantity:number;inStockBoxes:number;outboundQuantity:number;correctedQuantity:number;outboundBoxes:number;correctedBoxes:number;locations:string[]}>();
 const norm=(s:string)=>s.normalize('NFKC').trim().toLowerCase();
 for(const row of rows){const name=stockProductDetails({product:row.currentProductName||row.productName}).name,key=JSON.stringify([norm(row.customerName),row.currentProductKey?'product:'+row.currentProductKey:row.sku?'sku:'+norm(row.sku):'name:'+norm(name)]);let g=groups.get(key);if(!g){g={key,productName:name,customerName:row.customerName,sku:row.sku,rows:[],feeUsd:0,pendingFeeUsd:0,pricingReviewRows:0,inStockQuantity:0,inStockBoxes:0,outboundQuantity:0,correctedQuantity:0,outboundBoxes:0,correctedBoxes:0,locations:[]};groups.set(key,g);}g.rows.push(row);if(row.pricingReview)g.pricingReviewRows++;else if(row.settlementStatus==='pending')g.pendingFeeUsd+=row.periodFeeUsd;else if(row.settlementStatus!=='cancelled')g.feeUsd+=row.periodFeeUsd;
 if(row.inventoryStatus==='in_stock'){g.inStockQuantity+=row.quantity||0;g.inStockBoxes+=row.boxes||0;}else if(row.inventoryStatus==='corrected'){g.correctedQuantity+=row.quantity||0;g.correctedBoxes+=row.boxes||0;}else{g.outboundQuantity+=row.quantity||0;g.outboundBoxes+=row.boxes||0;}if(row.locationCode&&!g.locations.includes(row.locationCode))g.locations.push(row.locationCode);
 }
 return [...groups.values()].map(g=>({...g,feeUsd:Number(g.feeUsd.toFixed(6)),pendingFeeUsd:Number(g.pendingFeeUsd.toFixed(6))}));
}
