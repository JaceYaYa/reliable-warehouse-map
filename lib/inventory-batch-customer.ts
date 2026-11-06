import {env} from 'cloudflare:workers';
import {GoodsFlowError,goodsChoices,parseGoodsState,assertGoodsBalance,type GoodsStock} from './goods-flow';
import {goodsGuard,goodsFinish,goodsIdempotency,goodsOperation,goodsStateUpdate,loadGoodsContext} from './goods-store';
import {identityCandidates,identityText,planProductIdentity} from './goods-identity';
import {inventoryIdentity,parseAssociationState} from './inventory-associations';
export async function prepareBatchInventoryCustomer(body:Record<string,unknown>,user:{id:number;displayName:string},options:{allowDistinctSku?:boolean}={}){
 const idem=await goodsIdempotency(body.requestId,body);if(idem.replayed)return {replayed:idem.replayed};
 if(body.confirmed!==true||typeof body.customerName!=='string'||!body.customerName.trim()||body.customerName.length>200||/[\u0000-\u001f\u007f]/.test(body.customerName))throw new GoodsFlowError('请填写商家并核对批量修改范围',400);
 const refs=body.records as {id:number;expectedVersion:number}[];
 if(!Array.isArray(refs)||!refs.length||refs.length>1000||refs.some(r=>!r||!Number.isSafeInteger(r.id)||r.id<1||!Number.isSafeInteger(r.expectedVersion)||r.expectedVersion<0)||new Set(refs.map(r=>r.id)).size!==refs.length)throw new GoodsFlowError('请勾选1至1000条有效记录',400);
 const context=await loadGoodsContext(),before=refs.map(r=>context.rows.find(x=>x.id===r.id));
 if(before.some((r,i)=>!r||r.version!==refs[i].expectedVersion))throw new GoodsFlowError('勾选记录已有修改或已删除，请刷新核对；本次未保存',409);
 const selected=new Set(refs.map(r=>r.id)),customerName=body.customerName.trim(),stamp=new Date().toISOString();
 const merchantChoices=(value:ReturnType<typeof goodsChoices>)=>value.map(c=>options.allowDistinctSku&&c.reason==='同名但 SKU 不同，分别保留'?{...c,review:false,reason:''}:c);
 let state=context.state,rows=context.rows;
 const after:GoodsStock[]=[];
 const processed=new Set<number>();
 while(processed.size<selected.size){
  const stockId=[...selected].find(id=>!processed.has(id))!,freshChoices=merchantChoices(goodsChoices(rows,parseAssociationState(context.associationValue),state)),source=freshChoices.find(c=>c.members.some(r=>r.id===stockId));
  if(!source)throw new GoodsFlowError('勾选产品关联已变化，请刷新核对',409);
  const mine=source.members.filter(r=>selected.has(r.id)&&!processed.has(r.id));for(const row of mine)processed.add(row.id);
  if(source.customerName===customerName)continue;
  const pendingIdentity=state.categories.find(c=>c.id===source.categoryId)?.identityPending===true;
  if(source.review&&!pendingIdentity&&(source.categoryId||source.customerName.trim())&&!(options.allowDistinctSku&&source.reason==='同名但 SKU 不同，分别保留'))throw new GoodsFlowError(`${source.product}：${source.reason}，请先核对该产品`,409);
  const identity={product:source.product,sku:source.sku,customerName},matches=identityCandidates(freshChoices,identity,source.key);
  if(matches.length>1||matches.some(c=>c.review||identityText(c.product)!==identityText(identity.product)||identityText(c.sku)!==identityText(identity.sku)||c.members.some(r=>r.inventoryUnit==='box')!==source.members.some(r=>r.inventoryUnit==='box')))throw new GoodsFlowError(`${source.product} 在目标商家下有冲突产品，请单独核对关联；本批未保存`,409);
  const target=matches[0];
  if(mine.length===source.members.length){
   const plan=planProductIdentity(state,rows,source,target,identity,mine[0].id,'all',stamp,user.displayName,{merchantOnly:true});state=plan.state;after.push(...plan.afterRows);rows=rows.map(r=>plan.afterRows.find(x=>x.id===r.id)??r);
  }else for(const row of mine){
   const refreshed=merchantChoices(goodsChoices(rows,parseAssociationState(context.associationValue),state)),freshSource=refreshed.find(c=>c.members.some(r=>r.id===row.id))!,freshMatches=identityCandidates(refreshed,identity,freshSource.key);if(freshMatches.length>1)throw new GoodsFlowError('目标产品存在多项关联，请先核对',409);
   const plan=planProductIdentity(state,rows,freshSource,freshMatches[0],identity,row.id,'one',stamp,user.displayName,{merchantOnly:true});state=plan.state;after.push(...plan.afterRows);rows=rows.map(r=>plan.afterRows.find(x=>x.id===r.id)??r);
  }
 }
 state=parseGoodsState(JSON.stringify(state));for(const c of state.categories)assertGoodsBalance(c,rows);
 if(!after.length)throw new GoodsFlowError('勾选记录已经属于此商家，没有修改内容',400);
 let association=context.associationValue;
 if(association){const a=parseAssociationState(association),changed=new Set(after.map(r=>r.id));for(const link of a.associations){if(link.members.every(m=>changed.has(m.stockId))){for(const m of link.members)m.identity=inventoryIdentity(after.find(r=>r.id===m.stockId)!);link.customer=customerName;}else link.members=link.members.filter(m=>!changed.has(m.stockId));}a.associations=a.associations.filter(a=>a.members.length);a.revision++;association=JSON.stringify(a);}
 const changedBefore=after.map(r=>context.rows.find(x=>x.id===r.id)!),result={ok:true,stocks:after,stockIds:after.map(r=>r.id),customerName,count:after.length};
 const statements=([goodsGuard(context,idem.id,{rows:context.rows,association:true,highId:Math.max(0,...context.rows.map(r=>r.id))}),...after.map(r=>env.DB.prepare('UPDATE stocks SET product=?,customer_name=?,sku=?,catalog_item_id=NULL,updated_at=?,updated_by=?,version=? WHERE id=?').bind(r.product,r.customerName,r.sku,stamp,user.displayName,r.version,r.id)),...(association!==context.associationValue?[env.DB.prepare("UPDATE settings SET value=?,updated_at=? WHERE key='inventory_associations_v1'").bind(association,stamp)]:[]),goodsStateUpdate(state),goodsOperation({id:idem.id,kind:'identity',categoryId:after[0].id.toString(),fingerprint:idem.fingerprint,beforeCategory:context.state,afterCategory:state,beforeRows:changedBefore,afterRows:after,settlementIds:[],result:{...result,beforeAssociationValue:context.associationValue,afterAssociationValue:association},stamp}),env.DB.prepare('INSERT INTO audit_logs(user_id,user_name,action,entity_type,entity_id,operation_id,summary,before_snapshot,after_snapshot,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(user.id,user.displayName,'库存修改','货物',[...new Set(after.map(r=>r.locationCode))].join('、'),idem.id,`批量修改商家｜${after.length}条库位记录｜${[...new Set(changedBefore.map(r=>r.customerName||'未填写'))].join('、')} → ${customerName}｜名称、SKU、数量、条码、入库日期与原计价批次保留`,JSON.stringify({schema:'goods-operation-v1',rows:changedBefore}),JSON.stringify({schema:'goods-operation-v1',rows:after}),stamp),goodsFinish(idem.id)]);
 const coreStatements=[...after.map(r=>env.DB.prepare('UPDATE stocks SET product=?,customer_name=?,sku=?,catalog_item_id=NULL,updated_at=?,updated_by=?,version=? WHERE id=?').bind(r.product,r.customerName,r.sku,stamp,user.displayName,r.version,r.id)),...(association!==context.associationValue?[env.DB.prepare("UPDATE settings SET value=?,updated_at=? WHERE key='inventory_associations_v1'").bind(association,stamp)]:[]),goodsStateUpdate(state)];
 return {statements,coreStatements,result,beforeRows:changedBefore,afterRows:after,beforeState:context.state,afterState:state,beforeAssociationValue:context.associationValue,afterAssociationValue:association,context,stamp};
}

export async function batchInventoryCustomer(body:Record<string,unknown>,user:{id:number;displayName:string}){const p=await prepareBatchInventoryCustomer(body,user);if('replayed' in p)return p.replayed;await env.DB.batch(p.statements);return p.result;}
