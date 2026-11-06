DROP INDEX audit_logs_recent_sync_idx;
--> statement-breakpoint
CREATE INDEX audit_logs_recent_sync_idx ON audit_logs (id) WHERE action IN ('入库','出库','移库','库存修改','删除','恢复','箱件收货','箱件出库','箱件认领改单','箱件删除','撤销箱件操作');
--> statement-breakpoint
DROP TRIGGER recent_sync_insert;
--> statement-breakpoint
DROP TRIGGER recent_sync_update;
--> statement-breakpoint
DROP TRIGGER recent_sync_delete;
--> statement-breakpoint
CREATE TRIGGER recent_sync_insert AFTER INSERT ON audit_logs WHEN NEW.action IN ('入库','出库','移库','库存修改','删除','恢复','箱件收货','箱件出库','箱件认领改单','箱件删除','撤销箱件操作') BEGIN UPDATE warehouse_sync_versions SET revision = lower(hex(randomblob(16))) WHERE resource = 'recent'; END;
--> statement-breakpoint
CREATE TRIGGER recent_sync_update AFTER UPDATE ON audit_logs WHEN OLD.action IN ('入库','出库','移库','库存修改','删除','恢复','箱件收货','箱件出库','箱件认领改单','箱件删除','撤销箱件操作') OR NEW.action IN ('入库','出库','移库','库存修改','删除','恢复','箱件收货','箱件出库','箱件认领改单','箱件删除','撤销箱件操作') BEGIN UPDATE warehouse_sync_versions SET revision = lower(hex(randomblob(16))) WHERE resource = 'recent'; END;
--> statement-breakpoint
CREATE TRIGGER recent_sync_delete AFTER DELETE ON audit_logs WHEN OLD.action IN ('入库','出库','移库','库存修改','删除','恢复','箱件收货','箱件出库','箱件认领改单','箱件删除','撤销箱件操作') BEGIN UPDATE warehouse_sync_versions SET revision = lower(hex(randomblob(16))) WHERE resource = 'recent'; END;

--> statement-breakpoint
UPDATE warehouse_sync_versions SET revision=lower(hex(randomblob(16))) WHERE resource='recent';
