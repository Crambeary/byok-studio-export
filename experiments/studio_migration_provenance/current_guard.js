// Runs the repository's real guarded-write SQL on one disposable fixture copy.
// The environment check is stubbed because this lab tests the database-level
// checks only: the fixture lives under a marked scratch directory, and no
// asar, statfs or CLI-version decision is under test here.
//
// Usage: node current_guard.js <db> <file id> <new html>
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createGuardedWrite, runSql } = require(path.join(__dirname, '../../src/writeback.js'));

async function main() {
  const [db, id, html] = process.argv.slice(2);
  const raw = execFileSync('sqlite3', ['-readonly', '-json', db, `SELECT id, project_id, folder_id, data AS rawData FROM files WHERE id='${id}'`], { encoding: 'utf8' });
  const [row] = JSON.parse(raw || '[]');
  if (!row) return console.log(JSON.stringify({ accepted: false, reason: 'no such row' }));
  row.data = JSON.parse(row.rawData);
  try {
    await createGuardedWrite(async () => {}, runSql)(db, row, html, 'synthetic');
    console.log(JSON.stringify({ accepted: true }));
  } catch (error) {
    console.log(JSON.stringify({ accepted: false, reason: String(error.message).slice(0, 200) }));
  }
}
main();
