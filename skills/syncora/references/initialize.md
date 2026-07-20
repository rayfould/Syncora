# Initialize a greenfield workspace

Use initialization only after the user has authorized workspace mutation.
An explicit request to set up Syncora in the current workspace is that
authorization; do not add a mandatory dry-run or second approval. Installing
the skill itself must remain inert.

`setup` is not an import or upgrade path. It may be rerun idempotently in a
workspace Syncora already initialized. If an uninitialized workspace already
contains knowledge under `local/`, stop and use
[legacy-adoption.md](legacy-adoption.md). The runtime fails this case with
`MIGRATE015` rather than mixing old and new authority. If no graph exists and
an agent file contains the exact supported predecessor marker, `setup` replaces
that marker atomically while preserving unrelated instructions; do not combine
that transition with `--no-patch-agents`. `init` remains an expert alias for
compatibility.

If no graph exists but an instruction file appears to contain a custom or
unmarked predecessor activation, `setup` fails with `MIGRATE015`. Inspect every
active Codex, Cursor, and Claude instruction file, remove that activation, then
run one `setup --confirm-predecessor-reviewed` command. The skill may pass this
compatibility flag after its own complete inspection; do not ask the user for a
second confirmation. The flag does not find or delete custom instructions.

## Preflight

1. Resolve the requested workspace as an absolute real path.
2. If `local/` resolves outside the workspace through a symlink or junction,
   stop unless the user explicitly allowlists its exact resolved path.
3. Run `setup` once after the user authorizes initialization. Use
   `setup --dry-run` only when the user requests a preview or workspace risk
   warrants one. A legacy-graph finding means this is not greenfield; prepare a
   reviewed manifest, staged targets, and fixtures, then switch to the
   reviewed-pack `adopt` summary and internally digest-bound final invocation.

## Command

```text
node "<syncora-skill-root>/scripts/syncora.mjs" setup --workspace <absolute-path>
```

Options:

- `--dry-run`: report planned changes without writing.
- `--format json`: return structured output.
- `--no-patch-agents`: initialize files without agent instruction hooks.
- `--confirm-predecessor-reviewed`: use only after reviewing every active agent
  instruction file and removing custom or unmarked predecessor activation.
- `--allow-external-graph-root <absolute-path>`: allow exactly one resolved
  external graph root and record it in ignored machine-local state.

Initialization creates missing files only and patches supported agent files by
default. It does not overwrite existing graph notes, commit, push, install
dependencies, or change global agent configuration.

New configuration includes hybrid validation backstops of 50 completed
pre-work activations or 168 hours. Existing schema-v1 configuration remains
valid and receives those defaults in memory when the `maintenance` object is
absent. Malformed or unknown maintenance fields fail with `CONFIG001`.

The installed relevance-gated hook v6 teaches autonomous transactional capture
with internal exact authorization plus foreground changed-source drift routing.
Initialization may safely upgrade a tracked v1, v2, v3, v4, or v5 hook under the same workspace patch lock
used by `patch-agents`; restoration snapshots are verified before any upgrade
is published.
If initialization opted out of hooks, a later `patch-agents` call still refuses
to write while predecessor activation remains outside Syncora-owned markers;
confirmation never overrides that gate.

Run the same command again after initialization. A successful idempotency check
reports no changes.
