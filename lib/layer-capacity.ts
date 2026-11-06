// layerCount is a shelf number, never a quantity to add across stock rows.
export function defaultLayerCapacity(code: string): number {
  const name = code.trim().toUpperCase();
  if (name.includes('通道')) return 1;
  const match = /^(?:新)?([ABCDE])(\d+)$/.exec(name);
  if (!match) return 0;
  const [,zone,raw] = match, n = Number(raw);
  if (n < 1) return 0;
  if ((zone === 'A' && n <= 38) || (zone === 'B' && n <= 32) || (zone === 'C' && n >= 11 && n <= 34)) return 2;
  if (zone === 'D' && n <= 32) return 3;
  if ((zone === 'C' && n <= 10) || (zone === 'E' && n <= 6)) return 4;
  return 0;
}
export function layerCapacity(box: { capacityLayers?: number } | undefined, code: string) {
  return box?.capacityLayers === undefined ? defaultLayerCapacity(code) : Math.max(0, Math.floor(Number(box.capacityLayers) || 0));
}
export function layerUsage(items: readonly { layerCount?: number }[], capacity: number) {
  const layers = [...new Set(items.map(item => Number.isSafeInteger(item.layerCount) && Number(item.layerCount) > 0 ? Number(item.layerCount) : 1))].sort((a,b)=>a-b);
  const occupied = layers.length, inRange = layers.filter(n=>n<=capacity).length;
  const unlimited = capacity === 0, over = !unlimited && layers.some(n=>n>capacity), full = !unlimited && inRange === capacity;
  return { layers, occupied, inRange, remaining: unlimited ? null : Math.max(0,capacity-inRange), unlimited, over, full, state: !occupied ? 'empty' : unlimited ? 'unlimited' : over ? 'over' : full ? 'full' : 'used' };
}
