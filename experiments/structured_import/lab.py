#!/usr/bin/env python3
"""Capture synthetic Studio UI records in a disposable network namespace."""
import argparse
import json
import re
import shutil
import sqlite3
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "studio_writeback"))
import run_experiment as base


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--studio-dir", type=Path, required=True)
    parser.add_argument("--xvfb", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=HERE / "evidence.json")
    args = parser.parse_args()
    studio, xvfb = args.studio_dir.resolve(), args.xvfb.resolve()
    base.HERE = HERE
    with tempfile.TemporaryDirectory(prefix="studio-structured-") as temp:
        work = Path(temp)
        (work / "config").mkdir()
        report = base.jail(work, studio, xvfb, "seed")
        db = work / "config/studio-desktop/byokwa/db.sqlite"
        with sqlite3.connect(f"file:{db}?mode=ro", uri=True) as con:
            integrity = con.execute("pragma integrity_check").fetchone()[0]
            fk = con.execute("pragma foreign_key_check").fetchall()
            metadata_keys = [r[0] for r in con.execute("select key from metadata")]
        before = report["disk_outline_before"]["files"][0]["content"]
        after = report["disk_outline_after"]["files"][0]["content"]
        two = report["disk_two"]["manuscript_files"][0]["manuscripts"]
        reordered = report["disk_reordered"]["manuscript_files"][0]["manuscripts"]
        checks = {
            "loopback_only": report["jail_network_interfaces"] == ["lo"],
            "local_mode": report["desktop_mode"] == "local",
            "no_auth_token_key": "authToken" not in metadata_keys,
            "clean_exit": report["studio_exit"] == {"code": 0, "signal": None},
            "integrity": integrity == "ok" and not fk,
            "outline_identity_across_edit": before[0]["id"] == after[0]["id"] and before[0]["children"][0]["id"] == after[0]["children"][0]["id"],
            "duplicate_names_distinct_file_ids": len(two) == 2 and two[0]["file"]["name"] == two[1]["file"]["name"] and two[0]["file"]["id"] != two[1]["file"]["id"],
            "reordered_ids": [e["id"] for e in reordered] == [e["id"] for e in reversed(two)],
        }
        evidence = {"environment": {"studio_version": report["studio_app_version"], "electron": report["electron"], "studio_binary_sha256": base.sha256_file(studio / "studio"), "app_asar_sha256": base.sha256_file(studio / "resources/app.asar"), "xvfb_sha256": base.sha256_file(xvfb)}, "checks": checks, "captures": {k: v for k, v in report.items() if k.startswith("disk_") or k.startswith("tree_")}}
        # Preserve equality and relationships while removing run-specific IDs and times.
        raw = json.dumps(evidence, ensure_ascii=False, indent=2)
        ids, times = {}, {}
        raw = re.sub(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", lambda m: ids.setdefault(m[0], f"<id-{len(ids)+1}>"), raw, flags=re.I)
        raw = re.sub(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z", lambda m: times.setdefault(m[0], f"<time-{len(times)+1}>"), raw)
        args.output.write_text(raw + "\n")
        print(f"{sum(checks.values())}/{len(checks)} checks passed: {args.output}")
        return 0 if all(checks.values()) else 1


if __name__ == "__main__":
    sys.exit(main())
