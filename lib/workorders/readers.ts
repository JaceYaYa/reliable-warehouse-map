import {parseDelivery} from './legacy/delivery-data.mjs';
import {parseFreightSheets,combineDocuments} from './legacy/freight-data.mjs';
import {workbookRows} from './legacy/spreadsheet-data.mjs';
import {parseCartonScreenshot} from './legacy/carton-screenshot.mjs';
import type {WorkDocument} from './model';
type Material={file:File;visibility:'source'|'employee';quantityMode?:string};
export async function readWorkorderMaterials(materials:Material[],quantityMode:string,onProgress:(text:string)=>void){
 const documents:WorkDocument[]=[],ocr:string[]=[],screenshotRows:Record<string,unknown>[]=[],extra:string[]=[],warnings:string[]=[];
 for(const material of materials.filter(m=>m.visibility==='source')){
  const file=material.file;onProgress(`正在整理 ${file.name}`);
  if(/\.pdf$/i.test(file.name)){
   const moduleUrl=new URL('/workorders/vendor/pdf.min.mjs',window.location.href).href,pdfjs=await import(/* @vite-ignore */ moduleUrl);pdfjs.GlobalWorkerOptions.workerSrc='/workorders/vendor/pdf.worker.min.mjs';
   const task=pdfjs.getDocument({data:new Uint8Array(await file.arrayBuffer()),isEvalSupported:false});try{const doc=await task.promise;if(doc.numPages>20)throw Error('一份PDF最多20页');const pages=[];let chars=0;for(let i=1;i<=doc.numPages;i++){const page=await doc.getPage(i),content=await page.getTextContent();chars+=content.items.reduce((n:number,item:{str?:string})=>n+(item.str?.length||0),0);if(chars>18000)throw Error('PDF文字过多，请分单导出');pages.push({width:page.getViewport({scale:1}).width,items:content.items});}const text=pages.map(page=>page.items.map((item:{str?:string})=>item.str||'').join(' ')).join('\n');if(/Packing\s*List/i.test(text))documents.push((parseDelivery as unknown as (pages:unknown)=>WorkDocument)(pages));else{if(text.trim())extra.push(text);warnings.push(`${file.name} ${text.trim()?'已提取普通PDF文字，格式需要人工整理':'未找到文字层，可能是扫描PDF；请保留原件并用截图识字或手工补充'}`);}}finally{await task.destroy();}
  }else if(/\.xlsx$/i.test(file.name)){
   const XLSX=await import('xlsx'),sheets=workbookRows(XLSX,await file.arrayBuffer(),{includeMerges:true});
   const parsed=(parseFreightSheets as unknown as (sheets:unknown,options:unknown)=>{doc:WorkDocument;needsQuantityMode:boolean})(sheets,{quantityMode:material.quantityMode??quantityMode});documents.push(parsed.doc);if(parsed.needsQuantityMode)warnings.push(`${file.name} 的“数量”列含义待确认，请选择每箱件数或本行总件数后重新整理`);
  }else if(/\.(png|jpe?g|webp)$/i.test(file.name)){
   const moduleUrl=new URL('/workorders/vendor/tesseract.esm.min.mjs',window.location.href).href,api=await import(/* @vite-ignore */ moduleUrl);const worker=await(api.createWorker||api.default.createWorker)('chi_sim+eng',1,{workerPath:'/workorders/vendor/ocr-worker.min.js',corePath:'https://cdn.jsdelivr.net/npm/tesseract.js-core@7.0.0',workerBlobURL:false,logger:(event:{status:string;progress:number})=>onProgress(event.status==='recognizing text'?`${file.name} 识字 ${Math.round(event.progress*100)}%`:'正在准备截图识字组件…')});try{const data=(await worker.recognize(file,{},{text:true,blocks:true})).data;ocr.push(data.text);const table=(parseCartonScreenshot as unknown as (data:unknown)=>{rows:Record<string,unknown>[];warnings:string[]})(data);screenshotRows.push(...table.rows.map(row=>({...row,source:`截图 ${ocr.length} 箱型明细`})));warnings.push(...table.warnings,`${file.name} 为截图识字结果，数字、箱号和√标记需要对照原图核对`);}finally{await worker.terminate();}
  }else if(/\.(txt|csv)$/i.test(file.name)){const text=await file.text();if(text.length>12000)throw Error('文字文件过长，请分单整理');extra.push(text);}else warnings.push(`${file.name} 未自动识别，保留原附件供人工核对`);
 }
 const combined=(combineDocuments as unknown as (docs:WorkDocument[])=>{doc:WorkDocument|null;text:string;warnings:string[]})(documents);
 return{document:combined.doc,ocr:ocr.join('\n\n'),ocrSources:ocr,screenshotRows,text:[...extra,combined.text].filter(Boolean).join('\n'),warnings:[...warnings,...combined.warnings]};
}

/** Never render arbitrary local files under this site's origin. MIME comes from bytes, not the upload hint. */
export async function safeMaterialPreview(file:File){
 const bytes=new Uint8Array(await file.slice(0,16).arrayBuffer()),matches=(signature:number[],offset=0)=>signature.every((byte,index)=>bytes[index+offset]===byte);
 const mime=matches([137,80,78,71,13,10,26,10])?'image/png':matches([255,216,255])?'image/jpeg':matches([82,73,70,70])&&matches([87,69,66,80],8)?'image/webp':matches([37,80,68,70,45])?'application/pdf':'application/octet-stream';
 return{blob:new Blob([file],{type:mime}),image:mime.startsWith('image/'),download:mime==='application/octet-stream'};
}
