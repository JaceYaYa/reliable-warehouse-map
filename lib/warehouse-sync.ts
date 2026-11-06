export const SYNC_INTERVAL_MS = 12_000;
export const SYNC_MAX_RETRY_MS = 120_000;
export type SyncResource = "stocks" | "locations" | "recent";
export const SYNC_RESOURCES: SyncResource[] = ["stocks", "locations", "recent"];
export type SyncVersions = Partial<Record<SyncResource, string>>;
export type SyncUsage = { rowsRead: number | null; rowsWritten: number | null; queries: number };
export type SyncPayload = {
  versions: SyncVersions;
  data: Partial<Record<SyncResource, unknown>>;
  usage?: SyncUsage;
  viewer?: { id: number; username: string; displayName: string; role: string; permissions?: import("./permissions").Permission[]; permissionVersion?: number; mustChange?: number };
};
export type SyncStats = {
  requests: number; succeeded: number; failed: number; unchanged: number;
  snapshots: number; rowsRead: number; rowsWritten: number; measuredResponses: number;
  visibleMs: number; state: "syncing" | "ready" | "paused" | "retrying" | "signed-out";
};

// One request at a time. Versions are accepted only after the corresponding UI data
// is applied; locked/dirty layouts are deliberately retried after editing ends.
export function createWarehouseSync(options: {
  request: (versions: SyncVersions, signal: AbortSignal) => Promise<SyncPayload>;
  apply: (resource: SyncResource, data: unknown) => boolean;
  visible: () => boolean;
  online: () => boolean;
  onStats?: (stats: SyncStats) => void;
  onViewer?: (viewer: NonNullable<SyncPayload["viewer"]>) => void;
  onUnauthorized?: () => void;
  now?: () => number;
  schedule?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
}) {
  const now = options.now ?? Date.now, schedule = options.schedule ?? setTimeout, cancel = options.cancel ?? clearTimeout;
  let stopped = false, running = false, queued = false, epoch = 0, mutations = 0, failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined, controller: AbortController | undefined;
  let versions: SyncVersions = {}, visibleSince: number | null = null;
  const stats: SyncStats = { requests: 0, succeeded: 0, failed: 0, unchanged: 0, snapshots: 0, rowsRead: 0, rowsWritten: 0, measuredResponses: 0, visibleMs: 0, state: "paused" };
  const emit = () => { if (!stopped) options.onStats?.({ ...stats, visibleMs: stats.visibleMs + (visibleSince === null ? 0 : now() - visibleSince) }); };
  const clear = () => { if (timer !== undefined) cancel(timer); timer = undefined; };
  const available = () => !stopped && options.visible() && options.online();
  const later = (delay: number) => { clear(); if (available()) timer = schedule(() => { void run(); }, delay); };
  async function run() {
    clear();
    if (!available() || mutations) { stats.state = "paused"; emit(); return; }
    if (running) { queued = true; return; }
    running = true; queued = false;
    const startedEpoch = epoch;
    controller = new AbortController();
    // A stalled network request must not block synchronization forever.
    const timeout = schedule(() => controller?.abort(), 20_000);
    stats.requests++; stats.state = "syncing"; emit();
    try {
      const payload = await options.request({ ...versions }, controller.signal);
      if (stopped || startedEpoch !== epoch || !available() || mutations) return;
      stats.succeeded++;
      if (payload.usage && payload.usage.rowsRead !== null && payload.usage.rowsWritten !== null) {
        stats.rowsRead += payload.usage.rowsRead; stats.rowsWritten += payload.usage.rowsWritten; stats.measuredResponses++;
      }
      for (const resource of SYNC_RESOURCES) {
        if (Object.prototype.hasOwnProperty.call(payload.data, resource) && options.apply(resource, payload.data[resource])) {
          versions[resource] = payload.versions[resource]; stats.snapshots++;
        }
      }
      if (!Object.keys(payload.data).length) stats.unchanged++;
      if (payload.viewer) options.onViewer?.(payload.viewer);
      failures = 0; stats.state = "ready";
    } catch (error) {
      if (stopped || startedEpoch !== epoch || !available() || mutations) return;
      stats.failed++;
      if ((error as { status?: number }).status === 401) {
        stopped = true; stats.state = "signed-out"; options.onUnauthorized?.();
      } else { failures++; stats.state = "retrying"; }
    } finally {
      cancel(timeout); running = false; controller = undefined; emit();
      if (!stopped && !mutations) later(queued ? 0 : Math.min(SYNC_MAX_RETRY_MS, SYNC_INTERVAL_MS * 2 ** Math.min(failures, 4)));
    }
  }
  function wake() {
    if (stopped) return;
    clear();
    if (options.visible()) { if (visibleSince === null) visibleSince = now(); }
    else if (visibleSince !== null) { stats.visibleMs += now() - visibleSince; visibleSince = null; }
    if (!available()) { epoch++; controller?.abort(); queued = false; stats.state = "paused"; emit(); return; }
    failures = 0;
    void run();
  }
  function invalidate() {
    versions = {}; epoch++; controller?.abort(); queued = true;
  }
  return {
    start: wake,
    wake,
    refresh: async () => { invalidate(); if (!mutations) await run(); },
    // Hold the barrier for the entire UI operation, including response parsing and
    // optimistic updates, not merely until HTTP headers arrive.
    beginMutation: () => {
      mutations++; clear(); invalidate();
      let ended = false;
      return () => { if (ended) return; ended = true; mutations--; if (!mutations && !stopped) later(0); };
    },
    stop: () => { stopped = true; epoch++; controller?.abort(); clear(); },
  };
}

export type WarehouseSync = ReturnType<typeof createWarehouseSync>;
