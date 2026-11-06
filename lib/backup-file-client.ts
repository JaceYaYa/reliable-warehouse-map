/** Decompress in the browser so the server never holds a 60MB JSON upload plus copies. */
export async function readBackupFile(file:File){
 const prefix=new Uint8Array(await file.slice(0,2).arrayBuffer());
 const gzip=prefix[0]===0x1f&&prefix[1]===0x8b;
 if(!gzip&&/\.gz$/i.test(file.name))throw new Error('压缩备份格式不正确，请重新下载');
 const text=gzip?await new Response(file.stream().pipeThrough(new DecompressionStream('gzip'))).text():await file.text();
 const value:unknown=JSON.parse(text);
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('备份文件格式不正确');
 return {text,source:value as Record<string,unknown>,file:gzip?new File([text],file.name.replace(/\.gz$/i,''),{type:'application/json'}):file};
}
