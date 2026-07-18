import { SyncoraError } from "./cli.mjs";
import {
  readActiveFileTransaction,
  readFileTransaction,
} from "./file-transaction.mjs";
import { withPatchLock } from "./patch-lock.mjs";
import {
  requireInitializedWorkspace,
  resolveGraphContext,
  resolveWorkspace,
  samePath,
} from "./workspace.mjs";

// A committed transaction remains blocking until its immutable receipt has
// been published and finalize releases the marker. In particular,
// finalized-pending-receipt is deliberately not terminal here.
const TERMINAL_TRANSACTION_STATES = new Set(["finalized", "rolled-back"]);
const ACTIVE_READ_CAPABILITIES = new WeakMap();

function interlockError(message, details = undefined) {
  return new SyncoraError("WRITE007", message, details);
}

async function resolveReadRoots(options) {
  const workspace = await resolveWorkspace(options.workspace);
  await requireInitializedWorkspace(workspace.realPath);
  const graph = await resolveGraphContext(workspace, {
    allowExternalGraphRoot: options.allowExternalGraphRoot,
  });
  return Object.freeze({
    workspacePath: workspace.realPath,
    graphRoot: graph.resolvedGraphPath,
  });
}

function assertSameRoots(expected, actual) {
  if (
    !samePath(expected.workspacePath, actual.workspacePath) ||
    !samePath(expected.graphRoot, actual.graphRoot)
  ) {
    throw interlockError(
      "Workspace or graph root changed after the canonical read lock was selected.",
      { expected, actual },
    );
  }
}

function assertReadCapability(capability, roots) {
  const held = capability !== null && typeof capability === "object"
    ? ACTIVE_READ_CAPABILITIES.get(capability)
    : undefined;
  if (!held) {
    throw interlockError("An active canonical read capability is required.");
  }
  assertSameRoots(held, roots);
}

/**
 * Inspect the generic writer marker while the caller holds the graph patch lock.
 * A terminal journal can leave a short-lived stale marker, which is safe for
 * readers and will be cleaned by the transaction runtime. Missing or mismatched
 * recovery evidence fails closed.
 */
export async function assertNoNonterminalFileTransaction(graphRoot) {
  const active = await readActiveFileTransaction(graphRoot);
  if (!active) return null;

  const journal = await readFileTransaction({
    graphRoot,
    transactionId: active.transactionId,
  });
  if (!journal) {
    throw interlockError(
      "Canonical graph access is blocked by an active transaction without a recovery journal.",
      { transactionId: active.transactionId, status: "journal-missing" },
    );
  }
  if (
    journal.transactionDigest !== active.transactionDigest ||
    journal.rootIdentity !== active.rootIdentity ||
    journal.planSha256 !== active.planSha256
  ) {
    throw interlockError(
      "Canonical graph access is blocked by an active transaction with mismatched recovery evidence.",
      { transactionId: active.transactionId, status: journal.status },
    );
  }
  if (TERMINAL_TRANSACTION_STATES.has(journal.status)) {
    return Object.freeze({ active, journal, blocking: false });
  }
  throw interlockError(
    `Canonical graph access is blocked while transaction ${active.transactionId} is ${journal.status}.`,
    { transactionId: active.transactionId, status: journal.status },
  );
}

/**
 * Serialize a context-producing graph read with canonical writers. Nested
 * readers reuse an unforgeable in-process capability instead of reacquiring
 * the non-reentrant graph lock.
 */
export async function withCanonicalReadInterlock(
  options,
  operation,
  capability = undefined,
) {
  const roots = await resolveReadRoots(options);
  if (capability !== undefined) {
    assertReadCapability(capability, roots);
    return operation(capability);
  }

  return withPatchLock(roots.graphRoot, async () => {
    const lockedRoots = await resolveReadRoots(options);
    assertSameRoots(roots, lockedRoots);
    await assertNoNonterminalFileTransaction(lockedRoots.graphRoot);
    const activeCapability = Object.freeze({});
    ACTIVE_READ_CAPABILITIES.set(activeCapability, lockedRoots);
    try {
      return await operation(activeCapability);
    } finally {
      ACTIVE_READ_CAPABILITIES.delete(activeCapability);
    }
  });
}
