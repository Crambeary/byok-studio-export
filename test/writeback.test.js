const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const { sync } = require('../src/import');

const asar = process.env.BYOK_TEST_STUDIO_ASAR;
test('guarded sync on a disposable WAL library', { skip: !asar && 'set BYOK_TEST_STUDIO_ASAR to the tested Studio binary' }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-guard-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const db = path.join(dir, 'db.sqlite');
  await fs.writeFile(path.join(dir, 'DISPOSABLE_SYNTHETIC_LIBRARY'), 'synthetic\n');
  const schema = await fs.readFile(path.join(__dirname, '../experiments/studio_writeback/evidence/schema.sql'), 'utf8');
  const sql = (statement) => execFileSync('sqlite3', [db, statement], { encoding: 'utf8' });
  sql(`PRAGMA journal_mode=WAL; ${schema}
    INSERT INTO projects(id,data,mirrored_at) VALUES('p','{"name":"Project"}',0);
    INSERT INTO files(id,project_id,type,data,mirrored_at) VALUES('a','p','text','{"id":"a","name":"File","content":"<p>Hello</p>"}',0);`);
  const notes = new Map(), state = { version: 1, scopes: {} };
  const vault = { exists: async p => notes.has(p), read: async p => notes.get(p) ?? null,
    create: async (p,c) => notes.set(p,c), compareAndWrite: async (p,a,b) => { if (notes.get(p)!==a) return false; notes.set(p,b); return true; } };
  const run = (extra = {}) => sync({ database: db, folder: 'Target', vault, vaultId: dir, state, studioAsar: asar, save: async () => {}, ...extra });
  const first = await run(); const file = first.find(r => r.status === 'imported').path;
  const baseline = notes.get(file); notes.set(file, baseline.replace('Hello', 'Vault edit'));
  const before = sql("SELECT json_group_array(json_object('id',id,'data',body)) FROM outbox;");
  assert.ok((await run()).some(r => r.status === 'written-back'));
  assert.equal(sql("SELECT json_extract(data,'$.content') FROM files WHERE id='a';").trim(), '<p>Vault edit</p>');
  assert.equal(sql("SELECT content FROM local_versions WHERE file_id='a';").trim(), '"<p>Hello</p>"');
  assert.equal(sql("SELECT json_group_array(json_object('id',id,'data',body)) FROM outbox;"), before);
  const saved = notes.get(file); notes.set(file, saved.replace('Vault edit', 'Second edit'));
  sql("INSERT INTO outbox(kind,method,url,body,status,created_at,updated_at) VALUES('test','PUT','/other','a','failed',0,0);");
  assert.ok((await run()).some(r => r.status === 'failed'));
  assert.equal(sql("SELECT json_extract(data,'$.content') FROM files WHERE id='a';").trim(), '<p>Vault edit</p>');
  assert.equal(notes.get(file), saved.replace('Vault edit', 'Second edit'));
});
