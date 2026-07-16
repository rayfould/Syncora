# Release status

Latest public version: **0.1.0-preview.1**

Current source status: **development preview with unreleased adoption work**

The public preview establishes the portable and safety-critical foundation. It
is intended for collaborators who are comfortable testing pre-stable software
in version-controlled workspaces.

## Implemented in current source

- dependency-free Node runtime;
- hub-first graph bootstrap;
- workspace and resolved-path containment;
- Codex, Cursor, and Claude project instruction patching;
- ownership-aware unpatch and rollback;
- bounded doctor, validate, search, and backlinks commands;
- foreground checkpoint policy and state;
- zero-authority, dry-run migration inventory;
- reviewed v2 promotion-manifest validation and exact staged target bundles;
- bounded pre-cutover shadow fixtures;
- graph-root-scoped migration state, locking, artifacts, and recovery journal;
- gated cutover, verification, retirement, status, and exact rollback;
- legacy-note preservation: neither cutover nor retirement deletes Markdown,
  and replaced bytes are retained in an inactive, non-authoritative archive;
- cross-platform Node 22 and 24 test suite.

The full legacy-adoption lifecycle above is implemented in current source and
recorded under `[Unreleased]`; it is not part of the existing
`v0.1.0-preview.1` tag. See the
[adoption runbook](legacy-kg-adoption.md).

## Not implemented

- general budgeted task context compilation beyond adoption shadow fixtures;
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
- Review dry-run output before mutation.
- Keep canonical `local/` Markdown under your own backup or version control.
- Keep `local/.syncora/migrations/<migration-id>/` recovery evidence while a
  migration is active or rollback is still required.
- Report containment, rollback, or marker-ownership failures privately.
- Do not treat generated `.syncora/` state as canonical knowledge.
