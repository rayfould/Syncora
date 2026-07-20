# Release status

Current package version: **0.1.0-preview.2**

Latest public tag: **0.1.0-preview.2**

Current source status: **development source with adoption, context, autonomous transactional capture, and foreground changed-source drift detection**

The public preview establishes the portable and safety-critical foundation. It
is intended for collaborators who are comfortable testing pre-stable software
in version-controlled workspaces.

The public interface is conversational: setup, ordinary work, update, repair,
and removal are user intents. The detailed runtime commands below those intents
are internal agent machinery or advanced recovery tools, not steps users are
expected to memorize.

## Implemented in current source

- dependency-free Node runtime;
- one-command, idempotent `setup` for greenfield workspaces or workspaces with
  only the exact predecessor marker, with hub-first graph bootstrap;
- workspace and resolved-path containment;
- Codex, Cursor, and Claude project instruction patching;
- relevance-gated agent hook v6 with autonomous transactional capture,
  internal change summaries, and foreground drift routing;
- ownership-aware unpatch and rollback;
- bounded doctor, validate, search, and backlinks commands;
- foreground checkpoint policy and state;
- canonical-Markdown-read-only task-context compilation with explicit intent,
  deterministic scope resolution, task modes, hard character budgets,
  mandatory/working/evidence lanes, and a provenance-bearing source map;
  the default path may update a disposable derived lexical cache, while
  `--no-cache` prevents that cache write;
- immutable proposal creation, bounded inspection, and an exact local
  review artifact containing the complete before/after text;
- automatic internal authorization bound to the exact proposal and artifact
  digests for routine capture, with explicit review commands retained for
  expert inspection and recovery;
- projected-graph and authority-impact validation, source provenance checks,
  and optimistic graph and target concurrency;
- graph-scoped transactional apply with content-addressed before/after bytes,
  immutable conflicts and receipts, foreground process-interruption resume,
  exact pre-commit rollback, and irreversible receipt-bound finalization;
- one transient graph-level apply lock across preflight, rollback, commit,
  receipt recovery, and release, with bounded timeout and foreground retry;
- foreground `check --changed` over authoritative `file`, `module`, and
  `path_glob` bindings, using exact raw-byte fingerprints in Git and non-Git
  workspaces and treating Git change/rename data as advisory only;
- a visible first-observation baseline that never claims historical freshness,
  immutable zero-authority findings and refresh work items, exact-digest
  still-current acknowledgments, cumulative one-head finding supersession, and
  explicit immutable policy-rebaseline dispositions;
- graph-local drift state sharded by exact workspace identity so worktrees
  sharing an external graph do not share observations or baselines;
- zero-authority, dry-run migration inventory;
- reviewed v2 promotion-manifest validation and exact staged target bundles;
- one reviewed-pack `adopt` operation that internally previews a bounded summary,
  seals the exact content under the original adoption request, and runs the resumable
  lifecycle; standalone bundle adoption remains compatible;
- bounded pre-cutover shadow fixtures;
- graph-root-scoped migration state, locking, artifacts, and recovery journal;
- gated cutover, verification, retirement, status, and exact rollback;
- one outer graph/workspace lock across composite adoption plus automatic exact
  rollback after caught cutover or verification failures;
- legacy-note preservation: neither cutover nor retirement deletes Markdown,
  and replaced bytes are retained in an inactive, non-authoritative archive;
- cross-platform Node 22 and 24 test suite.

The legacy-adoption lifecycle, task-context compiler, transactional capture path,
and foreground changed-source detector above are included in the published
`v0.1.0-preview.2` release.
See the
[adoption runbook](legacy-kg-adoption.md) and
[capture contract](skill/governed-capture-contract.md). The bundled
[drift reference](../skills/syncora/references/drift.md) defines the operational
finding and repair flow.

## Remaining capability and acceptance gaps

- automatic `symbol` and `component` drift coverage; current source reports
  those bindings as unevaluated because no real versioned symbol index exists;
- clean-room activation proof across current agent releases;
- full ten-thousand-note release performance acceptance;
- representative live existing-graph adoption and reversible instruction
  cutover evidence;
- reconciliation of unique external or hosted predecessor state before any
  predecessor database or system is retired;
- stable compatibility and support guarantees.

Foreground drift detection does not mean background monitoring: no watcher,
daemon, timer, or after-response worker exists. Findings prove only potential
staleness and grant zero authority. Repairs still require complete resulting
Markdown, but routine repairs use autonomous `capture` with internal exact
authorization and transactional apply. Proposal and apply recheck the active
finding, canonical note hash, and complete live binding fingerprints.

The remaining items are accepted gates or explicit gaps, not hidden preview
behavior. In particular, implementing the portable detector does not prove that
this repository's own legacy graph has been adopted or that hosted database
retirement is safe. The stable release is blocked until the full
[architecture acceptance gate](skill/architecture.md#20-release-acceptance)
passes.

## Preview safety expectations

- Test in a Git repository or another recoverable workspace.
- An explicit setup or adoption request authorizes that complete operation.
  Internal validation, sealing, and rollback checkpoints do not create more
  user prompts.
- Keep canonical `local/` Markdown under your own backup or version control.
- Immutable local review artifacts remain available for optional audit and
  recovery. Routine capture authorizes and publishes through the trusted local
  runtime automatically; proposal creation alone still never grants authority.
- Keep `local/.syncora/migrations/<migration-id>/` recovery evidence while a
  migration is active or rollback is still required.
- Report containment, rollback, or marker-ownership failures privately.
- Do not treat generated `.syncora/` state as canonical knowledge.
- Retain active drift findings, proposal bindings, dispositions, and the
  workspace baseline when unresolved review work must survive. Noncanonical
  does not mean safe to delete during an active lifecycle.
- Treat governed apply as process-interruption recoverable, not as an
  unconditional power-loss guarantee. Windows directory-entry durability is
  not portable through Node, and a noncooperating external writer may race the
  final byte check and atomic rename.
