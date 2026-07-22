# Autonomous capture

Read this reference when durable project knowledge should be added or changed.
Capture runs during the active request and saves valid memory automatically.
Never ask the user whether to save it.

Normal flow: prepare one bounded input and run non-dry `capture`. The runtime
validates, internally authorizes, and applies the exact transaction. Its
proposal, artifact, authorization record, journal, and receipt are integrity
evidence, not user approval steps.

## Non-negotiable rules

- Never edit canonical `local/**/*.md` directly as the Syncora capture path.
- Save only durable project truth supported by the current task and inspected
  sources. Do not save casual conversation, guesses, or duplicate summaries.
- Prefer updating the scope's existing hub or stable note over creating a
  competing note.
- `capture` is the ordinary transactional write path. `propose`, `review`, and
  `apply` remain expert inspection and recovery commands.
- Never substitute `propose` for ordinary capture or stop after sealing a
  proposal. Normal capture must reach `state: "applied"` in the active request.
- If the fact itself is ambiguous, ask about the fact. Never ask merely whether
  Syncora should remember an otherwise valid change.
- If the underlying project action itself crosses a decision boundary, resolve
  that action before carrying it out; see
  [decision-boundaries.md](decision-boundaries.md). Once the action or fact is
  authorized, its valid memory capture is automatic and needs no second prompt.
- Treat `changeSummary` as an optional completion report after apply. Use
  declarative past tense; never turn it into "Save it?", "Apply this update?",
  or another pre-save question.
- Keep exact proposal, artifact, authorization, and receipt details internal
  unless the user requests audit evidence.
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

For a finding produced by `check --changed`, use `capture --input` with
`origin: "drift"`. Exact-bind the immutable `drift-finding` artifact and every current
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

## Save and inspect

```text
node "<syncora-skill-root>/scripts/syncora.mjs" capture \
  --workspace "<absolute-workspace>" \
  --input "<absolute-draft-json>" \
  --format json
```

Non-dry `capture` validates, seals, internally authorizes, and applies the
proposal in one operation. Use `--dry-run` only for explicit diagnostics; it
validates without storing a proposal or changing canonical Markdown.

`propose --input` is the expert proposal-only path. Inspect an existing
proposal without returning note bodies:

```text
node "<syncora-skill-root>/scripts/syncora.mjs" propose \
  --workspace "<absolute-workspace>" \
  --proposal "<proposal-id>" \
  --format json
```

Successful capture returns `state: "applied"`, `autonomous: true`, a bounded
`changeSummary`, changed paths, and the new graph revision. It does not return
a user approval question. The exact local artifact preserves prior and
resulting bytes for audit and recovery; ordinary users do not need to inspect
it. Artifact publication fails if its exact surface exceeds 8 MiB.

## Expert manual disposition

The normal capture path does not use this section. For expert inspection,
manual rejection, or recovery, `propose` can leave a proposal unapplied and
`review` can record a disposition:

```text
node "<syncora-skill-root>/scripts/syncora.mjs" review \
  --workspace "<absolute-workspace>" \
  --proposal "<proposal-id>" \
  --proposal-digest "sha256:<64-lowercase-hex>" \
  --decision approve \
  --reviewed-by "operator" \
  --reason "Manual recovery disposition." \
  --format json
```

An automatic capture writes the same exact digest binding internally with
`reviewedBy: "syncora:auto-capture"`. A rejection is terminal. If the proposal,
graph, or artifact changed, create a corrected proposal instead of forcing the
old one. Reviewer text is bounded attribution, not identity authentication.

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

After a successful capture or recovery apply, run the paired post-work
checkpoint when the task has a pre-work checkpoint ID. Mention memory capture
only when useful; do not turn quiet maintenance into a new conversation step.
Git commits remain a separate user or agent workflow.
