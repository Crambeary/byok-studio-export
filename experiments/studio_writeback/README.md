# Disposable Studio write-back experiment (issue #4)

Can a direct SQLite write to Studio's database, made while Studio is closed,
survive a real Studio reopen? This directory answers that against a fresh
synthetic library only. It is research code, not a supported feature, and
nothing here authorizes writing to a real library.

**Result: for one text file, on one Studio build, in local mode, yes. Sync is
the unresolved problem, and the evidence shows a concrete hazard there.**

## What was run

`run_experiment.py` launches the unmodified Studio binary three times in a
bubblewrap jail, and drives its real UI over the DevTools protocol:

1. **seed**: Studio's UI creates a project and a text file, types text, takes a
   version snapshot, types more, and exits.
2. **write-back**, with Studio closed: `writeback.py` replaces the file's
   content in SQLite and stores the previous content as a version.
3. **verify**: Studio reopens; the bridge and the editor are read, then it idles
   10 seconds and exits without any typing.
4. **edit-restore**: Studio reopens, types into the written-back file, restores
   the pre-image version through Studio's version bridge, and exits.

The jail has its own network namespace containing only `lo`, and an empty home.
Only `/usr`, fonts, the Studio binaries (read-only), this directory (read-only)
and a temporary work directory are visible, so the live library and any account
token do not exist inside it. Each phase records the jail's interfaces, and the
final library is checked for having no `authToken` key and no `synced` mode.
`writeback.py` also refuses any database that is not inside a directory holding
a `DISPOSABLE_SYNTHETIC_LIBRARY` marker, and always refuses the live path.

## Observed on a real Studio

All from `evidence/report.json` (23 of 23 checks passed), on Studio 1.1.3 on
Electron 44.4.5, Linux port, local mode. Binary hashes are in the report.

| Requirement | Observation |
| --- | --- |
| Reopening | Studio started and exited with code 0 on each launch after the write. `evidence/reopened.png` shows the written content in the editor. |
| Content | Main-process `getFile` returned the written HTML byte for byte. |
| Indexed fields | `user_id`, `project_id`, `folder_id`, `type`, `is_trashed`, `position` and `created_at` were unchanged and agreed with the JSON blob. `getProjectTree` still listed the file, and the project query used `idx_files_project`. |
| Timestamps | `updatedAt` and `contentUpdatedAt` held the written value through reopening, `createdAt` was preserved, and `getProjectActivity` reported the written time as `lastEditedAt`. |
| History | Studio listed the externally inserted version beside its own, returned its content, and restored it, writing its own `pre_restore` backup first. The Python fingerprint equals the one Studio stored for the same content. |
| Consistency | `integrity_check` was `ok` with no foreign-key violations after reopening and after later edits. |
| Later editing | A UI edit on top of the written content kept that content. |
| Cache | `localStorage` held no document text, only caret and scroll keys for the file. IndexedDB was empty. The stale caret key caused no visible problem in this short document. |
| Outbox | The write-back changed no outbox rows, and reopening and idling changed none either. |

**Studio rewrites HTML when it next saves.** Opening the editor did not change
the stored row, but the first UI edit stored normalized HTML, with
`class="editor-paragraph"` on paragraphs and an `id` on headings. Two-way sync
must not treat that as a user content change.

## Sync hazard

In local mode every UI edit queues an outbox row, so the library held a pending
`file.update` before the write-back. Its body still contained the **old** text
afterwards, because the write-back deliberately does not touch the outbox. A
later UI edit replaced that body with the new content.

So if sync were enabled after a write-back and before any further UI edit, that
queued `PUT` appears set to send the old text. **That replay was not run**: no
sync was exercised and no server contacted. `mirror.js` also protects rows
referenced by pending outbox entries from server overwrites, so rows changed
without an outbox entry appear unprotected. That second point comes from reading
source only.

## Not verified

- **Sync of any kind**, including outbox replay, server pulls, conflict
  handling, and the `synced` mode. Future sync compatibility must not be assumed.
- **Writing while Studio runs**, or a crash during the write. Studio was closed
  each time, and how it sees concurrent WAL writes is unknown.
- **Other record types and states**: grids, cards, outlines, manuscripts, wikis,
  files in folders (only `folder_id = NULL` was run), and renames or moves.
- **Large or old real libraries**, and migrations from earlier schema versions.
- **Other platforms or Studio versions.** The schema is undocumented and may
  change. Only this Linux port was run.
- **The Version History window.** History was exercised through the bridge that
  window uses, not by opening it. A restore from that window may also queue
  outbox work; after the bridge restore, the queued `file.update` body still
  held the edit made before the restore.
- **Long sessions.** Idle was 10 seconds, so autosave or automatic snapshots on
  longer timers were not observed.

The experiment labels the pre-image `manual`, so it displays as "Manual
Snapshot" and counts against Studio's 30-version limit. That is a prototype
choice, not a proven format.

## Reproduce

Needs Linux, `bwrap`, a Studio install, and `Xvfb` (a standalone binary is fine;
nothing has to be installed system-wide). This overwrites `evidence/`:

```sh
python3 run_experiment.py --studio-dir /path/to/studio/electron --xvfb /path/to/Xvfb
```

Timestamps and IDs differ per run. The unit tests need neither Studio nor `Xvfb`:

```sh
python3 -m unittest test_writeback
```
