# Foreground changed-source drift

## What the check proves

Resolve `<syncora-skill-root>` as the absolute directory containing the loaded
`SKILL.md`. After substantive project-source mutation or for an explicit drift
request, run:

```text
node "<syncora-skill-root>/scripts/syncora.mjs" check --changed \
  --workspace <absolute-path>
```

The command compares exact raw-byte fingerprints for sources selected by
current typed bindings. It never edits canonical Markdown and it never claims
that a matched note is wrong. A finding means only that a source the note says
it applies to has changed since the last complete foreground observation.

The first complete run establishes a visible baseline. It cannot prove
historical freshness, so its terminal state is `baseline-established`, not
`current`. If no eligible sources are bound, the state is
`no-tracked-sources`. Missing roots, excluded covered directories, legacy
bindings, and unavailable symbol/component coverage are bounded warnings and
produce a `-degraded` state instead of a false complete-coverage claim.

Git may add bounded rename and change hints. Exact raw-byte fingerprints remain
the detection authority on Git and non-Git workspaces. Syncora has no watcher,
daemon, timer, scheduled job, or after-response work.

## Automatic coverage

The detector evaluates current-schema, authoritative active project, concept,
and reference notes plus accepted decisions. It automatically observes:

- `file:<workspace-relative-path>`
- `module:<workspace-relative-directory>`
- `path_glob:<bounded-workspace-glob>`

Dependency manifests and lockfiles are ordinary file, module, or glob targets;
there is no inferred dependency-name grammar. Untyped, malformed, symbol, and
component bindings do not select files. Symbol and component coverage remains
explicitly incomplete unless a real versioned symbol index exists. Never infer
it with grep or name similarity.

## Finding evidence

Detailed findings and refresh work items are immutable local artifacts under
the resolved graph's ignored `.syncora/drift/` state. CLI output is bounded and
contains identifiers, paths, hashes, counts, and next actions, not note bodies
or diff hunks. Each finding binds the exact workspace and graph identities,
graph revision, affected note hash, matched bindings, and prior/current source
fingerprints. Its refresh item recommends a semantic operation and declares
`afterTextRequired: true`.

Observation artifacts normalize each exact file map and binding once, then let
notes reference binding specifiers. A shared module therefore is not copied
into every note. Matching uses exact-file lookup, module-prefix lookup, and
literal-root glob candidates under explicit work and artifact limits.

Workspaces sharing an external graph have separate state shards. Corrupt,
future-version, oversized, or identity-mismatched state fails closed; Syncora
does not silently reset a baseline.

## Repair route

The detector cannot invent replacement knowledge. Inspect the finding and the
current project sources, then author complete resulting note text only when the
note is actually stale. Prepare a normal proposal input with:

- `origin: "drift"`;
- the recommended operation (`hub.refresh`, `decision.accept`, or
  `note.update`);
- the affected note path and its exact `expectedPriorSha256`;
- complete `afterText`;
- a `drift-finding` source reference containing the finding ID and exact
  artifact SHA-256;
- optional focused file or note references that help human review.

The finding reference is the completeness boundary. At proposal creation and
again before apply, Syncora requires the finding to remain active, requires the
canonical note bytes to match the finding's note hash, and re-fingerprints the
complete matched file/module/glob bindings. This covers additions, deletions,
renames, and files not listed as focused proposal references.

Run `propose --input`, present its bounded repair summary, record the user's
plain-language decision with an internally digest-bound `review`, and use
`apply` only after approval. Offer the local exact before/after artifact only
when full detail is requested. `capture` intentionally rejects drift-origin inputs. Creating,
approving, rejecting, conflicting, or failing a proposal does not resolve the
finding; only an applied matching proposal can do that.

## Harmless changes

When the evidence was reviewed and the note is still current, close that exact
finding without fabricating a Markdown edit:

```text
node "<syncora-skill-root>/scripts/syncora.mjs" check --changed \
  --acknowledge-current <finding-id> \
  --finding-digest sha256:<64-hex> \
  --reason "Why the note remains current" \
  --workspace <absolute-path>
```

The acknowledgment is derived-state disposition bound to the immutable finding
digest. It succeeds only while the exact note and complete bound-source
fingerprints are still current. It is not a canonical repair.

## Explicit policy rebaseline

Ordinary checks fail closed with `DRIFT_POLICY_MISMATCH` when an installed
runtime changes the drift policy. Doctor reports the same condition and gives
the recovery command. After reviewing the previous baseline and every active
finding, run:

```text
node "<syncora-skill-root>/scripts/syncora.mjs" check --changed \
  --rebaseline \
  --reason "Why the previous drift state may be retired" \
  --workspace <absolute-path>
```

This foreground command publishes an immutable rebaseline record, publishes an
exact disposition for every active predecessor finding, establishes the new
observation, and atomically replaces only this workspace's state shard. It does
not repair Markdown and it cannot bypass corrupt, future-schema, or
workspace/graph-identity failures. It also refuses when no retained drift state
exists or when that state already uses the current policy. In those cases, run
ordinary `check --changed`; a reason alone cannot clear compatible active
findings.

## Finding lifetime

An active finding remains until one of these exact transitions is recorded:

1. An applied `origin: "drift"` proposal references the exact finding and
   repairs the affected note while the bound source evidence still matches.
2. The observed source bytes return exactly to the pre-finding fingerprint.
3. An exact-digest still-current acknowledgment records a reason.
4. Later source evolution publishes one cumulative replacement finding and an
   immutable exact `superseded-source-evolution` disposition. Only the latest
   actionable head remains active; prior evidence remains immutable history.
5. An explicit reasoned policy rebaseline retires it with an immutable
   disposition only while migrating retained state from a different policy.

Another check, an updated date, or a direct note edit does not silently clear
it. A direct note change invalidates proposal, apply, and acknowledgment against
the old lineage. Later source evolution is coalesced from the earliest
unresolved snapshot to the latest exact observation, so findings neither
compete nor grow as an unrepairable transition chain.
