import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { settings as settingsTable } from "../../../../db/schema";
import { withJsonErrors } from "../../../../lib/api-json";
import {saveAuditedPricingSetting} from "../../../../lib/admin-setting-undo";
import { requireUser } from "../../../../lib/auth";
import {
  DEFAULT_PRICING_SETTINGS,
  normalizePricingSettings,
  numberValue,
  PRICING_DEFAULTS_KEY,
  type PricingSettings,
} from "../../../../lib/pricing";

type StoredPricingSettings = PricingSettings & {
  updatedAt?: string;
  updatedBy?: string;
};

function parseStoredSettings(value: string | undefined): StoredPricingSettings {
  if (!value) return { ...DEFAULT_PRICING_SETTINGS };
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return {
      ...normalizePricingSettings(parsed),
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : undefined,
      updatedBy: typeof parsed.updatedBy === "string" ? parsed.updatedBy : undefined,
    };
  } catch {
    // A malformed legacy setting must not prevent the pricing page from opening.
    return { ...DEFAULT_PRICING_SETTINGS };
  }
}

async function readPricingSettings() {
  const [row] = await getDb().select().from(settingsTable)
    .where(eq(settingsTable.key, PRICING_DEFAULTS_KEY)).limit(1);
  return parseStoredSettings(row?.value);
}

export async function GET(request: Request) {
  return withJsonErrors(async () => {
    const auth = await requireUser(request,"pricing.manage"); if (auth.error) return auth.error;
    return Response.json(
      { ok: true, settings: await readPricingSettings() },
      { headers: { "cache-control": "no-store" } },
    );
  }, "默认计价设置读取失败，请稍后重试");
}

export async function PATCH(request: Request) {
  return withJsonErrors(async () => {
    const auth = await requireUser(request,"pricing.manage"); if (auth.error) return auth.error;
    const raw = await request.json() as Record<string, unknown>;
    const body = raw.settings && typeof raw.settings === "object"
      ? raw.settings as Record<string, unknown>
      : raw;
    const hasRate = Object.prototype.hasOwnProperty.call(body, "defaultRatePerM3Day");
    const hasFreeDays = Object.prototype.hasOwnProperty.call(body, "defaultFreeDays");
    if (!hasRate && !hasFreeDays) {
      return Response.json({ ok: false, error: "请填写默认单价或免租天数" }, { status: 400 });
    }

    const [expectedRow] = await getDb().select().from(settingsTable).where(eq(settingsTable.key,PRICING_DEFAULTS_KEY)).limit(1);
    const before = parseStoredSettings(expectedRow?.value);
    const rate = hasRate
      ? numberValue(body.defaultRatePerM3Day, Number.NaN)
      : before.defaultRatePerM3Day;
    const freeDays = hasFreeDays
      ? numberValue(body.defaultFreeDays, Number.NaN)
      : before.defaultFreeDays;
    if (!Number.isFinite(rate) || rate < 0 || rate > 1_000_000) {
      return Response.json({ ok: false, error: "默认单价必须是大于或等于0的有效数字" }, { status: 400 });
    }
    if (!Number.isFinite(freeDays) || freeDays < 0 || freeDays > 36_500) {
      return Response.json({ ok: false, error: "免租天数必须是0到36500之间的有效数字" }, { status: 400 });
    }

    const updatedAt = new Date().toISOString();
    const next: StoredPricingSettings = {
      defaultRatePerM3Day: rate,
      defaultFreeDays: Math.floor(freeDays),
      updatedAt,
      updatedBy: auth.user!.displayName,
    };
    const value = JSON.stringify(next);
    await saveAuditedPricingSetting(auth.user!,{key:PRICING_DEFAULTS_KEY,value,expectedRow:expectedRow??null,stamp:updatedAt,action:"修改默认仓储计价",entityType:"计价设置",entityId:PRICING_DEFAULTS_KEY,summary:`默认单价 $${before.defaultRatePerM3Day} → $${next.defaultRatePerM3Day}；免租 ${before.defaultFreeDays}天 → ${next.defaultFreeDays}天`});
    return Response.json({ ok: true, settings: next });
  }, "默认计价设置保存失败，请稍后重试");
}
