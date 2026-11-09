const { spawn, execFileSync } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { readFile, statfs, access } = require('node:fs/promises');

const path = require('node:path');
const testedSchema = require('./tested-schema.json');
const testedAsar = '25e93b78fb4753f7b47236a91f8907e674c341aab19af271d93c7dd1e04dbcfa';
const literal = s => `CAST(X'${Buffer.from(String(s), 'utf8').toString('hex')}' AS TEXT)`;

// Compatibility is deliberately an allowlist; matching a binary does not establish
// which version last migrated a particular database, so schema checks remain required.
async function compatible(database, asar, env = { platform: process.platform, readFile, statfs, access, execFileSync }) {
  // Until the library's migration provenance can be established, only
  // explicitly marked disposable fixtures are eligible.
  await env.access(path.join(path.dirname(database), 'DISPOSABLE_SYNTHETIC_LIBRARY'));
  if (env.platform !== 'linux' || !asar) throw Error('Unsupported platform or Studio build not configured');
  const hash = (env.hash || (bytes => createHash('sha256').update(bytes).digest('hex')))(await env.readFile(asar));
  if (hash !== testedAsar) throw Error('Untested Studio build');
  const fs = await env.statfs(database);
  if (![0xef53, 0x58465342, 0x9123683e, 0x01021994].includes(Number(fs.type))) throw Error('Unsupported filesystem');
  if (!env.execFileSync('sqlite3', ['--version'], { encoding: 'utf8' }).startsWith('3.53.4 ')) throw Error('Untested sqlite3 version');
}

function runSql(database, sql) {
  return new Promise((resolve, reject) => {
    const child = spawn('sqlite3', [database], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', b => out += b); child.stderr.on('data', b => err += b);
    child.on('error', reject);
    child.on('close', code => code === 0 && out.includes('COMMITTED') ? resolve() : reject(Error(err.trim() || 'Guard refused write')));
    child.stdin.on('error', () => {}); child.stdin.end(sql);
  });
}

function createGuardedWrite(checkCompatibility = compatible, execute = runSql) {
return async function guardedWrite(database, row, newHtml, asar) {
  await checkCompatibility(database, asar);
  const stamp = new Date().toISOString();
  const data = { ...row.data, content: newHtml, updatedAt: stamp, contentUpdatedAt: stamp };
  const encoded = JSON.stringify(row.data.content);
  const fingerprint = createHash('sha256').update(JSON.stringify({ c: row.data.content, e: null })).digest('hex');
  const q = literal, id = q(row.id);
  // Each assertion aborts the CLI, closing its connection and rolling back.
  const sql = `.bail on
PRAGMA busy_timeout=0;
PRAGMA locking_mode=EXCLUSIVE;
BEGIN EXCLUSIVE;
CREATE TEMP TABLE guard(ok INTEGER CHECK(ok=1));
INSERT INTO guard SELECT journal_mode='wal' FROM pragma_journal_mode;
INSERT INTO guard SELECT count(*)=${testedSchema.length} FROM sqlite_master WHERE name NOT GLOB 'sqlite_*';
${testedSchema.map(([type, name, definition]) => `INSERT INTO guard SELECT count(*)=1 FROM sqlite_master WHERE type=${q(type)} AND name=${q(name)} AND sql=${q(definition)};`).join('\n')}
INSERT INTO guard SELECT user_version=0 FROM pragma_user_version;
INSERT INTO guard SELECT application_id=0 FROM pragma_application_id;
INSERT INTO guard SELECT count(*)=1 FROM metadata WHERE key='schema_version' AND typeof(value)='text' AND value='3';
INSERT INTO guard SELECT count(*)=1 FROM metadata WHERE key='telemetry.lastVersion' AND typeof(value)='text' AND value='1.1.3';
INSERT INTO guard SELECT count(*)=1 FROM metadata WHERE key='currentUserId' AND typeof(value)='text' AND value='local';
INSERT INTO guard SELECT NOT EXISTS(SELECT 1 FROM metadata WHERE key='mode') OR (SELECT count(*)=1 FROM metadata WHERE key='mode' AND typeof(value)='text' AND value='local');
INSERT INTO guard SELECT NOT EXISTS(SELECT 1 FROM metadata WHERE key='authToken');
INSERT INTO guard SELECT count(*)=1 FROM files WHERE id=${id} AND type='text' AND is_trashed=0 AND data=${q(row.rawData)} AND project_id IS ${q(row.project_id)} AND folder_id IS ${row.folder_id == null ? 'NULL' : q(row.folder_id)};
INSERT INTO guard SELECT NOT EXISTS(SELECT 1 FROM outbox WHERE status IN ('pending','failed') AND (entity_id=${id} OR instr(coalesce(temp_ids,''),${id})>0 OR instr(coalesce(url,''),${id})>0 OR instr(coalesce(body,''),${id})>0));
INSERT INTO local_versions(id,file_id,content,extras,fingerprint,reason,file_name,content_size,created_at)
 SELECT ${q(randomUUID())},${id},${q(encoded)},NULL,${q(fingerprint)},'manual',${q(row.data.name || '')},${encoded.length},${q(stamp)}
 WHERE ${q(row.data.content)}<>'' AND coalesce((SELECT fingerprint FROM local_versions WHERE file_id=${id} ORDER BY created_at DESC LIMIT 1),'')<>${q(fingerprint)};
UPDATE files SET data=${q(JSON.stringify(data))},mirrored_at=${Date.parse(stamp)} WHERE id=${id};
COMMIT;
SELECT 'COMMITTED';
`;
  await execute(database, sql);
  return stamp;
}
}
const guardedWrite = createGuardedWrite();
module.exports = { guardedWrite, createGuardedWrite, compatible, runSql };
