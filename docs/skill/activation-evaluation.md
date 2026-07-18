# Syncora Activation Evaluation

Status: Preview semantic acceptance fixture
Applies to: unpublished `0.1.0-preview.2` release-candidate source
Updated: 2026-07-18

This matrix tests routing independently of graph contents. It is a semantic
agent evaluation, not a deterministic classifier API. Hosts must apply the
same installed skill and project hook.

| Request shape | Pre route | Direct operation or context | Post |
|---|---|---|---|
| Ordinary project work in an uninitialized workspace | `none` | Normal host behavior; do not create Syncora state | Never |
| Explicit greenfield initialization in an uninitialized workspace | Direct `maintenance` | Run one authorized `setup`; refuse an existing Markdown graph | Operation-owned lifecycle |
| Explicit setup where no graph exists and only the exact supported predecessor marker is present | Direct `maintenance` | Run one authorized `setup`; atomically replace the exact marker while preserving unrelated instructions | Operation-owned lifecycle |
| Explicit legacy-graph adoption in an uninitialized workspace | Direct `maintenance` | Prepare reviewed semantic files, seal them with `bundle`, then run one authorized `adopt --bundle`; never run `setup` or `init` first | Operation-owned lifecycle |
| Explicit custom or unmarked predecessor cleanup with no graph | Direct `maintenance` | Inspect all active agent files, remove predecessor activation, then run one `setup --confirm-predecessor-reviewed` | Operation-owned lifecycle |
| Current date, arithmetic, casual chat | `none` | None | Never |
| Translate or format only supplied text | `none` | None | Never |
| Read an exact version from a project manifest | `checkpoint` | Read the named artifact; no semantic context | Never |
| Explain an accepted project decision | `context` | Compile one bounded pack with `orient` or `review`, then answer from its mandatory and working lanes | Only if canonical knowledge later changes |
| Change architecture using existing constraints | `context` plus capture intent | Compile with `implement`, perform the authorized project work, then prepare one governed proposal and provide its exact local review artifact; after the user inspects and approves that artifact-bound proposal, record the digest-bound review and apply | Only after the approved apply changes canonical knowledge |
| Isolated project edit with no context dependency | `checkpoint` | Normal project work | Only if the task later changes canonical knowledge |
| Substantive project-source mutation with eligible knowledge bindings | Minimum task-relevant pre route | Perform the authorized source work, then run foreground `check --changed`; treat findings as zero-authority review work, not replacement truth | Only if a separately approved drift repair changes canonical knowledge |
| Explicit changed-source drift request | Direct `maintenance` | Run `check --changed`; first observation establishes a baseline rather than freshness | Operation-owned lifecycle |
| Review says an exact finding is harmless | Direct `maintenance` | Run `check --changed --acknowledge-current` with the exact finding ID, digest, and bounded reason | Operation-owned lifecycle; no canonical change |
| Doctor or check reports `DRIFT_POLICY_MISMATCH` | Direct `maintenance` after reviewing prior findings | Run `check --changed --rebaseline --reason <text>`; do not use it to bypass corrupt or identity-mismatched state | Operation-owned lifecycle; no canonical change |
| Explicit graph validation | Direct `maintenance` | Run `validate`; no redundant checkpoint | Operation-owned lifecycle |
| Validate, then review using accepted decisions | Direct `validate`, then `context` for the review clause | Preserve both clauses; maintenance does not erase context | Only after a separate canonical change |
| Relevance discovered after a checkpoint preflight | Reclassify in memory; reuse the same checkpoint ID | Load the newly required bounded capability | Use the original ID if canonical capture succeeds |
| Explicit "do not use Syncora" plus a project-memory question | `none` | Answer only from supplied non-Syncora evidence or report the limitation | Never |

## Acceptance rules

- `none` performs no Syncora command, state read, counter increment, or graph
  load, including no drift check.
- A global installation does not activate implicit project routes until a
  project-local `.syncora/config.json` confirms initialization.
- Explicit adoption may run before that config exists. Successful cutover
  creates or enables it; inventory, stage, and shadow do not make implicit
  routes available.
- `setup`, `bundle`, and `adopt --bundle` are the normal outcome-scoped commands. The
  individual `init` and `migrate --phase ...` surfaces are compatibility,
  inspection, and recovery tools, not additional approval steps.
- Uncertainty selects `checkpoint`, never recursive graph loading.
- One active request publishes at most one preflight and one activation-sequence
  increment.
- Capture intent does not grant write authority and does not mean capture
  succeeded.
- The bounded proposal summary is not the human review surface. Approval
  requires inspection of the exact immutable local review artifact returned by
  capture or proposal inspection.
- A normal code edit does not trigger post unless canonical Syncora knowledge
  was actually changed or an authority-changing operation completed.
- If post is mistakenly invoked without an exact canonical graph change, the
  runtime records `no-change` and does not claim a durable capture.
- If exact bytes differ but a reused metadata baseline cannot attribute the
  drift to this request, post records `unattributed-change` instead of making a
  false durability claim.
- Direct maintenance commands use their own lifecycle. Compound prompts retain
  every required clause rather than applying a lossy total precedence rule.
- Legacy cutover requires a reviewed v2 manifest, exact staged content, a
  passing recorded shadow report, and user-authorized publication. Missing
  exact predecessor markers fail closed unless the user has inspected all
  active agent instruction surfaces, removed custom predecessor activation,
  and explicitly passes `--confirm-predecessor-reviewed`.
- General canonical-Markdown-read-only `context` and governed
  `capture` -> `review` -> `apply` are executable in current source; default
  discovery may update a disposable lexical cache.
- Foreground `check --changed` is executable in current source. Exact raw-byte
  fingerprints are authoritative, Git hints are advisory, and the first
  observation cannot claim historical freshness.
- Automatic drift coverage is limited to typed `file`, `module`, and
  `path_glob` bindings. Untyped, malformed, `symbol`, and `component` bindings
  remain visibly unevaluated.
- A finding grants zero authority. Drift repair uses `propose` -> exact local
  artifact review -> `review` -> `apply`; `capture` rejects drift-origin input.
- Drift checks are event-driven foreground work after substantive source
  mutation or an explicit maintenance request. They do not run on every turn,
  from a timer, in a watcher, or after the final response.

## Host coverage

Codex and Cursor receive the same v4 block through root `AGENTS.md` and an
existing `AGENTS.override.md`. Claude receives the block through root
`CLAUDE.md`, nested `.claude/CLAUDE.md`, or an import of the patched
`AGENTS.md`. Patcher tests cover topology changes and deduplication. A public
release still requires clean installed-host evaluation in all three products;
static repository tests cannot prove a host model will route every novel prompt
correctly.
