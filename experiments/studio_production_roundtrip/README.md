# Production local-only sync probe

This probe exercises `src/import.js` and the real guarded writer, using a small filesystem vault adapter and persisted sync state. It does not launch Obsidian or exercise its editor adapter. The prior [roundtrip experiment](../studio_local_roundtrip/README.md) supplies the real Studio UI driver and isolated jail.

Studio creates the project, text, and populated outbox in a fresh temporary library. Once Studio has exited, the harness copies its database and SQLite sidecars to a separately marked disposable path (the production guard refuses paths containing `studio-desktop`). It imports, edits the vault, invokes opt-in sync, repeats, copies the closed database back, reopens the real editor, edits in Studio, and invokes sync and repeat again. Every plugin phase compares all columns of all outbox rows; Studio itself may modify its queue when edited. Baselines are reloaded from disk on each sync. The vault adapter is a test double and assumes no open editor or concurrent writer. Snapshots compare SQLite values, not physical bytes.

Studio runs with a private network namespace containing only loopback, an empty home, and only the synthetic work directory mounted. No live library, credentials, or BYOK server is used. The probe deletes its temporary directory even on failure. Queued data can still overwrite changes if Studio Sync is later used; this probe does not establish server replay safety.

Reproduce on Linux with bubblewrap, Python 3, Node, installed npm dependencies, SQLite 3.53.4, the pinned Studio 1.1.3 port and pinned Xvfb (the script checks both SHA-256 hashes):

```sh
npm ci --offline
python3 experiments/studio_production_roundtrip/lab.py --studio-dir /path/to/studio/electron --xvfb /path/to/Xvfb
```

The script overwrites `evidence.json`; IDs and timestamps vary. Results cover one text record and short sessions, not concurrency, crashes, account transitions, other content, or other builds.
