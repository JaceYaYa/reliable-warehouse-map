import {redactWarehousePricing} from '../../../lib/permissions';
import { env } from "cloudflare:workers";
import { requireUser } from "../../../lib/auth";
import {hasPermission} from '../../../lib/permissions';
import { GoodsFlowError,matchingGoodsCategory,type GoodsCategory } from "../../../lib/goods-flow";
import { goodsAudit,goodsFinish,goodsGuard,goodsIdempotency,goodsOperation,goodsResponseError,goodsStateUpdate,loadGoodsContext } from "../../../lib/goods-store";
import { stockProductDetails } from "../../../lib/stock-product";
import {assertGoodsSkuAvailable} from '../../../lib/goods-sku';
import {emptyGoodsProductSpec,parseGoodsProductSpec} from "../../../lib/goods-product-spec";
import {parseProductBarcodes} from "../../../lib/product-barcodes";
export async function GET(request:Request){const auth=await requireUser(request);if(auth.error)return auth.error;try{const context=await loadGoodsContext();return Response.json(redactWarehousePricing({revision:context.stored.revision,choices:context.choices},auth.user!),{headers:{"cache-control":"private, no-store"}});}catch(e){return goodsResponseError(e);}}
export async function POST(request:Request){const auth=await requireUser(request);if(auth.error)return auth.error;if(!hasPermission(auth.user!,'stock.inbound')&&!hasPermission(auth.user!,'product.manage'))return Response.json({error:'当前账号没有创建产品资料的权限'},{status:403});try{
  const body=await request.json() as Record<string,unknown>,idem=await goodsIdempotency(body.requestId,body);if(idem.replayed)return Response.json(redactWarehousePricing(idem.replayed,auth.user!));
  const context=await loadGoodsContext();if(body.expectedRevision!==context.stored.revision)throw new GoodsFlowError("货物列表已更新，请刷新后重新核对");
  let barcode=String(body.barcode??"").trim();if(body.barcodes!==undefined){try{barcode=parseProductBarcodes(body.barcodes);}catch(e){throw new GoodsFlowError(e instanceof Error?e.message:"条码资料无效",400);}}
  const product=stockProductDetails({product:String(body.product??"")}).name,customerName=String(body.customerName??"").trim(),sku=String(body.sku??"").trim();
  if(!product||!customerName)throw new GoodsFlowError("请填写客户和货物名称",400);if(product.length>2000||customerName.length>500||sku.length>500||barcode.length>500)throw new GoodsFlowError("货物资料过长",400);
  const normalize=(v:string)=>v.normalize('NFKC').trim().toLowerCase().replace(/\s+/g,' ');
  if(matchingGoodsCategory(context.state,{product,customerName,sku,barcode})||context.choices.some(c=>normalize(c.customerName)===normalize(customerName)&&normalize(c.product)===normalize(product)&&!(c.sku&&sku&&normalize(c.sku)!==normalize(sku))))throw new GoodsFlowError("已经有同客户、同名称且 SKU 兼容的货物，请选择已有货物，避免重复创建；SKU 未填写或条码不同不代表另一个商品");
  assertGoodsSkuAvailable(context.rows,context.state,{product,customerName,stockIds:[]},sku);
  let productSpec;try{productSpec=body.productSpec===undefined?emptyGoodsProductSpec():parseGoodsProductSpec(body.productSpec,false);}catch(e){throw new GoodsFlowError(e instanceof Error?e.message:"产品尺寸无效",400);}
  const stamp=new Date().toISOString(),category:GoodsCategory={id:crypto.randomUUID(),product,customerName,sku,barcode,productSpec,stockIds:[],lots:[],createdAt:stamp,confirmed:false},state={categories:[...context.state.categories,category]},result={ok:true,key:`category:${category.id}`,categoryId:category.id};
  await env.DB.batch([goodsGuard(context,idem.id,{rows:context.rows,highId:Math.max(0,...context.rows.map(r=>r.id))}),goodsStateUpdate(state),goodsAudit(auth.user!,idem.id,"create",product,`${product}｜客户 ${customerName}｜创建货物类别`,[],[],stamp),goodsOperation({id:idem.id,kind:"create",categoryId:category.id,fingerprint:idem.fingerprint,beforeCategory:null,afterCategory:category,beforeRows:[],afterRows:[],settlementIds:[],result,stamp}),goodsFinish(idem.id)]);return Response.json(redactWarehousePricing(result,auth.user!));
}catch(e){return goodsResponseError(e);}}
