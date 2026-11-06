ALTER TABLE users ADD COLUMN permissions TEXT;
--> statement-breakpoint
ALTER TABLE users ADD COLUMN permission_version INTEGER NOT NULL DEFAULT 0;
