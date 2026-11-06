import {requireUser} from '../../../../lib/auth';
import {GoodsFlowError} from '../../../../lib/goods-flow';
import {isLayerStoragePricing} from '../../../../lib/storage-pricing-basis';
import {outboundBillingDetailsContext,previewOutboundBillingDetails,saveOutboundBillingDetails} from '../../../../lib/outbound-billing-details-store';
const headers={'cache-control':'private, no-store'};
async function handle(request:Request,method:'GET'|'POST'|'PUT'){
 const auth=await requireUser(request,'pricing.manage');if(auth.error)return auth.error;
 try{
  if(!await isLayerStoragePricing())throw new GoodsFlowError('请在托层计价下修改历史计费资料',409);
  let result;
  if(method==='GET'){const params=new URL(request.url).searchParams;if([...params.keys()].some(k=>k!=='key')||params.getAll('key').length!==1)throw new GoodsFlowError('请选择一条历史出货记录',400);result=await outboundBillingDetailsContext(params.get('key')??'');}
  else{const body=await request.json();if(!body||typeof body!=='object'||Array.isArray(body))throw new GoodsFlowError('提交格式无效',400);result=method==='POST'?await previewOutboundBillingDetails(body,auth.user!):await saveOutboundBillingDetails(body,auth.user!);}
  return Response.json(result,{headers});
 }catch(e){return Response.json({error:e instanceof GoodsFlowError?e.message:'记录或计费资料已有变化，请刷新后重新预览'},{status:e instanceof GoodsFlowError?e.status:409,headers});}
}
export async function GET(r:Request){return handle(r,'GET');}
export async function POST(r:Request){return handle(r,'POST');}
export async function PUT(r:Request){return handle(r,'PUT');}
