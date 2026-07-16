# Syncora

Syncora is a local-first Agent Skill for durable, bounded project context. It
keeps plain Markdown as the source of truth while helping Codex, Cursor, and
Claude load the right project knowledge without pulling an entire knowledge
graph into every conversation.

> **Development preview — `v0.1.0-preview.1`.** The bootstrap, validation,
> search, checkpoint, migration-inventory, and reversible agent-patching
> surfaces are usable today. Budgeted context compilation, governed capture,
> manifest application, and drift detection are still under development.

## Why Syncora

Long-running agent work usually fails in one of two directions:

- **Over-inclusion:** every note is loaded, wasting tokens and hiding the
  constraints that matter.
- **Over-compression:** summaries become so small that decisions, provenance,
  conflicts, and required constraints disappear.

Syncora's architecture uses one authoritative hub per scope, explicit note
authority, bounded retrieval, and provenance-bearing changes to balance those
failure modes. The preview already establishes the safe local foundation; the
full context-control loop remains the stable-release target.

## Requirements

- Node.js 22 or 24
- Codex, Cursor, or Claude Code
- Git is recommended but not required at runtime

## Install

Install globally for all three supported agents:

```bash
npx skills add rayfould/Syncora --skill syncora --global --agent codex --agent cursor --agent claude-code --yes
```

Or omit `--global` to install into the current project. If your environment
cannot create shared links, add `--copy`.

Installation is inert: it only installs the skill. To initialize a workspace,
ask your agent:

```text
Use $syncora to initialize this workspace.
```

Syncora previews its plan, asks before project mutation, and patches supported
project-level agent instruction files by default. Agent patching is reversible
and can be disabled during initialization.

## What the preview can do

- diagnose workspace and graph preconditions;
- initialize a hub-first Markdown knowledge graph;
- patch and unpatch Codex, Cursor, and Claude project instructions;
- validate frontmatter, graph structure, authority, containment, and state;
- search with bounded deterministic output;
- inspect backlinks without granting authority;
- run foreground checkpoint decisions and maintain bounded local state;
- inventory legacy Markdown in a dry-run, zero-authority migration phase.

It does **not** yet compile full task context packs, accept or apply promotion
manifests, govern canonical writes, or perform changed-file drift detection.
The [release status](docs/release-status.md) tracks this boundary explicitly.

## Direct runtime use

Agent Skills should normally invoke the bundled runtime. Maintainers and
advanced users can call it directly from the installed skill root:

```bash
node <installed-syncora-skill>/scripts/syncora.mjs --help
node <installed-syncora-skill>/scripts/syncora.mjs doctor --workspace /absolute/path/to/project
node <installed-syncora-skill>/scripts/syncora.mjs init --workspace /absolute/path/to/project --dry-run
node <installed-syncora-skill>/scripts/syncora.mjs validate --workspace /absolute/path/to/project
```

Use an absolute workspace path for every mutating command. See the
[getting-started guide](docs/getting-started.md) for the full workflow.

## Update and uninstall

```bash
npx skills update syncora --global
```

Before removing the skill, ask Syncora to unpatch the workspace so its owned
agent-instruction markers are removed safely. Then uninstall it:

```bash
npx skills remove syncora --global --agent '*' --yes
```

Removing the skill never deletes a workspace's canonical `local/` Markdown.
See [upgrade and uninstall](docs/upgrade-and-uninstall.md) for details.

## Safety model

Syncora treats Markdown as untrusted data, resolves real paths before mutation,
fails closed on external graph roots, bounds reads and output, and uses
ownership-aware rollback for files it patches. There are no background workers:
all work runs visibly during an agent turn.

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

The runtime has no third-party production dependencies. Contributions should
follow [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
