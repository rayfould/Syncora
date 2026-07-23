# Syncora

[![Syncora Skill CI](https://github.com/rayfould/Syncora/actions/workflows/syncora-skill.yml/badge.svg)](https://github.com/rayfould/Syncora/actions/workflows/syncora-skill.yml)
[![skills.sh](https://skills.sh/b/rayfould/syncora)](https://skills.sh/rayfould/syncora)

Syncora gives Codex, Cursor, and Claude durable project memory without stuffing
every old note into every conversation. It keeps project knowledge in local
Markdown, loads only what a task needs, and gives each project or work area one
clear home for current truth.

> **Development preview.** The current public release is
> `v0.1.0-preview.2`. Use it in a Git repository or another recoverable
> workspace while stable-release acceptance remains in progress.

## Why Syncora

Long-running agent work usually fails in one of two directions:

- **Over-inclusion:** every note is loaded, wasting tokens and hiding the
  constraints that matter.
- **Over-compression:** summaries become so small that decisions, provenance,
  conflicts, and required constraints disappear.

Syncora uses one authoritative hub per scope, typed note authority, bounded
retrieval, and visible provenance. Mandatory context must fit or fail visibly;
optional material is omitted whole and reported rather than silently chopped.

## Requirements

- Node.js 22 or 24
- Codex, Cursor, or Claude Code
- Git is recommended but not required at runtime

## Install

Install globally for all three supported agents:

```bash
npx skills add rayfould/Syncora --skill syncora --global --agent codex --agent cursor --agent claude-code --yes
```

The Skills CLI keeps the canonical global skill at
`~/.agents/skills/syncora`. Codex and Cursor discover that shared standard
location directly; Claude Code receives the agent-specific link at
`~/.claude/skills/syncora`.

Or omit `--global` to install into the current project. If your environment
cannot create shared links, add `--copy`.

Installation is inert. It does not touch any project until you ask.

## Use Syncora

You use Syncora by talking to your coding agent. The agent handles the bundled
runtime internally.

### Set it up

Open a project and say:

```text
Set up Syncora in this project.
```

That single request creates the local Markdown graph and patches the supported
project agent instructions. Setup is idempotent and does not add a mandatory
preview-and-confirm ceremony.

### Work normally

After setup, just ask for project work:

```text
Review the authentication flow and fix the session expiry bug.
```

When the request depends on project decisions, constraints, status, or history,
Syncora supplies a bounded task-specific context pack. Self-contained requests,
such as asking the date or translating supplied text, bypass Syncora.

During relevant work it can find authoritative notes, save durable
changes, flag knowledge that may be stale after source changes, and recover an
interrupted Syncora write on a later foreground request. There is no timer,
watcher, daemon, or background worker.

Syncora does not add approval prompts to normal project work. Your agent asks
only when the project action itself needs a real choice: for example, you asked
for a plan but not implementation, the request is materially ambiguous, or an
unauthorized destructive or external action would follow. A long diff or an
important memory update is not, by itself, a reason to stop.

### Maintain it

Use the same plain language for maintenance:

```text
Update Syncora.
Repair Syncora in this project.
Remove Syncora from this project.
```

- **Update** installs the newest compatible skill release. It is not a graph
  migration.
- **Repair** diagnoses the workspace and fixes only the affected Syncora
  subsystem while preserving canonical Markdown.
- **Remove from this project** removes Syncora-owned agent instructions but
  preserves `local/` and version-control history.

To uninstall the global skill as well, say `Uninstall Syncora globally.`

## Existing project knowledge

If a project already has a Markdown knowledge graph or a predecessor agent
memory workflow, ask:

```text
Adopt this existing knowledge graph into Syncora.
```

This one request owns the complete conversion. Syncora inventories the old
graph, consolidates current truth into one workspace home with one
non-competing hub per active workstream, internally validates and seals that
replacement, then migrates the notes, verifies the new authority graph,
switches the agent instructions, and retires the predecessor workflow. Old
project pages remain evidence instead of parallel owners. Source notes and
rollback evidence are preserved. See
[legacy knowledge graph adoption](docs/legacy-kg-adoption.md).

## Current boundaries

The preview includes setup, reversible agent patching, validation, search,
backlinks, task-specific context compilation, autonomous transactional capture, foreground
drift detection, legacy adoption, rollback, and transaction recovery.

Automatic drift coverage supports exact `file`, `module`, and `path_glob`
bindings. `symbol` and `component` bindings remain explicitly unevaluated until
Syncora has a real versioned symbol index. A finding means only "potentially
stale" and cannot rewrite a note or grant authority.

The [release status](docs/release-status.md) tracks the remaining stable-release
acceptance gates.

## Maintainers and advanced use

Normal users should not need Syncora's command surface. Maintainers can inspect
the bundled runtime with:

```bash
node <installed-syncora-skill>/scripts/syncora.mjs --help
```

The installed skill's references define setup, activation, context, capture,
drift, recovery, validation, and agent-patching contracts. See the
[getting-started guide](docs/getting-started.md) for the public workflow and
[upgrade and uninstall](docs/upgrade-and-uninstall.md) for manual fallbacks.

## Safety model

Syncora treats Markdown as untrusted data, resolves real paths before mutation,
fails closed on external graph roots, bounds reads and output, and uses
ownership-aware rollback for files it patches. Governed apply recovers from
process interruption when a later foreground request reruns it; there are no
background workers.

Drift observations, findings, refresh work, proposal bindings, and
acknowledgments are noncanonical state beneath the resolved graph. They are
sharded by exact workspace identity, so worktrees sharing an external graph do
not share a baseline or changed-source observations. Corrupt, future-version,
oversized, or identity-mismatched drift state fails closed instead of silently
resetting history.

Syncora serializes its own graph writers and rechecks exact bytes before atomic
replacement. A noncooperating external process can still race the final
check-and-rename window, and Node does not provide a portable Windows
directory-fsync guarantee for power loss. Keep canonical Markdown under Git or
another backup when testing the preview.

Read [SECURITY.md](SECURITY.md) before testing hostile paths or content.

## Development

```bash
npm ci
npm run check
```

To exercise the real Skills CLI installer in a disposable workspace:

```bash
npm run smoke:install
```

To exercise the complete installed-copy legacy-adoption lifecycle:

```bash
npm run smoke:adoption
```

The runtime has no third-party production dependencies. Contributions should
follow [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
