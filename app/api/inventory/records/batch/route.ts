import {batchInventoryCustomer} from '../../../../../lib/inventory-batch-customer';
import { env } from "cloudflare:workers";
import { sql } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { stocks } from "../../../../../db/schema";
import { requireUser } from "../../../../../lib/auth";
import { withJsonErrors } from "../../../../../lib/api-json";
import { splitProductPrefix, stockProductDetails } from "../../../../../lib/stock-product";
import { goodsInventoryWritePlan } from "../../../../../lib/goods-inventory-guard";

export async function PATCH(request:Request) {
  return withJsonErrors(async()=>{
    const auth=await requireUser(request,"stock.edit");if(auth.error)return auth.error;
    const body=await request.json() as Record<string,unknown>,records=body?.records as {id:number;expectedVersion:number}[];
    if(body?.requestId!==undefined){if(Object.keys(body).some(k=>!['records','customerName','requestId','confirmed'].includes(k)))return Response.json({error:'批量商家修改不接受其他字段'},{status:400});return Response.json(await batchInventoryCustomer(body,auth.user!));}
    if(!body||Object.keys(body).some(key=>!["records","product","customerName"].includes(key))||!Array.isArray(records)||!records.length||records.length>1000||records.some(row=>!row||Object.keys(row).some(key=>!["id","expectedVersion"].includes(key))||!Number.isSafeInteger(row.id)||row.id<1||!Number.isSafeInteger(row.expectedVersion)||row.expectedVersion<0)||new Set(records.map(r=>r.id)).size!==records.length) return Response.json({error:"请重新勾选有效的库存记录，单次最多1000条"},{status:400});
    const changeProduct=Object.hasOwn(body,"product"),changeCustomer=Object.hasOwn(body,"customerName");
    if(!changeProduct&&!changeCustomer)return Response.json({error:"请选择要修改的项目"},{status:400});
    if(changeProduct&&(typeof body.product!=="string"||!body.product.trim()||body.product.length>2000))return Response.json({error:"请填写有效的产品名称"},{status:400});
    if(changeCustomer&&(typeof body.customerName!=="string"||!body.customerName.trim()||body.customerName.length>500))return Response.json({error:"请填写有效的客户名称"},{status:400});
    const ids=JSON.stringify(records.map(r=>r.id)),before=await getDb().select().from(stocks).where(sql`${stocks.id} IN (SELECT value FROM json_each(${ids}))`);
    const expected=new Map(records.map(r=>[r.id,r.expectedVersion]));
    const conflict=()=>Response.json({error:"勾选的库存已有修改或已删除，本次未保存；请刷新并重新勾选核对"},{status:409});
    if(before.length!==records.length||before.some(row=>row.version!==expected.get(row.id)))return conflict();
    const now=new Date().toISOString(),operationId=crypto.randomUUID();
    const after=before.map(row=>{const details=stockProductDetails(row);return {...row,product:changeProduct?splitProductPrefix(body.product as string).name:row.product,productPrefix:changeProduct?details.prefix:row.productPrefix,productCondition:changeProduct?details.condition:row.productCondition,customerName:changeCustomer?(body.customerName as string).trim():row.customerName,version:row.version+1,updatedAt:now,updatedBy:auth.user!.displayName}});
    if(after.every((row,i)=>row.product===before[i].product&&row.customerName===before[i].customerName))return Response.json({stocks:before});
    for(let i=0;i<after.length;i++)if(after[i].catalogItemId&&(stockProductDetails(after[i]).name!==stockProductDetails(before[i]).name||after[i].customerName!==before[i].customerName))after[i].catalogItemId=null;
    const goods=await goodsInventoryWritePlan(before.map((row,i)=>({before:row,after:after[i]})),"edit",{user:auth.user!});
    const data=JSON.stringify(after.map(row=>({id:row.id,version:row.version-1,product:row.product,prefix:row.productPrefix,condition:row.productCondition,customer:row.customerName,catalog:row.catalogItemId})));
    // One statement checks every selected version and updates all rows, or updates none.
    const update=env.DB.prepare(`WITH input AS (SELECT value FROM json_each(?))
      UPDATE stocks SET product=(SELECT json_extract(value,'$.product') FROM input WHERE json_extract(value,'$.id')=stocks.id),
      product_prefix=(SELECT json_extract(value,'$.prefix') FROM input WHERE json_extract(value,'$.id')=stocks.id),
      product_condition=(SELECT json_extract(value,'$.condition') FROM input WHERE json_extract(value,'$.id')=stocks.id),
      customer_name=(SELECT json_extract(value,'$.customer') FROM input WHERE json_extract(value,'$.id')=stocks.id),
      catalog_item_id=(SELECT json_extract(value,'$.catalog') FROM input WHERE json_extract(value,'$.id')=stocks.id),
      updated_at=?,updated_by=?,version=version+1
      WHERE id IN (SELECT json_extract(value,'$.id') FROM input) AND
      (SELECT count(*) FROM stocks s JOIN input i ON s.id=json_extract(i.value,'$.id') AND s.version=json_extract(i.value,'$.version'))=?`)
      .bind(data,now,auth.user!.displayName,records.length);
    const logs=JSON.stringify(after.map((row,i)=>({id:row.id,location:row.locationCode,operation:`${operationId}:${row.id}`,summary:`${row.product}｜批量修改${changeProduct?"产品名称":""}${changeProduct&&changeCustomer?"、":""}${changeCustomer?"客户":""}｜原客户 ${before[i].customerName||"未填写"} → ${row.customerName||"未填写"}｜数量和入库日期保留`,before:JSON.stringify(before[i]),after:JSON.stringify(row)})));
    const audit=env.DB.prepare(`INSERT INTO audit_logs(user_id,user_name,action,entity_type,entity_id,operation_id,summary,before_snapshot,after_snapshot,created_at)
      SELECT ?,?,'库存修改','库位',json_extract(value,'$.location'),json_extract(value,'$.operation'),json_extract(value,'$.summary'),json_extract(value,'$.before'),json_extract(value,'$.after'),?
      FROM json_each(?) WHERE changes()=?`).bind(auth.user!.id,auth.user!.displayName,now,logs,records.length);
    const results=await env.DB.batch([...goods.guard,update,audit,...goods.afterQueries]);if(results[goods.guard.length].meta.changes!==records.length)return conflict();
    return Response.json({stocks:after});
  },"批量修改保存失败，勾选和填写内容仍保留，请重试");
}
