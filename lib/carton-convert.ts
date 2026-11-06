import {fixedCartonPlacement,persistedCartonRow} from './carton-pallets';
import {env} from 'cloudflare:workers';
import {GoodsFlowError,goodsInteger} from './goods-flow';
import {loadGoodsContext,goodsIdempotency,goodsGuard,goodsStateUpdate,goodsFinish} from './goods-store';
import {prepareGoodsInbound} from './goods-inbound-plan';
import {cartonMutable,cartonGuard,cartonRowById,cartonReplay,cartonUuid,cartonView} from './carton-store';
import {cartonTotal,type CartonPlacement} from './carton-flow';
import type {PermissionUser} from './permissions';
import {cartonPlacementDetails} from './box-stock-details';
export async function convertCarton(body:Record<string,unknown>,user:PermissionUser&{id:number;displayName:string}){
 const requestId=cartonUuid(body.requestId),old=await cartonReplay(requestId,'convert',body,user);if(old)return old;
 const before=await cartonMutable({...body,id:cartonUuid(body.id)});if(!before)throw new GoodsFlowError('箱库存记录不存在',404);
 if(goodsInteger(body.expectedVersion,'箱库存版本')!==before.version)throw new GoodsFlowError('箱库存已变化，请刷新后核对',409);
 if(body.inboundDate!==undefined||body.inventoryUnit!==undefined)throw new GoodsFlowError('转换必须保留原入库日期，并填写实际产品件数',400);
 const placements=JSON.parse(before.placements) as CartonPlacement[],remaining=placements.filter(p=>p.boxes>0);if(!remaining.length)throw new GoodsFlowError('此箱库存已出完或已转换',409);
 if(!Array.isArray(body.placements)||body.placements.length!==remaining.length)throw new GoodsFlowError('请填写每个剩余库位的实际产品件数',400);
 const keys=new Set<string>(),converted=body.placements.map(raw=>{if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new GoodsFlowError('库位转换资料无效',400);const p=raw as Record<string,unknown>,original=remaining.find(x=>x.key===p.key);if(!original||keys.has(String(p.key)))throw new GoodsFlowError('库位重复或已经变化',400);keys.add(String(p.key));if(p.boxes!==undefined||p.locationCode!==undefined||p.layerCount!==undefined||p.inboundDate!==undefined||p.inboundOrder!==undefined)throw new GoodsFlowError('转换时箱数、库位、层数和原日期单号沿用原记录',400);const details=cartonPlacementDetails(cartonView(before),original);return {...p,quantity:goodsInteger(p.quantity,'实际产品件数',1),locationCode:original.locationCode,layerCount:original.layerCount,boxes:original.boxes,palletCount:details.palletCount,palletManual:true,productPrefix:original.marker,note:original.note??before.note,inboundDate:details.inboundDate,inboundOrder:details.inboundOrder,barcodes:p.barcodes??details.barcodes};});
 const idem=await goodsIdempotency(requestId,body);if(idem.replayed)throw new GoodsFlowError('该请求编号已用于其他操作',409);
 const now=new Date().toISOString(),after=persistedCartonRow({...before,placements:JSON.stringify(placements.map(p=>({...fixedCartonPlacement(p,0),boxes:0}))),version:before.version+1,updatedAt:now,updatedBy:user.id});
 const context=await loadGoodsContext(),choice=context.choices.find(c=>c.key===body.key);if(choice?.members.some(r=>r.inventoryUnit==='box'))throw new GoodsFlowError('请选择产品库存，箱库存不能作为转换目标',400);if(!choice)throw new GoodsFlowError('请搜索选择产品，或先创建产品',400);
 const plan=await prepareGoodsInbound(context,{key:body.key,expectedRevision:body.expectedRevision,members:body.members,inventoryUnit:'item',receipt:{inboundDate:before.inboundDate,inboundOrder:before.inboundOrder,inboundSource:body.inboundSource,requirePlacementDetails:true,productSpec:body.productSpec,barcodes:[]},placements:converted},user,{...idem,kind:'convert',cartonConversion:{before,after}});
 const columns=['id','inbound_order','original_order','order_history','customer_name','inbound_date','placements','note','version','created_by','created_at','updated_by','updated_at'];
 const values=[after.id,after.inboundOrder,after.originalOrder,after.orderHistory,after.customerName,after.inboundDate,after.placements,after.note,after.version,after.createdBy,after.createdAt,after.updatedBy,after.updatedAt];
 const canonical=(v:unknown):unknown=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,canonical(x)])):v;
 await env.DB.batch([cartonGuard(requestId,before),goodsGuard(context,requestId,{rows:choice.members,association:true,highId:Math.max(0,...context.rows.map(r=>r.id))}),...plan.queries,goodsStateUpdate(plan.state),env.DB.prepare(`UPDATE carton_receipts SET ${columns.slice(1).map(k=>k+'=?').join(',')} WHERE id=?`).bind(...values.slice(1),after.id),env.DB.prepare('INSERT INTO carton_operations(id,receipt_id,kind,fingerprint,before_snapshot,after_snapshot,result,user_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(requestId,before.id,'convert',JSON.stringify(canonical(body)),JSON.stringify(before),JSON.stringify(after),JSON.stringify({...plan.result,receipt:cartonView(after)}),user.id,now),goodsFinish(requestId),env.DB.prepare('DELETE FROM carton_transaction_guards WHERE id=?').bind(requestId)]);
 return plan.result;
}
