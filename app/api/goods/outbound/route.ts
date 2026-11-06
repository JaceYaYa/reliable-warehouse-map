import {redactWarehousePricing} from '../../../../lib/permissions';
import {env} from "cloudflare:workers";
import {requireWriteUser} from "../../../../lib/auth";
import {goodsIdempotency,loadGoodsContext,goodsGuard,goodsStateUpdate,goodsFinish,goodsResponseError} from "../../../../lib/goods-store";
import {prepareGoodsOutbound} from "../../../../lib/goods-outbound-plan";
export async function POST(request:Request){const auth=await requireWriteUser(request,"stock.outbound");if(auth.error)return auth.error;try{
 const body=await request.json(),idem=await goodsIdempotency(body.requestId,body);if(idem.replayed)return Response.json(redactWarehousePricing(idem.replayed,auth.user!));
 const context=await loadGoodsContext(),plan=await prepareGoodsOutbound(context,body,auth.user!,idem);
 const choice=context.choices.find(c=>c.key===body.key)!;
 await env.DB.batch([goodsGuard(context,idem.id,{rows:choice.members,association:true}),...plan.queries,goodsStateUpdate(plan.state),goodsFinish(idem.id)]);return Response.json(redactWarehousePricing(plan.result,auth.user!));
}catch(e){return goodsResponseError(e);}}
