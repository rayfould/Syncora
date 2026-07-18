# Governed capture

Read this reference when durable project knowledge should be added or changed.
Capture is foreground-only and has one user review boundary.

Normal flow: `capture` -> open the returned immutable review artifact -> record
an exact digest-bound `review` -> `apply`. The first two commands cannot change
canonical Markdown.

## Non-negotiable rules

- Never edit canonical `local/**/*.md` directly as the Syncora capture path.
- `capture` and `propose` only seal derived proposal state. They do not grant or
  exercise write authority.
- Give the user the returned local review-artifact path and digest. The user
  must inspect that artifact's exact JSON-escaped before/after records before
  approval. The bounded CLI summary is orientation only and cannot substitute
  for the artifact.
- Run `review --decision approve` only after the user explicitly approves that
  exact artifact-bound proposal digest. Do not infer approval from capture
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

Every `file` or `note` source reference likewise requires the exact
`expectedSha256` of the local bytes. Other source-reference types, including
`user` and `operation`, must use `null`. A proposal may contain at most 256
source references per operation, 512 in total, and 64 MiB of verified local
source bytes.

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
non-dry run, the JSON result contains the published `reviewArtifact.path`,
`reviewArtifact.digest`, and exact byte length. A dry run returns the artifact's
would-be metadata but does not create that file, so rerun without `--dry-run`
before review. Open the published local Markdown artifact. Its `B` and `A`
records preserve the exact prior and resulting UTF-8 text as JSON-escaped
lines; its metadata binds the proposal digest, byte counts, and content hashes.
The runtime verifies the artifact and its proposal binding again before
recording approval. Artifact publication fails if the exact review surface
would exceed 8 MiB.

## Review

After the user has inspected the exact local review artifact, ask one explicit
approval question that names both the proposal digest and artifact digest. If
approved, bind the exact proposal digest returned by capture:

```text
node "<syncora-skill-root>/scripts/syncora.mjs" review \
  --workspace "<absolute-workspace>" \
  --proposal "<proposal-id>" \
  --proposal-digest "sha256:<64-lowercase-hex>" \
  --decision approve \
  --reviewed-by "user" \
  --reason "Approved in the current task after inspecting the exact immutable review artifact." \
  --format json
```

If rejected, record `--decision reject`; do not apply. A rejection is terminal.
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
