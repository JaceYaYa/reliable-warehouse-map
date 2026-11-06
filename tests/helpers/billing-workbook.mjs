import * as XLSX from 'xlsx';
export const sheetRows=(book,name)=>XLSX.utils.sheet_to_json(book.Sheets[name],{header:1,defval:null});
export function billRows(book){
 let customer='';const result=[];
 for(const row of sheetRows(book,'客户账单')){
  if(row[0]==='客户')customer=row[1];
  if(/^\d{4}-\d{2}$/.test(String(row[0])))result.push({customer,month:row[0],stock:row[1],shipped:row[2],fee:row[3]});
 }
 return result;
}
export function detailRows(book){
 let customer='';const result=[],rows=sheetRows(book,book.Sheets['核对明细']?'核对明细':'收费核对'),header=rows.find(row=>row[0]==='库位／层')??[],fee=header.indexOf('仓储费（USD）'),arrival=header.indexOf('原入库日期'),rate=header.indexOf('日单价（$/m³/天）'),quantity=header.indexOf('计费量（m³·天）');
 for(const row of rows){
  if(String(row[0]).startsWith('客户：'))customer=String(row[0]).slice(3).split('　')[0];
  if(typeof row[11]==='string'&&/^(在库|已出库)/.test(row[11]))result.push({customer,location:row[0],product:row[1],arrival:row[arrival],start:row[3],end:row[4],pallets:row[5],volume:row[6],days:row[7],quantity:row[quantity],rate:row[rate],fee:row[fee],status:row[11],notes:row[12]??''});
 }
 return result;
}
export const dateText=value=>typeof value==='number'?new Date((value-25569)*86400000).toISOString().slice(0,10):value?.toISOString?.().slice(0,10)??value;
