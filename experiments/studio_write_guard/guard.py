"""Candidate closed-Studio guard for issue #5. Research code; not wired to anything.

The guard relies on SQLite's own file lock rather than process detection:

    PRAGMA locking_mode=EXCLUSIVE;   -- before any other access on the connection
    BEGIN EXCLUSIVE;                 -- with a zero busy timeout

Against a WAL database this needs an exclusive lock on the main database file,
which fails while any other connection has the database open and blocks new
connections until it is released. The experiments in this directory test that.

`write_text` refuses to run on any database outside a marked disposable root.
It never issues a statement that writes to the outbox. Its outbox check is
read-only, and the test fixtures make `outbox` a view so a write would raise.
"""
import json
import sqlite3
from pathlib import Path

MARKER = "DISPOSABLE_SYNTHETIC_LIBRARY"

# Any row Studio could still replay that mentions the record, in any field.
# Superset of Studio's hasPending (syncEngine.js) and pendingEntityIds (mirror.js).
OUTBOX_REFERENCES = """
SELECT id, kind, status FROM outbox
WHERE status IN ('pending', 'failed')
  AND (entity_id = :id
       OR instr(coalesce(temp_ids, ''), :id) > 0
       OR instr(coalesce(url, ''), :id) > 0
       OR instr(coalesce(body, ''), :id) > 0)
ORDER BY id
"""


class Refused(Exception):
    def __init__(self, reason, **detail):
        super().__init__(reason)
        self.reason = reason
        self.detail = detail


def _assert_disposable(db_path):
    db = Path(db_path).resolve()
    if not any((p / MARKER).is_file() for p in db.parents):
        raise Refused("not-disposable", path=str(db))


def acquire(db_path):
    """Open a connection holding the exclusive lock, or raise Refused."""
    con = sqlite3.connect(str(db_path), isolation_level=None, timeout=0)
    try:
        # Without this pragma BEGIN EXCLUSIVE is no guard in WAL mode.
        con.execute("PRAGMA locking_mode=EXCLUSIVE")
        con.execute("BEGIN EXCLUSIVE")
    except sqlite3.OperationalError as error:
        con.close()
        raise Refused("library-in-use", sqlite=str(error)) from error
    # Only a WAL connection holds a lock while idle, so the check means nothing
    # for a rollback-journal database. Studio always switches libraries to WAL.
    mode = con.execute("PRAGMA journal_mode").fetchone()[0]
    if mode != "wal":
        con.execute("ROLLBACK")
        con.close()
        raise Refused("not-wal", sqlite=mode)
    return con


def write_text(db_path, file_id, expected_data, new_content, hold=None):
    """Compare-and-swap one text file under the guard. Rolls back on any refusal."""
    _assert_disposable(db_path)
    con = acquire(db_path)
    try:
        references = con.execute(OUTBOX_REFERENCES, {"id": file_id}).fetchall()
        if references:
            raise Refused("stale-outbox", rows=references)
        row = con.execute("SELECT data FROM files WHERE id = ?", (file_id,)).fetchone()
        if row is None or row[0] != expected_data:
            raise Refused("changed-since-read")
        data = json.loads(row[0])
        data["content"] = new_content
        con.execute(
            "UPDATE files SET data = ? WHERE id = ?",
            (json.dumps(data, ensure_ascii=False, separators=(",", ":")), file_id),
        )
        if hold:
            hold()
        con.execute("COMMIT")
    except BaseException:
        if con.in_transaction:
            con.execute("ROLLBACK")
        raise
    finally:
        con.close()
