# Syncora Skill Implementation Plan

Status: Active toward stable release
Plan version: 3
Started: 2026-07-15

## 1. Objective

Deliver Syncora as a portable, open-source Agent Skill while preserving useful
context-control contracts without coupling them to predecessor infrastructure.

The skill is built in a dedicated public repository as a sequence of
production-complete subsystems with independently testable contracts. Milestones
are capability boundaries, not disposable prototypes; completed runtime
contracts must remain compatible as later capabilities are added.

## 2. Delivery rules

- Keep the skill self-contained under `skills/syncora/`.
- Use no runtime packages in the portable kernel.
- Do not import hosted application, database, or editor-extension code.
- Port behavior and contracts, not infrastructure coupling.
- Keep all skill tests in temporary workspaces.
- Never run initialization against a live workspace as a test.
- Require absolute workspace paths for mutations.
- Update architecture and release-status documents with every accepted
  milestone.
- Do not retire a predecessor source until reconciliation proves its unique
  state is preserved.

## 3. Workstreams

### Workstream A: Distribution and documentation

Deliverables:

- public repository README aligned with the skill direction;
- architecture, security, contribution, and migration documentation;
- permissive open-source license;
- one discoverable `syncora` skill;
- CI matrix covering supported operating systems and Node versions.

Exit gate:

- a fresh clone can validate and test the skill without hosted application
  dependencies or database.

### Workstream B: Bootstrap and agent activation

Deliverables:

- `doctor`;
- `init --workspace ABS`;
- `--dry-run`, text output, and JSON output;
- hub-first Markdown skeleton;
- default patching for Codex, Cursor, and Claude;
- `--no-patch-agents`;
- reversible `patch-agents` and `unpatch-agents`;
- relevance-gated `none`, `checkpoint`, `context`, `capture`, and `maintenance`
  profiles;
- foreground pre/post checkpoint orchestration with event triggers and bounded
  cadence backstops;
- safe marker-v1 to marker-v2 activation-policy migration;
- external graph-root allowlisting.

Exit gate:

- initialization is idempotent and rollback-safe across representative Windows,
  macOS, and Linux fixtures;
- self-contained requests stay inert while project work receives only the
  minimum applicable profile.

### Workstream C: Parser, graph index, and authority

Deliverables:

- constrained frontmatter parser;
- wiki-link parser and backlinks;
- content hashing and graph revision;
- one-active-hub enforcement;
- decision-key uniqueness;
- explicit supersession graph and cycle detection;
- historical and supporting authority ceilings;
- rebuildable lexical index.

Exit gate:

- structural and authority validators pass the compatibility corpus and reject
  every declared invariant violation with a stable code.

### Workstream D: Context compiler

Deliverables:

- `context` command;
- intent, scope, targets, mode, and budget inputs;
- mandatory, working, evidence, and source-map lanes;
- exact target binding resolution;
- bounded lexical and graph retrieval;
- deduplication and supersession filtering;
- expansion handles;
- explicit budget overflow.

Exit gate:

- current large-graph fixtures produce bounded, source-grounded packs without
  omitting mandatory constraints.

### Workstream E: Proposals and transactional writes

Deliverables:

- typed operation envelope;
- unique proposal files;
- `capture`, `propose`, and `apply`;
- expected graph revision and note hashes;
- authority-impact classification;
- conflict proposals;
- recovery journal and rollback;
- provenance and idempotency.

Exit gate:

- concurrent and interrupted-write tests demonstrate no silent canonical data
  loss.

### Workstream F: Drift and maintenance

Deliverables:

- `check --changed`;
- Git and non-Git fingerprint sources;
- path, glob, dependency, and optional symbol bindings;
- stale findings and refresh proposals;
- `validate`, `conflicts`, `repair`, and `upgrade`;
- disposable cache rebuild.

Exit gate:

- a representative code change creates a source-grounded stale finding without
  directly rewriting canonical knowledge.

### Workstream G: Legacy migration

Deliverables:

- inventory and classification report;
- byte-preserving graph baseline and restore test;
- malformed encoding, NUL, size, and link-count quarantine findings;
- read-only external-source export and Markdown reconciliation;
- proposed scope hubs;
- giant-note and duplicate-decision findings;
- reviewed v2 authority manifest and exact staged target bundles;
- reversible `migrate --phase authority|stage|shadow|cutover|verify|retire|rollback|status`;
- bounded comparison fixtures against a virtual staged graph;
- journaled accepted migration application and exact rollback;
- predecessor-system archive decision.

Exit gate:

- a migrated graph has one accepted hub per scope, explicit decision
  authority, and bounded default context while retaining history;
- no unique accepted state remains only in a predecessor system;
- the broad predecessor AGENTS workflow has been explicitly replaced rather
  than merely supplemented.

### Workstream H: Cross-agent evaluation and release

Deliverables:

- clean-room Codex, Cursor, and Claude activation tests;
- malicious-note and path-containment fixtures;
- performance corpus with at least ten thousand notes;
- installation and upgrade test;
- release checklist and signed version tag.

Exit gate:

- a friend can install the repository, initialize a project, obtain scoped
  context, capture a durable decision, and uninstall the agent hook without
  manual repair.

## 4. Ordered milestones

### Milestone 0: Direction and boundaries

Status: Complete

- [x] Critically assess the current repo and graph.
- [x] Select one public skill and a deterministic local kernel.
- [x] Select Markdown as the permanent canonical store.
- [x] Select explicit initialization with default agent patching.
- [x] Establish the public repository as an independent distribution boundary.
- [x] Record external graph-root and predecessor-instruction cutover hazards.
- [x] Record the portable skill architecture and replace the hosted launch plan.
- [ ] Capture a byte-preserving graph baseline and external-source
      reconciliation status for each real migration.

### Milestone 1: Portable bootstrap runtime

Status: Included in `0.1.0-preview.1`

- [x] Create the skill package and progressive-disclosure references.
- [x] Implement workspace resolution and containment.
- [x] Implement `doctor`.
- [x] Implement idempotent `init` and hub skeleton.
- [x] Implement patch, unpatch, dry-run, and rollback.
- [x] Bound agent and snapshot reads, bind ancestor identities through atomic
      publication, and make rollback ownership-aware under concurrent edits.
- [x] Make patch and recovery-guard wait deadlines monotonic under wall-clock
      reversal.
- [x] Add structure, patcher, and initialization tests.
- [x] Run the official skill validator.

The patcher is implemented and fixture-tested in this milestone, but it must not
replace a predecessor knowledge workflow through ordinary additive patching.
The migration runtime now owns that explicit, gated cutover.

### Milestone 2: Authority-aware graph kernel

Status: In progress

- [x] Implement raw-byte Markdown scanning, strict constrained frontmatter, and
      bounded wiki-link parsing.
- [x] Implement deterministic read-only `validate` reports and graph revisions.
- [x] Classify missing-schema legacy notes as unpromoted without authority
      inference.
- [x] Quarantine invalid UTF-8, NULs, oversized notes, excessive fanout,
      malformed frontmatter, future schemas, and unsafe paths without mutation.
- [x] Validate schema-v1 identity, authority ceilings, hub uniqueness, accepted
      decision uniqueness, and basic supersession integrity.
- [x] Add a bounded, revision-bound authority inventory and define the separate
      reviewed promotion-manifest schema without rewriting source notes.
- [x] Implement actionable v2 manifest acceptance, snapshot bindings, and exact
      staged target validation while retaining v1 as non-actionable review.
- [x] Implement incremental cache rebuild.
- [x] Add exact/alias link resolution, backlinks, and ambiguous-target findings.
- [x] Validate scoped reciprocal supersession and reject invalid authority
      graphs before staging.
- [x] Add the ten-thousand-note lexical performance corpus.

### Milestone 2.5: Relevance-gated foreground orchestration

Status: Included in `0.1.0-preview.1`

- [x] Define `none`, `checkpoint`, `context`, `capture`, and `maintenance`
      routing labels with positive dependency and durability tests.
- [x] Keep date/time, arithmetic, translation, casual, supplied-content, and
      other workspace-independent requests completely inert.
- [x] Keep global installs inert for ordinary work in uninitialized projects;
      allow only explicit initialization, adoption, or diagnostics pre-init.
- [x] Separate pre-work mode from the fail-closed post-work change disposition.
- [x] Replace the broad v1 agent hook with a concise relevance-gated v2 hook.
- [x] Preserve reversible baselines across untouched, diverged, untracked, and
      changing-target v1-to-v2 migrations.
- [x] Implement `checkpoint --phase pre|post` with paired checkpoint IDs,
      idempotent post behavior, and compact results.
- [x] Persist bounded, strictly validated, concurrency-safe derived checkpoint
      state without an append-only turn log.
- [x] Bound config, state, and lock-owner reads; serialize stale recovery with
      fail-closed guards; and bind runtime writes to stable directory identities.
- [x] Bind full validation to exact source and findings digests, and gate cheap
      reuse with graph identity, a path/stat change fingerprint, cadence, and
      parser/schema/runtime policy digests.
- [x] Add event-driven validation gates with 50-activation and 168-hour safety
      backstops.
- [x] Add corrupt-state, concurrent-agent, clock-change, completed-degraded,
      changed-topology, and cross-agent routing fixtures.

The semantic acceptance matrix is maintained in
[`activation-evaluation.md`](activation-evaluation.md). Static and delegated
evaluations do not replace the installed Codex, Cursor, and Claude release gate.

This milestone establishes foreground orchestration before context compilation.
It does not make `context` or governed `capture` executable; those remain
Milestones 3 and 4.

### Milestone 3: Budgeted context compiler

Status: Pending

- [ ] Implement target binding and scope resolution.
- [ ] Implement retrieval tiers and bounded traversal.
- [ ] Implement context lanes and source map.
- [ ] Implement lean, standard, and deep budgets.
- [ ] Prove mandatory overflow behavior.

The migration shadow phase includes a bounded adoption-only compiler for exact
required, evidence, and forbidden identities. It is not the general task
context command and does not complete this milestone.

### Milestone 4: Governed write path

Status: Pending

- [ ] Port operation-envelope semantics.
- [ ] Implement proposal lifecycle and optimistic concurrency.
- [ ] Implement authority review gates.
- [ ] Implement transaction recovery and conflict fixtures.

Legacy cutover now has a dedicated exact-byte recovery transaction. General
capture proposals and ordinary canonical writes remain pending.

### Milestone 5: Drift, migration, and stable release

Status: In progress

- [ ] Implement changed-file drift checks.
- [x] Implement reviewed manifest staging, bounded shadow gates, graph-scoped
      migration state, journaled cutover, verification, retirement, status,
      and rollback.
- [x] Preserve all legacy source notes through cutover and retirement, and
      retain exact rollback evidence after retirement.
- [x] Implement exact predecessor-marker replacement with a fail-closed,
      explicitly reviewed attestation path for markerless legacy workspaces.
- [ ] Reconcile external-source projections before deprecating predecessor
      systems.
- [ ] Migrate a representative existing graph through preview and acceptance.
- [ ] Replace the predecessor AGENTS workflow through an explicit reversible
      migration.
- [ ] Forward-test the installed skill across supported agents.
- [ ] Publish a stable release only after the compatibility and threat-model
      gates pass. Development previews follow the narrower, explicitly labeled
      preview checklist.

## 5. Production package surface

The portable runtime is organized under the following stable package surface:

```text
skills/syncora/
|-- SKILL.md
|-- agents/openai.yaml
|-- scripts/syncora.mjs
|-- scripts/lib/
|-- references/
`-- assets/

tests/syncora/
```

The current executable commands are:

```text
doctor
init
validate
backlinks
search
checkpoint
migrate --phase authority|stage|shadow|cutover|verify|retire|rollback|status
patch-agents
unpatch-agents
```

The current development preview does not claim to provide context compilation,
governed capture, or drift. Its adoption-specific shadow compiler and
transaction do not imply a general task context or canonical capture surface.
The skill must report this capability boundary instead of presenting
unimplemented commands as usable.

## 6. Predecessor component disposition

| Legacy component | Disposition |
|---|---|
| Markdown parsing, checksums, wiki links | Port semantics into standalone ESM |
| KG operation envelope | Port contract and validation semantics |
| Proposal lifecycle and provenance | Port after the read path |
| Decision bindings | Port path/glob first; symbols later |
| Drift signals and refresh proposals | Port after transactions |
| Existing context-pack selector | Replace with budgeted compiler |
| Hosted controllers and service modules | Excluded from the skill |
| Hosted SQL and repository adapters | Migration input only |
| Accounts, billing, governance service | Excluded |
| Hosted SLM and model gateway | Excluded |
| VS Code extension and MCP wrapper | Optional future adapters, not core |
| Marketing site | Independent surface |

## 7. Validation matrix

Every milestone must define tests across:

- Windows, macOS, and Linux paths;
- LF, CRLF, BOM, final-newline, and Unicode files;
- missing, empty, existing, and malformed instruction files;
- case-insensitive collisions and reserved Windows names;
- symlink and junction containment;
- Git and non-Git workspaces;
- tracked, ignored, and standalone `local/` repositories;
- dry-run and JSON output;
- interrupted and concurrent writes;
- older runtime with newer schema;
- hostile note content.

## 8. Risk register

### Agent does not invoke the skill

Mitigation: one explicit skill description, a tiny persistent project hook, and
cross-agent activation evaluations.

### Instructions consume too much startup context

Mitigation: keep the hook small and load operational references only after the
skill triggers.

### Existing graphs live outside the workspace

Mitigation: reject by default and require an exact machine-local allowlist.
Shared locks and recovery journals live beside the resolved graph, not merely
inside the calling workspace.

### Predecessor and skill architectures both appear current

Mitigation: mark predecessor documentation as superseded, create one new
skill-runtime hub, and keep transition status explicit.

### Predecessor authority is falsely promoted

Mitigation: inventory grants zero authority; only an exact reviewed v2 manifest
and staged target bundle may assign scope, authority, and decision identity,
and cutover remains locked behind a passing shadow report.

### External-source state is lost

Mitigation: preserve the source and require a read-only export and
reconciliation before retirement.

### Malformed notes pass structural validation

Mitigation: add strict UTF-8, embedded-NUL, size, fanout, and semantic authority
checks; quarantine without deletion.

### Patcher damages user instruction files

Mitigation: marker ownership, preflight of all targets, exact hashes,
same-directory temporary writes, rollback, and hostile fixtures.

### Context budgets erase essential truth

Mitigation: mandatory lane is verbatim and budget overflow is a hard status.

### History overwhelms current work

Mitigation: sessions are historical by schema and excluded outside handoff or
history modes.

### Direct external edits bypass transactions

Mitigation: hashes, drift checks, and conflict proposals; hard prevention is
outside a local-skill boundary.

## 9. Rollback boundaries

- Skill bootstrap files can be removed without changing predecessor systems.
- Agent hooks can be unpatched independently.
- Ordinary derived workspace `.syncora/` state can be deleted and rebuilt only
  outside an active operation; graph-local migration journals must remain while
  adoption or rollback is active.
- Graph migration preserves original notes through acceptance and retirement.
- Authority migration stages content-addressed reviewed bytes before a
  write-free shadow comparison.
- Agent-instruction cutover is a journaled migration transaction, not ordinary
  additive patching.
- Retirement records predecessor deactivation only after verification and
  retained-source proof; exact rollback remains available afterward.

## 10. Definition of done

The stable release is complete when the skill can:

1. initialize a workspace safely;
2. identify one authoritative hub;
3. compile bounded task context;
4. preserve mandatory truth and provenance;
5. stage and safely apply durable knowledge changes;
6. detect stale bindings;
7. survive cross-platform and hostile-input tests;
8. operate from Codex, Cursor, and Claude;
9. uninstall its instruction hooks without damaging the workspace;
10. migrate an existing graph without losing history.
