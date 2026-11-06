CREATE TABLE `warehouse_backup_rows` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`export_id` text NOT NULL,
	`section` text NOT NULL,
	`payload` text NOT NULL,
	`bytes` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `warehouse_backup_export_seq_idx` ON `warehouse_backup_rows` (`export_id`,`seq`);