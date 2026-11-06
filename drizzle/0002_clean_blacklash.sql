CREATE TABLE `sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`username` text NOT NULL,
	`display_name` text NOT NULL,
	`role` text DEFAULT 'employee' NOT NULL,
	`password_hash` text NOT NULL,
	`password_salt` text NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`must_change` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);
--> statement-breakpoint
INSERT INTO `users` (`username`,`display_name`,`role`,`password_hash`,`password_salt`,`active`,`must_change`,`created_at`) VALUES ('boss','老板','admin','!setup-via-handoff-required!','AAAAAAAAAAAAAAAAAAAAAA==',1,1,CURRENT_TIMESTAMP);
