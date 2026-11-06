import {prepareCartonDocumentOutbound} from '../../../../lib/carton-store';
import {redactWarehousePricing} from '../../../../lib/permissions';
import {warehouseTodayDate} from '../../../../lib/warehouse-time';
import {env} from "cloudflare:workers";
import {requireUser,requireWriteUser} from "../../../../lib/auth";
import {GoodsFlowError,goodsInteger,type GoodsStock} from "../../../../lib/goods-flow";
import {goodsIdempotency,loadGoodsContext,goodsGuard,goodsStateUpdate,goodsOperation,goodsFinish,goodsResponseError} from "../../../../lib/goods-store";
import {parseInventoryUnit} from "../../../../lib/inventory-unit";
import {prepareGoodsInbound} from "../../../../lib/goods-inbound-plan";
import {goodsOutboundDate,prepareGoodsOutbound} from "../../../../lib/goods-outbound-plan";

/** Validate all product lines first, then commit the whole document in one D1 transaction. */
export async function POST(request:Request){
 try{
  const session=await requireUser(request);if(session.error)return session.error;
  const body=await request.json() as Record<string,unknown>;
  if(body.mode!=="inbound"&&body.mode!=="outbound")throw new GoodsFlowError("请选择入库或出库",400);
  const auth=await requireWriteUser(request,body.mode==="inbound"?"stock.inbound":"stock.outbound");if(auth.error)return auth.error;
  const idem=await goodsIdempotency(body.requestId,body);if(idem.replayed){for(const id of idem.replayed.operationIds??[]){const old=await env.DB.prepare("SELECT restored_at FROM carton_operations WHERE id=? UNION ALL SELECT restored_at FROM goods_operations WHERE id=?").bind(id,id).all<{restored_at:string|null}>();if(old.results.some((row:{restored_at:string|null})=>row.restored_at))throw new GoodsFlowError('本单包含已撤销的出库操作，请重新填写',409);}return Response.json(redactWarehousePricing(idem.replayed,auth.user!));}
  if(!Array.isArray(body.lines)||!body.lines.length||body.lines.length>25)throw new GoodsFlowError("每张单请添加 1 至 25 项货物",400);
  if(body.customerName!==undefined&&typeof body.customerName!=="string")throw new GoodsFlowError("客户格式不正确",400);
  // Older callers explicitly select one customer; new documents derive ownership per product.
  const legacyCustomer=typeof body.customerName==='string'?body.customerName.trim():'';
  const original=await loadGoodsContext();let context={...original,state:JSON.parse(JSON.stringify(original.state)) as typeof original.state,rows:[...original.rows]};
  if(body.expectedRevision!==context.stored.revision)throw new GoodsFlowError("货物列表已变化，请刷新核对；填写仍保留");
  const keys=new Set<string>(),lineIds=new Set<string>(),stockOwners=new Map<number,string>(),guardRows:GoodsStock[]=[],stamp=new Date().toISOString(),documentNumber=`${body.mode==='inbound'?'IN':'OUT'}-${warehouseTodayDate(new Date(stamp)).replaceAll('-','')}-${idem.id.slice(0,8).toUpperCase()}`;
  const queries=[],results=[],operationIds=[],customerNames:string[]=[];let placementCount=0;
  const cartonSimulated=new Map<string,Awaited<ReturnType<typeof prepareCartonDocumentOutbound>>['after']>(),cartonInitialVersions=new Map<string,number>();
  const shared=body.receipt as Record<string,unknown>|undefined;
  const outboundDate=body.mode==='outbound'?goodsOutboundDate(body.outboundDate):undefined;
  if(body.mode==='inbound'&&(!shared||typeof shared!=='object'))throw new GoodsFlowError("请填写入库单资料",400);
  for(const [index,raw] of body.lines.entries()){
   if(!raw||typeof raw!=='object')throw new GoodsFlowError("货物行格式不正确",400);
   const line=raw as Record<string,unknown>;
   if(line.kind==='carton'){
    if(body.mode!=='outbound')throw new GoodsFlowError('箱库存仅可在此办理出库',400);
    if(line.lineId!==undefined){if(typeof line.lineId!=='string'||!line.lineId.trim()||line.lineId.length>120||lineIds.has(line.lineId))throw new GoodsFlowError('货物行编号无效或重复',400);lineIds.add(line.lineId);}
    const id=String(line.receiptId??''),version=goodsInteger(line.expectedVersion,'箱库存资料版本');
    if(cartonInitialVersions.has(id)&&cartonInitialVersions.get(id)!==version)throw new GoodsFlowError('同一箱库存版本不一致，请刷新',409);
    const plan=await prepareCartonDocumentOutbound({...line,requestId:crypto.randomUUID(),outboundDate},auth.user!,cartonSimulated.get(id),cartonSimulated);
    cartonInitialVersions.set(id,version);cartonSimulated.set(id,plan.after);
    const customer=String(line.customerName??plan.after?.customerName??'');if(legacyCustomer&&customer!==legacyCustomer)throw new GoodsFlowError('箱库存客户与所选客户不一致',400);
    if(!customerNames.includes(customer))customerNames.push(customer);queries.push(...plan.queries);results.push(plan.result);operationIds.push(plan.result.operationId);continue;
   }
   if(line.kind!==undefined&&line.kind!=='product')throw new GoodsFlowError('货物种类无效',400);
   const choice=original.choices.find(c=>c.key===line.key);
   if(!choice||(body.mode==='inbound'&&keys.has(choice.key)))throw new GoodsFlowError("货物不存在或在本单中重复，请刷新核对",400);keys.add(choice.key);
   if(line.lineId!==undefined){if(typeof line.lineId!=='string'||!line.lineId.trim()||line.lineId.trim().length>120||lineIds.has(line.lineId.trim()))throw new GoodsFlowError("货物行编号无效或重复，请重新打开表单",400);lineIds.add(line.lineId.trim());}
   if(legacyCustomer&&choice.customerName!==legacyCustomer)throw new GoodsFlowError("一张出入库单只能包含所选客户的货物",400);
   if(line.customerName!==undefined&&(typeof line.customerName!=='string'||line.customerName.trim()!==choice.customerName))throw new GoodsFlowError(`${choice.product}：客户与所选货物不一致，请刷新核对`,400);
   if(!customerNames.includes(choice.customerName))customerNames.push(choice.customerName);
   for(const row of choice.members){const owner=stockOwners.get(row.id);if(owner!==undefined){if(body.mode!=='outbound'||owner!==choice.key)throw new GoodsFlowError("两项货物包含重复的库存记录，请先核对关联",400);}else{stockOwners.set(row.id,choice.key);guardRows.push(row);}}
   const pieceOnlyReturn=body.mode==='inbound'&&line.inventoryUnit!=='box'&&(line.receipt as Record<string,unknown>|undefined)?.inboundSource==='return';
   const quantity=goodsInteger(line.quantity,"本次总件数"),boxes=pieceOnlyReturn?0:goodsInteger(line.boxes,"本次总箱数");if(!quantity&&!boxes)throw new GoodsFlowError(`${choice.product}：请填写本次总数量`,400);
   if(body.mode==='inbound'){
    parseInventoryUnit(line.inventoryUnit);
    if(line.inventoryUnit==='box'&&(quantity!==0||boxes<=0))throw new GoodsFlowError('箱库存件数必须为 0、箱数必须大于 0',400);
    if(line.inventoryUnit==='item'&&quantity<=0)throw new GoodsFlowError('件库存件数必须大于 0',400);
    if(!Array.isArray(line.placements))throw new GoodsFlowError("请分配入库库位",400);
    placementCount+=line.placements.length;if(placementCount>100)throw new GoodsFlowError("每张入库单最多填写 100 条库位分配",400);
    const allocated=line.placements.reduce((n,p)=>{if(!p||typeof p!=='object')throw new GoodsFlowError("库位填写无效",400);return{quantity:n.quantity+goodsInteger(p.quantity,"库位入库件数"),boxes:n.boxes+(pieceOnlyReturn?0:goodsInteger(p.boxes,"库位入库箱数"))}}, {quantity:0,boxes:0});
    if(allocated.quantity!==quantity||allocated.boxes!==boxes)throw new GoodsFlowError(`${choice.product}：各库位入库合计与实收总数量不一致`,400);
   }else if(!Array.isArray(line.selected)||line.selected.some(p=>!p||p.quantity===undefined||p.boxes===undefined))throw new GoodsFlowError("请填写每个库位的出库数量",400);
   const lineReceipt=line.receipt as Record<string,unknown>|undefined;
   const payload={...line,customerName:choice.customerName,expectedRevision:body.expectedRevision,outboundDate,receipt:{...(lineReceipt||{}),inboundDate:shared?.inboundDate,inboundOrder:lineReceipt?.inboundOrder??shared?.inboundOrder,note:lineReceipt?.note??shared?.note}};
   const operation={id:`${idem.id}:${index+1}`,fingerprint:JSON.stringify(payload),documentId:idem.id,documentNumber};
   try{
    const plan=body.mode==='inbound'?await prepareGoodsInbound(context,payload,auth.user!,operation):await prepareGoodsOutbound(context,payload,auth.user!,operation,original);
    queries.push(...plan.queries);results.push(plan.result);operationIds.push(operation.id);
    const rows=[...context.rows.filter(r=>!plan.rows.some(p=>p.id===r.id)),...plan.rows];
    // Keep the original product key as a document-local alias after its first line
    // materializes a category; later lines use its remaining rows and cost lots.
    context={...context,state:plan.state,rows,choices:body.mode==='outbound'?context.choices.map(c=>c.key===choice.key?{...c,categoryId:plan.result.categoryId,members:c.members.map(r=>rows.find(p=>p.id===r.id)!),quantity:c.members.reduce((n,r)=>n+rows.find(p=>p.id===r.id)!.totalQuantity,0),boxes:c.members.reduce((n,r)=>n+rows.find(p=>p.id===r.id)!.totalBoxes,0)}:c):context.choices};
   }catch(e){if(e instanceof GoodsFlowError)throw new GoodsFlowError(`${choice.product}：${e.message}`,e.status);throw e;}
  }
  const result={ok:true,documentId:idem.id,documentNumber,mode:body.mode,...(outboundDate?{outboundDate}:{}),customerNames,...(customerNames.length===1?{customerName:customerNames[0]}:{}),operationIds,lines:results};
  await env.DB.batch([goodsGuard(original,idem.id,{rows:guardRows,association:true,...(body.mode==='inbound'?{highId:Math.max(0,...original.rows.map(r=>r.id))}:{})}),...queries,goodsStateUpdate(context.state),goodsOperation({id:idem.id,kind:"document",categoryId:"",fingerprint:idem.fingerprint,beforeCategory:null,afterCategory:[],beforeRows:[],afterRows:[],settlementIds:[],result,stamp}),goodsFinish(idem.id)]);
  return Response.json(redactWarehousePricing(result,auth.user!));
 }catch(e){return goodsResponseError(e);}
}
