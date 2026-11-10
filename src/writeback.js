const { spawn, execFileSync } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { readFile, statfs, access, realpath } = require('node:fs/promises');

const path = require('node:path');
const { htmlToMarkdown, markdownToHtml } = require('./text-codec');
const testedSchema = require('./tested-schema.json');
const testedAsar = '25e93b78fb4753f7b47236a91f8907e674c341aab19af271d93c7dd1e04dbcfa';
const literal = s => `CAST(X'${Buffer.from(String(s), 'utf8').toString('hex')}' AS TEXT)`;

// Compatibility is deliberately an allowlist; matching a binary does not establish
// which version last migrated a particular database, so schema checks remain required.
async function compatible(database, asar, env = { platform: process.platform, readFile, statfs, access, realpath, execFileSync }) {
  const resolved = await (env.realpath || realpath)(database);
  // Independent of the disposable marker: never authorize Studio's live directory,
  // including a symlink to it or an alternate XDG config root.
  if ([resolved, path.resolve(database)].some(p => p.split(path.sep).includes('studio-desktop'))) {
    throw Error('Live Studio library refused. Use a separate disposable synthetic library; adding a marker cannot authorize a live library.');
  }
  // Until the library's migration provenance can be established, only
  // explicitly marked disposable fixtures are eligible.
  try { await env.access(path.join(path.dirname(resolved), 'DISPOSABLE_SYNTHETIC_LIBRARY')); }
  catch { throw Error('Disposable synthetic library marker missing. Write-back is experimental; select a marked synthetic fixture, never a real library.'); }
  if (env.platform !== 'linux' || !asar) throw Error('Unsupported platform or Studio build not configured. Use the tested Linux build and configure its app.asar path.');
  const hash = (env.hash || (bytes => createHash('sha256').update(bytes).digest('hex')))(await env.readFile(asar));
  if (hash !== testedAsar) throw Error('Untested Studio build. Use the pinned Studio 1.1.3 build or keep write-back disabled.');
  const fs = await env.statfs(database);
  if (![0xef53, 0x58465342, 0x9123683e, 0x01021994].includes(Number(fs.type))) throw Error('Unsupported filesystem. Move the disposable fixture to a tested local filesystem.');
  if (!env.execFileSync('sqlite3', ['--version'], { encoding: 'utf8' }).startsWith('3.53.4 ')) throw Error('Untested sqlite3 version. Install SQLite 3.53.4 before retrying the disposable fixture.');
}

function runSql(database, sql) {
  return new Promise((resolve, reject) => {
    const child = spawn('sqlite3', [database], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', b => out += b); child.stderr.on('data', b => err += b);
    child.on('error', () => reject(Error('Could not start sqlite3. Install SQLite 3.53.4 and retry the disposable fixture.')));
    child.on('close', code => {
      if (code === 0 && out.includes('COMMITTED')) return resolve();
      const reason = out.split('GUARD: ').pop().trim();
      reject(Error(/locked|busy/i.test(err)
        ? 'Library is in use. Close every Studio instance and other database readers, then retry the disposable fixture.'
        : `Write refused: ${out.includes('GUARD: ') ? reason : 'SQLite transaction failed; verify the tested disposable fixture and retry.'}`));
    });
    child.stdin.on('error', () => {}); child.stdin.end(sql);
  });
}

function createGuardedWrite(checkCompatibility = compatible, execute = runSql) {
return async function guardedWrite(database, row, newHtml, asar, localExperiment = false) {
  await checkCompatibility(database, asar);
  // JSON.parse/stringify can discard duplicate keys, round numbers, or turn
  // non-finite values into null. Permit only a demonstrably stable JSON snapshot.
  const compact = raw => raw.replace(/"(?:\\.|[^"\\])*"|\s+/g, token => token.startsWith('"') ? token : '');
  let parsed;
  try { parsed = JSON.parse(row.rawData); } catch { throw Error('Unsafe record JSON. Preserve the vault edit and repair the synthetic record before retrying.'); }
  const numbersSafe = value => typeof value === 'number' ? Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))
    : value && typeof value === 'object' ? Object.values(value).every(numbersSafe) : true;
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object' ||
      compact(row.rawData) !== JSON.stringify(parsed) || JSON.stringify(row.data) !== JSON.stringify(parsed) || !numbersSafe(parsed)) {
    throw Error('Unsafe record JSON transformation (duplicate keys, numeric representation, or mismatched snapshot). Preserve the vault edit; repair the synthetic record before retrying.');
  }
  const markdown = htmlToMarkdown(newHtml);
  newHtml = markdown === null ? null : markdownToHtml(markdown, parsed.content);
  if (newHtml === null) throw Error('Unsupported paragraph HTML or Markdown syntax. Preserve the vault edit and use literal paragraphs with one uniform supported paragraph form.');
  const stamp = new Date().toISOString();
  const encoded = JSON.stringify(row.data.content);
  const fingerprint = createHash('sha256').update(JSON.stringify({ c: row.data.content, e: null })).digest('hex');
  const q = literal, id = q(row.id);
  const experimental = localExperiment === true;
  // Each assertion aborts the CLI, closing its connection and rolling back.
  const sql = `.bail on
PRAGMA busy_timeout=0;
PRAGMA locking_mode=EXCLUSIVE;
BEGIN EXCLUSIVE;
CREATE TEMP TABLE guard(ok INTEGER NOT NULL CHECK(ok=1));
.print 'GUARD: Incompatible schema or migration metadata. Keep write-back disabled and use a fresh tested disposable fixture.'
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
.print 'GUARD: Record changed, moved, trashed, or is no longer text. Preserve the vault edit and re-import the synthetic record before retrying.'
INSERT INTO guard SELECT count(*)=1 FROM files WHERE id=${id} AND type='text' AND is_trashed=0 AND data=${q(row.rawData)} AND project_id IS ${q(row.project_id)} AND folder_id IS ${row.folder_id == null ? 'NULL' : q(row.folder_id)};
.print 'GUARD: Outbox references this file regardless of status, or an encoded URL prevents ruling out a reference. Preserve the vault edit; use a clean synthetic fixture without queued work. Do not delete or rewrite outbox rows.'
INSERT INTO guard SELECT ${experimental ? '1 OR ' : ''}NOT EXISTS(SELECT 1 FROM outbox WHERE (instr(coalesce(url,''),'%')>0 OR entity_id=${id} OR instr(coalesce(temp_ids,''),${id})>0 OR instr(coalesce(url,''),${id})>0 OR instr(coalesce(body,''),${id})>0 OR EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(temp_ids) THEN temp_ids ELSE 'null' END) WHERE instr(CAST(value AS TEXT),${id})>0) OR EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(body) THEN body ELSE 'null' END) WHERE instr(CAST(value AS TEXT),${id})>0)));
.print 'GUARD: JSON identity or location disagrees with indexed columns. Preserve the vault edit and repair the synthetic record before retrying.'
INSERT INTO guard SELECT (json_type(data,'$.id') IS NULL OR json_extract(data,'$.id') IS id) AND (json_type(data,'$.project') IS NULL OR json_extract(data,'$.project') IS project_id) AND (json_type(data,'$.folder') IS NULL OR json_extract(data,'$.folder') IS folder_id) AND (json_type(data,'$.type') IS NULL OR json_extract(data,'$.type') IS type) FROM files WHERE id=${id};
.print 'GUARD: Comments or device links reference this record or project. Preserve the vault edit and use an unlinked, uncommented synthetic record.'
INSERT INTO guard SELECT NOT EXISTS(SELECT 1 FROM comments WHERE file_id=${id});
INSERT INTO guard SELECT NOT EXISTS(SELECT 1 FROM device_files WHERE studio_file_id=${id});
INSERT INTO guard SELECT NOT EXISTS(SELECT 1 FROM device_projects WHERE studio_project_id=${q(row.project_id)});
INSERT INTO guard SELECT coalesce(json_type(data,'$.autoLinkedDeviceIds') IS NULL OR (json_type(data,'$.autoLinkedDeviceIds')='array' AND json_array_length(data,'$.autoLinkedDeviceIds')=0),0) AND (json_type(data,'$.file') IS NULL OR json_type(data,'$.file')='null') FROM files WHERE id=${id};
.print 'GUARD: Foreign ownership or trashed JSON record. Preserve the vault edit and use a local, active synthetic record.'
INSERT INTO guard SELECT (user_id IS NULL OR user_id='local') AND (json_type(data,'$.user') IS NULL OR ${experimental ? "json_type(data,'$.user')='null' OR " : ''}json_extract(data,'$.user')='local') AND (json_type(data,'$.userId') IS NULL OR ${experimental ? "json_type(data,'$.userId')='null' OR " : ''}json_extract(data,'$.userId')='local') AND (json_type(data,'$.isTrashed') IS NULL OR json_type(data,'$.isTrashed')='false') FROM files WHERE id=${id};
.print 'GUARD: Missing, foreign-owned, trashed, or inconsistent project/folder ancestor. Preserve the vault edit and repair the synthetic hierarchy before retrying.'
INSERT INTO guard SELECT count(*)=1 FROM projects WHERE id=${q(row.project_id)} AND (user_id IS NULL OR user_id='local') AND json_valid(data) AND json_type(data)='object' AND NOT EXISTS(SELECT 1 FROM json_tree(projects.data) GROUP BY fullkey HAVING count(*)>1) AND (json_type(data,'$.isTrashed') IS NULL OR json_type(data,'$.isTrashed')='false') AND (json_type(data,'$.user') IS NULL OR ${experimental ? "json_type(data,'$.user')='null' OR " : ''}json_extract(data,'$.user')='local') AND (json_type(data,'$.userId') IS NULL OR ${experimental ? "json_type(data,'$.userId')='null' OR " : ''}json_extract(data,'$.userId')='local');
WITH RECURSIVE chain(id) AS (
 SELECT folder_id FROM files WHERE id=${id} AND folder_id IS NOT NULL
 UNION SELECT parent_folder_id FROM folders JOIN chain ON folders.id=chain.id WHERE parent_folder_id IS NOT NULL
)
INSERT INTO guard SELECT NOT EXISTS(SELECT 1 FROM chain LEFT JOIN folders ON folders.id=chain.id WHERE folders.id IS NULL OR folders.project_id<>${q(row.project_id)} OR folders.is_trashed<>0 OR (folders.user_id IS NOT NULL AND folders.user_id<>'local') OR NOT json_valid(folders.data) OR json_type(folders.data)<>'object' OR EXISTS(SELECT 1 FROM json_tree(folders.data) GROUP BY fullkey HAVING count(*)>1) OR (json_type(folders.data,'$.isTrashed') IS NOT NULL AND json_type(folders.data,'$.isTrashed')<>'false') OR (json_type(folders.data,'$.user') IS NOT NULL AND ${experimental ? "json_type(folders.data,'$.user')<>'null' AND " : ''}json_extract(folders.data,'$.user') IS NOT 'local') OR (json_type(folders.data,'$.userId') IS NOT NULL AND ${experimental ? "json_type(folders.data,'$.userId')<>'null' AND " : ''}json_extract(folders.data,'$.userId') IS NOT 'local')) AND (NOT EXISTS(SELECT 1 FROM chain) OR EXISTS(SELECT 1 FROM chain JOIN folders ON folders.id=chain.id WHERE parent_folder_id IS NULL));
.print 'GUARD: Version snapshot or update failed. Preserve the vault edit; inspect the disposable fixture before retrying.'
INSERT INTO local_versions(id,file_id,content,extras,fingerprint,reason,file_name,content_size,created_at)
 SELECT ${q(randomUUID())},${id},${q(encoded)},NULL,${q(fingerprint)},'manual',${q(row.data.name || '')},${encoded.length},${q(stamp)}
 WHERE ${q(row.data.content)}<>'' AND coalesce((SELECT fingerprint FROM local_versions WHERE file_id=${id} ORDER BY created_at DESC LIMIT 1),'')<>${q(fingerprint)};
UPDATE files SET data=json_set(data,'$.content',${q(newHtml)},'$.updatedAt',${q(stamp)},'$.contentUpdatedAt',${q(stamp)}),mirrored_at=${Date.parse(stamp)} WHERE id=${id};
COMMIT;
SELECT 'COMMITTED';
`;
  await execute(database, sql);
  return stamp;
}
}
const guardedWrite = createGuardedWrite();
module.exports = { guardedWrite, createGuardedWrite, compatible, runSql };
