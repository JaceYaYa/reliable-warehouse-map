import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { settings } from "../db/schema";
import { LOCATION_ALIASES_KEY, parseLocationAliases } from "./location-aliases";

export async function loadLocationAliases() {
  const [row] = await getDb().select({ value: settings.value }).from(settings).where(eq(settings.key, LOCATION_ALIASES_KEY)).limit(1);
  return parseLocationAliases(row?.value);
}
