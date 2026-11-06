import {GoodsFlowError,assertGoodsBalance,materializeGoods,type GoodsChoice,type GoodsState,type GoodsStock,type GoodsCategory} from './goods-flow';
import {parseGoodsSku} from './goods-sku';
import {stockProductDetails} from './stock-product';
import {matchedProductParts} from './product-match';
/** Preserve legacy annotations independently of renamed product identity. */
export function identityStockFields<T extends {product:string;productPrefix?:string;productCondition?:string}>(row:T,identity:Partial<ProductIdentity>,sourceProduct?:string){if(identity.product===undefined)return {...row,...identity};const d=sourceProduct?matchedProductParts(row,sourceProduct):stockProductDetails(row);return {...row,productPrefix:d.prefix,productCondition:d.condition,...identity};}
export type ProductIdentity={product:string;customerName:string;sku:string};
export const identityText=(v:string)=>v.normalize('NFKC').trim().replace(/\s+/g,' ').toLowerCase();
export function parseProductIdentity(value:unknown):ProductIdentity{const v=value as Record<string,unknown>;if(!v||typeof v!=='object'||Array.isArray(v))throw new GoodsFlowError('请选择有效产品资料',400);for(const k of ['product','customerName'])if(typeof v[k]!=='string'||!(v[k] as string).trim()||(v[k] as string).length>500||/[\u0000-\u001f\u007f]/.test(v[k] as string))throw new GoodsFlowError('产品名称和商家不能为空，且不能超过500字或包含控制字符',400);return{product:stockProductDetails({product:(v.product as string).trim()}).name,customerName:(v.customerName as string).trim(),sku:parseGoodsSku(v.sku)}}
export function identityCandidates(choices:readonly GoodsChoice[],identity:ProductIdentity,excludeKey:string){return choices.filter(c=>c.key!==excludeKey&&identityText(c.customerName)===identityText(identity.customerName)&&(identity.sku?identityText(c.sku)===identityText(identity.sku):identityText(c.product)===identityText(identity.product)));}
export function validateIdentityMembers(choice:GoodsChoice,value:unknown){const refs=value as {id:number;version:number}[];if(!Array.isArray(refs)||refs.length!==choice.members.length||new Set(refs.map(r=>r?.id)).size!==refs.length||choice.members.some(r=>!refs.some(x=>x?.id===r.id&&x.version===r.version)))throw new GoodsFlowError('产品或库位资料已变化，请刷新后重新选择');}
export function identityNormalizationNeeded(rows:readonly GoodsStock[],source:GoodsChoice,identity:ProductIdentity,stockId:number,scope:'one'|'all'){
 return rows.filter(r=>source.members.some(m=>m.id===r.id)&&(scope==='all'||r.id===stockId)).some(r=>{const next=identityStockFields(r,identity,source.product);return next.product!==r.product||next.productPrefix!==r.productPrefix||next.productCondition!==r.productCondition||next.customerName!==r.customerName||next.sku!==r.sku;});
}
export function planProductIdentity(state:GoodsState,rows:readonly GoodsStock[],source:GoodsChoice,target:GoodsChoice|undefined,identity:ProductIdentity,stockId:number,scope:'one'|'all',stamp:string,userName:string,options:{merchantOnly?:boolean;classificationOnly?:boolean;normalizeOnly?:boolean}={}){
 const next=structuredClone(state),rowIdentity=options.classificationOnly?{}:options.merchantOnly?{customerName:identity.customerName}:identity;
 if(options.normalizeOnly){
  let category=next.categories.find(c=>c.id===source.categoryId);if(!category){category=materializeGoods(source,stamp);next.categories.push(category);}assertGoodsBalance(category,rows);
  const selected=new Set(scope==='all'?source.members.map(r=>r.id):[stockId]),beforeRows=rows.filter(r=>selected.has(r.id)&&identityNormalizationNeeded([r],source,identity,r.id,'one'));
  if(!beforeRows.length)throw new GoodsFlowError('产品资料没有变化，无需保存',400);
  const afterRows=beforeRows.map(r=>({...identityStockFields(r,identity,source.product),updatedAt:stamp,updatedBy:userName,version:r.version+1}));
  const changed=new Set(beforeRows.map(r=>r.id));for(const lot of category.lots)if(changed.has(lot.stockId))lot.snapshot=identityStockFields(lot.snapshot,identity,source.product);
  const currentRows=rows.map(r=>afterRows.find(a=>a.id===r.id)??r);for(const c of next.categories)assertGoodsBalance(c,currentRows);
  return{state:next,beforeRows,afterRows,categoryId:category.id};
 }
 if(!source.categoryId&&!source.customerName.trim()){
  const ids=scope==='all'?source.members.map(r=>r.id):[stockId],beforeRows=ids.map(id=>rows.find(r=>r.id===id)!),afterRows=beforeRows.map(r=>({...identityStockFields(r,rowIdentity,source.product),...(options.classificationOnly?{}:{catalogItemId:null}),updatedAt:stamp,updatedBy:userName,version:r.version+1}));
  let category=target?.categoryId?next.categories.find(c=>c.id===target.categoryId):undefined;
  if(target&&!category){category=materializeGoods(target,stamp);next.categories.push(category)}
  if(!category){category={id:crypto.randomUUID(),...identity,barcode:'',stockIds:[],lots:[],createdAt:stamp,confirmed:true,productSpec:source.productSpec};next.categories.push(category)}
  category.stockIds.push(...ids);category.lots.push(...beforeRows.map(r=>({id:crypto.randomUUID(),stockId:r.id,quantity:r.totalQuantity,boxes:r.totalBoxes,snapshot:{...identityStockFields(r,rowIdentity,source.product),...(options.classificationOnly?{}:{catalogItemId:null})}})));
  const currentRows=rows.map(r=>afterRows.find(a=>a.id===r.id)??r);for(const c of next.categories)assertGoodsBalance(c,currentRows);
  return{state:next,beforeRows,afterRows,categoryId:category.id};
 }
 const materialize=(c:GoodsChoice)=>{let category=next.categories.find(x=>x.id===c.categoryId);if(!category){category=materializeGoods(c,stamp);next.categories.push(category)}assertGoodsBalance(category,rows);return category};
 const sourceCategory=materialize(source),ids=scope==='all'?source.members.map(r=>r.id):[stockId],beforeRows=ids.map(id=>rows.find(r=>r.id===id)!),afterRows=beforeRows.map(r=>({...identityStockFields(r,rowIdentity,source.product),...(options.classificationOnly?{}:{catalogItemId:null}),updatedAt:stamp,updatedBy:userName,version:r.version+1}));
 const currentRows=rows.map(r=>afterRows.find(x=>x.id===r.id)??r);
 if(scope==='all'&&!target){Object.assign(sourceCategory,identity);if(!options.classificationOnly)delete sourceCategory.identityPending;for(const lot of sourceCategory.lots)lot.snapshot={...identityStockFields(lot.snapshot,rowIdentity,source.product),...(options.classificationOnly?{}:{catalogItemId:null})};}
 else{
  const targetCategory=target?materialize(target):{id:crypto.randomUUID(),...identity,...(options.classificationOnly&&sourceCategory.identityPending?{identityPending:true as const}:{}),barcode:'',stockIds:[],lots:[],createdAt:stamp,confirmed:true,productSpec:sourceCategory.productSpec} as GoodsCategory;if(!target)next.categories.push(targetCategory);
  targetCategory.stockIds.push(...ids);sourceCategory.stockIds=sourceCategory.stockIds.filter(id=>!ids.includes(id));
  if(scope==='all'){targetCategory.lots.push(...sourceCategory.lots.map(l=>({...l,snapshot:{...identityStockFields(l.snapshot,rowIdentity,source.product),...(options.classificationOnly?{}:{catalogItemId:null})}})));sourceCategory.lots=[];}
  else{
   const selected=beforeRows[0];let q=selected.totalQuantity,b=selected.totalBoxes;const ordered=sourceCategory.lots.slice().sort((a,b)=>Number(b.stockId===stockId)-Number(a.stockId===stockId)||a.snapshot.inboundDate.localeCompare(b.snapshot.inboundDate)||a.id.localeCompare(b.id));
   for(const lot of ordered){const qty=Math.min(q,lot.quantity),boxes=Math.min(b,lot.boxes);q-=qty;b-=boxes;if(!qty&&!boxes)continue;lot.quantity-=qty;lot.boxes-=boxes;targetCategory.lots.push({id:crypto.randomUUID(),stockId,quantity:qty,boxes,snapshot:{...identityStockFields(lot.snapshot,rowIdentity,source.product),id:stockId,locationCode:selected.locationCode,totalQuantity:qty,totalBoxes:boxes,...(options.classificationOnly?{}:{catalogItemId:null})}});}
   if(q||b)throw new GoodsFlowError('所选库位数量与成本批次不一致，不能调整归属');
   sourceCategory.lots=sourceCategory.lots.filter(l=>l.quantity||l.boxes||l.stockId!==stockId);for(const lot of sourceCategory.lots)if(lot.stockId===stockId){const anchor=sourceCategory.stockIds[0];if(!anchor)throw new GoodsFlowError('剩余成本批次没有对应库位，不能调整归属');lot.stockId=anchor;lot.snapshot={...lot.snapshot,id:anchor,locationCode:rows.find(r=>r.id===anchor)!.locationCode};}
  }
  assertGoodsBalance(targetCategory,currentRows);assertGoodsBalance(sourceCategory,currentRows);
 }
 for(const c of next.categories)assertGoodsBalance(c,currentRows);
 return{state:next,beforeRows,afterRows,categoryId:sourceCategory.id};
}
