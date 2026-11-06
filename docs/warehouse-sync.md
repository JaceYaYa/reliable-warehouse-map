# Warehouse synchronization

V82 synchronization optimization. Production publishing requires explicit approval.

## Behavior

- The visible, online page checks `/api/sync` every 12 seconds after completion. One request is in flight at a time; a 20-second timeout and capped 24/48/96/120-second retry delays prevent stalled or failed requests from piling up.
- Hidden/offline pages pause and discard late responses. Visibility/online recovery requests an immediate check. Logout/unmount invalidates all pending responses.
- A single three-row revision query decides which of stocks, layout/canvas, and latest movement need loading. No change means no stock scan or full layout/history download.
- Mutation barriers cover the entire save/delete/transfer/restore UI operation, including body parsing and local updates. After the barrier ends, a fresh check is scheduled immediately.
- Dirty stock drafts still use the existing `stockDirty` protection. Dirty/locked layouts are deferred and their revision is not acknowledged.
- The newest movement uses a partial ID index and does not count history. Full history pagination and restoration permissions remain unchanged.
- Authentication still checks active user/session/expiry on every request. Schema/account initialization stays on the login path, not every synchronized read.

## Migration and overhead

`0009_warehouse_sync_versions.sql` adds three revision rows, nine write triggers and a partial history index. It does not rewrite stock quantities or historical records. Stock inserts/updates/deletes, relevant settings changes, and relevant audit inserts/updates/deletes update their revision transactionally, including imports, restores and backup restores. A rollback also rolls back the revision.

Each affected row write adds one revision-row update. This is a deliberate read-versus-write tradeoff, not a claim of zero database writes or a verified cost reduction. Bulk imports also execute the triggers for each affected row. Backups need not copy this derived table; restore writes invalidate the existing revisions. Whole database replacements get fresh random tokens when migrated.

Apply the migration before serving the new client/endpoint. Missing migration produces a retryable 503, never an empty-success inventory response. Keep the existing version online until migration/build validation completes. Regression tests use an isolated in-memory SQLite database; release verification must also confirm the revision table is present in production without editing inventory.

## Usage panel

Admin-only, collapsed by default, scoped to this page session. Browser request attempts and valid responses are counted locally. Database row reads/writes come only from D1 metadata for successful sync data-query responses; authentication, mutations, other pages and unreceived responses are not included. Missing metadata remains unknown. No platform quota, CPU usage, global historical consumption or bill amount is fabricated. No telemetry writes are introduced.

The no-change fake-clock test counts 301 checks in one visible hour including initial load, versus the old theoretical 903 requests. This is a test/estimate comparison, not production analytics.

## Validation

`pnpm test` includes `tests/warehouse-sync-regressions.test.mjs`: timers, single-flight behavior, dirty layouts, mutation races, timeout/backoff, visibility/online recovery, unauthorized sessions, migration/rollback, cross-client CRUD, archival/layout deletion, permissions, indexed latest-history reads, version/data read races and honest usage samples. Existing stock editor regressions cover unsaved drafts.
