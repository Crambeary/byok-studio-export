"""Candidate read-only compatibility predicate for existing libraries (issue #5).

Research code. It is not wired to the plugin. Every statement is a SELECT or a
read-only pragma on a connection opened with mode=ro. `authToken` is only
counted; its value is never selected.
"""
import json
import sqlite3
from pathlib import Path

TESTED_SCHEMA = json.loads((Path(__file__).resolve().parents[2] / "src/tested-schema.json").read_text())
TESTED_MARKER = "3"
TESTED_VERSION = "1.1.3"


def meta_is(con, key, expected):
    row = con.execute("SELECT count(*) FROM metadata WHERE key=? AND typeof(value)='text' AND value=?", (key, expected)).fetchone()
    return row[0] == 1


def key_count(con, key):
    return con.execute("SELECT count(*) FROM metadata WHERE key=?", (key,)).fetchone()[0]


def evaluate(db):
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=5)
    try:
        # GLOB, unlike LIKE, treats the underscore literally, so only SQLite's
        # own reserved objects are excluded from the count.
        total = con.execute("SELECT count(*) FROM sqlite_master WHERE name NOT GLOB 'sqlite_*'").fetchone()[0]
        exact = all(
            con.execute("SELECT count(*) FROM sqlite_master WHERE type=? AND name=? AND sql=?", (t, n, s)).fetchone()[0] == 1
            for t, n, s in TESTED_SCHEMA
        )
        checks = {
            "schema_exact": exact and total == len(TESTED_SCHEMA),
            "pragmas_zero": con.execute("PRAGMA user_version").fetchone()[0] == 0
            and con.execute("PRAGMA application_id").fetchone()[0] == 0,
        }
        if exact:
            checks.update({
                "schema_version_exact": meta_is(con, "schema_version", TESTED_MARKER),
                "last_launch_tested": meta_is(con, "telemetry.lastVersion", TESTED_VERSION),
                "owner_local": meta_is(con, "currentUserId", "local"),
                "mode_not_synced": key_count(con, "mode") == 0 or meta_is(con, "mode", "local"),
                "no_auth_token": key_count(con, "authToken") == 0,
            })
        return {"accepted": all(checks.values()) and len(checks) == 7, "checks": checks}
    except sqlite3.Error as error:
        return {"accepted": False, "checks": {}, "sqlite_error": str(error)}
    finally:
        con.close()
