CREATE TRIGGER stocks_box_quantity_insert BEFORE INSERT ON stocks
WHEN NEW.inventory_unit='box' AND NEW.total_quantity<>0
BEGIN SELECT RAISE(ABORT, 'CHECK constraint failed: box_inventory_zero_pieces'); END;
--> statement-breakpoint
CREATE TRIGGER stocks_box_quantity_update BEFORE UPDATE ON stocks
WHEN NEW.inventory_unit='box' AND NEW.total_quantity<>0
BEGIN SELECT RAISE(ABORT, 'CHECK constraint failed: box_inventory_zero_pieces'); END;
