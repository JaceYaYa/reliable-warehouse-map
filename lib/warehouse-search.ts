import type {CartonReceipt} from './carton-flow';
export function cartonWarehouseSearchRecords(receipts:readonly CartonReceipt[]){
  return receipts.flatMap(receipt=>receipt.placements.filter(p=>p.boxes>0).map(p=>({kind:'carton' as const,receipt,placementKey:p.key,searchKey:`carton:${receipt.id}:${p.key}`,locationCode:p.locationCode,layerCount:p.layerCount,product:p.details?.product??p.product?.name??receipt.inboundOrder,sku:p.details?.sku??p.product?.sku,productPrefix:p.marker,...(p.details?.productCondition?{productCondition:p.details.productCondition}:{}),barcode:(p.details?.barcodes??[]).join('\n'),inboundOrder:p.details?.inboundOrder??receipt.inboundOrder,inboundDate:p.details?.inboundDate??receipt.inboundDate,customerName:p.details?.customerName??receipt.customerName,totalBoxes:p.boxes,palletCount:p.palletCount??(p.boxes>0?1:0),note:[receipt.note,p.note].filter(Boolean).join(' '),searchAliases:[receipt.inboundOrder,receipt.originalOrder,...receipt.orderHistory.map(h=>h.number)].join(' ')})));
}
export type WarehouseSearchRecord = {
  locationCode?: unknown;
  product?: unknown;
  productPrefix?: unknown; productCondition?: unknown;
  barcode?: unknown;
  sku?: unknown; fnsku?: unknown;
  inboundOrder?: unknown;
  customerName?: unknown;
  note?: unknown; searchAliases?: unknown;
};

export type WarehouseSearchOptions = {
  limit?: number;
  fuzzyLimit?: number;
};

export type WarehouseSearchHighlightPart = {
  text: string;
  matched: boolean;
};

const SEARCH_FIELDS = ["locationCode", "barcode", "sku", "fnsku", "inboundOrder", "product", "customerName", "productPrefix", "productCondition", "note", "searchAliases"] as const;
const DEFAULT_FUZZY_LIMIT = 12;
const MAX_FUZZY_QUERY_LENGTH = 64;
const MIN_PARTIAL_QUERY_LENGTH = 6;
const MIN_SHARED_CJK_LENGTH = 5;
const MAX_PARTIAL_TOKENS = 16;

function normalizeDimensionSeparators(value: string) {
  return value.replace(/([0-9](?:[.,][0-9]+)?)\s*[xX×*＊]\s*(?=[0-9])/g, "$1X");
}

function normalizeWarehouseSearchExact(value: unknown) {
  return normalizeDimensionSeparators(String(value ?? "")
    .normalize("NFKC")
    .toUpperCase())
    .replace(/[\p{P}\p{S}\p{Z}\s]+/gu, "");
}

export function normalizeWarehouseSearch(value: unknown) {
  return normalizeWarehouseSearchExact(value).replace(/[O0]/g, "0");
}

function differsByOneEditOrSwap(query: string, candidate: string) {
  const lengthDifference = candidate.length - query.length;
  if (Math.abs(lengthDifference) > 1) return false;

  if (lengthDifference === 0) {
    const mismatches: number[] = [];
    for (let index = 0; index < query.length; index += 1) {
      if (query[index] !== candidate[index]) {
        mismatches.push(index);
        if (mismatches.length > 2) return false;
      }
    }
    if (mismatches.length === 1) return query.length >= 4;
    if (mismatches.length !== 2) return false;
    const [first, second] = mismatches;
    return second === first + 1 && query[first] === candidate[second] && query[second] === candidate[first];
  }

  if (query.length < 4) return false;
  const shorter = lengthDifference > 0 ? query : candidate;
  const longer = lengthDifference > 0 ? candidate : query;
  let shortIndex = 0, longIndex = 0, skipped = false;
  while (shortIndex < shorter.length && longIndex < longer.length) {
    if (shorter[shortIndex] === longer[longIndex]) {
      shortIndex += 1;
      longIndex += 1;
      continue;
    }
    if (skipped) return false;
    skipped = true;
    longIndex += 1;
  }
  return true;
}

type FuzzyWindow = { position: number; length: number };

function fuzzyWindow(candidate: string, query: string): FuzzyWindow | null {
  if (query.length < 3 || query.length > MAX_FUZZY_QUERY_LENGTH) return null;
  const windowLengths = query.length === 3 ? [query.length] : [query.length, query.length - 1, query.length + 1];
  let best: FuzzyWindow | null = null;
  for (const windowLength of windowLengths) {
    if (windowLength < 1 || windowLength > candidate.length) continue;
    for (let start = 0; start <= candidate.length - windowLength; start += 1) {
      if (differsByOneEditOrSwap(query, candidate.slice(start, start + windowLength))) {
        if (!best || start < best.position) best = { position: start, length: windowLength };
        break;
      }
    }
  }
  return best;
}

function fuzzyPosition(candidate: string, query: string) {
  return fuzzyWindow(candidate, query)?.position ?? -1;
}

type MatchScore = {
  tier: 0 | 1 | 2 | 3;
  folded: 0 | 1;
  field: number;
  position: number;
  length: number;
};

type PartialMatchScore = {
  compositeIdentifierHits: number;
  identifierChars: number;
  identifierHits: number;
  directHits: number;
  matchedChars: number;
  matchedTokens: number;
  longestMatch: number;
  foldedHits: number;
  fuzzyHits: number;
  field: number;
  position: number;
  length: number;
};

type RecordScore =
  | { kind: "whole"; score: MatchScore }
  | { kind: "name"; score: NameScore }
  | { kind: "partial"; score: PartialMatchScore };

type NameQuery={han:string;counts:Map<string,number>;bigrams:Set<string>;ascii:string[];shortModel:boolean};
type NameScore={complete:boolean;coverage:number;matchedChars:number;extraModelChars:number;length:number};
const hanPattern=/\p{Script=Han}/u;
function nameQuery(raw:unknown):NameQuery|null{
 const source=String(raw??'').normalize('NFKC').toUpperCase();
 if(normalizeWarehouseSearchExact(source).length>MAX_FUZZY_QUERY_LENGTH||warehouseSearchTokens(source).some(token=>token.composite&&token.identifier))return null;
 const runs=source.match(/[\p{Script=Han}]+/gu)??[],han=runs.join(''),ascii=[...new Set(source.match(/[A-Z]+|[0-9]+/g)??[])];
 const compactModel=/^(?:IPHONE)?[0-9]{1,2}(?:PRO(?:MAX)?|MAX|PLUS|AIR|MINI|SE|ULTRA)$/.test(normalizeWarehouseSearchExact(source));
 if(!han&&!compactModel&&(ascii.length<2||(source.match(/[A-Z0-9]+/g)??[]).length<2))return null;
 const counts=new Map<string,number>(),bigrams=new Set<string>();for(const char of han)counts.set(char,(counts.get(char)??0)+1);
 for(const run of runs)for(let i=1;i<run.length;i++)bigrams.add(run.slice(i-1,i+1));
 return {han,counts,bigrams,ascii,shortModel:(!!han||compactModel)&&ascii.some(token=>/^[0-9]{1,2}$/.test(token))&&ascii.some(token=>/^[A-Z]+$/.test(token))};
}
function nameScore(candidate:string,query:NameQuery):NameScore|null{
 if(!candidate||candidate.length>512)return null;
 const words=candidate.match(/[A-Z]+|[0-9]+/g)??[],matchedWords=new Set<string>();
 for(const token of query.ascii){const word=words.filter(word=>/^[0-9]+$/.test(token)?word===token:word.includes(token)).sort((a,b)=>a.length-b.length)[0];if(!word)return null;matchedWords.add(word);}
 const candidateHan=candidate.match(/[\p{Script=Han}]+/gu)??[],counts=new Map<string,number>();for(const char of candidateHan.join(''))counts.set(char,(counts.get(char)??0)+1);
 let matchedHan=0;for(const [char,count] of query.counts)matchedHan+=Math.min(count,counts.get(char)??0);
 if(query.han){const anchored=candidateHan.some(run=>Array.from({length:Math.max(0,run.length-1)},(_,i)=>run.slice(i,i+2)).some(pair=>query.bigrams.has(pair)));if(matchedHan<2||matchedHan/query.han.length<.25||!anchored)return null;}
 const asciiChars=query.ascii.reduce((n,token)=>n+token.length,0),matchedChars=matchedHan+asciiChars;
 const extraModelChars=Math.max(0,[...matchedWords].reduce((n,word)=>n+word.length,0)-asciiChars);
 return {complete:matchedHan===query.han.length&&extraModelChars===0,coverage:matchedChars/(query.han.length+asciiChars),matchedChars,extraModelChars,length:candidate.length};
}
function recordName(record:WarehouseSearchRecord){return normalizeWarehouseSearchExact([record.product,record.productPrefix,record.productCondition==='damaged'?'残次品':record.productCondition==='good'?'正品':''].filter(Boolean).join(' '));}
function compareNameScores(a:NameScore,b:NameScore){return Number(b.complete)-Number(a.complete)||b.coverage-a.coverage||a.extraModelChars-b.extraModelChars||b.matchedChars-a.matchedChars||a.length-b.length;}
/** A suggestion only: never used by exact SKU recognition or automatic imports. */
export function isApproximateWarehouseSearchMatch(record:WarehouseSearchRecord,rawQuery:unknown){
 const query=normalizeWarehouseSearchExact(rawQuery);if(!query)return false;
 if(SEARCH_FIELDS.some(field=>normalizeWarehouseSearchExact(record[field])===query))return false;
 const keywords=nameQuery(rawQuery),score=keywords?nameScore(recordName(record),keywords):null;if(score)return !score.complete;
 return !SEARCH_FIELDS.some(field=>normalizeWarehouseSearchExact(record[field]).includes(query));
}
export const allowsLiteralWarehouseSearchFallback=(rawQuery:unknown)=>!nameQuery(rawQuery)?.shortModel;

function fieldScore(candidate: string, query: string, field: number, folded: 0 | 1): MatchScore | null {
  if (!candidate) return null;
  if (candidate === query) return { tier: 0, folded, field, position: 0, length: candidate.length };
  const position = candidate.indexOf(query);
  if (position === 0) return { tier: 1, folded, field, position, length: candidate.length };
  if (position > 0) return { tier: 2, folded, field, position, length: candidate.length };
  const approximatePosition = fuzzyPosition(candidate, query);
  return approximatePosition >= 0 ? { tier: 3, folded, field, position: approximatePosition, length: candidate.length } : null;
}

function scoreRank(score: MatchScore) {
  if (score.tier === 3) return 6;
  return score.tier + score.folded * 3;
}

function compareScores(left: MatchScore, right: MatchScore) {
  return scoreRank(left) - scoreRank(right) || left.folded - right.folded || left.field - right.field || left.position - right.position || left.length - right.length;
}

type SearchToken = {
  value: string;
  identifier: boolean;
  composite: boolean;
  foldable: boolean;
};

function canFoldO0Identifier(value: string) {
  return /[0-9]O|O[0-9]|[A-Z0-9]0[A-Z0-9]/.test(value);
}

function warehouseSearchTokens(value: unknown) {
  const source = normalizeDimensionSeparators(String(value ?? "").normalize("NFKC").toUpperCase());
  const tokens = new Map<string, SearchToken>();
  const addToken = (rawToken: string, composite = false) => {
    const token = normalizeWarehouseSearchExact(rawToken);
    if (/^[\p{Script=Han}]+$/u.test(token) ? token.length < 2 : token.length < 3) return;
    const existing = tokens.get(token);
    tokens.set(token, {
      value: token,
      identifier: /[0-9]/.test(token) && (/[A-Z]/.test(token) || /^[0-9]{3,}$/.test(token)),
      composite: composite || existing?.composite || false,
      foldable: canFoldO0Identifier(token),
    });
  };
  for (const composite of source.match(/[A-Z0-9]+(?:[-_./‐‑‒–—][A-Z0-9]+)+/g) ?? []) addToken(composite, true);
  for (const token of source.match(/[\p{Script=Han}]+|[A-Z0-9]+/gu) ?? []) addToken(token);
  return [...tokens.values()].slice(0, MAX_PARTIAL_TOKENS);
}

function longestSharedCjk(candidate: string, query: string) {
  if (query.length < MIN_SHARED_CJK_LENGTH || candidate.length < MIN_SHARED_CJK_LENGTH) return null;
  let previous = new Uint16Array(query.length + 1), current = new Uint16Array(query.length + 1);
  let bestLength = 0, bestPosition = -1;
  for (let candidateIndex = 1; candidateIndex <= candidate.length; candidateIndex += 1) {
    current.fill(0);
    for (let queryIndex = 1; queryIndex <= query.length; queryIndex += 1) {
      if (candidate[candidateIndex - 1] !== query[queryIndex - 1]) continue;
      current[queryIndex] = previous[queryIndex - 1] + 1;
      const position = candidateIndex - current[queryIndex];
      if (current[queryIndex] > bestLength || (current[queryIndex] === bestLength && position < bestPosition)) {
        bestLength = current[queryIndex];
        bestPosition = position;
      }
    }
    [previous, current] = [current, previous];
  }
  return bestLength >= MIN_SHARED_CJK_LENGTH ? { length: bestLength, position: bestPosition } : null;
}

type TokenHit = {
  length: number;
  folded: 0 | 1;
  fuzzy: 0 | 1;
  field: number;
  position: number;
  candidateLength: number;
  identifier: 0 | 1;
  composite: 0 | 1;
};

function compareTokenHits(left: TokenHit, right: TokenHit) {
  return right.length - left.length || left.fuzzy - right.fuzzy || left.folded - right.folded || left.field - right.field || left.position - right.position || left.candidateLength - right.candidateLength;
}

function tokenFieldHit(candidate: string, token: SearchToken, field: number): TokenHit | null {
  if (!candidate) return null;
  const directPosition = candidate.indexOf(token.value);
  if (directPosition >= 0) return { length: token.value.length, folded: 0, fuzzy: 0, field, position: directPosition, candidateLength: candidate.length, identifier: token.identifier ? 1 : 0, composite: token.composite ? 1 : 0 };

  const foldedCandidate = token.foldable ? normalizeWarehouseSearch(candidate) : candidate;
  const foldedToken = token.foldable ? normalizeWarehouseSearch(token.value) : token.value;
  const foldedPosition = token.foldable ? foldedCandidate.indexOf(foldedToken) : -1;
  if (foldedPosition >= 0) return { length: token.value.length, folded: 1, fuzzy: 0, field, position: foldedPosition, candidateLength: candidate.length, identifier: 1, composite: token.composite ? 1 : 0 };

  if (/^[\p{Script=Han}]+$/u.test(token.value)) {
    const shared = longestSharedCjk(candidate, token.value);
    return shared ? { length: shared.length, folded: 0, fuzzy: 1, field, position: shared.position, candidateLength: candidate.length, identifier: 0, composite: 0 } : null;
  }

  if (token.value.length < 4 || token.value.length > MAX_FUZZY_QUERY_LENGTH) return null;
  const directFuzzyPosition = fuzzyPosition(candidate, token.value);
  if (directFuzzyPosition >= 0) return { length: token.value.length - 1, folded: 0, fuzzy: 1, field, position: directFuzzyPosition, candidateLength: candidate.length, identifier: token.identifier ? 1 : 0, composite: token.composite ? 1 : 0 };
  const foldedFuzzyPosition = fuzzyPosition(foldedCandidate, foldedToken);
  return foldedFuzzyPosition >= 0
    ? { length: token.value.length - 1, folded: 1, fuzzy: 1, field, position: foldedFuzzyPosition, candidateLength: candidate.length, identifier: token.identifier ? 1 : 0, composite: token.composite ? 1 : 0 }
    : null;
}

function partialRecordScore(candidates: readonly string[], tokens: readonly SearchToken[]): PartialMatchScore | null {
  const hits: TokenHit[] = [];
  for (const token of tokens) {
    let best: TokenHit | null = null;
    for (let field = 0; field < candidates.length; field += 1) {
      const hit = tokenFieldHit(candidates[field], token, field);
      if (hit && (!best || compareTokenHits(hit, best) < 0)) best = hit;
    }
    if (best) hits.push(best);
  }
  if (!hits.length) return null;
  const matchedChars = hits.reduce((sum, hit) => sum + hit.length, 0);
  const longestMatch = Math.max(...hits.map(hit => hit.length));
  const identifierHits = hits.reduce((sum, hit) => sum + hit.identifier, 0);
  if (!identifierHits && longestMatch < MIN_SHARED_CJK_LENGTH && (hits.length < 2 || matchedChars < 6)) return null;
  const strongest = [...hits].sort(compareTokenHits)[0];
  return {
    compositeIdentifierHits: hits.reduce((sum, hit) => sum + (hit.identifier && hit.composite && !hit.fuzzy ? 1 : 0), 0),
    identifierChars: hits.reduce((sum, hit) => sum + (hit.identifier ? hit.length : 0), 0),
    identifierHits,
    directHits: hits.reduce((sum, hit) => sum + (hit.fuzzy ? 0 : 1), 0),
    matchedChars,
    matchedTokens: hits.length,
    longestMatch,
    foldedHits: hits.reduce((sum, hit) => sum + hit.folded, 0),
    fuzzyHits: hits.reduce((sum, hit) => sum + hit.fuzzy, 0),
    field: strongest.field,
    position: strongest.position,
    length: strongest.candidateLength,
  };
}

function comparePartialScores(left: PartialMatchScore, right: PartialMatchScore) {
  return right.compositeIdentifierHits - left.compositeIdentifierHits
    || right.identifierChars - left.identifierChars
    || right.identifierHits - left.identifierHits
    || right.matchedChars - left.matchedChars
    || right.matchedTokens - left.matchedTokens
    || right.longestMatch - left.longestMatch
    || left.fuzzyHits - right.fuzzyHits
    || left.foldedHits - right.foldedHits
    || left.field - right.field
    || left.position - right.position
    || left.length - right.length;
}

function compareRecordScores(left: RecordScore, right: RecordScore) {
  if(left.kind==='name'&&right.kind==='name')return compareNameScores(left.score,right.score);
  if(left.kind==='name'||right.kind==='name'){
    const rank=(value:RecordScore)=>value.kind==='whole'?(value.score.tier<3?0:3):value.kind==='name'?(value.score.complete?1:4):(value.score.directHits>0?2:3);
    return rank(left)-rank(right);
  }
  if (left.kind === "whole" && right.kind === "whole") return compareScores(left.score, right.score);
  if (left.kind !== right.kind) return left.kind === "whole" ? -1 : 1;
  if (left.kind === "partial" && right.kind === "partial") return comparePartialScores(left.score, right.score);
  return 0;
}

export function searchWarehouseRecords<T extends WarehouseSearchRecord>(
  records: readonly T[],
  rawQuery: unknown,
  options: WarehouseSearchOptions = {},
) {
  const exactQuery = normalizeWarehouseSearchExact(rawQuery);
  if (!exactQuery) return [];
  const foldedQuery = normalizeWarehouseSearch(exactQuery);
  const queryTokens = warehouseSearchTokens(rawQuery);
  const keywords=nameQuery(rawQuery);
  const partialTokens = exactQuery.length >= MIN_PARTIAL_QUERY_LENGTH ? queryTokens : [];
  const allowWholeQueryFold = queryTokens.length === 1 && queryTokens[0].identifier && queryTokens[0].foldable;
  const requestedLimit = options.limit === undefined ? null : Number(options.limit);
  const requestedFuzzyLimit = options.fuzzyLimit === undefined ? DEFAULT_FUZZY_LIMIT : Number(options.fuzzyLimit);
  const limit = requestedLimit !== null && Number.isFinite(requestedLimit) ? Math.max(1, Math.trunc(requestedLimit)) : null;
  const fuzzyLimit = Number.isFinite(requestedFuzzyLimit) ? Math.max(0, Math.trunc(requestedFuzzyLimit)) : DEFAULT_FUZZY_LIMIT;
  const matches = records.flatMap((record, originalIndex) => {
    let best: MatchScore | null = null;
    const candidates: string[] = [];
    for (let field = 0; field < SEARCH_FIELDS.length; field += 1) {
      const raw=record[SEARCH_FIELDS[field]],value=SEARCH_FIELDS[field]==="productCondition"?raw==="damaged"?"残次品":raw==="good"?"正品":"":raw;
      const exactCandidate = normalizeWarehouseSearchExact(value);
      candidates.push(exactCandidate);
      const exactScore = fieldScore(exactCandidate, exactQuery, field, 0);
      const foldedScore = allowWholeQueryFold ? fieldScore(normalizeWarehouseSearch(exactCandidate), foldedQuery, field, 1) : null;
      for (const score of [exactScore, foldedScore]) {
        if (score && (!best || compareScores(score, best) < 0)) best = score;
      }
    }
    const name=keywords?nameScore(recordName(record),keywords):null;
    const candidateNumbers:string[]=recordName(record).match(/[0-9]+/g)??[];
    const wrongShortModel=keywords?.shortModel&&keywords.ascii.filter(token=>/^[0-9]{1,2}$/.test(token)).some(token=>!candidateNumbers.includes(token));
    const extendedProductModel=best?.field===SEARCH_FIELDS.indexOf('product')&&name&&name.extraModelChars>0;
    const score: RecordScore | null = best&&best.tier<3&&!extendedProductModel
      ? { kind: "whole", score: best }
      : name ? {kind:'name',score:name}
      : wrongShortModel ? null
      : best ? {kind:'whole',score:best}
      : keywords?.shortModel&&keywords.han ? null
      : partialTokens.length
        ? (() => { const partial = partialRecordScore(candidates, partialTokens); return partial ? { kind: "partial" as const, score: keywords?.shortModel?{...partial,directHits:0}:partial } : null; })()
        : null;
    return score ? [{ record, score, originalIndex }] : [];
  }).sort((left, right) => compareRecordScores(left.score, right.score) || left.originalIndex - right.originalIndex);

  const direct = matches.filter(match => match.score.kind === "whole" && match.score.score.tier < 3);
  const completeNames=matches.filter(match=>match.score.kind==='name'&&match.score.score.complete);
  const partialDirect = matches.filter(match => match.score.kind === "partial" && match.score.score.directHits > 0);
  const fuzzy = matches.filter(match => (match.score.kind === "whole" && match.score.score.tier === 3) || (match.score.kind === "partial" && match.score.score.directHits === 0)||(match.score.kind==='name'&&!match.score.score.complete)).slice(0, fuzzyLimit);
  const combined = [...direct, ...completeNames,...partialDirect, ...fuzzy];
  return (limit === null ? combined : combined.slice(0, limit)).map(match => match.record);
}

type SearchSourceUnit = {
  char: string;
  start: number;
  end: number;
};

type SearchSourceMap = {
  source: string;
  text: string;
  units: SearchSourceUnit[];
};

type SearchHighlightRange = {
  start: number;
  end: number;
};

const SEARCH_GRAPHEME_SEGMENTER = typeof Intl.Segmenter === "function" ? new Intl.Segmenter("zh-CN", { granularity: "grapheme" }) : null;
const SEARCH_SEPARATOR_PATTERN = /^[X×*＊]$/u;
const SEARCH_IGNORED_PATTERN = /[\p{P}\p{S}\p{Z}\s]/u;

function warehouseSearchSourceSegments(source: string) {
  if (SEARCH_GRAPHEME_SEGMENTER) return [...SEARCH_GRAPHEME_SEGMENTER.segment(source)].map(item => ({ segment: item.segment, index: item.index }));
  const segments: { segment: string; index: number }[] = [];
  let index = 0;
  for (const char of source) {
    const previous = segments.at(-1);
    if (previous && /^\p{M}$/u.test(char)) previous.segment += char;
    else segments.push({ segment: char, index });
    index += char.length;
  }
  return segments;
}

function normalizeWarehouseSearchWithMap(value: unknown): SearchSourceMap {
  const source = String(value ?? "");
  const rawUnits: SearchSourceUnit[] = [];
  for (const segment of warehouseSearchSourceSegments(source)) {
    const normalized = segment.segment.normalize("NFKC").toUpperCase();
    for (const char of normalized) rawUnits.push({ char, start: segment.index, end: segment.index + segment.segment.length });
  }

  const dimensionUnits = rawUnits.map((unit, index) => {
    if (!SEARCH_SEPARATOR_PATTERN.test(unit.char)) return unit;
    let before = index - 1, after = index + 1;
    while (before >= 0 && /\s/u.test(rawUnits[before].char)) before -= 1;
    while (after < rawUnits.length && /\s/u.test(rawUnits[after].char)) after += 1;
    return before >= 0 && after < rawUnits.length && /[0-9]/.test(rawUnits[before].char) && /[0-9]/.test(rawUnits[after].char)
      ? { ...unit, char: "X" }
      : unit;
  });
  const units = dimensionUnits
    .filter(unit => !SEARCH_IGNORED_PATTERN.test(unit.char))
    .flatMap(unit => Array.from({ length: unit.char.length }, (_, index) => ({ ...unit, char: unit.char[index] })));
  const text = units.map(unit => unit.char).join("");
  return text === normalizeWarehouseSearchExact(source) ? { source, text, units } : { source, text, units: [] };
}

function allSearchPositions(candidate: string, query: string) {
  if (!query) return [];
  const positions: number[] = [];
  let offset = 0;
  while (offset <= candidate.length - query.length && positions.length < 32) {
    const position = candidate.indexOf(query, offset);
    if (position < 0) break;
    positions.push(position);
    offset = position + 1;
  }
  return positions;
}

function addMappedRange(ranges: SearchHighlightRange[], mapped: SearchSourceMap, position: number, length: number) {
  if (position < 0 || length < 1 || position + length > mapped.units.length) return;
  ranges.push({ start: mapped.units[position].start, end: mapped.units[position + length - 1].end });
}

function matchingCandidateIndices(query: string, candidate: string) {
  const matches: number[] = [];
  if (query.length === candidate.length) {
    for (let index = 0; index < candidate.length; index += 1) if (query[index] === candidate[index]) matches.push(index);
    return matches;
  }

  let queryIndex = 0, candidateIndex = 0, skipped = false;
  if (candidate.length === query.length + 1) {
    while (candidateIndex < candidate.length) {
      if (queryIndex < query.length && query[queryIndex] === candidate[candidateIndex]) {
        matches.push(candidateIndex);
        queryIndex += 1;
        candidateIndex += 1;
      } else if (!skipped) {
        skipped = true;
        candidateIndex += 1;
      } else break;
    }
    return matches;
  }

  if (query.length === candidate.length + 1) {
    while (queryIndex < query.length && candidateIndex < candidate.length) {
      if (query[queryIndex] === candidate[candidateIndex]) {
        matches.push(candidateIndex);
        queryIndex += 1;
        candidateIndex += 1;
      } else if (!skipped) {
        skipped = true;
        queryIndex += 1;
      } else break;
    }
  }
  return matches;
}

function addFuzzyRanges(
  ranges: SearchHighlightRange[],
  mapped: SearchSourceMap,
  candidate: string,
  query: string,
  window: FuzzyWindow,
) {
  const matchedIndices = matchingCandidateIndices(query, candidate.slice(window.position, window.position + window.length));
  let groupStart = -1, previous = -2;
  const flush = () => {
    if (groupStart >= 0) addMappedRange(ranges, mapped, window.position + groupStart, previous - groupStart + 1);
    groupStart = -1;
  };
  for (const index of matchedIndices) {
    if (index !== previous + 1) flush();
    if (groupStart < 0) groupStart = index;
    previous = index;
  }
  flush();
}

function addTokenHighlightRanges(ranges: SearchHighlightRange[], mapped: SearchSourceMap, token: SearchToken) {
  const directPositions = allSearchPositions(mapped.text, token.value);
  if (directPositions.length) {
    for (const position of directPositions) addMappedRange(ranges, mapped, position, token.value.length);
    return;
  }

  const foldedCandidate = token.foldable ? normalizeWarehouseSearch(mapped.text) : mapped.text;
  const foldedToken = token.foldable ? normalizeWarehouseSearch(token.value) : token.value;
  const foldedPositions = token.foldable ? allSearchPositions(foldedCandidate, foldedToken) : [];
  if (foldedPositions.length) {
    for (const position of foldedPositions) addMappedRange(ranges, mapped, position, foldedToken.length);
    return;
  }

  if (mapped.text.length > 512) return;

  if (/^[\p{Script=Han}]+$/u.test(token.value)) {
    const shared = longestSharedCjk(mapped.text, token.value);
    if (shared) addMappedRange(ranges, mapped, shared.position, shared.length);
    return;
  }

  if (token.value.length < 4 || token.value.length > MAX_FUZZY_QUERY_LENGTH) return;
  const directWindow = fuzzyWindow(mapped.text, token.value);
  if (directWindow) {
    addFuzzyRanges(ranges, mapped, mapped.text, token.value, directWindow);
    return;
  }
  const foldedWindow = token.foldable ? fuzzyWindow(foldedCandidate, foldedToken) : null;
  if (foldedWindow) addFuzzyRanges(ranges, mapped, foldedCandidate, foldedToken, foldedWindow);
}

function mergedHighlightRanges(ranges: SearchHighlightRange[], sourceLength: number) {
  const ordered = ranges
    .filter(range => range.start >= 0 && range.end > range.start && range.end <= sourceLength)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: SearchHighlightRange[] = [];
  for (const range of ordered) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else if (merged.length < 24) merged.push({ ...range });
  }
  return merged;
}

export function highlightWarehouseSearchText(value: unknown, rawQuery: unknown): WarehouseSearchHighlightPart[] {
  const mapped = normalizeWarehouseSearchWithMap(value);
  const exactQuery = normalizeWarehouseSearchExact(rawQuery);
  if (!mapped.source || !exactQuery || !mapped.units.length) return [{ text: mapped.source, matched: false }];

  const ranges: SearchHighlightRange[] = [];
  for (const position of allSearchPositions(mapped.text, exactQuery)) addMappedRange(ranges, mapped, position, exactQuery.length);

  const queryTokens = warehouseSearchTokens(rawQuery);
  const allowWholeQueryFold = queryTokens.length === 1 && queryTokens[0].identifier && queryTokens[0].foldable;
  if (allowWholeQueryFold) {
    const foldedCandidate = normalizeWarehouseSearch(mapped.text), foldedQuery = normalizeWarehouseSearch(exactQuery);
    for (const position of allSearchPositions(foldedCandidate, foldedQuery)) addMappedRange(ranges, mapped, position, foldedQuery.length);
  }

  if (!ranges.length && mapped.text.length <= 512) {
    const directWindow = fuzzyWindow(mapped.text, exactQuery);
    if (directWindow) addFuzzyRanges(ranges, mapped, mapped.text, exactQuery, directWindow);
    else if (allowWholeQueryFold) {
      const foldedCandidate = normalizeWarehouseSearch(mapped.text), foldedQuery = normalizeWarehouseSearch(exactQuery);
      const foldedWindow = fuzzyWindow(foldedCandidate, foldedQuery);
      if (foldedWindow) addFuzzyRanges(ranges, mapped, foldedCandidate, foldedQuery, foldedWindow);
    }
  }

  if (exactQuery.length >= MIN_PARTIAL_QUERY_LENGTH) {
    for (const token of queryTokens) addTokenHighlightRanges(ranges, mapped, token);
  }
  const keywords=nameQuery(rawQuery);
  if(keywords&&nameScore(mapped.text,keywords)){
    for(let index=0;index<mapped.text.length;index++)if(hanPattern.test(mapped.text[index])&&keywords.counts.has(mapped.text[index]))addMappedRange(ranges,mapped,index,1);
    for(const token of keywords.ascii)for(const position of allSearchPositions(mapped.text,token))addMappedRange(ranges,mapped,position,token.length);
  }

  const merged = mergedHighlightRanges(ranges, mapped.source.length);
  if (!merged.length) return [{ text: mapped.source, matched: false }];
  const parts: WarehouseSearchHighlightPart[] = [];
  let cursor = 0;
  for (const range of merged) {
    if (range.start > cursor) parts.push({ text: mapped.source.slice(cursor, range.start), matched: false });
    parts.push({ text: mapped.source.slice(range.start, range.end), matched: true });
    cursor = range.end;
  }
  if (cursor < mapped.source.length) parts.push({ text: mapped.source.slice(cursor), matched: false });
  return parts;
}
