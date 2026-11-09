// Stand-in for Studio's database code. Opens a library exactly as Studio 1.1.3's
// src/db.js does (no options, so better-sqlite3's default 5 s busy timeout, then
// journal_mode=WAL and foreign_keys=ON), using Studio's own better-sqlite3 build.
//
// Run by Studio's Electron binary as Node:
//   ELECTRON_RUN_AS_NODE=1 studio studio_like.js <better-sqlite3 dir> <db>
//
// Prints one JSON line per step. Commands arrive on stdin, one per line.
const Database = require(process.argv[2]);
const say = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const started = Date.now();
let db;
try {
  db = new Database(process.argv[3]);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  say({ event: 'open', ok: true, ms: Date.now() - started, pid: process.pid, sqlite: db.prepare('select sqlite_version() v').get().v });
} catch (e) {
  say({ event: 'open', ok: false, ms: Date.now() - started, error: String(e.message), code: e.code });
  process.exit(3);
}

const content = () => JSON.parse(db.prepare("select data from files where id='f1'").get().data).content;
const commands = {
  read: () => ({ content: content() }),
  // Simulates a Studio autosave. Never touches the outbox.
  write: () => {
    const row = db.prepare("select data from files where id='f1'").get();
    const data = JSON.parse(row.data);
    data.content = 'written by studio-like process';
    db.prepare("update files set data=? where id='f1'").run(JSON.stringify(data));
    return { content: content() };
  },
  begin: () => { db.prepare('BEGIN IMMEDIATE').run(); return {}; },
  commit: () => { db.prepare('COMMIT').run(); return {}; },
  exit: () => { db.close(); say({ event: 'exit', ok: true }); process.exit(0); },
};

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf('\n')) >= 0) {
    const name = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    const t = Date.now();
    try { say({ event: name, ok: true, ms: Date.now() - t, ...commands[name]() }); }
    catch (e) { say({ event: name, ok: false, ms: Date.now() - t, error: String(e.message), code: e.code }); }
  }
});
