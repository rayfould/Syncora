# Governed capture contract

Status: Implemented in the unpublished `0.1.0-preview.2` release candidate.

Syncora agents may interpret project work and prepare a proposed knowledge
change. Only the deterministic local runtime may validate and publish that
change to canonical Markdown.

## User flow

The normal flow has one review boundary:

1. The agent prepares a bounded JSON draft and runs `syncora capture`.
2. Syncora returns an immutable proposal ID and digest plus a local immutable
   review-artifact path, artifact digest, impact summary, and exact changed
   paths. Canonical Markdown is still byte-identical.
3. The agent gives the artifact path and digest to the user. The user opens the
   artifact and reviews its exact JSON-escaped before/after records. The compact
   CLI summary is orientation only.
4. After explicit approval of that exact artifact-bound proposal, the agent
   records a digest-bound approval and runs `syncora apply`.

The commands are internal skill machinery. A user should normally be asked to
approve one proposal, not to operate a multi-stage transaction manually.

```text
syncora capture --workspace ABS --input ABS_JSON [--dry-run]
syncora propose --workspace ABS --input ABS_JSON [--dry-run]
syncora propose --workspace ABS --proposal ID
syncora review --workspace ABS --proposal ID --proposal-digest SHA256 \
  --decision approve|reject --reviewed-by TEXT --reason TEXT [--dry-run]
syncora apply --workspace ABS --proposal ID [--dry-run]
```

`capture` is the approachable proposal-creation command. `propose` exposes the
same sealing path plus expert inspection. Neither command may write canonical
Markdown. `review` creates a separate immutable disposition. `apply` is the
only ordinary capture command allowed to publish canonical note bytes.

## Trust boundary

- Proposal input, Markdown, links, evidence, and model output are untrusted
  data.
- A checkpoint, capture intent, note field, or sentence inside a proposal
  cannot authorize a write.
- The runtime recomputes authority impact from the complete before/after graph.
- Automatic canonical apply is disabled. Approval requires the exact immutable
  local review artifact and must bind its proposal digest.
- Reviewer identity is attribution, not authentication. A local skill cannot
  prove which human typed an approval.

## Proposal package

An immutable proposal binds:

- a content-derived proposal ID and full proposal digest;
- actor, reason, provenance, and optional correction lineage;
- the resolved workspace and graph identities;
- validation and policy revisions;
- the exact expected graph revision;
- ordered semantic operations;
- a mandatory prior-state binding for every changed path: `null` only for
  required absence, otherwise the exact prior hash;
- exact resulting hashes for every changed path;
- kernel-computed authority impact and review requirement;
- projected-graph validation and bounded duplicate candidates.

The initial semantic operation kinds are:

- `note.create`
- `note.update`
- `note.move`
- `link.add`
- `decision.accept`
- `decision.supersede`
- `hub.refresh`
- `session.record`

Proposal files never change. Reviews, conflicts, transaction journals,
application receipts, and correction links are separate unique records. A
correction is a new proposal; Syncora never silently edits or rebases an old
one.

Ordinary proposals are bounded to 64 semantic operations, 256 file changes,
256 provenance references per operation, 512 provenance references per
proposal, 64 MiB of verified local source bytes, the canonical 256 KiB note
limit, and 16 MiB of sealed content. Every local `file` or `note` provenance
reference carries an exact source hash. Successful command output contains
summaries and hashes, never complete note bodies; the separately bounded local
review artifact carries the exact before/after text and is capped at 8 MiB.

## Graph-scoped governance state

Governance artifacts live beside the resolved graph so worktrees sharing one
external graph also share proposals, locks, conflicts, and recovery state:

```text
<resolved-graph>/.syncora/
  proposals/
    proposal_<digest>.json
  reviews/
    proposal_<digest>/review_<digest>.json
  operations/
    proposal_<digest>/{conflict,receipt}_<digest>.json
  review-artifacts/
    artifacts/artifact_<digest>.md
    bindings/proposal_<digest>/*.json
  locks/governed-apply.lock
  transactions/files/
    active.json
    <transaction-id>/{journal.json,blobs/}
  blobs/
```

This state is noncanonical and excluded from Markdown scanning. Workspace
`.syncora/` remains the home of host-local configuration, checkpoints, and
rebuildable caches.

## Apply invariant

One transient graph-level `governed-apply.lock` serializes the complete apply
lifecycle, including preflight, rollback, irreversible commit, receipt
recovery, and final marker release. Lock acquisition has a bounded monotonic
wait: the default is 10 seconds with 25-millisecond polling. A still-owned
lifecycle fails with `PATCH005`; callers retry `apply` in a later foreground
request and must not bypass or delete a live lock.

While holding that lifecycle lock, apply must:

1. verify immutable proposal, review-artifact, and review bytes;
2. re-resolve workspace and graph identities;
3. require exact source hashes, graph revision, and prior target hashes;
4. rebuild and validate the complete post-image in memory;
5. prepare content-addressed before/after blobs and a durable journal;
6. recheck every target immediately before deterministic publication;
7. publish with same-directory atomic replacement;
8. validate the final graph and reach `awaiting-finalization`;
9. irreversibly commit the sealed receipt digest, moving the journal to
   `finalized-pending-receipt` while retaining the active-writer marker;
10. publish the exact immutable receipt;
11. move the journal to `finalized` and release the active-writer marker.

Before step 9, a failed apply attempts to restore exact prior bytes. At or after
step 9, rollback is forbidden: `WRITE009` tells the caller to rerun `apply`,
which publishes a missing receipt or completes final marker release
idempotently. Recovery is foreground-only; interruption never schedules a
worker. After the journal reaches `finalized-pending-receipt`, later provenance
source churn cannot invalidate the already-committed canonical change; recovery
verifies the exact post-image and receipt binding instead.

A graph-scoped writer interlock keeps Syncora context, search, backlinks,
checkpoints, migrations, and cooperating writers from observing or competing
with a nonterminal file transaction. Ordinary Syncora work remains blocked
until the governed apply resumes, safely rolls back, or publishes and releases
its committed receipt.

A stale baseline creates a separate conflict record and never overwrites newer
work. If rollback can no longer prove ownership of bytes Syncora published, it
preserves the external edit and reports recovery required.

The protocol provides process-interruption recovery, not an unconditional
power-loss guarantee. File contents are flushed and directory entries are
synced where Node exposes a usable primitive, but Windows has no portable
directory-fsync contract in Node; sudden Windows power loss remains outside the
guarantee. Syncora's graph lock also cannot serialize a noncooperating external
writer. Exact pre-rename checks reduce that risk, but portable filesystems do
not provide the compare-and-swap needed to close the final check-and-rename
race. Canonical Markdown should remain versioned or backed up.

## Authority impact

The runtime derives the strongest applicable class:

- `none`: additive historical or transient capture;
- `supporting`: additive evidence that cannot override current truth;
- `canonical-content`: canonical prose or status without authority-topology
  changes;
- `authority-changing`: hub activation, decision acceptance or supersession,
  canonical identity or scope changes, and canonical moves or removals.

Operation names do not lower impact. For example, a generic `note.update` that
changes `authority`, `kind`, `scope`, `decision_key`, accepted state, or
supersession topology is authority-changing.

## Foreground-only lifecycle

No daemon, watcher, or background worker participates. Proposal creation,
review, apply, validation, recovery, and receipts all run within an explicit
agent request and stop before the final response.
