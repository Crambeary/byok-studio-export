const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { guardedWrite } = require('../src/writeback');

test('production write refuses before accessing a disposable library under uncertainty', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-closed-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const db = path.join(dir, 'db.sqlite');
  const bytes = Buffer.from('disposable sentinel');
  await fs.writeFile(db, bytes);
  // Closed, inaccessible, and disappearing/replaced paths cannot change the
  // decision; the gate does not rely on a racy process or filesystem scan.
  for (const candidate of [db, path.join(dir, 'inaccessible', 'db.sqlite'), path.join(dir, 'missing')]) {
    await assert.rejects(guardedWrite(candidate, null, '<p>edit</p>', null), /closed state cannot be established safely/);
  }
  await fs.chmod(db, 0);
  await assert.rejects(guardedWrite(db, null, '<p>edit</p>', null), /closed state cannot be established safely/);
  await fs.chmod(db, 0o600);
  assert.deepEqual(await fs.readFile(db), bytes);
});
