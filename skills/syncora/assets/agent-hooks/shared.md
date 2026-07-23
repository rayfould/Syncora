<!-- syncora-agent-hook:begin v8 -->
## Syncora

Syncora being installed does not make every request a Syncora task. Skip it for
self-contained work unrelated to project state. When this project is
initialized with `.syncora/config.json`, use the installed `syncora` skill for
project-dependent or plausibly project-relevant work and run its pre-work
checkpoint unless the selected maintenance command supplies the equivalent
lifecycle. Without initialization, ordinary work stays inactive; only an
explicit initialization, adoption, or diagnostic request may enter Syncora.
Run the paired post-work checkpoint only before the final response and only
when canonical Syncora knowledge changed or an
authority-changing operation completed. Outside setup and adoption, never edit
canonical graph Markdown directly. When durable project knowledge should
change, use non-dry Syncora `capture`; it validates, internally authorizes, and
applies the exact transaction automatically. Never ask whether to save Syncora
memory, and never expose its proposal or artifact digests. Mention the saved
result only when useful and only after apply succeeds. Never stop at a sealed
proposal or turn a change summary into a save question.
Before preparing a capture input, run the internal read-only `resolve-owner`
operation for its scope and stable owner identity. Update an `owner_found`
target using its exact path and prior hash. Never guess between
`owner_ambiguous` candidates or ask the user to choose a note; that is a repair
issue. `owner_missing` does not itself authorize new-node creation.
Before every final response on an initialized project-relevant route, perform
one internal capture-disposition sweep over the work completed and the current
conversation. Classify the result as `durable_change`, `open_question`, or
`no_durable_change`. If it is `durable_change`, prepare one bounded update and
run non-dry `capture` through `state: "applied"` before responding. If it is
`open_question`, silently create or update one stable-keyed entry in the
owning project or workstream hub's `Open questions` section through that same
applied capture path; a session or journal may provide provenance but never owns
the question. If it is `no_durable_change`, finish without a graph write.
Do not expose the classification or add a confirmation step. This sweep is
mandatory even when the agent did not predict capture at the start of the
request. Only when the unresolved fact blocks completion or could materially
change the outcome should it become `user_decision_required`; then ask one
focused question about the underlying project choice, never whether to save
memory. Later source-grounded evidence should update the same key to resolved.
Cleanup may merge duplicate keys, move resolved entries out of the active
list, or mark stale unsupported entries dormant, but it must not invent an
answer or silently delete a material unresolved question.
After substantive project-source mutation, run the foreground
`check --changed` operation before deciding whether durable knowledge capture
is needed. A drift finding proves only potential staleness: inspect its local
evidence, author complete replacement note text when repair is warranted, and
route that exact repair through autonomous `capture` with drift provenance. If
the correct project truth is unclear, ask about that truth rather than asking
whether to save. An exact-digest acknowledgment may close a harmless finding without a
Markdown edit. Do not run drift checks for `none` routes, on every turn, or as
background work; component and symbol bindings remain unevaluated unless a
versioned symbol index exists.
Syncora runs quietly during the active request; never imply a separate daemon
or after-final work, and never bypass the bounded context compiler or
transactional capture boundary.
An internal Syncora proposal is integrity evidence, not a request for user
permission. Continue ordinary in-scope work the user requested, including
reversible work that naturally touches many files. Pause only for a real
project decision: a plan-only request did not authorize implementation; the
request is materially ambiguous or contradictory; viable choices materially
change the outcome; a destructive, weakly reversible action would affect an
unusually large share of data without exact authorization; an unapproved
external or production effect would occur; or the host requires permission.
Diff length, file count, durability, or memory importance alone never require
confirmation. Ask one short question about the actual choice or risk. Once it
is resolved, continue and capture durable knowledge automatically without a
second memory confirmation.
When a long plan, specification, design, review, or audit is the basis for
implementation approval, put a `Decision brief` of no more than 200 words in
the response before asking. Include the recommendation, material outcome,
primary tradeoffs, risks and rollback, and only genuine open decisions. Keep
the full artifact available as optional detail. Never make `Please review the
full spec and say proceed` the only approval surface.
<!-- syncora-agent-hook:end v8 -->
