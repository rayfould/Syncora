# Getting started

This guide covers the public Syncora workflow. The agent handles the bundled
runtime; you should not need to learn its internal commands.

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

## 2. Set up a project

Open the target project in your agent and say:

```text
Set up Syncora in this project.
```

One request initializes the `local/` Markdown graph, adds the small supported
project instruction hooks, and establishes the starting foreground drift
observation when eligible sources exist. Setup can be rerun safely and does not
require a preview-and-confirm cycle.

Installing the skill alone never initializes a project.

## 3. Work normally

Ask for project work normally:

```text
Review the authentication flow and fix the session expiry bug.
```

The project hook lets the agent decide whether Syncora is relevant. Relevant
work receives bounded context from current project knowledge. Trivial or
self-contained requests bypass it. Nothing runs between messages or after the
agent's response.

When work creates a durable decision or changes a source-bound truth, Syncora
validates and saves it automatically before the agent finishes. It keeps exact
review artifacts, receipts, and rollback evidence internally without asking
whether to save. Internal proposal, checkpoint, and apply commands are expert
inspection and recovery tools, not part of the public workflow.

The agent also does not ask for approval merely because an implementation is
large. It pauses only for a real unresolved project decision, a plan-only
request that did not authorize implementation, an unapproved external effect,
required host permission, or a destructive weakly reversible action over broad
data whose exact scope was not authorized.

## 4. Update, repair, or remove

```text
Update Syncora.
Repair Syncora in this project.
Remove Syncora from this project.
```

Update means updating the installed skill, not migrating the graph. Repair
starts with diagnosis and uses only the affected subsystem. Removing Syncora
from a project unpatches Syncora-owned agent instructions and preserves
`local/`. See [Upgrade and uninstall](upgrade-and-uninstall.md) for manual
fallbacks.

## 5. Existing knowledge graphs

If the project already has a Markdown knowledge graph or predecessor agent
memory workflow, do not initialize over it. Say:

```text
Adopt this existing knowledge graph into Syncora.
```

That single request authorizes the complete reviewed conversion. Syncora inventories
the old graph, validates and seals the replacement internally, then migrates,
verifies, switches agent instructions, and retires the old
workflow while preserving source notes and rollback evidence. See
[Legacy knowledge graph adoption](legacy-kg-adoption.md).

## Safety notes

Syncora rejects a `local/` path that resolves outside the workspace unless the
exact resolved root is explicitly allowlisted. This protects against unexpected
symlink or junction mutation. Only allow an external root you control and have
reviewed. Keep preview workspaces under Git or another backup. Removing the
project integration preserves unrelated instruction content and does not
remove the Markdown graph.
