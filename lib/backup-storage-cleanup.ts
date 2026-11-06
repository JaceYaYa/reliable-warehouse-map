import {env} from 'cloudflare:workers';
import {putVerifiedBackup} from './backup-retention';
import {claimBackupJob} from './backup-job';
import {WarehouseHistoryImportError} from './warehouse-history-import';
const stream=(body:ReadableStream<Uint8Array>|string)=>typeof body==='string'?new Blob([body]).stream():body;
async function sameBytes(left:ReadableStream<Uint8Array>,right:ReadableStream<Uint8Array>){
 const a=left.getReader(),b=right.getReader();let av=new Uint8Array(0),bv=new Uint8Array(0),ai=0,bi=0,ad=false,bd=false;
 try{for(;;){
  if(ai===av.length&&!ad){const r=await a.read();av=r.value??new Uint8Array(0);ai=0;ad=!!r.done;}
  if(bi===bv.length&&!bd){const r=await b.read();bv=r.value??new Uint8Array(0);bi=0;bd=!!r.done;}
  if(ad||bd)return ad&&bd&&ai===av.length&&bi===bv.length;
  const length=Math.min(av.length-ai,bv.length-bi);for(let n=0;n<length;n++)if(av[ai+n]!==bv[bi+n])return false;ai+=length;bi+=length;
 }}finally{await Promise.allSettled([a.cancel(),b.cancel()]);}
}
/** Keep every recovery point; remove only a raw copy verified against its gzip. */
export async function compressLegacyBackup(key:unknown){
 if(typeof key!=='string'||!(/^(backups\/(manual|daily|monthly|before-restore)-|archives\/audit-).+\.json$/.test(key)))throw new WarehouseHistoryImportError('只可清理历史未压缩备份',400);
 const job=await claimBackupJob();let failed=true;
 try{
  const original=await env.BACKUPS.get(key);if(!original){failed=false;return {skipped:true,freedBytes:0};}
  if(original.size<1024){failed=false;return {skipped:true,freedBytes:0};}
  const target=key+'.gz',existing=await env.BACKUPS.head(target),created=!existing;
  if(created)await putVerifiedBackup(target,stream(original.body),{onlyIf:{etagDoesNotMatch:'*'},customMetadata:{...original.customMetadata,createdAt:original.customMetadata?.createdAt||original.uploaded.toISOString(),compressedFrom:key,uncompressedSize:String(original.size)},httpMetadata:{contentType:'application/gzip'}});
  const [fresh,compressed]=await Promise.all([env.BACKUPS.get(key),env.BACKUPS.get(target)]);
  if(!fresh||!compressed||fresh.etag!==original.etag)throw new WarehouseHistoryImportError('原备份已变化，未删除任何原文件',409);
  if(!await sameBytes(stream(fresh.body),stream(compressed.body).pipeThrough(new DecompressionStream('gzip'))))throw new Error('压缩内容核对不一致，原备份已保留');
  if(created&&compressed.size>=original.size){
   await env.BACKUPS.delete(target);
   const skipKey='maintenance/legacy-cleanup-v149-skips.json',previous=await env.BACKUPS.get(skipKey),skips:string[]=previous?JSON.parse(await previous.text()):[];
   if(!skips.includes(key))await env.BACKUPS.put(skipKey,JSON.stringify([...skips,key]));
   failed=false;return {skipped:true,freedBytes:0};
  }
  // Historical timestamp/UUID keys are immutable in this application. The shared
  // lease also prevents a second backup cleanup from replacing this target.
  if((await env.BACKUPS.head(key))?.etag!==original.etag)throw new WarehouseHistoryImportError('原备份已变化，未删除原文件',409);
  await env.BACKUPS.delete(key);
  failed=false;return {key:target,verified:true,originalBytes:original.size,compressedBytes:compressed.size,freedBytes:original.size-(created?compressed.size:0)};
 }finally{await job.release(failed);}
}
