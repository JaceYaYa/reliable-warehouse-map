ALTER TABLE stocks ADD COLUMN inventory_unit TEXT NOT NULL DEFAULT 'item' CHECK(inventory_unit IN ('item','box'));
--> statement-breakpoint
ALTER TABLE stocks ADD COLUMN inventory_review_decision TEXT NOT NULL DEFAULT '' CHECK(inventory_review_decision IN ('','confirm','retain'));
