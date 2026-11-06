import {requireUser} from '../../../../lib/auth';
import {outboundCarton,cartonResponseError,cartonBody} from '../../../../lib/carton-store';
export async function POST(request:Request){const a=await requireUser(request,'stock.outbound');if(a.error)return a.error;try{return Response.json(await outboundCarton(cartonBody(await request.json()),a.user!));}catch(e){return cartonResponseError(e);}}

