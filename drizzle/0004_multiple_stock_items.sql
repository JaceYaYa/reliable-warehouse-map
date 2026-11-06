DROP INDEX IF EXISTS `stocks_location_code_unique`;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `stocks_location_code_idx` ON `stocks` (`location_code`);
