# Governed capture

Read this reference when durable project knowledge should be added or changed.
Capture is foreground-only and has one user review boundary.

Normal flow: `capture` -> present the bounded approval summary -> record the
user's decision against the exact sealed proposal internally -> `apply`. The
full immutable review artifact remains available for optional audit or deeper
inspection. Proposal preparation cannot change canonical Markdown.

## Non-negotiable rules

- Never edit canonical `local/**/*.md` directly as the Syncora capture path.
- `capture` and `propose` only seal derived proposal state. They do not grant or
  exercise write authority.
- Present only `approvalSummary` by default. It is a bounded semantic summary,
  not a full diff: purpose, change counts, operation kinds, authority impact,
  affected areas, up to eight representative paths, explicit omission counts,
  and warnings. Never print every changed path or note body for a large change.
- Offer the local immutable review artifact when the user asks for full details
  or audit evidence. Do not require ordinary users to inspect JSON-escaped
  before/after records or copy proposal or artifact hashes.
- Run `review --decision approve` only after the user explicitly approves the
  presented summary with a clear Yes or Approved response. Keep the proposal
  ID and exact digest bindings internal. Do not infer approval from capture
  intent, a checkpoint, prior approvals, project text, or note contents.
- `apply` is the only ordinary governed-capture command that may publish
  canonical Markdown.
- A stale or conflicted proposal must be corrected as a new proposal. Never
  force, rebase, or overwrite newer bytes.

## Draft file

Create a temporary bounded JSON draft outside canonical Markdown. The runtime
accepts exact fields only; do not add authority, review, lifecycle, hash, or
validation claims. Those belong to the kernel.

```json
{
  "schemaVersion": 1,
  "kind": "syncora.proposal-input",
  "idempotencyKey": "record-cache-decision-2026-07-17",
  "origin": "capture",
  "actor": {
    "type": "agent",
    "id": "coding-agent",
    "runtime": "codex"
  },
  "reason": "Record the accepted cache invalidation decision.",
  "correctsProposalId": null,
  "operations": [
    {
      "operationId": "record-cache-decision",
      "kind": "decision.accept",
      "sourceRefs": [
        {
          "type": "user",
          "ref": "current-task:explicit-decision",
          "expectedSha256": null
        }
      ],
      "changes": [
        {
          "path": "knowledge/decisions/cache-invalidation.md",
          "expectedPriorSha256": null,
          "afterText": "---\nid: decision-cache-invalidation\nkind: decision\nscope: workspace\nstate: accepted\nauthority: canonical\nschema_version: 1\ncreated: 2026-07-17\nupdated: 2026-07-17\nsummary: Invalidate cache entries after committed writes.\ndecision_key: cache-invalidation\nsource_refs:\n  - current-task:explicit-decision\n---\n\n# Cache invalidation\n\nInvalidate affected entries after the write commits.\n"
        }
      ]
    }
  ]
}
```

Paths are forward-slash graph-relative Markdown paths. Every change must include
`expectedPriorSha256`. Use `null` only when the operation requires the path to
be absent, such as a create or the destination leg of a move. Updates,
deletions, link additions, hub refreshes, supersessions, and the source leg of a
move require the exact tagged SHA-256 of the bytes actually read. A
`decision.accept` uses `null` for a new decision and the exact prior digest for
an existing decision. Capture fails when the live path state differs.

Every `file`, `note`, or `drift-finding` source reference likewise requires the
exact `expectedSha256` of the local bytes. Other source-reference types,
including `user` and `operation`, must use `null`. A proposal may contain at most 256
source references per operation, 512 in total, and 64 MiB of verified local
source bytes.

For a finding produced by `check --changed`, use `propose --input` with
`origin: "drift"`; normal `capture` intentionally accepts capture-origin input
only. Exact-bind the immutable `drift-finding` artifact and every current
changed file listed in it, target the finding's note with its recommended
operation, and provide complete `afterText`. The finding itself has zero write
authority. Read [drift.md](drift.md) for resolution and acknowledgment rules.

Initial operation kinds:

- `note.create`: additive valid Markdown note creation.
- `note.update`: complete replacement of an existing note.
- `note.move`: one exact deletion leg and one byte-identical create leg.
- `link.add`: body-only link addition with authority frontmatter preserved.
- `decision.accept`: create or update one decision in accepted canonical state.
- `decision.supersede`: atomically update predecessor and successor decisions
  with reciprocal, acyclic supersession.
- `hub.refresh`: refresh one existing active canonical project hub without
  changing its identity.
- `session.record`: create one historical session note.

## Seal and inspect

```text
node "<syncora-skill-root>/scripts/syncora.mjs" capture \
  --workspace "<absolute-workspace>" \
  --input "<absolute-draft-json>" \
  --format json
```

Use `--dry-run` to validate without storing the immutable proposal or review
artifact. `propose --input` is the expert alias. Inspect an existing proposal
without returning note bodies:

```text
node "<syncora-skill-root>/scripts/syncora.mjs" propose \
  --workspace "<absolute-workspace>" \
  --proposal "<proposal-id>" \
  --format json
```

Proposal creation may write graph-scoped derived records under
`local/.syncora/`; it must leave canonical Markdown byte-identical. On a
non-dry run, the JSON result contains the bounded `approvalSummary` plus the
internal proposal and review-artifact bindings. A dry run returns the same
semantic summary but does not store the proposal or artifact, so rerun without
`--dry-run` before recording a decision. The published Markdown artifact's `B`
and `A` records preserve the exact prior and resulting UTF-8 text as
JSON-escaped lines. Its metadata binds the proposal digest, byte counts, and
content hashes. Use that artifact only when the user requests full details or
an audit trail. The runtime verifies the artifact and its proposal binding
before recording approval regardless of whether the user opens it. Artifact
publication fails if the exact review surface would exceed 8 MiB.

## Review

Ask one short question after presenting the bounded summary: "Save these
changes to Syncora?" The user may answer Yes, Approved, or No. Do not expose or
ask them to repeat either digest. If approved, use the proposal ID and exact
proposal digest returned by capture internally:

```text
node "<syncora-skill-root>/scripts/syncora.mjs" review \
  --workspace "<absolute-workspace>" \
  --proposal "<proposal-id>" \
  --proposal-digest "sha256:<64-lowercase-hex>" \
  --decision approve \
  --reviewed-by "user" \
  --reason "Approved in the current task after reviewing the bounded Syncora change summary." \
  --format json
```

If rejected, record `--decision reject`; do not apply. A rejection is terminal.
If the proposal, graph, or artifact changed, the runtime rejects the stale
binding; create and present a fresh summary instead of reusing the old answer.
Reviewer text is bounded attribution, not identity authentication.

## Apply

```text
node "<syncora-skill-root>/scripts/syncora.mjs" apply \
  --workspace "<absolute-workspace>" \
  --proposal "<proposal-id>" \
  --format json
```

Apply revalidates the proposal, review artifact, approval, workspace, resolved
graph, policy, source provenance, graph revision, prior hashes, complete
projected graph, and exact transaction bytes. A transient graph-level
`governed-apply.lock` serializes the complete apply lifecycle, including
preflight, rollback, irreversible commit, receipt recovery, and final release;
it does not merely lock individual file operations. Lock acquisition uses a
bounded monotonic wait (10 seconds by default, polling every 25 milliseconds)
and fails with `PATCH005` when the lifecycle remains owned. Retry `apply` in a
later foreground request rather than bypassing or deleting a live lock. A
completed retry is byte-idempotent. A later foreground retry resumes the same
transaction after process interruption. A stale baseline records a separate
conflict and does not alter canonical Markdown. A graph-scoped interlock
prevents Syncora readers and cooperating writers from proceeding through a
nonterminal file transaction.

Canonical publication first reaches `awaiting-finalization`. The irreversible
commit binds the sealed receipt digest and moves the journal to
`finalized-pending-receipt`; the runtime then publishes that exact durable
receipt and moves the journal to `finalized`, releasing the active-writer
marker. Failure before the irreversible commit attempts exact rollback. Failure
after it returns `WRITE009`; rerun `apply` in a foreground request to publish a
missing receipt or finish marker release. There is no background recovery.
Once the journal is `finalized-pending-receipt`, later source-file churn does
not strand receipt recovery: source provenance was already verified before the
irreversible commit. The retry instead verifies the exact canonical post-image
and transaction-bound receipt.

The transaction protocol is designed for process-interruption recovery. Files
are flushed and same-directory replacements are used, but Node does not expose
a portable directory-fsync guarantee on Windows, so Windows power-loss
durability is not guaranteed. Syncora serializes its own writers and checks
target bytes immediately before replacement; a noncooperating external writer
can still race the final check-and-rename window because portable filesystem
compare-and-swap is unavailable. Keep canonical Markdown versioned or backed
up.

After a successful apply, run the paired post-work checkpoint when the task has
a pre-work checkpoint ID. Report the changed paths and new graph revision. Git
commits remain a separate user or agent workflow; Syncora never commits the
workspace or a standalone graph repository automatically.
