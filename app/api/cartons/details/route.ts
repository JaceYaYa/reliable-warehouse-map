import {requireUser} from '../../../../lib/auth';
import {updateCartonDetails,cartonResponseError,cartonBody} from '../../../../lib/carton-store';
export async function POST(request:Request){const a=await requireUser(request);if(a.error)return a.error;try{return Response.json(await updateCartonDetails(cartonBody(await request.json()),a.user!));}catch(e){return cartonResponseError(e);}}
