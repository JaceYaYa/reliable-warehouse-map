import {env} from 'cloudflare:workers';
import {WarehouseHistoryImportError} from './warehouse-history-import';
const key='maintenance/backup-job-v149.json';
export const BACKUP_VERIFIED_MARKER='maintenance/backup-v149-verified.json';
/** R2 compare-and-swap: backup/cleanup requests across tabs cannot overlap. */
export async function claimBackupJob(durationMs=10*60*1000){
 const previous=await env.BACKUPS.get(key),state=previous?JSON.parse(await previous.text()):null;
 if(state&&Number(state.expiresAt)>Date.now())throw new WarehouseHistoryImportError(state.status==='cooldown'?'备份刚刚失败，请等待30秒后再试，避免数据库连续过载':'已有备份或空间清理正在进行，请等待完成，不要重复提交',409);
 const id=crypto.randomUUID(),value=JSON.stringify({id,status:'running',expiresAt:Date.now()+durationMs});
 const saved=await env.BACKUPS.put(key,value,{onlyIf:previous?{etagMatches:previous.etag}:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/json'}});
 if(!saved)throw new WarehouseHistoryImportError('已有备份或空间清理正在启动，请稍后核对',409);
 return {async release(failed=false){await env.BACKUPS.put(key,JSON.stringify({id,status:failed?'cooldown':'idle',expiresAt:failed?Date.now()+30000:0}),{onlyIf:{etagMatches:saved.etag}});}};
}
