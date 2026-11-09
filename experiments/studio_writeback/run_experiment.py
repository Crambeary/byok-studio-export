#!/usr/bin/env python3
"""Run the disposable Studio write-back experiment for issue #4.

Launches a real, unmodified Studio in a network-less bubblewrap jail against a
fresh synthetic library, writes to that library's SQLite database while Studio
is closed, reopens Studio, and records what it observed.

The jail mounts only /usr, fonts, the Studio binaries (read-only), this
directory (read-only) and the disposable work directory. The real home
directory, and therefore the live library and any account token, does not exist
inside it.

Usage: run_experiment.py --studio-dir DIR [--xvfb PATH] [--evidence DIR]
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

import writeback

HERE = Path(__file__).resolve().parent
NEW_HTML = (
    "<p>Obsidian write-back marker 7f3a: café &amp; “quotes”.</p>"
    "<h2>Synthetic heading</h2><p><strong>Bold</strong> synthetic line.</p>"
)
MARKER_TEXT = "Obsidian write-back marker 7f3a"
PRE_WRITEBACK_TEXT = "Second synthetic sentence"
INDEXED = ("user_id", "project_id", "folder_id", "type", "is_trashed", "position", "created_at")


def sha256_file(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def jail(work, studio_dir, xvfb, phase):
    argv = [
        "timeout", "180", "bwrap",
        "--unshare-all", "--die-with-parent", "--new-session", "--clearenv",
        "--setenv", "HOME", "/home/synthetic",
        "--setenv", "XDG_CONFIG_HOME", "/work/config",
        "--setenv", "PATH", "/usr/bin",
        "--setenv", "LANG", "C.UTF-8",
        "--setenv", "ELECTRON_RUN_AS_NODE", "1",
        "--ro-bind", "/usr", "/usr",
        "--symlink", "usr/lib", "/lib",
        "--symlink", "usr/lib", "/lib64",
        "--symlink", "usr/bin", "/bin",
        "--symlink", "usr/bin", "/sbin",
        "--ro-bind-try", "/etc/fonts", "/etc/fonts",
        "--ro-bind-try", "/etc/ld.so.cache", "/etc/ld.so.cache",
        "--proc", "/proc", "--dev", "/dev",
        "--tmpfs", "/tmp", "--dir", "/tmp/.X11-unix",
        "--tmpfs", "/home", "--dir", "/home/synthetic", "--dir", "/run",
        "--ro-bind", str(studio_dir), "/opt/studio/electron",
        "--ro-bind", str(xvfb), "/opt/xvfb/Xvfb",
        "--ro-bind", str(HERE), "/driver",
        "--bind", str(work), "/work",
        "/opt/studio/electron/studio", "/driver/driver.js", phase,
    ]
    print(f"== Studio phase: {phase}", flush=True)
    done = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    report_path = work / f"{phase}.json"
    if not report_path.exists():
        sys.exit(f"phase {phase} produced no report (exit {done.returncode}):\n{done.stdout[-2000:]}")
    report = json.loads(report_path.read_text())
    if report.get("error"):
        sys.exit(f"phase {phase} failed: {report['error']}")
    return report


def connect_ro(db):
    return sqlite3.connect(f"file:{db}?mode=ro", uri=True)


def file_row(db, file_id):
    with connect_ro(db) as con:
        con.row_factory = sqlite3.Row
        return dict(con.execute("SELECT * FROM files WHERE id = ?", (file_id,)).fetchone())


def outbox_rows(db):
    with connect_ro(db) as con:
        rows = con.execute(
            "SELECT id, kind, entity_type, entity_id, method, url, status, attempts,"
            " body, updated_at FROM outbox ORDER BY id"
        ).fetchall()
    return [
        {
            "id": r[0], "kind": r[1], "entity_type": r[2], "entity_id": r[3],
            "method": r[4], "url": r[5], "status": r[6], "attempts": r[7],
            "body_sha256": hashlib.sha256((r[8] or "").encode()).hexdigest(),
            "body_has_pre_writeback_text": PRE_WRITEBACK_TEXT in (r[8] or ""),
            "body_has_writeback_marker": MARKER_TEXT in (r[8] or ""),
        }
        for r in rows
    ]


def consistency(db, file_id):
    with connect_ro(db) as con:
        plan = " ".join(
            str(r[3]) for r in con.execute(
                "EXPLAIN QUERY PLAN SELECT id FROM files WHERE project_id = ? AND is_trashed = 0",
                ("x",),
            )
        )
        return {
            "integrity_check": con.execute("PRAGMA integrity_check").fetchone()[0],
            "foreign_key_violations": len(con.execute("PRAGMA foreign_key_check").fetchall()),
            "project_query_plan": plan,
            "metadata_keys": sorted(r[0] for r in con.execute("SELECT key FROM metadata")),
            "metadata_mode": (con.execute("SELECT value FROM metadata WHERE key='mode'").fetchone() or [None])[0],
        }


def indexed_match_blob(row):
    data = json.loads(row["data"])
    return {
        "project": row["project_id"] == data.get("project"),
        "folder": row["folder_id"] == data.get("folder"),
        "type": row["type"] == data.get("type"),
        "is_trashed": bool(row["is_trashed"]) == bool(data.get("isTrashed")),
        "position": row["position"] == data.get("position"),
        "created_at": row["created_at"] == data.get("createdAt"),
    }


def dump_schema(db, dest):
    with connect_ro(db) as con:
        ddl = [r[0] for r in con.execute(
            "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'"
            " ORDER BY type DESC, name"
        )]
    dest.write_text("".join(f"{stmt};\n\n" for stmt in ddl))


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--studio-dir", type=Path, required=True, help="directory holding the `studio` binary and resources/")
    ap.add_argument("--xvfb", type=Path, default=shutil.which("Xvfb"), help="Xvfb binary (default: from PATH)")
    ap.add_argument("--evidence", type=Path, default=HERE / "evidence")
    ap.add_argument("--keep-work", action="store_true", help="keep the disposable library for debugging")
    args = ap.parse_args()
    if not args.xvfb:
        sys.exit("Xvfb not found; pass --xvfb")

    studio_dir = args.studio_dir.resolve()
    xvfb = Path(args.xvfb).resolve()
    work = Path(tempfile.mkdtemp(prefix="studio-writeback-"))
    (work / writeback.MARKER).write_text("synthetic data only; safe to delete\n")
    (work / "config").mkdir()
    db = work / "config/studio-desktop/byokwa/db.sqlite"
    writeback.assert_disposable(db, work)

    try:
        seed = jail(work, studio_dir, xvfb, "seed")
        file_id = seed["file_id"]
        args.evidence.mkdir(parents=True, exist_ok=True)
        dump_schema(db, args.evidence / "schema.sql")

        row_before = file_row(db, file_id)
        outbox_before = outbox_rows(db)
        result = writeback.apply_text_writeback(db, work, file_id, NEW_HTML)
        row_after = file_row(db, file_id)
        outbox_after = outbox_rows(db)
        stamp = result["timestamp"]
        (work / "target.json").write_text(json.dumps({
            "project_id": seed["project_id"],
            "file_id": file_id,
            "pre_image_version_id": result["pre_image_version_id"],
        }))

        verify = jail(work, studio_dir, xvfb, "verify")
        row_verified = file_row(db, file_id)
        outbox_verified = outbox_rows(db)
        consistency_verified = consistency(db, file_id)
        shutil.copy(work / "reopened.png", args.evidence / "reopened.png")

        edit = jail(work, studio_dir, xvfb, "edit-restore")
        row_final = file_row(db, file_id)
        outbox_final = outbox_rows(db)
        consistency_final = consistency(db, file_id)

        data_before = json.loads(row_before["data"])
        data_after = json.loads(row_after["data"])
        changed = sorted(k for k in set(data_before) | set(data_after) if data_before.get(k) != data_after.get(k))
        boot = verify["at_boot"]
        pre_image_content = data_before["content"]
        snapshot = seed["studio_snapshot"]["version"]

        checks = {
            "jail_only_loopback": all(p["jail_network_interfaces"] == ["lo"] for p in (seed, verify, edit)),
            "no_auth_token_in_disposable_library": "authToken" not in consistency_final["metadata_keys"],
            "mode_is_not_synced": consistency_final["metadata_mode"] != "synced",
            "writeback_added_no_outbox_rows": outbox_before == outbox_after,
            "writeback_changed_only_expected_blob_keys": changed == ["content", "contentUpdatedAt", "updatedAt"],
            "writeback_left_indexed_columns_alone": all(row_before[c] == row_after[c] for c in INDEXED),
            "python_fingerprint_matches_studio": writeback.fingerprint(snapshot["content"]) == _stored_fingerprint(db, snapshot["id"]),
            "reopen_mirror_returns_writeback": boot["file"]["content"] == NEW_HTML,
            "reopen_timestamps_preserved": boot["file"]["updatedAt"] == stamp and boot["file"]["contentUpdatedAt"] == stamp,
            "reopen_created_at_preserved": boot["file"]["createdAt"] == data_before["createdAt"],
            "reopen_editor_shows_writeback": MARKER_TEXT in (verify["editor_html"] or ""),
            "reopen_history_lists_pre_image": any(v["id"] == result["pre_image_version_id"] for v in boot["versions"]),
            "reopen_history_lists_studio_snapshot": any(v["id"] == snapshot["id"] for v in boot["versions"]),
            "reopen_pre_image_content_correct": verify["pre_image"]["content"] == pre_image_content,
            "reopen_indexed_columns_match_blob": all(indexed_match_blob(row_verified).values()),
            "reopen_integrity_ok": consistency_verified["integrity_check"] == "ok",
            "reopen_no_foreign_key_violations": consistency_verified["foreign_key_violations"] == 0,
            "project_query_uses_index": "idx_files_project" in consistency_verified["project_query_plan"],
            "later_ui_edit_keeps_writeback": MARKER_TEXT in edit["file_after_ui_edit"]["content"],
            "history_restore_returns_pre_image": edit["file_after_restore"]["content"] == pre_image_content,
            "restore_recorded_pre_restore_backup": any(v["reason"] == "pre_restore" for v in edit["versions_after_restore"]),
            "final_integrity_ok": consistency_final["integrity_check"] == "ok",
            "final_no_foreign_key_violations": consistency_final["foreign_key_violations"] == 0,
        }

        report = {
            "checks": checks,
            "environment": {
                "electron": seed["electron"],
                "studio_app_version": seed["studio_app_version"],
                "desktop_mode": seed["desktop_mode"],
                "studio_binary_sha256": sha256_file(studio_dir / "studio"),
                "app_asar_sha256": sha256_file(studio_dir / "resources/app.asar"),
                "xvfb_sha256": sha256_file(xvfb),
                "sqlite_library_used_for_writeback": sqlite3.sqlite_version,
            },
            "seed": {
                "studio_snapshot": snapshot,
                "studio_snapshot_fingerprint": _stored_fingerprint(db, snapshot["id"]),
                "row_before_writeback": row_before,
                "outbox": outbox_before,
                "studio_exit": seed["studio_exit"],
            },
            "writeback": {
                "result": result,
                "blob_keys_changed": changed,
                "row_after_writeback": row_after,
                "outbox_unchanged": outbox_before == outbox_after,
            },
            "reopen": {
                "mirror_at_boot": boot["file"],
                "editor_html": verify["editor_html"],
                "editor_html_after_idle": verify["editor_html_after_idle"],
                "mirror_after_idle": verify["after_idle"]["file"],
                "versions": boot["versions"],
                "pre_image": verify["pre_image"],
                "tree": boot["tree"],
                "activity": boot["activity"],
                "projects": boot["projects"],
                "stats_at_boot": boot["stats"],
                "stats_after_idle": verify["after_idle"]["stats"],
                "cache": verify["cache"],
                "row_after_reopen": row_verified,
                "row_changed_by_reopen": row_verified != row_after,
                "outbox_changed_by_reopen": outbox_verified != outbox_after,
                "outbox_after_reopen": outbox_verified,
                "consistency": consistency_verified,
                "studio_exit": verify["studio_exit"],
            },
            "edit_restore": {
                "file_after_ui_edit": edit["file_after_ui_edit"],
                "restore_result": edit["restore_result"],
                "file_after_restore": edit["file_after_restore"],
                "versions_after_restore": edit["versions_after_restore"],
                "row_final": row_final,
                "outbox_final": outbox_final,
                "consistency": consistency_final,
                "studio_exit": edit["studio_exit"],
            },
        }
        out = args.evidence / "report.json"
        out.write_text(json.dumps(report, indent=1, ensure_ascii=False, sort_keys=True) + "\n")
        failed = [name for name, ok in checks.items() if not ok]
        print(f"{len(checks) - len(failed)}/{len(checks)} checks passed; report: {out}")
        for name in failed:
            print(f"FAILED: {name}")
        return 1 if failed else 0
    finally:
        if args.keep_work:
            print(f"kept disposable work directory: {work}")
        else:
            shutil.rmtree(work, ignore_errors=True)


def _stored_fingerprint(db, version_id):
    with connect_ro(db) as con:
        return con.execute("SELECT fingerprint FROM local_versions WHERE id = ?", (version_id,)).fetchone()[0]


if __name__ == "__main__":
    sys.exit(main())
