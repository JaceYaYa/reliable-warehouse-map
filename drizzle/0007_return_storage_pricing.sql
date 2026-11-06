ALTER TABLE `stocks` ADD `inbound_source` text NOT NULL DEFAULT 'domestic';--> statement-breakpoint
ALTER TABLE `stocks` ADD `billing_mode` text NOT NULL DEFAULT 'item';--> statement-breakpoint
ALTER TABLE `stocks` ADD `item_volume_m3` real NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE `stocks` ADD `box_volume_m3` real NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE `stocks` ADD `storage_rate_usd` real NOT NULL DEFAULT 0.7;--> statement-breakpoint
ALTER TABLE `stocks` ADD `free_days` integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE `stocks` ADD `catalog_item_id` integer;--> statement-breakpoint
ALTER TABLE `stocks` ADD `version` integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE `audit_logs` ADD `operation_id` text;--> statement-breakpoint
ALTER TABLE `audit_logs` ADD `before_snapshot` text;--> statement-breakpoint
ALTER TABLE `audit_logs` ADD `after_snapshot` text;--> statement-breakpoint
CREATE UNIQUE INDEX `audit_logs_operation_id_idx` ON `audit_logs` (`operation_id`);--> statement-breakpoint
CREATE TABLE `pricing_catalog_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`identity_key` text NOT NULL,
	`partner_name` text DEFAULT '' NOT NULL,
	`customer_name` text DEFAULT '' NOT NULL,
	`product` text NOT NULL,
	`sku` text DEFAULT '' NOT NULL,
	`barcode` text DEFAULT '' NOT NULL,
	`default_billing_mode` text DEFAULT 'item' NOT NULL,
	`item_length_cm` real DEFAULT 0 NOT NULL,
	`item_width_cm` real DEFAULT 0 NOT NULL,
	`item_height_cm` real DEFAULT 0 NOT NULL,
	`item_volume_m3` real DEFAULT 0 NOT NULL,
	`box_length_cm` real DEFAULT 0 NOT NULL,
	`box_width_cm` real DEFAULT 0 NOT NULL,
	`box_height_cm` real DEFAULT 0 NOT NULL,
	`box_volume_m3` real DEFAULT 0 NOT NULL,
	`rate_usd_m3_day` real DEFAULT 0.7 NOT NULL,
	`free_days` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`updated_by` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX `pricing_catalog_identity_key_idx` ON `pricing_catalog_items` (`identity_key`);--> statement-breakpoint
CREATE INDEX `pricing_catalog_product_idx` ON `pricing_catalog_items` (`product`);--> statement-breakpoint
CREATE INDEX `pricing_catalog_sku_idx` ON `pricing_catalog_items` (`sku`);--> statement-breakpoint
CREATE INDEX `pricing_catalog_barcode_idx` ON `pricing_catalog_items` (`barcode`);--> statement-breakpoint
CREATE INDEX `pricing_catalog_updated_at_idx` ON `pricing_catalog_items` (`updated_at`);--> statement-breakpoint
CREATE TABLE `storage_fee_settlements` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`stock_id` integer NOT NULL,
	`operation_id` text,
	`catalog_item_id` integer,
	`location_code` text NOT NULL,
	`inbound_source` text DEFAULT 'return' NOT NULL,
	`billing_mode` text DEFAULT 'item' NOT NULL,
	`product` text NOT NULL,
	`barcode` text DEFAULT '' NOT NULL,
	`inbound_order` text DEFAULT '' NOT NULL,
	`customer_name` text DEFAULT '' NOT NULL,
	`inbound_date` text NOT NULL,
	`outbound_at` text NOT NULL,
	`quantity` integer DEFAULT 0 NOT NULL,
	`boxes` integer DEFAULT 0 NOT NULL,
	`item_volume_m3` real DEFAULT 0 NOT NULL,
	`box_volume_m3` real DEFAULT 0 NOT NULL,
	`rate_usd_m3_day` real DEFAULT 0.7 NOT NULL,
	`free_days` integer DEFAULT 0 NOT NULL,
	`storage_days` integer DEFAULT 0 NOT NULL,
	`billable_days` integer DEFAULT 0 NOT NULL,
	`total_volume_m3` real DEFAULT 0 NOT NULL,
	`fee_usd` real DEFAULT 0 NOT NULL,
	`previous_inbound_source` text,
	`previous_billing_mode` text,
	`previous_item_volume_m3` real,
	`previous_box_volume_m3` real,
	`previous_storage_rate_usd` real,
	`previous_free_days` integer,
	`previous_catalog_item_id` integer,
	`stock_updated_at_before` text,
	`stock_updated_at_after` text,
	`operated_by` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL
);--> statement-breakpoint
CREATE INDEX `storage_fee_stock_idx` ON `storage_fee_settlements` (`stock_id`);--> statement-breakpoint
CREATE INDEX `storage_fee_outbound_at_idx` ON `storage_fee_settlements` (`outbound_at`);--> statement-breakpoint
CREATE INDEX `storage_fee_customer_idx` ON `storage_fee_settlements` (`customer_name`);--> statement-breakpoint
CREATE INDEX `storage_fee_product_idx` ON `storage_fee_settlements` (`product`);--> statement-breakpoint
CREATE UNIQUE INDEX `storage_fee_operation_id_idx` ON `storage_fee_settlements` (`operation_id`);
