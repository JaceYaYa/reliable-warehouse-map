import {loadStockPalletMetadata,projectStockPallets,stockStoredImage} from '../../../lib/stock-pallets';
import {palletManualKey} from '../../../lib/automatic-pallets';
import {sql} from 'drizzle-orm';
import {isLayerStoragePricing} from '../../../lib/storage-pricing-basis';
import {warehouseTodayDate} from '../../../lib/warehouse-time';
import { hasPermission, redactWarehousePricing, type PermissionUser } from "../../../lib/permissions";
import { loadLocationAliases } from "../../../lib/location-alias-store";
import { isLocationRenameConflict, resolveLocationAlias } from "../../../lib/location-aliases";
import { and, desc, eq } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { getDb } from "../../../db";
import { auditLogs, pricingCatalogItems, stocks, storageFeeSettlements, settings as settingsTable } from "../../../db/schema";
import { requireUser, requireWriteUser } from "../../../lib/auth";
import { palletLabel, palletCountValue, palletCountExceeds, palletRemaining } from "../../../lib/pallet";
import { clearsReturnPackaging } from "../../../lib/return-packaging";
import { calculateStorageFee, normalizePricingSettings, PRICING_DEFAULTS_KEY, inboundSourceLabel, normalizeBillingMode, normalizeInboundSource, numberValue } from "../../../lib/pricing";

import { goodsInventoryWritePlan } from "../../../lib/goods-inventory-guard";
import { GoodsFlowError } from "../../../lib/goods-flow";
import { goodsResponseError } from "../../../lib/goods-store";
import { stockProductDetails, stockProductLabel } from "../../../lib/stock-product";

type StockRow = typeof stocks.$inferSelect;
type CatalogRow = typeof pricingCatalogItems.$inferSelect;
type PricingSnapshot = ReturnType<typeof pricingSnapshot>;

const batchTuple = (queries: BatchItem<"sqlite">[]) => queries as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]];

function field(payload: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) if (payload[key] !== undefined && payload[key] !== null) return payload[key];
  return undefined;
}

function hasField(payload: Record<string, unknown>, ...keys: string[]) {
  return keys.some((key) => Object.prototype.hasOwnProperty.call(payload, key));
}

function validDateOnly(value: unknown) {
  const text = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const parsed = new Date(`${text}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text ? text : null;
}

function chinaToday() {
  return warehouseTodayDate();
}

const identity = (value: unknown) => String(value ?? "").trim().toLocaleLowerCase();

async function catalogFromPayload(payload: Record<string, unknown>, before?: StockRow) {
  const provided = hasField(payload, "catalogItemId", "pricingCatalogId");
  const rawId = field(payload, "catalogItemId", "pricingCatalogId");
  if (!provided) return { catalog: null, error: null, provided: false };
  if (rawId === undefined || rawId === "" || rawId === 0 || rawId === "0") return { catalog: null, error: null, provided: true };
  const id = Number(rawId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return { catalog: null, error: Response.json({ error: "合作商家货物编号无效" }, { status: 400 }), provided: true };
  }
  const [catalog] = await getDb().select().from(pricingCatalogItems).where(eq(pricingCatalogItems.id, id));
  if (!catalog) return { catalog: null, error: Response.json({ error: "所选合作商家货物不存在" }, { status: 404 }), provided: true };
  if (before?.catalogItemId && before.catalogItemId !== catalog.id) {
    return { catalog: null, error: Response.json({ error: "该库存已绑定其他合作商家货物，不能跨货物切换" }, { status: 409 }), provided: true };
  }
  if (before && !before.catalogItemId) {
    for (const key of ["sku"] as const) {
      if (identity(before[key]) && identity(catalog[key]) && identity(before[key]) !== identity(catalog[key])) return { catalog: null, error: Response.json({ error: `所选合作商家货物的 ${key.toUpperCase()} 与当前库存不一致` }, { status: 409 }), provided: true };
    }
    const stockBarcode = identity(before.barcode), catalogBarcode = identity(catalog.barcode);
    const sameBarcode = !!stockBarcode && !!catalogBarcode && stockBarcode === catalogBarcode;
    if (stockBarcode && catalogBarcode && !sameBarcode) {
      return { catalog: null, error: Response.json({ error: "所选合作商家货物的条码与当前库存不一致" }, { status: 409 }), provided: true };
    }
    if (!sameBarcode) {
      const stockProduct = identity(before.product), stockCustomer = identity(before.customerName);
      const catalogProduct = identity(catalog.product), catalogCustomer = identity(catalog.customerName);
      if (!stockProduct || !stockCustomer || !catalogProduct || !catalogCustomer || stockProduct !== catalogProduct || stockCustomer !== catalogCustomer) {
        return { catalog: null, error: Response.json({ error: "当前库存没有可核对的相同条码，产品名称和客户名称也未与目录同时匹配" }, { status: 409 }), provided: true };
      }
    }
  }
  return { catalog, error: null, provided: true };
}

function pricingSnapshot(payload: Record<string, unknown>, before: StockRow | undefined, catalog: CatalogRow | null, catalogProvided = false) {
  const inboundSource = normalizeInboundSource(field(payload, "inboundSource", "sourceType") ?? before?.inboundSource ?? "domestic");
  const billingMode = normalizeBillingMode(field(payload, "billingMode", "pricingMode") ?? catalog?.defaultBillingMode ?? before?.billingMode ?? "item");
  return {
    inboundSource,
    billingMode,
    itemVolumeM3: Math.max(0, numberValue(field(payload, "itemVolumeM3", "unitVolumeM3") ?? catalog?.itemVolumeM3 ?? before?.itemVolumeM3 ?? 0)),
    boxVolumeM3: Math.max(0, numberValue(field(payload, "boxVolumeM3", "cartonVolumeM3") ?? catalog?.boxVolumeM3 ?? before?.boxVolumeM3 ?? 0)),
    storageRateUsd: Math.max(0, numberValue(field(payload, "storageRateUsd", "ratePerM3Day", "rateUsdM3Day") ?? catalog?.rateUsdM3Day ?? before?.storageRateUsd ?? 0.7, 0.7)),
    freeDays: Math.max(0, Math.floor(numberValue(field(payload, "freeDays") ?? catalog?.freeDays ?? before?.freeDays ?? 0))),
    catalogItemId: catalog?.id ?? (catalogProvided ? null : before?.catalogItemId ?? null),
  };
}

async function warehousePricing(payload:Record<string,unknown>,before:StockRow|undefined,catalog:CatalogRow|null,catalogProvided:boolean,user:PermissionUser){
  const pricing=pricingSnapshot(payload,before,catalog,catalogProvided);
  if(hasPermission(user,'pricing.manage'))return {pricing,error:null};
  let storageRateUsd=before?.storageRateUsd??catalog?.rateUsdM3Day,freeDays=before?.freeDays??catalog?.freeDays;
  if(storageRateUsd===undefined||freeDays===undefined){
    const [row]=await getDb().select().from(settingsTable).where(eq(settingsTable.key,PRICING_DEFAULTS_KEY)).limit(1);
    let defaults=normalizePricingSettings({});try{if(row)defaults=normalizePricingSettings(JSON.parse(row.value));}catch{/* use configured fallback defaults */}
    storageRateUsd??=defaults.defaultRatePerM3Day;freeDays??=defaults.defaultFreeDays;
  }
  const fields=[['storageRateUsd',storageRateUsd],['ratePerM3Day',storageRateUsd],['rateUsdM3Day',storageRateUsd],['freeDays',freeDays]] as const;
  if(fields.some(([key,value])=>hasField(payload,key)&&(payload[key]===null||payload[key]===''||!Number.isFinite(Number(payload[key]))||Number(payload[key])!==value)))return {pricing,error:Response.json({error:'当前账号不能修改计价单价或免租规则'},{status:403})};
  return {pricing:{...pricing,storageRateUsd,freeDays},error:null};
}

function pricingValidationError(pricing: PricingSnapshot, quantity: number, boxes: number, context: string) {
  if (pricing.inboundSource !== "return") return null;
  if (pricing.billingMode === "box") {
    if (!(boxes > 0)) return `${context}按箱计费时，箱数必须大于0`;
    return null;
  }
  if (!(quantity > 0)) return `${context}按件计费时，件数必须大于0`;
  return null;
}

function auditValue(
  user: { id: number; displayName: string }, operationId: string, action: string,
  entityId: string, summary: string, createdAt: string,
  before: StockRow | null, after: StockRow | null, snapshotReady = true,
) {
  // Fixed counts need only the original stored facts; automatic snapshots retain their mode for undo.
  if(before&&(before as StockRow&{palletAutomatic?:boolean}).palletAutomatic===false)before=stockStoredImage(before);
  if(after&&(after as StockRow&{palletAutomatic?:boolean}).palletAutomatic===false)after=stockStoredImage(after);
  return {
    userId: user.id, userName: user.displayName, action, entityType: "库位", entityId, operationId, summary,
    beforeSnapshot: snapshotReady ? JSON.stringify(before) : null,
    afterSnapshot: snapshotReady ? JSON.stringify(after) : null,
    createdAt,
  };
}

function settlementValue(input: {
  stock: StockRow;
  pricing: PricingSnapshot;
  quantity: number;
  boxes: number;
  outboundAt: string;
  operatedBy: string;
  operationId: string;
  stockUpdatedAtAfter: string;
}) {
  if (input.quantity <= 0 && input.boxes <= 0) return null;
  const calc = calculateStorageFee({
    inboundDate: input.stock.inboundDate, endDate: input.outboundAt.slice(0, 10), billingMode: input.pricing.billingMode,
    quantity: input.quantity, boxes: input.boxes, itemVolumeM3: input.pricing.itemVolumeM3,
    boxVolumeM3: input.pricing.boxVolumeM3, rateUsdM3Day: input.pricing.storageRateUsd, freeDays: input.pricing.freeDays,
  });
  const chargeable = input.pricing.inboundSource === "return";
  return {
    stockId: input.stock.id, operationId: input.operationId, catalogItemId: input.pricing.catalogItemId,
    locationCode: input.stock.locationCode, inboundSource: input.pricing.inboundSource, billingMode: input.pricing.billingMode,
    product: stockProductLabel(input.stock), sku: input.stock.sku, fnsku: input.stock.fnsku, barcode: input.stock.barcode, inboundOrder: input.stock.inboundOrder,
    customerName: input.stock.customerName, inboundDate: input.stock.inboundDate, outboundAt: input.outboundAt,
    quantity: input.quantity, boxes: input.boxes, itemVolumeM3: input.pricing.itemVolumeM3,
    boxVolumeM3: input.pricing.boxVolumeM3, rateUsdM3Day: input.pricing.storageRateUsd, freeDays: input.pricing.freeDays,
    storageDays: calc.storageDays, billableDays: calc.billableDays, totalVolumeM3: calc.totalVolumeM3,
    feeUsd: chargeable ? calc.feeUsd : 0,
    settlementStatus: chargeable ? "pending" : "settled",
    settledAt: chargeable ? null : input.stockUpdatedAtAfter,
    settledBy: chargeable ? null : input.operatedBy,
    version: 0,
    previousInboundSource: input.stock.inboundSource, previousBillingMode: input.stock.billingMode,
    previousItemVolumeM3: input.stock.itemVolumeM3, previousBoxVolumeM3: input.stock.boxVolumeM3,
    previousStorageRateUsd: input.stock.storageRateUsd, previousFreeDays: input.stock.freeDays,
    previousCatalogItemId: input.stock.catalogItemId, stockUpdatedAtBefore: input.stock.updatedAt,
    stockUpdatedAtAfter: input.stockUpdatedAtAfter,
    operatedBy: input.operatedBy, createdAt: input.stockUpdatedAtAfter,
  } satisfies typeof storageFeeSettlements.$inferInsert;
}

export async function GET(request: Request) {
  const auth = await requireUser(request); if (auth.error) return auth.error;
  try { return Response.json(redactWarehousePricing({ stocks: projectStockPallets(await getDb().select().from(stocks).orderBy(desc(stocks.updatedAt)),await loadStockPalletMetadata(getDb().$client)) },auth.user!)); }
  catch (error) { if (isLocationRenameConflict(error)) return Response.json({ error: "库位名称已更新或库存刚有变化，请刷新重试" }, { status: 409 }); return Response.json({ error: error instanceof Error ? error.message : "读取失败" }, { status: 500 }); }
}

export async function POST(request: Request) {
  const auth = await requireWriteUser(request); if (auth.error) return auth.error;
  try {
    const p = await request.json() as Record<string, unknown>, db = getDb(), id = Number(p.id || 0);
    if (!hasPermission(auth.user!,id?"stock.edit":"stock.inbound")) return Response.json({error:"没有此库存操作权限"},{status:403});
    const [before] = id ? await db.select().from(stocks).where(eq(stocks.id, id)) : [];
    if(before && p.version!==undefined && p.version!==before.version) return Response.json({error:"这条库存已被其他人修改，请刷新后重新核对；填写内容仍保留"},{status:409});
    const catalogResult = await catalogFromPayload(p, before);
    if (catalogResult.error) return catalogResult.error;
    const catalog = catalogResult.catalog, checkedPricing = await warehousePricing(p,before,catalog,catalogResult.provided,auth.user!);
    if(checkedPricing.error)return checkedPricing.error;const pricing=checkedPricing.pricing;
    const locationCode = resolveLocationAlias(String(p.locationCode ?? before?.locationCode ?? ""), await loadLocationAliases());
    const rawProduct = String(catalog?.product ?? field(p, "product", "productName") ?? before?.product ?? "").trim();
    if (p.productCondition!==undefined && !["","good","damaged"].includes(String(p.productCondition))) return Response.json({error:"请选择正品或残次品"},{status:400});
    const details=stockProductDetails({product:rawProduct,productPrefix:String(p.productPrefix??before?.productPrefix??""),productCondition:String(p.productCondition??before?.productCondition??"")});
    if(details.prefix.length>500)return Response.json({error:"附加标记过长"},{status:400});
    const product=details.name;
    if (!locationCode || !product) return Response.json({ error: "库位和产品不能为空" }, { status: 400 });
    if (before && locationCode !== before.locationCode) {
      return Response.json({ error: "已有货物不能通过保存修改更换库位，请使用“移动货物”功能" }, { status: 400 });
    }
    const inboundDate = validDateOnly(p.inboundDate ?? before?.inboundDate);
    if (!inboundDate) return Response.json({ error: "入库日期格式不正确" }, { status: 400 });
    if (inboundDate > chinaToday()) return Response.json({ error: "入库日期不能晚于今天" }, { status: 400 });
    if(p.palletManual!==undefined&&typeof p.palletManual!=='boolean')return Response.json({error:'托盘设置标记不正确'},{status:400});
    const palletMetadata=await loadStockPalletMetadata(db.$client);
    const effectiveRows=before?projectStockPallets(await db.select().from(stocks),palletMetadata):[];
    const effectiveBefore=effectiveRows.find(row=>row.id===before?.id);
    const preserveAutomatic=!!before&&effectiveBefore?.palletAutomatic&&p.palletManual!==true&&(p.palletCount===undefined||palletCountValue(p.palletCount)===effectiveBefore.palletCount);
    const rawPallet = p.palletCount===undefined?String(before?.palletCount??((Number(p.totalQuantity)>0||Number(p.totalBoxes)>0)?1:0)):p.palletCount;
    const parsedPallet = preserveAutomatic?before!.palletCount:palletCountValue(rawPallet,before?.palletCount??((Number(p.totalQuantity)>0||Number(p.totalBoxes)>0)?1:0));
    if (!Number.isFinite(parsedPallet) || parsedPallet < 0) return Response.json({ error: "托盘数格式不正确，可填写 1、1/3、1/4、0.5" }, { status: 400 });
    const totalQuantity = Number(p.totalQuantity ?? before?.totalQuantity ?? 0);
    const totalBoxes = Number(p.totalBoxes ?? before?.totalBoxes ?? 0);
    const layerCount = Number(p.layerCount ?? before?.layerCount ?? 1);
    if (!Number.isFinite(totalQuantity) || totalQuantity < 0 || !Number.isFinite(totalBoxes) || totalBoxes < 0) {
      return Response.json({ error: "总数量和总箱数必须是大于或等于0的数字" }, { status: 400 });
    }
    if(before?.inventoryUnit==="box"&&totalQuantity!==0)return Response.json({error:"已确认箱库存不能填写件数；库存分类请通过箱库存核对处理"},{status:400});
    if (!Number.isSafeInteger(layerCount) || layerCount < 1) return Response.json({ error: "层数必须是大于或等于1的整数" }, { status: 400 });
    const value = {
      locationCode, inboundDate, product, productPrefix:details.prefix,productCondition:details.condition,
      sku: String(p.sku ?? catalog?.sku ?? before?.sku ?? "").trim(),
      fnsku: String(p.fnsku ?? catalog?.fnsku ?? before?.fnsku ?? "").trim(),
      barcode: String(p.barcode !== undefined ? p.barcode : catalog?.barcode ?? before?.barcode ?? ""),
      inboundOrder: String(p.inboundOrder ?? before?.inboundOrder ?? ""),
      totalQuantity, totalBoxes, inventoryUnit:before?.inventoryUnit??"item",inventoryReviewDecision:before?.inventoryReviewDecision??"",
      customerName: String(catalog?.customerName || p.customerName || before?.customerName || ""),
      palletCount: parsedPallet, palletLabel: preserveAutomatic?before!.palletLabel:palletLabel(parsedPallet, String(rawPallet)),
      layerCount,
      ...pricing, note: String(p.note ?? before?.note ?? ""), updatedBy: auth.user!.displayName, updatedAt: new Date().toISOString(),
      version: before ? before.version + 1 : 0,
    };
    if (id && !before) return Response.json({ error: "货物不存在" }, { status: 404 });
    const qtyDiff = value.totalQuantity - (before?.totalQuantity || 0), boxDiff = value.totalBoxes - (before?.totalBoxes || 0), palletDiff = value.palletCount - (before?.palletCount || 0);
    // This endpoint represents two explicit UI actions: creating inventory and
    // correcting an existing row. Outbound inventory only flows through PATCH
    // or DELETE, so corrections must never create an outbound settlement.
    const action = before ? "库存修改" : "入库";
    const metadataOnly=Boolean(before && ["totalQuantity","totalBoxes","inboundSource","billingMode","itemVolumeM3","boxVolumeM3","storageRateUsd","freeDays","catalogItemId","sku","customerName"].every(key=>value[key as keyof typeof value]===before[key as keyof StockRow]) && value.product===stockProductDetails(before).name);
    // Missing measurements do not block physical work. A partial pricing edit
    // must not replace an existing cost snapshot with a zero-volume basis.
    const pricingChanged=before&&["billingMode","itemVolumeM3","boxVolumeM3","storageRateUsd","freeDays","catalogItemId"].some(key=>value[key as keyof typeof value]!==before[key as keyof StockRow]);
    if(pricingChanged&&pricing.inboundSource==="return"&&!(pricing.billingMode==="box"?pricing.boxVolumeM3>0:pricing.itemVolumeM3>0))return Response.json({error:"计价资料尚未完整，不能用缺少体积的资料覆盖原计价批次；请在仓储计价核对"},{status:400});
    const stockPricingError = metadataOnly ? null : pricingValidationError(pricing, value.totalQuantity, value.totalBoxes, before ? "退货库存修改后的库存" : "退货入库");
    if (stockPricingError) return Response.json({ error: stockPricingError }, { status: 400 });
    const operationId = crypto.randomUUID(), stamp = value.updatedAt;
    const plannedAfter = before ? { ...before, ...value, id: before.id } satisfies StockRow : null;
    const goods=await goodsInventoryWritePlan([{before:before??null,after:plannedAfter??{...value,id:0}}],"edit",{preserveCostSnapshots:metadataOnly,user:auth.user!,expectedPalletSettings:palletMetadata.settings});
    const queries: BatchItem<"sqlite">[] = [id
      ? db.update(stocks).set(value).where(and(eq(stocks.id, id), eq(stocks.version, before!.version))).returning()
      : db.insert(stocks).values(value).returning()];
    if(p.palletManual===true||p.palletCount!==undefined&&(parsedPallet!==1||!!before&&!preserveAutomatic&&parsedPallet!==before.palletCount)){queries.push(db.insert(settingsTable).values({key:before?palletManualKey(before.id):sql<string>`'pallet_manual:stock:'||last_insert_rowid()`,value:'true',updatedAt:stamp}).onConflictDoUpdate({target:settingsTable.key,set:{value:'true',updatedAt:stamp}}));}
    const summary = before
      ? `${value.product}｜库存校正｜${inboundSourceLabel(pricing.inboundSource)}｜单号 ${value.inboundOrder || "—"}｜数量 ${before.totalQuantity}→${value.totalQuantity}｜箱数 ${before.totalBoxes}→${value.totalBoxes}｜结存 ${value.totalQuantity}件/${value.totalBoxes}箱`
      : `${value.product}｜${inboundSourceLabel(pricing.inboundSource)}｜单号 ${value.inboundOrder || "—"}｜数量 +${qtyDiff}｜箱数 +${boxDiff}｜结存 ${value.totalQuantity}件/${value.totalBoxes}箱`;
    queries.push(db.insert(auditLogs).values(auditValue(auth.user!, operationId, action, value.locationCode, summary, stamp, before ?? null, plannedAfter, !!before)));
    const results = await db.batch(batchTuple([...goods.drizzleGuard,...queries,...goods.drizzleAfterQueries]));
    const stock = (results[goods.drizzleGuard.length] as StockRow[])[0];
    if (!stock) {
      await db.delete(auditLogs).where(eq(auditLogs.operationId, operationId));
      return Response.json({ error: "该库存刚刚被其他账号修改，请刷新后重试" }, { status: 409 });
    }
    if (!before) {
      await db.update(auditLogs).set({ beforeSnapshot: JSON.stringify(null), afterSnapshot: JSON.stringify(stock) })
        .where(eq(auditLogs.operationId, operationId));
    }
    const projected=projectStockPallets(await db.select().from(stocks),await loadStockPalletMetadata(db.$client)).find(row=>row.id===stock.id)??stock;
    return Response.json(redactWarehousePricing({ stock:projected, settlement: null,dateDisplayOnly:goods.dateDisplayOnly },auth.user!));
  } catch (error) { if(error instanceof GoodsFlowError||/goods_transaction_guards|CHECK constraint failed: valid/.test(String(error)))return goodsResponseError(error); if (isLocationRenameConflict(error)) return Response.json({ error: "库位名称已更新或库存刚有变化，请刷新重试" }, { status: 409 }); return Response.json({ error: error instanceof Error ? error.message : "保存失败" }, { status: 500 }); }
}

export async function DELETE(request: Request) {
  try {
  const auth = await requireWriteUser(request,"stock.outbound"); if (auth.error) return auth.error;
  const id = Number(new URL(request.url).searchParams.get("id") || 0);
  if (!id) return Response.json({ error: "缺少货物编号" }, { status: 400 });
  const db = getDb(),before=projectStockPallets(await db.select().from(stocks),await loadStockPalletMetadata(db.$client)).find(row=>row.id===id);
  if (!before) return Response.json({ error: "货物不存在" }, { status: 404 });
  const layerPricing=await isLayerStoragePricing(db);
  const goods=await goodsInventoryWritePlan([{before,after:null}],"outbound");
  const pricing = pricingSnapshot({}, before, null);
  const pricingError = layerPricing?null:pricingValidationError(pricing, before.totalQuantity, before.totalBoxes, "退货出库");
  if (pricingError) return Response.json({ error: pricingError }, { status: 400 });
  const operationId = crypto.randomUUID(), stamp = new Date().toISOString();
  const settlementInput = layerPricing?null:settlementValue({ stock: before, pricing, quantity: before.totalQuantity, boxes: before.totalBoxes, outboundAt: stamp, operatedBy: auth.user!.displayName, operationId, stockUpdatedAtAfter: stamp });
  const queries: BatchItem<"sqlite">[] = [db.delete(stocks).where(and(eq(stocks.id, id), eq(stocks.version, before.version))).returning({ id: stocks.id })];
  const settlementIndex = settlementInput ? queries.push(db.insert(storageFeeSettlements).values(settlementInput).returning()) - 1 : -1;
  const auditBefore=layerPricing?{...before,physicalOutboundDate:warehouseTodayDate(new Date(stamp))}:before;
  queries.push(db.insert(auditLogs).values(auditValue(auth.user!, operationId, "出库", before.locationCode, `${before.product}｜${inboundSourceLabel(pricing.inboundSource)}｜单号 ${before.inboundOrder || "—"}｜数量 -${before.totalQuantity}｜箱数 -${before.totalBoxes}｜全部出库`, stamp, auditBefore, null)));
  const results = await db.batch(batchTuple([...goods.drizzleGuard,...queries,...goods.drizzleAfterQueries]));
  if (!(results[goods.drizzleGuard.length] as Array<{ id: number }>)[0]) {
    await db.batch(batchTuple([
      db.delete(storageFeeSettlements).where(eq(storageFeeSettlements.operationId, operationId)),
      db.delete(auditLogs).where(eq(auditLogs.operationId, operationId)),
    ]));
    return Response.json({ error: "该库存刚刚被其他账号修改，请刷新后重试" }, { status: 409 });
  }
  const settlement = settlementIndex >= 0 ? (results[goods.drizzleGuard.length+settlementIndex] as Array<typeof storageFeeSettlements.$inferSelect>)[0] : null;
  return Response.json(redactWarehousePricing({ ok: true,...(layerPricing?{pricingBasis:"layer"}:{}), pallets:before.palletCount, settlement },auth.user!));

  } catch (error) { if(error instanceof GoodsFlowError||/goods_transaction_guards|CHECK constraint failed: valid/.test(String(error)))return goodsResponseError(error); if (isLocationRenameConflict(error)) return Response.json({ error: "库位名称已更新或库存刚有变化，请刷新重试" }, { status: 409 }); throw error; }
}

export async function PATCH(request: Request) {
  try {
  const auth = await requireWriteUser(request,"stock.outbound"); if (auth.error) return auth.error;
  const p = await request.json() as Record<string, unknown>, id = Number(p.id || 0), rawQty = Number(p.quantity || 0), rawBoxes = Number(p.boxes || 0);
  const parsedPallets = palletCountValue(p.pallets);
  if (!Number.isFinite(rawQty) || rawQty < 0 || !Number.isFinite(rawBoxes) || rawBoxes < 0) return Response.json({ error: "请填写正确的出库件数和箱数" }, { status: 400 });
  if (!Number.isFinite(parsedPallets) || parsedPallets < 0) return Response.json({ error: "出库托盘数格式不正确，可填写 1/3、1/4、0.5" }, { status: 400 });
  const qty = rawQty, pallets = parsedPallets;
  if (!qty && !rawBoxes) return Response.json({ error: "出库件数或箱数至少填写一项" }, { status: 400 });
  const db = getDb(),before=projectStockPallets(await db.select().from(stocks),await loadStockPalletMetadata(db.$client)).find(row=>row.id===id);
  if (!before) return Response.json({ error: "货物不存在" }, { status: 404 });
  if (qty > before.totalQuantity || rawBoxes > before.totalBoxes || palletCountExceeds(pallets,before.palletCount)) return Response.json({ error: "出库件数或箱数不能超过当前库存" }, { status: 400 });
  const boxes = clearsReturnPackaging(before,qty)?before.totalBoxes:rawBoxes, automaticClearedBoxes=boxes-rawBoxes;
  const layerPricing=await isLayerStoragePricing(db);
  const goods=await goodsInventoryWritePlan([{before,after:null}],"outbound");
  const catalogResult = layerPricing?{catalog:null,error:null,provided:false}:await catalogFromPayload(p, before);
  if (catalogResult.error) return catalogResult.error;
  const catalog = catalogResult.catalog, checkedPricing = layerPricing?{pricing:pricingSnapshot({},before,null),error:null}:await warehousePricing(p,before,catalog,catalogResult.provided,auth.user!);
    if(checkedPricing.error)return checkedPricing.error;const pricing=checkedPricing.pricing;
  const nextQty = before.totalQuantity - qty, nextBoxes = before.totalBoxes - boxes, nextPallets = nextQty===0&&nextBoxes===0?0:palletRemaining(before.palletCount,pallets);
  const removed = nextQty === 0 && nextBoxes === 0;
  const pricingError = !layerPricing&&(qty || boxes) ? pricingValidationError(pricing, qty, boxes, "退货出库") : null;
  if (pricingError) return Response.json({ error: pricingError }, { status: 400 });
  if (!removed&&!layerPricing) {
    const remainingPricingError = pricingValidationError(pricing, nextQty, nextBoxes, "退货出库后的剩余库存");
    if (remainingPricingError) return Response.json({ error: remainingPricingError }, { status: 400 });
  }
  const outboundAtRaw = String(p.outboundAt || chinaToday()).trim();
  const outboundDate = validDateOnly(outboundAtRaw.slice(0, 10));
  if (!outboundDate) return Response.json({ error: "出库日期格式不正确" }, { status: 400 });
  if (outboundDate < before.inboundDate) return Response.json({ error: "出库日期不能早于入库日期" }, { status: 400 });
  if (outboundDate > chinaToday()) return Response.json({ error: "出库日期不能晚于今天" }, { status: 400 });
  const outboundAt = `${outboundDate}T23:59:59.000Z`;
  const operationId = crypto.randomUUID(), stamp = new Date().toISOString();
  const settlementInput = layerPricing?null:settlementValue({ stock: before, pricing, quantity: qty, boxes, outboundAt, operatedBy: auth.user!.displayName, operationId, stockUpdatedAtAfter: stamp });
  const automatic=before.palletAutomatic&&!removed&&pallets===0;
  const afterValue = {
    totalQuantity: nextQty, totalBoxes: nextBoxes, palletCount: automatic?before.palletRawCount??1:nextPallets, palletLabel: automatic?before.palletRawLabel??before.palletLabel:palletLabel(nextPallets),
    ...pricing, inboundSource: before.inboundSource, updatedBy: auth.user!.displayName, updatedAt: stamp, version: before.version + 1,
  };
  const plannedAfter = removed ? null : { ...before, ...afterValue, palletCount:nextPallets,palletLabel:palletLabel(nextPallets),palletAutomatic:automatic,palletManual:!automatic,palletRawCount:afterValue.palletCount,palletRawLabel:afterValue.palletLabel,id: before.id };
  const queries: BatchItem<"sqlite">[] = [removed
    ? db.delete(stocks).where(and(eq(stocks.id, id), eq(stocks.version, before.version))).returning({ id: stocks.id })
    : db.update(stocks).set(afterValue).where(and(eq(stocks.id, id), eq(stocks.version, before.version))).returning({ id: stocks.id })];
  const settlementIndex = settlementInput ? queries.push(db.insert(storageFeeSettlements).values(settlementInput).returning()) - 1 : -1;
  const auditBefore=layerPricing?{...before,physicalOutboundDate:outboundDate}:before;
  if(!removed)queries.push(db.insert(settingsTable).values({key:palletManualKey(before.id),value:JSON.stringify(!automatic),updatedAt:stamp}).onConflictDoUpdate({target:settingsTable.key,set:{value:JSON.stringify(!automatic),updatedAt:stamp}}));
  queries.push(db.insert(auditLogs).values(auditValue(auth.user!, operationId, "出库", before.locationCode, `${before.product}｜${inboundSourceLabel(pricing.inboundSource)}｜单号 ${before.inboundOrder || "—"}｜数量 -${qty}｜箱数 -${boxes}｜托盘 -${before.palletCount-nextPallets}｜结存 ${nextQty}件/${nextBoxes}箱`, stamp, auditBefore, plannedAfter)));
  const results = await db.batch(batchTuple([...goods.drizzleGuard,...queries,...goods.drizzleAfterQueries]));
  if (!(results[goods.drizzleGuard.length] as Array<{ id: number }>)[0]) {
    await db.batch(batchTuple([
      db.delete(storageFeeSettlements).where(eq(storageFeeSettlements.operationId, operationId)),
      db.delete(auditLogs).where(eq(auditLogs.operationId, operationId)),
    ]));
    return Response.json({ error: "该库存刚刚被其他账号修改，请刷新后重试" }, { status: 409 });
  }
  const settlement = settlementIndex >= 0 ? (results[goods.drizzleGuard.length+settlementIndex] as Array<typeof storageFeeSettlements.$inferSelect>)[0] : null;
  return Response.json(redactWarehousePricing({ ok: true,...(layerPricing?{pricingBasis:"layer"}:{}), removed, quantity:qty,boxes,automaticClearedBoxes,pallets:before.palletCount-nextPallets, settlement },auth.user!));

  } catch (error) { if(error instanceof GoodsFlowError||/goods_transaction_guards|CHECK constraint failed: valid/.test(String(error)))return goodsResponseError(error); if (isLocationRenameConflict(error)) return Response.json({ error: "库位名称已更新或库存刚有变化，请刷新重试" }, { status: 409 }); throw error; }
}

// Customer correction from pricing changes only this live stock row.
export async function PUT(request: Request) {
  const auth = await requireWriteUser(request, "stock.edit"); if (auth.error) return auth.error;
  if (!hasPermission(auth.user!, "pricing.manage")) return Response.json({ error: "没有计价管理权限" }, { status: 403 });
  try {
    const p = await request.json(), id = p.id, version = p.version;
    const customerName = typeof p.customerName === "string" ? p.customerName.trim() : "";
    if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(version) || version < 0 || !customerName || customerName.length > 200) {
      return Response.json({ error: "请选择货物并填写有效客户名称（最多200字）" }, { status: 400 });
    }
    const db = getDb();
    const [before] = await db.select().from(stocks).where(eq(stocks.id, id));
    if (!before) return Response.json({ error: "该货物已出库或不存在，请刷新" }, { status: 404 });
    if (before.version !== version) return Response.json({ error: "该库存已有变化，请刷新后重新编辑客户" }, { status: 409 });
    if (before.customerName === customerName) return Response.json({ stock: before });
    const stamp = new Date().toISOString(), operationId = crypto.randomUUID();
    const value = { customerName,catalogItemId:null, updatedAt: stamp, updatedBy: auth.user!.displayName, version: version + 1 };
    const after = { ...before, ...value };
    const goods=await goodsInventoryWritePlan([{before,after}],"edit",{user:auth.user!,preserveCostSnapshots:true});
    const results = await db.batch(batchTuple([
      ...goods.drizzleGuard,
      db.update(stocks).set(value).where(and(eq(stocks.id, id), eq(stocks.version, version))).returning(),
      db.insert(auditLogs).values(auditValue(auth.user!, operationId, "库存修改", before.locationCode,
        `${before.product}｜客户 ${before.customerName || "未填写"}→${customerName}`, stamp, before, after)),
      ...goods.drizzleAfterQueries,
    ]));
    const stock = (results[goods.drizzleGuard.length] as StockRow[])[0];
    if (!stock) {
      await db.delete(auditLogs).where(eq(auditLogs.operationId, operationId));
      return Response.json({ error: "该库存已有变化，请刷新后重新编辑客户" }, { status: 409 });
    }
    return Response.json({ stock });
  } catch (error) {
    if(error instanceof GoodsFlowError||/goods_transaction_guards|CHECK constraint failed: valid/.test(String(error)))return goodsResponseError(error);
    return Response.json({ error: error instanceof Error ? error.message : "客户保存失败" }, { status: 500 });
  }
}
