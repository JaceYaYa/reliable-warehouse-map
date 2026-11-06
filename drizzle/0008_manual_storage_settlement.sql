ALTER TABLE `storage_fee_settlements` ADD `settlement_status` text NOT NULL DEFAULT 'settled';--> statement-breakpoint
ALTER TABLE `storage_fee_settlements` ADD `settled_at` text;--> statement-breakpoint
ALTER TABLE `storage_fee_settlements` ADD `settled_by` text;--> statement-breakpoint
ALTER TABLE `storage_fee_settlements` ADD `version` integer NOT NULL DEFAULT 0;--> statement-breakpoint
UPDATE `storage_fee_settlements` SET `settled_at` = `created_at`, `settled_by` = `operated_by` WHERE `settlement_status` = 'settled' AND `settled_at` IS NULL;--> statement-breakpoint
CREATE INDEX `storage_fee_status_customer_idx` ON `storage_fee_settlements` (`settlement_status`,`customer_name`);
