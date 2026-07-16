import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";

import {
  checkpointIdMatchesEnvironment,
  checkpointIdParts,
  CHECKPOINT_IN_FLIGHT_MAX_AGE_MS,
  CHECKPOINT_MAX_COMPLETED,
  CHECKPOINT_MAX_IN_FLIGHT,
  CHECKPOINT_MAX_PENDING,
  createCheckpointId,
  createCheckpointState,
  readCheckpointState,
  resolveCheckpointStorage,
  shaIdentity,
  withCheckpointLock,
  writeCheckpointState,
} from "./checkpoint-state.mjs";
import { VERSION, SyncoraError } from "./cli.mjs";
import { discoverMarkdownFiles } from "./graph-scanner.mjs";
import {
  graphRevision,
  inspectWorkspace,
  VALIDATION_POLICY,
  VALIDATION_SPECIFICATION,
} from "./validate.mjs";
import {
  isWithin,
  readSyncoraConfigIfPresent,
  resolveGraphContext,
  resolveWorkspace,
  samePath,
} from "./workspace.mjs";

export const CHECKPOINT_RUNTIME_SPECIFICATION = "syncora-checkpoint-runtime-v2";
export const CHECKPOINT_CHANGE_SPECIFICATION = "syncora-checkpoint-change-fingerprint-v1";
export const CHECKPOINT_REPORT_SCHEMA_VERSION = 1;

const ALLOWED_PROFILES = new Set([
  "checkpoint",
  "context",
  "capture",
  "maintenance",
]);
const MAX_PUBLISH_ATTEMPTS = 6;

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalValue(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function digest(namespace, value) {
  return shaIdentity(namespace, typeof value === "string" ? value : canonicalJson(value));
}

function normalizedRoot(path) {
  const portable = path.replaceAll("\\", "/");
  return process.platform === "win32" ? portable.toLowerCase() : portable;
}

export const CHECKPOINT_RUNTIME_IDENTITY = digest(
  "syncora-checkpoint-runtime-identity-v1",
  `${CHECKPOINT_RUNTIME_SPECIFICATION}\n${VERSION}`,
);

export const CHECKPOINT_VALIDATOR_POLICY_IDENTITY = digest(
  "syncora-checkpoint-validator-policy-v1",
  {
    runtimeVersion: VERSION,
    checkpointChangeSpecification: CHECKPOINT_CHANGE_SPECIFICATION,
    validationSpecification: VALIDATION_SPECIFICATION,
    validationPolicy: VALIDATION_POLICY,
  },
);

function sameEnvironment(left, right) {
  return (
    left.runtimeIdentity === right.runtimeIdentity &&
    left.validatorPolicyIdentity === right.validatorPolicyIdentity &&
    left.configIdentity === right.configIdentity &&
    left.workspaceIdentity === right.workspaceIdentity &&
    left.graphRootIdentity === right.graphRootIdentity &&
    samePath(left.workspace.realPath, right.workspace.realPath) &&
    samePath(left.graph.resolvedGraphPath, right.graph.resolvedGraphPath)
  );
}

async function readStableConfig(workspacePath) {
  const loaded = await readSyncoraConfigIfPresent(workspacePath);
  if (!loaded) {
    throw new SyncoraError(
      "CONFIG001",
      "Workspace is not initialized. Run syncora setup first.",
    );
  }
  return loaded;
}

export async function resolveCheckpointEnvironment(options) {
  const workspace = await resolveWorkspace(options.workspace);
  const stableConfig = await readStableConfig(workspace.realPath);
  const storage = await resolveCheckpointStorage(workspace.realPath);
  const graph = await resolveGraphContext(workspace, {
    allowExternalGraphRoot: options.allowExternalGraphRoot,
  });
  const workspaceIdentity = digest(
    "syncora-workspace-root-v1",
    normalizedRoot(workspace.realPath),
  );
  const graphRootIdentity = digest(
    "syncora-graph-root-v1",
    normalizedRoot(graph.resolvedGraphPath),
  );
  return {
    workspace,
    graph,
    storage,
    maintenance: stableConfig.maintenance,
    runtimeIdentity: CHECKPOINT_RUNTIME_IDENTITY,
    validatorPolicyIdentity: CHECKPOINT_VALIDATOR_POLICY_IDENTITY,
    configIdentity: digest("syncora-config-bytes-v1", stableConfig.buffer.toString("utf8")),
    workspaceIdentity,
    graphRootIdentity,
  };
}

async function mapConcurrent(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(items.length, 1), concurrency) },
      () => worker(),
    ),
  );
  return results;
}

function sortedStructuralFindings(scan) {
  return [...scan.findings].sort((left, right) =>
    canonicalJson(left) < canonicalJson(right)
      ? -1
      : canonicalJson(left) > canonicalJson(right)
        ? 1
        : 0,
  );
}

function checkpointScanFingerprint(scan) {
  const findingsDigest = digest(
    "syncora-checkpoint-structural-findings-v1",
    sortedStructuralFindings(scan),
  );
  const hash = createHash("sha256");
  hash.update(`${CHECKPOINT_CHANGE_SPECIFICATION}\n`);
  for (const file of scan.files) {
    hash.update(file.path, "utf8");
    hash.update("\0");
    hash.update(canonicalJson(file.checkpointStat), "utf8");
    hash.update("\n");
  }
  hash.update(findingsDigest, "utf8");
  hash.update("\n");
  return {
    changeFingerprint: `sha256:${hash.digest("hex")}`,
    structuralFindingsDigest: findingsDigest,
    files: scan.files.length,
    totalBytes: scan.totalBytes,
  };
}

function checkpointSourceFingerprint(files, structuralFindingsDigest) {
  const hash = createHash("sha256");
  hash.update("syncora-checkpoint-source-fingerprint-v1\n");
  for (const file of files) {
    hash.update(file.path, "utf8");
    hash.update("\0");
    hash.update(file.rawSha256 ?? "unreadable", "utf8");
    hash.update("\n");
  }
  hash.update(structuralFindingsDigest, "utf8");
  hash.update("\n");
  return `sha256:${hash.digest("hex")}`;
}

async function captureCheckpointGraphMetadata(environment) {
  const scan = await discoverMarkdownFiles(
    environment.graph.resolvedGraphPath,
    VALIDATION_POLICY,
  );
  return { ...checkpointScanFingerprint(scan), scan };
}

export async function fingerprintCheckpointGraphMetadata(environment, hooks = {}) {
  const captured = await captureCheckpointGraphMetadata(environment);
  const { scan: _scan, ...snapshot } = captured;
  await hooks.onMetadataSnapshot?.(snapshot);
  return snapshot;
}

function bigintFileStatIdentity(metadata) {
  return {
    size: metadata.size.toString(),
    mtimeNs: metadata.mtimeNs.toString(),
    ctimeNs: metadata.ctimeNs.toString(),
    birthtimeNs: metadata.birthtimeNs.toString(),
    dev: metadata.dev.toString(),
    ino: metadata.ino.toString(),
    mode: metadata.mode.toString(),
  };
}

async function hashGraphFile(file, graphRoot) {
  const before = await lstat(file.absolutePath, { bigint: true });
  const resolved = await realpath(file.absolutePath);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    canonicalJson(bigintFileStatIdentity(before)) !== canonicalJson(file.checkpointStat) ||
    !samePath(resolved, file.realPath) ||
    !isWithin(graphRoot, resolved)
  ) {
    throw new SyncoraError("READ001", `Graph file identity changed: ${file.path}`);
  }

  const hash = createHash("sha256");
  let bytes = 0;
  try {
    for await (const chunk of createReadStream(file.absolutePath)) {
      bytes += chunk.length;
      hash.update(chunk);
    }
  } catch (error) {
    throw new SyncoraError("READ001", `Unable to fingerprint graph file: ${file.path}`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  const after = await lstat(file.absolutePath, { bigint: true });
  const finalResolved = await realpath(file.absolutePath);
  if (
    BigInt(bytes) !== before.size ||
    canonicalJson(bigintFileStatIdentity(after)) !== canonicalJson(bigintFileStatIdentity(before)) ||
    !samePath(finalResolved, resolved)
  ) {
    throw new SyncoraError("READ001", `Graph file changed while fingerprinting: ${file.path}`);
  }
  return { path: file.path, rawSha256: hash.digest("hex") };
}

export async function fingerprintCheckpointGraph(environment) {
  const captured = await captureCheckpointGraphMetadata(environment);
  const files = await mapConcurrent(captured.scan.files, 8, (file) =>
    hashGraphFile(file, environment.graph.resolvedGraphPath),
  );
  const revision = graphRevision(files);
  return {
    sourceFingerprint: checkpointSourceFingerprint(
      files,
      captured.structuralFindingsDigest,
    ),
    changeFingerprint: captured.changeFingerprint,
    graphRevision: revision,
    structuralFindingsDigest: captured.structuralFindingsDigest,
    files: files.length,
    totalBytes: captured.totalBytes,
  };
}

function fingerprintCheckpointInspection(inspection) {
  const scanFingerprint = checkpointScanFingerprint(inspection.scan);
  const revision = graphRevision(inspection.notes);
  if (revision !== inspection.report.graph.revision) {
    throw new SyncoraError("READ001", "Validation report revision does not match inspected note bytes.");
  }
  return {
    ...scanFingerprint,
    sourceFingerprint: checkpointSourceFingerprint(
      inspection.notes,
      scanFingerprint.structuralFindingsDigest,
    ),
    graphRevision: revision,
  };
}

function reportFindingsDigest(report) {
  return digest("syncora-checkpoint-validation-findings-v1", {
    ok: report.ok,
    summary: report.summary,
    diagnostics: report.diagnostics,
  });
}

function readIncomplete(report) {
  return (report.summary.diagnostics.byCode.READ001 ?? 0) > 0;
}

function timestamp(hooks = {}) {
  const supplied = typeof hooks.now === "function" ? hooks.now() : hooks.now;
  const date = supplied === undefined ? new Date() : new Date(supplied);
  if (Number.isNaN(date.valueOf())) {
    throw new SyncoraError("CHECKPOINT001", "Checkpoint clock returned an invalid time.");
  }
  return date.toISOString();
}

function stableOutcome(report, environment, fingerprint, completedAt) {
  const graphValid = report.summary.valid;
  return {
    completedAt,
    runtimeIdentity: environment.runtimeIdentity,
    validatorPolicyIdentity: environment.validatorPolicyIdentity,
    configIdentity: environment.configIdentity,
    workspaceIdentity: environment.workspaceIdentity,
    graphRootIdentity: environment.graphRootIdentity,
    sourceFingerprint: fingerprint.sourceFingerprint,
    changeFingerprint: fingerprint.changeFingerprint,
    graphRevision: report.graph.revision,
    findingsDigest: reportFindingsDigest(report),
    graphValid,
    errors: report.summary.diagnostics.error,
    warnings: report.summary.diagnostics.warning,
  };
}

export async function inspectStableCheckpoint(options, environment, _initialChange, hooks = {}) {
  await hooks.beforeFullValidation?.({ environment });
  const first = await inspectWorkspace(options);
  const firstFingerprint = fingerprintCheckpointInspection(first);
  await hooks.afterFirstInspection?.({
    inspection: first,
    environment,
    fingerprint: firstFingerprint,
    initialChange: _initialChange,
  });
  const second = await inspectWorkspace(options);
  const secondFingerprint = fingerprintCheckpointInspection(second);
  const firstDigest = reportFindingsDigest(first.report);
  const secondDigest = reportFindingsDigest(second.report);
  if (
    readIncomplete(first.report) ||
    readIncomplete(second.report) ||
    !samePath(first.graph.resolvedGraphPath, environment.graph.resolvedGraphPath) ||
    !samePath(second.graph.resolvedGraphPath, environment.graph.resolvedGraphPath) ||
    firstFingerprint.sourceFingerprint !== secondFingerprint.sourceFingerprint ||
    firstFingerprint.changeFingerprint !== secondFingerprint.changeFingerprint ||
    firstFingerprint.graphRevision !== secondFingerprint.graphRevision ||
    firstFingerprint.structuralFindingsDigest !==
      secondFingerprint.structuralFindingsDigest ||
    firstDigest !== secondDigest
  ) {
    throw new SyncoraError(
      "READ001",
      "Graph validation did not complete against one stable root and revision.",
    );
  }

  await hooks.beforeFinalFingerprint?.({
    first,
    second,
    environment,
    fingerprint: secondFingerprint,
  });
  const finalEnvironment = await resolveCheckpointEnvironment(options);
  if (!sameEnvironment(environment, finalEnvironment)) {
    throw new SyncoraError(
      "CHECKPOINT002",
      "Workspace, graph root, config, or runtime policy changed during validation.",
    );
  }
  return stableOutcome(
    second.report,
    finalEnvironment,
    secondFingerprint,
    timestamp(hooks),
  );
}

function applyEnvironmentHeaders(state, environment) {
  state.runtimeIdentity = environment.runtimeIdentity;
  state.validatorPolicyIdentity = environment.validatorPolicyIdentity;
  state.configIdentity = environment.configIdentity;
  state.workspaceIdentity = environment.workspaceIdentity;
  state.graphRootIdentity = environment.graphRootIdentity;
}

async function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function pruneInFlight(state, now, preserveOperationId = undefined) {
  const nowMs = new Date(now).valueOf();
  const retained = [];
  let abandoned = 0;
  for (const item of state.inFlight) {
    if (item.operationId === preserveOperationId) {
      retained.push(item);
      continue;
    }
    const age = nowMs - new Date(item.startedAt).valueOf();
    const alive = age <= CHECKPOINT_IN_FLIGHT_MAX_AGE_MS
      ? await processAlive(item.pid)
      : false;
    if (alive) retained.push(item);
    else abandoned += 1;
  }
  state.inFlight = retained;
  if (abandoned > 0) {
    state.lastIncomplete = { at: now, code: "INCOMPLETE" };
  }
  return abandoned;
}

function addInFlight(state, item) {
  if (state.inFlight.length >= CHECKPOINT_MAX_IN_FLIGHT) {
    throw new SyncoraError(
      "CHECKPOINT003",
      "Too many checkpoint operations are currently in flight.",
    );
  }
  state.inFlight.push(item);
}

function operationRecord(phase, now, checkpointId = null, recovery = null) {
  return {
    operationId: randomUUID(),
    phase,
    checkpointId,
    recovery,
    startedAt: now,
    pid: process.pid,
  };
}

function stateForRead(read, environment) {
  return read.state ?? createCheckpointState(environment);
}

async function reservePre(environment, hooks) {
  return withCheckpointLock(
    environment.storage,
    async () => {
      const now = timestamp(hooks);
      const read = await readCheckpointState(environment.storage);
      const state = stateForRead(read, environment);
      await pruneInFlight(state, now);
      const operation = operationRecord(
        "pre",
        now,
        null,
        read.condition === "loaded" ? null : read.condition,
      );
      addInFlight(state, operation);
      applyEnvironmentHeaders(state, environment);
      await writeCheckpointState(environment.storage, state);
      return { operation, condition: read.condition };
    },
    hooks.lockPolicy,
  );
}

function checkpointError(code, message, details = undefined) {
  return new SyncoraError(code, message, details);
}

async function reservePost(environment, checkpointId, hooks) {
  const binding = checkpointIdMatchesEnvironment(checkpointId, environment);
  if (!binding.ok) {
    throw checkpointError(
      binding.reason === "malformed" ? "CHECKPOINT004" : "CHECKPOINT005",
      binding.reason === "malformed"
        ? "Checkpoint ID is malformed."
        : `Checkpoint ID is bound to a different ${binding.reason}.`,
    );
  }
  return withCheckpointLock(
    environment.storage,
    async () => {
      const now = timestamp(hooks);
      const read = await readCheckpointState(environment.storage);
      const state = stateForRead(read, environment);
      await pruneInFlight(state, now);
      if (read.condition !== "loaded") {
        applyEnvironmentHeaders(state, environment);
        await writeCheckpointState(environment.storage, state);
        throw checkpointError(
          "CHECKPOINT006",
          "Checkpoint ID cannot be recovered because its derived state is missing or corrupt.",
        );
      }
      const epoch = state.epoch.replaceAll("-", "").toLowerCase();
      if (binding.parts.epoch !== epoch) {
        throw checkpointError("CHECKPOINT006", "Checkpoint ID is stale for this state epoch.");
      }
      const expectedId = createCheckpointId({
        workspaceIdentity: environment.workspaceIdentity,
        graphRootIdentity: environment.graphRootIdentity,
        epoch: state.epoch,
        sequence: binding.parts.sequence,
        runtimeIdentity: environment.runtimeIdentity,
      });
      if (expectedId !== checkpointId) {
        throw checkpointError(
          "CHECKPOINT006",
          "Checkpoint ID binding is stale or incompatible with this runtime.",
        );
      }
      const completed = state.completed.find((item) => item.id === checkpointId);
      if (completed) return { completed, condition: read.condition, operation: null };
      const pending = state.pending.find((item) => item.id === checkpointId);
      if (!pending) {
        throw checkpointError("CHECKPOINT007", "Checkpoint ID is unknown or has expired.");
      }
      const operation = operationRecord("post", now, checkpointId);
      addInFlight(state, operation);
      applyEnvironmentHeaders(state, environment);
      await writeCheckpointState(environment.storage, state);
      return { operation, pending, condition: read.condition, completed: null };
    },
    hooks.lockPolicy,
  );
}

function dueReasons({ state, operation, nextSequence, environment, fingerprint, now, force }) {
  const reasons = [];
  const stamp = state.validationStamp;
  if (force) reasons.push("force");
  if (operation.recovery === "missing") reasons.push("first_run");
  if (operation.recovery === "corrupt") reasons.push("state_corrupt");
  if (operation.recovery === "legacy") reasons.push("state_legacy");
  if (state.lastIncomplete) reasons.push("previous_incomplete");
  if (state.inFlight.some((item) => item.operationId !== operation.operationId)) {
    reasons.push("other_in_flight");
  }
  if (!stamp) {
    if (!reasons.includes("first_run") && !reasons.includes("state_corrupt")) {
      reasons.push("no_validation_stamp");
    }
    return reasons;
  }
  if (stamp.runtimeIdentity !== environment.runtimeIdentity) reasons.push("runtime_changed");
  if (stamp.validatorPolicyIdentity !== environment.validatorPolicyIdentity) {
    reasons.push("validator_policy_changed");
  }
  if (stamp.configIdentity !== environment.configIdentity) reasons.push("config_changed");
  if (stamp.workspaceIdentity !== environment.workspaceIdentity) reasons.push("workspace_changed");
  if (stamp.graphRootIdentity !== environment.graphRootIdentity) reasons.push("graph_root_changed");
  if (stamp.changeFingerprint !== fingerprint.changeFingerprint) reasons.push("graph_changed");

  const nowMs = new Date(now).valueOf();
  const completedMs = new Date(stamp.completedAt).valueOf();
  const lastCheckpointMs = state.lastCheckpointAt
    ? new Date(state.lastCheckpointAt).valueOf()
    : completedMs;
  if (nowMs < completedMs || nowMs < lastCheckpointMs) {
    reasons.push("clock_reversal");
  } else if (
    nowMs - completedMs >=
    environment.maintenance.fullValidationMaxAgeHours * 3_600_000
  ) {
    reasons.push("max_age");
  }
  if (
    nextSequence - stamp.activationSequence >=
    environment.maintenance.fullValidationEveryActivations
  ) {
    reasons.push("activation_cadence");
  }
  return [...new Set(reasons)];
}

function outcomeMatches(outcome, environment, fingerprint) {
  return Boolean(
    outcome &&
      outcome.runtimeIdentity === environment.runtimeIdentity &&
      outcome.validatorPolicyIdentity === environment.validatorPolicyIdentity &&
      outcome.configIdentity === environment.configIdentity &&
      outcome.workspaceIdentity === environment.workspaceIdentity &&
      outcome.graphRootIdentity === environment.graphRootIdentity &&
      outcome.changeFingerprint === fingerprint.changeFingerprint,
  );
}

function stampFromOutcome(outcome, activationSequence) {
  return { ...outcome, activationSequence };
}

function trimPending(state) {
  const protectedIds = new Set(
    state.inFlight
      .filter((item) => item.phase === "post" && item.checkpointId)
      .map((item) => item.checkpointId),
  );
  while (state.pending.length >= CHECKPOINT_MAX_PENDING) {
    const index = state.pending.findIndex((item) => !protectedIds.has(item.id));
    if (index < 0) {
      throw checkpointError(
        "CHECKPOINT003",
        "All retained checkpoint IDs are currently being finalized.",
      );
    }
    state.pending.splice(index, 1);
  }
}

function trimCompleted(state) {
  if (state.completed.length >= CHECKPOINT_MAX_COMPLETED) {
    state.completed.splice(0, state.completed.length - CHECKPOINT_MAX_COMPLETED + 1);
  }
}

async function confirmPublicationSnapshot({
  options,
  expectedEnvironment,
  expectedFingerprint,
  phase,
  checkpointId = null,
  hooks,
}) {
  await hooks.beforePublicationCas?.({
    phase,
    checkpointId,
    environment: expectedEnvironment,
    fingerprint: expectedFingerprint,
  });
  const currentEnvironment = await resolveCheckpointEnvironment(options);
  if (!sameEnvironment(expectedEnvironment, currentEnvironment)) return null;
  const captured = await captureCheckpointGraphMetadata(currentEnvironment);
  const { scan: _scan, ...currentFingerprint } = captured;
  if (hooks.afterPublicationMetadataCapture) {
    await hooks.afterPublicationMetadataCapture({
      phase,
      checkpointId,
      environment: currentEnvironment,
      fingerprint: currentFingerprint,
    });
  }
  const finalEnvironment = await resolveCheckpointEnvironment(options);
  if (
    !sameEnvironment(expectedEnvironment, finalEnvironment) ||
    !sameEnvironment(currentEnvironment, finalEnvironment)
  ) {
    return null;
  }
  const finalCaptured = await captureCheckpointGraphMetadata(finalEnvironment);
  const { scan: _finalScan, ...finalFingerprint } = finalCaptured;
  if (
    currentFingerprint.changeFingerprint !== expectedFingerprint.changeFingerprint ||
    currentFingerprint.structuralFindingsDigest !==
      expectedFingerprint.structuralFindingsDigest ||
    finalFingerprint.changeFingerprint !== expectedFingerprint.changeFingerprint ||
    finalFingerprint.structuralFindingsDigest !==
      expectedFingerprint.structuralFindingsDigest
  ) {
    return null;
  }
  return { environment: finalEnvironment, fingerprint: finalFingerprint };
}

async function publishPre({ options, profile, force, reservation, hooks }) {
  let outcome = null;
  for (let attempt = 0; attempt < MAX_PUBLISH_ATTEMPTS; attempt += 1) {
    const environment = await resolveCheckpointEnvironment(options);
    const fingerprint = await fingerprintCheckpointGraphMetadata(environment, hooks);
    const decision = await withCheckpointLock(
      environment.storage,
      async () => {
        const now = timestamp(hooks);
        const read = await readCheckpointState(environment.storage);
        if (read.condition !== "loaded") {
          throw checkpointError(
            "STATE001",
            "Checkpoint state changed or became corrupt while preflight was running.",
          );
        }
        const state = read.state;
        await pruneInFlight(state, now, reservation.operation.operationId);
        const operation = state.inFlight.find(
          (item) => item.operationId === reservation.operation.operationId,
        );
        if (!operation) {
          throw checkpointError("CHECKPOINT008", "Checkpoint reservation is no longer active.");
        }
        const nextSequence = state.activationSequence + 1;
        if (!Number.isSafeInteger(nextSequence)) {
          throw checkpointError("STATE001", "Checkpoint activation sequence is exhausted.");
        }
        const reasons = dueReasons({
          state,
          operation,
          nextSequence,
          environment,
          fingerprint,
          now,
          force,
        });
        if (reasons.length > 0 && !outcomeMatches(outcome, environment, fingerprint)) {
          return { validate: true, reasons };
        }

        const confirmed = await confirmPublicationSnapshot({
          options,
          expectedEnvironment: environment,
          expectedFingerprint: fingerprint,
          phase: "pre",
          hooks,
        });
        if (!confirmed) return { retry: true };
        if (outcome && !outcomeMatches(outcome, confirmed.environment, confirmed.fingerprint)) {
          return { retry: true };
        }

        const validationMode = reasons.length > 0 ? "full" : "reused";
        if (validationMode === "full") {
          state.validationStamp = stampFromOutcome(outcome, nextSequence);
          state.lastIncomplete = null;
        }
        const stamp = state.validationStamp;
        if (!stamp) {
          throw checkpointError("STATE001", "Checkpoint publication has no validation stamp.");
        }
        state.activationSequence = nextSequence;
        state.lastCheckpointAt = now;
        state.inFlight = state.inFlight.filter(
          (item) => item.operationId !== reservation.operation.operationId,
        );
        trimPending(state);
        const checkpointId = createCheckpointId({
          workspaceIdentity: environment.workspaceIdentity,
          graphRootIdentity: environment.graphRootIdentity,
          epoch: state.epoch,
          sequence: nextSequence,
          runtimeIdentity: environment.runtimeIdentity,
        });
        state.pending.push({
          id: checkpointId,
          sequence: nextSequence,
          profile,
          createdAt: now,
          baselineSourceFingerprint: stamp.sourceFingerprint,
          baselineChangeFingerprint: stamp.changeFingerprint,
        });
        applyEnvironmentHeaders(state, environment);
        await writeCheckpointState(environment.storage, state);
        return {
          published: true,
          environment: confirmed.environment,
          checkpointId,
          sequence: nextSequence,
          stamp,
          validationMode,
          reasons,
        };
      },
      hooks.lockPolicy,
    );

    if (decision.retry) continue;
    if (decision.validate) {
      outcome = await inspectStableCheckpoint(options, environment, fingerprint, hooks);
      continue;
    }
    return decision;
  }
  throw checkpointError(
    "CHECKPOINT009",
    "Checkpoint inputs did not remain stable long enough to publish preflight.",
  );
}

function completedRecord(pending, outcome, disposition) {
  return {
    id: pending.id,
    sequence: pending.sequence,
    profile: pending.profile,
    completedAt: outcome.completedAt,
    status: outcome.graphValid ? "ok" : "degraded",
    disposition,
    graphValid: outcome.graphValid,
    graphRevision: outcome.graphRevision,
    sourceFingerprint: outcome.sourceFingerprint,
    changeFingerprint: outcome.changeFingerprint,
    findingsDigest: outcome.findingsDigest,
    errors: outcome.errors,
    warnings: outcome.warnings,
    runtimeIdentity: outcome.runtimeIdentity,
    validatorPolicyIdentity: outcome.validatorPolicyIdentity,
    configIdentity: outcome.configIdentity,
    workspaceIdentity: outcome.workspaceIdentity,
    graphRootIdentity: outcome.graphRootIdentity,
  };
}

function postDisposition(pending, outcome) {
  if (pending.baselineSourceFingerprint === outcome.sourceFingerprint) {
    return "no-change";
  }
  if (pending.baselineChangeFingerprint === outcome.changeFingerprint) {
    return "unattributed-change";
  }
  return "durable-change";
}

async function publishPost({ options, checkpointId, reservation, hooks }) {
  let outcome = null;
  for (let attempt = 0; attempt < MAX_PUBLISH_ATTEMPTS; attempt += 1) {
    const environment = await resolveCheckpointEnvironment(options);
    const fingerprint = await fingerprintCheckpointGraphMetadata(environment, hooks);
    if (!outcomeMatches(outcome, environment, fingerprint)) {
      outcome = await inspectStableCheckpoint(options, environment, fingerprint, hooks);
    }
    const decision = await withCheckpointLock(
      environment.storage,
      async () => {
        const now = timestamp(hooks);
        const read = await readCheckpointState(environment.storage);
        if (read.condition !== "loaded") {
          throw checkpointError("STATE001", "Checkpoint state changed during postflight.");
        }
        const state = read.state;
        await pruneInFlight(state, now, reservation.operation.operationId);
        const alreadyCompleted = state.completed.find((item) => item.id === checkpointId);
        if (alreadyCompleted) {
          state.inFlight = state.inFlight.filter(
            (item) => item.operationId !== reservation.operation.operationId,
          );
          await writeCheckpointState(environment.storage, state);
          return { completed: alreadyCompleted, environment, idempotent: true };
        }
        const operation = state.inFlight.find(
          (item) => item.operationId === reservation.operation.operationId,
        );
        const pending = state.pending.find((item) => item.id === checkpointId);
        if (!operation || !pending) {
          throw checkpointError("CHECKPOINT008", "Checkpoint postflight reservation expired.");
        }
        if (!outcomeMatches(outcome, environment, fingerprint)) return { retry: true };
        const confirmed = await confirmPublicationSnapshot({
          options,
          expectedEnvironment: environment,
          expectedFingerprint: fingerprint,
          phase: "post",
          checkpointId,
          hooks,
        });
        if (!confirmed || !outcomeMatches(outcome, confirmed.environment, confirmed.fingerprint)) {
          return { retry: true };
        }

        state.validationStamp = stampFromOutcome(outcome, state.activationSequence);
        state.lastIncomplete = null;
        state.lastCheckpointAt = now;
        state.pending = state.pending.filter((item) => item.id !== checkpointId);
        state.inFlight = state.inFlight.filter(
          (item) => item.operationId !== reservation.operation.operationId,
        );
        const disposition = postDisposition(pending, outcome);
        const completed = completedRecord(pending, outcome, disposition);
        trimCompleted(state);
        state.completed.push(completed);
        applyEnvironmentHeaders(state, environment);
        await writeCheckpointState(environment.storage, state);
        return {
          completed,
          environment: confirmed.environment,
          idempotent: false,
          validationMode: "full",
          reasons: [
            disposition === "no-change"
              ? "post_no_change"
              : disposition === "durable-change"
                ? "post_durable_change"
                : "post_unattributed_change",
          ],
        };
      },
      hooks.lockPolicy,
    );
    if (decision.retry) continue;
    return decision;
  }
  throw checkpointError(
    "CHECKPOINT009",
    "Checkpoint inputs did not remain stable long enough to publish postflight.",
  );
}

function safeIncompleteCode(error) {
  const code = typeof error?.code === "string" ? error.code : "INTERNAL001";
  return /^[A-Z0-9_]{1,64}$/.test(code) ? code : "INTERNAL001";
}

async function recordIncomplete(environment, operationId, error, hooks) {
  return withCheckpointLock(
    environment.storage,
    async () => {
      const now = timestamp(hooks);
      const read = await readCheckpointState(environment.storage);
      if (read.condition !== "loaded") return null;
      const state = read.state;
      const operation = state.inFlight.find((item) => item.operationId === operationId);
      if (!operation) {
        if (error?.checkpointId) {
          return state.completed.find((item) => item.id === error.checkpointId) ?? null;
        }
        return null;
      }
      state.inFlight = state.inFlight.filter((item) => item.operationId !== operationId);
      state.lastIncomplete = { at: now, code: safeIncompleteCode(error) };
      await writeCheckpointState(environment.storage, state);
      return null;
    },
    hooks.lockPolicy,
  ).catch(() => null);
}

function resultFromStamp({
  phase,
  profile,
  checkpointId,
  sequence,
  environment,
  stamp,
  validationMode,
  reasons,
  condition,
  idempotent = false,
  disposition = undefined,
}) {
  const status = stamp.graphValid ? "ok" : "degraded";
  return {
    reportSchemaVersion: CHECKPOINT_REPORT_SCHEMA_VERSION,
    ok: true,
    command: "checkpoint",
    mode: "foreground",
    workspace: environment.workspace.realPath,
    graph: {
      root: environment.graph.resolvedGraphPath,
      external: environment.graph.external,
      rootIdentity: environment.graphRootIdentity,
      revision: stamp.graphRevision,
    },
    checkpoint: {
      phase,
      profile,
      id: checkpointId,
      sequence,
      idempotent,
      ...(phase === "post" ? { disposition } : {}),
    },
    validation: {
      status,
      mode: validationMode,
      graphValid: stamp.graphValid,
      errors: stamp.errors,
      warnings: stamp.warnings,
      reasons,
      completedAt: stamp.completedAt,
      findingsDigest: stamp.findingsDigest,
    },
    state: {
      condition,
      path: `.syncora/${environment.storage.statePath.split(/[\\/]/).at(-1)}`,
    },
  };
}

function stampFromCompleted(completed) {
  return {
    completedAt: completed.completedAt,
    runtimeIdentity: completed.runtimeIdentity,
    validatorPolicyIdentity: completed.validatorPolicyIdentity,
    configIdentity: completed.configIdentity,
    workspaceIdentity: completed.workspaceIdentity,
    graphRootIdentity: completed.graphRootIdentity,
    sourceFingerprint: completed.sourceFingerprint,
    changeFingerprint: completed.changeFingerprint,
    graphRevision: completed.graphRevision,
    findingsDigest: completed.findingsDigest,
    graphValid: completed.graphValid,
    errors: completed.errors,
    warnings: completed.warnings,
  };
}

function validateInvocation(options) {
  if (!new Set(["pre", "post"]).has(options.phase)) {
    throw checkpointError("CLI004", "Checkpoint requires phase pre or post.");
  }
  if (!ALLOWED_PROFILES.has(options.profile) && options.phase === "pre") {
    throw checkpointError("CLI004", "Checkpoint preflight requires a supported --profile.");
  }
  if (options.phase === "pre" && options.checkpointId !== undefined) {
    throw checkpointError("CLI005", "Checkpoint preflight does not accept --checkpoint-id.");
  }
  if (options.phase === "post" && !options.checkpointId) {
    throw checkpointError("CLI002", "Checkpoint postflight requires --checkpoint-id.");
  }
  if (options.phase === "post" && options.profile !== undefined) {
    throw checkpointError("CLI005", "Checkpoint postflight does not accept --profile.");
  }
  if (options.phase === "post" && options.force) {
    throw checkpointError("CLI005", "Checkpoint postflight does not accept --force.");
  }
}

export async function checkpointWorkspace(options, hooks = {}) {
  validateInvocation(options);
  let environment = await resolveCheckpointEnvironment(options);
  if (options.phase === "pre") {
    const reservation = await reservePre(environment, hooks);
    try {
      const published = await publishPre({
        options,
        profile: options.profile,
        force: options.force,
        reservation,
        hooks,
      });
      return resultFromStamp({
        phase: "pre",
        profile: options.profile,
        checkpointId: published.checkpointId,
        sequence: published.sequence,
        environment: published.environment,
        stamp: published.stamp,
        validationMode: published.validationMode,
        reasons: published.reasons,
        condition: reservation.condition,
      });
    } catch (error) {
      await recordIncomplete(environment, reservation.operation.operationId, error, hooks);
      throw error;
    }
  }

  const reservation = await reservePost(environment, options.checkpointId, hooks);
  if (reservation.completed) {
    const parts = checkpointIdParts(options.checkpointId);
    return resultFromStamp({
      phase: "post",
      profile: reservation.completed.profile,
      checkpointId: options.checkpointId,
      sequence: parts.sequence,
      environment,
      stamp: stampFromCompleted(reservation.completed),
      validationMode: "reused",
      reasons: ["idempotent_retry"],
      condition: reservation.condition,
      idempotent: true,
      disposition: reservation.completed.disposition,
    });
  }
  try {
    const published = await publishPost({
      options,
      checkpointId: options.checkpointId,
      reservation,
      hooks,
    });
    const stamp = stampFromCompleted(published.completed);
    return resultFromStamp({
      phase: "post",
      profile: published.completed.profile,
      checkpointId: options.checkpointId,
      sequence: published.completed.sequence,
      environment: published.environment,
      stamp,
      validationMode: published.validationMode ?? "reused",
      reasons: published.reasons ?? ["idempotent_retry"],
      condition: reservation.condition,
      idempotent: published.idempotent,
      disposition: published.completed.disposition,
    });
  } catch (error) {
    error.checkpointId = options.checkpointId;
    await recordIncomplete(environment, reservation.operation.operationId, error, hooks);
    throw error;
  }
}
