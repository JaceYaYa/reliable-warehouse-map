import {env} from 'cloudflare:workers';
import {backupRevision,initialBackupCursor,readBackupPage,type BackupCursor} from './backup-snapshot-stream';
import {claimBackupJob,BACKUP_VERIFIED_MARKER} from './backup-job';
import {putVerifiedBackup} from './backup-retention';
import {ensureLayerStorageCheckpoint} from './layer-storage-checkpoint';
import {WarehouseHistoryImportError} from './warehouse-history-import';

const activeKey='maintenance/backup-export-v150-active.json';
const prefix=(id:string)=>`maintenance/backup-export-v150/${id}/`;
type Part={key:string;bytes:number;hash:string};
type State={id:string;kind:string;createdBy:string;createdAt:string;revision:number;position:BackupCursor;parts:Part[];count:number;bytes:number;phase:'reading'|'finalizing'|'complete'|'failed';key:string;week?:string;previousEtag?:string;updatedAt:number;error?:string};
const encoder=new TextEncoder();
const hash=async(bytes:Uint8Array)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(bytes).buffer))).map(x=>x.toString(16).padStart(2,'0')).join('');
async function readState(id:string):Promise<State>{
 if(!/^[0-9a-f-]{36}$/.test(id))throw new WarehouseHistoryImportError('备份任务编号无效',400);
 const object=await env.BACKUPS.get(prefix(id)+'state.json');if(!object)throw new WarehouseHistoryImportError('备份任务不存在，请重新开始',404);return JSON.parse(await object.text());
}
const saveState=async(state:State)=>{state.updatedAt=Date.now();await env.BACKUPS.put(prefix(state.id)+'state.json',JSON.stringify(state));};
const response=(state:State)=>state.phase==='complete'?{pending:false,key:state.key,verified:true,backupJob:{id:state.id,count:state.count,bytes:state.bytes,phase:state.phase}}:{pending:true,backupJob:{id:state.id,count:state.count,bytes:state.bytes,phase:state.phase}};
async function clearParts(state:State){if(state.parts.length)await env.BACKUPS.delete(state.parts.map(p=>p.key));}
async function clearActive(id:string){const active=await env.BACKUPS.get(activeKey);if(active&&JSON.parse(await active.text()).id===id)await env.BACKUPS.delete(activeKey);}
async function unchanged(state:State){if(await backupRevision()!==state.revision)throw new WarehouseHistoryImportError('备份期间仓储数据发生变化，本次未生成备份，请重新开始；原有备份不受影响',409);}

/** Each browser request does at most four bounded D1 reads. Temporary chunks live
 * in R2, never D1, and do not appear as recovery points until fully verified. */
export async function beginBackupExport(kind:string,createdBy:string,weekly?:{week:string;previous:R2Object|null}){
 const lease=await claimBackupJob(45000);try{
  const active=await env.BACKUPS.get(activeKey);
  if(active){const previous=await readState(JSON.parse(await active.text()).id);if(previous.phase==='reading'||previous.phase==='finalizing'){
   if(previous.kind===kind&&previous.createdBy===createdBy&&previous.updatedAt>Date.now()-30*60*1000){try{await unchanged(previous);return response(previous);}catch{/* source changed: discard incomplete export, then start fresh */}}
   else if(previous.updatedAt>Date.now()-30*60*1000)throw new WarehouseHistoryImportError('另一份备份正在进行，请稍后再试',409);
   await clearParts(previous);previous.phase='failed';previous.error='未完成的旧任务已取消';await saveState(previous);
  }await clearActive(previous.id);}
  await ensureLayerStorageCheckpoint();const createdAt=new Date().toISOString(),id=crypto.randomUUID();
  const state:State={id,kind,createdBy,createdAt,revision:await backupRevision(),position:initialBackupCursor(),parts:[],count:0,bytes:0,phase:'reading',updatedAt:Date.now(),key:weekly?'backups/weekly-latest.json.gz':`backups/${kind}-${createdAt.replace(/[:.]/g,'-')}-${id}.json.gz`,...(weekly?{week:weekly.week,previousEtag:weekly.previous?.etag}: {})};
  await saveState(state);await env.BACKUPS.put(activeKey,JSON.stringify({id}));return response(state);
 }finally{await lease.release();}
}

export async function advanceBackupExport(id:string){
 const lease=await claimBackupJob(45000);let state:State|undefined,failed=true;try{
  state=await readState(id);if(state.phase==='complete'){if(state.kind==='manual')await env.BACKUPS.put(BACKUP_VERIFIED_MARKER,JSON.stringify({createdAt:state.createdAt,key:state.key}));await clearParts(state);await clearActive(id);failed=false;return response(state);}if(state.phase==='failed')throw new WarehouseHistoryImportError(state.error||'备份任务已停止，请重新开始',409);
  await unchanged(state);
  if(state.phase==='reading'){
   const texts:string[]=state.parts.length?[]:[`{"version":9,"createdAt":${JSON.stringify(state.createdAt)}`],started=Date.now();
   for(let pages=0;pages<4;pages++){
    const page=await readBackupPage(state.position);texts.push(page.text);state.position=page.next;state.count+=page.count;
    if(page.done){texts.push('}');state.phase='finalizing';break;}
    if(Date.now()-started>=10000)break;
   }
   await unchanged(state);const bytes=encoder.encode(texts.join('')),key=prefix(id)+`part-${state.parts.length}.json`,checksum=await hash(bytes);
   const saved=await env.BACKUPS.put(key,bytes,{sha256:await crypto.subtle.digest('SHA-256',bytes)});if(!saved||saved.size!==bytes.byteLength)throw new Error('备份分段未确认保存，可重试继续');
   state.parts.push({key,bytes:bytes.byteLength,hash:checksum});state.bytes+=bytes.byteLength;await saveState(state);failed=false;return response(state);
  }
  const snapshot=state;
  async function* content(){for(const part of snapshot.parts){const object=await env.BACKUPS.get(part.key);if(!object)throw new Error('备份分段缺失，请重新开始');const bytes=typeof object.body==='string'?encoder.encode(object.body):new Uint8Array(await new Response(object.body).arrayBuffer());if(bytes.byteLength!==part.bytes||await hash(bytes)!==part.hash)throw new Error('备份分段校验失败，未生成文件');yield bytes;}await unchanged(snapshot);}
  const existing=await env.BACKUPS.head(state.key);
  if(existing?.customMetadata?.exportId!==state.id){
   const iterator=content(),stream=new ReadableStream<Uint8Array>({async pull(controller){try{const next=await iterator.next();if(next.done)controller.close();else controller.enqueue(next.value);}catch(error){controller.error(error);}},async cancel(){await iterator.return(undefined);}});
   const saved=await putVerifiedBackup(state.key,stream,{customMetadata:{createdAt:state.createdAt,kind:state.kind,createdBy:state.createdBy,recordCount:String(state.count),uncompressedSize:String(state.bytes),exportId:state.id,...(state.week?{week:state.week}:{})},onlyIf:state.week?(state.previousEtag?{etagMatches:state.previousEtag}:{etagDoesNotMatch:'*'}):{etagDoesNotMatch:'*'}});
   if(saved===false)throw new Error('未能核验备份保存：目标已变化，原文件未覆盖，请重试');
  }
  state.phase='complete';await saveState(state);if(state.kind==='manual')await env.BACKUPS.put(BACKUP_VERIFIED_MARKER,JSON.stringify({createdAt:state.createdAt,key:state.key}));await clearParts(state);await clearActive(id);failed=false;return response(state);
 }catch(error){
  // Retain resumable progress for transient failures; revision conflicts can
  // never be resumed and must remove their now-invalid temporary payloads.
  if(state&&error instanceof WarehouseHistoryImportError&&/变化/.test(error.message)){state.phase='failed';state.error=error.message;await saveState(state);await clearParts(state);await clearActive(id);}
  throw error;
 }finally{await lease.release(failed);}
}
