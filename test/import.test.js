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
  const vault = { safeToMutate: async () => true, exists: async p => notes.has(p), read: async p => notes.get(p) ?? null, create: async (p, c) => { assert.ok(!notes.has(p)); notes.set(p, c); }, compareAndWrite: async (p, expected, content) => { if (notes.get(p) !== expected) return false; notes.set(p, content); return true; } };
  const state = { version: 1, scopes: {} }; let saves = 0;
  const run = () => sync({ database: db, folder: 'Target', vault, vaultId: tmp, state, save: async () => { saves++; } });
  // Failure at the first reservation save must remain restartable, including peers.
  const crashNotes = new Map(); let crashDurable = { version: 1, scopes: {} }, crashSaves = 0;
  const crashVault = { safeToMutate: async () => true, exists: async p => crashNotes.has(p), read: async p => crashNotes.get(p) ?? null,
    create: async (p, c) => { if (crashNotes.has(p)) throw Error('exists'); crashNotes.set(p, c); },
    compareAndWrite: async (p, a, b) => { if (crashNotes.get(p) !== a) return false; crashNotes.set(p, b); return true; } };
  const crashRun = (state, save) => sync({ database: db, folder: 'Crash', vault: crashVault, vaultId: tmp, state, save });
  const failedReservation = await crashRun(structuredClone(crashDurable), async value => { if (++crashSaves === 2) throw Error('reservation failure'); crashDurable = structuredClone(value); });
  assert.ok(failedReservation.some(r => r.id === 'file:a' && r.status === 'failed'));
  const restarted = await crashRun(structuredClone(crashDurable), async value => { crashDurable = structuredClone(value); });
  assert.ok(restarted.some(r => r.id === 'file:a' && (r.status === 'imported' || r.status === 'recovered')));
  // A failed save after first creation leaves a durable reservation, not an orphan.
  const isolated = new Map([['Recovery/Project/Folder/Same.md', 'unrelated recovery note']]);
  const recoveryVault = { safeToMutate: async () => true, exists: async p => isolated.has(p), read: async p => isolated.get(p) ?? null,
    create: async (p, c) => { if (isolated.has(p)) throw Error('exists'); isolated.set(p, c); },
    compareAndWrite: async (p, a, b) => { if (isolated.get(p) !== a) return false; isolated.set(p, b); return true; } };
  let durable = { version: 1, scopes: {} }, saveCount = 0;
  const recoveryRun = (current, save) => sync({ database: db, folder: 'Recovery', vault: recoveryVault, vaultId: tmp, state: current, save });
  const firstState = structuredClone(durable);
  const failedFirst = await recoveryRun(firstState, async value => { if (++saveCount === 3) throw Error('synthetic save failure'); durable = structuredClone(value); });
  assert.ok(failedFirst.some(r => r.status === 'failed' && /save failure/.test(r.detail)));
  const reservation = durable.scopes[JSON.stringify([db, tmp, 'Recovery'])]['file:a'];
  assert.equal(reservation.pending, true);
  const recoveryState = structuredClone(durable);
  const retried = await recoveryRun(recoveryState, async value => { durable = structuredClone(value); });
  assert.ok(retried.some(r => r.id === 'file:a' && r.status === 'changed' && /ownership/.test(r.detail)));
  assert.equal(isolated.get(reservation.path), reservation.baseline);
  assert.equal(isolated.get('Recovery/Project/Folder/Same.md'), 'unrelated recovery note');
  assert.equal([...isolated.keys()].filter(p => p.includes('Same (2)')).length, 1);
  await assert.rejects(recoveryRun({ version: 1, scopes: {} }, async () => {}), /state missing/);
  const corrupt = structuredClone(durable); corrupt.scopes[JSON.stringify([db, tmp, 'Recovery'])]['file:a'] = null;
  await assert.rejects(recoveryRun(corrupt, async () => {}), /Invalid record baseline/);
  const snapshot = new Map(isolated);
  recoveryVault.safeToMutate = async () => false;
  const priorRead = recoveryVault.read;
  recoveryVault.read = async p => p === reservation.path ? 'unsaved editor change' : priorRead(p);
  assert.ok((await recoveryRun(structuredClone(durable), async () => {})).some(r => r.id === 'file:a' && r.status === 'changed'));
  assert.deepEqual(isolated, snapshot);
  recoveryVault.safeToMutate = async () => true; recoveryVault.read = priorRead;
  // Moving the ambiguous note preserves it and makes the reservation recoverable.
  const moved = reservation.path + '.preserved';
  isolated.set(moved, isolated.get(reservation.path)); isolated.delete(reservation.path);
  const manual = await recoveryRun(structuredClone(durable), async value => { durable = structuredClone(value); });
  assert.ok(manual.some(r => r.id === 'file:a' && r.status === 'recovered'));
  assert.equal(isolated.get(moved), reservation.baseline);
  assert.equal(isolated.get(reservation.path), reservation.baseline);
  // A legacy marker refuses a new reservation without changing durable state.
  const legacyMarkerPath = [...isolated.keys()].find(p => p.includes('.byok-sync-'));
  const markerData = JSON.parse(isolated.get(legacyMarkerPath)); delete markerData.ids;
  isolated.set(legacyMarkerPath, JSON.stringify(markerData));
  const legacyState = structuredClone(durable);
  delete legacyState.scopes[JSON.stringify([db, tmp, 'Recovery'])]['file:a'];
  const legacyBefore = structuredClone(legacyState); let legacySaves = 0;
  const legacyReport = await recoveryRun(legacyState, async () => { legacySaves++; });
  assert.ok(legacyReport.some(r => r.id === 'file:a' && /Legacy import marker/.test(r.detail || '')));
  assert.deepEqual(legacyState, legacyBefore); assert.equal(legacySaves, 0);
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
  const update = text => execFileSync('python3', ['-c', `import sqlite3,json,sys
c=sqlite3.connect(sys.argv[1]); d=json.loads(c.execute("select data from files where id='a'").fetchone()[0]); d['content']=sys.argv[2]; c.execute("update files set data=? where id='a'",(json.dumps(d),)); c.commit()`, db, text]);
  update('<p>Studio edit</p>');
  assert.ok((await run()).some(r => r.id === 'file:a' && r.status === 'updated'));
  assert.match(notes.get(a), /Studio edit/);
  const baseline = state.scopes[JSON.stringify([db, tmp, 'Target'])]['file:a'].baseline;
  assert.equal(baseline, notes.get(a));
  const databaseSnapshot = () => execFileSync('sqlite3', ['-readonly', db, '.dump'], { encoding: 'utf8' });
  notes.set(a, baseline.replace('Studio edit', 'Vault edit'));
  // Obsolete opt-ins cannot authorize a Studio write, including when both sides change.
  update('<p>Concurrent Studio edit</p>');
  const sourceBefore = databaseSnapshot(), vaultBefore = notes.get(a);
  const oldOptionsReport = await sync({ database: db, folder: 'Target', vault, vaultId: tmp, state, studioAsar: 'synthetic', localExperiment: true, writebackRiskAccepted: true, save: async () => {} });
  assert.ok(oldOptionsReport.some(r => r.id === 'file:a' && r.status === 'changed'));
  assert.equal(databaseSnapshot(), sourceBefore);
  assert.equal(notes.get(a), vaultBefore);
  update('<p>Studio edit</p>');
  assert.ok((await run()).some(r => r.id === 'file:a' && r.status === 'changed' && r.detail.includes('Vault edit preserved')));
  assert.equal(state.scopes[JSON.stringify([db, tmp, 'Target'])]['file:a'].baseline, baseline);
  notes.set(a, 'my edit');
  assert.ok((await run()).some(r => r.id === 'file:a' && r.status === 'changed'));
  assert.equal(notes.get(a), 'my edit');
  assert.equal(state.scopes[JSON.stringify([db, tmp, 'Target'])]['file:a'].baseline, baseline);
  notes.set(a, baseline); update('<p>Another Studio edit</p>');
  const originalWrite = vault.compareAndWrite;
  vault.compareAndWrite = async (p, expected, content) => { if (p === a) notes.set(p, 'racing edit'); return originalWrite(p, expected, content); };
  assert.ok((await run()).some(r => r.id === 'file:a' && r.status === 'changed-during-sync'));
  assert.equal(notes.get(a), 'racing edit');
  assert.equal(state.scopes[JSON.stringify([db, tmp, 'Target'])]['file:a'].baseline, baseline);
  vault.compareAndWrite = originalWrite;
  notes.set(a, baseline);
  const originalRead = vault.read;
  let raced = false;
  vault.read = async p => { const value = await originalRead(p); if (p === a && !raced) { raced = true; update('<p>Racing Studio edit</p>'); } return value; };
  assert.ok((await run()).some(r => r.id === 'file:a' && r.status === 'changed-during-sync'));
  assert.equal(notes.get(a), baseline);
  vault.read = originalRead;
  const failed = await sync({ database: db, folder: 'Target', vault, vaultId: tmp, state, save: async () => { throw Error('save failed'); } });
  assert.ok(failed.some(r => r.id === 'file:a' && r.status === 'failed'));
  assert.equal(state.scopes[JSON.stringify([db, tmp, 'Target'])]['file:a'].baseline, baseline);
  // Recovery rechecks the vault and refuses a racing edit.
  const recoveryWrite = vault.compareAndWrite;
  vault.compareAndWrite = async (p, expected, next) => { if (p === a) notes.set(p, 'recovery race'); return recoveryWrite(p, expected, next); };
  assert.ok((await run()).some(r => r.id === 'file:a' && r.status === 'changed-during-sync'));
  assert.equal(notes.get(a), 'recovery race');
  assert.equal(state.scopes[JSON.stringify([db, tmp, 'Target'])]['file:a'].baseline, baseline);
  vault.compareAndWrite = recoveryWrite;
  notes.set(a, baseline.replace('Studio edit', 'Racing Studio edit'));
  assert.ok((await run()).some(r => r.id === 'file:a' && r.status === 'recovered'));
  assert.equal(state.scopes[JSON.stringify([db, tmp, 'Target'])]['file:a'].baseline, notes.get(a));
  const entry = state.scopes[JSON.stringify([db, tmp, 'Target'])]['file:a'];
  assert.equal(entry.studioContent, '<p>Racing Studio edit</p>');
  const studioBaseline = entry.studioContent;
  delete entry.studioContent;
  assert.ok((await run()).some(r => r.id === 'file:a' && r.status === 'changed' && /baseline missing/.test(r.detail)));
  assert.equal(entry.studioContent, undefined);
  entry.studioContent = null;
  await assert.rejects(run(), /Invalid record baseline/);
  entry.studioContent = studioBaseline;
  const scopeKey = JSON.stringify([db, tmp, 'Target']);
  state.scopes[scopeKey]['file:a'] = null;
  await assert.rejects(run(), /Invalid record baseline/);
  state.scopes[scopeKey]['file:a'] = entry;
  const scope = state.scopes[scopeKey];
  state.scopes[scopeKey] = null;
  await assert.rejects(run(), /Invalid import scope/);
  state.scopes[scopeKey] = scope;
  // Legacy interrupted writes and conflicts remain paused, even with old opt-ins.
  const protectedNote = notes.get(a), protectedDb = databaseSnapshot();
  entry.recovery = { vault: 'saved vault', studio: 'saved source', intended: 'saved intent' };
  assert.ok((await run()).some(r => r.id === 'file:a' && r.status === 'recovery-required'));
  assert.equal(notes.get(a), protectedNote); assert.equal(databaseSnapshot(), protectedDb);
  delete entry.recovery;
  entry.conflict = { path: 'Target/Project/Folder/Old conflict.md', note: 'snapshot', snapshot: '{}', vaultOriginal: 'original' };
  assert.ok((await run()).some(r => r.id === 'file:a' && r.status === 'conflict'));
  assert.equal(notes.get(a), protectedNote); assert.equal(databaseSnapshot(), protectedDb);
  delete entry.conflict;
  // Missing entries, including pending reservations, must never be remapped.
  const partial = structuredClone(state); delete partial.scopes[scopeKey]['file:a'];
  const notesBefore = new Map(notes);
  await assert.rejects(sync({ database: db, folder: 'Target', vault, vaultId: tmp, state: partial, save: async () => {} }), /state missing records/);
  assert.deepEqual(notes, notesBefore);
  for (const badPath of ['../outside.md', '/outside.md', 'Target/../outside.md', 'Other/note.md', 'Target\\outside.md']) {
    const bad = structuredClone(state); bad.scopes[scopeKey]['file:a'].path = badPath;
    await assert.rejects(sync({ database: db, folder: 'Target', vault, vaultId: tmp, state: bad, save: async () => {} }), /record path/);
    assert.deepEqual(notes, notesBefore);
  }
  // A reserved but not yet created name must remain unavailable to its peer.
  const pendingState = { version: 1, scopes: {} }, pendingNotes = new Map();
  let failCreate = true;
  const pendingVault = { safeToMutate: async () => true, exists: async p => pendingNotes.has(p), read: async p => pendingNotes.get(p) ?? null,
    create: async (p,c) => { if (p.endsWith('/Same.md') && failCreate) { failCreate = false; throw Error('creation failed'); } pendingNotes.set(p,c); },
    compareAndWrite: async (p,a,b) => { if (pendingNotes.get(p) !== a) return false; pendingNotes.set(p,b); return true; } };
  const pendingRun = () => sync({ database: db, folder: 'Pending', vault: pendingVault, vaultId: tmp, state: pendingState, save: async () => {} });
  const pendingReport = await pendingRun();
  assert.ok(pendingReport.some(r => r.id === 'file:a' && r.status === 'failed'));
  assert.ok(pendingReport.some(r => r.id === 'file:b' && r.status === 'imported' && r.path.endsWith('Same (2).md')));
  assert.ok((await pendingRun()).some(r => r.id === 'file:a' && r.status === 'recovered'));
  assert.match(pendingNotes.get('Pending/Project/Folder/Same.md'), /byok-id: "a"/);
  assert.match(pendingNotes.get('Pending/Project/Folder/Same (2).md'), /byok-id: "b"/);
  // Re-reading a source record larger than execFile's default buffer succeeds.
  execFileSync('python3', ['-c', `import sqlite3,json,sys
c=sqlite3.connect(sys.argv[1]); d=json.loads(c.execute("select data from files where id='a'").fetchone()[0]); d['content']='<p>'+'x'*1100000+'</p>'; c.execute("update files set data=? where id='a'",(json.dumps(d),)); c.commit()`, db]);
  const largeReport = await run();
  assert.ok(largeReport.some(r => r.id === 'file:a' && r.status === 'updated'), JSON.stringify(largeReport));
  const otherVault = new Map();
  const vault2 = { safeToMutate: async () => true, exists: async p => otherVault.has(p), read: async p => otherVault.get(p) ?? null, create: async (p, c) => otherVault.set(p, c), compareAndWrite: async (p, a, b) => { if (otherVault.get(p) !== a) return false; otherVault.set(p, b); return true; } };
  assert.ok((await sync({ database: db, folder: 'Target', vault: vault2, vaultId: tmp + '-other', state, save: async () => {} })).some(r => r.id === 'file:a' && r.status === 'imported'));
  assert.equal(execFileSync('sqlite3', [db, 'select count(*) from outbox'], { encoding: 'utf8' }).trim(), '0');
});

test('invalid destination fails before writing', async () => {
  await assert.rejects(sync({ database: '/missing', folder: '../escape', vault: {}, state: {}, save() {} }), /Invalid destination/);
});

test('names remain safe and stable across restart; malformed records stay isolated', async t => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-names-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const db = path.join(tmp, 'synthetic.sqlite');
  execFileSync('python3', ['-c', `import sqlite3,json,sys
c=sqlite3.connect(sys.argv[1]); c.executescript('create table projects(id text,data text); create table folders(id text,parent_folder_id text,data text); create table files(id text,project_id text,folder_id text,type text,is_trashed integer,data text); create table manuscript_files(id text,project_id text,folder_id text,is_trashed integer,data text);')
c.execute('insert into projects values (?,?)',('p',json.dumps({'name':'.obsidian'})))
c.execute('insert into folders values (?,?,?)',('f',None,json.dumps({'name':'.hidden'})))
for i,name in enumerate(['  Title .  ','.secret','é','e\\u0301','x'*400,'x'*400]): c.execute('insert into files values (?,?,?,?,?,?)',(str(i),'p','f','text',0,json.dumps({'name':name,'content':'<p>text</p>'})))
c.execute('insert into files values (?,?,?,?,?,?)',('broken','p','f','text',0,'{')); c.execute('insert into files values (?,?,?,?,?,?)',('trash','p','f','text',1,'{')); c.commit()`, db]);
  const notes = new Map(), state = { version: 1, scopes: {} }; let durable;
  let failMarker = true;
  const vault = { safeToMutate: async () => true, exists: async p => notes.has(p), read: async p => notes.get(p) ?? null,
    create: async (p,c) => { if (notes.has(p)) throw Error('exists'); notes.set(p,c); },
    compareAndWrite: async (p,a,b) => { if (p.includes('.byok-sync-') && failMarker) { failMarker = false; return false; } if (notes.get(p) !== a) return false; notes.set(p,b); return true; } };
  const run = state => sync({ database: db, folder: 'Target', vault, vaultId: tmp, state, save: async value => { durable = structuredClone(value); } });
  const first = await run(state);
  assert.ok(first.some(r => r.id === 'file:0' && r.status === 'failed'));
  assert.ok(first.some(r => r.id === 'file:broken' && r.status === 'failed' && /Malformed/.test(r.detail)));
  assert.ok(first.some(r => r.id === 'file:trash' && r.status === 'trashed'));
  const second = await run(structuredClone(durable));
  assert.ok(second.some(r => r.id === 'file:0' && r.status === 'recovered'));
  const entries = Object.values(durable.scopes[JSON.stringify([db, tmp, 'Target'])]);
  assert.equal(entries.length, 6);
  assert.equal(new Set(entries.map(e => e.path.normalize('NFC').toLowerCase())).size, 6);
  for (const e of entries) {
    assert.ok(e.path.startsWith('Target/_.obsidian/_.hidden/'));
    assert.ok(e.path.split('/').every(part => Buffer.byteLength(part) <= 180));
  }
  assert.ok(entries.some(e => e.path.endsWith('/Title.md')));
  assert.ok(entries.some(e => e.path.endsWith('/_.secret.md')));
  assert.ok((await run(structuredClone(durable))).some(r => r.status === 'unchanged'));
});

test('sync boundaries preserve ownership, hierarchy and current pending source', async t => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-boundary-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const db = path.join(tmp, 'synthetic.sqlite');
  const sql = code => execFileSync('python3', ['-c', `import sqlite3,json,sys\nc=sqlite3.connect(sys.argv[1])\n${code}\nc.commit()`, db]);
  sql(`c.executescript("create table projects(id text,data text); create table folders(id text,parent_folder_id text,data text); create table files(id text,project_id text,folder_id text,type text,is_trashed integer,data text); create table manuscript_files(id text,project_id text,folder_id text,is_trashed integer,data text);")
c.execute('insert into projects values (?,?)',('p',json.dumps({'name':'Project'})))
c.execute('insert into folders values (?,?,?)',('f',None,json.dumps({'name':'Folder'})))
c.execute('insert into files values (?,?,?,?,?,?)',('a','p','f','text',0,json.dumps({'name':'A','content':'<p>old</p>'})))`);
  const notes = new Map(), state = { version: 1, scopes: {} }; let failCreate = false;
  const vault = { safeToMutate: async () => true, exists: async p => notes.has(p), read: async p => notes.get(p) ?? null,
    create: async (p,c) => { if (failCreate && p.endsWith('/Pending.md')) throw Error('failed'); if (notes.has(p)) throw Error('exists'); notes.set(p,c); },
    compareAndWrite: async (p,a,b) => { if (notes.get(p) !== a) return false; notes.set(p,b); return true; } };
  const run = () => sync({ database: db, folder: 'Target', vault, vaultId: tmp, state, save: async () => {} });
  await run();
  const entry = state.scopes[JSON.stringify([db, tmp, 'Target'])]['file:a'];
  sql(`d=json.loads(c.execute("select data from files where id='a'").fetchone()[0]); d['content']='<p>new</p>'; c.execute("update files set data=? where id='a'",(json.dumps(d),))`);
  notes.set(entry.path, entry.baseline.replace('old', 'new'));
  assert.ok((await run()).some(r => r.id === 'file:a' && r.status === 'changed'));
  assert.match(entry.baseline, /old/);
  sql(`c.execute('insert into projects values (?,?)',('q',json.dumps({'name':'Project'})))
c.execute('insert into folders values (?,?,?)',('g',None,json.dumps({'name':'Folder'})))
for ident,project,folder,name in [('b','p','f','B'),('c','p','g','C'),('d','q','f','D'),('e','p','f','Pending')]: c.execute('insert into files values (?,?,?,?,?,?)',(ident,project,folder,'text',0,json.dumps({'name':name,'content':'<p>first</p>'})))`);
  failCreate = true;
  await run();
  const scope = state.scopes[JSON.stringify([db, tmp, 'Target'])];
  assert.equal(scope['file:b'].path, 'Target/Project/Folder/B.md');
  assert.notEqual(scope['file:c'].path.split('/')[2], 'Folder');
  assert.notEqual(scope['file:d'].path.split('/')[1], 'Project');
  assert.equal(scope['file:e'].pending, true);
  sql(`d=json.loads(c.execute("select data from files where id='e'").fetchone()[0]); d['content']='<p>second</p>'; c.execute("update files set data=? where id='e'",(json.dumps(d),))`);
  failCreate = false;
  assert.ok((await run()).some(r => r.id === 'file:e' && r.status === 'recovered'));
  assert.match(notes.get(scope['file:e'].path), /second/);
  assert.equal(scope['file:e'].baseline, notes.get(scope['file:e'].path));
  assert.equal(scope['file:e'].studioContent, '<p>second</p>');
});

test('persisted hierarchy survives same-depth moves and legacy paths reserve names', async t => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-moves-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const db = path.join(tmp, 'source.sqlite');
  const sql = code => execFileSync('python3', ['-c', `import sqlite3,json,sys\nc=sqlite3.connect(sys.argv[1])\n${code}\nc.commit()`, db]);
  sql(`c.executescript("create table projects(id text,data text); create table folders(id text,parent_folder_id text,data text); create table files(id text,project_id text,folder_id text,type text,is_trashed integer,data text); create table manuscript_files(id text,project_id text,folder_id text,is_trashed integer,data text);")
for i,n in [('p','Project'),('q','Other')]: c.execute('insert into projects values (?,?)',(i,json.dumps({'name':n})))
for i,n in [('f','Folder'),('g','Other folder')]: c.execute('insert into folders values (?,?,?)',(i,None,json.dumps({'name':n})))
for i,p,f in [('a','p','f'),('b','q','g')]: c.execute('insert into files values (?,?,?,?,?,?)',(i,p,f,'text',0,json.dumps({'name':i,'content':'<p>text</p>'})))`);
  const notes = new Map(); let durable = { version: 1, scopes: {} };
  const vault = { safeToMutate: async () => true, exists: async p => notes.has(p), read: async p => notes.get(p) ?? null, create: async (p,c) => { if (notes.has(p)) throw Error('exists'); notes.set(p,c); }, compareAndWrite: async (p,a,b) => { if (notes.get(p) !== a) return false; notes.set(p,b); return true; } };
  const run = () => sync({ database: db, folder: 'Target', vault, vaultId: tmp, state: structuredClone(durable), save: async s => { durable = structuredClone(s); } });
  await run();
  const key = JSON.stringify([db, tmp, 'Target']); const old = structuredClone(durable.scopes[key]);
  sql(`c.execute("update files set project_id='q', folder_id='g' where id='a'")
c.execute("update projects set data=? where id='p'",(json.dumps({'name':'Renamed'}),))
c.execute("update folders set data=? where id='f'",(json.dumps({'name':'Renamed folder'}),))
for i,p,f in [('c','q','g'),('d','p','f')]: c.execute('insert into files values (?,?,?,?,?,?)',(i,p,f,'text',0,json.dumps({'name':i,'content':'<p>new</p>'})))`);
  const report = await run();
  assert.ok(report.some(r => r.id === 'file:c' && r.status === 'imported'), JSON.stringify(report));
  assert.ok(report.some(r => r.id === 'file:d' && r.status === 'imported'), JSON.stringify(report));
  assert.equal(durable.scopes[key]['file:a'].path, old['file:a'].path);
  assert.equal(durable.scopes[key]['file:c'].path, 'Target/Other/Other folder/c.md');
  assert.equal(durable.scopes[key]['file:d'].path, 'Target/Project/Folder/d.md');
  // Legacy state cannot prove the ancestor identities, even when depths match.
  for (const entry of Object.values(durable.scopes[key])) delete entry.ancestors;
  sql(`c.execute('insert into files values (?,?,?,?,?,?)',('e','q','g','text',0,json.dumps({'name':'e','content':'<p>new</p>'})))`);
  const legacy = await run();
  assert.ok(legacy.some(r => r.id === 'file:e' && r.status === 'imported'), JSON.stringify(legacy));
  assert.notEqual(durable.scopes[key]['file:e'].path, 'Target/Other/Other folder/e.md');
});

test('text refresh survives durable intent and write crash windows', async t => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-refresh-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const db = path.join(tmp, 'source.sqlite');
  execFileSync('python3', ['-c', `import sqlite3,json,sys
c=sqlite3.connect(sys.argv[1]); c.executescript("create table projects(id text,data text); create table folders(id text,parent_folder_id text,data text); create table files(id text,project_id text,folder_id text,type text,is_trashed integer,data text); create table manuscript_files(id text,project_id text,folder_id text,is_trashed integer,data text);")
c.execute('insert into projects values (?,?)',('p',json.dumps({'name':'Project'}))); c.execute('insert into files values (?,?,?,?,?,?)',('a','p',None,'text',0,json.dumps({'name':'A','content':'<p>old</p>'}))); c.commit()`, db]);
  const notes = new Map(); let durable = { version: 1, scopes: {} }, failSave = 0, saves = 0, failWrite = false;
  const vault = { safeToMutate: async () => true, exists: async p => notes.has(p), read: async p => notes.get(p) ?? null, create: async (p,c) => notes.set(p,c), compareAndWrite: async (p,a,b) => { if (failWrite && !p.includes('.byok-sync-')) return false; if (notes.get(p) !== a) return false; notes.set(p,b); return true; } };
  const run = () => { saves = 0; return sync({ database: db, folder: 'Target', vault, vaultId: tmp, state: structuredClone(durable), save: async s => { if (++saves === failSave) throw Error('save failure'); durable = structuredClone(s); } }); };
  await run(); const key = JSON.stringify([db, tmp, 'Target']); const notePath = durable.scopes[key]['file:a'].path; const from = notes.get(notePath);
  execFileSync('python3', ['-c', `import sqlite3,json,sys
c=sqlite3.connect(sys.argv[1]); d=json.loads(c.execute("select data from files where id='a'").fetchone()[0]); d['content']='<p>new</p>'; c.execute("update files set data=? where id='a'",(json.dumps(d),)); c.commit()`, db]);
  failWrite = true; assert.ok((await run()).some(r => r.status === 'changed-during-sync'));
  const intent = structuredClone(durable.scopes[key]['file:a'].textRefresh); assert.equal(intent.from, from); assert.equal(notes.get(notePath), from);
  notes.set(notePath, 'other'); assert.ok((await run()).some(r => r.status === 'changed' && /Interrupted/.test(r.detail))); assert.deepEqual(durable.scopes[key]['file:a'].textRefresh, intent);
  notes.set(notePath, from); failWrite = false; failSave = 2; assert.ok((await run()).some(r => r.status === 'failed')); // clearing intent succeeds; saving new intent fails
  assert.equal(notes.get(notePath), from); assert.equal(durable.scopes[key]['file:a'].textRefresh, undefined);
  failSave = 2; assert.ok((await run()).some(r => r.status === 'failed')); // intent persisted; final save fails after write
  assert.equal(notes.get(notePath), intent.to); assert.deepEqual(durable.scopes[key]['file:a'].textRefresh, intent);
  failSave = 1; assert.ok((await run()).some(r => r.status === 'failed')); assert.deepEqual(durable.scopes[key]['file:a'].textRefresh, intent);
  failSave = 0; assert.ok((await run()).some(r => r.status === 'recovered'));
  assert.equal(durable.scopes[key]['file:a'].baseline, intent.to); assert.equal(durable.scopes[key]['file:a'].studioContent, intent.studio); assert.equal(durable.scopes[key]['file:a'].textRefresh, undefined);
});
