#!/usr/bin/env python3
"""Real-Studio experiments for the closed-Studio guard (issue #5).

Studio runs in a bubblewrap jail with no network, an empty home and a fresh
synthetic library. The guard runs outside the jail, in a different PID, UTS and
mount namespace, on the same database inode through a bind mount. That is the
same arrangement as a Flatpak Obsidian beside a native Studio.

Nothing here opens a real library, reads credentials or contacts a server. No
statement issued here writes to the outbox. Rows in `outbox` come only from the
real Studio storing its own local edits in the synthetic library.

Usage: lab_studio.py --studio-dir DIR --xvfb PATH [--out report.json]
"""
import argparse
import hashlib
import json
import os
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import guard

HERE = Path(__file__).resolve().parent
DB_REL = "config/studio-desktop/byokwa/db.sqlite"
LOCK_REL = "config/studio-desktop/SingletonLock"
CLEAN_ID = "guard-clean-file"


class Jail:
    """One jail: Xvfb plus the driver. Studio launches are driver commands."""

    def __init__(self, work, studio_dir, xvfb):
        command = [
            "timeout", "300", "bwrap", "--unshare-all", "--die-with-parent", "--new-session", "--clearenv",
            "--setenv", "HOME", "/home/synthetic",
            "--setenv", "XDG_CONFIG_HOME", "/work/config",
            "--setenv", "PATH", "/usr/bin", "--setenv", "LANG", "C.UTF-8",
            "--setenv", "ELECTRON_RUN_AS_NODE", "1",
            "--ro-bind", "/usr", "/usr", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib", "/lib64",
            "--symlink", "usr/bin", "/bin", "--symlink", "usr/bin", "/sbin",
            "--ro-bind-try", "/etc/fonts", "/etc/fonts", "--ro-bind-try", "/etc/ld.so.cache", "/etc/ld.so.cache",
            "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", "/tmp/.X11-unix",
            "--tmpfs", "/home", "--dir", "/home/synthetic", "--dir", "/run",
            "--ro-bind", str(studio_dir), "/opt/studio/electron",
            "--ro-bind", str(xvfb), "/opt/xvfb/Xvfb",
            "--ro-bind", str(HERE), "/driver",
            "--bind", str(work), "/work",
            "/opt/studio/electron/studio", "/driver/studio_driver.js",
        ]
        self.proc = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        self.hello = self._read()
        if self.hello.get("interfaces") != ["lo"]:
            self.proc.kill()
            raise RuntimeError(f"jail is not network-isolated: {self.hello}")

    def _read(self):
        line = self.proc.stdout.readline()
        if not line:
            raise RuntimeError("driver exited")
        return json.loads(line)

    def __call__(self, cmd, **args):
        self.proc.stdin.write(json.dumps({"cmd": cmd, **args}) + "\n")
        self.proc.stdin.flush()
        return self._read()

    def close(self):
        try:
            self("end")
        except (RuntimeError, BrokenPipeError):
            pass
        self.proc.wait(15)


def holders(db):
    """Host PIDs with the database open, found by inode so namespaces do not matter."""
    target = os.stat(db)
    found = []
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            for fd in (entry / "fd").iterdir():
                try:
                    stat = os.stat(fd)
                except OSError:
                    continue
                if (stat.st_ino, stat.st_dev) == (target.st_ino, target.st_dev):
                    found.append(int(entry.name))
                    break
        except OSError:
            continue
    return sorted(set(found))


def locks_on(db):
    inode = os.stat(db).st_ino
    return [line.split()[1:6] for line in Path("/proc/locks").read_text().splitlines() if f":{inode} " in line]


def probe(db):
    started = time.monotonic()
    try:
        con = guard.acquire(db)
    except guard.Refused as refused:
        return {"acquired": False, "reason": refused.reason, "sqlite": refused.detail["sqlite"], "ms": round((time.monotonic() - started) * 1000, 1)}
    con.execute("ROLLBACK")
    con.close()
    return {"acquired": True, "ms": round((time.monotonic() - started) * 1000, 1)}


def begin_immediate_control(db):
    """The check the current experiment uses. Rolled back, so it writes nothing."""
    con = sqlite3.connect(db, isolation_level=None, timeout=0)
    try:
        con.execute("BEGIN IMMEDIATE")
        con.execute("ROLLBACK")
        return "succeeded"
    except sqlite3.OperationalError as error:
        return str(error)
    finally:
        con.close()


def read_only(db):
    return sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=5)


def outbox_fingerprint(db):
    con = read_only(db)
    try:
        rows = con.execute("SELECT * FROM outbox ORDER BY id").fetchall()
    finally:
        con.close()
    return {"count": len(rows), "sha256": hashlib.sha256(repr(rows).encode()).hexdigest(),
            "kinds": sorted({(r[2], r[10] if len(r) > 10 else None) for r in rows})}


def row_data(db, file_id):
    con = read_only(db)
    try:
        return con.execute("SELECT data FROM files WHERE id=?", (file_id,)).fetchone()[0]
    finally:
        con.close()


def integrity(db):
    con = sqlite3.connect(db, timeout=5)
    try:
        return con.execute("PRAGMA integrity_check").fetchone()[0]
    finally:
        con.close()


def singleton(work):
    path = work / LOCK_REL
    return os.readlink(path) if path.is_symlink() else None


def log_tail(work, n):
    path = work / f"studio-{n}.log"
    return path.read_text(errors="replace")[-1200:] if path.exists() else None


def wait_for_holder(db, seconds):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        found = holders(db)
        # Our own guard connection is in this process and is excluded.
        found = [p for p in found if p != os.getpid()]
        if found:
            return found
        time.sleep(0.05)
    return []


def scenario_launch_during_guard(work, studio_dir, xvfb, db, marker, hold_after_open):
    """Hold the guard, start Studio, and keep holding once Studio has the file open."""
    jail = Jail(work, studio_dir, xvfb)
    timeline = {}
    before = row_data(db, CLEAN_ID)

    def hold():
        timeline["guard_held_refuses_reader"] = reader_blocked(db)
        timeline["launch"] = jail("launch_nowait")
        timeline["holder_pids_during_hold"] = wait_for_holder(db, 15)
        time.sleep(hold_after_open)

    guard.write_text(db, CLEAN_ID, before, marker, hold=hold)
    timeline["attach"] = jail("attach", timeout_ms=25000)
    timeline["status"] = jail("status")
    return jail, timeline


def reader_blocked(db):
    con = sqlite3.connect(db, isolation_level=None, timeout=0)
    try:
        con.execute("SELECT count(*) FROM files").fetchall()
        return False
    except sqlite3.OperationalError:
        return True
    finally:
        con.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--studio-dir", type=Path, required=True)
    parser.add_argument("--xvfb", type=Path, required=True)
    parser.add_argument("--out", type=Path, default=HERE / "evidence" / "studio_lab.json")
    args = parser.parse_args()
    studio_dir, xvfb = args.studio_dir.resolve(), args.xvfb.resolve()
    work = Path(tempfile.mkdtemp(prefix="studio-guard-real-"))
    (work / guard.MARKER).write_text("synthetic data only; safe to delete\n")
    db = work / DB_REL
    report = {"studio_asar_sha256": hashlib.sha256((studio_dir / "resources/app.asar").read_bytes()).hexdigest(),
              "xvfb_sha256": hashlib.sha256(xvfb.read_bytes()).hexdigest()}
    try:
        run(work, studio_dir, xvfb, db, report)
    except Exception as error:  # pylint: disable=broad-except
        report["aborted"] = repr(error)
        raise
    finally:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        text = json.dumps(report, indent=1, sort_keys=True, default=str) + "\n"
        args.out.write_text(text.replace(socket.gethostname(), "HOST"))
        shutil.rmtree(work, ignore_errors=True)
    print("report:", args.out)
    return 0


def run(work, studio_dir, xvfb, db, report):
    # Seed through the real UI, so Studio writes its own outbox rows.
    jail = Jail(work, studio_dir, xvfb)
    seed = {"jail": jail.hello, "launch": jail("launch")}
    seed["created"] = jail("seed")
    file_id = seed["created"]["file_id"]
    seed["lock_while_running"] = singleton(work)
    seed["quit"] = jail("quit")
    jail.close()
    seed["lock_after_clean_exit"] = singleton(work)
    seed["guard_after_clean_exit"] = probe(db)
    seed["outbox"] = outbox_fingerprint(db)
    report["seed"] = seed
    print("seed done", flush=True)

    # A record with no outbox rows, for the positive write path. Inserted only
    # while Studio is closed. Only `files` is written.
    con = sqlite3.connect(db, isolation_level=None, timeout=5)
    con.execute(
        "INSERT INTO files (id,user_id,project_id,folder_id,type,is_trashed,position,created_at,data,mirrored_at)"
        " SELECT ?,user_id,project_id,folder_id,type,is_trashed,position+1,created_at,"
        " json_set(data,'$.id',?,'$.name','Clean','$.content','<p>clean</p>'),mirrored_at FROM files WHERE id=?",
        (CLEAN_ID, CLEAN_ID, file_id),
    )
    con.close()

    # R1: running Studio, idle then after edits.
    jail = Jail(work, studio_dir, xvfb)
    r1 = {"launch": jail("launch")}
    time.sleep(1)
    r1["holders"] = holders(db)
    r1["locks_idle"] = locks_on(db)
    r1["singleton_lock_from_host"] = singleton(work)
    r1["guard_idle"] = probe(db)
    r1["begin_immediate_control_idle"] = begin_immediate_control(db)
    r1["second_instance"] = jail("second_instance")
    r1["guard_after_second_instance"] = probe(db)
    r1["edit"] = jail("open_and_edit")
    r1["locks_after_edit"] = locks_on(db)
    r1["guard_polls_after_edit"] = []
    for _ in range(8):
        r1["guard_polls_after_edit"].append(probe(db))
        time.sleep(2.5)
    r1["refused_write_while_running"] = None
    before = row_data(db, CLEAN_ID)
    try:
        guard.write_text(db, CLEAN_ID, before, "<p>must not land</p>")
        r1["refused_write_while_running"] = "WROTE"
    except guard.Refused as refused:
        r1["refused_write_while_running"] = refused.reason
    r1["row_unchanged"] = row_data(db, CLEAN_ID) == before
    r1["quit"] = jail("quit")
    jail.close()
    r1["lock_after_clean_exit"] = singleton(work)
    report["r1_running"] = r1
    print("r1 done", flush=True)

    # R1b: closed Studio, real outbox rows.
    closed = {"guard": probe(db), "outbox_before": outbox_fingerprint(db)}
    data = row_data(db, file_id)
    try:
        guard.write_text(db, file_id, data, "<p>must not land</p>")
        closed["ui_created_file"] = "WROTE"
    except guard.Refused as refused:
        closed["ui_created_file"] = {"reason": refused.reason, "rows": refused.detail.get("rows")}
    closed["ui_file_row_unchanged"] = row_data(db, file_id) == data
    closed["outbox_after"] = outbox_fingerprint(db)
    closed["integrity"] = integrity(db)
    report["closed_real_outbox"] = closed

    # R2: Studio started while the guard is held briefly, then SIGKILL.
    marker = "<p>written during launch</p>"
    jail, r2 = scenario_launch_during_guard(work, studio_dir, xvfb, db, marker, 2.0)
    r2["holders_after"] = holders(db)
    r2["file_seen_by_studio"] = jail("get_file", id=CLEAN_ID)
    r2["content_is_committed_write"] = marker in json.dumps(r2["file_seen_by_studio"])
    r2["guard_refused_after_boot"] = probe(db)
    r2["kill9"] = jail("kill9")
    r2["holders_after_kill"] = holders(db)
    r2["singleton_lock_after_kill"] = singleton(work)
    r2["guard_after_kill"] = probe(db)
    r2["integrity_after_kill"] = integrity(db)
    # R4: relaunch over the stale lock left by SIGKILL.
    r2["relaunch_over_stale_lock"] = jail("launch")
    r2["guard_refused_after_relaunch"] = probe(db)
    r2["quit"] = jail("quit")
    jail.close()
    r2["log"] = log_tail(work, 1)
    report["r2_r4_launch_during_guard_and_sigkill"] = r2
    print("r2 done", flush=True)

    # R3: guard held past better-sqlite3's 5 s busy timeout during Studio's open.
    marker = "<p>written during long hold</p>"
    jail, r3 = scenario_launch_during_guard(work, studio_dir, xvfb, db, marker, 8.0)
    r3["log"] = log_tail(work, 1)
    r3["holders_after"] = holders(db)
    r3["locks_after"] = locks_on(db)
    r3["kill"] = jail("kill9") if r3["status"].get("alive") else None
    r3["status_after_kill"] = jail("status")
    jail.close()
    r3["guard_after"] = probe(db)
    r3["integrity"] = integrity(db)
    r3["row_has_committed_write"] = marker in row_data(db, CLEAN_ID)
    report["r3_guard_outlasts_busy_timeout"] = r3
    print("r3 done", flush=True)

    # R5: foreign SingletonLock content, as a test of the lock as a mutex.
    lock = work / LOCK_REL
    host = (r1["singleton_lock_from_host"] or "unknown-1").rsplit("-", 1)[0]
    for label, target in (("same_host_dead_pid", f"{host}-999999"), ("other_host_dead_pid", "other-machine-999999")):
        if lock.is_symlink():
            lock.unlink()
        lock.symlink_to(target)
        jail = Jail(work, studio_dir, xvfb)
        r5 = {"planted": target, "launch": jail("launch", timeout_ms=20000)}
        r5["status"] = jail("status")
        r5["lock_during"] = singleton(work)
        r5["log"] = log_tail(work, 1)
        r5["guard"] = probe(db)
        if r5["status"].get("alive"):
            r5["quit"] = jail("quit") if r5["launch"].get("page") else jail("kill9")
        jail.close()
        if lock.is_symlink():
            lock.unlink()
        report[f"r5_{label}"] = r5
        print("r5", label, "done", flush=True)


if __name__ == "__main__":
    sys.exit(main())
