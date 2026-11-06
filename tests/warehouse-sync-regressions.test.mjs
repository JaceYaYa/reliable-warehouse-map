import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { createWarehouseSync, SYNC_INTERVAL_MS, SYNC_MAX_RETRY_MS } from "../lib/warehouse-sync.ts";
import { createSyncReader, readWarehouseSync } from "../lib/warehouse-sync-read.ts";

const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };
function client(request) {
  let now=0, visible=true, online=true, nextId=0;
  const timers=new Map(), applied=[], observed=[];
  const state={ stats:null, unauthorized:0, blocked:false };
  const sync=createWarehouseSync({ request, visible:()=>visible, online:()=>online,
    now:()=>now, schedule:(cb,delay)=>{const id=++nextId;timers.set(id,{cb,at:now+delay});return id},cancel:id=>timers.delete(id),
    apply:(resource,data)=>{if(resource==="locations"&&state.blocked)return false;applied.push({resource,data});return true},
    onStats:stats=>{state.stats=stats;observed.push(stats)},onUnauthorized:()=>state.unauthorized++,
  });
  async function advance(ms){const target=now+ms;for(;;){const next=[...timers.entries()].filter(([,t])=>t.at<=target).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;now=next[1].at;timers.delete(next[0]);next[1].cb();await flush()}now=target;await flush()}
  return {sync,state,applied,observed,advance,timers,hide:()=>{visible=false;sync.wake()},show:()=>{visible=true;sync.wake()},offline:()=>{online=false;sync.wake()},online:()=>{online=true;sync.wake()}};
}
const snapshot = (version="1") => ({versions:{stocks:version,locations:version,recent:version},data:{stocks:{stocks:[]},locations:{zones:null},recent:{logs:[]}}});

test("one visible hour makes 301 checks, hidden time makes none, return refreshes immediately",async()=>{
  let requests=0;
  const c=client(async versions=>{requests++;return requests===1?snapshot():{versions,data:{}}});
  c.sync.start();await flush();await c.advance(3_600_000);
  assert.equal(requests,301);assert.equal(c.applied.length,3);assert.equal(c.state.stats.unchanged,300);
  c.hide();await c.advance(3_600_000);assert.equal(requests,301);
  c.show();await flush();assert.equal(requests,302);c.sync.stop();
});

test("overlapping triggers coalesce and old responses cannot overwrite a local mutation",async()=>{
  const pending=deferred();let requests=0;
  const c=client(async()=>++requests===1?pending.promise:snapshot("new"));
  c.sync.start();c.sync.wake();c.sync.wake();await flush();assert.equal(requests,1);
  const end=c.sync.beginMutation();await c.sync.refresh();end();await c.advance(0);assert.equal(requests,1);
  pending.resolve(snapshot("old"));await flush();await c.advance(0);
  assert.equal(requests,2);assert.deepEqual(c.applied.map(x=>x.resource),["stocks","locations","recent"]);
  c.sync.stop();
});

test("dirty layout versions are not acknowledged until they can be applied",async()=>{
  const seen=[];const c=client(async versions=>{seen.push({...versions});return snapshot()});c.state.blocked=true;
  c.sync.start();await flush();await c.advance(SYNC_INTERVAL_MS);
  assert.equal(seen[1].stocks,"1");assert.equal(seen[1].locations,undefined);
  c.state.blocked=false;await c.advance(SYNC_INTERVAL_MS);await c.advance(SYNC_INTERVAL_MS);
  assert.equal(seen.at(-1).locations,"1");c.sync.stop();
});

test("failed requests back off, offline pauses, online retries immediately",async()=>{
  let requests=0, fail=true;const c=client(async()=>{requests++;if(fail)throw new Error("offline");return snapshot()});
  c.sync.start();await flush();assert.equal(requests,1);
  await c.advance(23_999);assert.equal(requests,1);await c.advance(1);assert.equal(requests,2);
  await c.advance(48_000);assert.equal(requests,3);await c.advance(96_000);assert.equal(requests,4);
  await c.advance(SYNC_MAX_RETRY_MS);assert.equal(requests,5);
  c.offline();await c.advance(300_000);assert.equal(requests,5);
  fail=false;c.online();await flush();assert.equal(requests,6);assert.equal(c.state.stats.state,"ready");c.sync.stop();
});

test("hiding aborts the request and ignores its late response; stopped sessions never update state",async()=>{
  const pending=deferred();let signal;
  const c=client(async(_,s)=>{signal=s;return pending.promise});c.sync.start();c.hide();assert.ok(signal.aborted);
  c.sync.stop();const count=c.observed.length;pending.resolve(snapshot());await flush();
  assert.equal(c.applied.length,0);assert.equal(c.observed.length,count);assert.equal(c.timers.size,0);
});

test("expired/revoked sessions stop polling and clear the signed-in UI",async()=>{
  let requests=0;const c=client(async()=>{requests++;throw Object.assign(new Error("denied"),{status:401})});
  c.sync.start();await flush();await c.advance(120_000);c.show();await flush();
  assert.equal(requests,1);assert.equal(c.state.unauthorized,1);assert.equal(c.applied.length,0);
});

test("timeout releases a stuck request and retries with backoff",async()=>{
  let requests=0;const c=client(async(_,signal)=>{requests++;return new Promise((_,reject)=>signal.addEventListener("abort",()=>reject(new Error("aborted")),{once:true}))});
  c.sync.start();await c.advance(20_000);assert.equal(c.state.stats.failed,1);
  await c.advance(24_000);assert.equal(requests,2);c.sync.stop();await flush();
});

async function database(){
  const db=new DatabaseSync(":memory:"), journal=JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json",import.meta.url),"utf8"));
  for(const entry of journal.entries)db.exec(await readFile(new URL(`../drizzle/${entry.tag}.sql`,import.meta.url),"utf8"));
  const queries=[];
  // SQLite fixtures do not pretend to provide Cloudflare billing metadata.
  const adapter = {
    prepare(sql) {
      return { bind(...values) {
        return { async all() { queries.push(sql); return { results: db.prepare(sql).all(...values) }; } };
      } };
    },
  };
  return {db,queries,adapter};
}
const viewer={id:1,username:"boss",displayName:"老板",role:"admin"};
const insertStock=db=>db.exec("INSERT INTO stocks (id,location_code,inbound_date,product,updated_at) VALUES (1,'A1','2026-08-20','测试货物','2026-09-04')");
const insertLog=(db,id,action,snapshot=null)=>db.prepare("INSERT INTO audit_logs (id,user_id,user_name,action,entity_type,entity_id,summary,before_snapshot,after_snapshot,created_at) VALUES (?,1,'test',?,'库位','A1','test',?,?, '2026-09-04')").run(id,action,snapshot,snapshot);

test("real SQLite migrations preserve inventory; changes, deletion, restore and bulk writes invalidate tokens",async()=>{
  const {db,adapter}=await database();const r=createSyncReader(adapter);let previous=await r.versions("1:admin");
  insertStock(db);const inserted=await r.versions("1:admin");assert.notEqual(inserted.stocks,previous.stocks);previous=inserted;
  for(const sql of ["UPDATE stocks SET total_quantity=8 WHERE id=1","DELETE FROM stocks WHERE id=1"]){db.exec(sql);const next=await r.versions("1:admin");assert.notEqual(next.stocks,previous.stocks);previous=next}
  insertStock(db);assert.notEqual((await r.versions("1:admin")).stocks,previous.stocks);
  db.exec("BEGIN; UPDATE stocks SET total_boxes=5; UPDATE stocks SET location_code='B1'; COMMIT");
  const beforeRollback=await r.versions("1:admin");db.exec("BEGIN; DELETE FROM stocks; ROLLBACK");assert.deepEqual(await r.versions("1:admin"),beforeRollback);
  assert.equal(db.prepare("SELECT total_boxes FROM stocks").get().total_boxes,5);db.close();
});

test("unchanged checks read only three revision rows, not stock/layout/history contents",async()=>{
  const {db,adapter,queries}=await database();insertStock(db);insertLog(db,1,"入库");
  const initial=await readWarehouseSync(adapter,viewer,new URLSearchParams());assert.equal(initial.data.stocks.stocks[0].locationCode,"A1");
  queries.length=0;const unchanged=await readWarehouseSync(adapter,viewer,new URLSearchParams(initial.versions));
  assert.deepEqual(unchanged.data,{});assert.equal(queries.length,1);assert.match(queries[0],/FROM warehouse_sync_versions/);
  assert.equal(unchanged.usage.rowsRead,null);assert.equal(unchanged.usage.rowsWritten,null);db.close();
});

test("two clients see additions, correction, deletion and restore on their next check",async()=>{
  const {db,adapter}=await database();let a={},b={};
  const check=async tokens=>readWarehouseSync(adapter,viewer,new URLSearchParams(tokens));
  a=(await check(a)).versions;b=(await check(b)).versions;insertStock(db);
  assert.equal((await check(a)).data.stocks.stocks.length,1);b=(await check(b)).versions;
  db.exec("UPDATE stocks SET total_quantity=40");let result=await check(b);assert.equal(result.data.stocks.stocks[0].totalQuantity,40);b=result.versions;
  db.exec("DELETE FROM stocks");result=await check(b);assert.equal(result.data.stocks.stocks.length,0);b=result.versions;
  insertStock(db);result=await check(b);assert.equal(result.data.stocks.stocks.length,1);db.close();
});

test("layout changes and deletions invalidate only layouts; unrelated settings do not",async()=>{
  const {db,adapter}=await database();const check=()=>createSyncReader(adapter).versions("1:admin");const first=await check();
  db.exec("INSERT INTO settings VALUES ('unrelated','1','now')");assert.deepEqual(await check(),first);
  db.exec("INSERT INTO settings VALUES ('warehouse_map_canvas','{\"width\":10000,\"height\":10000}','now')");const changed=await check();assert.notEqual(changed.locations,first.locations);assert.equal(changed.stocks,first.stocks);
  db.exec("DELETE FROM settings WHERE key='warehouse_map_canvas'");assert.notEqual((await check()).locations,changed.locations);db.close();
});

test("latest record uses bounded indexed lookup, retains correction/deletion/restore and pricing redaction",async()=>{
  const {db,adapter,queries}=await database();insertLog(db,1,"入库");insertLog(db,2,"库存修改");insertLog(db,3,"删除",JSON.stringify({product:"测试",itemVolumeM3:12,storageRateUsd:0.7,freeDays:30}));insertLog(db,4,"登录");
  const reader=createSyncReader(adapter);const admin=await reader.recent("admin"),employee=await reader.recent("employee"),warehouse=await reader.recent("warehouse");
  assert.equal(admin.logs[0].id,3);assert.equal(JSON.parse(admin.logs[0].beforeSnapshot).itemVolumeM3,12);
  assert.equal(JSON.parse(employee.logs[0].beforeSnapshot).storageRateUsd,undefined);assert.equal(warehouse.canRestore,false);assert.equal(employee.canRestoreDeletedStocks,false);
  assert.ok(queries.every(sql=>! /COUNT\s*\(/i.test(sql)));
  const latestQuery=queries.find(sql=>sql.includes("INDEXED BY"));const plan=db.prepare("EXPLAIN QUERY PLAN "+latestQuery).all().map(x=>x.detail).join(" ");assert.match(plan,/audit_logs_recent_sync_idx/);assert.doesNotMatch(plan,/TEMP B-TREE/);
  insertLog(db,5,"恢复");assert.equal((await reader.recent("admin")).logs[0].action,"恢复");db.close();
});

test("role changes invalidate cached results and dirty maps defer transfer without acknowledging",async()=>{
  const {db,adapter,queries}=await database();const initial=await readWarehouseSync(adapter,viewer,new URLSearchParams());
  queries.length=0;const params=new URLSearchParams(initial.versions);params.set("skipLocations","1");
  db.exec("INSERT INTO settings VALUES ('warehouse_zones','[]','now')");
  const deferred=await readWarehouseSync(adapter,viewer,params);assert.equal(deferred.data.locations,undefined);assert.equal(queries.length,1);
  params.delete("skipLocations");assert.ok((await readWarehouseSync(adapter,viewer,params)).data.locations);
  assert.ok((await readWarehouseSync(adapter,{...viewer,role:"warehouse"},new URLSearchParams(initial.versions))).data.stocks);db.close();
});

test("usage totals report real supplied metadata and never substitute missing measurements with zero",async()=>{
  const adapter={prepare(){return{bind(){return{async all(){return{results:[],meta:{rows_read:7,rows_written:0}}}}}}}};
  const reader=createSyncReader(adapter);await reader.stocks();await reader.stocks();assert.deepEqual(reader.usage,{rowsRead:42,rowsWritten:0,queries:6});
  const {db,adapter:unmeasured}=await database();const missing=createSyncReader(unmeasured);await missing.stocks();assert.equal(missing.usage.rowsRead,null);db.close();
});

test("a write between version capture and content loading is not accidentally acknowledged",async()=>{
  const {db,adapter}=await database();insertStock(db);let changed=false;
  const racing={prepare(sql){const statement=adapter.prepare(sql);return{bind(...args){const bound=statement.bind(...args);return{async all(){const result=await bound.all();if(!changed&&sql.includes("warehouse_sync_versions")){changed=true;db.exec("UPDATE stocks SET total_quantity=99")}return result}}}}}};
  const first=await readWarehouseSync(racing,viewer,new URLSearchParams());assert.equal(first.data.stocks.stocks[0].totalQuantity,99);
  const second=await readWarehouseSync(adapter,viewer,new URLSearchParams(first.versions));assert.ok(second.data.stocks);assert.notEqual(first.versions.stocks,second.versions.stocks);db.close();
});

test("archiving/deleting the latest log invalidates recent data, and deleting the layout resets it",async()=>{
  const {db,adapter}=await database();insertLog(db,1,"入库");insertLog(db,2,"删除");
  db.exec("INSERT INTO settings VALUES ('warehouse_zones','[]','now')");const before=await readWarehouseSync(adapter,viewer,new URLSearchParams());
  db.exec("DELETE FROM audit_logs WHERE id=2; DELETE FROM settings WHERE key='warehouse_zones'");
  const after=await readWarehouseSync(adapter,viewer,new URLSearchParams(before.versions));assert.equal(after.data.recent.logs[0].id,1);assert.equal(after.data.locations.zones,null);db.close();
});

test("the page wires every inventory mutation through the full-operation barrier",async()=>{
  const page=await readFile(new URL("../app/page.tsx",import.meta.url),"utf8");
  for(const name of ["saveStock","confirmOutbound","discardStock","confirmMove","saveCapacity","persistZones","saveSettings","confirmUndoRecent"])assert.ok(page.includes(`const ${name}=withWarehouseMutation(`),name);
  assert.match(page,/finally\{end\?\.\(\)\}/);assert.match(page,/visibilitychange/);assert.match(page,/window.addEventListener\("online"/);assert.match(page,/window.addEventListener\("offline"/);
  assert.doesNotMatch(page,/setInterval\(\(\)=>\{load\(\)/);
  assert.match(page,/allowed\("health.view"\)&&<SyncUsage/);
});

test("sync route rejects unauthorized requests before database reads; ordinary auth has no setup writes",async()=>{
  const source=await readFile(new URL("../app/api/sync/route.ts",import.meta.url),"utf8");const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  let reads=0;const exports={};const denied=new Response("denied",{status:401});
  runInNewContext(code,{exports,Response,URL,require:name=>name==="cloudflare:workers"?{env:{DB:{}}}:name.endsWith("auth")?{requireUser:async()=>({error:denied})}:{readWarehouseSync:async()=>{reads++;return{}}}});
  assert.equal((await exports.GET(new Request("https://test/api/sync"))).status,401);assert.equal(reads,0);
  const auth=await readFile(new URL("../lib/auth.ts",import.meta.url),"utf8"),login=await readFile(new URL("../app/api/auth/login/route.ts",import.meta.url),"utf8");
  const currentUser=auth.match(/export async function currentUser[^\n]+/)[0];assert.doesNotMatch(currentUser,/ensureAuthSchema|CREATE|UPDATE|INSERT/);assert.match(currentUser,/eq\(users.active,1\)/);assert.match(login,/ensureAuthSchema\(\)/);
});
