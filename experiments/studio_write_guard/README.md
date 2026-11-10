# Closed-Studio write guard (issue #5)

Research only. `guard.py` is not wired to the plugin, and it refuses any database
outside a directory holding the `DISPOSABLE_SYNTHETIC_LIBRARY` marker. Nothing
here opens a real library, reads credentials, contacts a server or issues a
statement that writes to the outbox.

Tested against Studio 1.1.3 on Linux (`app.asar` sha256 `25e93b78…`, Electron
44.4.5, SQLite 3.53.4). Results are in `evidence/sqlite_lab.json` (19 of 19) and
`evidence/studio_lab.json`.

## Production decision: fail closed

The plugin currently refuses every write, including when Studio appears closed.
The SQL transaction below remains research code and its other checks are retained.
The observed idle connection is not proof that a Studio process is absent: the
recorded startup experiment also shows a live process before it opens SQLite, and
the timeout experiment shows a live process with no database lock after startup
failure. A process scan cannot close that launch race. Executable names, command
lines, symlinks, and versions are not exhaustive identities; `/proc` access may
be denied or filtered (including hidepid), and PID or mount namespaces can hide
processes or change paths. An incomplete scan must never authorize a write.
Electron's stale/replaced singleton lock is not a reliable exclusion primitive.
A future implementation needs a tested mechanism that prevents Studio launching
or remaining active for the entire transaction, including across relevant users
and namespaces, plus the existing SQLite and compatibility checks. Until then,
permission failures and uncertainty both leave writes disabled. The test suite
checks the unconditional production refusal on disposable paths, including an
inaccessible file; it does not claim to simulate kernel permission boundaries.

The checked-in real-Studio evidence below predates this production refusal. It
tests the SQLite experiment, not a process-absence proof. In particular, the
launch-during-lock result demonstrates why lock acquisition cannot meet the
closed-process requirement.

## The guard

Run on one connection, with a zero busy timeout, as the first statements:

```sql
PRAGMA locking_mode=EXCLUSIVE;
BEGIN EXCLUSIVE;
-- confirm PRAGMA journal_mode is 'wal'
-- outbox check, compare-and-swap and the write go here
COMMIT;
```

`database is locked` means the library is in use, so refuse.

## Proven on Linux with Studio 1.1.3

Studio's own single-instance mechanism:

- `main.js:43-58` calls Electron's `app.requestSingleInstanceLock()`. The comment
  at `main.js:32-35` says the lock is per data folder. A second instance exited
  in about 1.2 s with code 0 while the first kept running.
- `src/db.js` opens one better-sqlite3 connection for the life of the process,
  in WAL mode, with the default 5 s busy timeout.

The guard, with a real Studio in a separate PID, UTS and mount namespace:

| Situation | Result |
| --- | --- |
| Studio running, idle or after UI edits (8 probes over 20 s) | Refused in under 1 ms |
| Kernel lock table while running | Studio holds a POSIX read lock on `db.sqlite` |
| `BEGIN IMMEDIATE`, the current experiment's check | Succeeds while Studio runs, so it is no guard |
| `BEGIN EXCLUSIVE` without the pragma | Succeeds while another connection is open |
| Studio closed cleanly | Acquired, and `SingletonLock` is gone |
| Studio killed with SIGKILL | Acquired, WAL data recovered, integrity ok |
| Studio started during a short hold | Waited, booted, and read the committed text |
| Writer killed mid-transaction | Old content kept, integrity ok |
| Outbox check, compare-and-swap and write through one `sqlite3` CLI run | Commits when clear; rolls back on a change or an outbox row |

`SingletonLock` cannot serve as the guard:

- After SIGKILL it stays behind, naming a PID from Studio's own namespace.
- A planted lock naming a dead PID was replaced, and Studio booted. This held for
  both the same hostname and a different one.

Holding the guard too long does real harm. If it outlasts Studio's 5 s busy
timeout during startup, `init` throws `SQLITE_BUSY` at `db.js:19`. The rest of
startup is skipped, and the process stays alive with no window until killed.
The library is unharmed. Hold times must stay far below 5 s, so no user prompt
or vault I/O may happen while the guard is held.

## Stale outbox rejection

Run inside the exclusive transaction, so no row can appear between check and
write:

```sql
SELECT id, kind, status FROM outbox
WHERE status IN ('pending', 'failed')
  AND (entity_id = :id
       OR instr(coalesce(temp_ids, ''), :id) > 0
       OR instr(coalesce(url, ''), :id) > 0
       OR instr(coalesce(body, ''), :id) > 0);
```

This covers Studio's `hasPending` and `pendingEntityIds`, and also finds an id
that appears only in a URL or body. Any row means refuse. Real Studio rows for a
UI-created file were refused (`file.create` and `file.update`), and the outbox
hash was unchanged.

Local mode conflicts with this check. Studio keeps outbox rows forever until an
account enables sync, so every file created or edited in Studio is refused.

## Not proven

- Windows and macOS were not run. The SQLite documentation describes the same
  locking semantics, but that is not a test.
- Flatpak Obsidian was not run. The bind-mounted jail is the closest test here.
  A document-portal path instead of `filesystems=home` could behave differently.
- Network filesystems are unsupported. SQLite's documentation says WAL does not
  work over them.
- Other Studio versions and other `sqlite3` CLI versions are untested. If a future
  Studio stopped holding its connection open, the guard would wrongly pass.
- Sync was never exercised. A file with no outbox rows passes the check, but
  nothing shows that a later sync would keep a direct write.

## Reproducing

```sh
python3 lab_sqlite.py --studio-dir ~/studio-linux/electron
python3 lab_studio.py --studio-dir ~/studio-linux/electron --xvfb /path/to/Xvfb
```

`lab_studio.py` needs bubblewrap, and it aborts unless the jail has only a
loopback interface. The Xvfb used has sha256 `ffe89f25…`, matching
`../studio_writeback/evidence/report.json`.
