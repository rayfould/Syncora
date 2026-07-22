# Changelog

All notable changes to Syncora are documented here.

## [Unreleased]

#### Changed

- Removed contradictory context guidance that could stop routine capture at a
  sealed proposal and ask the user whether to save. Ordinary capture now must
  reach `state: "applied"`; any summary is post-save reporting only.
- Routine knowledge capture and drift repair now validate, authorize internally,
  and apply transactionally without asking the user whether to save. Exact
  artifacts, receipts, recovery, and rollback evidence remain available.
- Existing-graph adoption now treats the original adoption request as authority
  for the complete lifecycle; its dry-run summary and digest binding are
  internal checks rather than another user confirmation.
- Upgraded the generated project instruction hook to v6 so Codex, Cursor, and
  Claude save relevant durable project memory autonomously.
- Default text reports only bounded change summaries: purpose, counts,
  authority impact, affected areas, representative paths, omissions, and
  warnings. Full immutable artifacts and exact bindings remain internal audit
  and recovery evidence.

## [0.1.0-preview.2] - 2026-07-18

#### Added

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
- General canonical-Markdown-read-only `context` compilation with typed task
  targets, deterministic scope resolution, five task modes, configurable hard
  character budgets, mandatory/working/evidence lanes, and a
  provenance-bearing source map. Default discovery may update a disposable
  derived lexical cache; `--no-cache` prevents that cache write.
- Governed `capture`, `propose`, `review`, and `apply` commands with immutable
  content-derived proposals, bounded inspection, an exact local review artifact
  containing complete before/after text, and one explicit approval or rejection
  bound to the exact proposal digest after artifact inspection.
- Complete projected-graph validation, provenance rechecks, authority-impact
  assessment, optimistic graph and target concurrency, and immutable conflict
  records for stale proposals.
- Graph-scoped content-addressed transaction journals, application receipts,
  foreground process-interruption resume, exact rollback before irreversible
  commit, and recovery-required outcomes that preserve bytes Syncora cannot
  prove it owns.
- Foreground `check --changed` with exact raw-byte source fingerprints,
  bounded advisory Git change and rename hints, and equal Git/non-Git detection
  authority.
- Automatic drift coverage for eligible current-schema canonical/supporting
  `file`, `module`, and `path_glob` bindings, with explicit degraded coverage
  for untyped, malformed, `symbol`, and `component` bindings.
- Graph-local, workspace-identity-sharded drift observations, immutable
  zero-authority findings, refresh work items, proposal bindings, and exact
  finding-digest still-current dispositions.
- Drift-origin proposal governance that exact-binds the active finding and
  rechecks the canonical note plus complete live file/module/glob fingerprints
  at proposal and apply time.
- Cumulative one-head-per-note finding supersession, normalized shared
  observation catalogs, indexed binding matching, visible missing/excluded
  coverage, and an explicit reasoned policy-rebaseline workflow with immutable
  dispositions.

#### Changed

- Reworked the public skill entrypoint around a plain-language product
  explanation, new-workspace and existing-graph quick starts, concise metadata,
  and a clear boundary between visitor guidance and internal agent rules.
- Upgraded the generated project instruction hook to v4 so installed agents
  retain relevance-gated routing, use exact review plus transactional apply for
  durable knowledge changes, and run foreground drift checks only after
  substantive source mutation or an explicit maintenance request.
- Greenfield `setup`/`init` now refuses pre-existing knowledge and unsupported
  predecessor workflows, while atomically replacing the exact supported
  predecessor marker when no graph exists.
- Possible custom predecessor activation without a graph requires instruction
  review, explicit removal, and `setup --confirm-predecessor-reviewed`.
- Agent-workflow cutover is gated by reviewed authority and passing shadow
  evidence instead of appending a competing hook.
- Lifecycle phases remain available for expert diagnostics and recovery but
  are no longer separate normal-workflow approval steps.

#### Safety

- Task-context target matching uses a strict non-regex glob grammar, portable
  case-preserving identities, eligible-note-only scope routing, and bounded
  pair and character work.
- Validation caps graph-wide link references and resolved edges; context uses
  bounded adjacency traversal instead of rescanning the full graph edge set.
- Context reports and all CLI error envelopes have independent hard output
  ceilings; conflict overflow and metadata pressure fail visibly.
- Mode-filtered known hub sections remain explicit source-map omissions, while
  unfamiliar adopted-hub sections remain eligible working context.
- Checkpoint and agent-patch lock waiters use optimistic live-owner polling and
  guarded double-checks, so recovery remains serialized without starving an
  owner that needs the same guard to release its lock.
- Proposal creation never changes canonical Markdown. Canonical publication is
  restricted to an exact digest-approved `apply`, which revalidates policy,
  identities, source provenance, prior hashes, authority impact, and the full
  post-image before writing.
- Canonical file transactions publish through same-directory atomic replacement
  and keep a graph-scoped active-writer marker through
  `awaiting-finalization`, irreversible receipt binding at
  `finalized-pending-receipt`, durable receipt publication, and final release;
  stale or unsafe pre-commit recovery fails closed instead of overwriting
  external work.
- A transient graph-level `governed-apply.lock` serializes the complete apply
  lifecycle across preflight, rollback, commit, receipt recovery, and release;
  its acquisition wait is bounded and callers retry in a later foreground
  request after timeout.
- The durability contract explicitly covers later foreground recovery after
  process interruption. It does not claim a portable Windows power-loss
  guarantee or filesystem compare-and-swap against noncooperating external
  writers in the final byte-check-to-rename window.
- Context, search, backlinks, checkpoints, and migration phases honor the same
  graph-scoped writer interlock, so they cannot consume a half-published graph.
- A first complete drift observation reports `baseline-established` instead of
  claiming historical freshness. Exact fingerprints remain authoritative when
  Git is absent, incomplete, or unavailable; Git never grants freshness.
- Drift findings contain identifiers, hashes, paths, counts, and next actions,
  not note bodies or diff hunks. A finding grants zero authority and never
  silently rewrites canonical Markdown.
- `capture` rejects drift-origin input. Repairs require complete agent-authored
  resulting text, an immutable exact `drift-finding` provenance reference, and
  the ordinary `propose` -> exact artifact review -> `review` -> `apply`
  lifecycle.
- Drift state is stored beneath the resolved graph and sharded by workspace
  identity, isolating worktrees that share an external graph. Unsafe, corrupt,
  future-version, oversized, or identity-mismatched state fails closed rather
  than resetting the baseline.

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

[Unreleased]: https://github.com/rayfould/Syncora/compare/v0.1.0-preview.2...HEAD
[0.1.0-preview.2]: https://github.com/rayfould/Syncora/releases/tag/v0.1.0-preview.2
[0.1.0-preview.1]: https://github.com/rayfould/Syncora/releases/tag/v0.1.0-preview.1
