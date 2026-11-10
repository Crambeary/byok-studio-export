# Studio upgrade compatibility experiment (issue #5)

**Historical experiment:** this lab depends on the former experimental writer
and schema allowlist removed from the one-way importer. Reproduce it using the
earlier repository revision that produced its checked-in evidence.

Does a library made by an older Studio survive an upgrade to the tested 1.1.3,
and does the current guarded write behave safely on it? This directory answers
that with a real older build and synthetic libraries only. It is research code,
and nothing here authorizes writing to a real library.

**Result: the 0.5.2 to 1.1.3 upgrade preserved every record and produced exactly
the tested schema, and the guard behaved safely throughout. The compatibility
blocker remains, for a different reason than expected: the guard refuses
everything Studio's own UI makes in a local library.**

## What was run

`lab_upgrade.py` drives the unmodified builds in a bubblewrap jail with only a
loopback interface and an empty home, then runs `guardedWrite` from `src/` with
its real environment check on disposable copies.

1. **Seed on 0.5.2.** The UI creates a project and a text file, types, takes a
   version snapshot, and types more. 0.5.2's own `mirror` bridge then writes a
   second project, a folder, and records of several shapes. The bridge queues no
   outbox work. This lab never calls `sync` or `ops`.
2. **Guard the un-upgraded library.** Every record is attempted, passing the real
   1.1.3 `app.asar` so only database-level checks can refuse.
3. **Upgrade.** 1.1.3 boots on the same user data directory.
4. **Guard the upgraded library,** one fresh copy per record.
5. **Reopen.** Each accepted write is copied back into a user data directory. 1.1.3
   boots, reads it through the bridge, opens it in the editor, types, and exits.
   The guard is then tried on the result.

Each phase records the jail's interfaces and aborts unless the only one is `lo`.
No statement here writes to the outbox. Rows Studio queued itself are only read
and hashed.

## Observed

From `evidence/upgrade_lab.json` (26 of 26 checks passed), Studio 0.5.2 and 1.1.3
on Electron 44.4.5, Linux port, local mode.

| Question | Observation |
| --- | --- |
| Migration | 1.1.3 added `comments`, `card_catalog`, `card_installs` and `idx_comments_file`. It removed nothing and changed no existing definition. The result is identical to `src/tested-schema.json`, all 28 objects. |
| Preservation | All 8 `files` rows, the `local_versions` row and the 3 outbox rows hash the same before and after the upgrade. `integrity_check` was `ok` with no foreign-key violations. `telemetry.firstVersion` stayed `0.5.2` and `lastVersion` became `1.1.3`. |
| Before upgrading | The guard refused all 8 records and left the database and WAL bytes unchanged. Six were refused as incompatible schema or migration metadata, and two earlier by the paragraph codec. |
| Accepted after upgrading | 4 records: plain paragraph, Studio-normalized paragraphs, a file in a folder, and a record with extra JSON keys. Each changed only its own row, kept all JSON fields but content and timestamps, kept its pre-image as a version, and left the outbox alone. |
| Refused after upgrading | 4 records, each with bytes unchanged. See below. |
| Reopen | 1.1.3 exited 0 on every boot, booting changed nothing, the bridge returned the written content, and the editor showed it (`evidence/reopened.png`). Integrity stayed `ok`. |
| Later UI edit | The edit kept the written text and changed only that record. Extra JSON keys survived. Studio queued its own `file.update`, and the guard then refused that record for its outbox reference. |

### Why records were refused after upgrading

| Record | Refused by |
| --- | --- |
| File created and typed in the UI | Outbox reference. Studio queues outbox rows for every UI edit in local mode. |
| Outbox-free record in a UI-created project | Project ancestor check. See below. |
| Headings and bold | Paragraph codec. |
| Non-text (`grid`) | Paragraph codec, which runs before the SQL type check. |

## The blocker

A project made in Studio's UI stores `"user": null`. The ancestor check in
`src/writeback.js` allows only an absent `user` key or the value `local`. SQLite's
`json_type` returns the text `'null'` for a JSON null, not SQL `NULL`, and
`json_extract` returns SQL `NULL`, so the row does not match and the guard
refuses. The same condition applies to the record's own `user` and `userId`.

This is not caused by the migration. `experiments/studio_writeback/evidence/report.json`
shows a project created by 1.1.3's UI with the same `"user": null`. The guard was
not run on a fresh 1.1.3 library here, so that step is inferred from the identical
value and the SQL.

Together with the outbox check, this means no record made through the UI in a
local library can pass today. The accepted records above exist only because 0.5.2's
bridge wrote them into a project without a `user` key, and real libraries are not
made that way. The refusals are safe, and they lose nothing, but two-way sync
cannot write to a real local library until both conditions are resolved.

Deciding either one needs more than this experiment supplies:

- Treating JSON `null` as local ownership looks correct for local projects, but
  this lab has not shown what a `null` means in a library that has synced.
- Whether a local-mode outbox row can be safely ignored depends on what happens
  when sync is enabled later. `experiments/studio_writeback/README.md` documents
  that hazard, and it stays unresolved.

## Not verified

- **Any other older version.** 0.5.2 is the only older build this search could
  verify, the only capture of the vendor's download URL in the Internet Archive.
  Versions between 0.5.2 and 1.1.3 were not run, nor anything before 0.5.2.
- **Native packaging.** The payload is the Windows installer's `app.asar` on the
  Linux Electron runtime, matching how the tested 1.1.3 port is built. No Windows
  or macOS run happened. Both builds use the same Electron and the same SQLite.
- **Sync of any kind,** the `synced` mode, and libraries that were ever signed in.
- **Real or large libraries.** Each library held 8 synthetic records.
- **Bridge-written shapes as a stand-in for real data.** They show what 0.5.2's
  storage layer preserves, not what its UI would have produced.
- **Other record types** past the guard. Grids, cards, outlines, manuscripts and
  wikis never reach a write.

## Provenance

`obtain_build.py` downloads the 0.5.2 installer from the Internet Archive capture
of the vendor's bucket, or takes `--installer`, and refuses it unless these all
hold: size, SHA-256, the Archive's recorded SHA-1, the Authenticode digest and
signature chaining to Microsoft's root (signer `BYOK LLC`), and the pinned
`app.asar` hash. The Electron runtime is checked against GitHub's published
`SHASUMS256.txt`. Results are in `evidence/provenance.json`. The short-lived
signing certificate (3 to 6 October 2026) has expired, so the chain is verified
ignoring expiry. The bucket's `Last-Modified` of 5 October falls inside that window.

The 1.1.3 binary and `Xvfb` are not redistributable here. `lab_upgrade.py` refuses
to run unless their hashes match the pinned values, which are also in the report.

## Reproduce

Needs Linux, `bwrap`, `7z`, `openssl`, the `sqlite3` CLI at 3.53.4, Node, a Studio
1.1.3 port, and `Xvfb`. This overwrites `evidence/upgrade_lab.json`:

```sh
python3 obtain_build.py --out /path/to/stage
python3 lab_upgrade.py --old-dir /path/to/stage/studio-0.5.2/electron \
  --new-dir /path/to/studio/electron --xvfb /path/to/Xvfb
```

IDs and timestamps differ per run. The whole run takes several minutes.
