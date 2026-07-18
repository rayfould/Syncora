# Release status

Current package version: **0.1.0-preview.2** (release candidate)

Latest public tag: **0.1.0-preview.1**

Current source status: **development preview.2 candidate with adoption, context, and governed capture**

The public preview establishes the portable and safety-critical foundation. It
is intended for collaborators who are comfortable testing pre-stable software
in version-controlled workspaces.

## Implemented in current source

- dependency-free Node runtime;
- one-command, idempotent `setup` for greenfield workspaces or workspaces with
  only the exact predecessor marker, with hub-first graph bootstrap;
- workspace and resolved-path containment;
- Codex, Cursor, and Claude project instruction patching;
- relevance-gated agent hook v3 with governed capture routing;
- ownership-aware unpatch and rollback;
- bounded doctor, validate, search, and backlinks commands;
- foreground checkpoint policy and state;
- canonical-Markdown-read-only task-context compilation with explicit intent,
  deterministic scope resolution, task modes, hard character budgets,
  mandatory/working/evidence lanes, and a provenance-bearing source map;
  the default path may update a disposable derived lexical cache, while
  `--no-cache` prevents that cache write;
- immutable governed proposal creation, bounded inspection, and an exact local
  review artifact containing the complete before/after text;
- explicit approval or rejection bound to the exact proposal digest after
  artifact inspection;
- projected-graph and authority-impact validation, source provenance checks,
  and optimistic graph and target concurrency;
- graph-scoped transactional apply with content-addressed before/after bytes,
  immutable conflicts and receipts, foreground process-interruption resume,
  exact pre-commit rollback, and irreversible receipt-bound finalization;
- one transient graph-level apply lock across preflight, rollback, commit,
  receipt recovery, and release, with bounded timeout and foreground retry;
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

The legacy-adoption lifecycle, task-context compiler, and governed capture path
above are included in the `v0.1.0-preview.2` release candidate. They are not
part of the existing public `v0.1.0-preview.1` tag until preview.2 is published.
See the
[adoption runbook](legacy-kg-adoption.md) and
[governed capture contract](skill/governed-capture-contract.md).

## Not implemented

- automatic changed-file and symbol drift detection;
- clean-room activation proof across current agent releases;
- ten-thousand-note performance acceptance;
- stable compatibility and support guarantees.

These remaining capabilities are part of Syncora's accepted architecture, not
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
- Open and inspect the immutable local review artifact before approving
  governed capture. The digest, impact, paths, and compact summary are not a
  substitute for its exact before/after text. Proposal creation alone never
  grants write authority.
- Keep `local/.syncora/migrations/<migration-id>/` recovery evidence while a
  migration is active or rollback is still required.
- Report containment, rollback, or marker-ownership failures privately.
- Do not treat generated `.syncora/` state as canonical knowledge.
- Treat governed apply as process-interruption recoverable, not as an
  unconditional power-loss guarantee. Windows directory-entry durability is
  not portable through Node, and a noncooperating external writer may race the
  final byte check and atomic rename.
