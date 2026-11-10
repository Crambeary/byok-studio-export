# Local outbox and ownership blocker (issue #5)

At commit 83d665a, there is no demonstrated way to allow an ordinary UI-created
file through the write guard while guaranteeing that later Studio sync cannot
lose the write. Keep the outbox and ownership guards unchanged. This is a
specific counterexample to ignoring local queued operations, not a proof that all
possible local-only designs are impossible.

## Evidence

The [parent issue](https://github.com/Crambeary/byok-studio-export/issues/2)
requires local-only operation and prohibits outbox modifications. The existing
[real Studio experiment](../studio_writeback/README.md#sync-hazard) created a
file and edited it in local mode. Its pending `file.update` contained the old
content after a direct write; reopening without editing did not change the
outbox. Its later UI edit coalesced a new update, but that cannot protect the
interval before the edit. A subsequent UI version restore also left the queued
update stale. [Upgrade evidence](../studio_upgrade_compat/README.md#the-blocker)
shows a real UI project has JSON `user: null` and that both checks block normal
UI-created records.

The pinned Studio 1.1.3 `src/syncEngine.js` (inside the asar, SHA-256 in
[evidence.json](evidence.json)) documents replayable request bodies. Lines
225–229 leave the queue in local mode, and lines 241–262 use the stored body in
the request. Lines 388–408 select pending operations FIFO and apply successful
server responses; lines 308–321 call `mirror.putFile` for both `file.create`
and `file.update`. The pinned `src/mirror.js` lines 491–498, 516–520 and
732–736 upsert the returned object's entire JSON into `files.data`. The success
callback does not check whether a later local write occurred. Thus, if a future
server returns an older file on successful replay, Studio's callback replaces
the newer local JSON. Even the earlier queued create can do this, before its
queued update is processed. Actual server replies, conflicts, and subsequent
sync behavior are unknown; this is a conditional local code path, not a claim
that a server replay was observed.

`probe.py` runs the exact extracted callback and mirror functions in Node with a
strict in-memory database adapter and synthetic old server responses. It shows
both create and update replace `vault edit` with `old Studio text`. This is a
source-level experiment, not a real SQLite, real Studio, network, or full sync
run; the adapter models the extracted UPSERT's `data=excluded.data` assignment.
It additionally runs the guard's ownership expressions in an in-memory SQLite
database. Missing and `local` values pass; JSON `null` and a foreign value fail
for file/project, and are rejected for folder ancestors. This confirms the SQL
behavior but does not establish whether null proves local ownership in a library
that previously synced. See [evidence.json](evidence.json) for the actual run.

## Candidate paths and limitations

- **Ignore queued rows in local mode:** unsafe under the conditional replay path
  above. The mode is mutable after the plugin exits. A plugin setting, marker,
  warning, or current lack of credentials cannot enforce permanent offline use.
- **Ask for a Studio edit after write-back:** the old body remains until that
  happens; the writer may never do it, and not all references are coalesced.
- **Rewrite, delete, or add operations:** outside the parent issue's explicit
  scope and this investigation's constraints. Nor is an empty queue by itself
  proof that future server pulls preserve a direct write.
- **Treat JSON null as local:** plausible for a fresh UI project, but insufficient
  ownership evidence for a previously synced library. Even a correct null change
  cannot address stale queued creates and updates.
- **One-way Studio-to-vault sync:** already useful and does not resolve this
  write-back blocker. A separate permanently isolated library or a supported
  Studio import mechanism could be researched, but neither is validated here.

Other existing restrictions still apply: only marked synthetic libraries, a
pinned Linux build and filesystem, exclusive lock, compatible schema and narrow
paragraph codec. Sync, other platforms, account transitions, server semantics,
large and real libraries, and recovery after a later overwrite remain untested.
No real library write-back is authorized by this result.

## Reproduce

With Node, Python 3 and the pinned Studio 1.1.3 `app.asar` available locally:

```sh
python3 experiments/studio_outbox_blocker/probe.py --asar /path/to/app.asar
```

The script checks the asar hash, reads only its source, creates no library and
makes no network requests. It neither reads credentials nor accesses an outbox.
Its SQLite database and the JavaScript adapter exist only in memory. The
checked-in evidence was obtained with SQLite 3.53.4. The earlier real-Studio
experiments have their own reproducible commands and isolation details.
