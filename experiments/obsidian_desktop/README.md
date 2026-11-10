# Real Obsidian desktop validation

This harness runs the built plugin inside the actual Obsidian desktop app, against
a disposable vault and a synthetic Studio database. It complements `npm test`, whose
unit tests use a mocked Obsidian API (`test/adapter.test.js`) and cannot show how the
real app behaves.

```sh
npm ci && experiments/obsidian_desktop/run.sh
```

The script exits non-zero if a check fails. Results go to `evidence/report.json`, which
is regenerated on each run along with the screenshots and the app log. Requires `bwrap`,
the Arch `obsidian` package (`/usr/lib/electron43/electron` and
`/usr/lib/obsidian/app.asar`), `/usr/bin/sqlite3`, and permission to create user and
network namespaces. A tool sandbox that blocks nested namespaces or Unix sockets has to
be lifted for this one command.

## Isolation

- `bwrap --unshare-all` with an empty tmpfs on `/home`, so live vaults, keychains and
  credentials do not exist inside the jail.
- The network namespace has only an isolated loopback. The renderer requested no HTTP
  hosts; the main process's update checks fail with `ERR_INTERNET_DISCONNECTED`.
- The environment is built from `env -i`. The vault and database live in a `mktemp`
  directory that is deleted on exit.
- `run.sh` compares only the mtime and size of the live `obsidian.json` before and after,
  and never reads its contents.

## What is real and what is not

Real: Obsidian 1.15.0 on Electron 43, its vault and editor code, the built `main.js`,
and `sqlite3` reading a database created with the schema in `src/tested-schema.json`.

Driven through real UI over the Chrome DevTools Protocol (mouse, keys, text input):
the vault trust prompt, enabling the plugin in Settings, typing the database path, the
command palette, and editor typing.

Driven through app objects, because the scenario needs them: opening notes
(`openLinkText`), firing the import in the same turn as a buffer sample
(`executeCommandById`), opening and closing Settings, and entering Canvas edit mode and
placing its caret (`startEditing`, `setCursor`). The Canvas text itself is real input.

Not exercised:

- A compositor or window manager. Electron runs with `--ozone-platform=headless`, and
  `--no-sandbox` inside the jail.
- Any other Obsidian build. The Flatpak 1.14.5 on the test machine was not run.
- A real Studio binary or real library. The database is synthetic.
- Studio write-back. `studioAsar` is left empty, and every import checks that the
  database bytes, records and outbox are unchanged.
- Editors in hover popovers.

## Scenarios

`isolation`, `install`, `first-import`, `repeat-import`, `restart`, `studio-update`,
`saved-vault-edit`, `unsaved-editor`, `editor-opened-mid-import` (300 records),
`marker-and-state-guards`, and `unsaved-canvas-embed`. See `driver.js`.

## Canvas regression

The checked-in original evidence recorded the race: an unsaved Canvas editor had no
Markdown leaf, the import reported the Studio revision updated, and the Canvas buffer
then saved over that revision. The scenario now fails if import is not refused before
writing, and checks the unsaved edit survives. Closing the Canvas and retrying leaves
the saved vault edit as a conflict. The plugin blocks all Canvas views and detected
hover popovers; hover popovers and third-party editor surfaces have not been exercised
in this real-app harness. See the main README for detection and race limitations.

### Smaller observations

- A manually copied plugin triggers Obsidian's vault trust prompt ("Trust author and
  enable plugins"). The project README does not mention it.
- `Beta original.\n Added in the Obsidian editor.` is the saved form of the edit-preservation
  fixture. Text typed at the end of a note has no trailing newline.
- An editor opened during a 300-record import stopped further writes after 7 notes were
  created, with 295 reported `changed`. A retry left all 300 notes present exactly once.
