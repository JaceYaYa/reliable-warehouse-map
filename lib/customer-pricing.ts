export const CUSTOMER_PRICING_KEY_PREFIX = "pricing_customer_override:";

export type CustomerPricingProfile = {
  customerName: string;
  ratePerM3Day: number | null;
  freeDays: number | null;
  updatedAt?: string;
  updatedBy?: string;
};

type SettingsRow = {
  key: string;
  value: string;
};

export function normalizeCustomerName(value: unknown) {
  return String(value ?? "").trim();
}

export function customerPricingKey(customerName: unknown) {
  return `${CUSTOMER_PRICING_KEY_PREFIX}${normalizeCustomerName(customerName)}`;
}

export function normalizeCustomerPricingProfile(
  raw: unknown,
  fallbackCustomerName = "",
): CustomerPricingProfile {
  const source = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const customerName = normalizeCustomerName(source.customerName ?? fallbackCustomerName);
  const rawRate = source.ratePerM3Day;
  const parsedRate = rawRate === null || rawRate === undefined || String(rawRate).trim() === ""
    ? null
    : Number(rawRate);
  const ratePerM3Day = parsedRate !== null && Number.isFinite(parsedRate) && parsedRate >= 0 && parsedRate <= 1_000_000
    ? parsedRate
    : null;
  const rawFreeDays = source.freeDays;
  const parsedFreeDays = rawFreeDays === null || rawFreeDays === undefined || String(rawFreeDays).trim() === ""
    ? null
    : Number(rawFreeDays);
  const freeDays = parsedFreeDays !== null && Number.isSafeInteger(parsedFreeDays) && parsedFreeDays >= 0 && parsedFreeDays <= 36_500
    ? parsedFreeDays
    : null;
  return {
    customerName,
    ratePerM3Day,
    freeDays,
    updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : undefined,
    updatedBy: typeof source.updatedBy === "string" ? source.updatedBy : undefined,
  };
}

export function parseCustomerPricingProfile(
  value: string | undefined,
  fallbackCustomerName = "",
) {
  if (!value) return normalizeCustomerPricingProfile({}, fallbackCustomerName);
  try {
    return normalizeCustomerPricingProfile(JSON.parse(value) as unknown, fallbackCustomerName);
  } catch {
    return normalizeCustomerPricingProfile({}, fallbackCustomerName);
  }
}

export function customerPricingProfiles(rows: SettingsRow[]) {
  const profiles = new Map<string, CustomerPricingProfile>();
  for (const row of rows) {
    if (!row.key.startsWith(CUSTOMER_PRICING_KEY_PREFIX)) continue;
    const fallbackCustomerName = row.key.slice(CUSTOMER_PRICING_KEY_PREFIX.length);
    const profile = parseCustomerPricingProfile(row.value, fallbackCustomerName);
    if (profile.customerName) profiles.set(profile.customerName, profile);
  }
  return profiles;
}

export function effectiveCustomerPricing(input: {
  customerName: string;
  inboundDate: string;
  recordRatePerM3Day: number;
  recordFreeDays: number;
  profiles: Map<string, CustomerPricingProfile>;
}) {
  const profile = input.profiles.get(normalizeCustomerName(input.customerName));
  const customerRateApplied = profile?.ratePerM3Day !== null && profile?.ratePerM3Day !== undefined;
  const customerFreeDaysApplied = profile?.freeDays !== null && profile?.freeDays !== undefined;
  return {
    ratePerM3Day: customerRateApplied ? profile.ratePerM3Day! : input.recordRatePerM3Day,
    freeDays: customerFreeDaysApplied ? profile.freeDays! : input.recordFreeDays,
    customerRateOverride: customerRateApplied ? profile.ratePerM3Day! : null,
    customerFreeDaysOverride: customerFreeDaysApplied ? profile.freeDays! : null,
    customerPricingApplied: customerRateApplied || customerFreeDaysApplied,
  };
}
