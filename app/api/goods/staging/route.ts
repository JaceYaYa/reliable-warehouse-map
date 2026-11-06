import {requireUser,requireWriteUser} from '../../../../lib/auth';
import {hasPermission} from '../../../../lib/permissions';
import {goodsResponseError,loadGoodsContext} from '../../../../lib/goods-store';
import {loadStagingTasks,publicStagingTasks,stageGoods} from '../../../../lib/goods-staging';
export async function GET(request:Request){const auth=await requireUser(request);if(auth.error)return auth.error;try{const context=await loadGoodsContext();return Response.json({revision:context.stored.revision,tasks:publicStagingTasks(await loadStagingTasks(context),hasPermission(auth.user!,'pricing.manage'))},{headers:{'cache-control':'private, no-store'}});}catch(e){return goodsResponseError(e);}}
export async function POST(request:Request){const auth=await requireWriteUser(request,'stock.move');if(auth.error)return auth.error;try{const plan=await stageGoods(await request.json(),auth.user!);return Response.json({ok:true,operationId:plan.result.operationId,staging:true,targetLocation:plan.result.targetLocation,targetLayerCount:plan.result.targetLayerCount,tasks:publicStagingTasks(plan.tasks,hasPermission(auth.user!,'pricing.manage'))});}catch(e){return goodsResponseError(e);}}
