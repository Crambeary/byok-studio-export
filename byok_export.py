#!/usr/bin/env python3
"""One-way export of the BYOK Studio desktop library to Markdown.

Reads Studio's SQLite DB read-only and writes <out>/<Project>/... as Markdown.
Never writes to the DB. Files edited since the last export are left alone
(reported as skipped) so a re-run can't clobber your edits.

Usage: byok_export.py --out DIR [--dry-run]
"""
import argparse
import hashlib
import json
import os
import re
import sqlite3
import sys
from html.parser import HTMLParser
from pathlib import Path

DB = Path.home() / ".config/studio-desktop/byokwa/db.sqlite"
STATE = (
    Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local/state"))
    / "byok-studio-export/state.json"
)


class HtmlToMd(HTMLParser):
    """Small HTML -> Markdown converter for the tags Studio emits."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out = []
        self.lists = []  # stack of ["ul"|"ol", counter]
        self.href = []

    def _emit(self, s):
        self.out.append(s)

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if re.fullmatch(r"h[1-6]", tag):
            self._emit("\n\n" + "#" * int(tag[1]) + " ")
        elif tag == "p":
            self._emit("\n\n")
        elif tag == "br":
            self._emit("  \n")
        elif tag in ("strong", "b"):
            self._emit("**")
        elif tag in ("em", "i"):
            self._emit("*")
        elif tag == "code":
            self._emit("`")
        elif tag == "blockquote":
            self._emit("\n\n> ")
        elif tag in ("ul", "ol"):
            self.lists.append([tag, 0])
            self._emit("\n")
        elif tag == "li":
            depth = max(len(self.lists) - 1, 0)
            marker = "-"
            if self.lists and self.lists[-1][0] == "ol":
                self.lists[-1][1] += 1
                marker = f"{self.lists[-1][1]}."
            self._emit("\n" + "  " * depth + marker + " ")
        elif tag == "hr":
            self._emit("\n\n---\n\n")
        elif tag == "a":
            self.href.append(a.get("href", ""))
            self._emit("[")

    def handle_endtag(self, tag):
        if tag in ("strong", "b"):
            self._emit("**")
        elif tag in ("em", "i"):
            self._emit("*")
        elif tag == "code":
            self._emit("`")
        elif tag in ("ul", "ol") and self.lists:
            self.lists.pop()
            self._emit("\n")
        elif tag == "a" and self.href:
            self._emit(f"]({self.href.pop()})")

    def handle_data(self, data):
        self._emit(data.replace("\n", " ") if "\n" in data else data)

    def markdown(self):
        text = "".join(self.out)
        text = re.sub(r"\n{3,}", "\n\n", text)
        return text.strip() + "\n"


def html_to_md(html):
    p = HtmlToMd()
    p.feed(html or "")
    return p.markdown()


def outline_to_md(nodes, depth=0):
    lines = []
    for n in nodes:
        text = html_to_md(n.get("text", "")).strip().replace("\n", " ")
        lines.append("  " * depth + "- " + text)
        lines.extend(outline_to_md(n.get("children") or [], depth + 1))
    return lines


def safe(name):
    name = re.sub(r'[\\/:*?"<>|#^\[\]]', "-", (name or "Untitled").strip())
    return name or "Untitled"


def frontmatter(meta):
    return "---\n" + "".join(f"{k}: {v}\n" for k, v in meta.items()) + "---\n\n"


def sha(s):
    return hashlib.sha256(s.encode()).hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, required=True, help="folder to export into")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    db = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    state = json.loads(STATE.read_text()) if STATE.exists() else {}

    projects = {
        pid: json.loads(d)["name"]
        for pid, d in db.execute("select id, data from projects")
    }
    folders = {}
    for fid, parent, d in db.execute("select id, parent_folder_id, data from folders"):
        folders[fid] = (parent, json.loads(d)["name"])

    def folder_path(fid):
        parts = []
        while fid:
            parent, name = folders[fid]
            parts.append(safe(name))
            fid = parent
        return Path(*reversed(parts)) if parts else Path()

    def write(rel, meta, body):
        target = args.out / rel
        text = frontmatter(meta) + body
        key = str(rel)
        if target.exists():
            on_disk = sha(target.read_text())
            if on_disk == sha(text):
                return "unchanged"
            if key in state and on_disk != state[key]:
                return "SKIPPED (edited in Obsidian since last export)"
        if not args.dry_run:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text)
            state[key] = sha(text)
        return "written"

    def report(rel, status):
        print(f"{status:12} {rel}")

    names = {}  # file id -> note path stem, for manuscript links
    for fid, pid, folder_id, ftype, trashed, d in db.execute(
        "select id, project_id, folder_id, type, is_trashed, data from files"
    ):
        if trashed:
            continue
        data = json.loads(d)
        proj = safe(projects.get(pid, "Unknown Project"))
        rel = Path(proj) / folder_path(folder_id) / (safe(data["name"]) + ".md")
        names[fid] = rel.with_suffix("").name
        content = data.get("content")
        if ftype == "outline":
            body = "\n".join(outline_to_md(content or [])) + "\n"
        else:
            body = html_to_md(content if isinstance(content, str) else "")
        meta = {
            "byok-id": fid,
            "byok-type": ftype,
            "byok-updated": data.get("updatedAt", ""),
        }
        report(rel, write(rel, meta, body))

    for mid, pid, folder_id, trashed, d in db.execute(
        "select id, project_id, folder_id, is_trashed, data from manuscript_files"
    ):
        if trashed:
            continue
        data = json.loads(d)
        proj = safe(projects.get(pid, "Unknown Project"))
        rel = Path(proj) / folder_path(folder_id) / (safe(data["name"]) + ".md")
        items = sorted(data.get("manuscripts", []), key=lambda m: m.get("position", 0))
        body = "".join(
            f"![[{names.get(m['file']['id'], safe(m['file']['name']))}]]\n\n"
            for m in items
        )
        meta = {"byok-id": mid, "byok-type": "manuscript", "byok-updated": data.get("updatedAt", "")}
        report(rel, write(rel, meta, body))

    if not args.dry_run:
        STATE.parent.mkdir(parents=True, exist_ok=True)
        STATE.write_text(json.dumps(state, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
