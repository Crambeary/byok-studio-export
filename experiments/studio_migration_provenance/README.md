# Library migration provenance (issue #5)

Research only. Nothing here is wired to the plugin, and `src/` is unchanged. Every
library is synthetic: Studio 1.1.3 creates it inside a bubblewrap jail with only
a loopback interface and an empty home. No real library, credential or BYOK
service is involved, and no statement issued here writes an outbox row.

Tested on Studio 1.1.3 on Linux (`app.asar` sha256 `25e93b78…`, Electron 44.4.5,
SQLite 3.53.4). Results are in `evidence/provenance_lab.json`, 27 fixtures, of
which 23 were booted by the real binary.

## Answer

**Which build migrated a database cannot be recovered from the database.** Studio
keeps no migration history. What can be verified is narrower and more useful:
whether 1.1.3 would leave this database's structure alone on its next launch.

**Identical schema plus the current guard is not enough.** Six fixtures had a
schema identical to the tested one and a missing or low `schema_version`. The
current guard accepted and committed the write each time, and the next real
Studio launch then deleted every row in `files` and `projects`, including the
written file.

**Adding an exact `schema_version` check closes that gap, but does not by itself
justify lifting the disposable-only restriction.** See "What this does not
establish".

## What Studio records

| Signal | Source | What it shows | Limit |
| --- | --- | --- | --- |
| `metadata.schema_version` | `src/mirror.js:26,84-88,188` | The destructive block has run. Currently `3`. | One number. Nine tables are created outside it. |
| `telemetry.lastVersion` | `src/telemetry.js:432-435`, called at `main.js:486` | The last build to finish startup. Runs after `init` at `main.js:450`. | A launch stamp, not a migration record. |
| `telemetry.firstVersion` | `src/telemetry.js:427-431` | The build running when telemetry first started here. | Says nothing about earlier builds. |
| `sqlite_master` text | SQLite | Exact stored DDL, including whitespace. | Stricter than meaning. See below. |
| SQLite header last-writer | File bytes 96-99 | `3053004`, the SQLite library. | Identifies the library, not Studio. Any tool using 3.53.4 stamps the same value. |
| `user_version`, `application_id` | Never set by Studio | Both `0`. | Carry no information. |

Studio has no migration log, and rows carry no build stamp.

**The history is erased by design.** `additive_tables_absent` drops the nine tables
created outside the versioned block. After one boot its schema digest equals a
fresh library's, and `schema_version` is the same.

## Why schema identity fails

`ensureSchema` (`src/mirror.js:83-191`) parses the marker with `Number(value) || 0`
and runs a block containing `DROP TABLE IF EXISTS files` and `projects` when the
result is below 3. The check is only on the marker, so the schema being current
does not protect the rows.

"Accepted" is the current `src/writeback.js` SQL, with its environment check stubbed.

| Fixture | Schema identical | Current guard | Real Studio boot |
| --- | --- | --- | --- |
| `control_fresh` | yes | accepted | written content kept, no schema or table change |
| `marker_missing`, `_2`, `_0`, `_null`, `_empty`, `_garbage` (`3abc`) | yes | **accepted** | **`files` and `projects` emptied, write lost** |
| `marker_future_4` | yes | **accepted** | Kept. Studio leaves `4` in place (`current >= 3`). |
| `v2_shape` | no | refused | `files` and `projects` dropped, marker becomes `3` |
| `mode_synced`, `owner_real_account`, `auth_token_present` | yes | **accepted** | not booted, to avoid the sync path |
| `extra_trigger_evading_count` | no | **accepted** | not booted |

How reachable the destructive state is: the marker is written in the same
transaction as the block, and no code path in 1.1.3 removes it. Studio alone is
not shown to produce an identical schema with a low marker. Restored, partially
copied or externally edited files could. The check is one line, and the failure
is total.

`extra_trigger_evading_count` is a separate defect in the current guard. Its
object count uses `NOT LIKE 'sqlite_%'`, where `_` matches any character, so a
trigger on `files` named `sqliteXtrigger` is not counted.

## Candidate predicate

`candidate.py` is read-only. All of these must hold:

- Every object's `sqlite_master` text matches `src/tested-schema.json`, and the
  object count matches, using `NOT GLOB 'sqlite_*'`.
- `schema_version` is the text `3` exactly.
- `telemetry.lastVersion` is `1.1.3`.
- `currentUserId` is `local`, `mode` is absent or `local`, and no `authToken` row
  exists. The token is only counted, never read.
- `user_version` and `application_id` are `0`.

Results:

- It refused all six destructive fixtures, `v2_shape`, the future marker, the
  evading trigger and all three account-state fixtures.
- It accepted two booted fixtures before launch, `control_fresh` and
  `legacy_metadata_keys`. In both, the write survived and no schema or table
  changed. The second fixture lost only its obsolete `maxSeenTime` key, which
  Studio deletes at `src/db.js:34`.
- That is a small accepted set, so it supports the predicate but does not prove it.
  The argument also rests on `init` having few branches: the marker block, the
  `users` repair, `CREATE TABLE IF NOT EXISTS`, and the `entitlements` drop.

`telemetry.lastVersion` is the weakest check. Fixtures with it missing, older or
newer all kept the write through a 1.1.3 boot, so nothing here shows it prevents
damage. Its value is refusing a database last opened by a build other than the
tested one, which the asar hash cannot show. It is an analytics key and could
change without notice.

## Known false refusals

These are safe and were kept deliberately. Some are permanent, because Studio
does not normalize them.

| Fixture | Candidate after a boot |
| --- | --- |
| `users_early_shape`: `repairUsersTable` writes different indentation from the versioned block | refused, permanently |
| `whitespace_only_files`, `folders_old_shape`, `extra_table` | refused |
| `marker_float_text` (`3.0`), `marker_leading_space` | refused. Studio treats both as 3 and rewrites neither. |
| `user_version_set`, `application_id_set` | refused |
| `additive_tables_absent`, `legacy_entitlements`, older or newer `lastVersion` | accepted. One 1.1.3 launch cures these. |

## What this does not establish

- **Real upgrades were not run.** Older shapes are built from Studio's own source
  comments. No earlier Studio build was launched, since this investigation was
  limited to 1.1.3.
- **Old row contents are unverified.** A schema says nothing about `files.data`
  written by an earlier build. The write is limited to one row by compare-and-swap,
  keeps other JSON keys, and `src/import.js` requires a string `content`, but no
  row written by an older build was tested.
- **Sync remains unverified.** The account-state checks only refuse. They do not
  show that a direct write would survive sync.
- **The outbox limit is unchanged.** Files with pending outbox rows are still
  refused, which is every file Studio has edited in local mode.
- **Source-only claims.** `start()` has no opt-out gate, so `lastVersion` should
  update with telemetry disabled, but that was not run. Nor was a launch that
  crashes between `init` and `start()`.
- **The predicate was run outside the write transaction.** Shipping it requires
  moving these checks inside `BEGIN EXCLUSIVE`.
- Windows, macOS, other Studio versions and network filesystems were not run.

## Reproducing

```sh
python3 lab_provenance.py --studio-dir ~/studio-linux/electron --xvfb /path/to/Xvfb
```

It needs bubblewrap, `sqlite3` 3.53.4 and Node, and takes about six minutes. It
refuses any other `app.asar`, and aborts if the jail has anything besides a
loopback interface. It imports the jail from `../studio_write_guard/lab_studio.py`.
The Xvfb used has sha256 `ffe89f25…`.
