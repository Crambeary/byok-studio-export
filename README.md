# byok-studio-export

## Experimental Obsidian desktop import

This repository also contains an early, manual, **import-only** Obsidian desktop
plugin. It requires Node.js and npm to build, and the `sqlite3` command-line
program (with JSON output support) available on Obsidian's PATH at runtime.
On systems that launch Obsidian with a restricted PATH, arrange for `sqlite3`
to be available to that process. No Studio account or network access is used.

1. Run `npm ci` and `npm run build`.
2. Copy `manifest.json` and the generated `main.js` to
   `<vault>/.obsidian/plugins/byok-studio-import/`, then enable the plugin in
   Obsidian's community plugin settings.
3. In the plugin settings, enter the absolute path to the local Studio
   `db.sqlite` and a destination folder within the vault. Run **Import local
   Studio Library** from the command palette. The developer console contains
   the detailed report (including collisions, unsupported and lossy records).

Use disposable libraries while evaluating this prototype. The SQLite CLI reads
one consistent snapshot including committed WAL data; an incompatible schema,
missing CLI, or inaccessible database fails the import. Only text records are
imported. HTML conversion is incomplete and every converted record is reported
as potentially lossy; other record types are reported without import. Original
Studio data is never written. Existing notes are not overwritten: collisions
receive a distinct name, and later changes on either side are reported for
manual handling. Renames and deletions are not propagated. Plugin state keeps
the imported content and record paths per database path and destination in the
vault's plugin data; moving a database or removing that state starts a separate
import and can create additional notes. Do not edit or delete that state if you
want to retain the mapping. This foundation does not implement reconciliation
or write-back.

Run `npm test` for the disposable SQLite/WAL sync-boundary tests. The original
Python exporter described below remains separate from the plugin.

One-way export of your [BYOK Studio](https://byok.io/studio) desktop library to
plain Markdown files, so you can read, edit and sync your writing (Obsidian,
git, Syncthing, ...) without Studio's paid sync.

A small personal export tool. Unofficial; not affiliated with BYOK.

## Why

Studio keeps its library in a SQLite database, not in Markdown files. This
script reads that database (read-only) and writes one `.md` file per Studio
file, laid out like your Studio projects.

## Requirements

- Linux (Studio desktop's data path is hard-coded to `~/.config/studio-desktop/`;
  other platforms need that path changed)
- Python 3.8+, standard library only

## Get the script

```sh
git clone https://github.com/Crambeary/byok-studio-export
cd byok-studio-export
```

No Python packages need installing. The script expects the database at
`~/.config/studio-desktop/byokwa/db.sqlite`; there is no `--db` option.

## Usage

Start with a new, dedicated output directory and a dry run:

```sh
# preview what would be written
python3 byok_export.py --out ~/notes/writing --dry-run

# export
python3 byok_export.py --out ~/notes/writing
```

Close Studio first if you can. The database is opened read-only, but a
mid-write read is still possible.

## Output

```
<out>/
  <Project name>/
    <Folder>/            # Studio folders become subfolders
      Chapter 1.md       # text files   -> Markdown
      Plan.md            # outlines     -> nested bullet list
      Draft 1.md         # manuscripts  -> ordered ![[file]] embeds
```

- **Text** is stored as HTML by Studio and converted to Markdown (headings,
  paragraphs, bold/italic, lists, quotes, links, code, rules).
- **Outlines** become nested `- ` bullets.
- **Manuscripts** are an ordered list of references to your text files. They
  export as Obsidian `![[Note]]` embeds, so editing a text file updates the
  draft view.
- Trashed files are skipped.
- Each file starts with frontmatter: `byok-id`, `byok-type`, `byok-updated`.
  Leave `byok-id` alone; it ties the file back to its Studio record.

## Re-running safely

Unchanged output is left alone. If a file differs from its **saved
last-export hash**, it is skipped and reported as edited. Hashes are kept in
`$XDG_STATE_HOME/byok-studio-export/state.json` (default
`~/.local/state/byok-studio-export/state.json`), outside your notes.

**This is not unconditional overwrite protection.** If a destination file
already exists but has no saved hash (first export, deleted state, or a
changed relative path), the script can overwrite it. Keep the state file,
back up notes before rerunning, and use a dedicated output folder. State is
keyed by relative path, not by output directory; use a separate
`XDG_STATE_HOME` when maintaining independent export destinations.

`--dry-run` reads the database and existing output/state, but writes neither
notes nor state. Its `written` label means “would write” in that mode.

## Limits

- Export only. There is no import back into Studio; use Studio's own
  Markdown import for that.
- Relies on Studio's undocumented internal schema, which may change.
- Renamed or deleted Studio items do not remove old exported files.
- Names are sanitized but collisions are not resolved. Duplicate names in
  one folder can target the same file; manuscript embeds use bare note
  names and may be ambiguous across folders.
- If the database is absent, export fails; if Studio changes its schema,
  SQLite/JSON errors may require adapting the script. It is not a backup
  replacement for the original library.
- HTML conversion is a small hand-written converter, not a full one. Tables,
  images and nested formatting edge cases are not handled.

## License

MIT
