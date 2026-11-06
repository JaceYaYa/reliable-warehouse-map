import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { settings, stocks } from "../../../../db/schema";
import { requireUser } from "../../../../lib/auth";
import { withJsonErrors } from "../../../../lib/api-json";
import { associatedInventory, INVENTORY_ASSOCIATIONS_KEY, inventoryIdentity, parseAssociationState, reviewGroup, inventoryReviewHistory, canUndoInventoryReview, excludedInventoryPair, type InventoryAssociation, type InventoryReview } from "../../../../lib/inventory-associations";
import {commonMatchedProduct,matchedProductParts} from "../../../../lib/product-match";
import {stockProductDetails} from "../../../../lib/stock-product";

async function readState() {
  const [row] = await getDb().select().from(settings).where(eq(settings.key, INVENTORY_ASSOCIATIONS_KEY));
  return { raw: row?.value, state: parseAssociationState(row?.value) };
}
export async function GET(request: Request) {
  return withJsonErrors(async () => {
    const auth = await requireUser(request); if (auth.error) return auth.error;
    return Response.json({ ok: true, state: (await readState()).state }, { headers: { "cache-control": "no-store" } });
  }, "关联记录读取失败，请刷新重试");
}
export async function POST(request: Request) {
  return withJsonErrors(async () => {
    const auth = await requireUser(request, "stock.edit"); if (auth.error) return auth.error;
    const body = await request.json() as Record<string, unknown>;
    const { raw, state } = await readState();
    const conflict = () => Response.json({ error: "库存或关联记录已更新，请刷新关联后重新勾选；本次未保存" }, { status: 409 });
    if (body.revision !== state.revision) return conflict();
    const current = await getDb().select().from(stocks), groups = associatedInventory(current, state);
    let associations = state.associations.slice(), reviews = [...(state.reviews || [])], selected: typeof current = [], summary = "", action = "";
    const now = new Date().toISOString(), actor = auth.user!.displayName;
    if (body.action === "link" || body.action === "exclude") {
      if (!Array.isArray(body.groupKeys) || body.groupKeys.length < 2 || body.groupKeys.length > 100 || new Set(body.groupKeys).size !== body.groupKeys.length) return Response.json({ error: "请勾选2到100组货物" }, { status: 400 });
      const chosen = groups.filter(g => (body.groupKeys as unknown[]).includes(g.key));
      if (chosen.length !== body.groupKeys.length) return conflict();
      if (!chosen[0].customer || chosen.some(g => g.customer !== chosen[0].customer)) return Response.json({ error: "只能关联同一客户的货物，请先核对客户名称" }, { status: 400 });
      selected = chosen.flatMap(g => g.members.map(m => m.stock));
      const expected = body.members as { id: number; identity: string; version: number }[];
      if (!Array.isArray(expected) || expected.length !== selected.length || new Set(expected.map(m => m?.id)).size !== selected.length || selected.some(s => !expected.some(m => m?.id === s.id && m.identity === inventoryIdentity(s) && m.version === s.version))) return conflict();
      if (body.action === "exclude") {
        if (chosen.length !== 2) return Response.json({error:"请选择两组货物标记为不是同款"}, {status:400});
        if (excludedInventoryPair(chosen[0], chosen[1], state)) return conflict();
        reviews.push({id:crypto.randomUUID(), action:"exclude", customer:chosen[0].customer, product:chosen.map(g=>g.product).join(" / "), groups:chosen.map(reviewGroup), createdAt:now, createdBy:actor, before:[], after:[]});
        action = "确认不是同款"; summary = `${chosen[0].customer}｜${chosen.map(g=>g.product).join(" / ")}｜不再推荐此对；库存记录保留`;
      } else {
      let product = typeof body.product === "string" ? body.product.normalize("NFKC").trim() : "";
      if (body.annotations === undefined && selected.some(s=>stockProductDetails(s).name===product)) product=commonMatchedProduct(selected.map(s=>s.product))||product;
      if (!product || product.length > 500) return Response.json({ error: "请填写500字以内的统一产品名称" }, { status: 400 });
      const annotations = body.annotations as {id:number;productPrefix:string}[] | undefined;
      if (annotations !== undefined && (!Array.isArray(annotations) || annotations.length!==selected.length || new Set(annotations.map(m=>m?.id)).size!==selected.length || selected.some(s=>!annotations.some(m=>m?.id===s.id&&typeof m.productPrefix==="string"&&m.productPrefix.length<=2000)))) return Response.json({error:"请核对每条货物的附加标记"},{status:400});
      const previousIds = new Set(chosen.flatMap(g => g.associationIds || []));
      const before = associations.filter(a => previousIds.has(a.id));
      associations = associations.filter(a => !previousIds.has(a.id));
      const association: InventoryAssociation = { id: crypto.randomUUID(), product, customer: chosen[0].customer, createdAt: now, createdBy: actor,
        members: selected.map(s => ({ stockId: s.id, identity: inventoryIdentity(s), productPrefix: annotations?.find(m=>m.id===s.id)!.productPrefix.normalize("NFKC").trim() ?? matchedProductParts(s,product).prefix })) };
      associations.push(association);
      reviews.push({id:crypto.randomUUID(), action:"link", customer:association.customer, product, groups:chosen.map(reviewGroup), createdAt:now, createdBy:actor, before, after:[association]});
      action = "关联同款货物"; summary = `${association.customer}｜${product}｜${chosen.length}组、${selected.length}条记录｜库存编号 ${selected.map(s => s.id).join(",")}｜原数量、库位、日期和计价不变`;
      }
    } else if (body.action === "unlink") {
      const group = groups.find(g => g.key === body.groupKey);
      if (!group?.associationIds?.length) return conflict();
      selected = group.members.map(m => m.stock);
      const before = associations.filter(a => group.associationIds!.includes(a.id));
      associations = associations.filter(a => !group.associationIds!.includes(a.id));
      reviews.push({id:crypto.randomUUID(), action:"unlink", customer:group.customer, product:group.product, groups:[reviewGroup(group)], createdAt:now, createdBy:actor, before, after:[]});
      action = "撤销同款关联"; summary = `${group.customer}｜${group.product}｜${selected.length}条记录恢复自动分组`;
    } else if (body.action === "undo") {
      const review = inventoryReviewHistory(state).find(r => r.id === body.reviewId);
      if (!review || !canUndoInventoryReview(review, state)) return Response.json({error:"这条核对已撤回或已被后续操作替代，请刷新核对记录，从最新操作开始撤回"}, {status:409});
      const ids = new Set([...review.groups.flatMap(g=>g.members.map(m=>m.stockId)), ...review.before.flatMap(a=>a.members.map(m=>m.stockId))]);
      selected = current.filter(s=>ids.has(s.id));
      if (review.action !== "exclude") {
        // Restoring an earlier rule must never attach rows whose customer/name/SKU changed in the meantime.
        for (const rule of review.before) {
          const valid = associatedInventory(selected, {revision:0, associations:[rule]});
          if (valid.some(g=>g.associationIds?.includes(rule.id) && g.review)) return Response.json({error:"原关联的客户、名称或 SKU 已修改，请重新核对；本次未撤回"}, {status:409});
        }
        const afterIds = new Set(review.after.map(a=>a.id));
        associations = associations.filter(a=>!afterIds.has(a.id));
        associations.push(...review.before);
      }
      const updated = {...review, revertedAt:now, revertedBy:actor};
      reviews = reviews.some(r=>r.id===review.id) ? reviews.map(r=>r.id===review.id?updated:r) : [...reviews,updated];
      action = "撤回货物核对"; summary = `${review.customer}｜${review.product}｜撤回${review.action==="exclude"?"不是同款":review.action==="unlink"?"撤销关联":"确认同款"}｜原始库存及计价不变`;
    } else return Response.json({ error: "不支持的关联操作" }, { status: 400 });
    const next = { revision: state.revision + 1, associations, reviews }, value = JSON.stringify(next);
    // One D1 transaction: compare-and-swap the state and stock snapshot, then log only the successful write.
    const guardValue = JSON.stringify(selected.map(s => ({ id: s.id, version: s.version, product: s.product, customerName: s.customerName, sku: s.sku, barcode: s.barcode })));
    const stockGuard = `(SELECT count(*) FROM stocks s JOIN json_each(?) e ON s.id=json_extract(e.value,'$.id') AND s.version=json_extract(e.value,'$.version') AND s.product=json_extract(e.value,'$.product') AND s.customer_name=json_extract(e.value,'$.customerName') AND s.sku=json_extract(e.value,'$.sku') AND s.barcode=json_extract(e.value,'$.barcode'))=?`;
    const write = raw === undefined
      ? env.DB.prepare(`INSERT OR IGNORE INTO settings(key,value,updated_at) SELECT ?,?,? WHERE ${stockGuard}`).bind(INVENTORY_ASSOCIATIONS_KEY, value, now, guardValue, selected.length)
      : env.DB.prepare(`UPDATE settings SET value=?,updated_at=? WHERE key=? AND value=? AND ${stockGuard}`).bind(value, now, INVENTORY_ASSOCIATIONS_KEY, raw, guardValue, selected.length);
    const log = env.DB.prepare("INSERT INTO audit_logs(user_id,user_name,action,entity_type,entity_id,summary,created_at) SELECT ?,?,?,?,?,?,? WHERE changes()=1")
      .bind(auth.user!.id, auth.user!.displayName, action, "货物关联", String(next.revision), summary, now);
    const result = await env.DB.batch([write, log]);
    if (result[0].meta.changes !== 1) return conflict();
    return Response.json({ ok: true, state: next });
  }, "货物关联保存失败，请刷新关联核对后重试");
}
