#!/usr/bin/env python3
"""Pinned-source replay callback and SQLite ownership probes; no library or network access."""
import argparse, hashlib, json, sqlite3, struct, subprocess
from pathlib import Path

PIN = '25e93b78fb4753f7b47236a91f8907e674c341aab19af271d93c7dd1e04dbcfa'
p = argparse.ArgumentParser()
p.add_argument('--asar', type=Path, required=True)
a = p.parse_args()
raw = a.asar.read_bytes()
assert hashlib.sha256(raw).hexdigest() == PIN, 'unexpected Studio build'
_, header_size, _, json_size = struct.unpack('<4I', raw[:16])
header = json.loads(raw[16:16 + json_size])
def source(name):
    item = header['files']['src']['files'][name]
    start = 8 + header_size + int(item['offset'])
    return raw[start:start + item['size']].decode()
def part(s, begin, end):
    assert s.count(begin) == 1 and s.count(end) == 1
    return s[s.index(begin):s.index(end)]
sync, mirror = source('syncEngine.js'), source('mirror.js')
# Source text runs in a fresh Node process. The database adapter is an in-memory
# stub: it accepts only the exact vendor UPSERT and records the new data value.
js = '''
const vm = require('node:vm');
const input = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
let current;
const ctx = { JSON, String, Number, Set, now: () => 1, str: x => x == null ? null : String(x),
 getCurrentUserId: () => 'local', camelize: x => x, parse: x => x ? JSON.parse(x) : null,
 rebasePendingUpdates: () => {}, remap: () => { throw Error('unexpected remap'); } };
ctx.db = {prepare(sql) {
 if (!sql.includes('ON CONFLICT(id) DO UPDATE SET') || !sql.includes('data=excluded.data')) throw Error('unexpected SQL');
 return {run(...args) { current = JSON.parse(args[8]); }};
}};
vm.createContext(ctx);
vm.runInContext(input.mirror + '\\n' + input.write + '\\n' + input.put, ctx);
ctx.mirror = {putFile: file => ctx.putFile(ctx.db, file)};
vm.runInContext(input.apply, ctx);
const results = {};
for (const kind of ['file.create', 'file.update']) {
 current = {id:'file-1', project:'project-1', type:'text', content:'vault edit'};
 const response = {id:'file-1', project:'project-1', type:'text', content:'old Studio text'};
 ctx.applyServerResult({kind, temp_ids:'[]'}, response);
 results[kind] = current.content;
}
process.stdout.write(JSON.stringify(results));
'''
payload = {'mirror': part(mirror, 'function upsertFileStmt(', 'function upsertFolderStmt('),
           'write': part(mirror, 'function writeFileRow(', 'function writeManuscriptRow('),
           'put': part(mirror, 'function putFile(', 'function getFile('),
           'apply': part(sync, 'function applyServerResult(', 'function remap(')}
result = json.loads(subprocess.run(['node', '-e', js], input=json.dumps(payload), text=True, capture_output=True, check=True).stdout)
assert result == {'file.create': 'old Studio text', 'file.update': 'old Studio text'}
# Exactly the predicates in the guard, on an in-memory database. SQLite's NULL
# truth value is reported separately; a CHECK INSERT/WHERE requires true (1).
c = sqlite3.connect(':memory:')
rows = {}
for key, doc in {'absent': '{}', 'json_null': '{"user":null}', 'local': '{"user":"local"}', 'foreign': '{"user":"foreign"}'}.items():
    q = "SELECT json_type(?,'$.user') IS NULL OR json_extract(?,'$.user')='local', json_type(?,'$.user') IS NOT NULL AND json_extract(?,'$.user') IS NOT 'local'"
    positive, folder_reject = c.execute(q, (doc, doc, doc, doc)).fetchone()
    rows[key] = {'file_project_pass': positive == 1, 'folder_rejected': bool(folder_reject)}
assert rows == {'absent': {'file_project_pass': True, 'folder_rejected': False}, 'json_null': {'file_project_pass': False, 'folder_rejected': True}, 'local': {'file_project_pass': True, 'folder_rejected': False}, 'foreign': {'file_project_pass': False, 'folder_rejected': True}}
print(json.dumps({'asar_sha256': PIN, 'sqlite_version': sqlite3.sqlite_version, 'callback_result': result, 'ownership': rows}, indent=2))
