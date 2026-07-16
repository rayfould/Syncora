import { SyncoraError } from "./cli.mjs";
import { withPatchLock } from "./patch-lock.mjs";
import { samePath } from "./workspace.mjs";

// Reuse the hardened filesystem lock protocol at two distinct roots. The graph
// lock serializes every worktree that shares an external graph; the workspace
// lock serializes agent-file and runtime-state changes. Always acquire them in
// this order to avoid cross-worktree lock inversion.
export async function withMigrationLocks(
  { workspacePath, graphRoot },
  operation,
  options = {},
) {
  if (samePath(workspacePath, graphRoot)) {
    throw new SyncoraError(
      "MIGRATE007",
      "Migration lock roots must identify distinct workspace and graph directories.",
    );
  }
  return withPatchLock(
    graphRoot,
    () => withPatchLock(workspacePath, operation, options.workspaceLock),
    options.graphLock,
  );
}

export async function withMigrationGraphLock(
  graphRoot,
  operation,
  options = {},
) {
  return withPatchLock(graphRoot, operation, options);
}
