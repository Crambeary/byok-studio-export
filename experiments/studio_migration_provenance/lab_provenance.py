#!/usr/bin/env python3
"""Can an existing library be identified as compatible with Studio 1.1.3? (issue #5)

Every library is synthetic. Studio 1.1.3 itself creates the base library inside
a bubblewrap jail with only a loopback interface and an empty home, and each
fixture is then booted by the same unmodified binary. No statement issued here
inserts, updates or deletes an outbox row. `outbox` only changes where Studio's
own init rebuilds it inside a synthetic fixture.

Usage: lab_provenance.py --studio-dir DIR --xvfb PATH [--out report.json] [--only a,b]
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
sys.path[:0] = [str(HERE), str(HERE.parent / "studio_write_guard")]
import guard  # noqa: E402
from lab_studio import DB_REL, Jail  # noqa: E402
import candidate  # noqa: E402

EXPECTED_ASAR = "25e93b78fb4753f7b47236a91f8907e674c341aab19af271d93c7dd1e04dbcfa"
FILE_ID = "provenance-file"
PROJECT_ID = "provenance-project"
ORIGINAL = "<p>Original synthetic body.</p>"
WRITTEN = "<p>Written by the current guard.</p>"
VOLATILE_META = ("telemetry.", "spelling.", "theme")
USERS_EARLY = "CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, last_auth_ok_at INTEGER)"


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def connect(db):
    return sqlite3.connect(db, isolation_level=None)


def set_marker(value):
    def apply(con):
        con.execute("UPDATE metadata SET value=? WHERE key='schema_version'", (value,))
    return apply


def set_meta(key, value):
    def apply(con):
        if value is None:
            con.execute("DELETE FROM metadata WHERE key=?", (key,))
        else:
            con.execute("INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, value))
    return apply


def run_sql(*statements):
    def apply(con):
        for statement in statements:
            con.execute(statement)
    return apply


def rebuild_files_with_other_whitespace(con):
    original = con.execute("SELECT sql FROM sqlite_master WHERE name='files'").fetchone()[0]
    spaced = original.replace("CREATE TABLE files (", "CREATE TABLE files_new  (")
    indexes = [r[0] for r in con.execute("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='files' AND sql IS NOT NULL")]
    con.execute(spaced)
    con.execute("INSERT INTO files_new SELECT * FROM files")
    con.execute("DROP TABLE files")
    con.execute("ALTER TABLE files_new RENAME TO files")
    for statement in indexes:
        con.execute(statement)


# name -> (mutation, boot Studio on it?)
CASES = {
    "control_fresh": (None, True),
    "marker_missing": (set_meta("schema_version", None), True),
    "marker_2": (set_marker("2"), True),
    "marker_0": (set_marker("0"), True),
    "marker_null": (set_marker(None), True),
    "marker_empty": (set_marker(""), True),
    "marker_garbage": (set_marker("3abc"), True),
    "marker_future_4": (set_marker("4"), True),
    "marker_float_text": (set_marker("3.0"), True),
    "marker_leading_space": (set_marker(" 3"), True),
    "last_version_missing": (set_meta("telemetry.lastVersion", None), True),
    "last_version_older": (set_meta("telemetry.lastVersion", "1.1.2"), True),
    "last_version_newer": (set_meta("telemetry.lastVersion", "1.2.0"), True),
    "users_early_shape": (run_sql("DROP TABLE users", USERS_EARLY), True),
    "folders_old_shape": (run_sql(
        "DROP TABLE folders",
        "CREATE TABLE folders (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, data TEXT NOT NULL)",
    ), True),
    "whitespace_only_files": (rebuild_files_with_other_whitespace, True),
    "extra_table": (run_sql("CREATE TABLE extra_thing (x)"), True),
    "extra_trigger_evading_count": (run_sql(
        "CREATE TABLE sqliteXaudit (x)",
        "CREATE TRIGGER sqliteXtrigger AFTER UPDATE ON files BEGIN INSERT INTO sqliteXaudit VALUES (new.id); END",
    ), False),
    "legacy_entitlements": (run_sql("CREATE TABLE entitlements (x)"), True),
    "legacy_metadata_keys": (set_meta("maxSeenTime", "1"), True),
    "additive_tables_absent": (run_sql(
        "DROP TABLE comments", "DROP TABLE scratchpad_entries", "DROP TABLE telemetry_queue",
        "DROP TABLE local_versions", "DROP TABLE card_catalog", "DROP TABLE card_installs",
        "DROP TABLE device_cards", "DROP TABLE device_projects", "DROP TABLE device_files",
    ), True),
    "v2_shape": (lambda con: (set_marker("2")(con), run_sql(
        "DROP TABLE outbox", "DROP TABLE id_map", "CREATE TABLE ops_queue (id INTEGER PRIMARY KEY, payload TEXT)")(con)), True),
    "user_version_set": (run_sql("PRAGMA user_version=7"), True),
    "application_id_set": (run_sql("PRAGMA application_id=7"), True),
    # Never booted: these would steer Studio toward its sync code path.
    "mode_synced": (set_meta("mode", "synced"), False),
    "owner_real_account": (set_meta("currentUserId", "synthetic-account"), False),
    "auth_token_present": (set_meta("authToken", "synthetic-not-a-token"), False),
}


def header(db):
    raw = Path(db).read_bytes()[:100]
    return {"sqlite_version_number_last_writer": int.from_bytes(raw[96:100], "big"), "schema_cookie": int.from_bytes(raw[40:44], "big"),
            "user_version": int.from_bytes(raw[60:64], "big"), "application_id": int.from_bytes(raw[68:72], "big"),
            "text_encoding": int.from_bytes(raw[56:60], "big")}


def snapshot(db):
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    try:
        schema = sorted(con.execute("SELECT type,name,sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*'").fetchall(), key=repr)
        tables = sorted(n for t, n, _ in schema if t == "table" and n not in ("metadata", "telemetry_queue"))
        digests = {}
        for name in tables:
            rows = con.execute(f'SELECT * FROM "{name}"').fetchall()
            digests[name] = {"count": len(rows), "sha256": hashlib.sha256(repr(sorted(rows, key=repr)).encode()).hexdigest()}
        meta = dict(con.execute("SELECT key, value FROM metadata WHERE key <> 'authToken'").fetchall())
        stable_meta = {k: v for k, v in meta.items() if not k.startswith(VOLATILE_META)}
        version_meta = {k: meta.get(k) for k in ("telemetry.firstVersion", "telemetry.lastVersion")}
        file_row = None
        if "files" in tables:
            row = con.execute("SELECT data FROM files WHERE id=?", (FILE_ID,)).fetchone()
            file_row = json.loads(row[0])["content"] if row else None
        outbox = con.execute("SELECT count(*) FROM outbox").fetchone()[0] if "outbox" in tables else None
        integrity = con.execute("PRAGMA integrity_check").fetchone()[0]
        return {"schema_sha256": hashlib.sha256(repr(schema).encode()).hexdigest(), "object_count": len(schema), "tables": digests,
                "stable_metadata": stable_meta, "version_metadata": version_meta, "file_content": file_row, "outbox_rows": outbox, "integrity": integrity}
    finally:
        con.close()


def schema_diff(before, after):
    tables = sorted(set(before["tables"]) | set(after["tables"]))
    changed = [t for t in tables if before["tables"].get(t) != after["tables"].get(t)]
    return {"schema_changed": before["schema_sha256"] != after["schema_sha256"], "tables_changed": changed,
            "stable_metadata_changed": before["stable_metadata"] != after["stable_metadata"]}


def copy_case(source, target):
    if target.exists():
        shutil.rmtree(target)
    shutil.copytree(source, target)


def run_current_guard(db):
    output = subprocess.run(["node", str(HERE / "current_guard.js"), str(db), FILE_ID, WRITTEN], capture_output=True, text=True, timeout=60)
    return json.loads(output.stdout)


def boot(work, studio_dir, xvfb):
    jail = Jail(work, studio_dir, xvfb)
    result = {"interfaces": jail.hello["interfaces"]}
    launched = jail("launch", timeout_ms=30000)
    result["window"] = bool(launched.get("page"))
    seen = jail("get_file", id=FILE_ID) if launched.get("page") else {"file": None}
    result["studio_sees_content"] = (seen.get("file") or {}).get("content")
    quit_result = jail("quit") if launched.get("page") else jail("kill9")
    result["clean_exit"] = quit_result.get("clean_exit")
    jail.close()
    return result


def build_base(root, studio_dir, xvfb):
    work = root / "base"
    (work / Path(DB_REL).parent).mkdir(parents=True)
    (work / guard.MARKER).write_text("synthetic\n")
    first = boot(work, studio_dir, xvfb)
    db = work / DB_REL
    con = connect(db)
    con.execute("INSERT INTO projects(id,user_id,created_at,data,mirrored_at) VALUES(?, 'local', '2026-01-01T00:00:00.000Z', ?, 0)",
                (PROJECT_ID, json.dumps({"id": PROJECT_ID, "name": "Synthetic Provenance Project"})))
    data = {"id": FILE_ID, "name": "Synthetic", "type": "text", "project": PROJECT_ID, "content": ORIGINAL,
            "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z", "contentUpdatedAt": "2026-01-01T00:00:00.000Z"}
    con.execute("INSERT INTO files(id,user_id,project_id,type,is_trashed,position,created_at,data,mirrored_at) VALUES(?, 'local', ?, 'text', 0, 0, ?, ?, 0)",
                (FILE_ID, PROJECT_ID, data["createdAt"], json.dumps(data)))
    con.close()
    # A second real boot stamps the base as last launched by 1.1.3 with rows in place.
    second = boot(work, studio_dir, xvfb)
    return work, {"first_boot": first, "second_boot": second, "snapshot": snapshot(db), "header": header(db)}


def run_case(name, root, base, studio_dir, xvfb):
    mutate, should_boot = CASES[name]
    source = root / f"{name}-fixture"
    copy_case(base, source)
    db = source / DB_REL
    if mutate:
        con = connect(db)
        mutate(con)
        con.close()
    result = {"before": snapshot_safe(db), "candidate_before": candidate.evaluate(db)}
    written = root / f"{name}-written"
    copy_case(source, written)
    result["current_guard_before"] = run_current_guard(written / DB_REL)
    result["written_snapshot"] = snapshot_safe(written / DB_REL)
    result["booted"] = should_boot
    if should_boot:
        result["boot"] = boot(written, studio_dir, xvfb)
        after = snapshot_safe(written / DB_REL)
        result["after_boot"] = after
        result["diff_written_vs_boot"] = schema_diff(result["written_snapshot"], after)
        result["candidate_after_boot"] = candidate.evaluate(written / DB_REL)
        reprobe = root / f"{name}-reprobe"
        copy_case(written, reprobe)
        result["current_guard_after_boot"] = run_current_guard(reprobe / DB_REL)
        result["header_after_boot"] = header(written / DB_REL)
    for path in (source, written, root / f"{name}-reprobe"):
        shutil.rmtree(path, ignore_errors=True)
    return result


def snapshot_safe(db):
    try:
        return snapshot(db)
    except sqlite3.Error as error:
        return {"error": str(error), "schema_sha256": None, "tables": {}, "stable_metadata": None}


def conclusions(cases):
    def booted(name):
        return cases[name].get("after_boot", {})
    lost = lambda name: cases[name]["current_guard_before"]["accepted"] and booted(name).get("file_content") != WRITTEN
    destructive = ["marker_missing", "marker_2", "marker_0", "marker_null", "marker_empty", "marker_garbage"]
    candidate_sound = []
    for name, case in cases.items():
        if not case["booted"] or not case["candidate_before"]["accepted"]:
            continue
        diff = case["diff_written_vs_boot"]
        candidate_sound.append({"case": name, "schema_changed": diff["schema_changed"], "file_kept": booted(name).get("file_content") == WRITTEN,
                                "tables_changed": diff["tables_changed"]})
    return {
        "current_guard_accepts_and_studio_discards_write": {n: lost(n) for n in destructive},
        "identical_schema_with_each_destructive_marker": {n: cases[n]["candidate_before"]["checks"].get("schema_exact") for n in destructive},
        "future_marker_accepted_by_current_guard": cases["marker_future_4"]["current_guard_before"]["accepted"],
        "future_marker_kept_by_studio": booted("marker_future_4").get("stable_metadata", {}).get("schema_version"),
        "candidate_accepted_cases_and_boot_effect": candidate_sound,
        "additive_gap_leaves_no_residue_after_boot": booted("additive_tables_absent").get("schema_sha256") == booted("control_fresh").get("schema_sha256"),
        "repaired_users_text_differs_from_fresh": booted("users_early_shape").get("schema_sha256") != booted("control_fresh").get("schema_sha256"),
        "evading_trigger_accepted_by_current_guard": cases["extra_trigger_evading_count"]["current_guard_before"]["accepted"],
        "evading_trigger_refused_by_candidate": not cases["extra_trigger_evading_count"]["candidate_before"]["accepted"],
        "synced_mode_accepted_by_current_guard": cases["mode_synced"]["current_guard_before"]["accepted"],
        "no_outbox_row_added_by_lab": all((c["written_snapshot"].get("outbox_rows") in (0, None)) for c in cases.values()),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--studio-dir", type=Path, required=True)
    parser.add_argument("--xvfb", type=Path, required=True)
    parser.add_argument("--out", type=Path, default=HERE / "evidence" / "provenance_lab.json")
    parser.add_argument("--only", default="")
    args = parser.parse_args()
    asar = args.studio_dir / "resources/app.asar"
    if sha(asar) != EXPECTED_ASAR:
        sys.exit("refusing: Studio build differs from the 1.1.3 asar this lab targets")
    names = [n for n in args.only.split(",") if n] or list(CASES)
    root = Path(tempfile.mkdtemp(prefix="studio-provenance-"))
    (root / guard.MARKER).write_text("synthetic\n")
    report = {"environment": {"app_asar_sha256": sha(asar), "studio_binary_sha256": sha(args.studio_dir / "studio"), "xvfb_sha256": sha(args.xvfb),
                              "sqlite_cli": subprocess.run(["sqlite3", "--version"], capture_output=True, text=True).stdout.split()[0], "python_sqlite": sqlite3.sqlite_version}}
    try:
        base, report["base"] = build_base(root, args.studio_dir, args.xvfb)
        report["cases"] = {}
        for name in names:
            print(name, flush=True)
            report["cases"][name] = run_case(name, root, base, args.studio_dir, args.xvfb)
        if set(names) == set(CASES):
            report["conclusions"] = conclusions(report["cases"])
    finally:
        shutil.rmtree(root, ignore_errors=True)
    args.out.write_text(json.dumps(report, indent=1, sort_keys=True) + "\n")
    print(json.dumps(report.get("conclusions", {}), indent=1))


if __name__ == "__main__":
    main()
