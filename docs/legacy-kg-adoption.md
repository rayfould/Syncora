# Legacy knowledge graph adoption

Use this runbook for a project that already has a Markdown knowledge graph. If
no graph exists and the exact supported predecessor marker is the only legacy
state, use one ordinary `setup` command instead. If no graph exists but a
custom or unmarked predecessor activation does, inspect every active Codex,
Cursor, and Claude instruction file, remove that activation, then run one
`setup --confirm-predecessor-reviewed` command. The skill sets that compatibility
flag after its own inspection without asking the user again. Reviewed adoption inputs require
real graph sources and are not an empty-workflow workaround.
Greenfield `setup`/`init` intentionally refuses existing graphs and unsupported
predecessor workflows with `MIGRATE015`: it cannot know which existing note is
authoritative or which custom instructions are safe to remove.

Adoption is a foreground, reviewed state machine internally:

```text
authority -> stage -> shadow -> cutover -> verify -> retire
                              \-> rollback <-/
```

Nothing runs between agent messages. The normal user surface is one adoption
operation: prepare the reviewed semantic files, internally preview `adopt`, then
let the final `adopt` invocation bind the exact digest and apply the same inputs
under the original request. The individual phases and standalone `bundle`
command remain available for expert inspection, compatibility, and recovery.
Every workspace mutation is journaled and bound to one migration ID. No
phase deletes legacy notes. Retirement means the predecessor activation and
default authority have been retired, not that historical Markdown was erased.

## Before you start

- Work from a recoverable workspace and inspect the graph's own repository
  status when `local/` is a separate repository.
- Choose a stable migration ID containing lowercase letters, digits, and
  interior hyphens, for example `syncora-adoption-2026`.
- Resolve the workspace to an absolute path. If `local/` resolves outside it,
  pass `--allow-external-graph-root <exact-absolute-path>` on every command.
- Prefer an exact begin/end marker around the predecessor agent workflow.
  Cutover refuses unmarked or customized broad instructions rather than
  guessing what to remove. A reviewed attestation path exists for workspaces
  where no exact marker remains; it is described at the cutover gate below.
- Do not run `setup` or `init` against an existing graph; successful cutover
  creates the required Syncora runtime files and hook.

In the commands below, replace `<runtime>` with:

```text
node <installed-syncora-skill>/scripts/syncora.mjs
```

## Prepare: inventory authority candidates

```text
<runtime> migrate --phase authority --dry-run --workspace /absolute/project
```

The result is a metadata-only, zero-authority inventory. It classifies every
Markdown source as `current-schema`, `review-required`, or `blocked` without
including note bodies or choosing winners. Follow `page.nextCursor` until the
inventory ends; restart from page one if the graph or policy changes.

Remediate every blocked source before staging. Preserve unreadable, malformed,
or oversized bytes as evidence; do not silently recode or discard them.

## Review and adopt once

Create a human-reviewed `syncora.authority-promotion` manifest with
`manifestSchemaVersion: 2` and `status: reviewed`. It must bind the inventory
snapshot and give every review-required source exactly one disposition:

- `promote-via-targets`: the source supports one or more explicit canonical or
  typed targets;
- `evidence-only`: preserve it as evidence without granting authority;
- `defer`: leave the authority question unresolved and out of promotion
  operations.

Each operation has exact source path/hash pairs and exactly one target. The
target declares its prior hash, schema fields, relations, source references,
and `contentSha256`. Put its exact reviewed Markdown at the matching relative
path below a separate staged-content directory. Merge by assigning several
sources to one target; split by assigning one source to several one-target
operations. Never infer a missing scope, decision key, authority, or target
body from legacy wording or recency.

Schema v1 manifests remain review records but are not actionable.

Place the three reviewed inputs together beneath one review directory:

```text
review/
  authority-promotion-manifest-v2.json
  staged-content/
  shadow-fixtures-v1.json
```

Preview the complete adoption. This validates every reviewed input and returns
the exact bundle digest without writing the descriptor or changing the
workspace:

```text
<runtime> adopt --workspace /absolute/project --migration-id syncora-adoption-2026 --manifest /absolute/review/authority-promotion-manifest-v2.json --staged-content /absolute/review/staged-content --fixtures /absolute/review/shadow-fixtures-v1.json --output /absolute/review/adoption-bundle-v1.json --dry-run
```

After reviewing the returned digest and summary, authorize the same operation
once by binding the final invocation to that digest:

```text
<runtime> adopt --workspace /absolute/project --migration-id syncora-adoption-2026 --manifest /absolute/review/authority-promotion-manifest-v2.json --staged-content /absolute/review/staged-content --fixtures /absolute/review/shadow-fixtures-v1.json --output /absolute/review/adoption-bundle-v1.json --expected-bundle-digest sha256:<reviewed-digest>
```

The final `adopt` invocation revalidates the current graph and reviewed bytes,
refuses any digest mismatch before publishing the descriptor, then runs stage,
shadow, cutover, verify, and retire synchronously. All inputs must be below the
descriptor's parent directory. A failed gate stops the command; rerun the exact
command after correcting the reported issue to resume from durable state. One
authorization covers this declared composite operation. An explicit rollback
command remains available for operator-driven recovery.
After a successful non-dry-run adoption, the same user-level command makes one
foreground changed-source observation for the adopted bindings. Its
`baseline-established` result, when eligible sources exist, is only the
starting point for later comparison; it does not certify that legacy knowledge
was historically fresh. With no eligible automatic binding it reports
`no-tracked-sources`. If observation publication fails after retirement
succeeds, `adopt` reports
`completed-degraded` and retains the completed migration while requiring
explicit drift-baseline attention.
If a caught cutover or verification failure leaves a recoverable publication
state, `adopt` first attempts the same exact rollback automatically. A
concurrent user edit is never overwritten; the command instead reports
`MIGRATE017` and retains recovery evidence for explicit repair.

The phase commands below are the advanced inspection and recovery surface, not
the default user workflow.

The standalone `bundle` command and `adopt --bundle <absolute-path>` remain
supported for existing automation and expert recovery. They expose the same
sealed descriptor boundary but are not the normal conversational workflow.

## Advanced phase diagnostics (optional)

### Stage

Preview, then stage:

```text
<runtime> migrate --phase stage --migration-id syncora-adoption-2026 --manifest /absolute/manifest.json --staged-content /absolute/staged --workspace /absolute/project --dry-run
<runtime> migrate --phase stage --migration-id syncora-adoption-2026 --manifest /absolute/manifest.json --staged-content /absolute/staged --workspace /absolute/project
```

Stage independently revalidates the complete source set, current target bytes,
manifest semantics, exact frontmatter/body hashes, provenance, portable
identities, reciprocal relations, and the virtual authority graph. It copies
content-addressed reviewed artifacts to
`local/.syncora/migrations/syncora-adoption-2026/`; canonical notes and agent
files remain unchanged.

### Shadow

Prepare 1 through 100 strict shadow cases. Each case identifies the scope and
query, sets a character budget from 1,000 through 64,000, and lists exact
required, evidence, and forbidden note IDs:

```json
{
  "schemaVersion": 1,
  "kind": "syncora-shadow-fixtures-v1",
  "cases": [
    {
      "caseId": "project-orientation",
      "scope": "workspace",
      "query": "What is current and authoritative?",
      "budgetCharacters": 8000,
      "requiredIds": ["workspace-atlas", "project-hub"],
      "evidenceIds": ["legacy-source"],
      "forbiddenIds": ["superseded-decision"]
    }
  ]
}
```

Run the comparison against the virtual post-migration graph:

```text
<runtime> migrate --phase shadow --migration-id syncora-adoption-2026 --fixtures /absolute/shadow-fixtures.json --workspace /absolute/project --dry-run
<runtime> migrate --phase shadow --migration-id syncora-adoption-2026 --fixtures /absolute/shadow-fixtures.json --workspace /absolute/project
```

Cutover remains locked unless the recorded report has zero failed cases. Fix
the manifest, staged targets, or fixtures deliberately; rerun `stage` and
`shadow` rather than weakening mandatory truth to fit a budget.

### Cutover

For advanced phase-by-phase diagnosis, review the dry run before publication:

```text
<runtime> migrate --phase cutover --migration-id syncora-adoption-2026 --workspace /absolute/project --dry-run
<runtime> migrate --phase cutover --migration-id syncora-adoption-2026 --workspace /absolute/project
```

Immediately before publication, Syncora rechecks the manifest, baseline,
staged bytes, target prior hashes, and passing shadow report. The journaled
transaction then:

- writes only declared target paths;
- copies any legacy Markdown bytes that a declared target will replace to
  `local/archive/migrations/<migration-id>/<original-path>` before publication;
- creates or enables project-local Syncora runtime configuration;
- replaces the exact predecessor workflow marker with relevance-gated hook v6,
  including autonomous transactional capture, internal change summaries, and
  foreground drift routing;
- preserves unrelated agent bytes, encoding, and newline style;
- records exact before/after bytes, hashes, and modes for recovery;
- validates the resulting graph and activation before reporting success.

Legacy source notes that are not replaced remain in place. Exact copies of
replaced Markdown remain in the reserved archive above; Syncora excludes that
archive from active authority and context so preserved history cannot compete
with the new atlas. An interrupted transaction resumes from the recovery
journal; concurrent changes fail closed instead of being overwritten.

If no exact predecessor marker exists, the default cutover fails closed. First
inspect every active `AGENTS.md`, `AGENTS.override.md`, `CLAUDE.md`, nested
`.claude/CLAUDE.md`, and applicable Cursor instruction surface. Explicitly
remove or neutralize any custom predecessor activation. Then preview and apply
the same cutover commands with `--confirm-predecessor-reviewed`. This flag records
the skill's completed inspection; it is not a discovery or deletion mechanism and must not be used merely to
bypass a marker error.

### Verify and retire

```text
<runtime> migrate --phase verify --migration-id syncora-adoption-2026 --workspace /absolute/project
<runtime> migrate --phase retire --migration-id syncora-adoption-2026 --workspace /absolute/project --dry-run
<runtime> migrate --phase retire --migration-id syncora-adoption-2026 --workspace /absolute/project
```

`verify` proves the active graph revision, exact target bodies, runtime, and
agent hook still match the cutover receipt. `retire` reruns those checks and
proves every disposition's source bytes remain live, or exist byte-for-byte in
both the inactive Markdown archive and recovery evidence. The retirement
receipt records that the predecessor path is inactive while keeping the source
notes, archived history, and rollback journal.

## Inspect or roll back

Status is read-only and available after staging:

```text
<runtime> migrate --phase status --migration-id syncora-adoption-2026 --workspace /absolute/project
```

Rollback is available after an interrupted or applied cutover, and from
verified or retired state:

```text
<runtime> migrate --phase rollback --migration-id syncora-adoption-2026 --workspace /absolute/project --dry-run
<runtime> migrate --phase rollback --migration-id syncora-adoption-2026 --workspace /absolute/project
```

It restores exact pre-cutover graph, runtime, and agent bytes and removes target
or archive files created by cutover. It does not erase migration evidence. Do
not manually delete `local/.syncora/migrations/<migration-id>/` while adoption
is active or within the intended rollback horizon.

## When a phase fails

- Stale source, graph, target, or artifact hashes: restart inventory/review or
  restage; do not edit stored migration artifacts.
- Invalid transition: inspect `status` and continue from the recorded state.
- Shadow failure: correct the reviewed design or make the budget intentionally
  larger; do not bypass the gate.
- Missing predecessor marker: inspect all active agent instruction surfaces,
  remove any custom predecessor activation, then explicitly attest the review
  with `--confirm-predecessor-reviewed`; Syncora will not guess or remove it.
- Verification failure: stop normal adoption work and inspect concurrent edits
  before deciding between a corrected verification and rollback.

For greenfield projects, use the shorter [getting-started guide](getting-started.md).
