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

## Findings

Checks assert the plugin's stated guarantees. Findings record observed behaviour that
needs a decision, and do not fail the run. Both appear in `evidence/report.json`.

### A note open in a Canvas editor is not protected

The guard in `src/main.js` counts only `markdown` leaves. A note being edited inside a
Canvas belongs to a `canvas` leaf, so the import is not refused. Observed in each of
three runs with this scenario, with text typed but not yet saved:

1. The import writes the Studio revision to disk and reports the note `updated`.
2. Within the next five seconds, the open Canvas editor saves its buffer over that
   revision. The typed text survives, and the Studio revision is gone from the vault.
3. The next import reports the note `changed` ("Vault edit preserved") and leaves it
   alone, so nothing further is overwritten. The Studio revision stays in Studio, but
   does not reach this note until the conflict is resolved.

The check "unsaved Canvas edit survives the import" passes because of that ordering. It
is not evidence that the plugin protects Canvas editors.

### Smaller observations

- A manually copied plugin triggers Obsidian's vault trust prompt ("Trust author and
  enable plugins"). The project README does not mention it.
- `Beta original.\n Added in the Obsidian editor.` is the saved form of the edit-preservation
  fixture. Text typed at the end of a note has no trailing newline.
- An editor opened during a 300-record import stopped further writes after 7 notes were
  created, with 295 reported `changed`. A retry left all 300 notes present exactly once.
