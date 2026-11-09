const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const { createSync } = require('../src/import');
const { createGuardedWrite, runSql, compatible } = require('../src/writeback');

test('guarded sync on a disposable WAL library', async t => {
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
  let write = createGuardedWrite(async () => {});
  const run = (extra = {}) => createSync((...args) => write(...args))({ database: db, folder: 'Target', vault, vaultId: dir, state, studioAsar: 'synthetic', save: async () => {}, ...extra });
  const first = await run(); const file = first.find(r => r.status === 'imported').path;
  const baseline = notes.get(file); notes.set(file, baseline.replace('Hello', 'Vault edit'));
  const before = sql("SELECT json_group_array(json_object('id',id,'data',body)) FROM outbox;");
  const originalRead = vault.read;
  let reads = 0;
  vault.read = async p => {
    const value = await originalRead(p);
    if (++reads === 2) sql("UPDATE files SET data=json_set(data,'$.content','<p>Racing source</p>') WHERE id='a'");
    return value;
  };
  assert.ok((await run()).some(r => r.status === 'failed'));
  assert.equal(notes.get(file), baseline.replace('Hello', 'Vault edit'));
  assert.equal(sql("SELECT json_extract(data,'$.content') FROM files WHERE id='a'").trim(), '<p>Racing source</p>');
  sql("UPDATE files SET data=json_set(data,'$.content','<p>Hello</p>') WHERE id='a'");
  vault.read = originalRead;
  reads = 0;
  vault.read = async p => { const value = await originalRead(p); if (++reads === 2) { notes.set(p, 'racing vault edit'); return 'racing vault edit'; } return value; };
  assert.ok((await run()).some(r => r.status === 'changed-during-sync'));
  assert.equal(notes.get(file), 'racing vault edit');
  vault.read = originalRead;
  notes.set(file, baseline.replace('Hello', 'Vault edit'));
  assert.ok((await run()).some(r => r.status === 'written-back'));
  assert.equal(sql("SELECT json_extract(data,'$.content') FROM files WHERE id='a';").trim(), '<p>Vault edit</p>');
  assert.equal(sql("SELECT content FROM local_versions WHERE file_id='a';").trim(), '"<p>Hello</p>"');
  assert.equal(sql("SELECT json_group_array(json_object('id',id,'data',body)) FROM outbox;"), before);
  const saved = notes.get(file); notes.set(file, saved.replace('Vault edit', 'Second edit'));
  const beforeBaseline = state.scopes[JSON.stringify([db, dir, 'Target'])]['file:a'].baseline;
  write = createGuardedWrite(async () => {}, (database, script) => runSql(database, script.replace('COMMIT;', 'SELECT no_such_column;\nCOMMIT;')));
  assert.ok((await run()).some(r => r.status === 'failed'));
  assert.equal(sql("SELECT json_extract(data,'$.content') FROM files WHERE id='a';").trim(), '<p>Vault edit</p>');
  assert.equal(state.scopes[JSON.stringify([db, dir, 'Target'])]['file:a'].baseline, beforeBaseline);
  write = createGuardedWrite(async () => {});
  sql('CREATE TABLE unexpected(x)');
  assert.ok((await run()).some(r => r.status === 'failed'));
  sql('DROP TABLE unexpected');
  const holder = spawn('python3', ['-u', '-c', "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('select * from files').fetchall(); print('ready',flush=True); sys.stdin.readline()", db], {stdio:['pipe','pipe','inherit']});
  await once(holder.stdout, 'data');
  assert.ok((await run()).some(r => r.status === 'failed'));
  holder.stdin.end('done\n'); await once(holder, 'exit');
  write = createGuardedWrite(async () => {}, (database, script) => runSql(database, script.replace("FROM outbox WHERE status", "FROM (SELECT 'failed' status, 'a' entity_id, NULL temp_ids, NULL url, NULL body) WHERE status")));
  assert.ok((await run()).some(r => r.status === 'failed'));
  assert.equal(sql("SELECT json_extract(data,'$.content') FROM files WHERE id='a';").trim(), '<p>Vault edit</p>');
  assert.equal(notes.get(file), saved.replace('Vault edit', 'Second edit'));
  assert.equal(sql("SELECT json_group_array(json_object('id',id,'data',body)) FROM outbox;"), before);
  write = createGuardedWrite(async () => {});
  assert.ok((await run({ save: async () => { throw Error('save failed'); } })).some(r => r.status === 'failed'));
  assert.equal(state.scopes[JSON.stringify([db, dir, 'Target'])]['file:a'].baseline, beforeBaseline);
  assert.equal(sql("SELECT json_extract(data,'$.content') FROM files WHERE id='a';").trim(), '<p>Second edit</p>');
  assert.match(notes.get(file), /Second edit/);
});

test('compatibility fails closed for unsupported environments', async () => {
  const good = { platform: 'linux', access: async () => {}, readFile: async () => Buffer.alloc(0),
    hash: () => '25e93b78fb4753f7b47236a91f8907e674c341aab19af271d93c7dd1e04dbcfa',
    statfs: async () => ({ type: 0xef53 }), execFileSync: () => '3.53.4 synthetic' };
  await compatible('/fixture/db.sqlite', 'synthetic', good);
  for (const [override, expected] of [
    [{ access: async () => { throw Error('marker missing'); } }, /marker missing/],
    [{ platform: 'darwin' }, /Unsupported platform/],
    [{ hash: () => 'other' }, /Untested Studio build/],
    [{ statfs: async () => ({ type: 1 }) }, /Unsupported filesystem/],
    [{ execFileSync: () => '3.1.0' }, /Untested sqlite3 version/]
  ]) await assert.rejects(compatible('/fixture/db.sqlite', 'synthetic', { ...good, ...override }), expected);
});
