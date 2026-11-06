import {env} from 'cloudflare:workers';
import {claimBackupJob} from './backup-job';
export const backupRetention={manual:100,daily:90,monthly:12,weekly:1,beforeRestore:20,archiveAfterDays:365};
export async function listBackupObjects(prefix:string){
 const objects:R2Object[]=[];let cursor:string|undefined;
 do{const page=await env.BACKUPS.list({prefix,limit:1000,include:['customMetadata'],...(cursor?{cursor}:{})});objects.push(...page.objects);if(page.truncated&&!page.cursor)throw new Error('备份列表未完整读取，请重试');cursor=page.truncated?page.cursor:undefined;}while(cursor);
 return objects;
}
export async function putVerifiedBackup(key:string,text:string|ReadableStream<Uint8Array>,options:R2PutOptions){
 if(key.endsWith('.json.gz')){
  const compressed=(typeof text==='string'?new Blob([text]).stream():text).pipeThrough(new CompressionStream('gzip'));
  const bytes=await new Response(compressed).arrayBuffer();
  const sha256=await crypto.subtle.digest('SHA-256',bytes);
  const saved=await env.BACKUPS.put(key,bytes,{...options,httpMetadata:{contentType:'application/gzip'},sha256});
  if(!saved&&options.onlyIf)return false;
  if(!saved||saved.size!==bytes.byteLength)throw new Error('未能核验压缩备份已完整保存');
  return true;
 }
 if(typeof text!=='string')throw new Error('分段备份必须使用压缩格式');
 await env.BACKUPS.put(key,text,options);const saved=await env.BACKUPS.get(key);
 if(!saved||await saved.text()!==text)throw new Error('未能核验备份文件已完整保存，请刷新列表核对后重试');
}
export async function pruneBackups(protectedKey?:string){
 const job=await claimBackupJob();
 try{
 const objects=await listBackupObjects('backups/'),remove:string[]=[];
 for(const [prefix,keep] of [['manual-',backupRetention.manual],['daily-',backupRetention.daily],['monthly-',backupRetention.monthly],['before-restore-',backupRetention.beforeRestore]] as const){
  const group=objects.filter(o=>o.key.startsWith('backups/'+prefix)).sort((a,b)=>a.key===protectedKey?-1:b.key===protectedKey?1:new Date(b.customMetadata?.createdAt||b.uploaded).getTime()-new Date(a.customMetadata?.createdAt||a.uploaded).getTime()||b.key.localeCompare(a.key));remove.push(...group.slice(keep).map(o=>o.key));
 }
 for(let i=0;i<remove.length;i+=1000)await env.BACKUPS.delete(remove.slice(i,i+1000));
 return remove.length;
 }finally{await job.release();}
}
