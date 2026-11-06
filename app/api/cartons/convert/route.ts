import {redactWarehousePricing} from '../../../../lib/permissions';
import {requireWriteUser} from '../../../../lib/auth';
import {cartonBody,cartonResponseError} from '../../../../lib/carton-store';
import {convertCarton} from '../../../../lib/carton-convert';
export async function POST(request:Request){const auth=await requireWriteUser(request,'stock.convert');if(auth.error)return auth.error;try{return Response.json(redactWarehousePricing(await convertCarton(cartonBody(await request.json()),auth.user!),auth.user!));}catch(e){return cartonResponseError(e);}}
