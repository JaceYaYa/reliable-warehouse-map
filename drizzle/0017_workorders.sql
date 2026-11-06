CREATE TABLE `work_orders` (
 `id` text PRIMARY KEY NOT NULL,
 `number` text NOT NULL UNIQUE,
 `kind` text NOT NULL,
 `title` text NOT NULL,
 `customer_name` text DEFAULT '' NOT NULL,
 `employee_body` text DEFAULT '' NOT NULL,
 `payload` text DEFAULT '{}' NOT NULL,
 `file_ids` text DEFAULT '[]' NOT NULL,
 `status` text DEFAULT 'draft' NOT NULL,
 `assigned_to` text DEFAULT '' NOT NULL,
 `version` integer DEFAULT 0 NOT NULL,
 `created_by` integer NOT NULL,
 `created_at` text NOT NULL,
 `updated_by` integer NOT NULL,
 `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `work_orders_status_updated_idx` ON `work_orders` (`status`,`updated_at`);
--> statement-breakpoint
CREATE INDEX `work_orders_assigned_idx` ON `work_orders` (`assigned_to`,`status`);
--> statement-breakpoint
CREATE TABLE `work_order_events` (
 `id` text PRIMARY KEY NOT NULL,
 `order_id` text NOT NULL,
 `action` text NOT NULL,
 `user_id` integer NOT NULL,
 `user_name` text NOT NULL,
 `summary` text DEFAULT '' NOT NULL,
 `mutation_id` text NOT NULL UNIQUE,
 `request_hash` text NOT NULL,
 `result` text NOT NULL,
 `created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `work_order_events_order_idx` ON `work_order_events` (`order_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `work_order_files` (
 `id` text PRIMARY KEY NOT NULL,
 `order_id` text DEFAULT '' NOT NULL,
 `object_key` text NOT NULL,
 `name` text NOT NULL,
 `mime` text NOT NULL,
 `size` integer NOT NULL,
 `hash` text NOT NULL,
 `visibility` text DEFAULT 'source' NOT NULL,
 `created_by` integer NOT NULL,
 `created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `work_order_files_order_idx` ON `work_order_files` (`order_id`);
