CREATE TABLE `wms_move_requests` (
  `request_id` text PRIMARY KEY NOT NULL,
  `actor_id` integer NOT NULL,
  `fingerprint` text NOT NULL,
  `operation_id` text NOT NULL UNIQUE,
  `response_json` text,
  `response_status` integer,
  `created_at` text NOT NULL,
  CONSTRAINT `wms_move_request_complete` CHECK (
    (response_json IS NULL AND response_status IS NULL)
    OR (response_json IS NOT NULL AND json_valid(response_json) AND response_status = 200)
  )
);

--> statement-breakpoint
CREATE TABLE wms_counts (
 id TEXT PRIMARY KEY NOT NULL, number TEXT NOT NULL UNIQUE, location TEXT NOT NULL,
 blind INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('draft','submitted','reviewed','cancelled')),
 version INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL, observations TEXT NOT NULL DEFAULT '[]',
 conclusion TEXT NOT NULL DEFAULT '', created_by INTEGER NOT NULL, created_name TEXT NOT NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, reviewed_by INTEGER, reviewed_name TEXT,
 reviewed_at TEXT
);
--> statement-breakpoint
CREATE INDEX wms_counts_status_idx ON wms_counts(status,updated_at);
--> statement-breakpoint
CREATE TABLE wms_count_requests (
 id TEXT PRIMARY KEY NOT NULL, actor_id INTEGER NOT NULL, fingerprint TEXT NOT NULL,
 response TEXT NOT NULL, created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE wms_count_guards (id TEXT PRIMARY KEY NOT NULL, valid INTEGER NOT NULL CHECK(valid=1));

--> statement-breakpoint
-- Documentary physical baseline only: never updates inventory or financial rows.
CREATE TABLE IF NOT EXISTS layer_storage_checkpoints (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  captured_at TEXT NOT NULL,
  value TEXT NOT NULL,
  audit_high_id INTEGER NOT NULL CHECK (audit_high_id >= 0)
);
