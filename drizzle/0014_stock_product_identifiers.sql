ALTER TABLE stocks ADD COLUMN sku TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE stocks ADD COLUMN fnsku TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE storage_fee_settlements ADD COLUMN sku TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE storage_fee_settlements ADD COLUMN fnsku TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE pricing_catalog_items ADD COLUMN fnsku TEXT NOT NULL DEFAULT '';
