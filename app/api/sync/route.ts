import { env } from "cloudflare:workers";
import { requireUser } from "../../../lib/auth";
import { readWarehouseSync } from "../../../lib/warehouse-sync-read";

export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  try {
    const payload = await readWarehouseSync(env.DB, auth.user!, new URL(request.url).searchParams);
    return Response.json(payload, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return Response.json({ error: "同步暂不可用，请稍后重试" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
