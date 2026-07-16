# Getting started

This guide initializes Syncora in one project and verifies the result. Syncora
has no background service: every command runs synchronously during an agent
turn or direct CLI invocation.

## 1. Install the skill

From any directory, install Syncora for the agents you use:

```bash
npx skills add rayfould/Syncora --skill syncora --global --agent codex --agent cursor --agent claude-code --yes
```

Remove agent flags you do not need. Use `--copy` if shared links are not
available on the machine.

## 2. Initialize a project

Open the target project in your agent and say:

```text
Use $syncora to initialize this workspace.
```

The skill should inspect the project, preview the mutation, and ask for approval
before writing. Initialization creates a `local/` Markdown graph and patches
supported project-level instruction files by default. Use
`--no-patch-agents` when invoking the runtime directly if you want the graph
without persistent agent hooks.

For a direct dry run:

```bash
node <installed-syncora-skill>/scripts/syncora.mjs init --workspace /absolute/path/to/project --dry-run
```

Then rerun without `--dry-run` after reviewing the plan.

## 3. Verify the workspace

```bash
node <installed-syncora-skill>/scripts/syncora.mjs doctor --workspace /absolute/path/to/project
node <installed-syncora-skill>/scripts/syncora.mjs validate --workspace /absolute/path/to/project
```

The initialized graph routes through `local/index.md`. Canonical project facts,
decisions, and concepts remain plain Markdown; generated `.syncora/` state is
disposable and should not be treated as knowledge.

## 4. Normal use

The small project instruction hook tells the agent when Syncora is relevant.
Trivial or unrelated requests can bypass it. Relevant work uses foreground
checkpoint decisions and bounded retrieval; no timer or worker runs between
messages.

The development preview supports bounded search, backlinks, validation, and
checkpoint policy. The complete task context compiler and governed write path
are not implemented yet. See [release status](release-status.md).

## 5. External graph roots

Syncora rejects a `local/` path that resolves outside the workspace unless the
exact resolved root is explicitly allowlisted. This protects against unexpected
symlink or junction mutation. Only allow an external root you control and have
reviewed.

## 6. Reversible agent patching

Preview removal of Syncora-owned markers:

```bash
node <installed-syncora-skill>/scripts/syncora.mjs unpatch-agents --workspace /absolute/path/to/project --dry-run
```

Run again without `--dry-run` to apply it. Unpatching preserves unrelated
instruction content and does not remove the Markdown graph.
