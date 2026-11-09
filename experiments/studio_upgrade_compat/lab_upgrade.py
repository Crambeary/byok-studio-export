#!/usr/bin/env python3
"""Does a library made by an older Studio build survive upgrade and guarded write? (issue #5)

Boots Studio 0.5.2, verified and staged by obtain_build.py, then the tested 1.1.3
on the same synthetic library, inside a bubblewrap jail with only a loopback
interface and an empty home. Then runs the current `guardedWrite` from src/, with
its real environment check, on disposable copies, and reopens the results in 1.1.3.

No statement issued here writes to the outbox. Rows Studio queues during UI edits
are Studio's own, and are only read and hashed.

Usage: lab_upgrade.py --old-dir DIR --new-dir DIR --xvfb PATH [--out report.json]
"""
import argparse
import hashlib
import json
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
sys.path.insert(0, str(HERE.parent / "studio_write_guard"))
DB_REL = Path("config/studio-desktop/byokwa/db.sqlite")
MARKER = "DISPOSABLE_SYNTHETIC_LIBRARY"
OLD_ASAR = "7f73eccbc1fdee8caaa3f0e7c04154bebc3eb75767df901747765051b0044980"
NEW_ASAR = "25e93b78fb4753f7b47236a91f8907e674c341aab19af271d93c7dd1e04dbcfa"
XVFB = "ffe89f25f4aa76a7c97d72bd4fa8b74d8304a1b4811a70a2614b0c953c241396"
WRITTEN = "<p>Written by the current guard after the upgrade.</p>"
WRITTEN_TWO = "<p>Guarded first paragraph after the upgrade.</p><p>Guarded second paragraph after the upgrade.</p>"
EDITOR_EXPECT = {
    "upgrade-plain": "Written by the current guard",
    "upgrade-studio-html": "Guarded second paragraph",
    "upgrade-folder-file": "Written by the current guard",
    "upgrade-extra-keys": "Written by the current guard",
}
PATHS = {
    "upgrade-plain": ["Synthetic Plain Record"],
    "upgrade-studio-html": ["Synthetic Studio HTML Record"],
    "upgrade-folder-file": ["Synthetic Folder Record"],
    "upgrade-extra-keys": ["Synthetic Extra Keys Record"],
}
USER_NULL_REFUSAL = "project/folder ancestor"
OUTBOX_REFUSAL = "Outbox references this file"


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def library_sha(db):
    """Hash of the main database and its WAL, so a refusal cannot hide in either."""
    parts = sorted(Path(db).parent.glob("db.sqlite*"))
    return {p.name: sha(p) for p in parts if not p.name.endswith("-shm")}


def text_sha(value):
    return hashlib.sha256(str(value).encode()).hexdigest()


def jail(work, studio_dir, xvfb, phase):
    argv = [
        "timeout", "240", "bwrap", "--unshare-all", "--die-with-parent", "--new-session", "--clearenv",
        "--setenv", "HOME", "/home/synthetic", "--setenv", "XDG_CONFIG_HOME", "/work/config",
        "--setenv", "PATH", "/usr/bin", "--setenv", "LANG", "C.UTF-8", "--setenv", "ELECTRON_RUN_AS_NODE", "1",
        "--ro-bind", "/usr", "/usr", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib", "/lib64",
        "--symlink", "usr/bin", "/bin", "--symlink", "usr/bin", "/sbin",
        "--ro-bind-try", "/etc/fonts", "/etc/fonts", "--ro-bind-try", "/etc/ld.so.cache", "/etc/ld.so.cache",
        "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", "/tmp/.X11-unix",
        "--tmpfs", "/home", "--dir", "/home/synthetic", "--dir", "/run",
        "--ro-bind", str(studio_dir), "/opt/studio/electron", "--ro-bind", str(xvfb), "/opt/xvfb/Xvfb",
        "--ro-bind", str(HERE), "/driver", "--bind", str(work), "/work",
        "/opt/studio/electron/studio", "/driver/driver.js", phase,
    ]
    print(f"== {phase} on {studio_dir.parent.name}", flush=True)
    done = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    path = work / f"{phase}.json"
    if not path.exists():
        sys.exit(f"phase {phase} produced no report (exit {done.returncode}):\n{done.stdout[-2000:]}")
    report = json.loads(path.read_text())
    path.unlink()
    if report.get("error"):
        sys.exit(f"phase {phase} failed: {report['error']}")
    if report["jail_network_interfaces"] != ["lo"]:
        sys.exit("jail was not network-isolated")
    return report


def connect_ro(db):
    return sqlite3.connect(f"file:{db}?mode=ro", uri=True)


def snapshot(db):
    con = connect_ro(db)
    try:
        schema = sorted(con.execute("SELECT type,name,sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*'").fetchall(), key=repr)
        files = {
            r[0]: {
                "user_id": r[1], "project_id": r[2], "folder_id": r[3], "type": r[4], "is_trashed": r[5],
                "position": r[6], "created_at": r[7], "data": r[8], "data_sha256": text_sha(r[8]),
            }
            for r in con.execute("SELECT id,user_id,project_id,folder_id,type,is_trashed,position,created_at,data FROM files")
        }
        tables = {}
        for kind, name, _ in schema:
            if kind == "table" and name not in ("metadata", "telemetry_queue"):
                rows = con.execute(f'SELECT * FROM "{name}"').fetchall()
                tables[name] = {"count": len(rows), "sha256": text_sha(repr(sorted(rows, key=repr)))}
        meta = dict(con.execute("SELECT key, value FROM metadata WHERE key <> 'authToken'").fetchall())
        outbox = [
            {"id": r[0], "kind": r[1], "entity_id": r[2], "method": r[3], "url": r[4], "status": r[5], "body_sha256": text_sha(r[6] or "")}
            for r in con.execute("SELECT id,kind,entity_id,method,url,status,body FROM outbox ORDER BY id")
        ]
        versions = con.execute("SELECT id,file_id,reason,fingerprint FROM local_versions ORDER BY id").fetchall()
        return {
            "schema": schema,
            "schema_sha256": text_sha(repr(schema)),
            "files": files,
            "projects": dict(con.execute("SELECT id, data FROM projects").fetchall()),
            "tables": tables,
            "metadata": {k: v for k, v in meta.items() if not k.startswith(("spelling.", "theme"))},
            "auth_token_rows": con.execute("SELECT count(*) FROM metadata WHERE key='authToken'").fetchone()[0],
            "outbox": outbox,
            "local_versions": versions,
            "integrity": con.execute("PRAGMA integrity_check").fetchone()[0],
            "foreign_key_violations": len(con.execute("PRAGMA foreign_key_check").fetchall()),
            "user_version": con.execute("PRAGMA user_version").fetchone()[0],
            "application_id": con.execute("PRAGMA application_id").fetchone()[0],
        }
    finally:
        con.close()


def schema_report(snap):
    tested = json.loads((REPO / "src/tested-schema.json").read_text())
    tested_map = {(t, n): s for t, n, s in tested}
    actual = {(t, n): s for t, n, s in snap["schema"]}
    return {
        "object_count": len(actual),
        "tested_object_count": len(tested_map),
        "identical_to_tested": actual == tested_map,
        "missing_objects": sorted(map(list, set(tested_map) - set(actual))),
        "extra_objects": sorted(map(list, set(actual) - set(tested_map))),
        "text_differs": sorted(list(k) for k in set(actual) & set(tested_map) if actual[k] != tested_map[k]),
    }


def copy_library(source, destination):
    if destination.exists():
        shutil.rmtree(destination)
    destination.mkdir(parents=True)
    (destination / MARKER).write_text("synthetic data only; safe to delete\n")
    for path in Path(source).glob("db.sqlite*"):
        shutil.copy2(path, destination / path.name)
    return destination / "db.sqlite"


def guard(db, file_id, html, asar):
    done = subprocess.run(["node", str(HERE / "run_guard.js"), str(db), file_id, html, str(asar)],
                          capture_output=True, text=True, timeout=60)
    if not done.stdout.strip():
        return {"accepted": False, "reason": f"harness failure: {done.stderr[-300:]}"}
    return json.loads(done.stdout)


def compare(before, after, written_id=None):
    changed = sorted(k for k in set(before["files"]) | set(after["files"]) if before["files"].get(k) != after["files"].get(k))
    tables = sorted(k for k in set(before["tables"]) | set(after["tables"]) if before["tables"].get(k) != after["tables"].get(k))
    return {
        "files_changed": changed,
        "other_files_changed": [k for k in changed if k != written_id],
        "tables_changed": tables,
        "outbox_unchanged": before["outbox"] == after["outbox"],
        "schema_unchanged": before["schema_sha256"] == after["schema_sha256"],
    }


def attempt(label, library, file_id, html, asar, root, snap_before):
    db = copy_library(library, root / "guard" / label)
    bytes_before = library_sha(db)
    result = guard(db, file_id, html, asar)
    snap_after = snapshot(db)
    old_json = json.loads(snap_before["files"][file_id]["data"])
    new_json = json.loads(snap_after["files"][file_id]["data"])
    volatile = {"content", "updatedAt", "contentUpdatedAt"}
    fingerprint = hashlib.sha256(json.dumps({"c": old_json.get("content"), "e": None}, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
    return db, {
        "preimage_version_kept": any(v[1] == file_id and v[2] == "manual" and v[3] == fingerprint for v in snap_after["local_versions"]),
        "only_content_and_times_changed": {k: v for k, v in old_json.items() if k not in volatile} == {k: v for k, v in new_json.items() if k not in volatile},
        "label": label, "file_id": file_id, "result": result,
        "bytes_unchanged": library_sha(db) == bytes_before,
        "wal_left_behind": Path(f"{db}-wal").exists(),
        "difference": compare(snap_before, snap_after, file_id),
        "content_after": json.loads(snap_after["files"][file_id]["data"]).get("content") if file_id in snap_after["files"] else None,
    }, snap_after


def reopen(root, label, base_work, db_written, new_dir, xvfb, target, edit_id, asar):
    work = root / "reopen" / label
    if work.exists():
        shutil.rmtree(work)
    shutil.copytree(base_work, work)
    live_dir = work / DB_REL.parent
    for path in live_dir.glob("db.sqlite*"):
        path.unlink()
    shutil.copy2(db_written, live_dir / "db.sqlite")
    (work / "target.json").write_text(json.dumps(target))
    before = snapshot(live_dir / "db.sqlite")
    read = jail(work, new_dir, xvfb, "read")
    after_read = snapshot(live_dir / "db.sqlite")
    (work / "target.json").write_text(json.dumps({**target, "edit_id": edit_id, "edit_path": PATHS[edit_id]}))
    edit = jail(work, new_dir, xvfb, "ui-edit")
    after_edit = snapshot(live_dir / "db.sqlite")
    _, later, _ = attempt(f"after_ui_edit_{label}", live_dir, edit_id, WRITTEN, asar, root, after_edit)
    return {
        "guard_after_ui_edit": later,
        "read_after_guarded_write": {"file": read["files"][edit_id], "stats": read["stats"], "studio_exit": read["studio_exit"]},
        "boot_changed": compare(before, after_read, None),
        "after_ui_edit": {"editor_html": edit["editor_html"], "file": edit["after_edit"], "versions": edit["versions"], "studio_exit": edit["studio_exit"]},
        "ui_edit_changed": compare(after_read, after_edit, edit_id),
        "integrity": after_edit["integrity"],
        "foreign_key_violations": after_edit["foreign_key_violations"],
        "outbox_after_ui_edit": after_edit["outbox"],
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--old-dir", type=Path, required=True)
    ap.add_argument("--new-dir", type=Path, required=True)
    ap.add_argument("--xvfb", type=Path, required=True)
    ap.add_argument("--workdir", type=Path)
    ap.add_argument("--keep", action="store_true", help="keep the synthetic work directory for inspection")
    ap.add_argument("--out", type=Path, default=HERE / "evidence/upgrade_lab.json")
    args = ap.parse_args()
    old_dir, new_dir, xvfb = args.old_dir.resolve(), args.new_dir.resolve(), args.xvfb.resolve()
    for path, expected in ((old_dir / "resources/app.asar", OLD_ASAR), (new_dir / "resources/app.asar", NEW_ASAR), (xvfb, XVFB)):
        if sha(path) != expected:
            sys.exit(f"refused: unexpected hash for {path}")
    sql_version = subprocess.run(["sqlite3", "--version"], capture_output=True, text=True).stdout.split()[0]
    if sql_version != "3.53.4":
        sys.exit("refused: guarded write needs sqlite3 3.53.4")

    root = Path(tempfile.mkdtemp(prefix="studio-upgrade-lab-", dir=args.workdir))
    work = root / "library"
    (work / "config").mkdir(parents=True)
    (work / MARKER).write_text("synthetic data only; safe to delete\n")
    db = work / DB_REL
    asar = new_dir / "resources/app.asar"
    try:
        seed = jail(work, old_dir, xvfb, "seed")
        target = {"project_id": seed["project_id"], "ui_file_id": seed["ui_file_id"], "bridge_ids": seed["bridge_ids"]}
        (work / "target.json").write_text(json.dumps(target))
        old_read = jail(work, old_dir, xvfb, "read")
        before_upgrade = snapshot(db)

        ids = [target["ui_file_id"], *target["bridge_ids"]]
        attempts = []
        # The real 1.1.3 asar is passed, so only database-level checks can refuse.
        pre_upgrade_root = root / "pre"
        for file_id in ids:
            _, entry, _ = attempt(f"pre_upgrade_{file_id}", db.parent, file_id, WRITTEN, asar, pre_upgrade_root, before_upgrade)
            attempts.append(entry)

        upgrade = jail(work, new_dir, xvfb, "read")
        after_upgrade = snapshot(db)
        library_snapshot = root / "upgraded"
        shutil.copytree(work, library_snapshot)

        reopen_results = {}
        post_attempts = []
        for file_id in ids:
            html = WRITTEN_TWO if file_id == "upgrade-studio-html" else WRITTEN
            written_db, entry, _ = attempt(f"post_upgrade_{file_id}", library_snapshot / DB_REL.parent, file_id, html, asar, root, after_upgrade)
            post_attempts.append(entry)
            if entry["result"].get("accepted") and file_id in PATHS:
                reopen_results[file_id] = reopen(root, file_id, library_snapshot, written_db, new_dir, xvfb, target, file_id, asar)

        schema = schema_report(after_upgrade)
        upgrade_diff = compare(before_upgrade, after_upgrade)
        old_objects = {(t, n): q for t, n, q in before_upgrade["schema"]}
        new_objects = {(t, n): q for t, n, q in after_upgrade["schema"]}
        migration = {
            "added": sorted(map(list, set(new_objects) - set(old_objects))),
            "removed": sorted(map(list, set(old_objects) - set(new_objects))),
            "definition_changed": sorted(list(k) for k in set(old_objects) & set(new_objects) if old_objects[k] != new_objects[k]),
        }
        accepted = [a["file_id"] for a in post_attempts if a["result"].get("accepted")]
        refused = {a["file_id"]: a["result"].get("reason") for a in post_attempts if not a["result"].get("accepted")}
        checks = {
            "jails_only_loopback": all(p["jail_network_interfaces"] == ["lo"] for p in (seed, old_read, upgrade)),
            "old_build_reports_0_5_2": seed["studio_app_version"] == "0.5.2",
            "new_build_reports_1_1_3": upgrade["studio_app_version"] == "1.1.3",
            "local_mode_throughout": all(p["desktop_mode"] == "local" for p in (seed, old_read, upgrade)),
            "no_auth_token_row": after_upgrade["auth_token_rows"] == 0,
            "all_pre_upgrade_guard_attempts_refused": not any(a["result"].get("accepted") for a in attempts),
            "pre_upgrade_refusals_left_bytes_alone": all(a["bytes_unchanged"] for a in attempts),
            "upgrade_kept_every_file_row": sorted(before_upgrade["files"]) == sorted(after_upgrade["files"]),
            "upgrade_did_not_change_file_rows": upgrade_diff["files_changed"] == [],
            "upgrade_integrity_ok": after_upgrade["integrity"] == "ok" and after_upgrade["foreign_key_violations"] == 0,
            "upgraded_schema_identical_to_tested": schema["identical_to_tested"],
            "upgrade_left_outbox_unchanged": upgrade_diff["outbox_unchanged"],
            "post_upgrade_refusals_left_bytes_alone": all(a["bytes_unchanged"] for a in post_attempts if not a["result"].get("accepted")),
            "accepted_writes_changed_only_their_row": all(a["difference"]["other_files_changed"] == [] for a in post_attempts if a["result"].get("accepted")),
            "accepted_writes_left_outbox_alone": all(a["difference"]["outbox_unchanged"] for a in post_attempts if a["result"].get("accepted")),
            "expected_records_accepted": sorted(accepted) == sorted(PATHS),
            "every_accepted_write_was_reopened": sorted(reopen_results) == sorted(accepted),
            "ui_created_file_refused_for_outbox": OUTBOX_REFUSAL in str(refused.get(target["ui_file_id"])),
            "outbox_free_record_in_ui_project_refused_for_ancestor": USER_NULL_REFUSAL in str(refused.get("upgrade-in-ui-project")),
            "ui_project_stores_json_null_user": json.loads(after_upgrade["projects"][target["project_id"]])["user"] is None,
            "guard_refuses_for_outbox_after_ui_edit": all(OUTBOX_REFUSAL in str(r["guard_after_ui_edit"]["result"].get("reason")) and r["guard_after_ui_edit"]["bytes_unchanged"] for r in reopen_results.values()),
            "accepted_writes_kept_preimage_version": all(a["preimage_version_kept"] for a in post_attempts if a["result"].get("accepted")),
            "accepted_writes_kept_other_json_fields": all(a["only_content_and_times_changed"] for a in post_attempts if a["result"].get("accepted")),
            "reopen_returned_written_content": all(r["read_after_guarded_write"]["file"]["content"] == next(a["content_after"] for a in post_attempts if a["file_id"] == k) for k, r in reopen_results.items()),
            "reopen_editor_kept_written_text": all(EDITOR_EXPECT[k] in r["after_ui_edit"]["editor_html"] for k, r in reopen_results.items()),
            "reopen_integrity_ok": all(r["integrity"] == "ok" and r["foreign_key_violations"] == 0 for r in reopen_results.values()),
        }
        report = {
            "checks": checks,
            "environment": {
                "old_app_asar_sha256": OLD_ASAR, "new_app_asar_sha256": NEW_ASAR, "xvfb_sha256": XVFB,
                "sqlite_cli": sql_version, "old_studio_exit": seed["studio_exit"], "new_studio_exit": upgrade["studio_exit"],
                "electron_old": seed["electron"], "electron_new": upgrade["electron"],
            },
            "seed": {k: seed[k] for k in ("project_id", "ui_file_id", "bridge_ids", "put_project", "put_folder", "put_files", "studio_snapshot")},
            "before_upgrade": before_upgrade,
            "after_upgrade": after_upgrade,
            "schema_vs_tested": schema,
            "schema_migration": migration,
            "upgrade_difference": upgrade_diff,
            "pre_upgrade_guard": attempts,
            "post_upgrade_guard": post_attempts,
            "post_upgrade_accepted": accepted,
            "post_upgrade_refused": refused,
            "reopen": reopen_results,
        }
        args.out.parent.mkdir(parents=True, exist_ok=True)
        screenshot = root / "reopen/upgrade-studio-html/reopened.png"
        if screenshot.exists():
            shutil.copy2(screenshot, args.out.parent / "reopened.png")
        args.out.write_text(json.dumps(report, indent=1, ensure_ascii=False, sort_keys=True) + "\n")
        failed = [k for k, v in checks.items() if not v]
        print(f"{len(checks) - len(failed)}/{len(checks)} checks passed; accepted={accepted}; refused={sorted(refused)}")
        for name in failed:
            print("FAILED:", name)
        return 1 if failed else 0
    finally:
        if args.keep:
            print("kept", root)
        else:
            shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
