# Disposable offline card import experiment

This investigates an alternative manual handoff, not issue #5 fulfillment or a
reason to relax any guard. Studio 1.1.3 runs in local mode in a fresh bubblewrap
network namespace with only loopback, an empty home and a synthetic library. A
read-only synthetic card directory is discovered by Studio's normal polling;
no physical BYOK, account, credential, server, plugin, or plugin outbox writer is
involved. This does not establish vendor support for a synthetic card.

## Observations

The [recorded run](evidence.json) and `verify.py` show:

* A UI-created project and text file already had unrelated contents. The setup
  also created a second same-name file and an unrelated file through Studio's
  mirror bridge, not the UI. With no prior card ledger and no card library IDs,
  Studio matched the project and the first tree file by name and previewed an
  **update**, not a conflict. Clicking Studio's import button updated that same
  UI-created ID. This one ordering does not prove which duplicate is selected in
  other trees or versions.
* Card bytes `card alpha  \n\ncard beta\t\n` became stored HTML
  `<p>card alpha  </p><p>card beta\t</p>` in default paragraph mode: the blank
  line and final newline disappeared; the two trailing spaces and tab were still
  present in the stored HTML immediately after import. Editor rendering, later
  editing, and export fidelity were not tested. After changing only whitespace
  on the card to `card alpha\ncard beta\n`, Studio reported unchanged and no
  actionable update. Exact text is therefore not a reliable comparison baseline.
* SQL comparisons of all file rows show the duplicate and unrelated rows were
  byte-for-byte unchanged, as was the project row; only the selected file row
  changed. Integrity checks returned `ok` with zero foreign-key violations at all
  three checkpoints. Other tables changed as shown in the evidence.
* The local versions table remained exactly as before import. Its one manual
  snapshot was taken **before** the last UI edit, so this run did not observe a
  snapshot of the complete immediate pre-import content. The overwritten text
  included that later edit. This observation alone does not explain why Studio
  did not add a snapshot or establish behavior in other circumstances.
* Studio itself changed an existing outbox row during import (three rows before
  and after). Studio also wrote its card ledger and telemetry. The harness reads
  synthetic queue rows for equality but does not directly write them. No plugin
  ran; no conclusion about later server replay or synchronization follows.

The card was mounted read-only. The harness writes its fixture only while Studio
is stopped. The extra seed files are synthetic bridge-created records, not proof
of normal UI behavior; duplicate names and a legacy path-derived card identity
are deliberate adversarial fixtures. Only one card identity and one import were
applied. Renames, real card IDs, conflicts after independent edits, crashes,
other linebreak mode, later sync and other builds/platforms remain untested.
The 1.1.3 binary is pinned by asar SHA-256; Xvfb and system dependencies are not.

## Reproduce

On Linux with bubblewrap, Python 3, the pinned Studio Linux port, and Xvfb:

```sh
python3 experiments/studio_card_import/lab.py --studio-dir /path/to/studio/electron --xvfb /path/to/Xvfb
python3 experiments/studio_card_import/verify.py
```

The first command overwrites `evidence.json`, takes a few minutes, and removes its
fresh temporary library unless `--keep-work` is supplied. It exits on a failed
Studio phase or unexpected network interfaces; run the second command to assert
the observed behavior. IDs and timestamps vary. A synthetic passwd file supports
Studio's Linux card discovery without mounting the host home or credentials.
