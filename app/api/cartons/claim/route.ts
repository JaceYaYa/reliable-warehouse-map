import {requireUser} from '../../../../lib/auth';
import {claimCarton,cartonResponseError,cartonBody} from '../../../../lib/carton-store';
export async function POST(request:Request){const a=await requireUser(request,'stock.edit');if(a.error)return a.error;try{return Response.json(await claimCarton(cartonBody(await request.json()),a.user!));}catch(e){return cartonResponseError(e);}}

