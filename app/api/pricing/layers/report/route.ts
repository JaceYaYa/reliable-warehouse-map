import{requireUser}from'../../../../../lib/auth';
import{parseLayerReportQuery,readLayerStorageReport}from'../../../../../lib/layer-storage-report-store';
import{encodeLayerReport}from'../../../../../lib/layer-report-transport';
export async function GET(request:Request){
 const a=await requireUser(request,'pricing.manage');if(a.error)return a.error;
 let query;try{query=parseLayerReportQuery(new URL(request.url).searchParams);}catch(e){return Response.json({error:e instanceof Error?e.message:'查询条件无效'},{status:400,headers:{'cache-control':'private, no-store'}});}
 const started=Date.now();
 try{
  const report=await readLayerStorageReport(query),compact=request.headers.get('accept')==='application/vnd.wms.layer-report+json',body=compact?encodeLayerReport(report):report;
  const response=Response.json(body,{headers:{'cache-control':'private, no-store'}});
  console.info('layer-report-ready',{elapsedMs:Math.round(Date.now()-started),sourceRows:report.rows.length,returnedRows:body.rows.length,compact});
  return response;
 }catch(error){
  const errorId=crypto.randomUUID();
  const cause=error instanceof Error?error.cause:undefined;
  console.error('layer-report-failed',{errorId,elapsedMs:Math.round(Date.now()-started),name:error instanceof Error?error.name:'Error',message:error instanceof Error?error.message:String(error),databaseCause:cause instanceof Error?cause.message:undefined});
  return Response.json({error:`托层费用读取失败，请重试；错误编号 ${errorId}`},{status:500,headers:{'cache-control':'private, no-store','x-wms-error-id':errorId}});
 }
}
