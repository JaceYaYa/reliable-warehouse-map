CREATE INDEX IF NOT EXISTS `stocks_updated_at_idx` ON `stocks` (`updated_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `sessions_expires_at_idx` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `audit_logs_action_id_idx` ON `audit_logs` (`action`,`id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `audit_logs_entity_id_idx` ON `audit_logs` (`entity_id`,`id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `audit_logs_created_at_idx` ON `audit_logs` (`created_at`);
