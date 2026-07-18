import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  authorityPolicyRevision,
  authorityRootIdentity,
} from "./authority-inventory.mjs";
import { SyncoraError } from "./cli.mjs";
import {
  FILE_TRANSACTION_DURABILITY,
  FILE_TRANSACTION_POLICY,
} from "./file-transaction.mjs";
import { withMigrationGraphLock } from "./migration-lock.mjs";
import {
  MIGRATION_STATUSES,
  migrationPaths,
  readMigrationState,
  workspaceIdentity,
} from "./migration-state.mjs";
import { withPatchLock } from "./patch-lock.mjs";
import { PROJECTED_GRAPH_POLICY } from "./projected-graph.mjs";
import {
  PROPOSAL_OPERATION_KINDS,
  PROPOSAL_POLICY,
  PROPOSAL_SCHEMA_VERSION,
  assertPortableGraphPath,
  assertPortableWorkspacePath,
  canonicalProposalJson,
} from "./proposal-schema.mjs";
import { PROPOSAL_SEMANTICS_POLICY } from "./proposal-semantics.mjs";
import { REVIEW_ARTIFACT_POLICY } from "./review-artifact-policy.mjs";
import { createStableDirectoryGuard } from "./stable-directory.mjs";
import { VALIDATION_SPECIFICATION } from "./validate.mjs";
import {
  isWithin,
  readBoundedRegularFileIfPresent,
  requireInitializedWorkspace,
  resolveGraphContext,
  resolveWorkspace,
  samePath,
} from "./workspace.mjs";

const MAXIMUM_MIGRATION_DIRECTORIES = 1_024;
const TERMINAL_MIGRATION_STATUSES = new Set(["retired", "rolled-back"]);

export const GOVERNED_WRITE_POLICY = Object.freeze({
  specification: "syncora-governed-write-policy-v1",
  validationSpecification: VALIDATION_SPECIFICATION,
  authorityPolicyRevision: authorityPolicyRevision(),
  proposalSchemaVersion: PROPOSAL_SCHEMA_VERSION,
  proposalOperationKinds: PROPOSAL_OPERATION_KINDS,
  proposal: PROPOSAL_POLICY,
  semantics: PROPOSAL_SEMANTICS_POLICY,
  projectedGraph: PROJECTED_GRAPH_POLICY,
  fileTransaction: FILE_TRANSACTION_POLICY,
  fileTransactionDurability: FILE_TRANSACTION_DURABILITY,
  reviewArtifact: REVIEW_ARTIFACT_POLICY,
});

export function governedPolicyRevision() {
  return `sha256:${createHash("sha256")
    .update(`${GOVERNED_WRITE_POLICY.specification}\n`, "utf8")
    .update(canonicalProposalJson(GOVERNED_WRITE_POLICY), "utf8")
    .digest("hex")}`;
}

function writeError(code, message, details = undefined) {
  return new SyncoraError(code, message, details);
}

async function metadataIfPresent(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function resolveGovernedEnvironment(options) {
  const workspace = await resolveWorkspace(options.workspace);
  await requireInitializedWorkspace(workspace.realPath);
  const graph = await resolveGraphContext(workspace, {
    allowExternalGraphRoot: options.allowExternalGraphRoot,
  });
  return Object.freeze({
    workspace,
    graph,
    workspacePath: workspace.realPath,
    graphRoot: graph.resolvedGraphPath,
    workspaceIdentity: workspaceIdentity(workspace.realPath),
    graphRootIdentity: authorityRootIdentity(graph.resolvedGraphPath),
    policyRevision: governedPolicyRevision(),
    validationSpecification: VALIDATION_SPECIFICATION,
  });
}

function assertSameEnvironment(expected, current) {
  if (
    !samePath(expected.workspacePath, current.workspacePath) ||
    !samePath(expected.graphRoot, current.graphRoot) ||
    expected.workspaceIdentity !== current.workspaceIdentity ||
    expected.graphRootIdentity !== current.graphRootIdentity
  ) {
    throw writeError(
      "WRITE002",
      "Workspace or resolved graph identity changed while selecting the governance lock.",
    );
  }
}

export async function withGovernedGraphLock(options, operation, lockOptions = {}) {
  const selected = await resolveGovernedEnvironment(options);
  return withMigrationGraphLock(
    selected.graphRoot,
    async () => {
      const current = await resolveGovernedEnvironment(options);
      assertSameEnvironment(selected, current);
      return operation(current);
    },
    lockOptions,
  );
}

/**
 * Serialize the complete governed-apply lifecycle, not merely its individual
 * canonical file operations. This keeps concurrent invocations for the same
 * graph from interleaving rollback, commit, and receipt recovery decisions.
 */
export async function withGovernedApplyLock(
  options,
  operation,
  lockOptions = {},
) {
  const selected = await resolveGovernedEnvironment(options);
  return withPatchLock(selected.graphRoot, async () => {
    const current = await resolveGovernedEnvironment(options);
    assertSameEnvironment(selected, current);
    return operation(current);
  }, {
    ...lockOptions,
    lockName: "governed-apply.lock",
  });
}

export async function readProposalInputFile(path) {
  if (typeof path !== "string" || !isAbsolute(path)) {
    throw writeError(
      "PROPOSAL001",
      "Proposal input path must be absolute.",
    );
  }
  const parent = dirname(path);
  let resolvedParent;
  try {
    resolvedParent = await realpath(parent);
  } catch (error) {
    throw writeError("PROPOSAL001", "Proposal input parent is unavailable.", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (!samePath(parent, resolvedParent)) {
    throw writeError(
      "PROPOSAL001",
      "Proposal input parent resolves through an unsafe alias.",
    );
  }
  const guard = createStableDirectoryGuard(parent, parent, {
    code: "PROPOSAL001",
    label: "Proposal input directory",
  });
  await guard.prepare();
  const bytes = await readBoundedRegularFileIfPresent(path, {
    containmentRoot: parent,
    maximumBytes: PROPOSAL_POLICY.maximumInputBytes,
    code: "PROPOSAL001",
    label: "Proposal input",
    beforeOpen: () => guard.assert(),
    beforeHandleOpen: () => guard.assert(),
    afterRead: () => guard.assert(),
  });
  if (bytes === null) {
    throw writeError("PROPOSAL001", "Proposal input file does not exist.");
  }
  return bytes;
}

function boundedReadLimit(value, fallback, ceiling, label) {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > ceiling) {
    throw writeError("WRITE001", `${label} byte limit is invalid.`);
  }
  return limit;
}

export async function readCanonicalNoteBytes(
  environment,
  graphRelativePath,
  options = {},
) {
  const portablePath = assertPortableGraphPath(graphRelativePath);
  const maximumBytes = boundedReadLimit(
    options.maximumBytes,
    PROPOSAL_POLICY.maximumNoteBytes,
    PROPOSAL_POLICY.maximumNoteBytes,
    "Canonical note read",
  );
  const readCode = options.code ?? "WRITE002";
  const readLabel = options.label ?? "Canonical note";
  const absolutePath = join(environment.graphRoot, ...portablePath.split("/"));
  const parent = dirname(absolutePath);
  const parentMetadata = await metadataIfPresent(parent);
  if (parentMetadata === null) return null;
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
    throw writeError("WRITE002", `Canonical note parent is unsafe: ${portablePath}`);
  }
  const resolvedParent = await realpath(parent);
  if (
    !samePath(resolvedParent, parent) ||
    !isWithin(environment.graphRoot, resolvedParent)
  ) {
    throw writeError("WRITE002", `Canonical note parent escapes the graph: ${portablePath}`);
  }
  const guard = createStableDirectoryGuard(environment.graphRoot, parent, {
    code: "WRITE002",
    label: "Canonical note directory",
  });
  await guard.prepare();
  return readBoundedRegularFileIfPresent(absolutePath, {
    containmentRoot: parent,
    maximumBytes,
    code: readCode,
    label: readLabel,
    beforeOpen: () => guard.assert(),
    beforeHandleOpen: () => guard.assert(),
    afterRead: () => guard.assert(),
  });
}

export async function readWorkspaceSourceBytes(
  environment,
  workspaceRelativePath,
  options = {},
) {
  const portablePath = assertPortableWorkspacePath(
    workspaceRelativePath,
    "Workspace source ref",
  );
  const maximumBytes = boundedReadLimit(
    options.maximumBytes,
    PROPOSAL_POLICY.maximumSourceFileBytes,
    PROPOSAL_POLICY.maximumSourceFileBytes,
    "Workspace source read",
  );
  const readCode = options.code ?? "WRITE002";
  const readLabel = options.label ?? "Workspace provenance file";
  const absolutePath = resolve(
    environment.workspacePath,
    ...portablePath.split("/"),
  );
  if (!isWithin(environment.workspacePath, absolutePath)) {
    throw writeError("WRITE002", "Workspace source ref escapes the workspace.");
  }
  const parent = dirname(absolutePath);
  const parentMetadata = await metadataIfPresent(parent);
  if (
    parentMetadata === null ||
    !parentMetadata.isDirectory() ||
    parentMetadata.isSymbolicLink()
  ) {
    throw writeError("WRITE002", `Workspace source parent is unsafe: ${portablePath}`);
  }
  const resolvedParent = await realpath(parent);
  if (
    !samePath(resolvedParent, parent) ||
    !isWithin(environment.workspacePath, resolvedParent)
  ) {
    throw writeError("WRITE002", `Workspace source parent escapes the workspace: ${portablePath}`);
  }
  const guard = createStableDirectoryGuard(environment.workspacePath, parent, {
    code: "WRITE002",
    label: "Workspace provenance directory",
  });
  await guard.prepare();
  const bytes = await readBoundedRegularFileIfPresent(absolutePath, {
    containmentRoot: parent,
    maximumBytes,
    code: readCode,
    label: readLabel,
    beforeOpen: () => guard.assert(),
    beforeHandleOpen: () => guard.assert(),
    afterRead: () => guard.assert(),
  });
  if (bytes === null) {
    throw writeError("WRITE001", `Workspace provenance file is missing: ${portablePath}`);
  }
  return bytes;
}

export async function assertNoActiveMigration(environment) {
  const migrationsRoot = join(environment.graphRoot, ".syncora", "migrations");
  const metadata = await metadataIfPresent(migrationsRoot);
  if (metadata === null) return;
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw writeError(
      "WRITE006",
      "Migration state root is unsafe; governed writes are blocked.",
    );
  }
  const resolved = await realpath(migrationsRoot);
  if (!samePath(resolved, migrationsRoot) || !isWithin(environment.graphRoot, resolved)) {
    throw writeError(
      "WRITE006",
      "Migration state root changed identity; governed writes are blocked.",
    );
  }
  const entries = await readdir(migrationsRoot, { withFileTypes: true });
  if (entries.length > MAXIMUM_MIGRATION_DIRECTORIES) {
    throw writeError(
      "WRITE006",
      "Migration state count exceeds the governed-write inspection limit.",
      { count: entries.length, limit: MAXIMUM_MIGRATION_DIRECTORIES },
    );
  }
  const active = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw writeError(
        "WRITE006",
        "Migration state root contains an unsafe entry.",
        { entry: entry.name },
      );
    }
    let paths;
    let loaded;
    try {
      paths = migrationPaths(environment.graphRoot, entry.name);
      loaded = await readMigrationState(paths);
    } catch (error) {
      throw writeError(
        "WRITE006",
        "Migration state could not be proven safe before a governed write.",
        {
          migrationId: entry.name,
          cause: error instanceof Error ? error.message : String(error),
        },
      );
    }
    if (loaded === null) {
      throw writeError(
        "WRITE006",
        "A migration directory has no valid state and blocks governed writes.",
        { migrationId: entry.name },
      );
    }
    if (
      !MIGRATION_STATUSES.includes(loaded.value.status) ||
      !TERMINAL_MIGRATION_STATUSES.has(loaded.value.status)
    ) {
      active.push({ migrationId: entry.name, status: loaded.value.status });
    }
  }
  if (active.length > 0) {
    throw writeError(
      "WRITE006",
      "An unfinished legacy-adoption migration blocks governed canonical writes.",
      { active: active.slice(0, 16), omitted: Math.max(0, active.length - 16) },
    );
  }
}
