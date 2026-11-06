import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import ts from 'typescript';
const require=createRequire(import.meta.url);
export function warehouseApiHarness(extraEnv={}){
 const sqlite=new DatabaseSync(':memory:');
 for(const entry of JSON.parse(readFileSync('drizzle/meta/_journal.json','utf8')).entries)sqlite.exec(readFileSync(`drizzle/${entry.tag}.sql`,'utf8'));
 sqlite.exec('DELETE FROM sessions; DELETE FROM users;');
 // Test fixtures retain the empty documentary epoch used before V128; production initializes lazily.
 sqlite.exec(readFileSync('lib/layer-storage-checkpoint.ts','utf8').match(/export const CAPTURE_LAYER_STORAGE_CHECKPOINT_SQL=`([\s\S]*?)`;/)[1]);
 // Existing fixtures exercise the retained historical algorithms; V123 opts into the deployed layer basis explicitly.
 sqlite.prepare("INSERT INTO settings(key,value,updated_at) VALUES ('storage_pricing_basis',?,'fixture') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(extraEnv.layerPricing===true?'layer':'legacy');
 const adapter={prepare(sql){const make=values=>({bind:(...args)=>make(args),raw:async()=>{const q=sqlite.prepare(sql);q.setReturnArrays(true);return q.all(...values)},all:async()=>({results:sqlite.prepare(sql).all(...values),success:true,meta:{changes:sqlite.prepare("SELECT changes() n").get().n}}),run:async()=>{const r=sqlite.prepare(sql).run(...values);return{results:[],success:true,meta:{changes:r.changes}}},first:async()=>sqlite.prepare(sql).get(...values)??null});return make([])},async batch(queries){const hook=adapter.beforeBatch;adapter.beforeBatch=null;hook?.();sqlite.exec('BEGIN');try{const rows=[];for(const q of queries)rows.push(await q.all());sqlite.exec('COMMIT');return rows}catch(e){sqlite.exec('ROLLBACK');throw e}}};
 const cache=new Map();
 function load(file){
  if(cache.has(file))return cache.get(file);
  const exports={};cache.set(file,exports);
  const code=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  const localRequire=specifier=>{if(specifier==='cloudflare:workers')return{env:{DB:adapter,...extraEnv}};if(!specifier.startsWith('.'))return require(specifier);let path=resolve(dirname(file),specifier);if(existsSync(path)&&statSync(path).isDirectory())path+='/index.ts';else if(!existsSync(path))path+='.ts';return load(path)};
  runInNewContext(code,{exports,require:localRequire,Response,Request,URL,crypto,structuredClone,TextEncoder,TextDecoder,Uint8Array,ArrayBuffer,Blob,ReadableStream,setTimeout,clearTimeout,CompressionStream,DecompressionStream,console,btoa,atob,File,FormData});return exports;
 }
 const seedUser=(id,permissions=null,role='employee',username=`user${id}`)=>{sqlite.prepare("INSERT INTO users(id,username,display_name,role,password_hash,password_salt,permissions,created_at,must_change) VALUES (?,?,?,?,'unused','unused',?,'now',0)").run(id,username,username,role,permissions===null?null:JSON.stringify(permissions));const token=`test-token-${id}`,hash=createHash('sha256').update(token).digest('hex');sqlite.prepare("INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES (?,?,'2099-01-01','now')").run(hash,id);return token};
 const call=async(path,method='GET',body,token='test-token-1',{drain=true}={})=>{
  const route=load(resolve(`app/api/${path.split('?')[0]}/route.ts`));
  const send=async(value)=>{const r=await route[method](new Request(`http://local.test/api/${path}`,{method,headers:{cookie:`wms_session=${token}`,'Content-Type':'application/json'},...(value===undefined?{}:{body:JSON.stringify(value)})}));return{status:r.status,data:await r.json()}};
  let result=await send(body),steps=0;
  while(drain&&path==='backups'&&method==='POST'&&result.status===200&&result.data.pending&&result.data.backupJob){if(++steps>10000)throw new Error('backup did not finish');result=await send({action:'backup-step',jobId:result.data.backupJob.id});}
  if(drain&&body?.action==='auto'&&result.data.verified)result=await send(body);
  return result;
 };
 const setting=(key,value)=>sqlite.prepare("INSERT INTO settings(key,value,updated_at) VALUES (?,?,'now') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key,JSON.stringify(value));
 const stock=(code='A1',layer=1,pallets=1)=>Number(sqlite.prepare("INSERT INTO stocks(location_code,inbound_date,product,total_quantity,total_boxes,pallet_count,layer_count,inbound_source,updated_at) VALUES (?,'2026-09-01','测试货物',10,2,?,?,'domestic','now')").run(code,pallets,layer).lastInsertRowid);
 return{sqlite,adapter,call,seedUser,setting,stock,load};
}
