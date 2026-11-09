"""Prototype write-back of one text file into a *disposable* Studio database.

This is experiment code for issue #4, not a supported feature. It refuses to
touch anything except a library explicitly marked as disposable, and it never
touches the outbox: sync compatibility is an open question recorded in
README.md.
"""
import hashlib
import json
import os
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path

MARKER = "DISPOSABLE_SYNTHETIC_LIBRARY"
MAX_VERSIONS_PER_FILE = 30  # Studio's MAX_PER_FILE (src/localVersions.js)


class Refused(Exception):
    """The write-back was refused; nothing was changed."""


def live_library_roots():
    """Locations of a real Studio library for this user. Never opened here."""
    home = Path(os.path.expanduser("~"))
    roots = {home / ".config" / "studio-desktop"}
    if os.environ.get("XDG_CONFIG_HOME"):
        roots.add(Path(os.environ["XDG_CONFIG_HOME"]) / "studio-desktop")
    return [r.resolve() for r in roots]


def assert_disposable(db_path, disposable_root):
    """Raise Refused unless db_path is inside a marked disposable root."""
    db = Path(db_path).resolve()
    root = Path(disposable_root).resolve()
    for live in live_library_roots():
        if db == live or live in db.parents:
            raise Refused(f"refusing live Studio library path: {db}")
    if root not in db.parents:
        raise Refused(f"{db} is outside disposable root {root}")
    if not (root / MARKER).is_file():
        raise Refused(f"{root} has no {MARKER} marker")


def iso_now():
    """Studio's timestamp format: Date.prototype.toISOString()."""
    now = datetime.now(timezone.utc)
    return now.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def fingerprint(content, extras=None):
    """sha256(JSON.stringify({c: content, e: extras})), as Studio computes it."""
    payload = json.dumps(
        {"c": content, "e": extras}, ensure_ascii=False, separators=(",", ":")
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _epoch_ms(iso):
    parsed = datetime.strptime(iso, "%Y-%m-%dT%H:%M:%S.%fZ")
    return int(parsed.replace(tzinfo=timezone.utc).timestamp() * 1000)


def apply_text_writeback(db_path, disposable_root, file_id, new_html, now=None):
    """Replace one text file's content, keeping a pre-image in local_versions.

    Studio must be closed. Mirrors what Studio's own patch path changes: the
    `data` blob's content/updatedAt/contentUpdatedAt and `mirrored_at`. Indexed
    columns are left alone because none of them derive from content.
    """
    assert_disposable(db_path, disposable_root)
    stamp = now or iso_now()
    db = sqlite3.connect(str(db_path), isolation_level=None)
    try:
        db.execute("PRAGMA foreign_keys = ON")
        db.execute("BEGIN IMMEDIATE")
        try:
            result = _apply(db, file_id, new_html, stamp)
            db.execute("COMMIT")
            return result
        except BaseException:
            db.execute("ROLLBACK")
            raise
    finally:
        db.close()


def _apply(db, file_id, new_html, stamp):
    row = db.execute(
        "SELECT type, is_trashed, data FROM files WHERE id = ?", (file_id,)
    ).fetchone()
    if row is None:
        raise Refused(f"no such file: {file_id}")
    file_type, trashed, raw = row
    if file_type != "text":
        raise Refused(f"only text files are supported, got {file_type!r}")
    if trashed:
        raise Refused("refusing to write back into a trashed file")

    data = json.loads(raw)
    old_content = data.get("content")
    if not isinstance(old_content, str):
        raise Refused("text file content is not a string")

    version_id = _snapshot_pre_image(db, file_id, data, old_content, stamp)
    data["content"] = new_html
    data["updatedAt"] = stamp
    data["contentUpdatedAt"] = stamp
    db.execute(
        "UPDATE files SET data = ?, mirrored_at = ? WHERE id = ?",
        (
            json.dumps(data, ensure_ascii=False, separators=(",", ":")),
            _epoch_ms(stamp),
            file_id,
        ),
    )
    return {"file_id": file_id, "timestamp": stamp, "pre_image_version_id": version_id}


def _snapshot_pre_image(db, file_id, data, content, stamp):
    """Insert a pre-image version unless the latest one already matches it."""
    if content == "":
        return None
    digest = fingerprint(content)
    last = db.execute(
        "SELECT fingerprint FROM local_versions WHERE file_id = ?"
        " ORDER BY created_at DESC LIMIT 1",
        (file_id,),
    ).fetchone()
    if last is not None and last[0] == digest:
        return None

    count = db.execute(
        "SELECT COUNT(*) FROM local_versions WHERE file_id = ?", (file_id,)
    ).fetchone()[0]
    excess = count - (MAX_VERSIONS_PER_FILE - 1)
    if excess > 0:
        db.execute(
            "DELETE FROM local_versions WHERE id IN (SELECT id FROM local_versions"
            " WHERE file_id = ? ORDER BY created_at ASC LIMIT ?)",
            (file_id, excess),
        )

    version_id = str(uuid.uuid4())
    encoded = json.dumps(content, ensure_ascii=False, separators=(",", ":"))
    db.execute(
        "INSERT INTO local_versions (id, file_id, content, extras, fingerprint,"
        " reason, file_name, content_size, created_at)"
        " VALUES (?, ?, ?, NULL, ?, 'manual', ?, ?, ?)",
        (version_id, file_id, encoded, digest, data.get("name") or "", len(encoded), stamp),
    )
    return version_id
