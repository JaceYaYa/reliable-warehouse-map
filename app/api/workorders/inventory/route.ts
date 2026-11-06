import {env} from 'cloudflare:workers';
import {requireUser} from '../../../../lib/auth';
import {loadLocationAliases} from '../../../../lib/location-alias-store';
import {resolveLocationAlias} from '../../../../lib/location-aliases';
import {WorkorderError} from '../../../../lib/workorders/model';
import {workorderResponseError} from '../../../../lib/workorders/store';
export async function GET(request:Request){const auth=await requireUser(request,'workorders.manage');if(auth.error)return auth.error;try{
 const params=new URL(request.url).searchParams,q=(params.get('q')||'').trim(),customer=(params.get('customer')||'').trim(),location=(params.get('location')||'').trim();if([q,customer,location].some(v=>v.length>500))throw new WorkorderError('查询内容过长',400);
 const where=['1=1'],args:string[]=[];if(q){where.push("(instr(lower(product),lower(?))>0 OR instr(lower(sku),lower(?))>0 OR instr(lower(barcode),lower(?))>0 OR instr(lower(inbound_order),lower(?))>0)");args.push(q,q,q,q);}if(customer){where.push('customer_name=?');args.push(customer);}if(location){where.push('location_code=?');args.push(resolveLocationAlias(location,await loadLocationAliases()));}
 const result=await env.DB.prepare(`SELECT id AS stockId,version,updated_at AS updatedAt,location_code AS locationCode,product,sku,customer_name AS customerName,total_quantity AS totalQuantity,total_boxes AS totalBoxes,inbound_order AS inboundOrder,layer_count AS layerCount FROM stocks WHERE ${where.join(' AND ')} ORDER BY inbound_date,id LIMIT 100`).bind(...args).all();return Response.json({stocks:result.results,readOnly:true,notice:'仅查询快照，不预占、扣减或修改库存'},{headers:{'cache-control':'private,no-store'}});
 }catch(e){return workorderResponseError(e);}}
