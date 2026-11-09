#!/usr/bin/env python3
"""SQLite-level experiments for the closed-Studio guard (issue #5).

No Studio window, network, account token or real library is involved. Every
database is created from the schema Studio itself produced, in a new temporary
directory. The "Studio" side is Studio's own better-sqlite3 build, opened with
the same code path as Studio's src/db.js.

Usage: lab_sqlite.py --studio-dir ~/studio-linux/electron [--out report.json]
"""
import argparse
import json
import os
import shutil
import signal
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

import guard

HERE = Path(__file__).resolve().parent
SCHEMA = HERE.parent / "studio_writeback" / "evidence" / "schema.sql"
FILE_ID = "aaaaaaaa-1111-4222-8333-444444444444"
OTHER_ID = "bbbbbbbb-1111-4222-8333-444444444444"
ORIGINAL = {"id": "f1", "content": "original", "updatedAt": "2026-01-01T00:00:00.000Z"}


def outbox_view(rows=()):
    """`outbox` as a read-only view, so no statement here can write outbox rows."""
    columns = "id, kind, entity_id, url, body, temp_ids, status"
    if not rows:
        return f"CREATE VIEW outbox AS SELECT NULL id, NULL kind, NULL entity_id, NULL url, NULL body, NULL temp_ids, NULL status WHERE 0"
    selects = " UNION ALL ".join(
        "SELECT " + ", ".join(sqlite_literal(v) for v in row) for row in rows
    )
    return f"CREATE VIEW outbox({columns}) AS {selects}"


def sqlite_literal(value):
    if value is None:
        return "NULL"
    if isinstance(value, int):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


class Lab:
    def __init__(self, studio_dir, root):
        self.electron = studio_dir / "studio"
        self.bsqlite = studio_dir / "resources/app.asar.unpacked/node_modules/better-sqlite3"
        self.root = root
        self.counter = 0

    def new_db(self, rows=()):
        self.counter += 1
        directory = self.root / f"case{self.counter}"
        directory.mkdir()
        (directory / guard.MARKER).write_text("synthetic\n")
        db = directory / "db.sqlite"
        con = sqlite3.connect(db, isolation_level=None)
        con.execute("PRAGMA journal_mode=WAL")
        ddl = [s for s in SCHEMA.read_text().split(";\n\n") if s.strip()]
        for statement in ddl:
            if "outbox" not in statement and "sqlite_sequence" not in statement:
                con.execute(statement)
        con.execute(outbox_view(rows))
        con.execute(
            "INSERT INTO files (id, project_id, type, is_trashed, position, created_at, data, mirrored_at, user_id)"
            " VALUES ('f1','p','text',0,0,'t',?,0,'local')",
            (json.dumps(ORIGINAL),),
        )
        con.close()
        return db

    def holder(self, db):
        env = {"ELECTRON_RUN_AS_NODE": "1", "PATH": os.environ["PATH"], "HOME": str(self.root)}
        proc = subprocess.Popen(
            [str(self.electron), str(HERE / "studio_like.js"), str(self.bsqlite), str(db)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env,
        )
        return Holder(proc)


class Holder:
    def __init__(self, proc):
        self.proc = proc
        self.opened = self.line()

    def line(self):
        text = self.proc.stdout.readline()
        if not text:
            raise RuntimeError("holder died: " + self.proc.stderr.read()[-800:])
        return json.loads(text)

    def do(self, name):
        self.proc.stdin.write(name + "\n")
        self.proc.stdin.flush()
        return self.line()

    def stop(self):
        if self.proc.poll() is None:
            self.do("exit")
            self.proc.wait(10)

    def kill9(self):
        self.proc.send_signal(signal.SIGKILL)
        self.proc.wait(10)


def try_guard(db):
    started = time.monotonic()
    try:
        con = guard.acquire(db)
    except guard.Refused as refused:
        return {"acquired": False, "reason": refused.reason, "sqlite": refused.detail["sqlite"],
                "ms": round((time.monotonic() - started) * 1000, 1)}
    con.execute("ROLLBACK")
    con.close()
    return {"acquired": True, "ms": round((time.monotonic() - started) * 1000, 1)}


def content_of(db):
    con = sqlite3.connect(db, timeout=5)
    try:
        return json.loads(con.execute("SELECT data FROM files WHERE id='f1'").fetchone()[0])["content"]
    finally:
        con.close()


def row_of(db):
    con = sqlite3.connect(db, timeout=5)
    try:
        return con.execute("SELECT data FROM files WHERE id='f1'").fetchone()[0]
    finally:
        con.close()


def locks_on(db):
    """Kernel lock table entries for the database file."""
    inode = os.stat(db).st_ino
    return [line.split() for line in Path("/proc/locks").read_text().splitlines() if f":{inode} " in line]


# ---------------------------------------------------------------- experiments

def test_idle_studio_connection_holds_a_file_lock(lab):
    db = lab.new_db()
    holder = lab.holder(db)
    holder.do("read")
    time.sleep(0.5)
    locks = locks_on(db)
    holder.stop()
    pid = str(holder.opened["pid"])
    ours = [l for l in locks if pid in l]
    return {"pass": bool(ours) and all(l[3] == "READ" for l in ours), "holder_pid": pid, "proc_locks": ours,
            "sqlite_of_studio": holder.opened["sqlite"]}


def test_begin_immediate_is_not_a_guard(lab):
    db = lab.new_db()
    holder = lab.holder(db)
    holder.do("read")
    con = sqlite3.connect(db, isolation_level=None, timeout=0)
    con.execute("BEGIN IMMEDIATE")
    con.execute("ROLLBACK")
    con.close()
    holder.stop()
    return {"pass": True, "note": "BEGIN IMMEDIATE succeeded while another connection was open"}


def test_guard_refused_while_idle_connection_open(lab):
    db = lab.new_db()
    holder = lab.holder(db)
    holder.do("read")
    time.sleep(0.5)
    result = try_guard(db)
    holder.stop()
    return {"pass": not result["acquired"] and result["reason"] == "library-in-use", **result}


def test_guard_refused_during_studio_write_transaction(lab):
    db = lab.new_db()
    holder = lab.holder(db)
    holder.do("begin")
    result = try_guard(db)
    holder.do("commit")
    holder.stop()
    return {"pass": not result["acquired"], **result}


def test_begin_exclusive_alone_is_not_a_guard(lab):
    """Control: in WAL mode BEGIN EXCLUSIVE alone only excludes other writers."""
    db = lab.new_db()
    holder = lab.holder(db)
    holder.do("read")
    con = sqlite3.connect(db, isolation_level=None, timeout=0)
    con.execute("BEGIN EXCLUSIVE")
    con.execute("ROLLBACK")
    con.close()
    holder.stop()
    return {"pass": True, "note": "BEGIN EXCLUSIVE without the pragma succeeded while another connection was open"}


def test_pragma_after_earlier_read_still_refused(lab):
    """A read before the pragma, so the connection has already used shared memory."""
    db = lab.new_db()
    holder = lab.holder(db)
    holder.do("read")
    con = sqlite3.connect(db, isolation_level=None, timeout=0)
    con.execute("SELECT count(*) FROM files").fetchone()
    con.execute("PRAGMA locking_mode=EXCLUSIVE")
    try:
        con.execute("BEGIN EXCLUSIVE")
        outcome = "succeeded"
        con.execute("ROLLBACK")
    except sqlite3.OperationalError as error:
        outcome = str(error)
    con.close()
    holder.stop()
    return {"pass": outcome == "database is locked", "begin_exclusive": outcome}


def test_rollback_journal_database_is_refused(lab):
    """An idle rollback-journal connection holds no lock, so the guard must not pass it."""
    directory = lab.root / "rollback"
    directory.mkdir()
    db = directory / "db.sqlite"
    con = sqlite3.connect(db, isolation_level=None)
    con.execute("CREATE TABLE t(x)")
    idle = con.execute("SELECT count(*) FROM t").fetchone()
    try:
        guard.acquire(db)
        result = "acquired"
    except guard.Refused as refused:
        result = refused.reason
    con.close()
    return {"pass": result == "not-wal", "result": result, "idle_probe": idle[0]}


CLI_CAS = """.bail on
PRAGMA locking_mode=EXCLUSIVE;
BEGIN EXCLUSIVE;
CREATE TEMP TABLE guard_check(ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO temp.guard_check SELECT NOT EXISTS (
  SELECT 1 FROM outbox WHERE status IN ('pending','failed') AND (
    entity_id = {id} OR instr(coalesce(temp_ids,''), {id}) > 0
    OR instr(coalesce(url,''), {id}) > 0 OR instr(coalesce(body,''), {id}) > 0));
INSERT INTO temp.guard_check SELECT coalesce((SELECT data FROM files WHERE id = {id}) = {expected}, 0);
UPDATE files SET data = json_set(data, '$.content', {new}) WHERE id = {id};
COMMIT;
SELECT 'committed';
"""


def _run_cli_cas(db, expected, new):
    script = CLI_CAS.format(id=sqlite_literal("f1"), expected=sqlite_literal(expected), new=sqlite_literal(new))
    return subprocess.run([shutil.which("sqlite3"), str(db)], input=script, capture_output=True, text=True)


def test_sqlite3_cli_transactional_compare_and_swap(lab):
    """The whole check-and-write in one CLI invocation, which is the plugin's route."""
    clear = lab.new_db()
    done = _run_cli_cas(clear, row_of(clear), "cli write")
    clear_ok = done.returncode == 0 and "committed" in done.stdout and content_of(clear) == "cli write"

    stale = lab.new_db()
    before = row_of(stale)
    other = sqlite3.connect(stale, isolation_level=None)
    other.execute("UPDATE files SET data = json_set(data, '$.content', 'changed') WHERE id = 'f1'")
    current = row_of(stale)
    other.close()
    changed = _run_cli_cas(stale, before, "must not land")
    changed_ok = changed.returncode != 0 and "CHECK" in changed.stderr and row_of(stale) == current

    with_outbox = lab.new_db([(1, "file.update", "f1", "/files/f1/", '{"content":"old"}', None, "pending")])
    expected = row_of(with_outbox)
    outbox = _run_cli_cas(with_outbox, expected, "must not land")
    outbox_ok = outbox.returncode != 0 and "CHECK" in outbox.stderr and row_of(with_outbox) == expected

    busy_db = lab.new_db()
    holder = lab.holder(busy_db)
    holder.do("read")
    time.sleep(0.3)
    expected = row_of(busy_db)
    busy = _run_cli_cas(busy_db, expected, "must not land")
    holder.stop()
    busy_ok = busy.returncode != 0 and "locked" in busy.stderr and row_of(busy_db) == expected

    return {"pass": clear_ok and changed_ok and outbox_ok and busy_ok,
            "clear": {"exit": done.returncode, "ok": clear_ok},
            "changed_since_read": {"exit": changed.returncode, "stderr": changed.stderr.strip(), "ok": changed_ok},
            "stale_outbox": {"exit": outbox.returncode, "stderr": outbox.stderr.strip(), "ok": outbox_ok},
            "studio_like_running": {"exit": busy.returncode, "stderr": busy.stderr.strip(), "ok": busy_ok}}


def _hold_then_open(lab, hold_seconds):
    db = lab.new_db()
    release = threading.Event()
    acquired = threading.Event()
    errors = []

    def writer():
        try:
            guard.write_text(db, "f1", row_of(db), "written under guard",
                             hold=lambda: (acquired.set(), release.wait(30)))
        except Exception as error:  # pylint: disable=broad-except
            errors.append(repr(error))
            acquired.set()

    thread = threading.Thread(target=writer)
    thread.start()
    acquired.wait(10)
    timer = threading.Timer(hold_seconds, release.set)
    timer.start()
    holder = lab.holder(db)
    result = dict(holder.opened)
    if result["ok"]:
        result["content_seen"] = holder.do("read").get("content")
        holder.stop()
    timer.join()
    release.set()
    thread.join()
    result["writer_errors"] = errors
    return result


def test_new_studio_waits_then_sees_commit(lab):
    result = _hold_then_open(lab, 1.5)
    return {"pass": result["ok"] and result["content_seen"] == "written under guard" and result["ms"] >= 1000, **result}


def test_new_studio_errors_if_guard_outlasts_busy_timeout(lab):
    result = _hold_then_open(lab, 7.0)
    return {"pass": (not result["ok"]) and result.get("code") == "SQLITE_BUSY" and result["ms"] >= 4500, **result}


def test_stale_lock_free_after_studio_sigkill_and_wal_recovered(lab):
    db = lab.new_db()
    holder = lab.holder(db)
    holder.do("write")
    wal = Path(str(db) + "-wal")
    wal_size = wal.stat().st_size if wal.exists() else 0
    holder.kill9()
    before = try_guard(db)
    seen = content_of(db)
    return {"pass": before["acquired"] and seen == "written by studio-like process" and wal_size > 0,
            "wal_bytes_at_kill": wal_size, "guard": before, "content_recovered": seen}


def test_guard_after_clean_close(lab):
    db = lab.new_db()
    holder = lab.holder(db)
    holder.do("write")
    holder.stop()
    result = try_guard(db)
    return {"pass": result["acquired"], **result}


def test_writer_killed_mid_transaction_leaves_library_intact(lab):
    db = lab.new_db()
    before = row_of(db)
    script = (
        "import sys, os, signal\n"
        f"sys.path.insert(0, {str(HERE)!r})\n"
        "import guard\n"
        f"guard.write_text({str(db)!r}, 'f1', {before!r}, 'torn', hold=lambda: os.kill(os.getpid(), signal.SIGKILL))\n"
    )
    done = subprocess.run([sys.executable, "-I", "-c", script], capture_output=True, text=True)
    guard_after = try_guard(db)
    con = sqlite3.connect(db)
    integrity = con.execute("PRAGMA integrity_check").fetchone()[0]
    con.close()
    return {"pass": done.returncode == -signal.SIGKILL and row_of(db) == before and guard_after["acquired"] and integrity == "ok",
            "writer_exit": done.returncode, "integrity": integrity, "guard_after": guard_after}


def test_write_commits_when_clear(lab):
    db = lab.new_db()
    guard.write_text(db, "f1", row_of(db), "written under guard")
    holder = lab.holder(db)
    seen = holder.do("read")["content"]
    holder.stop()
    return {"pass": seen == "written under guard", "content_seen_by_studio_like": seen}


def test_compare_and_swap_detects_change(lab):
    db = lab.new_db()
    stale = row_of(db)
    holder = lab.holder(db)
    holder.do("write")
    holder.stop()
    current = row_of(db)
    try:
        guard.write_text(db, "f1", stale, "must not land")
        return {"pass": False}
    except guard.Refused as refused:
        return {"pass": refused.reason == "changed-since-read" and row_of(db) == current, "reason": refused.reason}


def _refused_by_outbox(lab, rows):
    db = lab.new_db(rows)
    before = row_of(db)
    wal_before = Path(str(db) + "-wal").exists()
    try:
        guard.write_text(db, "f1", before, "must not land")
    except guard.Refused as refused:
        return {"refused": refused.reason, "rows": refused.detail.get("rows"), "row_unchanged": row_of(db) == before,
                "wal_existed_before": wal_before}
    return {"refused": None, "row_unchanged": row_of(db) == before}


def test_outbox_matrix(lab):
    cases = {
        "pending_update_entity": ((1, "file.update", "f1", "/files/f1/", '{"content":"old"}', None, "pending"), "stale-outbox"),
        "failed_update_entity": ((1, "file.update", "f1", "/files/f1/", '{"content":"old"}', None, "failed"), "stale-outbox"),
        "pending_create": ((1, "file.create", "f1", "/projects/p/files/", '{"name":"x"}', None, "pending"), "stale-outbox"),
        "temp_id_reference": ((1, "file.update", "server-9", "/files/server-9/", "{}", '["f1"]', "pending"), "stale-outbox"),
        "url_reference_only": ((1, "items.reorder", None, "/files/f1/move/", "{}", None, "pending"), "stale-outbox"),
        "body_reference_only": ((1, "items.reorder", None, "/x/", '{"order":["f1"]}', None, "pending"), "stale-outbox"),
        "malformed_body": ((1, "file.update", "f1", "/files/f1/", "{not json", None, "pending"), "stale-outbox"),
        "other_entity_only": ((1, "file.update", OTHER_ID, f"/files/{OTHER_ID}/", '{"content":"x"}', None, "pending"), None),
        "no_rows": (None, None),
    }
    results = {}
    ok = True
    for name, (row, expected) in cases.items():
        result = _refused_by_outbox(lab, [row] if row else [])
        results[name] = result
        passed = result["refused"] == expected and result["row_unchanged"] == (expected is not None)
        result["pass"] = passed
        ok = ok and passed
    return {"pass": ok, "cases": results}


def test_no_writer_can_interleave_during_guard(lab):
    db = lab.new_db()
    release = threading.Event()
    acquired = threading.Event()
    outcome = {}

    def writer():
        guard.write_text(db, "f1", row_of(db), "written under guard", hold=lambda: (acquired.set(), release.wait(30)))

    thread = threading.Thread(target=writer)
    thread.start()
    acquired.wait(10)
    other = sqlite3.connect(db, isolation_level=None, timeout=0)
    for name, statement in (("read", "SELECT count(*) FROM files"), ("write", "UPDATE metadata SET value=value")):
        try:
            other.execute(statement).fetchall()
            outcome[name] = "succeeded"
        except sqlite3.OperationalError as error:
            outcome[name] = str(error)
    other.close()
    release.set()
    thread.join()
    return {"pass": all(v == "database is locked" for v in outcome.values()), **outcome}


def test_sqlite3_cli_guard(lab):
    """The plugin currently shells out to sqlite3, so check that route too."""
    cli = shutil.which("sqlite3")
    script = ".bail on\nPRAGMA locking_mode=EXCLUSIVE;\nBEGIN EXCLUSIVE;\nSELECT 'acquired';\nROLLBACK;\n"
    db = lab.new_db()
    holder = lab.holder(db)
    holder.do("read")
    time.sleep(0.3)
    with_holder = subprocess.run([cli, str(db)], input=script, capture_output=True, text=True)
    holder.stop()
    alone = subprocess.run([cli, str(db)], input=script, capture_output=True, text=True)
    return {
        "pass": with_holder.returncode != 0 and "locked" in with_holder.stderr and "acquired" not in with_holder.stdout
        and alone.returncode == 0 and "acquired" in alone.stdout,
        "with_studio_like": {"exit": with_holder.returncode, "stderr": with_holder.stderr.strip()},
        "alone": {"exit": alone.returncode, "stdout": alone.stdout.strip()},
    }


def test_plugin_readonly_cli_also_blocks_guard_briefly(lab):
    """A concurrent import read counts as in use, which fails closed."""
    db = lab.new_db()
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, isolation_level=None)
    con.execute("BEGIN")
    con.execute("SELECT count(*) FROM files").fetchall()
    result = try_guard(db)
    con.execute("COMMIT")
    con.close()
    after = try_guard(db)
    return {"pass": not result["acquired"] and after["acquired"], "during_read": result, "after_read": after}


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--studio-dir", type=Path, required=True)
    parser.add_argument("--out", type=Path, default=HERE / "evidence" / "sqlite_lab.json")
    args = parser.parse_args()
    root = Path(tempfile.mkdtemp(prefix="studio-guard-lab-"))
    lab = Lab(args.studio_dir.resolve(), root)
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    results = {}
    try:
        for test in tests:
            name = test.__name__[5:]
            try:
                results[name] = test(lab)
            except Exception as error:  # pylint: disable=broad-except
                results[name] = {"pass": False, "exception": repr(error)}
            print(("PASS " if results[name]["pass"] else "FAIL ") + name, flush=True)
    finally:
        shutil.rmtree(root, ignore_errors=True)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    report = {
        "python_sqlite": sqlite3.sqlite_version,
        "cli_sqlite": subprocess.run(["sqlite3", "--version"], capture_output=True, text=True).stdout.split()[0],
        "results": results,
    }
    args.out.write_text(json.dumps(report, indent=1, sort_keys=True) + "\n")
    failed = [k for k, v in results.items() if not v["pass"]]
    print(f"{len(results) - len(failed)}/{len(results)} passed; report: {args.out}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
