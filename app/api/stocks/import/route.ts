import { loadGoodsContext,goodsResponseError } from "../../../../lib/goods-store";
import { GoodsFlowError } from "../../../../lib/goods-flow";
import {assertStockInventoryUnit} from '../../../../lib/inventory-unit';
import type { BatchItem } from "drizzle-orm/batch";
import { sql } from "drizzle-orm";
import { goodsTransactionGuards } from "../../../../db/schema";
import { hasPermission } from "../../../../lib/permissions";
import { loadLocationAliases } from "../../../../lib/location-alias-store";
import { isLocationRenameConflict, resolveLocationAlias } from "../../../../lib/location-aliases";
import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { stocks } from "../../../../db/schema";
import { requireUser } from "../../../../lib/auth";
import { recordAudit } from "../../../../lib/audit";
import { palletLabel as formatPalletLabel, palletCountValue } from "../../../../lib/pallet";

type ImportRecord = {
  locationCode?: unknown;
  inboundDate?: unknown;
  product?: unknown;
  barcode?: unknown;
  sku?: unknown; fnsku?: unknown;
  inboundOrder?: unknown;
  totalQuantity?: unknown;
  totalBoxes?: unknown;
  customerName?: unknown;
  palletCount?: unknown;
  palletLabel?: unknown;
  layerCount?: unknown;
  note?: unknown;
};

export async function POST(request: Request) {
  const auth = await requireUser(request,"stock.inbound");
  if (auth.error) return auth.error;
  if(!hasPermission(auth.user!,"stock.edit"))return Response.json({error:"批量导入会校正已有记录，还需要库存校正权限"},{status:403});

  try {
    const body = await request.json() as { records?: ImportRecord[] } | ImportRecord[];
    const input = Array.isArray(body) ? body : body.records;
    if (!Array.isArray(input) || input.length === 0) return Response.json({ error: "没有可导入的库存记录" }, { status: 400 });
    if (input.length > 500) return Response.json({ error: "单次最多导入500条记录" }, { status: 400 });

    const aliases = await loadLocationAliases();
    const now = new Date().toISOString();
    const missingPallets=input.map(raw=>raw.palletCount===undefined||typeof raw.palletCount==='string'&&!raw.palletCount.trim());
    const normalized = input.map((raw, index) => {
      const locationCode = resolveLocationAlias(String(raw.locationCode || ""), aliases);
      const inboundDate = String(raw.inboundDate || "").trim();
      const product = String(raw.product || "").trim();
      const rawPallet = raw.palletCount;
      const parsedPallet = palletCountValue(rawPallet,1);
      const layerCount = Number(raw.layerCount ?? 1);
      if (!locationCode || !product) throw new Error(`第${index + 1}条缺少库位或产品名称`);
      if (!/^2026-\d{2}-\d{2}$/.test(inboundDate) || Number.isNaN(Date.parse(`${inboundDate}T00:00:00Z`))) throw new Error(`第${index + 1}条入库日期格式不正确`);
      if (!Number.isFinite(parsedPallet) || parsedPallet < 0) throw new Error(`第${index + 1}条托盘数格式不正确`);
      if (!Number.isSafeInteger(layerCount) || layerCount < 1) throw new Error(`第${index + 1}条层数必须是大于或等于1的整数`);
      return {
        locationCode,
        inboundDate,
        product,
        sku: String(raw.sku ?? "").trim(),
        barcode: String(raw.barcode || raw.fnsku || "").trim(),
        inboundOrder: String(raw.inboundOrder || "").trim(),
        totalQuantity: Math.max(0, Number(raw.totalQuantity || 0)),
        totalBoxes: Math.max(0, Number(raw.totalBoxes || 0)),
        customerName: String(raw.customerName || "").trim(),
        palletCount: parsedPallet,
        palletLabel: formatPalletLabel(parsedPallet, String(rawPallet??'')),
        layerCount,
        note: String(raw.note || "").trim(),
        updatedBy: auth.user!.displayName,
        updatedAt: now,
      };
    });

    const db = getDb();
    const context=await loadGoodsContext();
    if(context.state.categories.length)throw new GoodsFlowError("已启用货物批次的测试版请使用货物入库；旧纸质库存导入暂停，避免覆盖计价批次");
    const guardId=crypto.randomUUID(),queries:BatchItem<"sqlite">[]=[db.insert(goodsTransactionGuards).values({id:guardId,valid:sql<number>`CASE WHEN EXISTS(SELECT 1 FROM goods_flow_state WHERE id=1 AND revision=${context.stored.revision} AND value=${context.stored.value}) THEN 1 ELSE 0 END`})];
    const existing = await db.select().from(stocks);
    const insertRows: typeof normalized = [];
    let updated = 0;
    let skipped = 0;

    for (const [index,value] of normalized.entries()) {
      const match = existing.find(row => row.locationCode === value.locationCode && row.product === value.product && row.sku === value.sku && row.barcode === value.barcode && row.customerName === value.customerName && row.inboundOrder === value.inboundOrder && row.note === value.note);
      assertStockInventoryUnit({inventoryUnit:match?.inventoryUnit,totalQuantity:value.totalQuantity});
      if(value.totalQuantity===0&&value.totalBoxes===0){value.palletCount=0;value.palletLabel='0';}
      else if(match&&missingPallets[index]){value.palletCount=match.palletCount;value.palletLabel=match.palletLabel;}
      if (!match) {
        insertRows.push(value);
        continue;
      }
      const changed = match.inboundDate !== value.inboundDate || match.barcode !== value.barcode || match.sku !== value.sku || match.totalQuantity !== value.totalQuantity || match.totalBoxes !== value.totalBoxes || match.customerName !== value.customerName || match.palletCount !== value.palletCount || match.palletLabel !== value.palletLabel || match.layerCount !== value.layerCount;
      if (!changed) {
        skipped += 1;
        continue;
      }
      queries.push(db.update(stocks).set({...value,version:match.version+1}).where(eq(stocks.id, match.id)));
      updated += 1;
    }

    for (let index = 0; index < insertRows.length; index += 25) {
      queries.push(db.insert(stocks).values(insertRows.slice(index, index + 25)));
    }

    queries.push(db.delete(goodsTransactionGuards).where(eq(goodsTransactionGuards.id,guardId)));
    await db.batch(queries as [BatchItem<"sqlite">,...BatchItem<"sqlite">[]]);
    await recordAudit(auth.user!, "纸质转线上", "库存", "2026正式迁移", `导入${insertRows.length}条，校正${updated}条，跳过重复${skipped}条`);
    return Response.json({ ok: true, imported: insertRows.length, updated, skipped, total: normalized.length });
  } catch (error) { if(error instanceof GoodsFlowError||/goods_transaction_guards|CHECK constraint failed: valid/.test(String(error)))return goodsResponseError(error); if (isLocationRenameConflict(error)) return Response.json({ error: "库位名称已更新或库存刚有变化，请刷新重试" }, { status: 409 });
    return Response.json({ error: error instanceof Error ? error.message : "批量导入失败" }, { status: 400 });
  }
}
