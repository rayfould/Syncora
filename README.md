# Syncora

[![Syncora Skill CI](https://github.com/rayfould/Syncora/actions/workflows/syncora-skill.yml/badge.svg)](https://github.com/rayfould/Syncora/actions/workflows/syncora-skill.yml)
[![skills.sh](https://skills.sh/b/rayfould/syncora)](https://skills.sh/rayfould/syncora)

Syncora is a local-first Agent Skill for durable, bounded project context. It
keeps plain Markdown as the source of truth while helping Codex, Cursor, and
Claude load the right project knowledge without pulling an entire knowledge
graph into every conversation.

> **Development preview.** The current package is the
> `v0.1.0-preview.2` release candidate; the latest public tag remains
> `v0.1.0-preview.1` until it is published. Preview.2 adds reviewed reversible
> adoption, task-specific context compilation, and governed capture. Automatic
> changed-file drift detection remains under development.

## Why Syncora

Long-running agent work usually fails in one of two directions:

- **Over-inclusion:** every note is loaded, wasting tokens and hiding the
  constraints that matter.
- **Over-compression:** summaries become so small that decisions, provenance,
  conflicts, and required constraints disappear.

Syncora's architecture uses one authoritative hub per scope, explicit note
authority, bounded retrieval, and visible provenance to balance those failure
modes. Current source implements the safe canonical read path and an explicit,
reviewed write path; it may maintain disposable derived runtime state.
Automatic drift detection and the remaining stable-release acceptance work are
still pending.

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
- compile task-specific context with typed targets, explicit modes, hard
  character budgets, mandatory/working/evidence lanes, and a source map;
- prepare immutable knowledge proposals without changing canonical Markdown;
- record an explicit approval or rejection bound to the exact proposal digest;
- apply approved proposals with optimistic concurrency, projected-graph
  validation, full-lifecycle graph serialization, exact receipts, foreground
  transaction recovery, and exact rollback before the irreversible commit
  boundary;
- inventory legacy Markdown in a dry-run, zero-authority migration phase;
- stage a reviewed v2 promotion manifest and exact target Markdown;
- shadow-test the proposed authority graph before canonical mutation;
- cut over, verify, retire predecessor activation, or restore exact
  pre-cutover bytes through a journaled migration lifecycle.

It does **not** yet perform automatic changed-file drift detection. The
task-context compiler is read-only with respect to canonical Markdown and
authority; compiling a pack never authorizes a note write. Governed capture is
a separate `capture` -> exact local artifact review -> `apply` lifecycle with
one explicit user approval boundary. Its default discovery path may update a disposable derived
lexical cache, and `--no-cache` prevents that cache write. The
[release status](docs/release-status.md) tracks this boundary explicitly.

To record a durable decision, you can simply tell your agent:

```text
Use $syncora to record this decision in the project knowledge graph.
```

The agent prepares a proposal and gives you the path and digest of an immutable
local review artifact containing the exact before/after text. Open that
artifact before answering the one approval question. The compact path and
impact summary is only a guide; nothing canonical changes until you approve the
artifact-bound proposal digest and the transactional apply succeeds.

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
node <installed-syncora-skill>/scripts/syncora.mjs context --workspace /absolute/path/to/project --intent "implement session expiry" --mode implement --target file:src/auth/session.ts --budget standard --format json
node <installed-syncora-skill>/scripts/syncora.mjs capture --workspace /absolute/path/to/project --input /absolute/path/to/proposal-input.json --format json
node <installed-syncora-skill>/scripts/syncora.mjs propose --workspace /absolute/path/to/project --proposal PROPOSAL_ID --format json
node <installed-syncora-skill>/scripts/syncora.mjs review --workspace /absolute/path/to/project --proposal PROPOSAL_ID --proposal-digest sha256:DIGEST --decision approve --reviewed-by user --reason "Approved after inspecting the exact immutable review artifact." --format json
node <installed-syncora-skill>/scripts/syncora.mjs apply --workspace /absolute/path/to/project --proposal PROPOSAL_ID --format json
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
ownership-aware rollback for files it patches. Governed apply recovers from
process interruption when a later foreground request reruns it; there are no
background workers.

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
