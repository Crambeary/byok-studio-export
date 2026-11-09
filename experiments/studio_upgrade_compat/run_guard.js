// Runs the repository's real `guardedWrite`, including its real environment
// check, against one disposable copy of a library outside any studio-desktop
// path. Usage: node run_guard.js <db> <file id> <new html> <1.1.3 app.asar>
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { guardedWrite } = require(path.join(__dirname, '../../src/writeback.js'));

async function main() {
  const [db, id, html, asar] = process.argv.slice(2);
  const sql = `SELECT id, project_id, folder_id, data AS rawData FROM files WHERE id=CAST(X'${Buffer.from(id).toString('hex')}' AS TEXT)`;
  const [row] = JSON.parse(execFileSync('sqlite3', ['-readonly', '-json', db, sql], { encoding: 'utf8' }) || '[]');
  if (!row) return console.log(JSON.stringify({ accepted: false, reason: 'no such row' }));
  row.data = JSON.parse(row.rawData);
  try {
    const stamp = await guardedWrite(db, row, html, asar);
    console.log(JSON.stringify({ accepted: true, stamp }));
  } catch (error) {
    console.log(JSON.stringify({ accepted: false, reason: String(error.message) }));
  }
}
main().catch((error) => { console.log(JSON.stringify({ accepted: false, reason: `harness: ${error.message}` })); });
