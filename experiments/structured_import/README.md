# Synthetic structured-record observation

This is a limited research capture for issue #7, not a supported import or write-back contract. [evidence.json](evidence.json) contains sanitized SQLite JSON records and Studio mirror responses from one real UI session. UUIDs and timestamps are replaced consistently within the capture; equality relationships remain, but their original values and elapsed times do not. Text, structure, field names and positions are otherwise retained. All text and records were generated for this experiment.

The pinned Linux Studio 1.1.3 port and Electron 44.4.5 were used; exact executable, archive and Xvfb hashes are in the evidence. The script uses the existing [bubblewrap launcher](../studio_writeback/run_experiment.py): an empty home and disposable config, read-only app and driver, isolated network namespace with loopback only, and no live library or credentials. It creates a project, outline, manuscript and two text files through Studio UI. It checks the SQLite database read-only until each asserted change is actually saved, captures the rows, then closes Studio. The workspace is removed after the run. The mirror captures are separate from disk captures. Integrity and foreign keys are checked after exit. No server or BYOK connection is used.

In this run:

- The new outline was `content: []`. A header and subheader were nested in `children`, with `type` values `I` and `II`. The two item IDs remained equal across the captured header text edit, while the child and its content remained present. This says nothing about other edits or all outline types.
- The empty manuscript had `manuscripts: []`. Creating a section generated a separate entry ID, position, and embedded file. After a body edit the persisted file row contained the text while the embedded copy in the manuscript still had empty content; the corresponding mirror tree contained the updated content. Adding another section subsequently captured an updated embedded copy. Consumers must not assume the embedded copy is always current based on this observation.
- Two distinct files with the same name were added. Moving the second section up changed their order and positions from 0/1 to 1/0 for the original IDs. The stored before/after records show the exact values. This is not a test of adding the same file twice, equal or missing positions, or other reorder paths.

Malformed JSON, unknown fields and node types, missing references, deeper or sibling outline nodes, formatting, deletion, reopen behavior and duplicate references to the same file were not exercised. No conclusion about their interpretation or preservation follows from this capture. The existing importer reports outline and manuscript types unsupported; this experiment does not change it. This does not establish safe write-back, sync compatibility, or behavior on other builds.

## Reproduce

Linux, bubblewrap, Python 3, the pinned Studio port and Xvfb are required. The script runs for about a minute and replaces only its output evidence file. Pass installed paths; they need not match the original machine:

```sh
python3 experiments/structured_import/lab.py --studio-dir /path/to/studio/electron --xvfb /path/to/Xvfb
```

A failed save wait or check exits nonzero. Each capture is a fresh synthetic run, so normalized ID and time numbering may differ. The UI driver deliberately fails if the expected controls or persisted records do not appear.
