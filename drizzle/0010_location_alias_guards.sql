CREATE TRIGGER stocks_location_alias_insert BEFORE INSERT ON stocks
WHEN EXISTS (SELECT 1 FROM settings, json_each(settings.value) AS alias WHERE settings.key = 'warehouse_location_aliases' AND upper(trim(alias.key)) = upper(trim(NEW.location_code)))
BEGIN SELECT RAISE(ABORT, '库位名称已更新，请刷新重试'); END;
--> statement-breakpoint
CREATE TRIGGER stocks_location_alias_update BEFORE UPDATE OF location_code ON stocks
WHEN EXISTS (SELECT 1 FROM settings, json_each(settings.value) AS alias WHERE settings.key = 'warehouse_location_aliases' AND upper(trim(alias.key)) = upper(trim(NEW.location_code)))
BEGIN SELECT RAISE(ABORT, '库位名称已更新，请刷新重试'); END;
--> statement-breakpoint
CREATE TRIGGER settlements_location_alias_insert BEFORE INSERT ON storage_fee_settlements
WHEN EXISTS (SELECT 1 FROM settings, json_each(settings.value) AS alias WHERE settings.key = 'warehouse_location_aliases' AND upper(trim(alias.key)) = upper(trim(NEW.location_code)))
BEGIN SELECT RAISE(ABORT, '库位名称已更新，请刷新重试'); END;
--> statement-breakpoint
CREATE TRIGGER settlements_location_alias_update BEFORE UPDATE OF location_code ON storage_fee_settlements
WHEN EXISTS (SELECT 1 FROM settings, json_each(settings.value) AS alias WHERE settings.key = 'warehouse_location_aliases' AND upper(trim(alias.key)) = upper(trim(NEW.location_code)))
BEGIN SELECT RAISE(ABORT, '库位名称已更新，请刷新重试'); END;
--> statement-breakpoint
CREATE TRIGGER settings_location_alias_insert BEFORE INSERT ON settings
WHEN NEW.key = 'warehouse_zones' AND EXISTS (
 SELECT 1 FROM settings AS aliases, json_each(aliases.value) AS alias, json_each(NEW.value) AS zone, json_each(zone.value, '$.codes') AS code
 WHERE aliases.key = 'warehouse_location_aliases' AND upper(trim(alias.key)) = upper(trim(code.value))
)
BEGIN SELECT RAISE(ABORT, '库位名称已更新，请刷新重试'); END;
--> statement-breakpoint
CREATE TRIGGER settings_location_alias_update BEFORE UPDATE OF value ON settings
WHEN NEW.key = 'warehouse_zones' AND EXISTS (
 SELECT 1 FROM settings AS aliases, json_each(aliases.value) AS alias, json_each(NEW.value) AS zone, json_each(zone.value, '$.codes') AS code
 WHERE aliases.key = 'warehouse_location_aliases' AND upper(trim(alias.key)) = upper(trim(code.value))
)
BEGIN SELECT RAISE(ABORT, '库位名称已更新，请刷新重试'); END;
