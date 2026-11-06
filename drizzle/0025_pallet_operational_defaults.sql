-- Operational metadata only. Historical fee lots, settlements and movement snapshots stay untouched.
-- The durable marker prevents explicit zero saved after this migration from ever being defaulted again.
CREATE TABLE IF NOT EXISTS warehouse_metadata_migrations (
  key TEXT PRIMARY KEY NOT NULL,
  applied_at TEXT NOT NULL
);
--> statement-breakpoint
INSERT OR IGNORE INTO audit_logs(user_id,user_name,action,entity_type,entity_id,operation_id,summary,before_snapshot,after_snapshot,created_at)
SELECT 0,'系统迁移','托盘初始化','系统','stocks','v122:pallet-defaults:v1',
  'V122 一次性初始化现存有货且托盘为0的库存为1；不改变计价批次、数量、日期和费率',
  json_object('schema','pallet-default-init-v1','rows',json(COALESCE((SELECT json_group_array(json_object('id',id,'palletCount',pallet_count,'palletLabel',pallet_label,'version',version)) FROM stocks WHERE pallet_count=0 AND (total_quantity>0 OR total_boxes>0)),'[]'))),
  json_object('schema','pallet-default-init-v1','rows',json(COALESCE((SELECT json_group_array(json_object('id',id,'palletCount',1,'palletLabel','1','version',version+1)) FROM stocks WHERE pallet_count=0 AND (total_quantity>0 OR total_boxes>0)),'[]'))),
  strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE NOT EXISTS(SELECT 1 FROM warehouse_metadata_migrations WHERE key='v122_pallet_defaults_v1')
  AND EXISTS(SELECT 1 FROM stocks WHERE pallet_count=0 AND (total_quantity>0 OR total_boxes>0));
--> statement-breakpoint
UPDATE stocks SET pallet_count=1,pallet_label='1',version=version+1
WHERE pallet_count=0 AND (total_quantity>0 OR total_boxes>0)
  AND NOT EXISTS(SELECT 1 FROM warehouse_metadata_migrations WHERE key='v122_pallet_defaults_v1');
--> statement-breakpoint
INSERT OR IGNORE INTO warehouse_metadata_migrations(key,applied_at)
VALUES('v122_pallet_defaults_v1',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
