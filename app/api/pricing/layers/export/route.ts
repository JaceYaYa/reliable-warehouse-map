import * as XLSX from 'xlsx';
import {requireUser} from '../../../../../lib/auth';
import {parseLayerReportQuery,readLayerStorageReport} from '../../../../../lib/layer-storage-report-store';
import {buildLayerStorageWorkbook} from '../../../../../lib/layer-storage-workbook';
export async function GET(request:Request){
 const a=await requireUser(request,'pricing.manage');if(a.error)return a.error;
 let query;try{query=parseLayerReportQuery(new URL(request.url).searchParams);}catch(e){return Response.json({error:e instanceof Error?e.message:'查询条件无效'},{status:400,headers:{'cache-control':'private, no-store'}});}
 try{
  const report=await readLayerStorageReport(query),workbook=buildLayerStorageWorkbook(report);
  return new Response(XLSX.write(workbook,{type:'array',bookType:'xlsx',compression:true}),{headers:{'content-type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','content-disposition':`attachment; filename="layer-storage-${report.period.fromDate??report.period.fromMonth}-${report.period.toDate??report.period.toMonth}.xlsx"`,'cache-control':'private, no-store'}});
 }catch{return Response.json({error:'托层费用导出失败，请刷新后重试；账单和库存未修改'},{status:500,headers:{'cache-control':'private, no-store'}});}
}
