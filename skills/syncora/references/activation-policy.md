# Activation policy

## Availability gate

An explicit request to set up, update, repair, remove, adopt, or diagnose
Syncora may run the corresponding maintenance workflow before project
initialization when its target exists. For every other request, implicit
project routing is available only when the workspace has a project-local
`.syncora/config.json`. If it does not, select `none`: a global skills.sh
installation must remain inert in ordinary uninitialized projects.

Availability is still not activation. The presence of `.syncora/config.json`
means Syncora can be used in the workspace; it does not prove that the current
request needs project knowledge. Do not initialize or create runtime state just
to make an implicit route available.

## Positive routing test

Evaluate the request before loading graph content:

1. Does the user explicitly request a Syncora operation?
2. Does the answer depend on workspace-specific files, facts, artifacts,
   decisions, constraints, architecture, status, blockers, history, or
   provenance?
3. Does the task require substantive project exploration or mutation even if
   durable context is probably unnecessary?
4. Could the work establish or change durable project knowledge?

If every answer is no, select `none`. If project relevance is plausible but
uncertain, select `checkpoint`; uncertainty never justifies loading the full
graph.

An explicit user request to skip Syncora selects `none`. If the same request
also asks for a Syncora mutation or safety gate, do not execute that operation;
surface the conflict instead of overriding the opt-out.

## Profiles

| Profile | Select when | Required behavior |
|---|---|---|
| `none` | The request is self-contained and independent of workspace state. | Do not activate Syncora, inspect its state, increment its cadence, or load graph notes. |
| `checkpoint` | The task concerns the project but does not need durable context, or relevance is uncertain. | Perform only the supported cheap pre-work checkpoint. Do not compile context or capture knowledge by default. |
| `context` | Correct work depends on project decisions, constraints, status, history, or provenance. | Perform the pre-work checkpoint, then run the bounded task-context compiler with the current intent, suitable mode, and any known typed targets. |
| `capture` | The task may establish or change durable knowledge without needing context retrieval. | Use checkpoint-level pre-work, then run autonomous transactional capture when a durable change is actually needed. Run post only after capture changes canonical Markdown or authority. |
| `maintenance` | The user requests initialization, diagnostics, validation, migration, repair, conflict review, upgrade, patching, or unpatching. | Run only the requested supported maintenance operation and its required safety gates. |

The five labels describe routing, not five mutation authority levels. Select a
pre-work mode (`none`, `checkpoint`, `context`, or `maintenance`) and an
independent post-work change disposition. Runtime profile `capture` is
shorthand for checkpoint-level pre-work plus planned capture intent. If a task
needs both context and capture, run pre with `context`, then run post only after
the durable change. Maintenance-oriented project work can use pre
`maintenance`, then post; a direct maintenance command instead owns its whole
lifecycle. Creating or inspecting a proposal does not count as a durable
change; only a successful canonical apply does.

## Mandatory pre-final capture disposition

For every initialized project-relevant route, perform one internal disposition
sweep after the work is complete and before the final response. This sweep is
mandatory even when pre-work routing did not predict a durable change. Inspect
the completed work and current conversation, then select exactly one result:

- `durable_change`: durable decisions, constraints, rationale, status, or
  discoveries changed. Prepare one bounded proposal input and run non-dry
  `capture` through `state: "applied"` before responding.
- `open_question`: a potentially durable project fact remains uncertain but
  does not block the current task. Resolve the owning project or workstream hub,
  then silently create or update one stable-keyed item in its `Open questions`
  section through the same applied capture path. Session or journal material
  may be provenance, but it never owns the question.
- `no_durable_change`: no canonical project knowledge changed. Finish without
  a graph write or post-work capture checkpoint.

An uncertainty that blocks completion or could materially change the outcome is
not a quiet capture disposition. Treat it as `user_decision_required` and ask
one focused question about the underlying project choice. Never ask whether to
save memory. Later source-grounded evidence updates the existing question key
to resolved. Cleanup may merge duplicate keys, move resolved entries out of the
active list, or mark stale unsupported entries dormant; it must not invent an
answer or silently delete a material unresolved question.

The disposition is internal bookkeeping, not a user-visible status or approval
surface. Do not announce it, ask whether to save, or perform the sweep for a
route that remained `none`. A direct maintenance command may satisfy its own
equivalent lifecycle, but any additional durable project truth established by
the surrounding work still receives this disposition.

For compound prompts, classify every clause and retain each required operation.
Precedence applies only when clauses can share one checkpoint gate; it never
removes a direct maintenance command or a separate context requirement. Keep
unrelated self-contained clauses out of graph context. No route authorizes
unrelated reads or writes.

## User decision gate

Routing and user authorization are separate. A request to implement, fix,
update, proceed, or finish authorizes ordinary in-scope work; do not stop for a
plan approval, a long diff, or a Syncora save question. A request only for a
plan, proposal, design, review, or audit does not authorize implementation.

Before asking the user anything, apply
[decision-boundaries.md](decision-boundaries.md). Pause only when the underlying
project action needs a material choice, has unresolved ambiguity, introduces an
unapproved external effect, or combines destructive weakly reversible behavior
with unusually broad data impact and unclear scope. Ask once about that real
decision. After it is resolved, continue the authorized operation and save any
warranted Syncora memory automatically.

Direct maintenance commands with an equivalent lifecycle run directly. Do not
precede `setup` (`init` compatibility), reviewed-pack `adopt`, compatibility
`bundle` or `adopt --bundle`, `doctor`, explicit `validate`, patch/unpatch, or
read-only migration inventory with a redundant checkpoint. Their
operation-owned lifecycle satisfies the applicable pre/post gates. Use a
maintenance checkpoint only for maintenance-oriented project work that lacks
its own gate.
Operation-specific validation remains mandatory for authority-sensitive writes.

## Foreground drift trigger

`check --changed` is event-driven maintenance, not a per-turn gate. Run it when
the current foreground task substantively creates, changes, moves, or deletes
project source files, or when the user explicitly asks for drift inspection.
Run it before the final durable-capture decision, while the agent can still
inspect findings and prepare any warranted governed proposal. Do not run it for
`none` routes, read-only tasks, trivial metadata reads, every fixed number of
turns, or after the final response. Syncora has no watcher, daemon, timer, or
background worker.

A finding means only that exact bytes covered by a typed file, module, or path
glob binding changed. It does not prove the note is wrong and never grants
permission to edit canonical Markdown. Symbol and component bindings report
incomplete drift coverage unless a real versioned symbol index is available.
Repair remains the autonomous transactional flow in [capture.md](capture.md); a harmless
finding may instead receive an exact-digest acknowledgment with a reason.

## Requests that stay `none`

Keep Syncora inactive for requests such as:

- the current date or time;
- arithmetic or unit conversion;
- translating or formatting text supplied in the request;
- casual conversation;
- general definitions or explanations independent of this workspace;
- writing or summarizing entirely from supplied content when no project fact is
  needed.

A named project in the working directory is not enough to change these
outcomes.

Project-local code-only tasks, such as reading an exact version from a manifest
or making an isolated mechanical edit, normally select `checkpoint`, not
`context`, unless a project decision or constraint is actually needed.

When `context` is selected, follow [context.md](context.md). The checkpoint and
compiler are separate foreground commands: run preflight once, then compile
one bounded pack. Do not run `context` for clauses that remain self-contained.

## Escalation and de-escalation

- Escalate `none` to `checkpoint` only if project dependency appears during the
  task; run one preflight at that point.
- Escalate `checkpoint` to `context` only when a concrete project-specific fact
  is required. Reuse the existing checkpoint ID and do not run a second
  preflight or increment cadence again.
- Mark capture intent when the work may produce a durable change; execute the
  autonomous flow in [capture.md](capture.md), then execute the post disposition
  with that same checkpoint ID only when apply actually changes canonical
  knowledge.
- Always perform the mandatory pre-final disposition sweep. If its result is
  `no_durable_change`, omit the post-work capture path.
- Never substitute chat memory for a required context pack, and never replace
  transactional capture with a direct note write.

In an initialized project, a relevant foreground task grants Syncora authority
to save its own durable memory through `capture`. This does not authorize
unrelated project mutation, initialization, patching, unpatching, committing,
or pushing. Capture still fails closed on invalid provenance, stale bytes,
authority conflicts, or an unsafe projected graph; none of those gates require
a separate save confirmation.
