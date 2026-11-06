import { env } from "cloudflare:workers";
import { inventoryIntegration } from "../../../../lib/inventory-integration";

export async function GET(request: Request) {
 return inventoryIntegration(request, env as unknown as Parameters<typeof inventoryIntegration>[1]);
}
