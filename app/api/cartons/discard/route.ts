import {requireUser} from '../../../../lib/auth';
import {discardCarton,cartonResponseError,cartonBody} from '../../../../lib/carton-store';

export async function DELETE(request:Request){
 const auth=await requireUser(request,'stock.delete');if(auth.error)return auth.error;
 try{return Response.json(await discardCarton(cartonBody(await request.json()),auth.user!));}
 catch(error){return cartonResponseError(error);}
}
