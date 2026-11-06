export function locationCodeKey(value: unknown) {
  return String(value ?? "").normalize("NFKC").trim().toUpperCase();
}

export function matchingLocationCodes(codes: readonly string[], value: unknown) {
  const key = locationCodeKey(value);
  return key ? codes.filter((code) => locationCodeKey(code) === key) : [];
}

/** Search existing locations only; exact and prefix matches lead substring matches. */
export function searchLocationCodes(codes: readonly string[], value: unknown) {
  const key = locationCodeKey(value);
  if (!key) return [];
  const rank = (code: string) => {const candidate = locationCodeKey(code);return candidate === key ? 0 : candidate.startsWith(key) ? 1 : 2;};
  return [...new Set(codes)].filter(code => locationCodeKey(code).includes(key))
    .sort((a,b) => rank(a)-rank(b) || a.localeCompare(b,'zh-CN',{numeric:true}));
}
