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
Studio data is never written. Existing notes are preserved on import: collisions receive a distinct name.
A later Studio-only change refreshes an unchanged imported note after checking
the source again and atomically checking the note. Vault edits are preserved
and reported for manual handling. Conversion remains potentially lossy; the
original Studio content is retained. Renames and deletions are not propagated. Plugin state keeps
the imported content and record paths per database path, vault path, destination and Record in the vault's plugin
data; moving a database or vault, upgrading from the previous import-only
state, or removing state starts a separate import and can create additional
notes. Do not edit or delete that state if you
want to retain the mapping. Write-back is currently disabled because Studio being closed cannot be established throughout a write. The experimental transaction is restricted to explicitly marked disposable libraries and uses the Linux Studio 1.1.3 WAL exclusive-lock guard. The setting requires the tested Studio app.asar. Inside the transaction, the guard requires the exact recorded schema, migration marker and last-launch version, zero SQLite header versions, and local account state with no auth row. These conservative checks can refuse otherwise safe libraries. They do not establish migration provenance or compatibility with older builds; real libraries remain ineligible. See `experiments/studio_migration_provenance/README.md` for the evidence and limitations. The narrow literal-paragraph codec limits eligible edits.
Pending outbox operations may contain stale text and must be checked before any
future write-back; the experiment observed this hazard. Future Studio sync behavior
is outside the plugin's control and has not been verified. No unmarked Studio database is written. A state-save failure after a note update requires manual
recovery; the prior baseline is retained.

Run `npm test` for the disposable SQLite/WAL sync-boundary tests; these run without the proprietary Studio binary. The schema allowlist in `src/tested-schema.json` is reproducible by executing the checked-in schema in SQLite and selecting `type, name, sql` from `sqlite_master` with `name NOT GLOB 'sqlite_*'`, ordered by type and name. The original
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

Studio 1.1.3 has been observed creating local projects with JSON `user: null`
([synthetic upgrade evidence](experiments/studio_upgrade_compat/README.md)), but
that experiment did not prove that accepting null preserves the account ownership
guard. Normal-mode write-back therefore refuses it and records with outbox
references. The disposable-only restriction also remains in force.


### Disposable local-only experiment

Write-back is off by default. The separate **Enable disposable write-back and accept risks** setting opts in to writes only to marked disposable synthetic libraries on the tested Linux build. Close Studio first: the process check is a best-effort snapshot and the SQLite lock cannot prevent Studio from starting between that check and the write. Process inspection may miss instances in other PID or mount namespaces, or renamed executables; an unavailable or uncertain inspection refuses the write. Later Studio Sync may overwrite these edits. The **Disposable local-only experiment** setting is also off by default and separately opts into its outbox and local ownership exceptions. The research transaction can accept JSON null local ownership and existing queued references only for marked disposable synthetic libraries; it never changes the outbox. The pinned build, local metadata, schema, ownership, and live-library restrictions remain in the research transaction.

**Future Studio Sync can overwrite these edits** using older queued operations or
remote data. This setting does not make Studio Sync safe. Do not use it on real
libraries, or transition an experimental library to an account or Studio Sync.
Keep separate backups and preserve the vault and previous baseline if a sync
reports a conflict or partial application.

### Experimental concurrent text edits

This dependent prototype builds on PR #39 and issue #5, which remains incomplete. All existing disposable-library, local-only, Studio closure and write-back safeguards still apply. Only the verified literal paragraph subset can be reconciled. Changes to distinct existing paragraphs may merge; reordered, repeated, inserted, deleted, overlapping or otherwise ambiguous paragraphs may require manual recovery or a conflict. Unsupported formats remain protected.

For a reported conflict, the original vault note remains in place and a separately named `Studio conflict` note holds the Studio version. The record stays paused. To resolve it, edit the original note to the desired reversible text, leave its metadata intact, and append a separate `RESOLVED` line to the unchanged conflict note. Close editors and run sync. The Studio snapshot is retained. If the Studio record changed, the conflict note is missing or altered, or a partial write occurred, automatic resolution refuses; preserve both copies and recover manually. Conflict state also retains the original vault text.
