import { isAbsolute } from "node:path";

import { SyncoraError } from "./cli.mjs";
import { withPatchLock } from "./patch-lock.mjs";
import {
  resolveGraphContext,
  resolveWorkspace,
  samePath,
} from "./workspace.mjs";

const ACTIVE_MIGRATION_LOCK_CAPABILITIES = new WeakMap();

function migrationLockError(message, details = undefined) {
  return new SyncoraError("MIGRATE007", message, details);
}

function assertLockRootsShape(value, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof value.workspacePath !== "string" ||
    value.workspacePath.length === 0 ||
    !isAbsolute(value.workspacePath) ||
    typeof value.graphRoot !== "string" ||
    value.graphRoot.length === 0 ||
    !isAbsolute(value.graphRoot)
  ) {
    throw migrationLockError(`${label} must contain resolved workspacePath and graphRoot values.`);
  }
  if (samePath(value.workspacePath, value.graphRoot)) {
    throw migrationLockError(
      `${label} must identify distinct workspace and graph directories.`,
    );
  }
  return value;
}

/**
 * Resolve the exact real workspace and graph roots used by migration locks.
 * Composite operations must resolve once, acquire these roots, and pass the
 * same object through the lifecycle execution channel.
 */
export async function resolveMigrationLockRoots(options) {
  const workspace = await resolveWorkspace(options.workspace);
  const graph = await resolveGraphContext(workspace, {
    allowExternalGraphRoot: options.allowExternalGraphRoot,
  });
  return Object.freeze(assertLockRootsShape({
    workspacePath: workspace.realPath,
    graphRoot: graph.resolvedGraphPath,
  }, "Resolved migration lock roots"));
}

/**
 * Fail closed unless the currently resolved roots exactly match the roots
 * already held by an outer migration operation.
 */
export function assertMigrationLockRoots(expected, actual) {
  assertLockRootsShape(expected, "Expected migration lock roots");
  assertLockRootsShape(actual, "Current migration lock roots");
  if (
    !samePath(expected.workspacePath, actual.workspacePath) ||
    !samePath(expected.graphRoot, actual.graphRoot)
  ) {
    throw migrationLockError(
      "Workspace or graph root changed after migration locks were selected.",
      { expected, actual },
    );
  }
  return actual;
}

/**
 * Prove that a caller is executing inside the exact migration locks it claims
 * to hold. Root-shaped objects are intentionally insufficient: only
 * withMigrationLocks can activate a capability, and the capability expires as
 * soon as its callback settles.
 */
export function assertMigrationLockCapability(capability, actual) {
  const lockedRoots =
    capability !== null && typeof capability === "object"
      ? ACTIVE_MIGRATION_LOCK_CAPABILITIES.get(capability)
      : undefined;
  if (
    lockedRoots === undefined
  ) {
    throw migrationLockError(
      "An active migration lock capability is required to reuse outer locks.",
    );
  }
  return assertMigrationLockRoots(lockedRoots, actual);
}

export function readMigrationLockCapability(execution = {}) {
  if (
    execution !== null &&
    typeof execution === "object" &&
    Object.prototype.hasOwnProperty.call(execution, "lockRoots")
  ) {
    throw migrationLockError(
      "Raw migration lock roots cannot authorize an unlocked lifecycle call.",
    );
  }
  return execution?.lockCapability;
}

// Reuse the hardened filesystem lock protocol at two distinct roots. The graph
// lock serializes every worktree that shares an external graph; the workspace
// lock serializes agent-file and runtime-state changes. Always acquire them in
// this order to avoid cross-worktree lock inversion.
export async function withMigrationLocks(
  { workspacePath, graphRoot },
  operation,
  options = {},
) {
  const roots = Object.freeze(assertLockRootsShape(
    { workspacePath, graphRoot },
    "Migration lock roots",
  ));
  const capability = Object.freeze({});
  return withPatchLock(
    graphRoot,
    () => withPatchLock(workspacePath, async () => {
      ACTIVE_MIGRATION_LOCK_CAPABILITIES.set(capability, roots);
      try {
        return await operation(capability);
      } finally {
        ACTIVE_MIGRATION_LOCK_CAPABILITIES.delete(capability);
      }
    }, options.workspaceLock),
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
