# Syncora Activation Evaluation

Status: Preview semantic acceptance fixture
Applies to: unpublished `0.1.0-preview.2` release-candidate source
Updated: 2026-07-20

This matrix tests routing independently of graph contents. It is a semantic
agent evaluation, not a deterministic classifier API. Hosts must apply the
same installed skill and project hook.

| Request shape | Pre route | Direct operation or context | Post |
|---|---|---|---|
| Ordinary project work in an uninitialized workspace | `none` | Normal host behavior; do not create Syncora state | Never |
| Explicit greenfield initialization in an uninitialized workspace | Direct `maintenance` | Run one authorized `setup`; refuse an existing Markdown graph | Operation-owned lifecycle |
| Explicit setup where no graph exists and only the exact supported predecessor marker is present | Direct `maintenance` | Run one authorized `setup`; atomically replace the exact marker while preserving unrelated instructions | Operation-owned lifecycle |
| Explicit legacy-graph adoption in an uninitialized workspace | Direct `maintenance` | Prepare reviewed semantic files, run an internal `adopt --dry-run`, then immediately run the digest-bound final `adopt`; the original request authorizes the lifecycle | Operation-owned lifecycle |
| Explicit custom or unmarked predecessor cleanup with no graph | Direct `maintenance` | Inspect all active agent files, remove predecessor activation, then run one `setup --confirm-predecessor-reviewed` | Operation-owned lifecycle |
| Current date, arithmetic, casual chat | `none` | None | Never |
| Translate or format only supplied text | `none` | None | Never |
| Plan, proposal, design, review, or audit only | Task-relevant route | Deliver the requested artifact; do not implement unless the user also authorizes implementation | Only if the requested artifact itself changes canonical knowledge |
| Implement, fix, update, proceed, or finish within stated scope | Task-relevant route | Continue ordinary reversible work without a second plan, proposal, or size-based confirmation | Only after a real canonical change |
| Materially ambiguous or contradictory request | Minimum safe route | Continue independent safe work, then ask one focused question about the unresolved project choice | After the answer leads to a real canonical change |
| Destructive, weakly reversible action over unusually broad data without exact authorization | Minimum safe route | Ask once about the underlying scope and consequence; do not mutate affected data first | Only after authorized work changes canonical knowledge |
| Exact high-impact action already authorized | Task-relevant route | Continue through the authorized scope; do not ask again merely because the diff is large | Only after a real canonical change |
| Read an exact version from a project manifest | `checkpoint` | Read the named artifact; no semantic context | Never |
| Explain an accepted project decision | `context` | Compile one bounded pack with `orient` or `review`, then answer from its mandatory and working lanes | Only if canonical knowledge later changes |
| Change architecture using existing constraints | `context` plus capture intent | Compile with `implement`, perform the authorized project work, then run autonomous transactional capture with an internal exact authorization and receipt | Only after capture changes canonical knowledge |
| Isolated project edit with no context dependency | `checkpoint` | Normal project work | Only if the task later changes canonical knowledge |
| Substantive project-source mutation with eligible knowledge bindings | Minimum task-relevant pre route | Perform the authorized source work, then run foreground `check --changed`; treat findings as zero-authority review work, not replacement truth | Only if an autonomous validated drift repair changes canonical knowledge |
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
- `setup` and reviewed-pack `adopt` are the normal outcome-scoped commands.
  Standalone `bundle`, `adopt --bundle`, `init`, and `migrate --phase ...` are
  compatibility, inspection, and recovery tools, not additional approval
  steps.
- Uncertainty selects `checkpoint`, never recursive graph loading.
- One active request publishes at most one preflight and one activation-sequence
  increment.
- Capture intent does not mean capture succeeded. Initialized relevant work
  authorizes only the validated transactional capture path.
- The bounded change summary is reporting, not a user approval surface. The
  exact immutable local review artifact remains optional audit evidence.
- An internal Syncora proposal is integrity evidence, not a user-facing
  proposal. Plan-only requests stop at the plan; implementation requests may
  use an internal plan and continue without asking for plan approval.
- Diff length, file count, durability, validation effort, or memory importance
  alone never creates a confirmation boundary. Ask only about a material
  unresolved project choice, unapproved external effect, required host
  permission, or destructive weakly reversible broad-data action whose exact
  scope was not authorized.
- Ask one focused question about the underlying decision. Once resolved, resume
  the operation and capture warranted memory automatically without a second
  save confirmation.
- Ordinary capture must reach `state: "applied"` before the agent responds. An
  agent that stops at a sealed proposal or asks "Save it?" has failed this
  contract; summaries are optional past-tense completion reports only.
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
- General canonical-Markdown-read-only `context` and autonomous transactional
  `capture` are executable in current source; default
  discovery may update a disposable lexical cache.
- Foreground `check --changed` is executable in current source. Exact raw-byte
  fingerprints are authoritative, Git hints are advisory, and the first
  observation cannot claim historical freshness.
- Automatic drift coverage is limited to typed `file`, `module`, and
  `path_glob` bindings. Untyped, malformed, `symbol`, and `component` bindings
  remain visibly unevaluated.
- A finding grants zero authority. Drift repair uses complete agent-authored
  replacement text through autonomous `capture`; the runtime internally binds
  the exact artifact and rechecks every finding constraint before apply.
- Drift checks are event-driven foreground work after substantive source
  mutation or an explicit maintenance request. They do not run on every turn,
  from a timer, in a watcher, or after the final response.

## Host coverage

Codex and Cursor receive the same v7 block through root `AGENTS.md` and an
existing `AGENTS.override.md`. Claude receives the block through root
`CLAUDE.md`, nested `.claude/CLAUDE.md`, or an import of the patched
`AGENTS.md`. Patcher tests cover topology changes and deduplication. A public
release still requires clean installed-host evaluation in all three products;
static repository tests cannot prove a host model will route every novel prompt
correctly.
