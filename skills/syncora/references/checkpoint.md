# Foreground checkpoint contract

A checkpoint is a small foreground control step, not a background worker. It
may run only while an agent is handling an active request.

## Turn lifecycle

```text
request
  -> classify activation profile
  -> pre-work checkpoint when the selected route requires it
  -> task-scoped work
  -> post-work checkpoint only after canonical or authority change
  -> final response
  -> stop
```

- Run the pre-work phase before substantial project exploration or mutation.
- Do not run it before a direct maintenance command that already supplies the
  equivalent lifecycle. In particular, initialization and pre-initialization
  diagnostics cannot depend on checkpoint state.
- Run the post-work phase before the final response, never after it, and only
  when canonical Syncora Markdown actually changed or an authority-changing
  operation completed. A direct maintenance command with an equivalent
  operation-owned lifecycle satisfies its own gates and does not need a generic
  checkpoint ID.
- Pair both phases with one checkpoint ID. A completed pre phase returns the
  ID; post requires that ID and is idempotent. Post never increments the
  activation sequence.
- Do not schedule timers, watchers, daemons, delayed callbacks, or after-final
  work as part of the portable skill.
- A wall-clock deadline means "due at the next foreground activation," not an
  autonomous wake-up.

## Validation cadence

Use event triggers as the correctness boundary. Use activation count and time
only as safety backstops.

A completed full validation stores an exact source fingerprint, graph revision,
findings digest, and environment and policy identities. Unchanged preflights use
a cheaper `changeFingerprint` over Markdown paths, byte sizes, nanosecond
modification/change/birth times, device and inode identity, mode, and structural
findings. Reuse is allowed only while that best-effort change signal, the
environment, policy identities, and cadence all match.

The fast tier enumerates and stats Markdown files but does not read every note
body. A changed signal, event trigger, threshold, postflight, or `--force`
performs two complete exact inspections and publishes only when both agree. A
publication settle check observes graph metadata, rebinds the environment, and
observes graph metadata again immediately before state publication. Both graph
observations and the environment must match, so ordinary late add, delete,
rename, replacement, config, and graph-root races force retry.

A full validation is due on the next relevant activation when any of these are
true:

- no completed compatible validation stamp exists;
- the graph, configuration, schema, runtime policy, or graph-root identity
  changed;
- the previous validation was incomplete, crashed, or transiently failed, or
  checkpoint state is corrupt;
- a canonical write, authority change, manifest application, migration, or
  repair requires a gate;
- the user explicitly requests validation;
- 50 completed pre-work activations or 168 hours have elapsed since the last
  full validation.

Critical events never wait for the count or time threshold. When the metadata
change signal and every other stamp input still match, reuse the completed
validation and return a compact result. A completed validation with quarantined
findings is `completed-degraded`, not incomplete; reuse it while these gates
match and return its degraded status rather than rescanning forever.

The metadata tier is not content authority. An external writer that preserves
every observable stat field, stale network-filesystem metadata, or a write after
the final compare-and-swap can defer detection until the 50-activation,
168-hour, or forced exact scan. Authority-sensitive reads and writes therefore
retain independent current-byte validation and shared-write gates.

Count completed pre-work activations, including completed-degraded results, not
raw chat turns. Requests classified as `none` do not increment the sequence.
Store one bounded, replaceable derived-state record; do not append one log entry
per turn. State and lock-owner records use bounded, stable regular-file reads.
Lock-path mutation is serialized by an exclusive recovery guard, and every
state/lock operation stays bound to the exact `.syncora/` and `locks/`
directory identities resolved for that operation. An orphaned recovery guard
is never guessed stale automatically; diagnosis reports it for deliberate
operator cleanup after confirming no owner is active.

## Commands

Run pre before substantial project work:

```text
node "<syncora-skill-root>/scripts/syncora.mjs" checkpoint --phase pre --profile <checkpoint|context|capture|maintenance> --workspace <absolute-path>
```

Pre returns `checkpoint.id` and increments `checkpoint.sequence` once. Use
`--force` only to request full validation explicitly.

Use pre profile `capture` only as shorthand for checkpoint-level pre-work plus
planned capture intent. If the task also needs context, use pre profile
`context`; the later post phase still records the independent change
disposition.

After a durable change, run post before the final response:

```text
node "<syncora-skill-root>/scripts/syncora.mjs" checkpoint --phase post --checkpoint-id <pre-checkpoint-id> --workspace <absolute-path>
```

Post rejects a missing or unrelated ID, never increments the sequence, and is
idempotent for the same completed checkpoint. It compares the exact postflight
source fingerprint with the preflight baseline and reports `no-change` instead
of claiming a durable change when they match. The post result preserves the
original pre-work profile. Its disposition independently reports
`durable-change`, `no-change`, or `unattributed-change`. The last result is a
fail-closed outcome: exact source bytes differ from the stored exact stamp, but
the best-effort metadata baseline did not change, so a reused preflight cannot
prove that the drift happened during this request. Both phases accept
`--format text|json` and the exact external-graph-root allowlist option.

## Durable-change boundary

Run post after canonical Syncora Markdown was changed or an operation actually
applied an authority, migration, repair, or governed-capture change. A normal
code edit, discussion, proposal, or change to derived `.syncora/` state is not
by itself a completed knowledge capture. If code changes establish a durable
truth that still needs capture, retain capture intent and report the unavailable
capture capability; do not run post as if the knowledge was already recorded.

If relevance escalates after preflight, keep the original checkpoint ID. Load
the newly required bounded capability when available, but never run a second
preflight for the same active request.

The compact result reports foreground mode, graph identity and revision,
checkpoint phase/profile/ID/sequence, validation status and reuse mode,
findings digest, and state condition. Text output is one `SYNCORA_OK` or
`SYNCORA_DEGRADED` line.

Checkpoint orchestration does not itself compile context. After a successful
preflight with profile `context`, run the separate bounded `context` command as
described in [context.md](context.md). Governed capture is still unavailable;
do not silently substitute chat memory or direct note writes.
