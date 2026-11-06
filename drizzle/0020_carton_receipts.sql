CREATE TABLE carton_receipts (
 id TEXT PRIMARY KEY NOT NULL, inbound_order TEXT NOT NULL, original_order TEXT NOT NULL,
 order_history TEXT NOT NULL, customer_name TEXT NOT NULL DEFAULT '', inbound_date TEXT NOT NULL,
 placements TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0),
 created_by INTEGER NOT NULL, created_at TEXT NOT NULL, updated_by INTEGER NOT NULL, updated_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX carton_receipts_customer_idx ON carton_receipts(customer_name,inbound_date);
--> statement-breakpoint
CREATE TABLE carton_operations (
 id TEXT PRIMARY KEY NOT NULL, receipt_id TEXT NOT NULL, kind TEXT NOT NULL,
 fingerprint TEXT NOT NULL, before_snapshot TEXT, after_snapshot TEXT, result TEXT NOT NULL,
 user_id INTEGER NOT NULL, created_at TEXT NOT NULL, restored_at TEXT
);
--> statement-breakpoint
CREATE INDEX carton_operations_receipt_idx ON carton_operations(receipt_id,created_at);
--> statement-breakpoint
CREATE TABLE carton_transaction_guards (id TEXT PRIMARY KEY NOT NULL, valid INTEGER NOT NULL CHECK(valid=1));
