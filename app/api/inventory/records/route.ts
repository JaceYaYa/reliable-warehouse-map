import {redactWarehousePricing} from '../../../../lib/permissions';
import {warehouseTodayDate} from '../../../../lib/warehouse-time';
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { stocks } from "../../../../db/schema";
import { requireUser } from "../../../../lib/auth";
import { withJsonErrors } from "../../../../lib/api-json";
import { RECORD_NUMBER_FIELDS, RECORD_TEXT_FIELDS } from "../../../../lib/inventory-record-edit";
import { stockProductDetails } from "../../../../lib/stock-product";
import { goodsInventoryWritePlan } from "../../../../lib/goods-inventory-guard";

const columns = { product: "product", productPrefix:"product_prefix", productCondition:"product_condition", customerName: "customer_name", sku: "sku", barcode: "barcode", inboundDate: "inbound_date", inboundOrder: "inbound_order", note: "note", inboundSource: "inbound_source", totalQuantity: "total_quantity", totalBoxes: "total_boxes", layerCount: "layer_count",catalogItemId:"catalog_item_id" };
export async function PATCH(request: Request) {
  return withJsonErrors(async () => {
    const auth = await requireUser(request, "stock.edit"); if (auth.error) return auth.error;
    const body = await request.json() as Record<string, unknown>;
    if (!body || !Number.isSafeInteger(body.id) || Number(body.id) <= 0 || !Number.isSafeInteger(body.expectedVersion) || Number(body.expectedVersion) < 0) return Response.json({ error: "缺少有效的库存编号或版本，请刷新重试" }, { status: 400 });
    const allowed = ["id", "expectedVersion", ...RECORD_TEXT_FIELDS, ...RECORD_NUMBER_FIELDS];
    if (Object.keys(body).some(key => !allowed.includes(key as typeof allowed[number]))) return Response.json({ error: "该界面只能修改货物信息，不能更换库位或计价规则" }, { status: 400 });
    const db = getDb(), [before] = await db.select().from(stocks).where(eq(stocks.id, Number(body.id)));
    if (!before) return Response.json({ error: "这条库存已不存在，请刷新库存" }, { status: 404 });
    const conflict = () => Response.json({ error: "这条记录已被其他人修改，你的填写仍保留；请载入最新记录重新核对" }, { status: 409 });
    if (body.expectedVersion !== before.version) return conflict();
    const values: Record<string, string | number | null> = {};
    for (const key of RECORD_TEXT_FIELDS) if (Object.hasOwn(body, key)) {
      if (typeof body[key] !== "string") return Response.json({ error: "货物信息格式不正确" }, { status: 400 });
      const raw = body[key] as string, value = key === "note" ? raw : raw.trim();
      if (value.length > (key === "note" ? 20000 : key === "product" ? 2000 : 500)) return Response.json({ error: "填写的内容过长，请缩短后重试" }, { status: 400 });
      if (key === "product" && !value) return Response.json({ error: "产品名称不能为空" }, { status: 400 });
      if (key === "productCondition" && !["", "good", "damaged"].includes(value)) return Response.json({error:"请选择正品或残次品"},{status:400});
      if (key === "inboundSource" && !["return", "domestic", "unspecified"].includes(value)) return Response.json({ error: "请选择退货、国内或无" }, { status: 400 });
      if (key === "inboundDate") {
        const date = new Date(`${value}T00:00:00.000Z`);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return Response.json({ error: "入库日期格式不正确" }, { status: 400 });
        if (value > warehouseTodayDate()) return Response.json({ error: "入库日期不能晚于今天" }, { status: 400 });
      }
      if (value !== before[key]) values[key] = value;
    }
    for (const key of RECORD_NUMBER_FIELDS) if (Object.hasOwn(body, key)) {
      const raw = body[key];
      if ((typeof raw !== "number" && typeof raw !== "string") || String(raw).trim() === "" || !Number.isSafeInteger(Number(raw)) || Number(raw) < (key === "layerCount" ? 1 : 0)) return Response.json({ error: key === "layerCount" ? "层数必须是大于或等于1的整数" : "件数和箱数必须是大于或等于0的整数" }, { status: 400 });
      if (Number(raw) !== before[key]) values[key] = Number(raw);
    }
    if (["product","productPrefix","productCondition"].some(key=>Object.hasOwn(body,key))) {
      const details=stockProductDetails({...before,...values} as typeof before);
      const normalized={product:details.name,productPrefix:details.prefix,productCondition:details.condition};
      for(const key of ["product","productPrefix","productCondition"] as const) if(normalized[key]!==before[key])values[key]=normalized[key];
    }
    if (before.inventoryUnit==='box'&&Number(values.totalQuantity??before.totalQuantity)!==0) return Response.json({error:'已确认箱库存不能填写件数；库存分类请通过箱库存核对处理'},{status:400});
    if (!Object.keys(values).length) return Response.json(redactWarehousePricing({ stock: before },auth.user!));
    const identityAfter={...before,...values} as typeof before;
    if(before.catalogItemId && (stockProductDetails(identityAfter).name!==stockProductDetails(before).name||["customerName","sku","barcode"].some(key=>identityAfter[key as keyof typeof before]!==before[key as keyof typeof before])))values.catalogItemId=null;
    const now = new Date().toISOString(), operationId = crypto.randomUUID();
    const after = { ...before, ...values, updatedAt: now, updatedBy: auth.user!.displayName, version: before.version + 1 };
    const goods=await goodsInventoryWritePlan([{before,after:after as typeof before}],"edit",{user:auth.user!});
    const labels: Record<string, string> = { product: "产品", productPrefix:"附加标记",productCondition:"品相", customerName: "客户", sku: "SKU", barcode: "条码", inboundDate: "入库日期", inboundOrder: "入库单号", note: "备注", inboundSource: "来源", totalQuantity: "件数", totalBoxes: "箱数", layerCount: "层数",catalogItemId:"旧目录绑定（价格保留）" };
    const summary = `${after.product}｜库存信息修改｜${Object.keys(values).map(key => key === "note" ? "备注已修改" : `${labels[key]} ${before[key as keyof typeof before]}→${values[key]}`).join("｜")}｜未生成出库记录`;
    const keys = Object.keys(values) as (keyof typeof columns)[];
    const write = env.DB.prepare(`UPDATE stocks SET ${keys.map(key => `${columns[key]}=?`).join(",")},updated_at=?,updated_by=?,version=version+1 WHERE id=? AND version=?`)
      .bind(...keys.map(key => values[key]), now, auth.user!.displayName, before.id, before.version);
    const log = env.DB.prepare("INSERT INTO audit_logs(user_id,user_name,action,entity_type,entity_id,operation_id,summary,before_snapshot,after_snapshot,created_at) SELECT ?,?,?,?,?,?,?,?,?,? WHERE changes()=1")
      .bind(auth.user!.id, auth.user!.displayName, "库存修改", "库位", before.locationCode, operationId, summary, JSON.stringify(before), JSON.stringify(after), now);
    const results = await env.DB.batch([...goods.guard,write, log,...goods.afterQueries]);
    if (results[goods.guard.length].meta.changes !== 1) return conflict();
    return Response.json(redactWarehousePricing({ stock: after,dateDisplayOnly:goods.dateDisplayOnly },auth.user!));
  }, "库存修改保存失败，填写内容仍保留，请稍后重试");
}
