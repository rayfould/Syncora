# Activation policy

## Availability gate

An explicit request to initialize, adopt, or diagnose Syncora may run its
direct maintenance command before initialization. For every other request,
implicit project routing is available only when the workspace has a
project-local `.syncora/config.json`. If it does not, select `none`: a global
skills.sh installation must remain inert in ordinary uninitialized projects.

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
| `capture` | The task may establish or change durable knowledge without needing context retrieval. | Use checkpoint-level pre-work with planned capture intent. Before the final response, run post only if canonical Syncora Markdown changed or an authority-changing operation completed. |
| `maintenance` | The user requests initialization, diagnostics, validation, migration, repair, conflict review, upgrade, patching, or unpatching. | Run only the requested supported maintenance operation and its required safety gates. |

The five labels describe routing, not five mutation authority levels. Select a
pre-work mode (`none`, `checkpoint`, `context`, or `maintenance`) and an
independent post-work change disposition. Runtime profile `capture` is
shorthand for checkpoint-level pre-work plus planned capture intent. If a task
needs both context and capture, run pre with `context`, then run post only after
the durable change. Maintenance-oriented project work can use pre
`maintenance`, then post; a direct maintenance command instead owns its whole
lifecycle.

For compound prompts, classify every clause and retain each required operation.
Precedence applies only when clauses can share one checkpoint gate; it never
removes a direct maintenance command or a separate context requirement. Keep
unrelated self-contained clauses out of graph context. No route authorizes
unrelated reads or writes.

Direct maintenance commands with an equivalent lifecycle run directly. Do not
precede `setup` (`init` compatibility), `bundle`, `adopt --bundle`, `doctor`, explicit
`validate`, patch/unpatch, or read-only migration inventory with a redundant
checkpoint. Their operation-owned lifecycle satisfies the applicable pre/post
gates. Use a maintenance checkpoint only for maintenance-oriented project work
that lacks its own gate.
Operation-specific validation remains mandatory for authority-sensitive writes.

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
  post disposition with that same checkpoint ID only when the change actually
  occurs.
- If a proposed durable change does not occur, omit the post-work capture path.
- Never substitute chat memory for a required context pack, and never replace
  unavailable governed capture with an unreviewed direct note write.

Profile selection grants no mutation authority. Initialization, canonical
writes, patching, unpatching, committing, and pushing retain their independent
authorization requirements. In particular, selecting `capture` never grants
permission to write canonical knowledge.
