CREATE TABLE `warehouse_backup_revision` (
	`id` integer PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
DROP TABLE `warehouse_backup_rows`;
--> statement-breakpoint
CREATE TRIGGER warehouse_backup_stocks_insert AFTER INSERT ON stocks BEGIN INSERT INTO warehouse_backup_revision(id,revision) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET revision=revision+1; END;

--> statement-breakpoint
CREATE TRIGGER warehouse_backup_stocks_update AFTER UPDATE ON stocks BEGIN INSERT INTO warehouse_backup_revision(id,revision) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET revision=revision+1; END;

--> statement-breakpoint
CREATE TRIGGER warehouse_backup_stocks_delete AFTER DELETE ON stocks BEGIN INSERT INTO warehouse_backup_revision(id,revision) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET revision=revision+1; END;

--> statement-breakpoint
CREATE TRIGGER warehouse_backup_settings_insert AFTER INSERT ON settings BEGIN INSERT INTO warehouse_backup_revision(id,revision) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET revision=revision+1; END;

--> statement-breakpoint
CREATE TRIGGER warehouse_backup_settings_update AFTER UPDATE ON settings BEGIN INSERT INTO warehouse_backup_revision(id,revision) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET revision=revision+1; END;

--> statement-breakpoint
CREATE TRIGGER warehouse_backup_settings_delete AFTER DELETE ON settings BEGIN INSERT INTO warehouse_backup_revision(id,revision) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET revision=revision+1; END;

--> statement-breakpoint
CREATE TRIGGER warehouse_backup_users_insert AFTER INSERT ON users BEGIN INSERT INTO warehouse_backup_revision(id,revision) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET revision=revision+1; END;

--> statement-breakpoint
CREATE TRIGGER warehouse_backup_users_update AFTER UPDATE ON users BEGIN INSERT INTO warehouse_backup_revision(id,revision) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET revision=revision+1; END;

--> statement-breakpoint
CREATE TRIGGER warehouse_backup_users_delete AFTER DELETE ON users BEGIN INSERT INTO warehouse_backup_revision(id,revision) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET revision=revision+1; END;

--> statement-breakpoint
CREATE TRIGGER warehouse_backup_audit_logs_insert AFTER INSERT ON audit_logs BEGIN INSERT INTO warehouse_backup_revision(id,revision) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET revision=revision+1; END;

--> statement-breakpoint
CREATE TRIGGER warehouse_backup_audit_logs_update AFTER UPDATE ON audit_logs BEGIN INSERT INTO warehouse_backup_revision(id,revision) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET revision=revision+1; END;

--> statement-breakpoint
CREATE TRIGGER warehouse_backup_audit_logs_delete AFTER DELETE ON audit_logs BEGIN INSERT INTO warehouse_backup_revision(id,revision) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET revision=revision+1; END;

--> statement-breakpoint
CREATE TRIGGER warehouse_backup_pricing_catalog_items_insert AFTER INSERT ON pricing_catalog_items BEGIN INSERT INTO warehouse_backup_revision(id,revision) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET revision=revision+1; END;

--> statement-breakpoint
CREATE TRIGGER warehouse_backup_pricing_catalog_items_update AFTER UPDATE ON pricing_catalog_items BEGIN INSERT INTO warehouse_backup_revision(id,revision) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET revision=revision+1; END;

--> statement-breakpoint
CREATE TRIGGER warehouse_backup_pricing_catalog_items_delete AFTER DELETE ON pricing_catalog_items BEGIN INSERT INTO warehouse_backup_revision(id,revision) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET revision=revision+1; END;

--> statement-breakpoint
CREATE TRIGGER warehouse_backup_storage_fee_settlements_insert AFTER INSERT ON storage_fee_settlements BEGIN INSERT INTO warehouse_backup_revision(id,revision) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET revision=revision+1; END;

--> statement-breakpoint
CREATE TRIGGER warehouse_backup_storage_fee_settlements_update AFTER UPDATE ON storage_fee_settlements BEGIN INSERT INTO warehouse_backup_revision(id,revision) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET revision=revision+1; END;

--> statement-breakpoint
CREATE TRIGGER warehouse_backup_storage_fee_settlements_delete AFTER DELETE ON storage_fee_settlements BEGIN INSERT INTO warehouse_backup_revision(id,revision) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET revision=revision+1; END;

--> statement-breakpoint
CREATE TRIGGER warehouse_backup_goods_flow_state_insert AFTER INSERT ON goods_flow_state BEGIN INSERT INTO warehouse_backup_revision(id,revision) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET revision=revision+1; END;

--> statement-breakpoint
CREATE TRIGGER warehouse_backup_goods_flow_state_update AFTER UPDATE ON goods_flow_state BEGIN INSERT INTO warehouse_backup_revision(id,revision) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET revision=revision+1; END;

--> statement-breakpoint
CREATE TRIGGER warehouse_backup_goods_flow_state_delete AFTER DELETE ON goods_flow_state BEGIN INSERT INTO warehouse_backup_revision(id,revision) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET revision=revision+1; END;

--> statement-breakpoint
CREATE TRIGGER warehouse_backup_goods_operations_insert AFTER INSERT ON goods_operations BEGIN INSERT INTO warehouse_backup_revision(id,revision) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET revision=revision+1; END;

--> statement-breakpoint
CREATE TRIGGER warehouse_backup_goods_operations_update AFTER UPDATE ON goods_operations BEGIN INSERT INTO warehouse_backup_revision(id,revision) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET revision=revision+1; END;

--> statement-breakpoint
CREATE TRIGGER warehouse_backup_goods_operations_delete AFTER DELETE ON goods_operations BEGIN INSERT INTO warehouse_backup_revision(id,revision) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET revision=revision+1; END;

--> statement-breakpoint
CREATE TRIGGER warehouse_backup_work_orders_insert AFTER INSERT ON work_orders BEGIN INSERT INTO warehouse_backup_revision(id,revision) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET revision=revision+1; END;

--> statement-breakpoint
CREATE TRIGGER warehouse_backup_work_orders_update AFTER UPDATE ON work_orders BEGIN INSERT INTO warehouse_backup_revision(id,revision) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET revision=revision+1; END;

--> statement-breakpoint
CREATE TRIGGER warehouse_backup_work_orders_delete AFTER DELETE ON work_orders BEGIN INSERT INTO warehouse_backup_revision(id,revision) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET revision=revision+1; END;

--> statement-breakpoint
CREATE TRIGGER warehouse_backup_work_order_events_insert AFTER INSERT ON work_order_events BEGIN INSERT INTO warehouse_backup_revision(id,revision) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET revision=revision+1; END;

--> statement-breakpoint
CREATE TRIGGER warehouse_backup_work_order_events_update AFTER UPDATE ON work_order_events BEGIN INSERT INTO warehouse_backup_revision(id,revision) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET revision=revision+1; END;

--> statement-breakpoint
CREATE TRIGGER warehouse_backup_work_order_events_delete AFTER DELETE ON work_order_events BEGIN INSERT INTO warehouse_backup_revision(id,revision) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET revision=revision+1; END;

--> statement-breakpoint
CREATE TRIGGER warehouse_backup_work_order_files_insert AFTER INSERT ON work_order_files BEGIN INSERT INTO warehouse_backup_revision(id,revision) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET revision=revision+1; END;

--> statement-breakpoint
CREATE TRIGGER warehouse_backup_work_order_files_update AFTER UPDATE ON work_order_files BEGIN INSERT INTO warehouse_backup_revision(id,revision) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET revision=revision+1; END;

--> statement-breakpoint
CREATE TRIGGER warehouse_backup_work_order_files_delete AFTER DELETE ON work_order_files BEGIN INSERT INTO warehouse_backup_revision(id,revision) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET revision=revision+1; END;

--> statement-breakpoint
CREATE TRIGGER warehouse_backup_carton_receipts_insert AFTER INSERT ON carton_receipts BEGIN INSERT INTO warehouse_backup_revision(id,revision) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET revision=revision+1; END;

--> statement-breakpoint
CREATE TRIGGER warehouse_backup_carton_receipts_update AFTER UPDATE ON carton_receipts BEGIN INSERT INTO warehouse_backup_revision(id,revision) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET revision=revision+1; END;

--> statement-breakpoint
CREATE TRIGGER warehouse_backup_carton_receipts_delete AFTER DELETE ON carton_receipts BEGIN INSERT INTO warehouse_backup_revision(id,revision) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET revision=revision+1; END;

--> statement-breakpoint
CREATE TRIGGER warehouse_backup_carton_operations_insert AFTER INSERT ON carton_operations BEGIN INSERT INTO warehouse_backup_revision(id,revision) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET revision=revision+1; END;

--> statement-breakpoint
CREATE TRIGGER warehouse_backup_carton_operations_update AFTER UPDATE ON carton_operations BEGIN INSERT INTO warehouse_backup_revision(id,revision) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET revision=revision+1; END;

--> statement-breakpoint
CREATE TRIGGER warehouse_backup_carton_operations_delete AFTER DELETE ON carton_operations BEGIN INSERT INTO warehouse_backup_revision(id,revision) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET revision=revision+1; END;

--> statement-breakpoint
CREATE TRIGGER warehouse_backup_wms_move_requests_insert AFTER INSERT ON wms_move_requests BEGIN INSERT INTO warehouse_backup_revision(id,revision) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET revision=revision+1; END;

--> statement-breakpoint
CREATE TRIGGER warehouse_backup_wms_move_requests_update AFTER UPDATE ON wms_move_requests BEGIN INSERT INTO warehouse_backup_revision(id,revision) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET revision=revision+1; END;

--> statement-breakpoint
CREATE TRIGGER warehouse_backup_wms_move_requests_delete AFTER DELETE ON wms_move_requests BEGIN INSERT INTO warehouse_backup_revision(id,revision) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET revision=revision+1; END;

--> statement-breakpoint
CREATE TRIGGER warehouse_backup_wms_counts_insert AFTER INSERT ON wms_counts BEGIN INSERT INTO warehouse_backup_revision(id,revision) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET revision=revision+1; END;

--> statement-breakpoint
CREATE TRIGGER warehouse_backup_wms_counts_update AFTER UPDATE ON wms_counts BEGIN INSERT INTO warehouse_backup_revision(id,revision) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET revision=revision+1; END;

--> statement-breakpoint
CREATE TRIGGER warehouse_backup_wms_counts_delete AFTER DELETE ON wms_counts BEGIN INSERT INTO warehouse_backup_revision(id,revision) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET revision=revision+1; END;

--> statement-breakpoint
CREATE TRIGGER warehouse_backup_wms_count_requests_insert AFTER INSERT ON wms_count_requests BEGIN INSERT INTO warehouse_backup_revision(id,revision) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET revision=revision+1; END;

--> statement-breakpoint
CREATE TRIGGER warehouse_backup_wms_count_requests_update AFTER UPDATE ON wms_count_requests BEGIN INSERT INTO warehouse_backup_revision(id,revision) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET revision=revision+1; END;

--> statement-breakpoint
CREATE TRIGGER warehouse_backup_wms_count_requests_delete AFTER DELETE ON wms_count_requests BEGIN INSERT INTO warehouse_backup_revision(id,revision) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET revision=revision+1; END;

--> statement-breakpoint
CREATE TRIGGER warehouse_backup_layer_storage_checkpoints_insert AFTER INSERT ON layer_storage_checkpoints BEGIN INSERT INTO warehouse_backup_revision(id,revision) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET revision=revision+1; END;

--> statement-breakpoint
CREATE TRIGGER warehouse_backup_layer_storage_checkpoints_update AFTER UPDATE ON layer_storage_checkpoints BEGIN INSERT INTO warehouse_backup_revision(id,revision) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET revision=revision+1; END;

--> statement-breakpoint
CREATE TRIGGER warehouse_backup_layer_storage_checkpoints_delete AFTER DELETE ON layer_storage_checkpoints BEGIN INSERT INTO warehouse_backup_revision(id,revision) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET revision=revision+1; END;
