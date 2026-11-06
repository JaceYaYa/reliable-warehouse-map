import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { sql } from "drizzle-orm";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { LOCATION_ALIASES_KEY, composeLocationAliases, parseLocationAliases, planNewZonePrefixRemoval, remapSnapshotLocations, remapWarehouseZones, resolveLocationAlias, upgradeBackupLocationNames } from "../lib/location-aliases.ts";
import { mergeRequiredWarehouseZones, normalizeWarehouseZones } from "../lib/warehouse-layout.ts";
import { matchMessageLocations } from "../lib/inbound-message.ts";

const zones = () => [
  { id: "NEW_A", title: "新A区 · 新库位", codes: ["新A1", "新A2"], locationCodesVersion: 1, layout: { 新A1: { x: 3, y: 4, w: 2, h: 2, capacityPallets: 3 }, 新A2: { x: 6, y: 4, w: 2, h: 2 } }, features: [{ id: "a", label: "新A区", x: 1, y: 1, w: 2, h: 1 }] },
  { id: "OLD_A", title: "旧A区", codes: ["旧A1"], layout: { 旧A1: { x: 5, y: 5, w: 2, h: 2 } } },
];

test("prefix removal preserves old locations, geometry and capacities, then remains stable after normalization", () => {
  const original = zones(), before = structuredClone(original), result = planNewZonePrefixRemoval(original, ["新A1", "旧A1"]);
  assert.deepEqual(result.renames, { 新A1: "A1", 新A2: "A2" });
  assert.deepEqual(result.zones[1], original[1]); assert.deepEqual(result.zones[0].layout.A1, original[0].layout.新A1);
  assert.equal(result.zones[0].title, "A区 · 库位"); assert.equal(result.zones[0].features[0].label, "A区");
  const normalized = normalizeWarehouseZones(mergeRequiredWarehouseZones(result.zones));
  assert.deepEqual(normalized.find(zone => zone.id === "NEW_A").codes, ["A1", "A2"]);
  assert.deepEqual(original, before);
});

test("manual numbering survives saving instead of reappearing under preset new names", () => {
  const result = remapWarehouseZones(zones(), { 新A1: "A-01" });
  const merged = mergeRequiredWarehouseZones(result).find(zone => zone.id === "NEW_A");
  assert.deepEqual(merged.codes, ["A-01", "新A2"]); assert.equal(merged.layout["A-01"].capacityPallets, 3);
});

test("prefix removal rejects occupied and empty-map collisions, including B3", () => {
  assert.throws(() => planNewZonePrefixRemoval([{ id: "NEW_B", title: "新B区", codes: ["新B3"] }], ["B3"]), /B3/);
  assert.throws(() => planNewZonePrefixRemoval([...zones(), { id: "EXTRA", title: "其他", codes: ["A1"] }], []), /A1/);
  assert.throws(() => remapWarehouseZones(zones(), { 新A1: "旧A1" }), /重复/);
});

test("continuous renames resolve all historic names and cycles fail before restoration", () => {
  const aliases = composeLocationAliases({ 新A1: "A1" }, { A1: "A01" }, ["A01"]);
  assert.deepEqual(aliases, { 新A1: "A01", A1: "A01" });
  assert.equal(resolveLocationAlias(" 新ａ１ ", aliases), "A01");
  assert.throws(() => parseLocationAliases('{"A1":"A2","A2":"A1"}'), /循环/);
  assert.throws(() => remapSnapshotLocations('{"locationCode":"A1"}', { A1: "A2", A2: "A1" }), /循环/);
});

test("delete and transfer snapshots follow new location names without rewriting notes, amounts or history", () => {
  const aliases = { 新A1: "A1", 新A2: "A2" }, row = { id: 8, locationCode: "新A1", note: "新A1原始清点", totalQuantity: 10, palletCount: .5, version: 7 };
  assert.deepEqual(JSON.parse(remapSnapshotLocations(JSON.stringify(row), aliases)), { ...row, locationCode: "A1" });
  const envelope = { sourceLocation: "新A1", targetLocation: "新A2", rows: [row, { ...row, id: 9, locationCode: "新A2" }] };
  const remapped = JSON.parse(remapSnapshotLocations(JSON.stringify(envelope), aliases));
  assert.deepEqual([remapped.sourceLocation, remapped.targetLocation, ...remapped.rows.map(row => row.locationCode)], ["A1", "A2", "A1", "A2"]);
  assert.equal(remapped.rows[0].note, row.note); assert.equal(remapped.rows[0].version, 7);
  assert.equal(remapSnapshotLocations("null", aliases), "null"); assert.equal(remapSnapshotLocations("old unstructured record", aliases), "old unstructured record");
});

test("old pasted location names continue to work after removing the prefix", () => {
  assert.deepEqual(matchMessageLocations("新A1", ["A1", "旧A1"]), ["A1"]);
  assert.deepEqual(matchMessageLocations("新A1", ["A1", "新A1"]), ["新A1"]);
  assert.deepEqual(matchMessageLocations("旧A1", ["A1", "旧A1"]), ["旧A1"]);
});

const backup = () => ({ stocks: [{ locationCode: "新A1", totalQuantity: 10 }], settings: [{ key: "warehouse_zones", value: JSON.stringify(zones()) }], storageFeeSettlements: [{ locationCode: "新A1", feeUsd: 19.2 }] });
test("backup restoration maps names while preserving stock quantities and settled amounts", () => {
  const data = backup(), before = structuredClone(data), upgraded = upgradeBackupLocationNames(data, { 新A1: "A1", 新A2: "A2" });
  assert.equal(upgraded.stocks[0].locationCode, "A1"); assert.equal(upgraded.stocks[0].totalQuantity, 10);
  assert.deepEqual(upgraded.storageFeeSettlements, [{ locationCode: "A1", feeUsd: 19.2 }]);
  assert.deepEqual(JSON.parse(upgraded.settings[0].value)[1], zones()[1]); assert.deepEqual(data, before);
  assert.equal(upgradeBackupLocationNames(data, {}), data);
});

test("backup map-external stocks and settlement collisions are rejected before live data can be cleared", () => {
  for (const field of ["stocks", "storageFeeSettlements"]) {
    const data = backup(); data[field].push({ locationCode: "A1" });
    assert.throws(() => upgradeBackupLocationNames(data, { 新A1: "A1" }), /备份库位冲突/);
  }
});

const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
const migrations = await Promise.all(journal.entries.map(entry => readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8")));
function database() { const db = new DatabaseSync(":memory:"); for (const migration of migrations) db.exec(migration); return db; }
function aliases(db) { db.prepare("INSERT INTO settings(key,value,updated_at) VALUES (?,?,?)").run(LOCATION_ALIASES_KEY, '{"新A1":"A1"}', "now"); }
const insertStock = (db, code) => db.prepare("INSERT INTO stocks(location_code,inbound_date,product,updated_at) VALUES (?,?,?,?)").run(code, "2026-09-20", "测试货物", "now");

test("schema-only alias guards preserve inventory and old records while rejecting stale inserts and restores", () => {
  const db = database();
  try {
    db.prepare("INSERT INTO settings(key,value,updated_at) VALUES ('plain','non-json','now')").run();
    insertStock(db, "新A1"); aliases(db); db.prepare("UPDATE stocks SET location_code='A1' WHERE location_code='新A1'").run();
    assert.throws(() => insertStock(db, "新A1"), /库位名称已更新/);
    assert.throws(() => db.prepare("UPDATE stocks SET location_code='新A1' WHERE location_code='A1'").run(), /库位名称已更新/);
    insertStock(db, "旧A1"); insertStock(db, "A1");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM stocks").get().n, 3);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_logs").get().n, 0);
  } finally { db.close(); }
});

test("stale map updates and alias-name reuse fail, and a failed receiving batch rolls back all effects", () => {
  const db = database();
  try {
    aliases(db);
    const insertMap = value => db.prepare("INSERT INTO settings(key,value,updated_at) VALUES ('warehouse_zones',?,'now')").run(JSON.stringify(value));
    assert.throws(() => insertMap(zones()), /库位名称已更新/);
    insertMap(planNewZonePrefixRemoval(zones(), []).zones);
    assert.throws(() => db.prepare("UPDATE settings SET value=? WHERE key='warehouse_zones'").run(JSON.stringify(zones())), /库位名称已更新/);
    db.exec("BEGIN");
    try { insertStock(db, "A1"); insertStock(db, "新A1"); db.exec("COMMIT"); assert.fail("must reject"); }
    catch (error) { db.exec("ROLLBACK"); assert.match(String(error), /库位名称已更新/); }
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM stocks").get().n, 0);
  } finally { db.close(); }
});

test("new alias-guard migration creates triggers without rewriting inventory", () => {
  assert.doesNotMatch(migrations[journal.entries.findIndex(entry=>entry.tag==="0010_location_alias_guards")], /\b(?:UPDATE|DELETE FROM|INSERT INTO)\s+(?:stocks|settings|audit_logs|storage_fee_settlements)\b/i);
});

// Compile the actual guarded SQL expression used by the rename route, then exercise it in SQLite.
const routeSource = await readFile(new URL("../app/api/locations/route.ts", import.meta.url), "utf8");
const routeTree = ts.createSourceFile("route.ts", routeSource, ts.ScriptTarget.Latest, true);
const guardExpressions = new Map();
function visit(node) {
  if (ts.isVariableDeclaration(node) && ["targetValues", "guardedValue"].includes(node.name.getText(routeTree))) guardExpressions.set(node.name.getText(routeTree), node.initializer.getText(routeTree));
  ts.forEachChild(node, visit);
}
visit(routeTree);
const guardCode = ts.transpileModule([...guardExpressions].map(([name, expression]) => `const ${name} = ${expression};`).join("\n") + "\nguardedValue;", { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
function renameGuardQuery(db) {
  const storedRows = db.prepare("SELECT key,value FROM settings").all(), stockRevision = db.prepare("SELECT revision FROM warehouse_sync_versions WHERE resource='stocks'").get().revision;
  const guardedValue = runInNewContext(guardCode, { sql,cartonUnchanged:sql`1`, renameEntries: [["新A2", "A2"]], aliases: { 新A1: "A1", 新A2: "A2" }, storedRows, stockRevision, ZONES_SETTINGS_KEY: "warehouse_zones", LOCATION_ALIASES_KEY });
  return new SQLiteSyncDialect().sqlToQuery(sql`INSERT INTO settings(key,value,updated_at) VALUES (${LOCATION_ALIASES_KEY},${guardedValue},'now') ON CONFLICT(key) DO UPDATE SET value=${guardedValue}`);
}

test("actual rename UPSERT supports existing aliases and rolls back when inventory changes during inspection", () => {
  for (const concurrentCode of [null, "a2", "Ａ２"]) {
    const db = database();
    try {
      aliases(db); const query = renameGuardQuery(db);
      if (concurrentCode) insertStock(db, concurrentCode);
      db.exec("BEGIN");
      if (concurrentCode) {
        assert.throws(() => db.prepare(query.sql).run(...query.params), /NOT NULL/); db.exec("ROLLBACK");
        assert.deepEqual(JSON.parse(db.prepare("SELECT value FROM settings WHERE key=?").get(LOCATION_ALIASES_KEY).value), { 新A1: "A1" });
      } else {
        db.prepare(query.sql).run(...query.params); db.exec("COMMIT");
        assert.deepEqual(JSON.parse(db.prepare("SELECT value FROM settings WHERE key=?").get(LOCATION_ALIASES_KEY).value), { 新A1: "A1", 新A2: "A2" });
      }
    } finally { db.close(); }
  }
});

test("stale settlement insertion is rejected so a rename cannot split stock and billing locations", () => {
  const db = database();
  try {
    aliases(db);
    const columns = db.prepare("PRAGMA table_info(storage_fee_settlements)").all().filter(column => column.notnull && column.dflt_value === null && !column.pk);
    const values = columns.map(column => column.name === "location_code" ? "新A1" : column.type === "integer" ? 1 : "test");
    const statement = db.prepare(`INSERT INTO storage_fee_settlements(${columns.map(column => column.name).join(",")}) VALUES (${columns.map(() => "?").join(",")})`);
    assert.throws(() => statement.run(...values), /库位名称已更新/);
    values[columns.findIndex(column => column.name === "location_code")] = "A1";
    statement.run(...values); assert.equal(db.prepare("SELECT COUNT(*) AS n FROM storage_fee_settlements").get().n, 1);
  } finally { db.close(); }
});

test("explicitly saved layouts do not recreate a deleted bin, region, or all four new regions", () => {
  const original = mergeRequiredWarehouseZones([]).map(zone => ({ ...zone, locationCodesVersion: 1 }));
  original.push({ id: "OLD", title: "旧区", codes: ["旧A1"], layout: {}, locationCodesVersion: 1 });
  for (const removed of [["新B3"], original.find(zone => zone.id === "NEW_B").codes, original.filter(zone => zone.id.startsWith("NEW_")).flatMap(zone => zone.codes)]) {
    let saved = original.map(zone => ({ ...zone, codes: zone.codes.filter(code => !removed.includes(code)) })).filter(zone => zone.codes.length);
    const expected = saved.flatMap(zone => zone.codes);
    for (let round = 0; round < 3; round++) {
      saved = normalizeWarehouseZones(saved);
      assert.deepEqual(saved.flatMap(zone => zone.codes), expected);
      assert.ok(!saved.some(zone => zone.codes.some(code => removed.includes(code))));
    }
  }
});

function repairFixture(crossZone = false) {
  const value = mergeRequiredWarehouseZones([]), b = value.find(zone => zone.id === "NEW_B");
  const canonical = { x: 70, y: 80, w: 2, h: 3, capacityPallets: 4, capacityBoxes: 20, groupId: "manual", groupLocked: true };
  if (crossZone) { delete canonical.capacityPallets; canonical.custom = null; b.layout["新B3"].duplicateOnly = "must not survive"; }
  const old = { id: "OLD", title: "旧区", codes: ["旧A1"], layout: { 旧A1: { x: 10, y: 70, w: 2, h: 3, capacityPallets: 2 } } };
  (crossZone ? old : b).codes.push("B3"); (crossZone ? old : b).layout.B3 = canonical;
  value.push(old); return value;
}
function repairDatabase(value) {
  const db = new DatabaseSync(":memory:"); for (const migration of migrations.slice(0,-1)) db.exec(migration);
  db.prepare("INSERT INTO settings(key,value,updated_at) VALUES('warehouse_zones',?,'before')").run(JSON.stringify(value));
  insertStock(db, "新A1"); insertStock(db, "B3"); insertStock(db, "B3"); insertStock(db, "旧A1");
  db.exec("UPDATE stocks SET total_quantity=10,total_boxes=2,pallet_count=0.5,pallet_label='1/2',layer_count=3,version=7");
  db.prepare("INSERT INTO audit_logs(user_id,user_name,action,entity_type,entity_id,summary,created_at,before_snapshot,after_snapshot) VALUES(1,'测试','入库','库存','新A1','新A1原始记录','before',null,?)").run(JSON.stringify({ locationCode: "新A1", totalQuantity: 10 }));
  return db;
}
const repairSql = migrations[journal.entries.findIndex(entry=>entry.tag==="0011_remove_new_location_prefix")];
function executeMigrationLines(db, migration) {
  for (const line of migration.split(/\r?\n/).map(value => value.trim()).filter(value => value && !value.startsWith("--"))) db.prepare(line).run();
}

test("pending repair keeps CASE expressions outside its trigger body and complete SQL boundaries", () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (const migration of migrations.slice(0, -2)) db.exec(migration);
    db.exec(migrations.at(-2));
    const trigger = repairSql.split("--> statement-breakpoint").find(part => part.includes("CREATE TRIGGER"));
    assert.doesNotMatch(trigger, /\bCASE\b/);
    assert.equal((trigger.match(/\bBEGIN\b/g) ?? []).length, 1);
    assert.equal((trigger.match(/\bEND\b/g) ?? []).length, 1);
    db.prepare("INSERT INTO settings(key,value,updated_at) VALUES('warehouse_zones',?,'before')").run(JSON.stringify(repairFixture()));
    insertStock(db, "新A1"); insertStock(db, "B3");
    executeMigrationLines(db, repairSql);
    assert.equal(db.prepare("SELECT count(*) AS n FROM stocks WHERE location_code='A1'").get().n, 1);
    assert.equal(JSON.parse(db.prepare("SELECT value FROM settings WHERE key='warehouse_location_prefix_repair_v1'").get().value).status, "done");
    assert.throws(() => insertStock(db, "新A1"), /库位名称已更新/);
  } finally { db.close(); }
});
test("authorized repair keeps B3's full saved layout and all stock fields while removing the empty duplicate", () => {
  for (const crossZone of [false, true]) {
    const beforeZones = repairFixture(crossZone), expectedInput = structuredClone(beforeZones);
    const newB = expectedInput.find(zone => zone.id === "NEW_B");
    newB.codes = newB.codes.filter(code => !["新B33", "新B34"].includes(code));
    delete newB.layout["新B33"]; delete newB.layout["新B34"];
    const expected = planNewZonePrefixRemoval(expectedInput, ["新A1", "B3", "旧A1"], true);
    const db = repairDatabase(beforeZones);
    try {
      const stockBefore = db.prepare("SELECT * FROM stocks ORDER BY id").all(), logsBefore = db.prepare("SELECT * FROM audit_logs").all();
      executeMigrationLines(db, repairSql);
      const after = JSON.parse(db.prepare("SELECT value FROM settings WHERE key='warehouse_zones'").get().value);
      assert.deepEqual(after, expected.zones);
      assert.equal(after.flatMap(zone => zone.codes).filter(code => code === "B3").length, 1);
      assert.equal(after.flatMap(zone => zone.codes).filter(code => /^新[ABCD]\d+$/.test(code)).length, 0);
      assert.equal(after.flatMap(zone => zone.codes).some(code => ["B33", "B34", "新B33", "新B34"].includes(code)), false);
      assert.deepEqual(normalizeWarehouseZones(mergeRequiredWarehouseZones(after)).flatMap(zone => zone.codes), after.flatMap(zone => zone.codes));
      assert.deepEqual(db.prepare("SELECT * FROM stocks ORDER BY id").all().map(row => ({ ...row })), stockBefore.map(row => ({ ...row, location_code: row.location_code === "新A1" ? "A1" : row.location_code })));
      assert.deepEqual(db.prepare("SELECT * FROM audit_logs").all(), logsBefore);
      assert.equal(JSON.parse(db.prepare("SELECT value FROM settings WHERE key='warehouse_location_prefix_repair_v1'").get().value).status, "done");
      const repaired = db.prepare("SELECT * FROM stocks ORDER BY id").all(), mapText = JSON.stringify(after);
      executeMigrationLines(db, repairSql);
      assert.deepEqual(db.prepare("SELECT * FROM stocks ORDER BY id").all(), repaired);
      assert.equal(db.prepare("SELECT value FROM settings WHERE key='warehouse_zones'").get().value, mapText);
    } finally { db.close(); }
  }
});

test("repair conflicts roll back the single operation without leaving renamed stocks or changed settings", () => {
  for (const conflict of ["新B3", "新B33", "新B34", "A1", "a1", "Ａ１"]) {
    const value = repairFixture(), db = repairDatabase(value);
    try {
      insertStock(db, conflict); const before = db.prepare("SELECT * FROM stocks ORDER BY id").all();
      assert.throws(() => executeMigrationLines(db, repairSql), /库位更名中止/);
      assert.deepEqual(db.prepare("SELECT * FROM stocks ORDER BY id").all(), before);
      assert.equal(db.prepare("SELECT value FROM settings WHERE key='warehouse_zones'").get().value, JSON.stringify(value));
      assert.equal(db.prepare("SELECT count(*) AS n FROM settings WHERE key IN ('warehouse_location_aliases','warehouse_location_prefix_backup_v1','warehouse_location_prefix_repair_v1')").get().n, 0);
      // If a migration runner leaves DDL installed after failure, ordinary map edits must not trigger a repair.
      db.exec("UPDATE settings SET updated_at='ordinary save' WHERE key='warehouse_zones'");
      assert.deepEqual(db.prepare("SELECT * FROM stocks ORDER BY id").all(), before);
    } finally { db.close(); }
  }
});

test("an old backup with the confirmed empty B3 duplicate restores one canonical bin", () => {
  const data = { stocks: [{ locationCode: "B3", totalQuantity: 10 }], settings: [{ key: "warehouse_zones", value: JSON.stringify(repairFixture()) }], storageFeeSettlements: [{ locationCode: "新B3", feeUsd: 10 }] };
  const renamed = planNewZonePrefixRemoval(repairFixture(), ["B3"], true).renames;
  const upgraded = upgradeBackupLocationNames(data, renamed);
  assert.equal(JSON.parse(upgraded.settings.find(row => row.key === "warehouse_zones").value).flatMap(zone => zone.codes).filter(code => code === "B3").length, 1);
  assert.deepEqual(upgraded.stocks, data.stocks); assert.deepEqual(upgraded.storageFeeSettlements, [{ locationCode: "B3", feeUsd: 10 }]);
});
