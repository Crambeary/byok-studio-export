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
missing CLI, or inaccessible database fails the import. Text, observed outline
and manuscript shapes are imported. Outlines become nested bullets with node IDs;
manuscripts show ordered sections with entry and file IDs, reading text from the
current file rows rather than the possibly stale embedded copies. Duplicate file
references remain separate. These views are read-only: editing one preserves it
and requires manual reconciliation. Missing references, malformed or unfamiliar
structures are reported without replacing an existing view. The observed shapes
and their limits are documented in [the Studio capture](experiments/structured_import/README.md).
The observed plain-text cardstack and grid shapes are also projected as literal
JSON code blocks, retaining IDs, array order, and tile coordinates. Only medium
sections, uncolored cards and uncolored non-header version-2 tiles with empty
connections, groups and labels are accepted; unfamiliar fields, formatting and
structures are reported as unsupported. See the [synthetic capture](experiments/cardstack_grid/README.md)
for the evidence and its limits. HTML conversion is incomplete and converted text is reported as potentially
lossy; other record types are reported without import. Structured records are
never written back to Studio. Existing notes are preserved on import: collisions receive a distinct name.
A later Studio-only change refreshes an unchanged imported note after checking
the source again and atomically checking the note. Vault edits are preserved
and reported for manual handling. Conversion remains potentially lossy; the
original Studio content is retained. Renames and deletions are not propagated. Plugin state keeps
the imported content and record paths per database path, vault path, destination and Record in the vault's plugin
data; moving a database or vault, upgrading from the previous import-only
state, or removing state starts a separate import and can create additional
notes. Older imports without saved ancestor identities reserve their existing
folders; new notes may be placed in separate suffixed folders and the report
flags this. Do not edit or delete that state if you
want to retain the mapping. The plugin opens the Studio database read-only and
never writes vault edits back. Historical write-back experiments are research,
not plugin features. A failed state save after a note refresh retains the old
baseline; a retry can recover a refresh when its saved intent matches the note.

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
  [`experiments/studio_writeback/`](experiments/studio_writeback/README.md)
  records research into writing back on a disposable library; it is not a
  feature and must not be pointed at a real library.
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

### Import recovery and editor safety

Close all Markdown views, Canvas views and hover popovers before importing. The plugin
blocks imports while any of these surfaces is open, even if it is not editing a note,
and checks again before mutations. Unsaved buffers cannot be reliably compared with
vault files. Do not open an editor during an import. Canvas detection uses workspace
leaf types; hover detection relies on Obsidian’s internal `.hover-popover` class and
may break in other versions. Third-party views, other embedded editors and popovers
are not reliably detectable; close them too. There is no atomic lock against an
editor opening after the final check. A per-destination hidden
`.byok-sync-*.json` marker detects a missing scope in plugin data; keep it with the
vault and back up both the vault and the plugin's `data.json`. If state or the marker
is corrupt, restore the matching files from a backup before retrying. Do not delete
markers to bypass a refusal. Loss of both the marker and state cannot be detected.

A first import saves a reservation before creating a note. After an interrupted save,
retry with the same plugin data. An unoccupied reserved path is recreated. Any
occupied reserved path is left untouched because matching content alone cannot prove
ownership. To recover, close editors, move the occupied note to a different path,
then retry the import; compare and reconcile the preserved note with the recreated
note yourself. Never delete an occupied note merely to clear the reservation. Restore a matching backup
if the reservation itself was lost. Existing imports made before markers were added
are protected once run with this version; state already lost before that cannot be
identified automatically. Note creation still saves state per record to preserve
these recovery guarantees, so large imports can remain slow.

Older plugin versions may have left `recovery` or `conflict` state from their
experimental write-back. These records remain paused and are reported, even if
the source record disappears. Preserve the note, conflict snapshot and plugin
`data.json`; back up the Studio library and vault, then reconcile manually.
There is no automatic resolution UI. Do not remove recovery state until the saved
versions and current source have been compared and a consistent baseline restored.
