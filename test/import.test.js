const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { sync } = require('../src/import');

test('sync reads WAL, preserves notes and identities, and reports exceptional records', async t => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-test-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const db = path.join(tmp, 'synthetic.sqlite');
  const script = `import sqlite3,sys,json
c=sqlite3.connect(sys.argv[1]); c.execute('pragma journal_mode=wal'); c.execute('pragma wal_autocheckpoint=0')
c.executescript('create table projects(id text,data text); create table folders(id text,parent_folder_id text,data text); create table files(id text,project_id text,folder_id text,type text,is_trashed integer,data text); create table manuscript_files(id text,project_id text,folder_id text,is_trashed integer,data text); create table outbox(id text);')
c.execute('insert into projects values (?,?)',('p',json.dumps({'name':'Project'})))
c.execute('insert into folders values (?,?,?)',('f',None,json.dumps({'name':'Folder'})))
for row in [('a','Same','<p>Hello</p>','text',0),('b','Same','<p>Other</p>','text',0),('c','Grid','{}','grid',0),('d','Trash','<p>x</p>','text',1),('e','Image','<p><img src="x">caption</p>','text',0)]:
 c.execute('insert into files values (?,?,?,?,?,?)',(row[0],'p','f',row[3],row[4],json.dumps({'name':row[1],'content':row[2]})))
c.commit(); print('ready',flush=True); sys.stdin.readline(); c.close()`;
  const python = spawn('python3', ['-u', '-c', script, db], { stdio: ['pipe', 'pipe', 'inherit'] });
  t.after(() => python.stdin.end('done\n'));
  await once(python.stdout, 'data');
  assert.ok((await fs.stat(db + '-wal')).size > 0);
  const notes = new Map([['Target/Project/Folder/Same.md', 'unrelated']]);
  const vault = { exists: async p => notes.has(p), read: async p => notes.get(p) ?? null, create: async (p, c) => { assert.ok(!notes.has(p)); notes.set(p, c); } };
  const state = { version: 1, scopes: {} }; let saves = 0;
  const run = () => sync({ database: db, folder: 'Target', vault, state, save: async () => { saves++; } });
  const report = await run();
  assert.equal(report.filter(r => r.status === 'imported').length, 3);
  assert.ok(report.some(r => r.status === 'collision'));
  assert.ok(report.some(r => r.status === 'unsupported' && r.id === 'file:c'));
  assert.ok(report.some(r => r.status === 'trashed'));
  assert.ok(report.some(r => r.status === 'lossy' && r.detail.includes('img')));
  assert.equal(notes.get('Target/Project/Folder/Same.md'), 'unrelated');
  const a = report.find(r => r.id === 'file:a' && r.status === 'imported').path;
  assert.match(notes.get(a), /byok-id: "a"/);
  const before = saves; const again = await run();
  assert.equal(saves, before); assert.equal(again.filter(r => r.status === 'unchanged').length, 3);
  notes.set(a, 'my edit'); assert.ok((await run()).some(r => r.id === 'file:a' && r.status === 'changed')); assert.equal(notes.get(a), 'my edit');
  assert.equal(execFileSync('sqlite3', [db, 'select count(*) from outbox'], { encoding: 'utf8' }).trim(), '0');
});

test('invalid destination fails before writing', async () => {
  await assert.rejects(sync({ database: '/missing', folder: '../escape', vault: {}, state: {}, save() {} }), /Invalid destination/);
});
