import {requireUser} from '../../../../../lib/auth';
import {GoodsFlowError} from '../../../../../lib/goods-flow';
import {readLayerPricingSettings,saveLayerPricingSettings} from '../../../../../lib/layer-storage-store';

const headers={'cache-control':'no-store'};
async function handle(request:Request,save:boolean){
 try{
  const auth=await requireUser(request,'pricing.manage');
  if(auth.error){auth.error.headers.set('cache-control','no-store');return auth.error;}
  const result=save?await saveLayerPricingSettings(auth.user!,await request.json()):await readLayerPricingSettings();
  return Response.json(result,{headers});
 }catch(error){
  const conflict=/CHECK constraint failed:.*goods|CHECK constraint failed: valid/i.test(String(error));
  const status=conflict?409:error instanceof GoodsFlowError?error.status:400;
  const message=error&&typeof error==='object'&&'message' in error?String(error.message):'托层设置数据无效，请刷新后核对';
  return Response.json({error:conflict?'托层配置、地图或库位名称刚有变化，本次未保存；请刷新后核对':message},{status,headers});
 }
}
export async function GET(request:Request){return handle(request,false);}
export async function PATCH(request:Request){return handle(request,true);}
