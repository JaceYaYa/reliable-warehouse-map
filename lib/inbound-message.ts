import { locationCodeKey } from "./location-code.ts";
import { palletLabel, parsePalletValue } from "./pallet.ts";

export type MessageReferenceStock = {
  id?: number; locationCode: string; product: string; productPrefix?: string; productCondition?: string; customerName: string; barcode: string; sku?: string; fnsku?: string;
  totalQuantity: number; totalBoxes: number; palletCount: number; layerCount: number;
  inboundDate: string; inboundSource: "return" | "domestic" | "unspecified";
  billingMode: "item" | "box"; itemVolumeM3: number; boxVolumeM3: number;
  storageRateUsd: number; freeDays: number; updatedAt?: string; note?: string; inboundOrder?: string;
};
export type MessageInboundDraft = Omit<MessageReferenceStock, "id" | "updatedAt"> & {
  inboundOrder: string; palletLabel: string; note: string; updatedBy: string; catalogItemId: number | string | null;
};
export type MessageInboundItem = {
  key: string; draft: MessageInboundDraft; rawProduct: string; condition: string; card: string;
  rawLocation: string; locations: string[]; references: MessageReferenceStock[];
  referenceId: string; duplicateIds: number[]; warnings: string[];
  messageIdentifiers?: { sku: string; fnsku: string; barcode: string };
  receiptIdentifier?: string; quantityUnknown?: boolean; palletSpecified?: boolean; messagePalletCount?: number;
};
type ParseOptions = { locations: readonly string[]; stocks: readonly MessageReferenceStock[]; inboundDate: string; defaultRate?: number; defaultFreeDays?: number };
const conditionPattern = /残次品|残次|不良品|不良|次品|新品|良品|正品/;
const defectPattern = /残次|不良|次品/;
const numberPattern = "(?:\\d+\\s+\\d+\\s*/\\s*\\d+|\\d+(?:\\.\\d+)?(?:\\s*/\\s*\\d+(?:\\.\\d+)?)?)";
const compact = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
const cardIn = (value: string) => /无卡|没卡|不带卡/.test(value) ? "无卡" : /有卡|带卡/.test(value) ? "有卡" : "";
const baseProduct = (value: string) => value.replace(/^(?:残次品|残次|不良品|不良|次品|新品|良品|正品)\s*[:：·-]?\s*/u, "").replace(/[（(]?\s*(?:无卡|有卡|没卡|不带卡|带卡)\s*[）)]?/gu, "").replace(/^[-—:：\s]+|[-—:：\s]+$/g, "").trim();
const modelIn = (value: string) => value.toUpperCase().match(/[A-Z]{1,10}-?\d+[A-Z0-9-]*/g) ?? [];
const referenceKey = (stock: MessageReferenceStock) => `${stock.id ?? ""}|${stock.locationCode}|${stock.product}|${stock.customerName}|${stock.barcode}|${stock.sku ?? ""}`;
const receiptIdentifier = (value: string) => /^(?:FBA[A-Z0-9]{6,}|IB[A-Z0-9-]{6,})$/i.test(value.trim()) ? value.trim().toUpperCase() : "";
const palletMissingWarning = "消息未单列托盘数，已填1托，请按实际占位核对";
const palletReferenceWarning = "托盘数沿用同批记录，请核对实际占位";

function receiptLines(line: string) {
  if (/^(?:备注|说明)\s*[:：]/.test(line)) return [line];
  const result: string[] = [];
  const identifier = line.match(/^((?:FBA[A-Z0-9]{6,}|IB[A-Z0-9-]{6,}))[。.;；,，\s]+(.+)$/i);
  if (identifier && /入库|收货|到货|来货|(?:客户|货主)\s*[:：]|\d+\s*箱/.test(identifier[2])) { result.push(identifier[1]); line = identifier[2]; }
  const position = line.search(/(?:位于|位置|库位|放在|存放于)\s*[:：]?\s*(?:新)?[A-Za-z]\s*\d/u);
  if (position > 0) {
    result.push(line.slice(0, position).replace(/[。;；,，\s]+$/, ""));
    line = line.slice(position);
  }
  result.push(line.replace(/[。;；,，\s]+$/, ""));
  return result.filter(Boolean);
}

function receiptReferences(identifier: string, customer: string, stocks: readonly MessageReferenceStock[]) {
  return stocks.filter(stock => (!customer || stock.customerName === customer) &&
    [stock.product, stock.barcode, stock.inboundOrder, stock.note].some(value =>
      (value?.normalize("NFKC").toUpperCase().match(/[A-Z0-9]+(?:[_-][A-Z0-9]+)*/g) ?? []).includes(identifier)));
}

export function matchMessageLocations(raw: string, locations: readonly string[]) {
  const key = locationCodeKey(raw).replace(/\s/g, "");
  const exact = locations.filter(code => locationCodeKey(code).replace(/\s/g, "") === key);
  // Short floor labels such as D1 may refer to 新D1. Keep both candidates when both exist.
  const alias = /^[A-D]\d+$/.test(key) ? locations.filter(code => locationCodeKey(code) === `新${key}`) : [];
  if (!exact.length && /^新[A-D]\d+$/.test(key)) return locations.filter(code => locationCodeKey(code) === key.slice(1));
  return [...new Set([...exact, ...alias])];
}

function chineseLayer(value: string) {
  if (/^\d+$/.test(value)) return Number(value);
  const digits: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (value.includes("十")) { const [tens, ones] = value.split("十"); return (digits[tens] ?? 1) * 10 + (digits[ones] ?? 0); }
  return digits[value] ?? 1;
}

function quantities(line: string) {
  const warnings: string[] = [];
  const packs = [...line.matchAll(/(\d+(?:\.\d+)?)\s*箱\s*[xX×*]\s*(\d+(?:\.\d+)?)\s*(?:个|件|只|套|支|台)/g)];
  const packQuantity = packs.reduce((n, m) => n + Number(m[1]) * Number(m[2]), 0);
  const packBoxes = packs.reduce((n, m) => n + Number(m[1]), 0);
  const outsidePacks = line.replace(/[（(][^）)]*[）)]/g, " ").replace(/\d+(?:\.\d+)?\s*箱\s*[xX×*]\s*\d+(?:\.\d+)?\s*(?:个|件|只|套|支|台)/g, " ");
  const directQuantity = outsidePacks.match(/(?<![A-Za-z0-9])(\d+(?:\.\d+)?)\s*(?:个|件|只|套|支|台)(?!\p{L})/u);
  const directBoxes = outsidePacks.match(/(?<![A-Za-z0-9])(\d+(?:\.\d+)?)\s*箱(?!\s*[xX×*]|\p{L})/u);
  const singleBox = /\d+(?:\.\d+)?\s*(?:个|件|只|套|支|台)\s*[/／]\s*箱/.test(line);
  const pallet = line.match(new RegExp(`(?<![A-Za-z0-9])(${numberPattern})\\s*(?:托盘|托)(?!\\p{L})`, "u"));
  const quantity = directQuantity ? Number(directQuantity[1]) : packs.length ? packQuantity : null;
  const boxes = directBoxes ? Number(directBoxes[1]) : packs.length ? packBoxes : singleBox ? 1 : 0;
  if (packs.length && directQuantity && quantity !== packQuantity) warnings.push(`总件数 ${quantity} 与装箱合计 ${packQuantity} 不一致，请核对`);
  if (packs.length && directBoxes && boxes !== packBoxes) warnings.push(`总箱数 ${boxes} 与装箱合计 ${packBoxes} 不一致，请核对`);
  return { quantity, boxes, boxesSpecified: !!directBoxes || !!packs.length || singleBox, pallets: pallet ? parsePalletValue(pallet[1]) : 1, palletSpecified: !!pallet, warnings };
}

function findReferences(rawProduct: string, card: string, condition: string, location: string, customer: string, stocks: readonly MessageReferenceStock[]) {
  const base = compact(baseProduct(rawProduct));
  if (base.length < 2) return [];
  const models = modelIn(rawProduct);
  const matches = stocks.filter(stock => {
    const other = compact(baseProduct(stock.product));
    const otherCard = cardIn(stock.product);
    return (!card || !otherCard || otherCard === card) && (!customer || stock.customerName === customer)
      && (!models.length || models.some(model => modelIn(stock.product).includes(model)))
      && (other === base || other.endsWith(base) || base.endsWith(other));
  });
  const score = (stock: MessageReferenceStock) => (stock.locationCode === location ? 20 : 0) + (defectPattern.test(stock.product) === defectPattern.test(condition) ? 5 : 0) + (card && cardIn(stock.product) === card ? 2 : 0);
  matches.sort((a, b) => score(b) - score(a) || (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  const groups = new Map<string, MessageReferenceStock>();
  for (const stock of matches) {
    const key = `${compact(baseProduct(stock.product))}|${cardIn(stock.product)}|${stock.customerName}|${stock.barcode}|${stock.sku ?? ""}`;
    if (!groups.has(key)) groups.set(key, stock);
  }
  return [...groups.values()];
}

export function applyMessageReference(item: MessageInboundItem, reference: MessageReferenceStock | undefined): MessageInboundItem {
  const base = reference ? baseProduct(reference.product) : baseProduct(item.rawProduct);
  const card = item.card || (reference ? cardIn(reference.product) : "");
  const product = item.receiptIdentifier && reference && !item.condition && !item.card ? reference.product : `${defectPattern.test(item.condition) ? "残次品：" : ""}${base}${card ? `（${card}）` : ""}`;
  const draft = { ...item.draft, product, catalogItemId: null, sku: item.messageIdentifiers?.sku || "", fnsku: "" };
  if (reference) Object.assign(draft, {
    customerName: reference.customerName, barcode: item.messageIdentifiers?.barcode || reference.barcode, sku: item.messageIdentifiers?.sku || reference.sku || "", fnsku: "",
    billingMode: reference.billingMode, itemVolumeM3: reference.itemVolumeM3, boxVolumeM3: reference.boxVolumeM3,
    storageRateUsd: reference.storageRateUsd, freeDays: reference.freeDays,
  });
  let warnings = [...item.warnings];
  if (item.receiptIdentifier && !item.palletSpecified) {
    // An exact receipt identifier can recover the existing unopened batch's known occupancy.
    // A different box count or location is a new allocation and cannot inherit that occupancy.
    const sameBatch = reference && item.quantityUnknown && reference.totalQuantity === 0 && reference.totalBoxes === draft.totalBoxes && reference.locationCode === draft.locationCode && reference.layerCount === draft.layerCount;
    draft.palletCount = sameBatch ? reference.palletCount : item.messagePalletCount ?? 1;
    draft.palletLabel = palletLabel(draft.palletCount);
    warnings = warnings.filter(value => value !== palletMissingWarning && value !== palletReferenceWarning);
    warnings.push(sameBatch ? palletReferenceWarning : palletMissingWarning);
  }
  return { ...item, draft, warnings, referenceId: reference ? referenceKey(reference) : "" };
}

export function messageReferenceId(stock: MessageReferenceStock) { return referenceKey(stock); }

export function editMessageInboundItem(item: MessageInboundItem, patch: Partial<MessageInboundDraft>): MessageInboundItem {
  const identityChanged = (patch.sku !== undefined && patch.sku !== item.draft.sku) || (patch.product !== undefined && patch.product !== item.draft.product) || (patch.barcode !== undefined && patch.barcode !== item.draft.barcode) || (patch.customerName !== undefined && patch.customerName !== item.draft.customerName);
  const next = { ...item, draft: { ...item.draft, ...patch, ...(identityChanged && patch.catalogItemId === undefined ? { catalogItemId: null } : {}) } };
  if (patch.totalQuantity !== undefined && patch.totalQuantity > 0) next.quantityUnknown = false;
  if (patch.palletLabel !== undefined || patch.palletCount !== undefined) {
    next.palletSpecified = true; next.messagePalletCount = next.draft.palletCount;
    next.warnings = next.warnings.filter(value => value !== palletMissingWarning && value !== palletReferenceWarning);
  }
  if (next.receiptIdentifier && !next.palletSpecified && [patch.locationCode, patch.layerCount, patch.totalBoxes, patch.totalQuantity].some(value => value !== undefined)) {
    const occupancy = applyMessageReference(next, next.references.find(stock => referenceKey(stock) === next.referenceId));
    next.draft.palletCount = occupancy.draft.palletCount; next.draft.palletLabel = occupancy.draft.palletLabel; next.warnings = occupancy.warnings;
  }
  return next;
}

export function messageDuplicateIds(draft: MessageInboundDraft, stocks: readonly MessageReferenceStock[], identifier = "") {
  if (identifier) return receiptReferences(identifier, draft.customerName, stocks).flatMap(stock => stock.id === undefined ? [] : [stock.id]);
  return stocks.filter(stock => compact(stock.product) === compact(draft.product) && (stock.sku ?? "") === (draft.sku ?? "") && stock.barcode === draft.barcode && stock.locationCode === draft.locationCode
    && stock.customerName === draft.customerName && stock.totalQuantity === draft.totalQuantity && stock.totalBoxes === draft.totalBoxes
    && stock.layerCount === draft.layerCount).flatMap(stock => stock.id === undefined ? [] : [stock.id]);
}

export function parseInboundMessage(text: string, options: ParseOptions): { items: MessageInboundItem[]; errors: string[] } {
  if (!text.trim()) return { items: [], errors: ["请先粘贴清点消息"] };
  if (text.length > 20_000) return { items: [], errors: ["消息太长，请分次粘贴"] };
  const normalizedText = text.normalize("NFKC");
  if (/[-−]\s*\d+(?:\.\d+)?(?:\s*\/\s*\d+(?:\.\d+)?)?\s*(?:个|件|只|套|支|台|箱|托)(?!\p{L})/u.test(normalizedText)) return { items: [], errors: ["消息含负数，请修正数量后重新识别"] };
  if (/\d+\s*\/\s*0(?:\.0+)?\s*托/u.test(normalizedText)) return { items: [], errors: ["托盘分数的分母不能为0，请修正后重新识别"] };
  const lines = text.normalize("NFKC").replace(/\r/g, "").split("\n").map(line => line.trim()).filter(Boolean).flatMap(receiptLines);
  const source = /退货|退件/.test(text) ? "return" as const : /国内|到货|来货/.test(text) ? "domestic" as const : "unspecified" as const;
  let product = "", card = "", customer = "", inboundOrder = "", location = "", layer = 1;
  let identifiers = { sku: "", fnsku: "", barcode: "" };
  let current: MessageInboundItem | undefined;
  const items: MessageInboundItem[] = [];
  let pendingCondition = "";
  let pendingText: string[] = [];
  const generation = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  for (const originalLine of lines) {
    let line = originalLine.replace(/(?<=\d),(?=\d{3}(?:\D|$))/g, "").replace(/^[\d\s️⃣🟦🟠📦📍⚠️❗]+(?=退货|退件|产品|新品|良品|残次|位于|库位|数量)/u, "");
    if (/^(?:退货|退件|到货|入库)(?:产品)?清点\s*[:：]?\s*$/.test(line)) {
      product = ""; identifiers = { sku: "", fnsku: "", barcode: "" }; card = ""; location = ""; layer = 1; current = undefined; pendingCondition = ""; pendingText = []; continue;
    }
    const receipt = line.match(/^(.*?)\s*(?:入库|收货|到货|来货)\s*[:：]?\s*(\d.+)$/);
    if (receipt && quantities(receipt[2]).boxesSpecified) {
      const prefix = receipt[1].replace(/^(?:客户|货主)\s*[:：]?\s*/, "").trim();
      if (current) { product = ""; identifiers = { sku: "", fnsku: "", barcode: "" }; card = ""; location = ""; layer = 1; current = undefined; pendingCondition = ""; pendingText = []; }
      if (prefix && !/^(?:国内|退货|退件)$/.test(prefix)) {
        const knownCustomer = options.stocks.find(stock => stock.customerName.toUpperCase() === prefix.toUpperCase())?.customerName;
        if (knownCustomer || /^[A-Za-z][A-Za-z0-9 ()_-]{0,50}$/.test(prefix)) customer = knownCustomer || prefix;
        else { product = prefix; card = cardIn(product); }
      }
      line = receipt[2];
    }
    const customerMatch = line.match(/^(?:客户|货主|商家)\s*[:：]\s*(.+)$/);
    if (customerMatch) { customer = customerMatch[1].trim(); if (current) current.draft.customerName = customer; continue; }
    const orderMatch = line.match(/^(?:入库单号|入库单|单号)\s*[:：]\s*(.+)$/);
    if (orderMatch) { inboundOrder = orderMatch[1].trim(); if (current) current.draft.inboundOrder = inboundOrder; continue; }
    const identifierMatch = line.match(/^(SKU|FNSKU|产品条形码|条形码|条码)\s*[:：]\s*(.*)$/i);
    if (identifierMatch) {
      const key = identifierMatch[1].toUpperCase() === "SKU" ? "sku" : identifierMatch[1].toUpperCase() === "FNSKU" ? "fnsku" : "barcode";
      identifiers[key] = identifierMatch[2].trim();
      if (current) { current.draft[key] = identifiers[key]; current.messageIdentifiers = { ...identifiers }; }
      continue;
    }
    const locationMatch = line.match(/^(?:位于|位置|库位|放在|存放(?:于)?)\s*[:：]?\s*(.+)$/)
      ?? line.match(/^((?:新)?[A-Za-z]\s*\d+(?:通道)?\s*(?:第)?[\d一二两三四五六七八九十]+\s*层)$/);
    if (locationMatch) {
      const raw = locationMatch[1].trim(); const layerMatch = raw.match(/(?:第)?([一二两三四五六七八九十]+|\d+)\s*层/);
      location = raw.replace(/(?:第)?(?:[一二两三四五六七八九十]+|\d+)\s*层/g, "").replace(/[，,。;；]/g, "").trim();
      layer = layerMatch ? chineseLayer(layerMatch[1]) : 1;
      if (current) { current.rawLocation = location; current.draft.layerCount = layer; current.draft.note += `\n位置原文：${raw}`; }
      continue;
    }
    const condition = line.match(conditionPattern)?.[0] ?? pendingCondition;
    const q = quantities(line);
    const metadata = /^(?:备注|说明|卡片|条码|FNSKU|SKU|日期|入库日期)\s*[:：]/i.test(line) || /^(?:其中|外包装|包装破损|破损原因|缺少配件)/.test(line);
    if (metadata) {
      if (/^SKU/i.test(line)) { product = line.replace(/^[^:：]+[:：]\s*/, ""); card = cardIn(product); }
      else if (current) current.draft.note += `\n${originalLine}`;
      else pendingText.push(originalLine);
      continue;
    }
    if (condition && q.quantity === null && !/箱|托/.test(line)) {
      pendingCondition = condition;
      const heading = line.replace(conditionPattern, "").replace(/^[:：\s]+/, "");
      if (heading && !/^[（(]/.test(heading)) { product = heading; card = cardIn(product); if (current) { location = ""; layer = 1; } current = undefined; }
      pendingText.push(line); continue;
    }
    if (current && /^(?:数量|件数|箱数|托盘数|托盘|占托)\s*[:：]?\s*\d/.test(line)) {
      if (q.quantity !== null) { current.draft.totalQuantity = q.quantity; current.quantityUnknown = false; current.warnings = current.warnings.filter(value => !value.startsWith("消息未写件数")); }
      if (q.boxesSpecified) current.draft.totalBoxes = q.boxes;
      if (q.palletSpecified) { current.draft.palletCount = q.pallets; current.draft.palletLabel = palletLabel(q.pallets); current.palletSpecified = true; current.messagePalletCount = q.pallets; current.warnings = current.warnings.filter(value => !value.startsWith("消息未单列托盘数")); }
      current.draft.note += `\n${originalLine}`; current.warnings.push(...q.warnings); continue;
    }
    if ((q.quantity !== null || q.boxesSpecified || q.palletSpecified) && (condition || product || identifiers.sku || identifiers.fnsku || (customer && q.boxesSpecified))) {
      if (items.length >= 30) return { items: [], errors: ["一次最多识别30条货物，请分次粘贴"] };
      const draft: MessageInboundDraft = {
        product: "", locationCode: "", customerName: customer, ...identifiers, inboundOrder,
        totalQuantity: q.quantity ?? 0, totalBoxes: q.boxes, palletCount: q.pallets, palletLabel: palletLabel(q.pallets),
        layerCount: layer, inboundDate: options.inboundDate, inboundSource: source,
        billingMode: "item", itemVolumeM3: 0, boxVolumeM3: 0, storageRateUsd: options.defaultRate ?? 0.7,
        freeDays: options.defaultFreeDays ?? 0, catalogItemId: null, updatedBy: "",
        note: [condition, ...pendingText, originalLine].filter(Boolean).join("\n"),
      };
      const quantityUnknown = q.quantity === null && q.boxes > 0;
      current = { key: `${generation}-${items.length}`, draft, messageIdentifiers: { ...identifiers }, rawProduct: product || identifiers.sku || identifiers.fnsku || (quantityUnknown ? "未清点货物" : ""), condition: condition || "", card,
        rawLocation: location, locations: [], references: [], referenceId: "", duplicateIds: [], warnings: q.warnings,
        receiptIdentifier: receiptIdentifier(product), quantityUnknown, palletSpecified: q.palletSpecified, messagePalletCount: q.pallets };
      if (!product && !quantityUnknown) current.warnings.push("请在入库表单填写产品名称");
      if (q.quantity === null && !quantityUnknown) current.warnings.push("消息未写件数，请在表单核对");
      if (!q.palletSpecified && !defectPattern.test(condition)) current.warnings.push(palletMissingWarning);
      items.push(current); pendingCondition = ""; pendingText = [];
      continue;
    }
    // Product headings contain letters/names, but never consume a location or sender-only punctuation.
    if (/[\p{L}\p{N}]/u.test(line) && !/^(?:图片|照片|退货清点|退件清点)/.test(line)) {
      if (current) identifiers = { sku: "", fnsku: "", barcode: "" };
      product = line.replace(/^(?:产品|品名|货物)\s*[:：]\s*/, ""); card = cardIn(product);
      if (current) { location = ""; layer = 1; } current = undefined;
    }
  }

  if (items.some(item => !Number.isSafeInteger(item.draft.totalQuantity) || item.draft.totalQuantity < 0 || !Number.isSafeInteger(item.draft.totalBoxes) || item.draft.totalBoxes < 0 || !Number.isFinite(item.draft.palletCount) || item.draft.palletCount < 0)) return { items: [], errors: ["件数和箱数须为非负整数，托盘数须为有效数字，请修正后重新识别"] };
  const resolved = items.map(item => {
    // FNSKU is an alternate label for the existing product barcode.
    const identifiers = item.messageIdentifiers!;
    if (identifiers.barcode && identifiers.fnsku && identifiers.barcode !== identifiers.fnsku) item.warnings.push("条形码与 FNSKU 不一致，请核对产品条形码");
    item.draft.barcode = identifiers.barcode || identifiers.fnsku;
    item.draft.fnsku = "";
    item.messageIdentifiers = { sku: identifiers.sku, barcode: item.draft.barcode, fnsku: "" };
    const candidates = matchMessageLocations(item.rawLocation, options.locations);
    item.locations = candidates; item.draft.locationCode = candidates.length === 1 ? candidates[0] : "";
    if (item.quantityUnknown) item.draft.note += "\n消息未提供件数，按箱登记（件数记0）";
    if (item.receiptIdentifier) item.draft.note += `\n${item.receiptIdentifier}`;
    item.references = item.receiptIdentifier ? receiptReferences(item.receiptIdentifier, item.draft.customerName, options.stocks) : findReferences(item.rawProduct, item.card, item.condition, item.draft.locationCode, item.draft.customerName, options.stocks);
    item.references = item.references.filter(stock => (!item.draft.sku || stock.sku === item.draft.sku) && (!item.draft.barcode || stock.barcode === item.draft.barcode));
    const atLocation = item.references.filter(stock => stock.locationCode === item.draft.locationCode);
    const automatic = atLocation.length === 1 ? atLocation[0] : item.references.length === 1 ? item.references[0] : undefined;
    const result = applyMessageReference(item, automatic);
    result.duplicateIds = messageDuplicateIds(result.draft, options.stocks, item.receiptIdentifier);
    if (candidates.length > 1) result.warnings.push(`“${item.rawLocation}”对应多个库位，请选择`);
    if (!candidates.length) result.warnings.push(`未匹配库位“${item.rawLocation || "未填写"}”，请选择`);
    return result;
  });
  return { items: resolved, errors: resolved.length ? [] : ["未识别到货物数量。请粘贴包含产品、件数/箱数和库位的清点文字"] };
}
