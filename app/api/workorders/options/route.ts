import {env} from 'cloudflare:workers';
import {requireUser} from '../../../../lib/auth';
import {hasPermission,type PermissionUser} from '../../../../lib/permissions';
import {workorderResponseError} from '../../../../lib/workorders/store';
export async function GET(request:Request){
 const auth=await requireUser(request,'workorders.manage');if(auth.error)return auth.error;
 try{
  const [customers,users]=await env.DB.batch([
   env.DB.prepare("SELECT customer_name name FROM stocks WHERE trim(customer_name)<>'' UNION SELECT customer_name name FROM work_orders WHERE trim(customer_name)<>'' ORDER BY name"),
   env.DB.prepare('SELECT id,username,display_name AS displayName,role,permissions FROM users WHERE active=1 ORDER BY display_name,username')
  ]);
  return Response.json({customers:(customers.results as {name:string}[]).map(row=>row.name),users:(users.results as (PermissionUser&{id:number;displayName:string})[]).filter(user=>hasPermission(user,'workorders.execute')).map(({id,username,displayName})=>({id,username,displayName}))},{headers:{'cache-control':'private,no-store'}});
 }catch(error){return workorderResponseError(error);}
}
