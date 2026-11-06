type InventoryDB = { prepare(sql: string): { bind(...args: unknown[]): { all(): Promise<{results: Record<string, unknown>[]}> } } };
const reply = (data: unknown, status = 200) => Response.json(data, {status, headers: {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"}});
// This integration deliberately selects operational fields only, never billing or account data.
const projection = `s.id AS stockId, s.catalog_item_id AS catalogItemId, s.product,
 coalesce(nullif(s.sku,''),c.sku) AS sku, s.fnsku, s.barcode, s.customer_name AS customerName, s.location_code AS locationCode,
 s.total_quantity AS totalQuantity, s.total_boxes AS totalBoxes,
 s.pallet_count AS palletCount, s.pallet_label AS palletLabel, s.layer_count AS layerCount,
 s.inbound_date AS inboundDate, s.inbound_order AS inboundOrder,
 s.inbound_source AS inboundSource, s.updated_at AS updatedAt, s.version`;

export async function inventoryIntegration(request: Request, env: {DB: InventoryDB; WORKORDER_INVENTORY_TOKEN?: string}) {
 if (request.method !== "GET") return reply({error: "仅支持库存查询。"}, 405);
 const secret = env.WORKORDER_INVENTORY_TOKEN;
 if (!secret || secret.length < 32) return reply({error: "库存连接尚未配置。"}, 503);
 const supplied = request.headers.get("Authorization") || "";
 if (supplied.length > 512) return reply({error: "库存连接未授权。"}, 401);
 const hash = async (value: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
 const [a, b] = await Promise.all([hash(supplied), hash("Bearer " + secret)]);
 let different = 0; for (let i = 0; i < a.length; i++) different |= a[i] ^ b[i];
 if (different) return reply({error: "库存连接未授权。"}, 401);
 const params = new URL(request.url).searchParams, conditions: string[] = [], args: unknown[] = [];
 const q = (params.get("q") || "").trim();
 const after = params.get("after") || "0", limit = params.get("limit") || "30";
 if (q.length > 120 || !/^\d{1,12}$/.test(after) || !/^\d{1,2}$/.test(limit) || +limit < 1 || +limit > 50) return reply({error: "查询条件无效。"}, 400);
 for (const [key, column] of Object.entries({stockId: "s.id", barcode: "s.barcode", sku: "coalesce(nullif(s.sku,''),c.sku)", fnsku: "s.fnsku", locationCode: "s.location_code", customerName: "s.customer_name"})) {
  if (!params.has(key)) continue;
  const value = params.get(key)!.trim();
  if (!value || value.length > 200 || (key === "stockId" && !/^[1-9]\d{0,11}$/.test(value))) return reply({error: "查询条件无效。"}, 400);
  conditions.push(`${column} = ?`); args.push(key === "stockId" ? +value : value);
 }
 if (q) {
  conditions.push("(" + ["s.product", "s.barcode", "coalesce(nullif(s.sku,''),c.sku)", "s.fnsku", "s.location_code", "s.customer_name"].map(column => `instr(lower(coalesce(${column},'')), lower(?)) > 0`).join(" OR ") + ")");
  args.push(q, q, q, q, q, q);
 }
 // Require a query; do not download every warehouse record on page load.
 if (!conditions.length) return reply({schemaVersion: 1, fetchedAt: new Date().toISOString(), stocks: [], nextAfter: null});
 conditions.push("s.id > ?"); args.push(+after, +limit + 1);
 try {
  const rows = await env.DB.prepare(`SELECT ${projection} FROM stocks s LEFT JOIN pricing_catalog_items c ON c.id = s.catalog_item_id WHERE ${conditions.join(" AND ")} ORDER BY s.id ASC LIMIT ?`).bind(...args).all();
  const stocks = rows.results.slice(0, +limit);
  return reply({schemaVersion: 1, fetchedAt: new Date().toISOString(), stocks, nextAfter: rows.results.length > +limit ? stocks.at(-1)!.stockId : null});
 } catch { return reply({error: "库存暂时无法读取，请稍后重试。"}, 503); }
}
