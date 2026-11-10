const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createSync } = require('../src/import');

test('structured views use current rows, preserve ordering and protect source and notes', async t => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'structured-')); t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const db = path.join(tmp, 'synthetic.sqlite');
  const sql = script => execFileSync('python3', ['-c', `import sqlite3,json,sys\nc=sqlite3.connect(sys.argv[1])\n${script}\nc.commit()`, db]);
  sql(`c.executescript('create table projects(id text,data text); create table folders(id text,parent_folder_id text,data text); create table files(id text,project_id text,folder_id text,type text,is_trashed integer,data text); create table manuscript_files(id text,project_id text,folder_id text,is_trashed integer,data text);')
c.execute('insert into projects values (?,?)',('p',json.dumps({'name':'Project'})))
outline={'name':'Same','content':[{'id':'n1','text':'Parent','type':'I','isCollapsed':False,'children':[{'id':'n2','text':'Child','type':'II','isCollapsed':False,'children':[]}]}]}
c.execute('insert into files values (?,?,?,?,?,?)',('o','p',None,'outline',0,json.dumps(outline)))
for id,body in [('a','Current A'),('b','Current B')]: c.execute('insert into files values (?,?,?,?,?,?)',(id,'p',None,'text',0,json.dumps({'name':'Same','content':'<p>'+body+'</p>'})))
def entry(id,file,pos): return {'id':id,'position':pos,'color':'#fff','outline_item_id':None,'outlineItemId':None,'file':{'id':file,'content':'STALE'}}
m={'name':'Same','manuscripts':[entry('e2','b',0),entry('e1','a',1),entry('e3','a',2)]}
c.execute('insert into manuscript_files values (?,?,?,?,?)',('m','p',None,0,json.dumps(m)))`);
  const snapshot = () => execFileSync('python3', ['-c', "import sqlite3,sys,json; c=sqlite3.connect(sys.argv[1]); print(json.dumps([list(c.execute('select * from '+t)) for t in ['projects','folders','files','manuscript_files']]))", db], {encoding:'utf8'});
  const before = snapshot(), notes = new Map([['Target/Project/Same.md','existing']]);
  const vault = {safeToMutate:async()=>true, exists:async p=>notes.has(p), read:async p=>notes.get(p) ?? null, create:async(p,c)=>{assert.ok(!notes.has(p)); notes.set(p,c)}, compareAndWrite:async(p,a,b)=>{if(notes.get(p)!==a)return false; notes.set(p,b); return true}};
  const state = {version:1,scopes:{}}; let writes = 0;
  const run = () => createSync(async()=>{writes++; throw Error('unexpected write')})({database:db,folder:'Target',vault,vaultId:tmp,state,save:async()=>{},studioAsar:'synthetic'});
  const first = await run(); const o = first.find(r=>r.id==='file:o' && r.status==='imported').path; const m = first.find(r=>r.id==='manuscript:m' && r.status==='imported').path;
  assert.match(notes.get(o), /- Parent[^\n]*\n  - Child/); assert.ok(first.some(r=>r.status==='collision'));
  const body = notes.get(m); assert.ok(body.indexOf('Current B') < body.indexOf('Current A')); assert.equal((body.match(/Current A/g)||[]).length,2); assert.doesNotMatch(body,/STALE/); assert.ok(first.some(r=>r.id==='manuscript:m' && /Repeated file reference/.test(r.detail||'')));
  assert.ok((await run()).some(r=>r.id==='manuscript:m' && r.status==='unchanged')); assert.equal(snapshot(),before); assert.equal(writes,0);
  sql(`d=json.loads(c.execute("select data from files where id='o'").fetchone()[0]); d['content'][0]['type']='unknown'; c.execute("update files set data=? where id='o'",(json.dumps(d),))`);
  const old = notes.get(o); assert.ok((await run()).some(r=>r.id==='file:o' && r.status==='failed')); assert.equal(notes.get(o),old);
  sql(`d=json.loads(c.execute("select data from manuscript_files where id='m'").fetchone()[0]); d['manuscripts'][0]['file']['id']='missing'; c.execute("update manuscript_files set data=? where id='m'",(json.dumps(d),))`);
  assert.ok((await run()).some(r=>r.id==='manuscript:m' && /missing/.test(r.detail||''))); assert.equal(notes.get(m),body);
  // Literal HTML text must not become active Markdown at the sync boundary.
  sql(`d=json.loads(c.execute("select data from files where id='a'").fetchone()[0]); d['content']='<p>![alt](https://example.invalid/a)\\n&lt;img src=x&gt; [link](https://example.invalid)</p>'; c.execute("update files set data=? where id='a'",(json.dumps(d),)); d=json.loads(c.execute("select data from manuscript_files where id='m'").fetchone()[0]); d['manuscripts'][0]['file']['id']='a'; c.execute("update manuscript_files set data=? where id='m'",(json.dumps(d),))`);
  await run(); assert.doesNotMatch(notes.get(m), /!\[alt\]\(|<img src=x>|(?<!\\)\[link\]\(/);
  const entry = state.scopes[JSON.stringify([db,tmp,'Target'])]['manuscript:m'];
  const original = notes.get(m);
  sql(`d=json.loads(c.execute("select data from manuscript_files where id='m'").fetchone()[0]); d['manuscripts'][0]['color']='#abc'; c.execute("update manuscript_files set data=? where id='m'",(json.dumps(d),))`);
  await run(); assert.notEqual(notes.get(m), original, 'color-only change must be represented');
  sql(`d=json.loads(c.execute("select data from manuscript_files where id='m'").fetchone()[0]); d['manuscripts'][0]['color']={}; c.execute("update manuscript_files set data=? where id='m'",(json.dumps(d),))`);
  const colorNote = notes.get(m); assert.ok((await run()).some(r=>r.id==='manuscript:m' && r.status==='failed')); assert.equal(notes.get(m),colorNote);
  // Simulate a process restart after the note write but before baseline persistence.
  let persisted = structuredClone(state), failAfterWrite = false;
  const restartRun = () => createSync(async()=>{throw Error('unexpected write')})({database:db,folder:'Target',vault,vaultId:tmp,state:persisted,save:async value=>{
    const e = value.scopes[JSON.stringify([db,tmp,'Target'])]['manuscript:m'];
    if (failAfterWrite && !e.structuredRefresh) { failAfterWrite = false; throw Error('interrupted'); }
    persisted = structuredClone(value);
  }});
  sql(`d=json.loads(c.execute("select data from manuscript_files where id='m'").fetchone()[0]); d['manuscripts'][0]['color']='#def'; c.execute("update manuscript_files set data=? where id='m'",(json.dumps(d),))`);
  failAfterWrite = true; assert.ok((await restartRun()).some(r=>r.id==='manuscript:m' && r.status==='failed'));
  assert.ok((await restartRun()).some(r=>r.id==='manuscript:m' && r.status==='recovered'));
  Object.assign(state, structuredClone(persisted));
  // A vault edit that differs from the recorded intent is never adopted.
  sql(`d=json.loads(c.execute("select data from manuscript_files where id='m'").fetchone()[0]); d['manuscripts'][0]['color']='#123'; c.execute("update manuscript_files set data=? where id='m'",(json.dumps(d),))`);
  failAfterWrite = true; await restartRun(); notes.set(m, 'independent edit');
  assert.ok((await restartRun()).some(r=>r.id==='manuscript:m' && r.status==='changed')); assert.equal(notes.get(m),'independent edit');
  notes.set(m,persisted.scopes[JSON.stringify([db,tmp,'Target'])]['manuscript:m'].structuredRefresh.to); await restartRun(); Object.assign(state, structuredClone(persisted));
  sql(`d=json.loads(c.execute("select data from files where id='o'").fetchone()[0]); d['content'][0]['type']='II'; d['content'][0]['isCollapsed']=True; c.execute("update files set data=? where id='o'",(json.dumps(d),))`);
  const beforeFields = notes.get(o); await run(); assert.notEqual(notes.get(o),beforeFields);
  for (const field of ['type','isCollapsed']) {
    sql(`d=json.loads(c.execute("select data from files where id='o'").fetchone()[0]); del d['content'][0]['${field}']; c.execute("update files set data=? where id='o'",(json.dumps(d),))`);
    const previous = notes.get(o); assert.ok((await run()).some(r=>r.id==='file:o' && r.status==='failed')); assert.equal(notes.get(o),previous);
    sql(`d=json.loads(c.execute("select data from files where id='o'").fetchone()[0]); d['content'][0]['${field}']=${field === 'type' ? "'II'" : 'True'}; c.execute("update files set data=? where id='o'",(json.dumps(d),))`);
  }
  // Empty observed shapes and a source edit refresh unchanged views.
  sql(`d=json.loads(c.execute("select data from files where id='o'").fetchone()[0]); d['content']=[]; c.execute("update files set data=? where id='o'",(json.dumps(d),)); d=json.loads(c.execute("select data from manuscript_files where id='m'").fetchone()[0]); d['manuscripts']=[]; c.execute("update manuscript_files set data=? where id='m'",(json.dumps(d),))`);
  const empty = await run(); assert.ok(empty.some(r=>r.id==='file:o' && r.status==='updated')); assert.ok(empty.some(r=>r.id==='manuscript:m' && r.status==='updated'));
  const emptyOutline = notes.get(o), emptyManuscript = notes.get(m);
  for (const value of [null, {}, [{'id':'n','text':'x','type':'I','children':[],'isCollapsed':false,'unknown':1}], [{'id':'n','text':'x','type':'I','children':[],'isCollapsed':false},{'id':'n','text':'x','type':'I','children':[],'isCollapsed':false}]]) {
    const encoded = Buffer.from(JSON.stringify(value)).toString('base64');
    sql(`import base64
d=json.loads(c.execute("select data from files where id='o'").fetchone()[0]); d['content']=json.loads(base64.b64decode('${encoded}')); c.execute("update files set data=? where id='o'",(json.dumps(d),))`);
    assert.ok((await run()).some(r=>r.id==='file:o' && r.status==='failed')); assert.equal(notes.get(o),emptyOutline);
  }
  for (const value of [null, [{}], [{'id':'e','position':1,'file':{'id':'a'}}], [{'id':'e','position':0,'file':{'id':'a'}},{'id':'e','position':1,'file':{'id':'b'}}]]) {
    const encoded = Buffer.from(JSON.stringify(value)).toString('base64');
    sql(`import base64
d=json.loads(c.execute("select data from manuscript_files where id='m'").fetchone()[0]); d['manuscripts']=json.loads(base64.b64decode('${encoded}')); c.execute("update manuscript_files set data=? where id='m'",(json.dumps(d),))`);
    assert.ok((await run()).some(r=>r.id==='manuscript:m' && r.status==='failed')); assert.equal(notes.get(m),emptyManuscript);
  }
  sql(`d=json.loads(c.execute("select data from files where id='o'").fetchone()[0]); d['content']=[]; c.execute("update files set data=? where id='o'",(json.dumps(d),))`);
  notes.set(o,'user edit'); assert.ok((await run()).some(r=>r.id==='file:o' && r.status==='changed')); assert.equal(notes.get(o),'user edit'); assert.equal(writes,0);
});
