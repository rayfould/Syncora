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

### Changed

- Greenfield `init` now refuses pre-existing knowledge or predecessor agent
  workflows and routes them to reversible adoption.
- Agent-workflow cutover is gated by reviewed authority and passing shadow
  evidence instead of appending a competing hook.

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
