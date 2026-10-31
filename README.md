# byok-studio-export

One-way export of your [BYOK Studio](https://byok.io/studio) desktop library to
plain Markdown files, so you can read, edit and sync your writing (Obsidian,
git, Syncthing, ...) without Studio's paid sync.

Unofficial. Not affiliated with BYOK.

## Why

Studio keeps its library in a SQLite database, not in Markdown files. This
script reads that database (read-only) and writes one `.md` file per Studio
file, laid out like your Studio projects.

## Requirements

- Linux (Studio desktop's data path is hard-coded to `~/.config/studio-desktop/`;
  other platforms need that path changed)
- Python 3.8+, standard library only

## Usage

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

Re-runs are idempotent. If a file has changed on disk since the last export
(because you edited it), it is **skipped and reported**, never overwritten.
Last-export hashes are kept in `$XDG_STATE_HOME/byok-studio-export/state.json`
(default `~/.local/state/byok-studio-export/state.json`), outside your notes.

## Limits

- Export only. There is no import back into Studio; use Studio's own
  Markdown import for that.
- Relies on Studio's undocumented internal schema, which may change.
- HTML conversion is a small hand-written converter, not a full one. Tables,
  images and nested formatting edge cases are not handled.

## License

MIT
