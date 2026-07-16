# Changelog

All notable changes to Syncora are documented here.

## [Unreleased]

### Added

- Full foreground legacy-adoption command family: authority inventory, reviewed
  manifest staging, bounded shadow comparison, cutover, verification,
  retirement, status, and rollback.
- Actionable authority-promotion manifest v2 with exact source, target,
  provenance, and staged-content bindings.
- Graph-local migration state, locks, content-addressed artifacts, exact
  recovery journals, and phase receipts.
- Legacy knowledge graph adoption runbook and skill reference.
- One-command greenfield `setup` plus an installed two-command `bundle` then
  resumable `adopt` path for an existing graph.
- Adoption bundle v1 schema binding the migration ID, reviewed manifest,
  fixtures, and every staged target byte.
- Atomic, no-clobber bundle construction with full semantic, fixture, target,
  containment, and hash validation; no handwritten descriptor glue is needed.

### Changed

- Reworked the public skill entrypoint around a plain-language product
  explanation, new-workspace and existing-graph quick starts, concise metadata,
  and a clear boundary between visitor guidance and internal agent rules.
- Greenfield `setup`/`init` now refuses pre-existing knowledge and unsupported
  predecessor workflows, while atomically replacing the exact supported
  predecessor marker when no graph exists.
- Possible custom predecessor activation without a graph requires instruction
  review, explicit removal, and `setup --confirm-predecessor-reviewed`.
- Agent-workflow cutover is gated by reviewed authority and passing shadow
  evidence instead of appending a competing hook.
- Lifecycle phases remain available for expert diagnostics and recovery but
  are no longer separate normal-workflow approval steps.

### Safety

- Cutover and retirement preserve legacy notes; overwritten Markdown is copied
  to an inactive migration archive, and retirement records predecessor
  deactivation without deleting history or rollback evidence.
- Migration directories are created segment-by-segment with stable identity
  bindings, while high-volume target reads remain bounded without per-note
  helper-process startup.
- Markerless cutover remains fail-closed unless the user explicitly attests
  with `--confirm-predecessor-reviewed` after inspecting active agent
  instructions and removing custom predecessor activation.
- Cutover, verification, retirement, and rollback fail closed on stale hashes,
  graph/workspace identity changes, invalid states, or corrupt recovery data.
- Composite adoption holds one graph-then-workspace lock across the lifecycle,
  resumes from durable state, and automatically attempts exact rollback after
  a caught cutover or verification failure without overwriting concurrent user
  edits.

## [0.1.0-preview.1] - 2026-07-16

First public development preview of the portable Syncora Agent Skill.

### Included

- Hub-first workspace initialization.
- Reversible project instruction patching for Codex, Cursor, and Claude.
- Deterministic doctor, validate, search, backlinks, and checkpoint commands.
- Bounded zero-authority legacy Markdown inventory.
- Cross-platform Node 22 and 24 test matrix.

### Not yet included

- Budgeted task context compilation.
- Governed canonical capture and proposal application.
- Promotion-manifest application.
- Changed-file drift detection.
- Stable-release compatibility guarantees.

[0.1.0-preview.1]: https://github.com/rayfould/Syncora/releases/tag/v0.1.0-preview.1
