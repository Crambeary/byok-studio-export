# Disposable local-only round-trip probe

This is research for issue #5, not a product feature or evidence that its acceptance criteria are met. It tests a small simulated vault exchange using the repository's narrow text codec and the issue #4 experimental SQLite writer, not the plugin's guarded sync command or Obsidian. The user has stated their Studio Sync trial will not continue; that does not make later re-enabling Sync safe. No production guards are changed.

## Method and results

`lab.py` creates a fresh library through the real Studio UI in local mode, then copies it and operates only on the copy. It exports one paragraph to a disposable Markdown file, changes its text, writes the converted HTML with Studio closed, reopens Studio, checks the editor and version history, checks a repeat exchange without changes, makes another edit through the real Studio editor, exports it to the vault file, and checks another repeat. This is a scripted exchange, not the production conflict resolver. The snapshot comparisons in [evidence.json](evidence.json) include all columns of the synthetic file, project, versions and outbox, as well as the vault content. Outbox equality compares all SQLite column values, including full body text, not physical SQLite page bytes.

The recorded run used the pinned Studio 1.1.3 Linux port and Electron 44.4.5. The UI-created project's JSON contains `user: null`; its text file omits `user`. The original queue had three entries. Direct write and reopening preserved every outbox column value; the writer added a history pre-image, left indexed file columns and the project row unchanged, and Studio displayed the new text. A subsequent UI edit preserved the vault edit and changed a queued row itself; the subsequent vault export did not change it. Both scripted repeat checks were no-ops. Studio inserted the later text at its restored caret position, visible in the evidence, rather than necessarily at the end. SQLite integrity and foreign-key checks passed at every recorded checkpoint.

The only network interface inside each Studio phase was isolated loopback; the jail has an empty home and no live library or credentials. The synthetic library had no authToken key and was not in synced mode. No BYOK server was contacted. Studio is launched in a separate namespace with only its binary, system dependencies, this driver and the disposable work directory mounted. The harness deletes both the seed and copy afterwards. See the issue #4 harness for jail construction and writer limitations.

## Candidate local-only design

An explicitly opted-in local-only mode could use a separate, clearly identified offline library and vault, with warnings that future Studio Sync may overwrite changes. Persist a baseline scoped to library identity, vault identity and record ID, retaining both exact Studio HTML and vault bytes. On each run compare both sides to that baseline: propagate only a single-sided reversible edit; report concurrent edits, deletion, unsupported/lossy content and uncertain identity without overwriting. Require proof Studio is closed, supported pinned schema/build and a stable source snapshot immediately before a transactional write. Retain the previous content as a version, recheck the vault before replacing it, and advance the baseline only after both sides are verified; interrupted partial writes need explicit recovery. Never mutate outbox rows. Protect open or dirty vault editors. Provide backup and recovery instructions and an explicit way to stop using the mode before any account or Sync transition. These are design requirements, not guarantees provided by this experiment.

**Unresolved overwrite risk:** queued create/update bodies may still describe earlier content. PR #29's pinned-source probe shows that a successful replay returning an older object can overwrite the direct write. Reopening and a later edit do not establish what a real server returns, and neither an offline setting nor a warning prevents a later account transition or pull. Do not claim future Sync is safe. PR #30 found lossy, name-based first-contact card matching; PR #31 observed Studio's import modifying its own queue and losing blank/final newlines. Neither is a safe substitute established by this experiment.

Only one short text record, one local edit in each direction, one Linux build, and short sessions were tested. No real server replay, account transition, crash, concurrent writer, long autosave interval, other record types, real libraries, or other Studio versions were tested. The scripted exchange does not prove production race handling, baseline persistence, conflict handling, editor safety, physical page identity, or recovery.

## Reproduce

Linux, bubblewrap, Python 3, Node, the pinned Studio port and Xvfb are required. The command overwrites only this experiment's evidence file and deletes its generated temporary libraries:

```sh
python3 experiments/studio_local_roundtrip/lab.py --studio-dir /path/to/studio/electron --xvfb /path/to/Xvfb
```

IDs and timestamps vary. The script exits nonzero when an assertion fails. It does not read or modify an existing library.
