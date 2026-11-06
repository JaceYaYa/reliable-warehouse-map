import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { auditLogs, users } from "../db/schema.ts";
import {
  canWriteWarehouseData,
  normalizeUserRole,
  userRoleLabel,
} from "../lib/roles.ts";

const source = async (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

function routeMethod(text, name) {
  const start = text.indexOf(`export async function ${name}`);
  assert.notEqual(start, -1, `${name} route handler is missing`);
  const next = text.indexOf("\nexport async function ", start + 1);
  return text.slice(start, next === -1 ? text.length : next);
}

test("employee and legacy warehouse are read-only while admin writes warehouse data", () => {
  assert.equal(normalizeUserRole("warehouse"), "warehouse");
  assert.equal(normalizeUserRole(" EMPLOYEE "), "employee");
  assert.equal(normalizeUserRole("admin"), "admin");
  assert.equal(normalizeUserRole("unknown"), null);
  assert.equal(canWriteWarehouseData("admin"), true);
  assert.equal(canWriteWarehouseData("employee"), false);
  assert.equal(canWriteWarehouseData("warehouse"), false);
  assert.equal(canWriteWarehouseData("unknown"), false);
  assert.equal(userRoleLabel("admin", "boss"), "老板");
  assert.equal(userRoleLabel("admin", "manager"), "管理员");
  assert.equal(userRoleLabel("employee"), "员工");
  assert.equal(userRoleLabel("warehouse"), "员工");
});

test("fixed roles reject custom grants and changes remain version guarded", async()=>{
 const usersRoute=await source("app/api/users/route.ts"),auth=await source("lib/auth.ts");
 assert.match(usersRoute,/if\(p.permissions!==undefined\)/);
 assert.match(usersRoute,/role!=="employee"&&role!=="admin"/);
 assert.match(usersRoute,/eq\(users.permissionVersion,target.permissionVersion\)/);
 assert.match(auth,/permission\?hasPermission\(auth.user!,permission\)/);
});

test("permanent account deletion is atomic, protected, and keeps historical records", async () => {
  const [usersRoute, page, css, schema] = await Promise.all([
    source("app/api/users/route.ts"),
    source("components/AccountManager.tsx"),
    source("app/auth.css"),
    source("db/schema.ts"),
  ]);
  const handler = routeMethod(usersRoute, "DELETE");
  assert.match(handler, /requireUser\(req,"users.manage"\)/);
  assert.ok(handler.indexOf('requireUser(req,"users.manage")') < handler.indexOf("accountPayload(req)"));
  assert.match(handler, /confirmUsername/);
  assert.match(handler, /p\.id===a\.user!\.id/);
  assert.match(handler, /isProtectedOwnerUsername\(target\.username\)/);
  assert.match(handler, /role===\"admin\"/);
  assert.match(handler, /role!==\"employee\"&&role!==\"warehouse\"/);
  assert.match(handler, /if\(target\.active\).*status:409/);
  assert.match(handler, /db\.batch\(batchTuple\(\[/);
  assert.match(handler, /targetCondition=and\(eq\(users\.id,target\.id\),eq\(users\.active,0\),ne\(users\.id,a\.user!\.id\),inArray\(users\.role,\["employee","warehouse"\]\),sql`lower\(trim\(\$\{users\.username\}\)\) NOT IN \('boss','xmcxmc'\)`,eq\(users\.username,target\.username\),eq\(users\.permissionVersion,target\.permissionVersion\)\)/);
  assert.match(handler, /auditInsert=db\.insert\(auditLogs\)\.select\([\s\S]*\.from\(users\)\.where\(targetCondition\)\)\.returning/);
  assert.match(handler, /select\(\{id:sql<number>`null`\.as\("id"\),userId:[\s\S]*beforeSnapshot:sql<string\|null>`null`\.as\("before_snapshot"\),afterSnapshot:sql<string\|null>`null`\.as\("after_snapshot"\),createdAt:/);
  assert.match(handler, /db\.delete\(sessions\)\.where\(and\(eq\(sessions\.userId,target\.id\),auditGate\)\)/);
  assert.match(handler, /db\.delete\(users\)\.where\(and\(targetCondition,auditGate\)\)\.returning/);
  assert.match(handler, /历史操作记录保留/);
  assert.doesNotMatch(handler, /DELETE FROM audit_logs|DELETE FROM stocks|DELETE FROM storage_fee_settlements/);
  assert.match(page, /window\.confirm\(`确认永久删除账号/);
  assert.match(page, /confirmUsername:u.username/);
  assert.match(page, /className="delete-user" disabled=\{busy\|\|!!u.active\}/);
  assert.match(page, /u\.role!=='admin'/);
  assert.match(css, /\.user-list button\.delete-user\{background:#fff0ed;color:#b54735\}/);
  assert.doesNotMatch(schema, /references\(\(\)=>users\.id\)/);

  const db = drizzle({});
  assert.doesNotThrow(() => db.insert(auditLogs).select(db.select({
    id: sql`null`.as("id"),
    userId: sql`${1}`.as("user_id"),
    userName: sql`${"老板"}`.as("user_name"),
    action: sql`'删除账号'`.as("action"),
    entityType: sql`'系统账号'`.as("entity_type"),
    entityId: sql`${"2"}`.as("entity_id"),
    operationId: sql`${"delete-user:2:test"}`.as("operation_id"),
    summary: sql`${"删除测试"}`.as("summary"),
    beforeSnapshot: sql`null`.as("before_snapshot"),
    afterSnapshot: sql`null`.as("after_snapshot"),
    createdAt: sql`${"2026-08-17T00:00:00.000Z"}`.as("created_at"),
  }).from(users).where(eq(users.id, 2))).returning({ id: auditLogs.id }).toSQL());
});

test("stock discard requires explicit permission, atomic, restorable, and never creates an outbound settlement", async () => {
  const [discardRoute, movementsRoute, page, movementsPage, styles] = await Promise.all([
    source("app/api/stocks/discard/route.ts"),
    source("app/api/movements/route.ts"),
    source("app/page.tsx"),
    source("app/movements/page.tsx"),
    source("app/multi-stock.css"),
  ]);
  const discard = routeMethod(discardRoute, "DELETE"), restore = routeMethod(movementsRoute, "POST");
  assert.match(discard, /requireUser\(request,"stock.delete"\)/);
  assert.ok(discard.indexOf('requireUser(request,"stock.delete")') < discard.indexOf("request.json()"));
  assert.match(discard, /expectedVersion/);
  assert.match(discard, /eq\(stocks\.version, expectedVersion\)/);
  assert.match(discard, /eq\(stocks\.updatedAt, before\.updatedAt\)/);
  assert.match(discard, /db\.batch\(batchTuple\(\[/);
  assert.match(discard, /action: sql<string>`'删除'`/);
  assert.match(discard, /beforeSnapshot: sql<string>`\$\{JSON\.stringify\(before\)\}`/);
  assert.match(discard, /afterSnapshot: sql<string>`\$\{JSON\.stringify\(null\)\}`/);
  assert.match(discard, /不计入出入库/);
  assert.doesNotMatch(discardRoute, /storageFeeSettlements|storage_fee_settlements|settlementValue|calculateStorageFee/);

  assert.match(movementsRoute, /\["入库","出库","移库","库存修改","删除","恢复","箱件收货","箱件出库","箱件认领改单","箱件删除","撤销箱件操作"\]/);
  assert.match(restore, /\["入库","出库","移库","库存修改","删除"\]/);
  assert.match(restore, /log\.action==="删除"&&!hasPermission\(a\.user!,"stock.delete"\)/);
  assert.match(movementsRoute, /canRestoreDeletedStocks:hasPermission\(a\.user!,"stock.delete"\)/);
  assert.match(restore, /before===null[\s\S]*db\.insert\(stocks\)\.values\(\{id:before\.id/);

  assert.match(page, /const canDeleteInventory=allowed\("stock.delete"\)/);
  assert.match(page, /fetch\("\/api\/stocks\/discard",\{method:"DELETE"/);
  assert.match(page, /body:JSON\.stringify\(\{id:stock\.id,expectedVersion:Number\(stock\.version\?\?0\),requestId\}\)/);
  assert.match(page, /\{canDeleteInventory&&<button type="button" className="delete-stock"/);
  assert.match(page, /recentMovement\.action!=="删除"\|\|canDeleteInventory/);
  assert.match(styles, /\.stock-tabs>\.stock-tab-row\{[^}]*grid-template-columns:minmax\(0,1fr\) auto/);
  assert.match(styles, /\.stock-tab-row>\.delete-stock\{[^}]*background:#fff0ed/);
  assert.match(movementsPage, /setCanRestoreDeletedStocks\(d\.canRestoreDeletedStocks === true\)/);
  assert.match(movementsPage, /log\.action !== "删除" \|\| canRestoreDeletedStocks/);
  assert.match(movementsPage, /\[restoringId, setRestoringId\] = useState<number \| null>\(null\)/);
  assert.match(movementsPage, /disabled=\{(?:loading\|\|)?restoringId !== null\}[\s\S]*?restoringId === log\.id \? "恢复中…" : "恢复"/);
  assert.match(movementsPage, /无恢复权限/);
});

test("every inventory mutation uses the fail-closed write guard before reading its payload", async () => {
  const [stocks, discard, move, locations, movements] = await Promise.all([
    source("app/api/stocks/route.ts"),
    source("app/api/stocks/discard/route.ts"),
    source("app/api/stocks/move/route.ts"),
    source("app/api/locations/route.ts"),
    source("app/api/movements/route.ts"),
  ]);
  for (const [text, method, label] of [
    [stocks, "POST", "stock save"],
    [stocks, "PATCH", "stock outbound"],
    [stocks, "DELETE", "stock delete"],
    [move, "POST", "stock move"],
    [locations, "PATCH", "capacity update"],
    [movements, "POST", "movement restore"],
  ]) {
    const body = routeMethod(text, method);
    assert.match(body, /requireWriteUser\(/, `${label} must use requireWriteUser`);
    const guard = body.indexOf("requireWriteUser(");
    const payload = body.indexOf("request.json(") >= 0 ? body.indexOf("request.json(") : body.indexOf("req.json(");
    if (payload >= 0) assert.ok(guard < payload, `${label} must reject before parsing the payload`);
  }
  assert.match(routeMethod(stocks, "GET"), /requireUser\(/);
  assert.doesNotMatch(routeMethod(stocks, "GET"), /requireWriteUser\(/);
  const discardHandler = routeMethod(discard, "DELETE");
  assert.match(discardHandler, /requireUser\(request,"stock.delete"\)/);
  assert.ok(discardHandler.indexOf('requireUser(request,"stock.delete")') < discardHandler.indexOf("request.json()"));
  assert.match(routeMethod(locations, "GET"), /requireUser\(/);
  assert.match(routeMethod(movements, "GET"), /requireUser\(/);
  assert.match(routeMethod(movements, "GET"), /canRestore:/);
  assert.match(await source("app/api/auth/password/route.ts"), /requireUser\(req\)/);
});

test("warehouse keeps employee browsing surfaces but receives a dedicated read-only inventory panel", async () => {
  const [page, movementsPage, css, multiStockCss, layout] = await Promise.all([
    source("app/page.tsx"),
    source("app/movements/page.tsx"),
    source("app/role-permissions.css"),
    source("app/multi-stock.css"),
    source("app/layout.tsx"),
  ]);
  assert.match(page, /<AccountManager viewer=\{user\}/);
  assert.match(page, /userRoleLabel\(user\.role,user\.username\)/);
  assert.match(page, /const canWriteInventory=canOperateStock\(user\)/);
  assert.match(page, /仓库账号仅可搜索和查看，不能修改库存数据/);
  assert.match(page, /allowed\("stock.restore"\)&&recentMovement/);
  assert.match(page, /canWriteInventory\?"调整当前库位":"查看当前库位"/);
  assert.match(page, /const resetSessionUi=.*stockDirty\.current=false.*setMapEdit\(false\).*setSettings\(false\).*setUsersOpen\(false\).*setMapLayoutDirty\(false\)/s);
  assert.match(page, /if\(r\.ok&&d\.user\)\{resetSessionUi\(\);setUser\(d\.user\)/);
  assert.match(page, /const logout=async\(\)=>\{[\s\S]*fetch\("\/api\/auth\/logout"[\s\S]*if\(!r\.ok\)[\s\S]*resetSessionUi\(\);setUser\(null\)/);
  assert.match(page, /\{mapEditing&&<div className="map-editbar">/);
  assert.match(page, /\{mapSettingsOpen&&<div className="modal-backdrop">/);
  assert.match(page, /\{allowed\("users.manage"\)&&usersOpen&&<AccountManager/);
  const readOnlyPanel = page.slice(page.indexOf("const readOnlyEditor="), page.indexOf("const toggleListZone="));
  assert.match(readOnlyPanel, /editor-stock-search/);
  assert.match(readOnlyPanel, /read-only-stock-grid/);
  assert.match(readOnlyPanel, /sourceStatusLabel\(editing\.inboundSource\)/);
  assert.doesNotMatch(readOnlyPanel, /saveStock|confirmOutbound|openMove|newStock|setScanning/);
  assert.equal((page.match(/className="stock-tab-layer"/g) ?? []).length, 2, "both product sidebars should show the layer badge");
  assert.equal((page.match(/className="stock-tab-product"/g) ?? []).length, 2);
  assert.equal((page.match(/className="stock-tab-meta"/g) ?? []).length, 2);
  assert.equal((page.match(/className="stock-tab-product"><StockProductName stock=\{s\}\/><\/span>/g) ?? []).length, 2);
  assert.equal((page.match(/s\.inventoryUnit==='box'\?`箱库存 · \$\{s\.totalBoxes\}箱`/g) ?? []).length, 2, "both sidebars should label box stock without zero pieces");
  assert.equal((page.match(/\{s\.layerCount\|\|1\}层/g) ?? []).length, 2, "legacy rows should fall back to one layer");
  assert.match(multiStockCss, /\.stock-tabs>\.stock-tab-select,\.stock-tab-row>\.stock-tab-select\{[^}]*display:grid;[^}]*grid-template-columns:max-content minmax\(0,1fr\)/s);
  assert.match(multiStockCss, /\.stock-tab-layer\{[^}]*min-width:0;[^}]*min-height:0;[^}]*padding:3px 6px;[^}]*border-radius:999px;[^}]*background:#e3efe8;[^}]*color:#1d6a4e;[^}]*font-size:10px;[^}]*white-space:nowrap;[^}]*box-shadow:none/s);
  assert.match(multiStockCss, /\.stock-tab-meta\{[^}]*grid-column:1\/-1;[^}]*grid-row:2/s, "stock metadata should use the full row below the compact layer badge");
  assert.doesNotMatch(multiStockCss, /grid-template-columns:(?:50px|43px) minmax\(0,1fr\)|min-width:(?:48px|41px)|min-height:(?:52px|47px)|font-size:(?:17px|15px)/, "the sidebar layer badge should not regain its former fixed tile size");
  assert.match(css, /\.warehouse-read-only \.editor:not\(\.read-only-editor\)\{display:none\}/);
  assert.match(layout, /role-permissions\.css/);
  assert.match(movementsPage, /setCanRestore\(d\.canRestore === true\)/);
  assert.match(movementsPage, /!canRestoreLog\(log\)/);
  assert.match(movementsPage, /仅可搜索和查看记录/);
});
