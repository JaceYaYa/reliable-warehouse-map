import {redactWarehousePricing} from '../../../lib/permissions';
import {requireUser} from '../../../lib/auth';
import {createCarton,listCartons,listCartonOperations,cartonResponseError,cartonBody} from '../../../lib/carton-store';
export async function GET(request:Request){const a=await requireUser(request);if(a.error)return a.error;try{return Response.json(redactWarehousePricing({receipts:await listCartons(),operations:await listCartonOperations()},a.user!),{headers:{'cache-control':'private, no-store'}});}catch(e){return cartonResponseError(e);}}
export async function POST(request:Request){const a=await requireUser(request,'stock.inbound');if(a.error)return a.error;try{return Response.json(redactWarehousePricing(await createCarton(cartonBody(await request.json()),a.user!),a.user!));}catch(e){return cartonResponseError(e);}}

