# Release status

Latest public version: **0.1.0-preview.1**

Current source status: **development preview with unreleased adoption and context work**

The public preview establishes the portable and safety-critical foundation. It
is intended for collaborators who are comfortable testing pre-stable software
in version-controlled workspaces.

## Implemented in current source

- dependency-free Node runtime;
- one-command, idempotent `setup` for greenfield workspaces or workspaces with
  only the exact predecessor marker, with hub-first graph bootstrap;
- workspace and resolved-path containment;
- Codex, Cursor, and Claude project instruction patching;
- ownership-aware unpatch and rollback;
- bounded doctor, validate, search, and backlinks commands;
- foreground checkpoint policy and state;
- canonical-Markdown-read-only task-context compilation with explicit intent,
  deterministic scope resolution, task modes, hard character budgets,
  mandatory/working/evidence lanes, and a provenance-bearing source map;
  the default path may update a disposable derived lexical cache, while
  `--no-cache` prevents that cache write;
- zero-authority, dry-run migration inventory;
- reviewed v2 promotion-manifest validation and exact staged target bundles;
- installed, atomic content-addressed `bundle` construction and one resumable
  `adopt` command over the reviewed lifecycle;
- bounded pre-cutover shadow fixtures;
- graph-root-scoped migration state, locking, artifacts, and recovery journal;
- gated cutover, verification, retirement, status, and exact rollback;
- one outer graph/workspace lock across composite adoption plus automatic exact
  rollback after caught cutover or verification failures;
- legacy-note preservation: neither cutover nor retirement deletes Markdown,
  and replaced bytes are retained in an inactive, non-authoritative archive;
- cross-platform Node 22 and 24 test suite.

The full legacy-adoption lifecycle above is implemented in current source and
recorded under `[Unreleased]`; it is not part of the existing
`v0.1.0-preview.1` tag. The task-context compiler is likewise current-source,
unreleased work. See the
[adoption runbook](legacy-kg-adoption.md).

## Not implemented

- governed capture and proposal lifecycle;
- changed-file and symbol drift detection;
- clean-room activation proof across current agent releases;
- ten-thousand-note performance acceptance;
- stable compatibility and support guarantees.

These missing capabilities are part of Syncora's accepted architecture, not
hidden preview behavior. The stable release is blocked until the full
[architecture acceptance gate](skill/architecture.md#20-release-acceptance)
passes.

## Preview safety expectations

- Test in a Git repository or another recoverable workspace.
- An explicit setup request authorizes ordinary greenfield or exact
  predecessor-marker-only setup. Legacy graph adoption requires one
  consolidated review and authorization for the exact content-addressed
  bundle.
- Keep canonical `local/` Markdown under your own backup or version control.
- Keep `local/.syncora/migrations/<migration-id>/` recovery evidence while a
  migration is active or rollback is still required.
- Report containment, rollback, or marker-ownership failures privately.
- Do not treat generated `.syncora/` state as canonical knowledge.
