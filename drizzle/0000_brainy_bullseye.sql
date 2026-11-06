CREATE TABLE `stocks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`location_code` text NOT NULL,
	`inbound_date` text NOT NULL,
	`product` text NOT NULL,
	`barcode` text DEFAULT '' NOT NULL,
	`inbound_order` text DEFAULT '' NOT NULL,
	`total_quantity` integer DEFAULT 0 NOT NULL,
	`total_boxes` integer DEFAULT 0 NOT NULL,
	`customer_name` text DEFAULT '' NOT NULL,
	`pallet_count` integer DEFAULT 1 NOT NULL,
	`layer_count` integer DEFAULT 1 NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`updated_by` text DEFAULT '' NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stocks_location_code_unique` ON `stocks` (`location_code`);