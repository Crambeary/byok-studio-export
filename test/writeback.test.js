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
    INSERT INTO metadata(key,value) VALUES('schema_version','3'),('telemetry.lastVersion','1.1.3'),('currentUserId','local');
    INSERT INTO projects(id,data,mirrored_at) VALUES('p','{"name":"Project"}',0);
    INSERT INTO files(id,project_id,type,data,mirrored_at) VALUES('a','p','text','{"id":"a","name":"File","content":"<p>Hello</p>"}',0);`);
  const notes = new Map(), state = { version: 1, scopes: {} };
  const vault = { safeToMutate: async () => true, exists: async p => notes.has(p), read: async p => notes.get(p) ?? null,
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
    if (p === file && ++reads === 2) sql("UPDATE files SET data=json_set(data,'$.content','<p>Racing source</p>') WHERE id='a'");
    return value;
  };
  assert.ok((await run()).some(r => r.status === 'failed'));
  assert.equal(notes.get(file), baseline.replace('Hello', 'Vault edit'));
  assert.equal(sql("SELECT json_extract(data,'$.content') FROM files WHERE id='a'").trim(), '<p>Racing source</p>');
  sql("UPDATE files SET data=json_set(data,'$.content','<p>Hello</p>') WHERE id='a'");
  vault.read = originalRead;
  reads = 0;
  vault.read = async p => { const value = await originalRead(p); if (p === file && ++reads === 2) { notes.set(p, 'racing vault edit'); return 'racing vault edit'; } return value; };
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
  write = createGuardedWrite(async () => {}, (database, script) => runSql(database, script.replace("FROM outbox WHERE", "FROM (SELECT 'complete' status, 'a' entity_id, NULL temp_ids, NULL url, NULL body) WHERE")));
  assert.ok((await run()).some(r => r.status === 'failed'));
  assert.equal(sql("SELECT json_extract(data,'$.content') FROM files WHERE id='a';").trim(), '<p>Vault edit</p>');
  assert.equal(notes.get(file), saved.replace('Vault edit', 'Second edit'));
  assert.equal(sql("SELECT json_group_array(json_object('id',id,'data',body)) FROM outbox;"), before);
  write = createGuardedWrite(async () => {});
  assert.ok((await run({ save: async () => { throw Error('save failed'); } })).some(r => r.status === 'failed'));
  assert.equal(state.scopes[JSON.stringify([db, dir, 'Target'])]['file:a'].baseline, beforeBaseline);
  assert.equal(sql("SELECT json_extract(data,'$.content') FROM files WHERE id='a';").trim(), '<p>Second edit</p>');
  assert.match(notes.get(file), /Second edit/);
  assert.ok((await run()).some(r => r.status === 'recovered'));
  assert.equal(state.scopes[JSON.stringify([db, dir, 'Target'])]['file:a'].studioContent, '<p>Second edit</p>');

  // Studio committed but the vault changed before its metadata could be updated.
  const savedSecond = notes.get(file);
  notes.set(file, savedSecond.replace('Second edit', 'Third edit'));
  const compare = vault.compareAndWrite;
  vault.compareAndWrite = async () => false;
  assert.ok((await run()).some(r => r.status === 'failed'));
  assert.equal(sql("SELECT json_extract(data,'$.content') FROM files WHERE id='a';").trim(), '<p>Third edit</p>');
  vault.compareAndWrite = compare;
  assert.ok((await run()).some(r => r.status === 'recovered'));
  assert.match(notes.get(file), /Third edit/);

  // A divergent vault edit after the partial write must never be adopted.
  const savedThird = notes.get(file);
  notes.set(file, savedThird.replace('Third edit', 'Fourth edit'));
  vault.compareAndWrite = async (p, a, b) => { notes.set(p, 'independent vault edit'); return false; };
  assert.ok((await run()).some(r => r.status === 'failed'));
  vault.compareAndWrite = compare;
  assert.ok((await run()).some(r => r.status === 'changed'));
  assert.equal(notes.get(file), 'independent vault edit');
  assert.equal(state.scopes[JSON.stringify([db, dir, 'Target'])]['file:a'].studioContent, '<p>Third edit</p>');
});

test('compatibility fails closed for unsupported environments', async () => {
  const good = { platform: 'linux', realpath: async p => p, access: async () => {}, readFile: async () => Buffer.alloc(0),
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
  for (const resolved of ['/home/synthetic/.config/studio-desktop/byokwa/db.sqlite', '/xdg/studio-desktop/byokwa/db.sqlite']) {
    await assert.rejects(compatible('/fixture/link.sqlite', 'synthetic', {
      ...good, realpath: async () => resolved,
      access: async () => assert.fail('live path must be refused before checking the disposable marker'),
      readFile: async () => assert.fail('live path must be refused before reading any file')
    }), /Live Studio library refused/);
  }
});

test('transaction refuses incompatible synthetic libraries without changing rows', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-compat-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const schema = await fs.readFile(path.join(__dirname, '../experiments/studio_writeback/evidence/schema.sql'), 'utf8');
  const rawData = JSON.stringify({ id: 'a', name: 'File', content: '<p>Original</p>' });
  const row = { id: 'a', project_id: 'p', folder_id: null, rawData, data: JSON.parse(rawData) };
  const cases = [
    ['missing marker', "DELETE FROM metadata WHERE key='schema_version'"],
    ...['2', '0', '', '3abc', '4', '3.0', ' 3'].map(value => [`marker ${JSON.stringify(value)}`, `UPDATE metadata SET value='${value}' WHERE key='schema_version'`]),
    ['null marker', "UPDATE metadata SET value=NULL WHERE key='schema_version'"],
    ['missing launch', "DELETE FROM metadata WHERE key='telemetry.lastVersion'"],
    ['other launch', "UPDATE metadata SET value='1.1.2' WHERE key='telemetry.lastVersion'"],
    ['missing owner', "DELETE FROM metadata WHERE key='currentUserId'"],
    ['account owner', "UPDATE metadata SET value='account' WHERE key='currentUserId'"],
    ['synced mode', "INSERT INTO metadata VALUES('mode','synced')"],
    ['unknown mode', "INSERT INTO metadata VALUES('mode',NULL)"],
    ['auth row', "INSERT INTO metadata VALUES('authToken',NULL)"],
    ['user version', 'PRAGMA user_version=1'],
    ['application id', 'PRAGMA application_id=1'],
    ['extra table', 'CREATE TABLE unexpected(x)'],
    ['evading trigger', 'CREATE TRIGGER sqliteXtrigger AFTER UPDATE ON files BEGIN SELECT 1; END'],
  ];
  for (const [name, mutation] of cases) await t.test(name, async () => {
    const db = path.join(dir, `${cases.findIndex(c => c[0] === name)}.sqlite`);
    const sql = statement => execFileSync('sqlite3', [db, statement], { encoding: 'utf8' });
    sql(`PRAGMA journal_mode=WAL; ${schema}
      INSERT INTO metadata VALUES('schema_version','3'),('telemetry.lastVersion','1.1.3'),('currentUserId','local');
      INSERT INTO projects(id,data,mirrored_at) VALUES('p','{}',0);
      INSERT INTO files(id,project_id,type,data,mirrored_at) VALUES('a','p','text','${rawData}',0);
      ${mutation};`);
    const snapshot = () => sql("SELECT json_group_array(json_array(id,project_id,data,mirrored_at)) FROM files; SELECT json_group_array(json_array(id,data,mirrored_at)) FROM projects; SELECT count(*) FROM local_versions; SELECT count(*) FROM outbox;");
    const before = snapshot();
    await assert.rejects(createGuardedWrite(async () => {})(db, row, '<p>Changed</p>', 'synthetic'));
    assert.equal(snapshot(), before);
  });
});

test('compatibility is checked after acquiring the transaction', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-transaction-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const db = path.join(dir, 'db.sqlite');
  const schema = await fs.readFile(path.join(__dirname, '../experiments/studio_writeback/evidence/schema.sql'), 'utf8');
  const sql = statement => execFileSync('sqlite3', [db, statement], { encoding: 'utf8' });
  const rawData = '{"id":"a","name":"File","content":"<p>Original</p>"}';
  sql(`PRAGMA journal_mode=WAL; ${schema}
    INSERT INTO metadata VALUES('schema_version','3'),('telemetry.lastVersion','1.1.3'),('currentUserId','local'),('mode','local');
    INSERT INTO projects(id,data,mirrored_at) VALUES('p','{}',0);
    INSERT INTO files(id,project_id,type,data,mirrored_at) VALUES('a','p','text','${rawData}',0);`);
  const row = { id: 'a', project_id: 'p', folder_id: null, rawData, data: JSON.parse(rawData) };
  const write = createGuardedWrite(async () => {}, (database, script) => runSql(database, script.replace('BEGIN EXCLUSIVE;', "BEGIN EXCLUSIVE; UPDATE metadata SET value='2' WHERE key='schema_version';")));
  await assert.rejects(write(db, row, '<p>Changed</p>', 'synthetic'));
  assert.equal(sql("SELECT value FROM metadata WHERE key='schema_version'; SELECT data FROM files WHERE id='a'; SELECT count(*) FROM local_versions;").trim(), `3\n${rawData}\n0`);
  await createGuardedWrite(async () => {})(db, row, '<p>Changed</p>', 'synthetic');
  assert.equal(sql("SELECT json_extract(data,'$.content') FROM files WHERE id='a'").trim(), '<p>Changed</p>');
});

// Every database is generated from the checked-in synthetic schema. Outbox
// references are SELECT-only injected relations: these tests never write outbox.
async function fixture(t, data = { id: 'file-a', name: 'File', content: '<p>Original</p>' }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-record-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const db = path.join(dir, 'db.sqlite');
  const schema = await fs.readFile(path.join(__dirname, '../experiments/studio_writeback/evidence/schema.sql'), 'utf8');
  const rawData = typeof data === 'string' ? data : JSON.stringify(data);
  const q = value => `CAST(X'${Buffer.from(value).toString('hex')}' AS TEXT)`;
  const sql = statement => execFileSync('sqlite3', [db, statement], { encoding: 'utf8' });
  sql(`PRAGMA journal_mode=WAL; ${schema}
    INSERT INTO metadata VALUES('schema_version','3'),('telemetry.lastVersion','1.1.3'),('currentUserId','local');
    INSERT INTO projects(id,data,mirrored_at) VALUES('p','{}',0);
    INSERT INTO files(id,project_id,type,data,mirrored_at) VALUES('file-a','p','text',${q(rawData)},0);`);
  const row = { id: 'file-a', project_id: 'p', folder_id: null, rawData, data: JSON.parse(rawData) };
  const snapshot = () => sql("SELECT json_group_array(json_array(id,data,mirrored_at)) FROM files; SELECT json_group_array(json_array(id,data,mirrored_at)) FROM projects; SELECT json_group_array(json_array(id,data,mirrored_at)) FROM folders; SELECT count(*) FROM local_versions; SELECT count(*) FROM outbox;");
  return { db, row, sql, snapshot };
}

test('outbox references in every status refuse without any outbox writes', async t => {
  const f = await fixture(t);
  const before = f.snapshot();
  for (const status of ['pending', 'failed', 'complete', 'completed', 'inflight', 'cancelled', 'future-status']) {
    for (const field of ['entity_id', 'temp_ids', 'url', 'body']) {
      const relation = `(SELECT '${status}' status, ${['entity_id', 'temp_ids', 'url', 'body'].map(key => `${key === field ? "'file-a'" : 'NULL'} ${key}`).join(', ')})`;
      const write = createGuardedWrite(async () => {}, (db, script) => runSql(db, script.replace('FROM outbox WHERE', `FROM ${relation} WHERE`)));
      await assert.rejects(write(f.db, f.row, '<p>Edited</p>'), /Outbox references this file regardless of status.*Preserve the vault edit/);
      assert.equal(f.snapshot(), before);
    }
  }
  for (const field of ['body', 'temp_ids']) {
    const escaped = JSON.stringify('file-a').replace('f', '\\u0066');
    const q = `CAST(X'${Buffer.from(escaped).toString('hex')}' AS TEXT)`;
    const relation = `(SELECT NULL entity_id, NULL url, ${field === 'body' ? q : 'NULL'} body, ${field === 'temp_ids' ? q : 'NULL'} temp_ids)`;
    const write = createGuardedWrite(async () => {}, (db, script) => runSql(db, script.replace('FROM outbox WHERE', `FROM ${relation} WHERE`)));
    await assert.rejects(write(f.db, f.row, '<p>Edited</p>'), /Outbox references/);
    assert.equal(f.snapshot(), before);
  }
  const encodedUrl = createGuardedWrite(async () => {}, (db, script) => runSql(db, script.replace('FROM outbox WHERE', "FROM (SELECT NULL entity_id, NULL temp_ids, '/files/%66ile-a' url, NULL body) WHERE")));
  await assert.rejects(encodedUrl(f.db, f.row, '<p>Edited</p>'), /encoded URL prevents ruling out a reference/);
  assert.equal(f.snapshot(), before);
  const unrelated = createGuardedWrite(async () => {}, (db, script) => runSql(db, script.replace('FROM outbox WHERE', "FROM (SELECT 'file-z' entity_id, NULL temp_ids, NULL url, NULL body) WHERE")));
  await unrelated(f.db, f.row, '<p>Edited</p>');
});

test('unsafe record and ancestor states roll back with actionable refusal', async t => {
  const folder = "INSERT INTO folders(id,project_id,data,mirrored_at) VALUES('f','p','{}',0); UPDATE files SET folder_id='f'";
  const cases = [
    ['comment', "INSERT INTO comments(id,file_id,data,mirrored_at) VALUES('c','file-a','{}',0)", /Comments or device links/],
    ['device file', "INSERT INTO device_files(card_id,file_key,project_key,studio_file_id,imported_at) VALUES('card','k','p','file-a',0)", /Comments or device links/],
    ['device project', "INSERT INTO device_projects(card_id,project_key,studio_project_id) VALUES('card','k','p')", /Comments or device links/],
    ['JSON device link', "UPDATE files SET data=json_set(data,'$.autoLinkedDeviceIds',json('[\"card\"]'))", /Comments or device links/],
    ['JSON attachment', "UPDATE files SET data=json_set(data,'$.file','external')", /Comments or device links/],
    ['foreign file', "UPDATE files SET user_id='other'", /Foreign ownership/],
    ['foreign JSON file', "UPDATE files SET data=json_set(data,'$.user','other')", /Foreign ownership/],
    ['trashed file', 'UPDATE files SET is_trashed=1', /Record changed/],
    ['trashed JSON file', "UPDATE files SET data=json_set(data,'$.isTrashed',json('true'))", /Foreign ownership or trashed/],
    ['foreign project', "UPDATE projects SET user_id='other'", /ancestor/],
    ['foreign JSON project', "UPDATE projects SET data=json_set(data,'$.userId','other')", /ancestor/],
    ['ambiguous project JSON', `UPDATE projects SET data='{"isTrashed":false,"isTrashed":true}'`, /ancestor/],
    ['trashed project', "UPDATE projects SET data=json_set(data,'$.isTrashed',json('true'))", /ancestor/],
    ['missing project', 'DELETE FROM projects', /ancestor/],
    ['missing folder', "UPDATE files SET folder_id='missing'", /ancestor/],
    ['foreign folder', `${folder}; UPDATE folders SET user_id='other'`, /ancestor/],
    ['cross-project folder', `${folder}; UPDATE folders SET project_id='other'`, /ancestor/],
    ['trashed folder', `${folder}; UPDATE folders SET is_trashed=1`, /ancestor/],
    ['ambiguous folder JSON', `${folder}; UPDATE folders SET data='{"isTrashed":false,"isTrashed":true}'`, /ancestor/],
    ['trashed JSON folder', `${folder}; UPDATE folders SET data=json_set(data,'$.isTrashed',json('true'))`, /ancestor/],
    ['missing parent', `${folder}; UPDATE folders SET parent_folder_id='missing'`, /ancestor/],
    ['cyclic parent', `${folder}; UPDATE folders SET parent_folder_id='f'`, /ancestor/],
    ['trashed grandparent', `${folder}; INSERT INTO folders(id,project_id,data,is_trashed,mirrored_at) VALUES('g','p','{}',1,0); UPDATE folders SET parent_folder_id='g' WHERE id='f'`, /ancestor/],
    ['JSON identity mismatch', "UPDATE files SET data=json_set(data,'$.id','other')", /JSON identity/],
  ];
  for (const [name, mutation, expected] of cases) await t.test(name, async t => {
    const f = await fixture(t);
    f.sql(mutation);
    // Supply the actual post-mutation snapshot so the state guard, rather than
    // the compare-and-swap guard, must detect the unsafe state.
    const values = JSON.parse(execFileSync('sqlite3', ['-json', f.db, "SELECT data,folder_id FROM files WHERE id='file-a'"], { encoding: 'utf8' }))[0];
    f.row.rawData = values.data; f.row.data = JSON.parse(values.data); f.row.folder_id = values.folder_id;
    const before = f.snapshot();
    await assert.rejects(createGuardedWrite(async () => {})(f.db, f.row, '<p>Edited</p>'), expected);
    assert.equal(f.snapshot(), before);
  });
});

test('unsafe JSON transformations refuse before executing a write', async () => {
  for (const rawData of [
    '{"content":"<p>Original</p>","n":9007199254740993}',
    '{"content":"<p>Original</p>","n":9007199254740992}',
    '{"content":"<p>Original</p>","n":1e400}',
    '{"content":"<p>Original</p>","n":-0}',
    '{"content":"<p>Original</p>","content":"<p>Duplicate</p>"}',
    '{"content":"<p>Original</p>","nested":{"x":1,"x":2}}',
    '[]', 'null'
  ]) {
    await assert.rejects(createGuardedWrite(async () => {}, async () => assert.fail('unsafe JSON reached SQL'))('synthetic', { rawData, data: JSON.parse(rawData) }, '<p>Edited</p>'), /Unsafe record JSON/);
  }
});

test('normalized paragraph writes preserve source form, unknown JSON and pre-image', async t => {
  const original = { id: 'file-a', name: 'File', content: '<p class="editor-paragraph">Original</p>', unknown: { list: [1, true, null, 'keep this'] } };
  const f = await fixture(t, original);
  await createGuardedWrite(async () => {})(f.db, f.row, '<p>Edited</p>');
  const actual = JSON.parse(f.sql("SELECT data FROM files WHERE id='file-a'"));
  assert.deepEqual(actual.unknown, original.unknown);
  assert.equal(actual.content, '<p class="editor-paragraph">Edited</p>');
  assert.equal(JSON.parse(f.sql("SELECT content FROM local_versions WHERE file_id='file-a'")), original.content);
  assert.equal(f.sql('SELECT count(*) FROM outbox').trim(), '0');
});
