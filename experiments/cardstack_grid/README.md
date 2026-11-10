# Synthetic cardstack and grid observations

This is research for issue #8, not an import or write-back contract. [evidence.json](evidence.json) captures synthetic records created in one Studio 1.1.3 UI session. The driver creates a cardstack, adds two empty cards and a second section, moves that section up, then creates a grid, adds a tile and edits its text. The capture contains separate mirror snapshots and a final read-only SQLite snapshot. Assertions check the persisted final content, section order, distinct card IDs, and tile identity across that edit. UUIDs, timestamps, card IDs and the grid tile ID are replaced consistently; card IDs were numbers before sanitization and are strings in this evidence. Relationships are preserved, but original values and elapsed times are not.

The cardstack stored an array of sections, with cards in each section. The two sections exchanged array order on the observed move; the populated section and both card IDs remained intact. The grid's legacy `tiles` array stayed empty while `v2.tiles` held the new tile with coordinates and dimensions. Its ID remained the same after the text edit. These observations do not establish a general ordering rule, identity stability across other operations, or how to interpret every field. The card content in this capture is empty; the grid exercise covers only one tile, no connections, groups or labels.

The experiment uses the existing bubblewrap launcher: a fresh disposable local library and home, read-only Studio and driver, isolated network namespace with loopback only, no credentials or BYOK networking. It checks SQLite integrity and foreign keys after Studio exits. Binary hashes and environment checks are in the evidence. The workspace is removed after the run.

The evidence is insufficient to safely project populated cardstacks or general grids. They and unknown record kinds remain unsupported and must be reported and protected; no structured write-back or round-trip guarantee follows. Next, capture card titles and formatted bodies, card moves between sections, and grid multiple tiles, placement, connections, groups, labels and reorder/edit behavior, including persisted and reopened views. Use those observations to define conservative accepted shapes and sync-boundary tests before implementing projections. Never infer Studio or later BYOK sync compatibility from this capture.

## Reproduce

On Linux with bubblewrap, Python 3, the pinned Studio port and Xvfb:

```sh
python3 experiments/cardstack_grid/lab.py --studio-dir /path/to/studio/electron --xvfb /path/to/Xvfb
```

The executable, archive and Xvfb hashes appear in the evidence; this run used Studio 1.1.3 and Electron 44.4.5. The script replaces only the specified evidence output. It exits nonzero if the UI, persistence, isolation or identity assertions fail. Fresh synthetic IDs and timestamp numbering may differ between runs.
