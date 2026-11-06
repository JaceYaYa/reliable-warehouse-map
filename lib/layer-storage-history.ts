import {automaticPalletRows} from './automatic-pallets.ts';
import type { LayerOccupant } from './layer-storage.ts';
import type { LocationAliases } from './location-aliases.ts';
import { resolveLocationAlias } from './location-aliases.ts';
import { locationCodeKey } from './location-code.ts';
import { warehouseTodayDate } from './warehouse-time.ts';
import {resolveMerchantName,merchantHistoryCustomerNames,type MerchantAliases,type MerchantPhysicalOwners} from './merchant-identity.ts';

export type LayerHistoryIssue = { code: string; message: string; startDate: string; endDateExclusive: string; recordIds?: string[]; locationCode?: string; layer?: number; customerName?: string };
export type LayerHistoryInterval = { startDate: string; endDateExclusive: string; occupants: LayerOccupant[]; issues: LayerHistoryIssue[]; evidenceIds: string[] };
export type LayerHistoryLineage={parentId:string;childId:string;day:string};
export type LayerHistoryResult = { intervals: LayerHistoryInterval[]; issues: LayerHistoryIssue[]; coverageStart: string | null; checkpointAt: string | null; currentArrivalReviewIds?: string[];lineage?:LayerHistoryLineage[] };
type Row = Record<string, unknown>;
export type LayerHistoryInput = {
  stocks: Row[]; cartons: Row[]; audits: Row[]; goodsOps: Row[]; cartonOps: Row[]; settlements: Row[];
  checkpoint: { capturedAt: string; value: string; auditHighId: number } | null;
  aliases?: LocationAliases; periodStart: string; periodEndExclusive: string;includeQuantities?:boolean;customerAliases?:MerchantAliases;customerOwners?:MerchantPhysicalOwners;
};
type Physical = LayerOccupant & { quantity: number; boxes: number };
type State = Map<string, Physical>;
type Event = {
  id: string; stamp: string; recordedDay: string; day: string; kind: string; before: State; after: State;
  auditIds: number[]; evidence: string[]; undoTarget?: string; restoredAt?: string | null;
  trackedUndo: boolean; problems: string[]; cancelled?: boolean;financialIdentity?:boolean;
};
const messages: Record<string, string> = {
  'history-before-checkpoint': '基线之前缺少完整仓库占层证据，历史费用待核对',
  'missing-checkpoint': '缺少完整实物占层基线，不能由当前库存推算历史费用',
  'invalid-checkpoint': '实物占层基线损坏或格式不完整，请核对基线',
  'invalid-physical-data': '实物库存资料损坏，无法验证历史占层',
  'missing-physical-snapshot': '操作缺少可验证的实物前后快照',
  'source-snapshot-conflict': '同一操作的多份实物快照不一致',
  'recorded-chain-mismatch': '实物变更链与基线不一致，可能缺少操作记录',
  'current-state-mismatch': '变更链的最终实物与当前库存不一致',
  'backdated-physical-conflict': '补录业务日期跨越实物变更，不能证明当日实际位置或数量',
  'unmatched-undo': '撤销缺少匹配的原操作、时间或精确恢复快照',
  'undo-crosses-checkpoint': '撤销跨越基线且无法证明基线中的原操作状态',
  'arrival-cohort-unknown': '数量修正后的实际到仓批次不明确，免租日期待核对',
  'metadata-effective-date-unknown': '客户或到仓日期被修改，历史生效时段待核对',
  'missing-business-date': '出库或修正操作缺少明确业务日期',
  'unpaired-conversion': '箱转产品缺少对应来源快照，不能证明未重复占层',
  'ambiguous-event-order': '同一时刻的相关操作缺少可验证先后顺序',
};
const dayValid = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const nextDay = (v: string) => new Date(Date.parse(`${v}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
const record = (v: unknown): Row => { if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('object'); return v as Row; };
const parsed = (v: unknown): unknown => typeof v === 'string' ? JSON.parse(v) : v;
const text = (v: unknown, fallback = '') => typeof v === 'string' ? v : fallback;
const number = (v: unknown) => { if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new Error('count'); return v; };
const physicalIdentity=(v:Physical|undefined)=>{if(!v)return v;const {palletCount,palletManual,estimatedPallets,...physical}=v;return physical;};
const equal = (a: Physical | undefined, b: Physical | undefined) => JSON.stringify(physicalIdentity(a)) === JSON.stringify(physicalIdentity(b));
const keys = (e: Event) => [...new Set([...e.before.keys(), ...e.after.keys()])];
const same = (a: State, b: State) => a.size === b.size && [...a].every(([id, value]) => equal(value, b.get(id)));
const occupied = (s: State,includeQuantities=false) => {
 const rows=[...s.values()].filter(r => r.quantity > 0 || r.boxes > 0).sort((a, b) => a.id.localeCompare(b.id));
 // Legacy snapshots lack intent: their recorded counts remain authoritative.
 const shareByKind=new Map(['stock','carton'].map(kind=>[kind,automaticPalletRows(rows.filter(r=>r.kind===kind).map(r=>({...r,palletManual:r.palletManual??true,totalQuantity:r.quantity,totalBoxes:r.boxes})))]));
 const shares=new Map([...shareByKind.values()].flat().map(r=>[r.id,r]));
 return rows.map(({quantity,boxes,...row},n)=>({...row,...(row.palletManual===false?{palletCount:shares.get(row.id)!.palletCount}:{}),...(includeQuantities?{physicalQuantity:quantity,physicalBoxes:boxes}:{})}));
};
const replace = (state: State, event: Pick<Event, 'before' | 'after'>) => { for (const id of new Set([...event.before.keys(), ...event.after.keys()])) { const row = event.after.get(id); if (row) state.set(id, row); else state.delete(id); } };
const matchesBefore = (state: State, event: Event) => keys(event).every(id => equal(state.get(id), event.before.get(id)));

/** Documentary evidence only: cost lots, dimensions, pallet counts and fee snapshots are never physical state. */
export function projectLayerStorageHistory(input: LayerHistoryInput): LayerHistoryResult {
  const start = input.periodStart, end = input.periodEndExclusive;
  if (!dayValid(start) || !dayValid(end) || end < start) throw new Error('历史占层账期日期无效');
  const issues: LayerHistoryIssue[] = [];
  const addIssue = (code: string, from = start, ids?: string[], until = end) => {
    const startDate = from > start ? from : start, endDateExclusive = until < end ? until : end;
    if (startDate >= endDateExclusive) return;
    const issue: LayerHistoryIssue = { code, message: messages[code] ?? code, startDate, endDateExclusive, ...(ids?.length ? { recordIds: [...new Set(ids)].sort() } : {}) };
    if (!issues.some(i => JSON.stringify(i) === JSON.stringify(issue))) issues.push(issue);
  };
  const fallback = (code: string, checkpointAt: string | null = null): LayerHistoryResult => {
    addIssue(code);
    return { intervals: start === end ? [] : [{ startDate: start, endDateExclusive: end, occupants: [], issues: [...issues], evidenceIds: [] }], issues, coverageStart: null, checkpointAt };
  };
  const canonical = (code: unknown) => { if (typeof code !== 'string' || !code.trim()) throw new Error('location'); return locationCodeKey(resolveLocationAlias(code, input.aliases ?? {})); };
  const customerAliases=input.customerAliases??{},customerOwners=input.customerOwners??{},financialNames=merchantHistoryCustomerNames(customerOwners,customerAliases,input.goodsOps,input.cartonOps);
  const documentaryCustomers=new WeakMap<Physical,string>();
  const physical = (raw: Row, id: string, kind: 'stock' | 'carton', quantity: unknown, boxes: unknown): Physical => {
    const layer = number(raw.layerCount); if (layer < 1 || layer > 10000) throw new Error('layer');
    const inboundDate=text(raw.inboundDate),name=resolveMerchantName(text(raw.customerName).trim(),customerAliases),owner=customerOwners[id],customerName=owner&&owner.inboundDate===inboundDate&&financialNames.get(JSON.stringify([id,inboundDate]))?.has(name)?resolveMerchantName(owner.originalCustomerName,customerAliases):name;
    const row={ ...(typeof raw.palletManual==='boolean'?{palletManual:raw.palletManual}:typeof raw.palletAutomatic==='boolean'?{palletManual:!raw.palletAutomatic}:{}), ...(typeof raw.palletCount==='number'&&Number.isFinite(raw.palletCount)&&raw.palletCount>=0?{palletCount:raw.palletCount}:{}), id, kind, locationCode: canonical(raw.locationCode), layer, customerName, inboundDate, productName: text(raw.product), sku: text(raw.sku), quantity: number(quantity), boxes: number(boxes) };
    documentaryCustomers.set(row,name);return row;
  };
  const stockRows = (raw: unknown): State => {
    if (!Array.isArray(raw)) throw new Error('stock rows'); const state: State = new Map();
    for (const item of raw) { const row = record(item), id = `stock:${number(row.id)}`; if (state.has(id)) throw new Error('duplicate stock'); state.set(id, physical(row, id, 'stock', row.totalQuantity, row.totalBoxes)); }
    return state;
  };
  const cartonRows = (raw: unknown): State => {
    if (!Array.isArray(raw)) throw new Error('carton rows'); const state: State = new Map(); const receipts = new Set<string>();
    for (const item of raw) {
      const receipt = record(item); if (typeof receipt.id !== 'string' || !receipt.id || receipts.has(receipt.id)) throw new Error('receipt id'); receipts.add(receipt.id);
      const placements = parsed(receipt.placements); if (!Array.isArray(placements)) throw new Error('placements');
      for (const value of placements) {
        const p = record(value); if (typeof p.key !== 'string' || !p.key) throw new Error('placement key');
        const id = `carton:${receipt.id}:${p.key}`; if (state.has(id)) throw new Error('duplicate placement');
        const d = p.details == null ? {} : record(p.details), product = p.product == null ? {} : record(p.product);
        // This is cartonPlacementDetails' physical subset; do not inherit linked-product ownership.
        state.set(id, physical({ palletCount:p.palletCount,palletManual:p.palletManual, locationCode: p.locationCode, layerCount: p.layerCount, customerName: d.customerName ?? receipt.customerName, inboundDate: d.inboundDate ?? receipt.inboundDate, product: d.product ?? product.name ?? receipt.inboundOrder, sku: d.sku ?? product.sku }, id, 'carton', 0, p.boxes));
      }
    }
    return state;
  };
  const allRows = (stocks: unknown, cartons: unknown): State => new Map([...stockRows(stocks), ...cartonRows(cartons)]);
  const cp = input.checkpoint; if (!cp) return fallback('missing-checkpoint');
  let baseline: State, current: State, coverageStart: string;
  try {
    if (!Number.isFinite(Date.parse(cp.capturedAt)) || !Number.isSafeInteger(cp.auditHighId) || cp.auditHighId < 0) throw new Error('checkpoint');
    const value = record(parsed(cp.value)); if (value.schemaVersion !== 1) throw new Error('version');
    baseline = allRows(value.stocks, value.cartons); coverageStart = nextDay(warehouseTodayDate(new Date(cp.capturedAt)));
  } catch { return fallback('invalid-checkpoint'); }
  try { current = allRows(input.stocks, input.cartons); } catch { return fallback('invalid-physical-data', cp.capturedAt); }
  addIssue('history-before-checkpoint', start, undefined, coverageStart);

  const events = new Map<string, Event>(), auditToOperation = new Map<string, string>();
  for (const log of input.audits) if (log.id !== undefined) auditToOperation.set(String(log.id), text(log.operationId, `audit:${log.id}`));
  const isPost = (e: Event) => e.auditIds.length ? e.auditIds.some(id => id > cp.auditHighId) : Date.parse(e.stamp) > Date.parse(cp.capturedAt);
  const rawPost = (op: Row) => input.audits.some(log => log.operationId === op.id && Number(log.id) > cp.auditHighId) || !Number.isFinite(Date.parse(String(op.createdAt))) || Date.parse(String(op.createdAt)) > Date.parse(cp.capturedAt) || op.restoredAt && Date.parse(String(op.restoredAt)) > Date.parse(cp.capturedAt);
  const event = (id: string, stamp: unknown, kind: string): Event => {
    if (typeof stamp !== 'string' || !Number.isFinite(Date.parse(stamp))) throw new Error('event timestamp');
    const old = events.get(id); if (old) {
      // convertCarton prepares receipt time before prepareGoodsInbound obtains its own time,
      // then commits both legs in one transaction. The latest preparation time is authoritative.
      if (old.kind === 'convert' && Date.parse(stamp) > Date.parse(old.stamp)) { old.stamp = stamp; old.recordedDay = warehouseTodayDate(new Date(stamp)); old.day = old.recordedDay; }
      else if (old.kind !== 'convert' && Date.parse(old.stamp) !== Date.parse(stamp)) old.problems.push('source-snapshot-conflict');
      return old;
    }
    const recordedDay = warehouseTodayDate(new Date(stamp));
    const next: Event = { id, stamp, recordedDay, day: recordedDay, kind, before: new Map(), after: new Map(), auditIds: [], evidence: [], problems: [], trackedUndo: false };
    events.set(id, next); return next;
  };
  const leg = (e: Event, before: State, after: State, source: string, physicalKind?: 'stock' | 'carton') => {
    // Different tables may cover disjoint legs of one atomic carton conversion.
    for (const [target, supplied] of [[e.before, before], [e.after, after]] as const) for (const [id, row] of supplied) { if (target.has(id) && !equal(target.get(id), row)) e.problems.push('source-snapshot-conflict'); target.set(id, row); }
    // Check absent/deleted rows too when this source repeats an existing physical kind.
    const kinds = new Set([...before.values(), ...after.values()].map(r => r.kind)); if (physicalKind) kinds.add(physicalKind);
    for (const kind of kinds) {
      const filter = (s: State) => new Map([...s].filter(([, r]) => r.kind === kind));
      if (!same(filter(e.before), filter(before)) || !same(filter(e.after), filter(after))) e.problems.push('source-snapshot-conflict');
    }
    e.evidence.push(source);
  };
  const snapshot = (value: unknown, kind: 'stock' | 'carton') => {
    if (value === null && kind === 'carton') return new Map<string, Physical>(); // Receipt ledger uses SQL NULL for creation/deletion.
    if (value === null || value === undefined) throw new Error('missing snapshot');
    const v = parsed(value); if (v === null) return new Map<string, Physical>();
    if (kind === 'carton') return cartonRows([v]);
    const r = record(v); if (r.schema === 'goods-operation-v1' || r.kind === 'stock-transfer' && r.snapshotVersion === 1) return stockRows(r.rows);
    return stockRows([r]);
  };
  for (const op of input.goodsOps) {
    if (op.kind === 'document') continue; // Parent request ledger; children own physical changes.
    try {
      const e = event(text(op.id), op.createdAt, text(op.kind)); if (!e.id) throw new Error('operation id');
      leg(e, stockRows(parsed(op.beforeRows)), stockRows(parsed(op.afterRows)), `goods:${e.id}`, 'stock');
      const result = record(parsed(op.result)); e.trackedUndo = true; e.restoredAt = op.restoredAt == null ? null : text(op.restoredAt);
      try{const f=record(parsed(op.fingerprint));e.financialIdentity=op.kind==='identity'&&typeof f.merchantChangeId==='string'&&!!f.merchantChangeId&&f.merchantChangeId===result.merchantChangeId;}catch{}
      if (op.kind === 'outbound' || op.kind === 'correction') {
        const day = op.kind === 'outbound' ? result.outboundDate : result.effectiveDate;
        if (dayValid(day)) e.day = day; else e.problems.push('missing-business-date');
      }
      if (op.kind === 'inbound') { const dates = [...e.after.values()].map(r => r.inboundDate); if (dates.length && dates.every(d => dayValid(d) && d === dates[0])) e.day = dates[0]; else if (dates.length) e.problems.push('missing-business-date'); }
      if (op.kind === 'convert' && result.cartonConversion) { const c = record(result.cartonConversion); leg(e, cartonRows([c.before]), cartonRows([c.after]), `goods-conversion:${e.id}`, 'carton'); }
    } catch { if (rawPost(op)) addIssue('missing-physical-snapshot', coverageStart); }
  }
  for (const op of input.cartonOps) {
    try {
      const e = event(text(op.id), op.createdAt, text(op.kind)); if (!e.id) throw new Error('operation id');
      leg(e, op.beforeSnapshot === null ? new Map() : snapshot(op.beforeSnapshot, 'carton'), op.afterSnapshot === null ? new Map() : snapshot(op.afterSnapshot, 'carton'), `carton:${e.id}`, 'carton');
      const body = record(parsed(op.fingerprint)); e.trackedUndo = true; e.restoredAt = op.restoredAt == null ? null : text(op.restoredAt);
      try{const result=record(parsed(op.result));e.financialIdentity=op.kind==='details'&&typeof body.merchantChangeId==='string'&&!!body.merchantChangeId&&body.merchantChangeId===result.merchantChangeId;}catch{}
      if (op.kind === 'outbound') { if (dayValid(body.outboundDate)) e.day = body.outboundDate; else e.problems.push('missing-business-date'); }
      if (op.kind === 'inbound') { const dates = [...e.after.values()].map(r => r.inboundDate); if (dates.length && dates.every(d => dayValid(d) && d === dates[0])) e.day = dates[0]; else if (dates.length) e.problems.push('missing-business-date'); }
      if (op.kind === 'restore') e.undoTarget = text(body.operationId) || undefined;
    } catch { if (rawPost(op)) addIssue('missing-physical-snapshot', coverageStart); }
  }
  const actions = new Set(['入库', '出库', '移库', '库存修改', '删除', '恢复', '箱件收货', '箱件出库', '箱件认领改单', '箱件删除', '撤销箱件操作', '箱件移库', '箱件资料修改', '箱件数量修正']);
  const entities = new Set(['库位', '货物', '原记录', '待出库', '箱件收货', '箱件原操作']);
  for (const log of input.audits) {
    if (!actions.has(text(log.action)) || !entities.has(text(log.entityType))) continue;
    try {
      const id = text(log.operationId, `audit:${log.id}`), existing = events.has(id), e = event(id, log.createdAt, text(log.action));
      if (typeof log.id === 'number') e.auditIds.push(log.id);
      const kind = text(log.entityType).startsWith('箱件') ? 'carton' : 'stock';
      leg(e, snapshot(log.beforeSnapshot, kind), snapshot(log.afterSnapshot, kind), `audit:${log.id}`, kind);
      if (log.action === '恢复') e.undoTarget = auditToOperation.get(String(log.entityId));
      if (!existing && log.action === '入库') {
        const arrivals = [...e.after.values()].filter(r => !e.before.has(r.id)).map(r => r.inboundDate);
        if (arrivals.length && arrivals.every(d => dayValid(d) && d === arrivals[0])) e.day = arrivals[0];
      }
      if (!existing && log.action === '出库') {
        const physicalBefore = record(parsed(log.beforeSnapshot));
        const bills = input.settlements.filter(s => s.operationId === id);
        if (Object.hasOwn(physicalBefore, 'physicalOutboundDate')) {
          // Layer billing creates no legacy settlement: preserve the explicit physical
          // business date on the audit itself. A present invalid value is not a fallback.
          if (dayValid(physicalBefore.physicalOutboundDate)) e.day = physicalBefore.physicalOutboundDate;
          else e.problems.push('missing-business-date');
        } else if (bills.length === 1 && typeof bills[0].outboundAt === 'string') {
          const at = bills[0].outboundAt;
          // Legacy DELETE used its exact operation instant; POST encoded a selected calendar date.
          const businessDay = at === e.stamp ? e.recordedDay : /^\d{4}-\d{2}-\d{2}T23:59:59\.000Z$/.test(at) ? at.slice(0, 10) : '';
          if (dayValid(businessDay)) e.day = businessDay; else e.problems.push('missing-business-date');
        } else e.problems.push('missing-business-date');
      }
    } catch {
      if (Number(log.id) > cp.auditHighId || Date.parse(String(log.createdAt)) > Date.parse(cp.capturedAt)) addIssue('missing-physical-snapshot', coverageStart);
    }
  }
  // Conversion undo has two distinct ledger IDs but one target and timestamp.
  const undoGroups = new Map<string, Event>();
  for (const e of [...events.values()]) if (e.undoTarget) {
    const groupKey = `${e.undoTarget}\n${e.stamp}`, previous = undoGroups.get(groupKey);
    if (previous) { leg(previous, e.before, e.after, e.evidence.join(',')); previous.auditIds.push(...e.auditIds); previous.problems.push(...e.problems); events.delete(e.id); }
    else undoGroups.set(groupKey, e);
  }
  const ordered = [...events.values()].sort((a, b) => Date.parse(a.stamp) - Date.parse(b.stamp) || Math.min(...a.auditIds, Infinity) - Math.min(...b.auditIds, Infinity) || a.id.localeCompare(b.id));
  const post = ordered.filter(isPost), initial = new Map(baseline), recorded = new Map(baseline);
  // Validate recorded-time continuity independently of selected business dates.
  for (const e of post) {
    if (!matchesBefore(recorded, e)) addIssue('recorded-chain-mismatch', coverageStart, keys(e));
    replace(recorded, e);
  }
  if (!same(recorded, current)) {
    const ids = [...new Set([...recorded.keys(), ...current.keys()])].filter(id => !equal(recorded.get(id), current.get(id)));
    addIssue('current-state-mismatch', coverageStart, ids);
  }
  for (const e of ordered) {
    if (e.kind === 'convert' && !(e.evidence.includes(`goods:${e.id}`) && e.evidence.includes(`carton:${e.id}`) && keys(e).some(id => id.startsWith('stock:')) && keys(e).some(id => id.startsWith('carton:')))) { if (isPost(e)) addIssue('unpaired-conversion', coverageStart, keys(e)); }
    if (!e.undoTarget) continue;
    const original = events.get(e.undoTarget), valid = original && Date.parse(original.stamp) <= Date.parse(e.stamp) && !original.cancelled && same(e.before, original.after) && same(e.after, original.before) && (!original.trackedUndo || original.restoredAt === e.stamp) && !e.problems.length && original.problems.every(p => p === 'missing-business-date');
    if (!valid) { if (isPost(e)) addIssue('unmatched-undo', coverageStart, keys(e)); continue; }
    original.cancelled = true; e.cancelled = true;
    if (!isPost(original) && isPost(e)) {
      if (keys(original).every(id => equal(initial.get(id), original.after.get(id)))) replace(initial, { before: original.after, after: original.before });
      else addIssue('undo-crosses-checkpoint', coverageStart, keys(original));
    }
  }
  // A matched undo cancels the original business effect even when its deleted settlement
  // was the only date carrier. Its exact physical inverse remains independently proven.
  for (const e of post) for (const problem of e.problems) if (!(e.cancelled && problem === 'missing-business-date')) addIssue(problem, coverageStart, keys(e));
  for (const e of ordered) if (e.restoredAt && !e.cancelled && !same(e.before, e.after) && (isPost(e) || Date.parse(e.restoredAt) > Date.parse(cp.capturedAt))) addIssue('unmatched-undo', coverageStart, keys(e));

  // A recognized financial edit may be physically equal after cohort projection.
  // Ordinary metadata edits still need their effective-date warning even if the
  // same names also happen to appear in a later merchant change.
  for(const e of post)if(!e.cancelled&&!e.financialIdentity&&!(e.undoTarget&&events.get(e.undoTarget)?.financialIdentity))for(const[id,before]of e.before){const after=e.after.get(id);if(after&&documentaryCustomers.get(before)!==documentaryCustomers.get(after))addIssue('metadata-effective-date-unknown',coverageStart,[id]);}

  // Pallet-only edits change financial occupancy while physical identity remains equal.
  const palletChanged=(e:Event)=>keys(e).some(id=>e.before.get(id)?.palletCount!==e.after.get(id)?.palletCount||e.before.get(id)?.palletManual!==e.after.get(id)?.palletManual);
  const active = post.filter(e => !e.cancelled && (!same(e.before, e.after)||palletChanged(e)));
  for (const e of active) {
    if (e.day > e.recordedDay) { addIssue('missing-business-date', coverageStart, keys(e)); e.day = e.recordedDay; }
    if (e.day < e.recordedDay) {
      const touched = new Set(keys(e));
      const conflicts = active.some(other => other !== e && Date.parse(other.stamp) < Date.parse(e.stamp) && other.recordedDay > e.day && keys(other).some(id => touched.has(id)));
      if (conflicts) { addIssue('backdated-physical-conflict', e.day, keys(e)); e.day = e.recordedDay; }
    }
    for (const [id, before] of e.before) {
      const after = e.after.get(id);
      if (after && (before.inboundDate !== after.inboundDate || before.customerName !== after.customerName)) addIssue('metadata-effective-date-unknown', coverageStart, [id]);
    }
  }
  // Track uncertainty over the complete recorded lineage, independently of the requested
  // month. Decreasing a known cohort creates no new ambiguity; emptying it ends any old
  // ambiguity. A transfer carries existing ambiguity into only its possible descendants.
  const uncertain = new Map<string, { row: Physical; since: string }>();
  const living = (row: Physical | undefined): row is Physical => !!row && (row.quantity > 0 || row.boxes > 0);
  const increased = (before: Physical | undefined, after: Physical) => after.quantity > (before?.quantity ?? 0) || after.boxes > (before?.boxes ?? 0);
  const decreased = (before: Physical, after: Physical | undefined) => !after || after.quantity < before.quantity || after.boxes < before.boxes;
  const arrivalIssue = (row: Physical, since: string, until = end) => {
    const from = [since, coverageStart, start].sort().at(-1)!, to = until < end ? until : end;
    if (from >= to) return;
    const common = { code: 'arrival-cohort-unknown', message: messages['arrival-cohort-unknown'], startDate: from, endDateExclusive: to };
    const candidates: LayerHistoryIssue[] = [{ ...common, recordIds: [row.id] }, { ...common, locationCode: row.locationCode, layer: row.layer }];
    for (const candidate of candidates) if (!issues.some(i => JSON.stringify(i) === JSON.stringify(candidate))) issues.push(candidate);
  };
  for (const e of ordered) {
    if (e.cancelled || same(e.before, e.after)) continue;
    const transfer = ['move', '移库', 'staging', 'convert'].includes(e.kind);
    const uncertainSources = [...e.before.values()].filter(row => uncertain.has(row.id) && decreased(row, e.after.get(row.id)));
    const inherited = new Set<string>();
    if (transfer) for (const [id, after] of e.after) if (living(after) && increased(e.before.get(id), after) && uncertainSources.some(source =>
      e.kind === 'convert'
        ? source.inboundDate === after.inboundDate && source.locationCode === after.locationCode && source.layer === after.layer
        : source.kind === after.kind && source.inboundDate === after.inboundDate && source.customerName === after.customerName && source.productName === after.productName && source.sku === after.sku
    )) inherited.add(id);
    for (const id of keys(e)) {
      const before = e.before.get(id), after = e.after.get(id), prior = uncertain.get(id);
      if (prior && (!living(after) || prior.row.locationCode !== after.locationCode || prior.row.layer !== after.layer)) {
        arrivalIssue(prior.row, prior.since, e.day); uncertain.delete(id);
      }
      if (!living(after)) continue;
      const newlyUncertain = !transfer && !!before && increased(before, after);
      if (prior || inherited.has(id) || newlyUncertain) uncertain.set(id, { row: after, since: uncertain.get(id)?.since ?? e.day });
    }
  }
  for (const { row, since } of uncertain.values()) arrivalIssue(row, since);
  const currentArrivalReviewIds = [...uncertain.keys()].filter(id => living(current.get(id))).sort();
  active.sort((a, b) => a.day.localeCompare(b.day) || ordered.indexOf(a) - ordered.indexOf(b));
  const state = new Map(initial), snapshots: Array<{ day: string; state: State; evidence: string[] }> = [];
  const evidence = new Set<string>([`checkpoint:${cp.capturedAt}`]);
  for (let index = 0; index < active.length;) {
    const day = active[index].day < coverageStart ? coverageStart : active[index].day;
    do {
      const e = active[index];
      if (!matchesBefore(state, e)) addIssue('backdated-physical-conflict', day, keys(e));
      replace(state, e); e.evidence.forEach(id => evidence.add(id)); index++;
    } while (index < active.length && (active[index].day < coverageStart ? coverageStart : active[index].day) === day);
    snapshots.push({ day, state: new Map(state), evidence: [...evidence] });
  }
  // A split changes record IDs, never the evidential quality of the goods moved into the new row.
  for (const issue of issues) if (issue.recordIds && issue.code !== 'arrival-cohort-unknown') {
    const affected = new Set(issue.recordIds);
    for (const e of active) if (e.day < issue.endDateExclusive && [...e.before.keys()].some(id => affected.has(id))) for (const id of e.after.keys()) affected.add(id);
    issue.recordIds = [...affected].sort();
  }
  // Missing or ambiguous goods can change the oldest arrival/customer mix of other
  // goods in the same layer, including after the affected row itself disappeared.
  const knownRows = [...baseline.values(), ...current.values(), ...ordered.flatMap(e => [...e.before.values(), ...e.after.values()])];
  for (const issue of [...issues]) if (issue.recordIds && issue.code !== 'arrival-cohort-unknown') {
    const scopes = new Map<string, Physical>();
    for (const row of knownRows) if (issue.recordIds.includes(row.id)) scopes.set(JSON.stringify([row.locationCode, row.layer]), row);
    for (const row of scopes.values()) {
      const scoped: LayerHistoryIssue = { code: issue.code, message: issue.message, startDate: issue.startDate, endDateExclusive: issue.endDateExclusive, locationCode: row.locationCode, layer: row.layer };
      if (!issues.some(i => JSON.stringify(i) === JSON.stringify(scoped))) issues.push(scoped);
    }
  }
  const boundaries = [...new Set([start, end, coverageStart, ...snapshots.map(s => s.day), ...issues.flatMap(i => [i.startDate, i.endDateExclusive])])].filter(d => d >= start && d <= end).sort();
  const intervals: LayerHistoryInterval[] = [];
  let index = 0, visible = initial, proof = [`checkpoint:${cp.capturedAt}`];
  for (let n = 0; n < boundaries.length - 1; n++) {
    const day = boundaries[n], until = boundaries[n + 1];
    while (index < snapshots.length && snapshots[index].day <= day) { visible = snapshots[index].state; proof = snapshots[index].evidence; index++; }
    const interval: LayerHistoryInterval = { startDate: day, endDateExclusive: until, occupants: day < coverageStart ? [] : occupied(visible,input.includeQuantities), issues: issues.filter(i => i.startDate < until && i.endDateExclusive > day), evidenceIds: day < coverageStart ? [] : proof };
    const previous = intervals.at(-1);
    if (previous && JSON.stringify([previous.occupants, previous.issues, previous.evidenceIds]) === JSON.stringify([interval.occupants, interval.issues, interval.evidenceIds])) previous.endDateExclusive = until;
    else intervals.push(interval);
  }
  const lineage:LayerHistoryLineage[]=[];
  if(input.includeQuantities)for(const e of ordered){
   if(e.cancelled||e.restoredAt||!['move','移库','staging'].includes(e.kind)||e.problems.length)continue;
   const proven:Array<{parent:Physical;child:Physical}>=[];
   for(const child of e.after.values()){
    if(e.before.has(child.id)||child.quantity<=0&&child.boxes<=0)continue;
    const parents=[...e.before.values()].filter(parent=>parent.id!==child.id&&parent.kind===child.kind&&documentaryCustomers.get(parent)===documentaryCustomers.get(child)&&parent.inboundDate===child.inboundDate&&parent.productName===child.productName&&parent.sku===child.sku&&parent.quantity-(e.after.get(parent.id)?.quantity??0)>=child.quantity&&parent.boxes-(e.after.get(parent.id)?.boxes??0)>=child.boxes);
    if(parents.length===1)proven.push({parent:parents[0],child});
   }
   for(const{parent,child}of proven){const siblings=proven.filter(p=>p.parent.id===parent.id);if(siblings.reduce((n,p)=>n+p.child.quantity,0)!==parent.quantity-(e.after.get(parent.id)?.quantity??0)||siblings.reduce((n,p)=>n+p.child.boxes,0)!==parent.boxes-(e.after.get(parent.id)?.boxes??0))continue;lineage.push({parentId:parent.id,childId:child.id,day:e.day});}
  }
  return { intervals, issues, coverageStart, checkpointAt: cp.capturedAt, currentArrivalReviewIds,...(input.includeQuantities?{lineage}:{}) };
}
