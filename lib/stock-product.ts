export type ProductCondition = "" | "good" | "damaged";
export type StockProduct = { product: string; productPrefix?: string; productCondition?: string };
const clean = (v = "") => v.normalize("NFKC").trim().replace(/\s+/g, " ");
const quality = (part: string): ProductCondition => /残次|次品|破损/.test(part) ? "damaged" : part === "正品" ? "good" : "";

// Strip only marked operational numbers and known warehouse prefixes, never model numbers or variants.
export function splitProductPrefix(value: string) {
  let name = clean(value); const parts: string[] = [];
  const numbered = "#\\d+(?:\\s*[-–—~～至]\\s*\\d+)*";
  const known = `左侧|右侧|左边|右边|残次品|次品|破损品|正品|${numbered}`;
  const pattern = new RegExp(`^(?:\\((${known})\\)\\s*|(${known.replace(`|${numbered}`, "")})\\s*[:：]?\\s*|(${numbered})(?=\\s|[:：]|左侧|右侧|左边|右边)\\s*[:：]?\\s*)`);
  for (let i = 0; i < 8; i++) {
    const match = name.match(pattern);
    if (!match || !name.slice(match[0].length).trim()) break;
    parts.push(match[1] || match[2] || match[3]); name = name.slice(match[0].length).trim();
  }
  return { name, prefix: parts.join(" · "), damaged: parts.some(p => quality(p) === "damaged"), parts };
}
export function stockProductDetails(stock: StockProduct) {
  const parsed = splitProductPrefix(stock.product);
  const condition: ProductCondition = stock.productCondition === "good" || stock.productCondition === "damaged" ? stock.productCondition : parsed.parts.map(quality).find(Boolean) || "";
  const prefix = clean(stock.productPrefix) || parsed.parts.filter(p => !quality(p)).join(" · ");
  const label = [condition === "damaged" ? "残次品" : condition === "good" ? "正品" : "", prefix].filter(Boolean).join(" · ");
  return { name: parsed.name, prefix, condition, label, damaged: condition === "damaged" };
}
export function stockProductLabel(stock: StockProduct) {
  const details = stockProductDetails(stock);
  return `${details.label ? `（${details.label}）` : ""}${details.name}`;
}
