export function workbookRows(XLSX,bytes,{includeMerges=false}={}){
 const buffer=new Uint8Array(bytes),view=new DataView(buffer.buffer,buffer.byteOffset,buffer.byteLength);
 if(buffer.length<22||view.getUint32(0,true)!==0x04034b50)throw new Error('请选择未加密的 .xlsx 表格。');
 let end=-1;for(let i=buffer.length-22;i>=Math.max(0,buffer.length-65557);i--)if(view.getUint32(i,true)===0x06054b50){end=i;break}
 if(end<0)throw new Error('Excel 文件不完整，请重新下载。');const count=view.getUint16(end+10,true);let cursor=view.getUint32(end+16,true),size=0;
 if(count>2000)throw new Error('表格内容过多，请分单导出。');
 for(let i=0;i<count;i++){if(cursor+46>buffer.length||view.getUint32(cursor,true)!==0x02014b50)throw new Error('Excel 文件目录不完整。');size+=view.getUint32(cursor+24,true);if(size>40*1024*1024)throw new Error('表格展开后过大，请分单导出。');cursor+=46+view.getUint16(cursor+28,true)+view.getUint16(cursor+30,true)+view.getUint16(cursor+32,true)}
 const workbook=XLSX.read(buffer,{type:'array',cellFormula:false,cellHTML:false,cellStyles:false,sheetRows:1002,bookVBA:false});
 if(workbook.SheetNames.length>12)throw new Error('一次最多读取12张工作表，请按出库单导出。');
 return workbook.SheetNames.map(name=>{const sheet=workbook.Sheets[name];if(sheet['!fullref']&&XLSX.utils.decode_range(sheet['!fullref']).e.r>=1001)throw new Error('表格超过1000行，请分单导出。');return {name,rows:XLSX.utils.sheet_to_json(sheet,{header:1,defval:'',raw:true,blankrows:includeMerges}),...(includeMerges?{merges:sheet['!merges']||[]}: {})}});
}
