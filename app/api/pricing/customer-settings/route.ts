import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { settings } from "../../../../db/schema";
import { withJsonErrors } from "../../../../lib/api-json";
import {saveAuditedPricingSetting} from "../../../../lib/admin-setting-undo";
import { requireUser } from "../../../../lib/auth";
import {
  customerPricingKey,
  normalizeCustomerName,
  parseCustomerPricingProfile,
  type CustomerPricingProfile,
} from "../../../../lib/customer-pricing";

async function readCustomerPricing(customerName: string) {
  const [row] = await getDb().select().from(settings)
    .where(eq(settings.key, customerPricingKey(customerName))).limit(1);
  return parseCustomerPricingProfile(row?.value, customerName);
}

function rateLabel(value: number | null) {
  return value === null ? "继承货物价格" : `$${value}/m³/天`;
}

function freeDaysLabel(value: number | null) {
  return value === null ? "继承货物免租天数" : `${value}天`;
}

export async function GET(request: Request) {
  return withJsonErrors(async () => {
    const auth = await requireUser(request,"pricing.manage"); if (auth.error) return auth.error;
    const customerName = normalizeCustomerName(new URL(request.url).searchParams.get("customer"));
    if (!customerName) {
      return Response.json({ ok: false, error: "请先选择客户" }, { status: 400 });
    }
    return Response.json(
      { ok: true, profile: await readCustomerPricing(customerName) },
      { headers: { "cache-control": "no-store" } },
    );
  }, "客户计价规则读取失败，请稍后重试");
}

export async function PATCH(request: Request) {
  return withJsonErrors(async () => {
    const auth = await requireUser(request,"pricing.manage"); if (auth.error) return auth.error;
    const body = await request.json() as Record<string, unknown>;
    const customerName = normalizeCustomerName(body.customerName);
    if (!customerName || customerName.length > 500) {
      return Response.json({ ok: false, error: "请选择有效的客户" }, { status: 400 });
    }

    const rawRate = body.ratePerM3Day;
    const ratePerM3Day = rawRate === null || rawRate === undefined || String(rawRate).trim() === ""
      ? null
      : Number(rawRate);
    if (ratePerM3Day !== null && (!Number.isFinite(ratePerM3Day) || ratePerM3Day < 0 || ratePerM3Day > 1_000_000)) {
      return Response.json({ ok: false, error: "客户单价必须是大于或等于0的有效数字，留空则继承货物价格" }, { status: 400 });
    }

    const rawFreeDays = body.freeDays;
    const freeDays = rawFreeDays === null || rawFreeDays === undefined || String(rawFreeDays).trim() === ""
      ? null
      : Number(rawFreeDays);
    if (freeDays !== null && (!Number.isSafeInteger(freeDays) || freeDays < 0 || freeDays > 36_500)) {
      return Response.json({ ok: false, error: "免租天数必须是0到36500之间的整数，留空则继承货物设置" }, { status: 400 });
    }

    const key = customerPricingKey(customerName);
    const [expectedRow] = await getDb().select().from(settings).where(eq(settings.key,key)).limit(1);
    const before = parseCustomerPricingProfile(expectedRow?.value,customerName);
    const updatedAt = new Date().toISOString();
    const next: CustomerPricingProfile = {
      customerName,
      ratePerM3Day,
      freeDays,
      updatedAt,
      updatedBy: auth.user!.displayName,
    };

    await saveAuditedPricingSetting(auth.user!,{key,expectedRow:expectedRow??null,value:ratePerM3Day === null && freeDays === null?null:JSON.stringify(next),stamp:updatedAt,action:ratePerM3Day === null && freeDays === null?"清除客户仓储计价":"修改客户仓储计价",entityType:"客户计价设置",entityId:customerName,summary:`${customerName}｜单价 ${rateLabel(before.ratePerM3Day)} → ${rateLabel(ratePerM3Day)}｜免租天数 ${freeDaysLabel(before.freeDays)} → ${freeDaysLabel(freeDays)}`});
    return Response.json({ ok: true, profile: next });
  }, "客户计价规则保存失败，请稍后重试");
}
