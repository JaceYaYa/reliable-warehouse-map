import { requireUser } from "../../../../lib/auth";
import { hasPermission } from "../../../../lib/permissions";
import { restoreGoodsCreateAudit } from "../../../../lib/goods-create-undo";
import { GoodsFlowError, goodsInteger } from "../../../../lib/goods-flow";
import { goodsResponseError } from "../../../../lib/goods-store";
import {restoreAdminSettingAudit} from "../../../../lib/admin-setting-undo";
import {getDb} from "../../../../db";
import {auditLogs} from "../../../../db/schema";
import {eq} from "drizzle-orm";
import {restoreCartonAudit} from '../../../../lib/carton-store';

export async function POST(request: Request) {
  const auth = await requireUser(request, "audit.view");
  if (auth.error) return auth.error;
  try {
    const body = await request.json() as Record<string, unknown>;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new GoodsFlowError("提交格式不正确", 400);
    const id = goodsInteger(body.id, "管理记录编号", 1);
    const [log] = await getDb().select().from(auditLogs).where(eq(auditLogs.id,id));
    if (!log) throw new GoodsFlowError("没有找到这条管理记录", 404);
    if(log.action==='货物类别新增'&&(!hasPermission(auth.user!,"stock.restore")||!hasPermission(auth.user!,"stock.inbound")&&!hasPermission(auth.user!,"product.manage")))return Response.json({error:"当前账号没有货物类别新增的撤销权限"},{status:403});
    const response = await restoreCartonAudit(log,auth.user!)??await restoreGoodsCreateAudit(log, auth.user!)??await restoreAdminSettingAudit(log,auth.user!);
    return response ?? Response.json({ error: "这类管理记录暂不支持撤销" }, { status: 400 });
  } catch (error) { return goodsResponseError(error); }
}
