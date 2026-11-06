import type {CartonReceipt} from './carton-flow';
export type BoxCorrectionRecovery={draftKey:string;receipt:CartonReceipt;placementKey:string;requestId:string};
type DraftStorage=Pick<Storage,'length'|'key'|'getItem'>;
export function pendingBoxCorrections(storage:DraftStorage,userId:number):BoxCorrectionRecovery[]{
 const rows:BoxCorrectionRecovery[]=[],prefix=`warehouse:carton-details:${userId}:`,suffix=':correction';
 for(let i=0;i<storage.length;i++){
  const key=storage.key(i);if(!key?.startsWith(prefix)||!key.endsWith(suffix))continue;
  try{const pending=JSON.parse(storage.getItem(key)||'null'),body=pending?.body,receipt=pending?.receipt;
   if(!receipt||typeof receipt.id!=='string'||receipt.id!==body?.id||typeof body.requestId!=='string'||typeof body.placementKey!=='string'||!Array.isArray(receipt.placements)||!Number.isSafeInteger(body.boxes)||body.boxes<0)continue;
   rows.push({draftKey:key.slice(0,-suffix.length),receipt,placementKey:body.placementKey,requestId:body.requestId});
  }catch{/* Keep the other original requests reachable when one local draft is damaged. */}
 }
 return rows;
}
