CREATE TABLE `audit_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`user_name` text NOT NULL,
	`action` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text DEFAULT '' NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL
);
