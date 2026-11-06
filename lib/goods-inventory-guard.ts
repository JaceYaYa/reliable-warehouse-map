import { env } from "cloudflare:workers";
import { eq,sql } from "drizzle-orm";
import { getDb } from "../db";
import { goodsFlowState,goodsTransactionGuards } from "../db/schema";
import { GoodsFlowError,assertGoodsBalance,coalesceGoodsCategories,normalizedGoodsIdentity,type GoodsStock,type GoodsState } from "./goods-flow";
import { goodsFinish,goodsGuard,goodsStateUpdate,loadGoodsContext } from "./goods-store";
import {assertStockInventoryUnit} from './inventory-unit';
import {hasPermission,type PermissionUser} from './permissions';
export type GoodsStockChange={before:GoodsStock|null;after:GoodsStock|null};
/** Prepend guard and append afterQueries to the SAME raw D1 batch as the stock mutations. */
export async function goodsInventoryWritePlan(changes:readonly GoodsStockChange[],kind:"edit"|"outbound"|"delete"|"move"="edit",options:{preserveCostSnapshots?:boolean;user?:PermissionUser;expectedPalletSettings?:Array<{key:string;value:string;updatedAt?:string}>}={}) {
  for(const change of changes)if(change.after)assertStockInventoryUnit(change.after);
  if(kind==='edit'&&changes.length===1&&changes[0].before&&changes[0].after&&changes[0].before.sku!==changes[0].after.sku)throw new GoodsFlowError('SKU 属于产品核心资料，请通过修改产品归属选择仅此记录或所有同产品并确认');
  const context=await loadGoodsContext(),affected=context.state.categories.filter(c=>changes.some(change=>c.stockIds.includes(change.before?.id??change.after?.id??-1))),managed=new Set(context.state.categories.flatMap(c=>c.stockIds));
  const compatible=(row:GoodsStock,c:GoodsState['categories'][number])=>!c.archived&&normalizedGoodsIdentity(row).product.toLowerCase()===c.product.toLowerCase()&&row.customerName.trim()===c.customerName.trim()&&!(row.sku&&c.sku&&row.sku!==c.sku);
  for(const change of changes.filter(c=>!c.before&&c.after))if(context.state.categories.some(c=>compatible(change.after!,c)))throw new GoodsFlowError("已有这项货物的独立计价批次，请通过“货物入库”选择多个库位，旧入口不会新增同款记录");
  if(affected.length&&(kind==="outbound"||kind==="delete"))throw new GoodsFlowError("这项货物已启用独立计价批次，请使用“货物出库”；旧方式不会扣减库存");
  let state=JSON.parse(JSON.stringify(context.state)) as GoodsState;
  for(const category of affected){
    assertGoodsBalance(category,context.rows);
    const next=state.categories.find(c=>c.id===category.id)!,mine=changes.filter(change=>category.stockIds.includes(change.before?.id??change.after?.id??-1));
    if(kind==='edit'&&options.user&&!hasPermission(options.user,'product.manage')&&mine.some(change=>change.before&&change.after&&(normalizedGoodsIdentity(change.before).product!==normalizedGoodsIdentity(change.after).product||change.before.sku!==change.after.sku)))throw new GoodsFlowError('修改产品主资料需要产品资料管理权限；库存备注、标记和品相可单独修改',403);
    if(kind==="edit"&&mine.some(change=>!change.before||!change.after||change.before.totalQuantity!==change.after.totalQuantity||change.before.totalBoxes!==change.after.totalBoxes))throw new GoodsFlowError("已启用独立计价批次的件数或箱数不能作为普通校正修改，请使用“货物入库 / 货物出库”以保留计价记录");
    if(kind==="edit"&&mine.some(change=>change.before&&change.after&&normalizedGoodsIdentity(change.before).product!==normalizedGoodsIdentity(change.after).product)&&!category.stockIds.every(id=>mine.some(change=>change.before?.id===id&&change.after)))throw new GoodsFlowError("该货物已启用独立计价批次，请勾选这项货物的全部库位记录统一修改主体名称；附加标记可以单独修改");
    if(kind==="move"){
      if(affected.length!==1)throw new GoodsFlowError("不能一次移动不同货物类别的库存");
      const created=changes.filter(change=>!change.before&&change.after);
      for(const change of created){if(change.after!.id<=0||change.after!.customerName!==category.customerName)throw new GoodsFlowError("新移库记录编号或客户无效");next.stockIds.push(change.after!.id);}
      for(const change of mine.filter(change=>!change.after)){if(next.lots.some(l=>l.stockId===change.before!.id))throw new GoodsFlowError("该移库记录承担计价批次，不能删除，请刷新核对");next.stockIds=next.stockIds.filter(id=>id!==change.before!.id);}
      for(const key of ["totalQuantity","totalBoxes"] as const){const delta=changes.reduce((n,c)=>n+(c.after?.[key]??0)-(c.before?.[key]??0),0);if(delta!==0)throw new GoodsFlowError("移库必须保持件数和箱数总量不变");}
    }
    const current=next.stockIds.map(id=>changes.find(c=>c.after?.id===id)?.after??context.rows.find(r=>r.id===id)).filter(Boolean) as GoodsStock[];
    const customers=[...new Set(current.map(r=>r.customerName.trim()))];if(customers.length>1||customers[0]==="")throw new GoodsFlowError("该货物类别还有其他库位记录，请勾选这项货物的全部记录一起修改客户，避免计价归属不一致");
    if(customers.length)next.customerName=customers[0];
    const names=[...new Set(current.map(r=>normalizedGoodsIdentity(r).product))];if(names.length===1)next.product=names[0];
    for(const key of ["sku","barcode"] as const){const codes=[...new Set(current.map(r=>r[key].trim()).filter(Boolean))];if(codes.length===1)next[key]=codes[0];else if(key==="sku"&&codes.length>1&&!next.confirmed)throw new GoodsFlowError("修改后该货物出现不同 SKU，请先在库存界面核对关联");else next[key]=codes.join(" / ");}
    for(const lot of next.lots){if(options.preserveCostSnapshots)continue;const change=mine.find(c=>c.after?.id===lot.stockId);if(change?.after){const quantity=lot.snapshot.totalQuantity,boxes=lot.snapshot.totalBoxes,inboundDate=lot.snapshot.inboundDate;lot.snapshot={...change.after,totalQuantity:quantity,totalBoxes:boxes,inboundDate,customerName:next.customerName};}else lot.snapshot={...lot.snapshot,customerName:next.customerName};}
    assertGoodsBalance(next,current);
  }
  // An existing legacy row renamed into one uniquely compatible category carries its own original cost lot.
  if(kind==='edit')for(const change of changes.filter(c=>c.before&&c.after&&!managed.has(c.before.id))){const matches=state.categories.filter(c=>compatible(change.after!,c));if(matches.length===1){const target=matches[0];target.stockIds.push(change.after!.id);target.lots.push({id:crypto.randomUUID(),stockId:change.after!.id,quantity:change.after!.totalQuantity,boxes:change.after!.totalBoxes,snapshot:{...change.after!}});}}
  state=coalesceGoodsCategories(state);
  const palletSettings=options.expectedPalletSettings??context.palletMetadata.settings;
  const guardId=crypto.randomUUID(),db=getDb(),expectedRows=JSON.stringify(changes.flatMap(c=>c.before?[{id:c.before.id,version:c.before.version,updatedAt:c.before.updatedAt}]:[]));
  return {needsLedger:true,dateDisplayOnly:changes.some(c=>c.before&&c.after&&managed.has(c.before.id)&&c.before.inboundDate!==c.after.inboundDate),guard:[goodsGuard(context,guardId,{rows:changes.flatMap(c=>c.before?[c.before]:[]),expectedPalletSettings:palletSettings})],afterQueries:[goodsStateUpdate(state),goodsFinish(guardId)],
    drizzleGuard:[db.insert(goodsTransactionGuards).values({id:guardId,valid:sql<number>`CASE WHEN EXISTS(SELECT 1 FROM goods_flow_state WHERE id=1 AND revision=${context.stored.revision} AND value=${context.stored.value}) AND (SELECT COUNT(*) FROM settings WHERE key LIKE 'pallet_manual:stock:%')=${palletSettings.length} AND NOT EXISTS(SELECT 1 FROM json_each(${JSON.stringify(palletSettings)}) j LEFT JOIN settings s ON s.key=json_extract(j.value,'$.key') WHERE s.key IS NULL OR s.value IS NOT json_extract(j.value,'$.value') OR s.updated_at IS NOT json_extract(j.value,'$.updatedAt')) AND NOT EXISTS(SELECT 1 FROM json_each(${expectedRows}) j LEFT JOIN stocks s ON s.id=json_extract(j.value,'$.id') WHERE s.id IS NULL OR s.version<>json_extract(j.value,'$.version') OR s.updated_at<>json_extract(j.value,'$.updatedAt')) THEN 1 ELSE 0 END`})],
    drizzleAfterQueries:[db.update(goodsFlowState).set({value:JSON.stringify(state),revision:sql`${goodsFlowState.revision}+1`}).where(eq(goodsFlowState.id,1)),db.delete(goodsTransactionGuards).where(eq(goodsTransactionGuards.id,guardId))],
  };
}

/** For the legacy partial move route: append immediately after destination INSERT, before audit INSERT. */
export async function goodsPartialMovePlan(before:GoodsStock,destination:{locationCode:string;updatedAt:string;layerCount:number},operationId:string,expectedPalletSettings?:Array<{key:string;value:string;updatedAt?:string}>){
  const context=await loadGoodsContext(),index=context.state.categories.findIndex(c=>c.stockIds.includes(before.id)),id=`${operationId}:goods-move`;if(index<0)return {needsLedger:true,guard:[goodsGuard(context,id,{rows:[before],expectedPalletSettings})],afterQueries:[goodsFinish(id)]};
  assertGoodsBalance(context.state.categories[index],context.rows);const post=`${id}:destination`,predicate="updated_at=? AND location_code=? AND layer_count=? AND id<>?",binds=[destination.updatedAt,destination.locationCode,destination.layerCount,before.id];
  return {needsLedger:true,guard:[goodsGuard(context,id,{rows:[before]})],afterQueries:[
    env.DB.prepare(`INSERT INTO goods_transaction_guards(id,valid) VALUES (?,CASE WHEN (SELECT COUNT(*) FROM stocks WHERE ${predicate})=1 THEN 1 ELSE 0 END)`).bind(post,...binds),
    env.DB.prepare(`UPDATE goods_flow_state SET value=json_insert(?, ?, (SELECT id FROM stocks WHERE ${predicate})),revision=revision+1 WHERE id=1`).bind(context.stored.value,`$.categories[${index}].stockIds[#]`,...binds),
    goodsFinish(post),goodsFinish(id),
  ]};
}
