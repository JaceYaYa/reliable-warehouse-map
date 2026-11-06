import type {GoodsChoice,GoodsStock} from './goods-flow';
import type {CartonReceipt} from './carton-flow';
import {cartonPlacementDetails} from './box-stock-details';
import {palletLabel} from './pallet';
/** IDs exist only in the shared allocation UI. Physical writes use the explicit receipt/key refs. */
function allocationId(identity:string){let a=2166136261,b=2246822519;for(let i=0;i<identity.length;i++){a=Math.imul(a^identity.charCodeAt(i),16777619);b=Math.imul(b^identity.charCodeAt(i),3266489917);}return (a>>>8)*16777216+(b>>>8)+4503599627370496;}
export function cartonGoodsChoices(receipts:readonly CartonReceipt[]):GoodsChoice[]{
 const result=new Map<string,GoodsChoice>(),ids=new Map<number,string>();
 for(const receipt of receipts)for(const placement of receipt.placements){
  if(placement.boxes<=0)continue;
  const details=cartonPlacementDetails(receipt,placement),key='carton:'+JSON.stringify([receipt.id,details.customerName,details.product,details.sku]),identity=JSON.stringify([receipt.id,placement.key]),id=allocationId(identity);
  if(ids.has(id)&&ids.get(id)!==identity)throw Error('箱库存分配标识冲突，请刷新后核对');ids.set(id,identity);
  const row:GoodsStock={id,version:receipt.version,locationCode:placement.locationCode,layerCount:placement.layerCount,product:details.product,sku:details.sku,customerName:details.customerName,inboundDate:details.inboundDate,inboundOrder:details.inboundOrder,productPrefix:details.productPrefix,productCondition:details.productCondition,barcode:details.barcodes.join(' / '),fnsku:'',inventoryUnit:'box',inventoryReviewDecision:'',totalQuantity:0,totalBoxes:placement.boxes,palletCount:details.palletCount,palletLabel:palletLabel(details.palletCount),inboundSource:details.inboundSource,billingMode:'box',itemVolumeM3:0,boxVolumeM3:0,storageRateUsd:0,freeDays:0,catalogItemId:null,note:[details.note,receipt.originalOrder,...(receipt.orderHistory??[]).map(h=>h.number)].filter(Boolean).join(' / '),updatedBy:String(receipt.updatedBy??''),updatedAt:receipt.updatedAt??''};
  const choice=result.get(key)??{key,source:'carton',cartonReceiptId:receipt.id,cartonVersion:receipt.version,cartonRefs:{},product:details.product,sku:details.sku,customerName:details.customerName,barcode:'',members:[],quantity:0,boxes:0,review:!details.customerName,reason:!details.customerName?'箱库存商家待认领':'箱库存实物，按所选库位箱数出库'};
  choice.members.push(row);choice.boxes+=placement.boxes;choice.cartonRefs![id]={receiptId:receipt.id,placementKey:placement.key,version:receipt.version};choice.barcode=[...new Set(choice.members.flatMap(r=>r.barcode.split(' / ')).filter(Boolean))].join(' / ');result.set(key,choice);
 }
 return [...result.values()];
}
