import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('bootstrap creates an unusable password and never resets an existing password', async () => {
  const source = await readFile(new URL('../lib/auth.ts', import.meta.url), 'utf8');
  const body = source.match(/export async function ensureAuthSchema\(\)\{([\s\S]*?)\n\]\)\}/)?.[1];
  assert.ok(body, 'auth schema setup must be found');
  const statements = [];
  const env = { DB: { prepare(sql) { statements.push(sql); return sql; }, async batch() {} } };
  await new Function('env', `return (async () => {${body}\n])})()`)(env);
  const seed = statements.find(sql => sql.startsWith('INSERT OR IGNORE INTO users'));
  assert.ok(seed?.includes('!setup-via-handoff-required!'));
  assert.equal(statements.some(sql => /UPDATE users SET password_hash/i.test(sql)), false);
  // PBKDF2 SHA-256 produces 32 bytes (44 base64 chars); this sentinel cannot match.
  assert.notEqual('!setup-via-handoff-required!'.length, 44);
  const migration = await readFile(new URL('../drizzle/0002_clean_blacklash.sql', import.meta.url), 'utf8');
  assert.ok(migration.includes('!setup-via-handoff-required!'));
});
