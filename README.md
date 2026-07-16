# Syncora

[![Syncora Skill CI](https://github.com/rayfould/Syncora/actions/workflows/syncora-skill.yml/badge.svg)](https://github.com/rayfould/Syncora/actions/workflows/syncora-skill.yml)
[![skills.sh](https://skills.sh/b/rayfould/syncora)](https://skills.sh/rayfould/syncora)

Syncora is a local-first Agent Skill for durable, bounded project context. It
keeps plain Markdown as the source of truth while helping Codex, Cursor, and
Claude load the right project knowledge without pulling an entire knowledge
graph into every conversation.

> **Development preview.** The latest public tag is `v0.1.0-preview.1`; current
> source adds a reviewed, reversible legacy-adoption lifecycle for the next
> preview. Bootstrap, validation, search, checkpoint, and reversible
> agent-patching are also usable. General context compilation remains under
> development. Governed capture and drift detection are too.

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

The Skills CLI keeps the canonical global skill at
`~/.agents/skills/syncora`. Codex and Cursor discover that shared standard
location directly; Claude Code receives the agent-specific link at
`~/.claude/skills/syncora`.

Or omit `--global` to install into the current project. If your environment
cannot create shared links, add `--copy`.

Installation is inert: it only installs the skill. For a new workspace without
an existing knowledge graph or predecessor agent workflow, ask your agent:

```text
Use $syncora to set up this workspace.
```

That explicit request authorizes the normal greenfield setup. Syncora runs one
`setup` command and patches supported project-level agent instruction files by
default; it does not add a mandatory preview-and-confirm cycle. Agent patching
is reversible and can be disabled during initialization.

For a workspace with existing Markdown knowledge that needs semantic authority
migration, do **not** initialize over it. Ask:

```text
Use $syncora to adopt this existing knowledge graph with the reversible migration workflow.
```

The skill prepares reviewed semantic files, seals them with one `bundle`
command, then applies the exact descriptor with one authorized `adopt` command.
No handwritten hashing script is required. Adoption stages exact v2 targets,
shadow-tests bounded fixtures, cuts over, verifies, and retires the predecessor
workflow. It resumes safely after interruption and retains rollback.
See [legacy knowledge graph adoption](docs/legacy-kg-adoption.md).

If there is no existing graph and only the exact supported predecessor marker
is present, ordinary `setup` replaces that marker atomically; no empty
migration bundle is required.

## What current source can do

- diagnose workspace and graph preconditions;
- initialize a hub-first Markdown knowledge graph;
- patch and unpatch Codex, Cursor, and Claude project instructions;
- validate frontmatter, graph structure, authority, containment, and state;
- search with bounded deterministic output;
- inspect backlinks without granting authority;
- run foreground checkpoint decisions and maintain bounded local state;
- inventory legacy Markdown in a dry-run, zero-authority migration phase;
- stage a reviewed v2 promotion manifest and exact target Markdown;
- shadow-test the proposed authority graph before canonical mutation;
- cut over, verify, retire predecessor activation, or restore exact
  pre-cutover bytes through a journaled migration lifecycle.

It does **not** yet compile general task context packs, provide governed capture,
or perform changed-file drift detection. The adoption-only
shadow compiler and migration transaction do not imply those general
capabilities. The [release status](docs/release-status.md) tracks this boundary
explicitly.

## Direct runtime use

Agent Skills should normally invoke the bundled runtime. Maintainers and
advanced users can call it directly from the installed skill root:

```bash
node <installed-syncora-skill>/scripts/syncora.mjs --help
node <installed-syncora-skill>/scripts/syncora.mjs doctor --workspace /absolute/path/to/project
node <installed-syncora-skill>/scripts/syncora.mjs setup --workspace /absolute/path/to/project
node <installed-syncora-skill>/scripts/syncora.mjs bundle --help
node <installed-syncora-skill>/scripts/syncora.mjs adopt --workspace /absolute/path/to/project --bundle /absolute/path/to/review/adoption-bundle-v1.json
node <installed-syncora-skill>/scripts/syncora.mjs validate --workspace /absolute/path/to/project
node <installed-syncora-skill>/scripts/syncora.mjs migrate --help
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
Resolve or intentionally retain any migration recovery journal before removal.
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

To exercise the complete installed-copy legacy-adoption lifecycle:

```bash
npm run smoke:adoption
```

The runtime has no third-party production dependencies. Contributions should
follow [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
