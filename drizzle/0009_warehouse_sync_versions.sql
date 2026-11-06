CREATE TABLE `warehouse_sync_versions` (`resource` text PRIMARY KEY NOT NULL, `revision` text NOT NULL);
--> statement-breakpoint
CREATE INDEX audit_logs_recent_sync_idx ON audit_logs (id) WHERE action IN ('入库','出库','移库','库存修改','删除','恢复');
--> statement-breakpoint
INSERT INTO warehouse_sync_versions (resource, revision) VALUES ('stocks', lower(hex(randomblob(16)))), ('locations', lower(hex(randomblob(16)))), ('recent', lower(hex(randomblob(16))));
--> statement-breakpoint
CREATE TRIGGER stocks_sync_insert AFTER INSERT ON stocks BEGIN UPDATE warehouse_sync_versions SET revision = lower(hex(randomblob(16))) WHERE resource = 'stocks'; END;
--> statement-breakpoint
CREATE TRIGGER stocks_sync_update AFTER UPDATE ON stocks BEGIN UPDATE warehouse_sync_versions SET revision = lower(hex(randomblob(16))) WHERE resource = 'stocks'; END;
--> statement-breakpoint
CREATE TRIGGER stocks_sync_delete AFTER DELETE ON stocks BEGIN UPDATE warehouse_sync_versions SET revision = lower(hex(randomblob(16))) WHERE resource = 'stocks'; END;
--> statement-breakpoint
CREATE TRIGGER locations_sync_insert AFTER INSERT ON settings WHEN NEW.key IN ('warehouse_zones', 'warehouse_map_canvas') BEGIN UPDATE warehouse_sync_versions SET revision = lower(hex(randomblob(16))) WHERE resource = 'locations'; END;
--> statement-breakpoint
CREATE TRIGGER locations_sync_update AFTER UPDATE ON settings WHEN OLD.key IN ('warehouse_zones', 'warehouse_map_canvas') OR NEW.key IN ('warehouse_zones', 'warehouse_map_canvas') BEGIN UPDATE warehouse_sync_versions SET revision = lower(hex(randomblob(16))) WHERE resource = 'locations'; END;
--> statement-breakpoint
CREATE TRIGGER locations_sync_delete AFTER DELETE ON settings WHEN OLD.key IN ('warehouse_zones', 'warehouse_map_canvas') BEGIN UPDATE warehouse_sync_versions SET revision = lower(hex(randomblob(16))) WHERE resource = 'locations'; END;
--> statement-breakpoint
CREATE TRIGGER recent_sync_insert AFTER INSERT ON audit_logs WHEN NEW.action IN ('入库','出库','移库','库存修改','删除','恢复') BEGIN UPDATE warehouse_sync_versions SET revision = lower(hex(randomblob(16))) WHERE resource = 'recent'; END;
--> statement-breakpoint
CREATE TRIGGER recent_sync_update AFTER UPDATE ON audit_logs WHEN OLD.action IN ('入库','出库','移库','库存修改','删除','恢复') OR NEW.action IN ('入库','出库','移库','库存修改','删除','恢复') BEGIN UPDATE warehouse_sync_versions SET revision = lower(hex(randomblob(16))) WHERE resource = 'recent'; END;
--> statement-breakpoint
CREATE TRIGGER recent_sync_delete AFTER DELETE ON audit_logs WHEN OLD.action IN ('入库','出库','移库','库存修改','删除','恢复') BEGIN UPDATE warehouse_sync_versions SET revision = lower(hex(randomblob(16))) WHERE resource = 'recent'; END;
