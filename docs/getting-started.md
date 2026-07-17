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
supported project-level instruction files by default. Use
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
state is noncanonical and rebuildable outside active operations; it should not
be treated as knowledge.

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
material is omitted whole and reported in the source map. Governed note capture
and changed-file drift detection are not implemented yet. See
[release status](release-status.md).

Use JSON when an agent needs the complete lanes and a bounded structured source
map with totals and truncation signals. The default text form prints the
bounded context plus a compact human-readable summary. Context compilation
never changes canonical Markdown; unless `--no-cache` is used, it may update a
disposable derived lexical cache.

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
