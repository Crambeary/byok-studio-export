# Studio-owned local interfaces (issue #5)

**Result: no candidate is demonstrated safe for automated write-back to ordinary
UI-created records under issue #2.** Keep the existing guards. Studio's offline
card import is a promising vendor-owned path for a separate, user-driven workflow,
but it requires Studio to be running and is documented for a BYOK card, not a
vault integration. It is not a closed-Studio write-back interface. No plugin or
library code changed in this investigation.

## Supported workflows and their boundaries

The [Studio import guide](https://byok.io/studio/guides/export-import-backup#import)
describes importing `.txt`, `.md`, `.docx` and `.rtf` as **new** text files.
It does not describe updating an existing record by stable ID. Reimport therefore
does not establish two-way sync of the original record; replacing or deleting
the original would affect references and is not authorized by issue #2.

The [card import guide](https://byok.io/studio/guides/byok-card-import) describes
offline, account-free import from a connected BYOK or its card. Studio previews
changes, snapshots before an update, creates a copy for edits on both sides, and
leaves Studio-only changes alone. It is explicitly one-way. This is useful prior
art, not documented support for presenting a vault as a card or an API for
editing an arbitrary record. Studio must be open to do the import; allowing a
plugin to stage data while closed and asking the user to import later would be a
different, asynchronous workflow whose application and baseline must be verified.

The [desktop guide](https://byok.io/studio/guides/desktop-app) says signing in
can adopt a local library into an account, and signing out returns a previously
synced library to local mode. Thus current local mode is not proof of permanent
isolation or ownership. Its backup restore replaces the library, so it is not a
per-record update interface. The guide's promises about adoption do not verify
the behavior of externally modified database rows.

## Pinned source observations

The installed 1.1.3 asar has SHA-256
`25e93b78fb4753f7b47236a91f8907e674c341aab19af271d93c7dd1e04dbcfa`.
Its `src/deviceCard.js:18-26,705-777,827-843` says the renderer applies card
plans through Studio's normal service layer and records its own card ledger.
On first contact, it falls back to matching project and file names; with no
ledger, a different card text is classified as an update, not a two-sided
conflict. It picks the first same-name file in the project tree. This is a
potentially destructive ambiguity for an arbitrary vault; a version snapshot
does not satisfy the requested conflict and identity guarantees by itself.

`src/deviceText.js:105-118` canonicalizes text by dropping blank lines and
trailing whitespace. The checked-in [probe](probe.py) extracts and executes the
exact pinned canonicalizer on three synthetic strings: a blank-line change and
a trailing-space change both become indistinguishable. It also verifies the
first-contact planner branches exist; it does **not** execute the planner or
simulate a real card. This is enough to rule out treating its hash as a lossless
baseline, not proof that every card import loses those characters. Whether the
renderer or service layer preserves queued edits and later server synchronization
for this workflow has not been demonstrated. The separate
[outbox experiment](../studio_outbox_blocker/README.md) demonstrates why that
question matters for direct writes.

## Next steps and limits

1. Ask the vendor for a documented local, stable-ID update interface and its
   atomicity, versioning, queue coalescing and later-sync contract. A Studio-owned
   operation performed while Studio is running would need an explicit change to
   issue #2's closed-Studio requirement before it could count as write-back.
2. Separately prototype a user-mediated handoff only if that scope is approved:
   stage a disposable card-like fixture, establish identity without name-only
   guesses, and have Studio preview/apply it. Do not silently emulate a physical
   device or modify Studio's ledger. Confirm that this use is supported first.
3. In a network-isolated disposable library, test ordinary UI-created records,
   queued create and update operations, rich and whitespace-sensitive content,
   ambiguous names, concurrent edits, crashes, version history and actual Studio
   application. Inspect only synthetic queue metadata/bodies. Verify durable
   acknowledgement before advancing the vault baseline; an exported proposal or
   click is not proof of application. Later server behavior remains unverified
   without an authorized safe test or a vendor contract.
4. Until those conditions are met, retain the existing import-only behavior and
   refusal/reporting for unsafe write-back. A permanently isolated copy would
   require an enforceable isolation boundary, not merely a warning or local-mode
   flag; no such boundary was established here.

Reproduce the source probe with `python3 experiments/studio_local_interfaces/probe.py
--asar /path/to/app.asar`. It reads only the pinned program source and uses an
in-memory Node process; it opens no Studio library and makes no network requests.
The guide links describe current documentation, which may change independently
of the pinned binary. No real Studio or sync run was performed for this note.
