import {requireUser} from '../../../../lib/auth';
import {restoreCarton,cartonResponseError,cartonBody} from '../../../../lib/carton-store';
export async function POST(request:Request){const a=await requireUser(request,'stock.restore');if(a.error)return a.error;try{return Response.json(await restoreCarton(cartonBody(await request.json()),a.user!));}catch(e){return cartonResponseError(e);}}

