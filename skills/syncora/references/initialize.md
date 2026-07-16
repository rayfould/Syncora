# Initialize a workspace

Use initialization only after the user has authorized workspace mutation.
Installing the skill itself must remain inert.

## Preflight

1. Resolve the requested workspace as an absolute real path.
2. Run `doctor` first for an existing workspace.
3. If `local/` resolves outside the workspace through a symlink or junction,
   stop unless the user explicitly allowlists its exact resolved path.
4. Use `--dry-run` when adopting a workspace with existing graph or agent
   instruction files.

## Command

```text
node "<syncora-skill-root>/scripts/syncora.mjs" init --workspace <absolute-path>
```

Options:

- `--dry-run`: report planned changes without writing.
- `--format json`: return structured output.
- `--no-patch-agents`: initialize files without agent instruction hooks.
- `--allow-external-graph-root <absolute-path>`: allow exactly one resolved
  external graph root and record it in ignored machine-local state.

Initialization creates missing files only and patches supported agent files by
default. It does not overwrite existing graph notes, commit, push, install
dependencies, or change global agent configuration.

New configuration includes hybrid validation backstops of 50 completed
pre-work activations or 168 hours. Existing schema-v1 configuration remains
valid and receives those defaults in memory when the `maintenance` object is
absent. Malformed or unknown maintenance fields fail with `CONFIG001`.

The installed hook is relevance-gated v2. Initialization may safely upgrade a
tracked v1 hook under the same workspace patch lock used by `patch-agents`;
restoration snapshots are verified before any upgrade is published.

Run the same command again after initialization. A successful idempotency check
reports no changes.
