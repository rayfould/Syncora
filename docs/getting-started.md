# Getting started

This guide sets up Syncora in a greenfield project and shows optional
diagnostics.
Syncora has no background service: every command runs synchronously during an
agent turn or direct CLI invocation.

## Requirements

- Node.js 22 or 24
- Codex, Cursor, or Claude Code
- A version-controlled or otherwise recoverable test workspace is recommended

## 1. Install the skill

From any directory, install Syncora for the agents you use:

```bash
npx skills add rayfould/Syncora --skill syncora --global --agent codex --agent cursor --agent claude-code --yes
```

This creates the canonical global installation at
`~/.agents/skills/syncora`, which Codex and Cursor discover directly. The
installer also exposes the same skill to Claude Code at
`~/.claude/skills/syncora`.

Remove agent flags you do not need. Use `--copy` if shared links are not
available on the machine.

## 2. Choose greenfield initialization or legacy adoption

Use `setup` for a new project with no pre-Syncora Markdown knowledge graph. It
may be rerun idempotently after Syncora has initialized the project. For a
pre-existing graph, follow
[legacy knowledge graph adoption](legacy-kg-adoption.md). Greenfield `setup`
(and its `init` compatibility alias) deliberately fails that case with
`MIGRATE015`; it will not merge competing authority or append a new hook beside
a predecessor workflow.

A project with no graph and only the exact supported predecessor instruction
marker remains a setup case: `setup` replaces that marker atomically while
preserving unrelated instructions. `--no-patch-agents` is invalid for that
transition because it would leave competing activation in place.

If a custom or unmarked predecessor activation exists without a graph, inspect
all active Codex, Cursor, and Claude instruction files, remove that activation,
then run `setup --confirm-predecessor-reviewed`. The confirmation authorizes
adding Syncora after semantic review; it never deletes custom instructions.
Existing graphs instead use the two-command `bundle` then `adopt` flow in the
legacy-adoption runbook.

## 3. Initialize a greenfield project

Open the target project in your agent and say:

```text
Use $syncora to set up this workspace.
```

That explicit request authorizes normal greenfield setup; the skill should run
one `setup` command without adding a mandatory preview-and-confirm cycle.
Initialization creates a `local/` Markdown graph and patches
supported project-level instruction files by default. A successful non-dry-run
setup also makes one foreground changed-source observation. Its reported
`baseline-established` state, when eligible sources exist, is a starting point
for future comparisons, not a claim that newly created or adopted knowledge was
historically fresh. A graph without eligible automatic bindings reports
`no-tracked-sources`. If the runtime cannot complete the observation, setup
reports `completed-degraded` and the baseline requires explicit attention. Use
`--no-patch-agents` when invoking the runtime directly if you want the graph
without persistent agent hooks.

If you later enable hooks with `patch-agents`, the command fails while an exact
or possible custom predecessor activation remains. You may add
`--confirm-predecessor-reviewed` after review and removal; the flag never
overrides that byte-level safety gate.

For a direct dry run:

```bash
node <installed-syncora-skill>/scripts/syncora.mjs setup --workspace /absolute/path/to/project --dry-run
```

Add `--dry-run` only when a preview is specifically useful. `init` remains an
expert compatibility alias.

## 4. Optional diagnostics

```bash
node <installed-syncora-skill>/scripts/syncora.mjs doctor --workspace /absolute/path/to/project
node <installed-syncora-skill>/scripts/syncora.mjs validate --workspace /absolute/path/to/project
```

`setup` checks initialization preconditions and verifies any agent-file
publication, but it does not run the separate full-graph `validate` command.
Run `doctor` or `validate` only when you want the corresponding diagnostic
report. The initialized graph routes through
`local/index.md`. Canonical project facts,
decisions, and concepts remain plain Markdown. Ordinary generated `.syncora/`
state is noncanonical; it should not be treated as knowledge. Drift state lives
under the resolved graph at
`.syncora/drift/workspaces/<workspace-identity>/`, so separate worktrees that
share an external graph retain separate baselines and observations. Do not
discard active migration, proposal, transaction, or drift evidence merely
because it is noncanonical.

## 5. Normal use

The small project instruction hook tells the agent when Syncora is relevant.
Trivial or unrelated requests can bypass it. Relevant work uses foreground
checkpoint decisions and bounded retrieval; no timer or worker runs between
messages.

When a task depends on project decisions, constraints, status, or history, the
agent runs one `context` checkpoint, then compiles a task-specific pack. For
direct use:

```bash
node <installed-syncora-skill>/scripts/syncora.mjs checkpoint --phase pre --profile context --workspace /absolute/path/to/project
node <installed-syncora-skill>/scripts/syncora.mjs context --workspace /absolute/path/to/project --intent "review session expiry" --mode review --target file:src/auth/session.ts --budget standard --format json
```

The built-in `lean`, `standard`, and `deep` ceilings are 4,800, 12,000, and
32,000 characters. Mandatory truth fails visibly if it cannot fit; optional
material is omitted whole and reported in the source map.

Use JSON when an agent needs the complete lanes and a bounded structured source
map with totals and truncation signals. The default text form prints the
bounded context plus a compact human-readable summary. Context compilation
never changes canonical Markdown; unless `--no-cache` is used, it may update a
disposable derived lexical cache.

After substantive project-source mutation, or when the user explicitly asks
for drift maintenance, the agent runs:

```bash
node <installed-syncora-skill>/scripts/syncora.mjs check --changed --workspace /absolute/path/to/project --format json
```

The command is foreground-only. It does not run before or after every message,
and nothing watches the project between requests. The first complete run in a
workspace without setup/adoption baseline state returns `baseline-established`
when eligible sources exist; that establishes a comparison point and cannot
prove historical freshness. With no eligible automatic binding it reports
`no-tracked-sources` instead. Missing or excluded covered roots and unsupported
binding kinds add bounded warnings and a visible `-degraded` state.

Exact raw-byte fingerprints are the detection authority in both Git and
non-Git workspaces. Git may contribute bounded change and rename hints, but a
Git baseline never overrides those fingerprints. Automatic source selection is
limited to eligible canonical or supporting active projects, concepts, and
references, plus accepted decisions, with `file`, `module`, or `path_glob`
bindings. Dependency manifests and lockfiles are covered only when named by one
of those binding forms. `symbol` and `component` bindings are reported as
unevaluated because the preview has no real versioned symbol index.

A changed binding creates an immutable, zero-authority finding and refresh work
item beneath the resolved graph. A finding means only that a note is
potentially stale; it contains no replacement text and never changes canonical
Markdown. If current sources show that the note needs repair, the agent authors
the complete resulting note and uses `propose --input`, inspects the exact local
review artifact, records the exact digest decision with `review`, and runs
`apply` only after approval. `capture` intentionally rejects `origin: "drift"`
inputs, so drift evidence cannot bypass the governed path.

If exact evidence shows the note is still current, close only that finding with
an exact digest and a reason:

```bash
node <installed-syncora-skill>/scripts/syncora.mjs check --changed \
  --acknowledge-current finding_<64-hex> \
  --finding-digest sha256:<64-hex> \
  --reason "The source change does not alter the documented contract." \
  --workspace /absolute/path/to/project
```

An active finding otherwise remains until a matching applied drift proposal is
proven, all matched source fingerprints return exactly to their pre-finding
values, a still-current acknowledgment is exact and fresh, later source
evolution creates one cumulative replacement, or an explicit reasoned
policy rebaseline of incompatible retained state dispositions it. Proposal creation and apply recheck the complete
matched bindings and canonical note hash. A direct note edit, later check, or
changed timestamp does not silently clear it. If doctor reports
`DRIFT_POLICY_MISMATCH`, run `check --changed --rebaseline --reason <text>` only
after reviewing prior active findings. The command refuses absent or already
policy-compatible state. See the bundled
[foreground drift reference](../skills/syncora/references/drift.md).

When work creates a durable decision, constraint, status change, or other
project knowledge, the agent uses a separate governed flow:

1. Prepare a bounded proposal draft and run `capture`.
2. Open the returned immutable local review artifact and inspect its exact
   JSON-escaped before/after records. The returned digest, impact, paths, and
   compact summary are orientation only. Canonical Markdown is still unchanged.
3. Ask one approval question naming the proposal and artifact digests. After
   approval, record a `review` bound to that exact proposal digest.
4. Run `apply`, which revalidates the artifact, provenance, and complete
   post-image and publishes through a process-interruption-recoverable
   transaction.

A stale baseline becomes a conflict instead of overwriting newer work. A later
foreground retry resumes the same transaction or returns the existing exact
receipt. Before the irreversible commit boundary, a failed apply attempts exact
rollback. After the boundary, the journal remains
`finalized-pending-receipt`; rerunning `apply` publishes the bound receipt and
finishes release. No worker performs that retry automatically. The agent
normally handles these commands; maintainers can use the complete
[capture reference](../skills/syncora/references/capture.md).

Process interruption is the supported recovery model. Node cannot provide a
portable Windows directory-fsync guarantee for sudden power loss. Syncora also
cannot make a noncooperating editor or process participate in its graph lock;
such a writer can race the final byte check and atomic rename. Keep the preview
in a versioned or otherwise recoverable workspace.

## 6. External graph roots

Syncora rejects a `local/` path that resolves outside the workspace unless the
exact resolved root is explicitly allowlisted. This protects against unexpected
symlink or junction mutation. Only allow an external root you control and have
reviewed.

## 7. Reversible agent patching

Preview removal of Syncora-owned markers:

```bash
node <installed-syncora-skill>/scripts/syncora.mjs unpatch-agents --workspace /absolute/path/to/project --dry-run
```

Run again without `--dry-run` to apply it. Unpatching preserves unrelated
instruction content and does not remove the Markdown graph.
