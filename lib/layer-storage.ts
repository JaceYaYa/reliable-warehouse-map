import { locationCodeKey } from './location-code.ts';
import type { LocationAliases } from './location-aliases.ts';
import type { WarehouseZoneRecord } from './warehouse-layout.ts';

export const LAYER_PRICING_KEY = 'pricing_layer_storage_v1';
export type LayerRule = { volumeM3?: number; shares?: Array<{ customerName: string; percent: number }> };
export type LayerLocationConfig = { defaultVolumeM3?: number; layers: Record<string, LayerRule> };
export type LayerPricingConfig = { schemaVersion: 1; revision: number; locations: Record<string, LayerLocationConfig> };
export type LayerOccupant = {
  id: string; kind: 'stock' | 'carton'; locationCode: string; layer: number;
  customerName: string; inboundDate: string; productName: string; sku: string;
  physicalLocationCode?: string; physicalLayer?: number; stagingPricingReview?: string;
  physicalQuantity?:number;physicalBoxes?:number;sourcePhysicalId?:string;palletManual?:boolean;palletCount?:number;estimatedPallets?:boolean;billingSection?:'in_stock'|'shipped';
};
export type LayerOccupancy = {
  key: string; locationCode: string; layer: number; volumeM3: number; volumeSource: string;
  customers: Array<{ customerName: string; oldestInboundDate: string; products: string[]; recordIds: string[] }>;
  shares: Array<{ customerName: string; percent: number }> | null;
  reviewReasons: string[]; occupants: LayerOccupant[];
};
type VolumeResult = { volumeM3: number; volumeSource: 'layer' | 'location' | 'builtin-exception' | 'one-piece-zone' | 'default' };
type PlainRecord = Record<string, unknown>;
const prohibitedKeys = new Set(['__proto__', 'prototype', 'constructor']);

function fail(message: string): never { throw new Error(message); }
function nativePrototype(value: unknown, expected: object, constructor: ObjectConstructor | ArrayConstructor): boolean {
  if (!value || typeof value !== 'object') return false;
  const ctor = Object.getOwnPropertyDescriptor(value, 'constructor')?.value;
  const expectedKeys = Reflect.ownKeys(expected), actualKeys = Reflect.ownKeys(value);
  return typeof ctor === 'function' && Function.prototype.toString.call(ctor) === Function.prototype.toString.call(constructor)
    && actualKeys.length === expectedKeys.length && actualKeys.every(key => expectedKeys.includes(key));
}
function record(value: unknown, label: string): PlainRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label}格式不正确`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && (Object.getPrototypeOf(prototype) !== null || !nativePrototype(prototype, Object.prototype, Object))) fail(`${label}不能包含继承属性`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || prohibitedKeys.has(key) || !Object.getOwnPropertyDescriptor(value, key)?.enumerable
      || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value')) fail(`${label}包含不安全属性`);
  }
  return value as PlainRecord;
}
function fields(value: PlainRecord, allowed: string[], label: string) {
  if (Object.keys(value).some(key => !allowed.includes(key))) fail(`${label}包含未知字段`);
}
function name(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f]/u.test(value)
    || prohibitedKeys.has(value.trim())) fail(`${label}不正确`);
  return value.trim();
}
function volume(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1e6) fail('体积须为大于0且不超过1000000的数字');
  return value;
}
function layerNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 10000) fail('层数须为1至10000的整数');
  return value;
}
function shares(raw: unknown): NonNullable<LayerRule['shares']> {
  if (!Array.isArray(raw) || !raw.length) fail('客户比例不能为空');
  if (!nativePrototype(Object.getPrototypeOf(raw), Array.prototype, Array)) fail('客户比例数组不能包含继承属性');
  if (Reflect.ownKeys(raw).length !== raw.length + 1) fail('客户比例数组格式不正确');
  for (let index = 0; index < raw.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('客户比例数组须包含连续的普通记录');
  }
  const seen = new Set<string>();
  const result = raw.map(item => {
    const r = record(item, '客户比例'); fields(r, ['customerName', 'percent'], '客户比例');
    const customerName = name(r.customerName, '客户名称');
    if (seen.has(customerName)) fail('客户比例包含重复客户');
    seen.add(customerName);
    if (typeof r.percent !== 'number' || !Number.isFinite(r.percent) || r.percent < 0 || r.percent > 100) fail('客户比例须为0至100的数字');
    return { customerName, percent: r.percent };
  });
  if (Math.abs(result.reduce((sum, item) => sum + item.percent, 0) - 100) > 1e-6) fail('客户比例合计须为100%');
  return result;
}

export function emptyLayerPricingConfig(): LayerPricingConfig { return { schemaVersion: 1, revision: 0, locations: {} }; }

/** Invalid saved/legacy values must be surfaced; absence is handled by the persistence adapter. */
export function parseLayerPricingConfig(raw: unknown): LayerPricingConfig {
  let parsed = raw;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { fail('托层配置JSON格式不正确'); }
  }
  const root = record(parsed, '托层配置'); fields(root, ['schemaVersion', 'revision', 'locations'], '托层配置');
  if (root.schemaVersion !== 1) fail('托层配置版本不支持');
  if (typeof root.revision !== 'number' || !Number.isSafeInteger(root.revision) || root.revision < 0) fail('托层配置修订号不正确');
  const locations = record(root.locations, '库位配置');
  const output: LayerPricingConfig = { schemaVersion: 1, revision: root.revision, locations: {} };
  const canonicalKeys = new Set<string>();
  for (const [rawCode, rawLocation] of Object.entries(locations)) {
    const code = name(rawCode, '库位名称'), key = locationCodeKey(code);
    if (canonicalKeys.has(key)) fail(`库位名称重复：${code}`);
    canonicalKeys.add(key);
    const location = record(rawLocation, '库位配置'); fields(location, ['defaultVolumeM3', 'layers'], '库位配置');
    const layers = record(location.layers, '层配置');
    const outputLocation: LayerLocationConfig = { layers: {} };
    if (Object.hasOwn(location, 'defaultVolumeM3')) outputLocation.defaultVolumeM3 = volume(location.defaultVolumeM3);
    for (const [layer, rawRule] of Object.entries(layers)) {
      if (!/^[1-9]\d*$/.test(layer)) fail('层数须为1至10000的整数');
      layerNumber(Number(layer));
      const rule = record(rawRule, '层规则'); fields(rule, ['volumeM3', 'shares'], '层规则');
      const outputRule: LayerRule = {};
      if (Object.hasOwn(rule, 'volumeM3')) outputRule.volumeM3 = volume(rule.volumeM3);
      if (Object.hasOwn(rule, 'shares')) outputRule.shares = shares(rule.shares);
      outputLocation.layers[layer] = outputRule;
    }
    Object.defineProperty(output.locations, code, { value: outputLocation, enumerable: true, configurable: true, writable: true });
  }
  return output;
}

function aliasResolver(aliases: LocationAliases) {
  const lookup = new Map<string, string>();
  for (const [from, to] of Object.entries(record(aliases, '库位更名记录'))) {
    const key = locationCodeKey(name(from, '旧库位')), target = name(to, '新库位');
    if (lookup.has(key)) fail(`库位更名记录重复：${from}`);
    lookup.set(key, target);
  }
  const resolve = (rawCode: string): string => {
    let code = name(rawCode, '库位名称'); const visited = new Set<string>();
    while (lookup.has(locationCodeKey(code))) {
      const key = locationCodeKey(code);
      if (visited.has(key)) fail('库位更名记录循环，请先核对');
      visited.add(key); code = lookup.get(key)!;
    }
    return locationCodeKey(code);
  };
  for (const key of lookup.keys()) resolve(key);
  return resolve;
}

function canonicalConfig(config: LayerPricingConfig, resolve: (code: string) => string) {
  const byCode = new Map<string, LayerLocationConfig>();
  for (const [code, source] of Object.entries(config.locations)) {
    const key = resolve(code), existing = byCode.get(key);
    if (!existing) { byCode.set(key, source); continue; }
    if (existing.defaultVolumeM3 !== undefined && source.defaultVolumeM3 !== undefined && existing.defaultVolumeM3 !== source.defaultVolumeM3) fail(`更名后库位体积冲突：${key}`);
    const merged: LayerLocationConfig = { layers: { ...existing.layers } };
    const defaultVolumeM3 = existing.defaultVolumeM3 ?? source.defaultVolumeM3;
    if (defaultVolumeM3 !== undefined) merged.defaultVolumeM3 = defaultVolumeM3;
    for (const [layer, rule] of Object.entries(source.layers)) {
      const previous = merged.layers[layer];
      if (previous?.volumeM3 !== undefined && rule.volumeM3 !== undefined && previous.volumeM3 !== rule.volumeM3) fail(`更名后单层体积冲突：${key}/${layer}`);
      merged.layers[layer] = { ...previous, ...rule };
    }
    byCode.set(key, merged);
  }
  return byCode;
}

function exceptionLastLayer(code: string): number | undefined {
  const match = /^([DCE])([1-9]\d*)$/.exec(code);
  if (match) {
    const max = { D: [32, 2], C: [8, 3], E: [6, 4] }[match[1] as 'D' | 'C' | 'E'];
    if (Number(match[2]) <= max[0]) return max[1];
  }
  return undefined;
}
function builtinVolume(code: string, layer: number, zones: readonly WarehouseZoneRecord[], resolve: (code: string) => string): VolumeResult {
  const lastLayer = exceptionLastLayer(code);
  if (lastLayer !== undefined && layer <= lastLayer) return { volumeM3: 1, volumeSource: 'builtin-exception' };
  if (zones.some(zone => zone.id === 'Y' && zone.codes.some(member => resolve(member) === code))) return { volumeM3: .2, volumeSource: 'one-piece-zone' };
  return { volumeM3: 2, volumeSource: 'default' };
}
function effectiveVolume(location: LayerLocationConfig | undefined, code: string, layer: number, zones: readonly WarehouseZoneRecord[], resolve: (code: string) => string): VolumeResult {
  const rule = location?.layers[String(layer)];
  if (rule?.volumeM3 !== undefined) return { volumeM3: rule.volumeM3, volumeSource: 'layer' };
  // Legacy whole-location 1m³ exception values only apply within their original floors.
  // An explicit manual layer value above always wins, including an explicit 1m³.
  const lastLayer = exceptionLastLayer(code);
  const legacyOverflow = location?.defaultVolumeM3 === 1 && lastLayer !== undefined && layer > lastLayer;
  if (location?.defaultVolumeM3 !== undefined && !legacyOverflow) return { volumeM3: location.defaultVolumeM3, volumeSource: 'location' };
  return builtinVolume(code, layer, zones, resolve);
}

export function resolveLayerVolume(config: LayerPricingConfig, code: string, layer: number, zones: readonly WarehouseZoneRecord[], aliases: LocationAliases = {}): VolumeResult {
  layerNumber(layer);
  const resolve = aliasResolver(aliases), key = resolve(code), normalized = canonicalConfig(parseLayerPricingConfig(config), resolve);
  return effectiveVolume(normalized.get(key), key, layer, zones, resolve);
}

/** Current physical occupancy only; this does not choose billing dates or write any stock. */
export function groupLayerOccupancy(occupants: readonly LayerOccupant[], config: LayerPricingConfig, zones: readonly WarehouseZoneRecord[], aliases: LocationAliases = {}): LayerOccupancy[] {
  const resolve = aliasResolver(aliases), normalized = canonicalConfig(parseLayerPricingConfig(config), resolve);
  const groups = new Map<string, LayerOccupancy>();
  for (const raw of occupants) {
    const locationCode = resolve(raw.locationCode), layer = layerNumber(raw.layer), key = JSON.stringify([locationCode, layer]);
    if (raw.kind !== 'stock' && raw.kind !== 'carton') fail('占层来源不正确');
    if (typeof raw.customerName !== 'string' || typeof raw.inboundDate !== 'string' || typeof raw.productName !== 'string' || typeof raw.sku !== 'string') fail('占层资料格式不正确');
    const occupant: LayerOccupant = { ...raw, id: name(raw.id, '库存记录标识'), locationCode, layer, customerName: raw.customerName.trim() };
    let group = groups.get(key);
    if (!group) {
      group = { key, locationCode, layer, ...effectiveVolume(normalized.get(locationCode), locationCode, layer, zones, resolve), customers: [], shares: null, reviewReasons: [], occupants: [] };
      groups.set(key, group);
    }
    group.occupants.push(occupant);
    let customer = group.customers.find(item => item.customerName === occupant.customerName);
    if (!customer) {
      customer = { customerName: occupant.customerName, oldestInboundDate: occupant.inboundDate, products: [], recordIds: [] };
      group.customers.push(customer);
    }
    if (occupant.inboundDate && (!customer.oldestInboundDate || occupant.inboundDate < customer.oldestInboundDate)) customer.oldestInboundDate = occupant.inboundDate;
    if (occupant.productName && !customer.products.includes(occupant.productName)) customer.products.push(occupant.productName);
    if (!customer.recordIds.includes(occupant.id)) customer.recordIds.push(occupant.id);
  }
  for (const group of groups.values()) {
    if (group.customers.some(customer => !customer.customerName)) group.reviewReasons.push('unclaimed-customer');
    // Each customer's nonempty layer is billed in full. Saved ratios remain legacy metadata.
    group.shares = group.customers.map(customer => ({ customerName: customer.customerName, percent: 100 }));
  }
  return [...groups.values()].sort((a, b) => a.locationCode.localeCompare(b.locationCode, 'zh-CN', { numeric: true }) || b.layer - a.layer);
}
