CREATE TABLE `goods_flow_state` (`id` integer PRIMARY KEY NOT NULL CHECK(id=1), `revision` integer NOT NULL DEFAULT 0, `value` text NOT NULL);
--> statement-breakpoint
INSERT INTO `goods_flow_state` (`id`,`revision`,`value`) VALUES (1,0,'{"categories":[]}');
--> statement-breakpoint
CREATE TABLE `goods_operations` (`id` text PRIMARY KEY NOT NULL, `kind` text NOT NULL, `category_id` text NOT NULL, `fingerprint` text NOT NULL, `before_category` text, `after_category` text NOT NULL, `before_rows` text NOT NULL, `after_rows` text NOT NULL, `settlement_ids` text NOT NULL DEFAULT '[]', `result` text NOT NULL, `created_at` text NOT NULL, `restored_at` text);
--> statement-breakpoint
CREATE TABLE `goods_transaction_guards` (`id` text PRIMARY KEY NOT NULL, `valid` integer NOT NULL CHECK(valid=1));
