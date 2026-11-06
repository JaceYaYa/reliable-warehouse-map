import {requireUser} from '../../../../lib/auth';
import {correctCarton,cartonResponseError,cartonBody} from '../../../../lib/carton-store';
export async function POST(request:Request){const a=await requireUser(request,'stock.edit');if(a.error)return a.error;try{return Response.json(await correctCarton(cartonBody(await request.json()),a.user!));}catch(e){return cartonResponseError(e);}}
