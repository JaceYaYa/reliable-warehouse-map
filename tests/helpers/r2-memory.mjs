import {gunzipSync} from 'node:zlib';
export function readBackupJson(value){return JSON.parse(typeof value==='string'?value:gunzipSync(Buffer.from(value)).toString('utf8'));}
import {createHash} from 'node:crypto';

export function memoryR2(objects=new Map()) {
 const metadata=new Map();
 const size=value=>typeof value==='string'?Buffer.byteLength(value):value.byteLength;
 return {objects,
  put:async(key,value,options={})=>{
   const previous=metadata.get(key);
   if((options.onlyIf?.etagDoesNotMatch==='*'&&objects.has(key))||(options.onlyIf?.etagMatches&&previous?.etag!==options.onlyIf.etagMatches))return null;
   if(options.sha256&&!createHash('sha256').update(Buffer.from(value)).digest().equals(Buffer.from(options.sha256)))throw new Error('R2 checksum mismatch');
   objects.set(key,value);
   const etag=createHash('md5').update(Buffer.from(value)).digest('hex');
   metadata.set(key,{key,etag,size:size(value),uploaded:new Date(),customMetadata:options.customMetadata});
   return metadata.get(key);
  },
  get:async key=>{
   if(!objects.has(key))return null;
   const value=objects.get(key),blob=new Blob([value]);
   return {...metadata.get(key),body:typeof value==='string'?value:blob.stream(),text:()=>blob.text()};
  },
  head:async key=>objects.has(key)?metadata.get(key)??{key}:null,
  list:async({prefix='',limit=1000,cursor}={})=>{const all=[...objects.keys()].filter(k=>k.startsWith(prefix)).sort(),offset=Number(cursor||0),keys=all.slice(offset,offset+limit);return {objects:keys.map(key=>metadata.get(key)??{key,size:size(objects.get(key)),uploaded:new Date('2020-01-01')}),truncated:offset+keys.length<all.length,cursor:offset+keys.length<all.length?String(offset+keys.length):undefined}},
  delete:async keys=>{for(const key of Array.isArray(keys)?keys:[keys]){objects.delete(key);metadata.delete(key)}}};
}
