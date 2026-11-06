import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { auditLogs } from "../../../../db/schema";
import { requireWriteUser } from "../../../../lib/auth";
import { hasPermission } from "../../../../lib/permissions";
import { GoodsFlowError,goodsInteger } from "../../../../lib/goods-flow";
import { goodsResponseError } from "../../../../lib/goods-store";
import { restoreGoodsOperation } from "../../../../lib/goods-restore";
export async function POST(request:Request){const auth=await requireWriteUser(request,"stock.restore");if(auth.error)return auth.error;try{const body=await request.json() as {id:unknown},id=goodsInteger(body.id,"原记录编号",1),[log]=await getDb().select().from(auditLogs).where(eq(auditLogs.id,id));if(!log||!['入库','出库'].includes(log.action))throw new GoodsFlowError("找不到可撤销的货物操作",404);if(!hasPermission(auth.user!,log.action==='入库'?'stock.inbound':'stock.outbound'))return Response.json({error:"没有撤销此操作的权限"},{status:403});return await restoreGoodsOperation(log,auth.user!)??Response.json({error:"这不是货物方式的操作，请从原记录撤销"},{status:400});}catch(e){return goodsResponseError(e);}}
