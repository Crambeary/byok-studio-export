const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createSync } = require('../src/import');
const evidence = require('../experiments/cardstack_grid/populated-evidence.json');

test('observed cardstacks and grids are literal, read-only, and recover safely', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cardgrid-')); t.after(() => fs.rm(dir, {recursive:true, force:true}));
  const db = path.join(dir, 'test.sqlite');
  const records = evidence.captures.tree_reopened.map(r => ({...r, content: structuredClone(r.content)}));
  const sql = (code, arg = '') => execFileSync('python3', ['-c', `import sqlite3,json,sys\nc=sqlite3.connect(sys.argv[1])\n${code}\nc.commit()`, db, arg], {encoding:'utf8'});
  sql(`c.executescript('create table projects(id text,data text); create table folders(id text,parent_folder_id text,data text); create table files(id text,project_id text,folder_id text,type text,is_trashed integer,data text); create table manuscript_files(id text,project_id text,folder_id text,is_trashed integer,data text);')
c.execute('insert into projects values (?,?)',('p',json.dumps({'name':'Project'})))
for r in json.loads(sys.argv[2]): c.execute('insert into files values (?,?,?,?,?,?)',(r['type'],'p',None,r['type'],0,json.dumps(r)))`, JSON.stringify(records));
  const update = r => execFileSync('python3', ['-c', "import sqlite3,json,sys\nc=sqlite3.connect(sys.argv[1])\nr=json.load(sys.stdin)\nc.execute('update files set data=? where id=?',(json.dumps(r),r['type']))\nc.commit()", db], {input: JSON.stringify(r)});
  const snapshot = () => sql("print(json.dumps(list(c.execute('select * from files order by id'))))");
  const notes = new Map([['Target/Project/Untitled Grid.md','user note']]);
  let failCreate = false;
  const vault = {safeToMutate:async()=>true, exists:async p=>notes.has(p), read:async p=>notes.get(p) ?? null, create:async(p,v)=>{assert.ok(!notes.has(p));if(failCreate && p.endsWith('.md')) { failCreate=false; throw Error('interrupted create'); } notes.set(p,v)}, compareAndWrite:async(p,a,b)=>{if(notes.get(p)!==a)return false;notes.set(p,b);return true}};
  let durable = {version:1,scopes:{}}, fail = false, writes = 0;
  const run = () => { const state = structuredClone(durable); return createSync(async()=>{writes++; throw Error('unexpected write')})({database:db,folder:'Target',vault,vaultId:dir,state,studioAsar:'synthetic',save:async v=>{const e=v.scopes[JSON.stringify([db,dir,'Target'])]?.['file:grid']; if(fail && e && !e.structuredRefresh){fail=false;throw Error('interrupted')} durable=structuredClone(v)}}); };
  const before = snapshot(), first = await run();
  const gridPath = first.find(r=>r.id==='file:grid' && r.status==='imported').path;
  const cardPath = first.find(r=>r.id==='file:cardstack' && r.status==='imported').path;
  assert.ok(first.some(r=>r.id==='file:grid' && r.status==='collision')); assert.equal(notes.get('Target/Project/Untitled Grid.md'),'user note');
  assert.match(notes.get(gridPath), /"x": 17/); assert.ok(notes.get(cardPath).indexOf('Synthetic beta') < notes.get(cardPath).indexOf('Synthetic alpha'));
  assert.equal(snapshot(),before); assert.equal(writes,0);
  const grid = records.find(r=>r.type==='grid'); grid.content.v2.tiles[0].content = '```\n![x](https://example.invalid)\n````'; update(grid);
  fail=true; assert.ok((await run()).some(r=>r.id==='file:grid' && r.status==='failed')); assert.ok((await run()).some(r=>r.id==='file:grid' && r.status==='recovered'));
  assert.match(notes.get(gridPath), /`````json/);
  const projected = notes.get(gridPath); notes.set(gridPath, 'independent user edit'); grid.content.v2.tiles[0].x++; update(grid);
  assert.ok((await run()).some(r=>r.id==='file:grid' && r.status==='changed')); assert.equal(notes.get(gridPath),'independent user edit'); notes.set(gridPath,projected);
  for (const mutate of [g=>g.content.v2.connections.push({}), g=>g.content.v2.tiles[0].extra=1, g=>g.content.v2.tiles[0].w='8', g=>g.content.tiles.push({}), g=>g.content.v2.tiles.push(structuredClone(g.content.v2.tiles[0]))]) {
    const bad=structuredClone(grid); mutate(bad); update(bad); const note=notes.get(gridPath); assert.ok((await run()).some(r=>r.id==='file:grid' && r.status==='unsupported')); assert.equal(notes.get(gridPath),note);
  }
  const cards=records.find(r=>r.type==='cardstack'); cards.content[0].cards[0].content='<strong>formatted</strong>'; update(cards);
  const note=notes.get(cardPath); assert.ok((await run()).some(r=>r.id==='file:cardstack' && r.status==='unsupported')); assert.equal(notes.get(cardPath),note); assert.equal(writes,0);

  // Unknown record-level values are retained verbatim, including malformed-looking values.
  grid.gridLayout = { unexpected: [null, { nested: true }] }; grid.file = ['opaque']; grid.future = { value: 42 }; update(grid);
  assert.ok((await run()).some(r=>r.id==='file:grid' && r.status==='updated'));
  assert.match(notes.get(gridPath), /"future": \{/); assert.match(notes.get(gridPath), /"opaque"/);
  grid.future.value = 43; update(grid); const priorFields = notes.get(gridPath);
  assert.ok((await run()).some(r=>r.id==='file:grid' && r.status==='updated')); assert.notEqual(notes.get(gridPath), priorFields);

  // A completed note write is recovered even when Studio advances again.
  grid.future.value = 44; update(grid); fail = true;
  assert.ok((await run()).some(r=>r.id==='file:grid' && r.status==='failed'));
  const intent = durable.scopes[JSON.stringify([db,dir,'Target'])]['file:grid'].structuredRefresh;
  grid.future.value = 45; update(grid); notes.set(gridPath, 'divergent edit');
  assert.ok((await run()).some(r=>r.id==='file:grid' && r.status==='changed')); assert.equal(notes.get(gridPath), 'divergent edit');
  notes.set(gridPath, intent.to);
  assert.ok((await run()).some(r=>r.id==='file:grid' && r.status==='updated')); assert.match(notes.get(gridPath), /"value": 45/);

  // Many separate backtick runs must not overflow the argument stack.
  grid.content.v2.tiles[0].content = '`x'.repeat(150000); update(grid);
  assert.ok((await run()).some(r=>r.id==='file:grid' && r.status==='updated')); assert.match(notes.get(gridPath), /```json/);

  // Restart a failed initial creation after the source has changed.
  cards.content[0].cards[0].content = 'original'; update(cards);
  // Use a fresh scope so its marker and reservations agree.
  const pendingNotes = new Map(); let pendingState = {version:1,scopes:{}};
  const pendingVault = {...vault, exists:async p=>pendingNotes.has(p), read:async p=>pendingNotes.get(p) ?? null,
    create:async(p,v)=>{if(failCreate && p.endsWith('.md')) {failCreate=false; throw Error('interrupted create');} pendingNotes.set(p,v)},
    compareAndWrite:async(p,a,b)=>{if(pendingNotes.get(p)!==a)return false;pendingNotes.set(p,b);return true}};
  let changeDuringSave = null;
  const pendingRun = () => createSync(async()=>{throw Error('unexpected write')})({database:db,folder:'Pending',vault:pendingVault,vaultId:dir,state:structuredClone(pendingState),save:async s=>{pendingState=structuredClone(s); if(changeDuringSave) { const change=changeDuringSave; changeDuringSave=null; change(); }}});
  failCreate=true; assert.ok((await pendingRun()).some(r=>r.status==='failed'));
  const pendingEntry = Object.entries(pendingState.scopes[JSON.stringify([db,dir,'Pending'])]).find(([,e])=>e.pending);
  const pendingRecord = records.find(r=>`file:${r.type}`===pendingEntry[0]); pendingRecord.extraAfterRestart = 'new source'; update(pendingRecord);
  changeDuringSave = () => { pendingRecord.extraAfterRestart = 'changed during recovery'; update(pendingRecord); };
  assert.ok((await pendingRun()).some(r=>r.id===pendingEntry[0] && r.status==='changed-during-sync'));
  assert.equal(pendingNotes.has(pendingEntry[1].path), false);
  assert.ok((await pendingRun()).some(r=>r.id===pendingEntry[0] && r.status==='recovered'));
  assert.match(pendingNotes.get(pendingEntry[1].path), /"extraAfterRestart": "changed during recovery"/);
  assert.equal(writes,0);
});
