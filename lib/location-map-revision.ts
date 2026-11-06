// A token for the exact map snapshot, independent of display normalization.
export async function locationMapRevision(zones = "", canvas = "") {
  const bytes = new TextEncoder().encode(JSON.stringify([zones, canvas]));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
