# Syncora Activation Evaluation

Status: Acceptance fixture
Updated: 2026-07-16

This matrix tests routing independently of graph contents. It is a semantic
agent evaluation, not a deterministic classifier API. Hosts must apply the
same installed skill and project hook.

| Request shape | Pre route | Direct operation or context | Post |
|---|---|---|---|
| Ordinary project work in an uninitialized workspace | `none` | Normal host behavior; do not create Syncora state | Never |
| Explicit Syncora initialization or adoption in an uninitialized workspace | Direct `maintenance` | Run the authorized `init` lifecycle | Operation-owned lifecycle |
| Current date, arithmetic, casual chat | `none` | None | Never |
| Translate or format only supplied text | `none` | None | Never |
| Read an exact version from a project manifest | `checkpoint` | Read the named artifact; no semantic context | Never |
| Explain an accepted project decision | `context` | Bounded context compiler; report unavailable in the current runtime | Only if canonical knowledge later changes |
| Change architecture using existing constraints | `context` plus capture intent | Bounded context, then governed capture; report unavailable capabilities honestly | After canonical capture actually succeeds |
| Isolated project edit with no context dependency | `checkpoint` | Normal project work | Only if the task later changes canonical knowledge |
| Explicit graph validation | Direct `maintenance` | Run `validate`; no redundant checkpoint | Operation-owned lifecycle |
| Validate, then review using accepted decisions | Direct `validate`, then `context` for the review clause | Preserve both clauses; maintenance does not erase context | Only after a separate canonical change |
| Relevance discovered after a checkpoint preflight | Reclassify in memory; reuse the same checkpoint ID | Load the newly required bounded capability | Use the original ID if canonical capture succeeds |
| Explicit "do not use Syncora" plus a project-memory question | `none` | Answer only from supplied non-Syncora evidence or report the limitation | Never |

## Acceptance rules

- `none` performs no Syncora command, state read, counter increment, or graph
  load.
- A global installation does not activate implicit project routes until a
  project-local `.syncora/config.json` confirms initialization.
- Uncertainty selects `checkpoint`, never recursive graph loading.
- One active request publishes at most one preflight and one activation-sequence
  increment.
- Capture intent does not grant write authority and does not mean capture
  succeeded.
- A normal code edit does not trigger post unless canonical Syncora knowledge
  was actually changed or an authority-changing operation completed.
- If post is mistakenly invoked without an exact canonical graph change, the
  runtime records `no-change` and does not claim a durable capture.
- If exact bytes differ but a reused metadata baseline cannot attribute the
  drift to this request, post records `unattributed-change` instead of making a
  false durability claim.
- Direct maintenance commands use their own lifecycle. Compound prompts retain
  every required clause rather than applying a lossy total precedence rule.
- Missing `context` or governed `capture` remains an explicit capability gap in
  this development version.

## Host coverage

Codex and Cursor receive the same v2 block through root `AGENTS.md` and an
existing `AGENTS.override.md`. Claude receives the block through root
`CLAUDE.md`, nested `.claude/CLAUDE.md`, or an import of the patched
`AGENTS.md`. Patcher tests cover topology changes and deduplication. A public
release still requires clean installed-host evaluation in all three products;
static repository tests cannot prove a host model will route every novel prompt
correctly.
