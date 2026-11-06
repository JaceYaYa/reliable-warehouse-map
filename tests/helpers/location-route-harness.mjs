import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';

const require = createRequire(import.meta.url);
// Run the real route and real Drizzle D1 queries against an isolated SQLite
// database. The adapter implements D1's atomic batch, including SQL triggers.
export function locationRouteHarness(d1) {
  const sqlite = new DatabaseSync(':memory:');
  for (const entry of JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8')).entries) sqlite.exec(readFileSync(`drizzle/${entry.tag}.sql`, 'utf8'));
  const state = { beforeBatch: null, role: 'admin', audits: [] };
  const bindValue = value => typeof value === 'boolean' ? Number(value) : value;
  const adapter = {
    prepare(sql) {
      const make = values => ({
        bind: (...args) => make(args.map(bindValue)),
        raw: async () => { const statement = sqlite.prepare(sql); statement.setReturnArrays(true); return statement.all(...values); },
        all: async () => ({ results: sqlite.prepare(sql).all(...values), success: true }),
        run: async () => { sqlite.prepare(sql).run(...values); return { results: [], success: true }; },
      });
      return make([]);
    },
    async batch(queries) {
      const hook = state.beforeBatch; state.beforeBatch = null; hook?.(sqlite);
      sqlite.exec('BEGIN');
      try { const results = []; for (const query of queries) results.push(await query.all()); sqlite.exec('COMMIT'); return results; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  const db = require('drizzle-orm/d1').drizzle(d1 ?? adapter);
  const cache = new Map();
  function load(file) {
    if (cache.has(file)) return cache.get(file);
    const exports = {}; cache.set(file, exports);
    const output = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    const localRequire = specifier => {
      if (specifier === '../../../db') return { getDb: () => db };
      if (specifier === '../../../lib/auth') return { requireUser: async (_request, admin) => state.role === 'none' || (admin && state.role !== 'admin') ? { error: Response.json({ error: '无权限' }, { status: 403 }) } : { user: { id: 1, role: state.role } }, requireWriteUser: async () => ({ user: { id: 1 } }) };
      if (specifier === '../../../lib/audit') return { recordAudit: async (...args) => { state.audits.push(args); } };
      if (!specifier.startsWith('.')) return require(specifier);
      let target = resolve(dirname(file), specifier); if (!existsSync(target)) target += '.ts'; return load(target);
    };
    runInNewContext(output, { exports, require: localRequire, Response, Request, URL, crypto, TextEncoder, Uint8Array, console });
    return exports;
  }
  const route = load(resolve('app/api/locations/route.ts'));
  const setting = (key, value) => sqlite.prepare("INSERT INTO settings(key,value,updated_at) VALUES (?,?,'now') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, JSON.stringify(value));
  const readSetting = key => JSON.parse(sqlite.prepare('SELECT value FROM settings WHERE key=?').get(key).value);
  const get = async () => (await route.GET(new Request('http://local.test/api/locations'))).json();
  const post = async payload => { const response = await route.POST(new Request('http://local.test/api/locations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })); return { status: response.status, data: await response.json() }; };
  const stock = (code, product='测试货物') => sqlite.prepare("INSERT INTO stocks(location_code,inbound_date,product,updated_at,total_quantity,total_boxes,pallet_count,layer_count,version,note) VALUES (?,'2026-09-21',?,'unchanged',11,3,0.5,2,7,'保留备注')").run(code, product);
  return { sqlite, adapter, state, route, setting, readSetting, get, post, stock };
}

export const editableZones = () => [{ id: 'NEW_B', title: 'B区 · 库位', codes: ['B1', 'B2', 'B3'], locationCodesVersion: 1, layoutVersion: 8, newPalletCapacityVersion: 1, unified: true, features: [], layout: Object.fromEntries(['B1','B2','B3'].map((code, index) => [code, { x: 10+index*5, y: 20, w: 2, h: 3, capacityPallets: 2, capacityBoxes: 8 }])) }];
