import {requireUser} from '../../../../lib/auth';
import {moveCarton,cartonResponseError,cartonBody} from '../../../../lib/carton-store';
export async function POST(request:Request){const a=await requireUser(request,'stock.move');if(a.error)return a.error;try{return Response.json(await moveCarton(cartonBody(await request.json()),a.user!));}catch(e){return cartonResponseError(e);}}
