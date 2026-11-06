import {requireUser} from '../../../../lib/auth';
import {withJsonErrors} from '../../../../lib/api-json';
import {isLayerStoragePricing} from '../../../../lib/storage-pricing-basis';
export async function GET(request:Request){
 return withJsonErrors(async()=>{
  const auth=await requireUser(request,'pricing.manage');
  if(auth.error)return auth.error;
  const basis=await isLayerStoragePricing()?'layer':'legacy';
  return Response.json({basis},{headers:{'cache-control':'private, no-store'}});
 },'暂时无法读取计价方式，请重试');
}
