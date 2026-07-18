import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";

import { readOptionalBuffer } from "./atomic-file.mjs";
import {
  CURRENT_AGENT_HOOK_VERSION,
  inspectAgentHooks,
} from "./agent-patcher.mjs";
import {
  CHECKPOINT_RUNTIME_IDENTITY,
  CHECKPOINT_VALIDATOR_POLICY_IDENTITY,
} from "./checkpoint.mjs";
import {
  CHECKPOINT_STATE_FILE,
  readCheckpointState,
} from "./checkpoint-state.mjs";
import {
  readActiveFileTransaction,
  readFileTransaction,
} from "./file-transaction.mjs";
import {
  captureStableDirectoryBinding,
  parseRecoveryGuardRecord,
} from "./lock-recovery-guard.mjs";
import {
  isWithin,
  readBoundedRegularFileIfPresent,
  readSyncoraConfigIfPresent,
  resolveGraphContext,
  resolveWorkspace,
} from "./workspace.mjs";

const LOCK_MAX_BYTES = 4_096;

function check(status, code, message) {
  return { status, code, message };
}

async function metadataIfPresent(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function inspectCheckpointRuntime(workspacePath, checks, warnings) {
  const runtimeRoot = join(workspacePath, ".syncora");
  const statePath = join(runtimeRoot, CHECKPOINT_STATE_FILE);
  try {
    const syncoraBinding = await captureStableDirectoryBinding(runtimeRoot, {
      code: "STATE001",
      label: "The .syncora runtime directory",
      containmentRoot: workspacePath,
    });
    const stateRead = await readCheckpointState({
      statePath,
      syncoraRoot: runtimeRoot,
      syncoraBinding,
    });
    if (stateRead.condition === "missing") {
      checks.push(
        check(
          "ok",
          "CHECKPOINT001",
          "No checkpoint state exists yet; the first relevant activation will validate.",
        ),
      );
    } else if (stateRead.condition === "legacy") {
      checks.push(
        check(
          "warn",
          "CHECKPOINT001",
          `Checkpoint state schema ${stateRead.schemaVersion} is obsolete; the next relevant activation will rebuild it.`,
        ),
      );
    } else if (stateRead.condition === "corrupt") {
      checks.push(
        check(
          stateRead.unsafe ? "error" : "warn",
          "CHECKPOINT001",
          stateRead.unsafe
            ? "Checkpoint state path is unsafe and must be repaired before activation."
            : "Checkpoint state is corrupt; the next relevant activation will rebuild it.",
        ),
      );
    } else {
      const state = stateRead.state;
      const policyCurrent =
        state.runtimeIdentity === CHECKPOINT_RUNTIME_IDENTITY &&
        state.validatorPolicyIdentity === CHECKPOINT_VALIDATOR_POLICY_IDENTITY;
      checks.push(
        check(
          policyCurrent ? "ok" : "warn",
          "CHECKPOINT001",
          policyCurrent
            ? `Checkpoint state is compatible at activation sequence ${state.activationSequence}.`
            : "Checkpoint state uses an older runtime or validation policy; the next relevant activation will refresh it.",
        ),
      );
      if (state.lastIncomplete) {
        warnings.push({
          code: "CHECKPOINT_INCOMPLETE",
          message: `The previous checkpoint did not complete (${state.lastIncomplete.code}); the next relevant activation will run full validation.`,
        });
      }
    }
  } catch (error) {
    checks.push(check("error", error.code ?? "STATE001", error.message));
  }
}

function appendUnsafeLockDirectoryChecks(checks, message) {
  checks.push(check("error", "LOCK001", message));
  checks.push(check("error", "PATCH005", message));
}

async function inspectLockDirectory(workspacePath, checks) {
  const runtimeRoot = join(workspacePath, ".syncora");
  const runtimeMetadata = await metadataIfPresent(runtimeRoot);
  if (!runtimeMetadata) return null;
  if (
    !runtimeMetadata.isDirectory() ||
    runtimeMetadata.isSymbolicLink()
  ) {
    appendUnsafeLockDirectoryChecks(
      checks,
      "The Syncora runtime directory is unsafe for checkpoint and patch locks.",
    );
    return null;
  }
  const resolvedRuntimeRoot = await realpath(runtimeRoot);
  if (!isWithin(workspacePath, resolvedRuntimeRoot)) {
    appendUnsafeLockDirectoryChecks(
      checks,
      "The Syncora runtime directory escapes the workspace.",
    );
    return null;
  }

  const locksRoot = join(resolvedRuntimeRoot, "locks");
  const locksMetadata = await metadataIfPresent(locksRoot);
  if (!locksMetadata) {
    checks.push(
      check("ok", "LOCK001", "No checkpoint operation lock is held."),
    );
    checks.push(
      check("ok", "PATCH005", "No agent-patcher operation lock is held."),
    );
    return null;
  }
  if (!locksMetadata.isDirectory() || locksMetadata.isSymbolicLink()) {
    appendUnsafeLockDirectoryChecks(
      checks,
      "The Syncora lock directory is a junction, symlink, or non-directory.",
    );
    return null;
  }

  const resolvedLocksRoot = await realpath(locksRoot);
  if (!isWithin(resolvedRuntimeRoot, resolvedLocksRoot)) {
    appendUnsafeLockDirectoryChecks(
      checks,
      "The Syncora lock directory escapes its runtime root.",
    );
    return null;
  }
  return {
    path: locksRoot,
    resolvedPath: resolvedLocksRoot,
    metadata: locksMetadata,
  };
}

function lockDirectoryIdentityMatches(left, right) {
  if (
    !left?.isDirectory() ||
    !right?.isDirectory() ||
    left.isSymbolicLink() ||
    right.isSymbolicLink()
  ) {
    return false;
  }
  if (left.dev !== 0 || left.ino !== 0 || right.dev !== 0 || right.ino !== 0) {
    return left.dev === right.dev && left.ino === right.ino;
  }
  return true;
}

async function inspectLockFile(
  locksRoot,
  checks,
  { fileName, code, label, role = "operation lock" },
) {
  const lockPath = join(locksRoot.resolvedPath, fileName);
  let buffer;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      buffer = await readBoundedRegularFileIfPresent(lockPath, {
        containmentRoot: locksRoot.resolvedPath,
        maximumBytes: LOCK_MAX_BYTES,
        code,
        label: `${label} ${role}`,
        allowTransientMissing: true,
      });
      break;
    } catch (error) {
      if (error?.details?.reason === "changed") {
        if (attempt === 0) continue;
        checks.push(
          check(
            "warn",
            code,
            `${label} ${role} changed during diagnosis; retry when no operation is active.`,
          ),
        );
        return;
      }
      checks.push(check("error", error.code ?? code, error.message));
      return;
    }
  }
  if (!buffer) {
    checks.push(check("ok", code, `No ${label} ${role} is held.`));
    return;
  }
  let owner = null;
  if (role === "recovery guard") {
    owner = parseRecoveryGuardRecord(buffer);
  } else {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      owner = JSON.parse(text.trim());
    } catch {
      owner = null;
    }
  }
  const hasOwner = Number.isInteger(owner?.pid) && owner.pid > 0;
  checks.push(
    check(
      role === "recovery guard" && !hasOwner ? "error" : "warn",
      code,
      hasOwner
        ? role === "recovery guard"
          ? `${label} recovery guard is held by process ${owner.pid}; lock-path mutation is fail-closed until it is released.`
          : `${label} operation lock is held by process ${owner.pid}.`
        : role === "recovery guard"
          ? `${label} recovery guard exists with an incomplete owner record; verify no operation is active before manually removing an orphaned guard.`
          : `${label} operation lock exists but its owner record is incomplete.`,
    ),
  );
}

async function inspectRuntimeLocks(workspacePath, checks) {
  let locksRoot;
  try {
    locksRoot = await inspectLockDirectory(workspacePath, checks);
  } catch (error) {
    appendUnsafeLockDirectoryChecks(
      checks,
      error instanceof Error ? error.message : String(error),
    );
    return;
  }
  if (!locksRoot) return;

  const observations = [];
  await inspectLockFile(locksRoot, observations, {
    fileName: "checkpoint.lock",
    code: "LOCK001",
    label: "checkpoint",
  });
  await inspectLockFile(locksRoot, observations, {
    fileName: "agent-patcher.lock",
    code: "PATCH005",
    label: "agent-patcher",
  });
  await inspectLockFile(locksRoot, observations, {
    fileName: "checkpoint.lock.recovery",
    code: "LOCK001",
    label: "checkpoint",
    role: "recovery guard",
  });
  await inspectLockFile(locksRoot, observations, {
    fileName: "agent-patcher.lock.recovery",
    code: "PATCH005",
    label: "agent-patcher",
    role: "recovery guard",
  });

  try {
    const finalMetadata = await metadataIfPresent(locksRoot.path);
    const finalResolvedPath = finalMetadata
      ? await realpath(locksRoot.path)
      : null;
    if (
      !lockDirectoryIdentityMatches(locksRoot.metadata, finalMetadata) ||
      finalResolvedPath === null ||
      !isWithin(join(workspacePath, ".syncora"), finalResolvedPath)
    ) {
      appendUnsafeLockDirectoryChecks(
        checks,
        "The Syncora lock directory changed or became unsafe during diagnosis.",
      );
      return;
    }
    checks.push(...observations);
  } catch (error) {
    appendUnsafeLockDirectoryChecks(
      checks,
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function inspectCanonicalTransaction(graphRoot, checks) {
  try {
    const active = await readActiveFileTransaction(graphRoot);
    if (!active) {
      checks.push(
        check("ok", "WRITE007", "No governed canonical file transaction is active."),
      );
      return;
    }
    const journal = await readFileTransaction({
      graphRoot,
      transactionId: active.transactionId,
    });
    if (!journal) {
      checks.push(
        check(
          "error",
          "WRITE007",
          `Canonical transaction ${active.transactionId} has no readable recovery journal.`,
        ),
      );
      return;
    }
    const terminal = new Set(["finalized", "rolled-back"]).has(journal.status);
    checks.push(
      check(
        "warn",
        "WRITE007",
        terminal
          ? `Canonical transaction ${active.transactionId} is ${journal.status} but its stale marker still needs foreground cleanup.`
          : `Canonical transaction ${active.transactionId} is ${journal.status}; resume its governed apply or recovery before context reads or another writer.`,
      ),
    );
  } catch (error) {
    checks.push(check("error", error.code ?? "WRITE007", error.message));
  }
}

export async function diagnoseWorkspace(options) {
  const workspace = await resolveWorkspace(options.workspace);
  const checks = [];
  const warnings = [];
  let graph;

  const major = Number.parseInt(process.versions.node.split(".")[0], 10);
  checks.push(
    major >= 22 && major < 25
      ? check("ok", "NODE001", `Node ${process.versions.node} is supported.`)
      : check("error", "NODE001", "Syncora supports Node 22 through Node 24."),
  );

  let configInfo = null;
  let configFailed = false;
  try {
    configInfo = await readSyncoraConfigIfPresent(workspace.realPath);
  } catch (error) {
    configFailed = true;
    checks.push(check("error", error.code ?? "CONFIG001", error.message));
  }
  const config = configInfo?.config;
  if (!configInfo && !configFailed) {
    checks.push(
      check("warn", "CONFIG001", "Workspace is not initialized by Syncora."),
    );
  } else if (configInfo) {
    checks.push(
      check(
        "ok",
        "CONFIG001",
        `Syncora configuration is readable; full validation backstops are ${configInfo.maintenance.fullValidationEveryActivations} activations or ${configInfo.maintenance.fullValidationMaxAgeHours} hours.`,
      ),
    );
    if (config.agentPatching?.markerVersion !== undefined) {
      warnings.push({
        code: "LEGACY_CONFIG_FIELD",
        message: "agentPatching.markerVersion is deprecated and ignored; hook version is runtime-owned.",
      });
    }
    await inspectCheckpointRuntime(workspace.realPath, checks, warnings);
  }

  await inspectRuntimeLocks(workspace.realPath, checks);

  try {
    graph = await resolveGraphContext(workspace, {
      allowExternalGraphRoot: options.allowExternalGraphRoot,
    });
    checks.push(
      check(
        "ok",
        "WRITE002",
        graph.external
          ? `External graph root is explicitly allowlisted: ${graph.resolvedGraphPath}`
          : "Graph root is contained by the workspace.",
      ),
    );
  } catch (error) {
    checks.push(check("error", error.code ?? "WRITE002", error.message));
  }

  if (graph) {
    await inspectCanonicalTransaction(graph.resolvedGraphPath, checks);
    const index = await readOptionalBuffer(join(graph.resolvedGraphPath, "index.md"));
    checks.push(
      index
        ? check("ok", "GRAPH002", "Graph atlas exists.")
        : check("warn", "GRAPH002", "Graph atlas is missing."),
    );
  }

  let hooks = [];
  try {
    hooks = await inspectAgentHooks(workspace.realPath);
  } catch (error) {
    checks.push(check("error", error.code ?? "PATCH004", error.message));
  }
  const hooked = hooks.filter((item) => item.marker === "present");
  if (config?.agentPatching?.enabled && hooked.length === 0) {
    checks.push(
      check("warn", "PATCH004", "Agent patching is enabled but no hook exists."),
    );
  } else if (hooked.some((item) => item.version < CURRENT_AGENT_HOOK_VERSION)) {
    checks.push(
      check(
        "warn",
        "PATCH004",
        `Agent instruction hook is older than supported v${CURRENT_AGENT_HOOK_VERSION}; run patch-agents to upgrade it.`,
      ),
    );
  } else if (hooked.length > 0) {
    checks.push(
      check("ok", "PATCH004", `${hooked.length} agent instruction hook(s) found.`),
    );
  }

  for (const hook of hooks.filter((item) => item.legacyKnowledgeGraphWorkflow)) {
    warnings.push({
      code: "LEGACY_AGENT_WORKFLOW",
      message: `${hook.path} still contains the broad legacy knowledge-graph workflow; do not claim context-efficiency cutover until it is migrated.`,
    });
  }

  const claudeFiles = hooks.filter((item) =>
    item.path.toLowerCase().endsWith("claude.md"),
  );
  if (claudeFiles.length > 1) {
    warnings.push({
      code: "MULTIPLE_CLAUDE_FILES",
      message: "Both root and nested Claude instruction files exist; root CLAUDE.md is the patch target.",
    });
  }

  const ok = checks.every((item) => item.status !== "error");
  return {
    ok,
    command: "doctor",
    workspace: workspace.realPath,
    checks,
    warnings,
  };
}
