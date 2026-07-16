import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

import { writeBufferAtomic } from "./atomic-file.mjs";
import { SyncoraError } from "./cli.mjs";
import {
  assertStableDirectoryBinding,
  captureStableDirectoryBinding,
  inspectRecoveryGuard,
  readBoundedLockRecordBytes,
  recoveryGuardPath,
  releaseRecoveryGuard,
  tryAcquireRecoveryGuard,
} from "./lock-recovery-guard.mjs";
import {
  isWithin,
  readBoundedRegularFileIfPresent,
} from "./workspace.mjs";

export const CHECKPOINT_STATE_SCHEMA_VERSION = 2;
export const CHECKPOINT_STATE_FILE = "checkpoint-state.json";
export const CHECKPOINT_STATE_MAX_BYTES = 65_536;
export const CHECKPOINT_MAX_PENDING = 64;
export const CHECKPOINT_MAX_COMPLETED = 64;
export const CHECKPOINT_MAX_IN_FLIGHT = 32;
export const CHECKPOINT_IN_FLIGHT_MAX_AGE_MS = 3_600_000;
export const CHECKPOINT_LOCK_POLICY = Object.freeze({
  timeoutMs: 30_000,
  pollMs: 25,
  staleMs: 300_000,
});

const SHA_PATTERN = /^sha256:[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHECKPOINT_ID_PATTERN = /^cp1\.[0-9a-f]{16}\.[0-9a-f]{16}\.[0-9a-f]{32}\.[0-9a-z]+\.[0-9a-f]{32}$/;

function validIso(value) {
  if (typeof value !== "string" || value.length > 40) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function validCount(value, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function validSha(value) {
  return typeof value === "string" && SHA_PATTERN.test(value);
}

function validCheckpointId(value) {
  return typeof value === "string" && CHECKPOINT_ID_PATTERN.test(value);
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected) {
  if (!plainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function validProfile(value) {
  return ["checkpoint", "context", "capture", "maintenance"].includes(value);
}

function validPending(item, activationSequence) {
  return (
    plainObject(item) &&
    exactKeys(item, [
      "id",
      "sequence",
      "profile",
      "createdAt",
      "baselineSourceFingerprint",
      "baselineChangeFingerprint",
    ]) &&
    validCheckpointId(item.id) &&
    validCount(item.sequence, activationSequence) &&
    item.sequence > 0 &&
    validProfile(item.profile) &&
    validIso(item.createdAt) &&
    validSha(item.baselineSourceFingerprint) &&
    validSha(item.baselineChangeFingerprint)
  );
}

function validCompleted(item, activationSequence) {
  return (
    plainObject(item) &&
    exactKeys(item, [
      "id",
      "sequence",
      "profile",
      "completedAt",
      "status",
      "disposition",
      "graphValid",
      "graphRevision",
      "sourceFingerprint",
      "changeFingerprint",
      "findingsDigest",
      "errors",
      "warnings",
      "runtimeIdentity",
      "validatorPolicyIdentity",
      "configIdentity",
      "workspaceIdentity",
      "graphRootIdentity",
    ]) &&
    validCheckpointId(item.id) &&
    validCount(item.sequence, activationSequence) &&
    item.sequence > 0 &&
    validProfile(item.profile) &&
    validIso(item.completedAt) &&
    ["ok", "degraded"].includes(item.status) &&
    ["durable-change", "no-change", "unattributed-change"].includes(
      item.disposition,
    ) &&
    item.status === (item.graphValid ? "ok" : "degraded") &&
    typeof item.graphValid === "boolean" &&
    validSha(item.graphRevision) &&
    validSha(item.sourceFingerprint) &&
    validSha(item.changeFingerprint) &&
    validSha(item.findingsDigest) &&
    validSha(item.runtimeIdentity) &&
    validSha(item.validatorPolicyIdentity) &&
    validSha(item.configIdentity) &&
    validSha(item.workspaceIdentity) &&
    validSha(item.graphRootIdentity) &&
    validCount(item.errors, 1_000_000) &&
    validCount(item.warnings, 1_000_000)
  );
}

function validInFlight(item) {
  return (
    plainObject(item) &&
    exactKeys(item, [
      "operationId",
      "phase",
      "checkpointId",
      "recovery",
      "startedAt",
      "pid",
    ]) &&
    UUID_PATTERN.test(item.operationId ?? "") &&
    ["pre", "post"].includes(item.phase) &&
    (item.checkpointId === null || validCheckpointId(item.checkpointId)) &&
    [null, "missing", "corrupt", "legacy"].includes(item.recovery) &&
    validIso(item.startedAt) &&
    Number.isInteger(item.pid) &&
    item.pid > 0
  );
}

function validStamp(stamp, activationSequence) {
  if (stamp === null) return true;
  return (
    plainObject(stamp) &&
    exactKeys(stamp, [
      "completedAt",
      "activationSequence",
      "runtimeIdentity",
      "validatorPolicyIdentity",
      "configIdentity",
      "workspaceIdentity",
      "graphRootIdentity",
      "sourceFingerprint",
      "changeFingerprint",
      "graphRevision",
      "findingsDigest",
      "graphValid",
      "errors",
      "warnings",
    ]) &&
    validIso(stamp.completedAt) &&
    validCount(stamp.activationSequence, activationSequence) &&
    validSha(stamp.runtimeIdentity) &&
    validSha(stamp.validatorPolicyIdentity) &&
    validSha(stamp.configIdentity) &&
    validSha(stamp.workspaceIdentity) &&
    validSha(stamp.graphRootIdentity) &&
    validSha(stamp.sourceFingerprint) &&
    validSha(stamp.changeFingerprint) &&
    validSha(stamp.graphRevision) &&
    validSha(stamp.findingsDigest) &&
    typeof stamp.graphValid === "boolean" &&
    validCount(stamp.errors, 1_000_000) &&
    validCount(stamp.warnings, 1_000_000)
  );
}

function validIncomplete(value) {
  return (
    value === null ||
    (plainObject(value) &&
      exactKeys(value, ["at", "code"]) &&
      validIso(value.at) &&
      typeof value.code === "string" &&
      value.code.length >= 1 &&
      value.code.length <= 64 &&
      /^[A-Z0-9_]+$/.test(value.code))
  );
}

function uniqueIds(items) {
  return new Set(items.map((item) => item.id)).size === items.length;
}

export function validateCheckpointState(value) {
  if (!plainObject(value)) return false;
  if (
    !exactKeys(value, [
      "schemaVersion",
      "epoch",
      "runtimeIdentity",
      "validatorPolicyIdentity",
      "configIdentity",
      "workspaceIdentity",
      "graphRootIdentity",
      "activationSequence",
      "lastCheckpointAt",
      "validationStamp",
      "lastIncomplete",
      "pending",
      "completed",
      "inFlight",
    ]) ||
    value.schemaVersion !== CHECKPOINT_STATE_SCHEMA_VERSION ||
    !UUID_PATTERN.test(value.epoch ?? "") ||
    !validSha(value.runtimeIdentity) ||
    !validSha(value.validatorPolicyIdentity) ||
    !validSha(value.configIdentity) ||
    !validSha(value.workspaceIdentity) ||
    !validSha(value.graphRootIdentity) ||
    !validCount(value.activationSequence) ||
    !(value.lastCheckpointAt === null || validIso(value.lastCheckpointAt)) ||
    !validStamp(value.validationStamp, value.activationSequence) ||
    !validIncomplete(value.lastIncomplete) ||
    !Array.isArray(value.pending) ||
    value.pending.length > CHECKPOINT_MAX_PENDING ||
    !value.pending.every((item) => validPending(item, value.activationSequence)) ||
    !uniqueIds(value.pending) ||
    !Array.isArray(value.completed) ||
    value.completed.length > CHECKPOINT_MAX_COMPLETED ||
    !value.completed.every((item) => validCompleted(item, value.activationSequence)) ||
    !uniqueIds(value.completed) ||
    !Array.isArray(value.inFlight) ||
    value.inFlight.length > CHECKPOINT_MAX_IN_FLIGHT ||
    !value.inFlight.every(validInFlight) ||
    new Set(value.inFlight.map((item) => item.operationId)).size !== value.inFlight.length
  ) {
    return false;
  }
  const pendingIds = new Set(value.pending.map((item) => item.id));
  return !value.completed.some((item) => pendingIds.has(item.id));
}

export function createCheckpointState(environment) {
  return {
    schemaVersion: CHECKPOINT_STATE_SCHEMA_VERSION,
    epoch: randomUUID(),
    runtimeIdentity: environment.runtimeIdentity,
    validatorPolicyIdentity: environment.validatorPolicyIdentity,
    configIdentity: environment.configIdentity,
    workspaceIdentity: environment.workspaceIdentity,
    graphRootIdentity: environment.graphRootIdentity,
    activationSequence: 0,
    lastCheckpointAt: null,
    validationStamp: null,
    lastIncomplete: null,
    pending: [],
    completed: [],
    inFlight: [],
  };
}

const CAPACITY_ISO = "9999-12-31T23:59:59.999Z";
const CAPACITY_SHA = `sha256:${"f".repeat(64)}`;
const CAPACITY_SEQUENCE = Number.MAX_SAFE_INTEGER;
const CAPACITY_CHECKPOINT_ID = [
  "cp1",
  "f".repeat(16),
  "f".repeat(16),
  "f".repeat(32),
  CAPACITY_SEQUENCE.toString(36),
  "f".repeat(32),
].join(".");

function capacityValidationStamp() {
  return {
    completedAt: CAPACITY_ISO,
    activationSequence: CAPACITY_SEQUENCE,
    runtimeIdentity: CAPACITY_SHA,
    validatorPolicyIdentity: CAPACITY_SHA,
    configIdentity: CAPACITY_SHA,
    workspaceIdentity: CAPACITY_SHA,
    graphRootIdentity: CAPACITY_SHA,
    sourceFingerprint: CAPACITY_SHA,
    changeFingerprint: CAPACITY_SHA,
    graphRevision: CAPACITY_SHA,
    findingsDigest: CAPACITY_SHA,
    graphValid: false,
    errors: 1_000_000,
    warnings: 1_000_000,
  };
}

function capacityPendingRecord() {
  return {
    id: CAPACITY_CHECKPOINT_ID,
    sequence: CAPACITY_SEQUENCE,
    profile: "maintenance",
    createdAt: CAPACITY_ISO,
    baselineSourceFingerprint: CAPACITY_SHA,
    baselineChangeFingerprint: CAPACITY_SHA,
  };
}

function capacityInFlightRecord() {
  return {
    operationId: "ffffffff-ffff-4fff-bfff-ffffffffffff",
    phase: "post",
    checkpointId: CAPACITY_CHECKPOINT_ID,
    recovery: "corrupt",
    startedAt: CAPACITY_ISO,
    pid: CAPACITY_SEQUENCE,
  };
}

function serializedStateBytes(state) {
  return Buffer.byteLength(`${JSON.stringify(state)}\n`, "utf8");
}

function reservedCapacityBytes(state) {
  return serializedStateBytes({
    ...state,
    activationSequence: CAPACITY_SEQUENCE,
    lastCheckpointAt: CAPACITY_ISO,
    validationStamp: capacityValidationStamp(),
    lastIncomplete: { at: CAPACITY_ISO, code: "X".repeat(64) },
    pending: Array.from(
      { length: CHECKPOINT_MAX_PENDING },
      capacityPendingRecord,
    ),
    inFlight: Array.from(
      { length: CHECKPOINT_MAX_IN_FLIGHT },
      capacityInFlightRecord,
    ),
  });
}

function compactCompletedForCapacity(state) {
  while (
    state.completed.length > 0 &&
    reservedCapacityBytes(state) > CHECKPOINT_STATE_MAX_BYTES
  ) {
    state.completed.shift();
  }
  const reservedBytes = reservedCapacityBytes(state);
  if (reservedBytes > CHECKPOINT_STATE_MAX_BYTES) {
    throw new SyncoraError(
      "STATE001",
      "Checkpoint state schema cannot reserve its bounded pending and in-flight capacity.",
      { bytes: reservedBytes, limit: CHECKPOINT_STATE_MAX_BYTES },
    );
  }
}

async function metadataOrNull(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function resolveCheckpointStorage(workspaceRoot) {
  const syncoraRoot = join(workspaceRoot, ".syncora");
  const metadata = await metadataOrNull(syncoraRoot);
  if (!metadata?.isDirectory() || metadata.isSymbolicLink()) {
    throw new SyncoraError(
      "STATE001",
      "The .syncora runtime directory is missing or unsafe.",
    );
  }
  const resolvedSyncoraRoot = await realpath(syncoraRoot);
  if (!isWithin(workspaceRoot, resolvedSyncoraRoot)) {
    throw new SyncoraError("STATE001", "The .syncora runtime directory escapes the workspace.");
  }
  const syncoraBinding = await captureStableDirectoryBinding(
    resolvedSyncoraRoot,
    {
      code: "STATE001",
      label: "The .syncora runtime directory",
      containmentRoot: workspaceRoot,
    },
  );

  const locksRoot = join(resolvedSyncoraRoot, "locks");
  try {
    await mkdir(locksRoot);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const locksMetadata = await metadataOrNull(locksRoot);
  if (!locksMetadata?.isDirectory() || locksMetadata.isSymbolicLink()) {
    throw new SyncoraError("LOCK001", "The Syncora lock directory is unsafe.");
  }
  const resolvedLocksRoot = await realpath(locksRoot);
  if (!isWithin(resolvedSyncoraRoot, resolvedLocksRoot)) {
    throw new SyncoraError("LOCK001", "The Syncora lock directory escapes its runtime root.");
  }
  await assertStableDirectoryBinding(syncoraBinding, {
    code: "STATE001",
    label: "The .syncora runtime directory",
  });
  const locksBinding = await captureStableDirectoryBinding(resolvedLocksRoot, {
    code: "LOCK001",
    label: "The Syncora lock directory",
    containmentRoot: resolvedSyncoraRoot,
  });

  return {
    workspaceRoot,
    syncoraRoot: resolvedSyncoraRoot,
    statePath: join(resolvedSyncoraRoot, CHECKPOINT_STATE_FILE),
    syncoraBinding,
    locksRoot: resolvedLocksRoot,
    locksBinding,
    lockPath: join(resolvedLocksRoot, "checkpoint.lock"),
    recoveryGuardPath: recoveryGuardPath(
      join(resolvedLocksRoot, "checkpoint.lock"),
    ),
  };
}

async function assertCheckpointStateStorage(storage) {
  await assertStableDirectoryBinding(storage.syncoraBinding, {
    code: "STATE001",
    label: "The .syncora runtime directory",
  });
}

async function assertCheckpointLockStorage(storage) {
  await assertCheckpointStateStorage(storage);
  await assertStableDirectoryBinding(storage.locksBinding, {
    code: "LOCK001",
    label: "The Syncora lock directory",
  });
}

export async function readCheckpointState(storage) {
  await assertCheckpointStateStorage(storage);
  const metadata = await metadataOrNull(storage.statePath);
  if (!metadata) return { condition: "missing", state: null };
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new SyncoraError(
      "STATE001",
      "Checkpoint state is not a safe regular file.",
    );
  }
  if (metadata.size > CHECKPOINT_STATE_MAX_BYTES) {
    // This is derived state, so a plainly observed oversized regular file can
    // be rebuilt without ever reading its contents. Unsafe types and races
    // still fail closed through the bounded reader below.
    return { condition: "corrupt", state: null };
  }
  try {
    const buffer = await readBoundedRegularFileIfPresent(storage.statePath, {
      containmentRoot: storage.syncoraRoot,
      maximumBytes: CHECKPOINT_STATE_MAX_BYTES,
      code: "STATE001",
      label: "Checkpoint state",
      allowTransientMissing: true,
    });
    await assertCheckpointStateStorage(storage);
    if (buffer === null) return { condition: "missing", state: null };
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    const parsed = JSON.parse(text);
    if (
      plainObject(parsed) &&
      Number.isInteger(parsed.schemaVersion) &&
      parsed.schemaVersion > CHECKPOINT_STATE_SCHEMA_VERSION
    ) {
      throw new SyncoraError(
        "SCHEMA001",
        `Checkpoint state schema ${parsed.schemaVersion} is newer than supported schema ${CHECKPOINT_STATE_SCHEMA_VERSION}.`,
      );
    }
    if (
      plainObject(parsed) &&
      Number.isInteger(parsed.schemaVersion) &&
      parsed.schemaVersion < CHECKPOINT_STATE_SCHEMA_VERSION
    ) {
      return { condition: "legacy", state: null, schemaVersion: parsed.schemaVersion };
    }
    return validateCheckpointState(parsed)
      ? { condition: "loaded", state: parsed }
      : { condition: "corrupt", state: null };
  } catch (error) {
    if (error instanceof SyncoraError) throw error;
    return { condition: "corrupt", state: null };
  }
}

export async function writeCheckpointState(storage, state) {
  await assertCheckpointStateStorage(storage);
  if (!validateCheckpointState(state)) {
    throw new SyncoraError("STATE001", "Refusing to publish invalid checkpoint state.");
  }
  compactCompletedForCapacity(state);
  const bytes = Buffer.from(`${JSON.stringify(state)}\n`, "utf8");
  if (bytes.length > CHECKPOINT_STATE_MAX_BYTES) {
    throw new SyncoraError("STATE001", "Checkpoint state exceeds its bounded byte limit.", {
      bytes: bytes.length,
      limit: CHECKPOINT_STATE_MAX_BYTES,
    });
  }
  const existing = await metadataOrNull(storage.statePath);
  if (existing?.isDirectory()) {
    throw new SyncoraError("STATE001", "Checkpoint state path is a directory.");
  }
  if (existing?.isSymbolicLink()) {
    throw new SyncoraError("STATE001", "Checkpoint state path is a symbolic link.");
  } else if (existing && !existing.isFile()) {
    throw new SyncoraError("STATE001", "Checkpoint state path is unsafe.");
  }
  await writeBufferAtomic(storage.statePath, bytes, 0o600);
  await assertCheckpointStateStorage(storage);
}

async function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function validCheckpointLockRecord(value) {
  return (
    exactKeys(value, ["schemaVersion", "token", "pid", "acquiredAt"]) &&
    value.schemaVersion === 1 &&
    UUID_PATTERN.test(value.token ?? "") &&
    Number.isInteger(value.pid) &&
    value.pid > 0 &&
    validIso(value.acquiredAt)
  );
}

function parseCheckpointLockRecord(bytes) {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value = JSON.parse(text);
    return validCheckpointLockRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function sameLockIdentity(left, right) {
  if (
    !left?.isFile() ||
    !right?.isFile() ||
    left.isSymbolicLink() ||
    right.isSymbolicLink()
  ) {
    return false;
  }
  if (
    left.dev !== 0 ||
    left.ino !== 0 ||
    right.dev !== 0 ||
    right.ino !== 0
  ) {
    return left.dev === right.dev && left.ino === right.ino;
  }
  return (
    left.mode === right.mode &&
    left.size === right.size &&
    left.birthtimeMs === right.birthtimeMs &&
    left.mtimeMs === right.mtimeMs
  );
}

async function inspectCheckpointLock(storage) {
  await assertCheckpointLockStorage(storage);
  const bytes = await readBoundedLockRecordBytes(storage.lockPath, {
    containmentRoot: storage.locksRoot,
    code: "LOCK001",
    label: "Checkpoint lock",
    allowTransientMissing: true,
    containmentBinding: storage.locksBinding,
  });
  await assertCheckpointLockStorage(storage);
  if (bytes === null) return null;
  const metadata = await metadataOrNull(storage.lockPath);
  if (!metadata) return null;
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new SyncoraError("LOCK001", "Checkpoint lock path is unsafe.");
  }
  return {
    bytes,
    metadata,
    record: parseCheckpointLockRecord(bytes),
  };
}

async function staleCheckpointLock(observation, policy) {
  if (Date.now() - observation.metadata.mtimeMs < policy.staleMs) return false;
  return !(
    Number.isInteger(observation.record?.pid) &&
    observation.record.pid > 0 &&
    (await processAlive(observation.record.pid))
  );
}

function sameLockObservation(left, right) {
  return (
    left !== null &&
    right !== null &&
    sameLockIdentity(left.metadata, right.metadata) &&
    left.bytes.equals(right.bytes)
  );
}

async function retireStaleCheckpointLock(storage, observation, policy, hooks) {
  if (hooks.beforeStaleRetire) await hooks.beforeStaleRetire();
  const finalObservation = await inspectCheckpointLock(storage);
  if (
    !sameLockObservation(observation, finalObservation) ||
    !(await staleCheckpointLock(finalObservation, policy))
  ) {
    return false;
  }

  const retiredPath = join(
    storage.locksRoot,
    `.checkpoint.lock.stale-${randomUUID()}`,
  );
  await assertCheckpointLockStorage(storage);
  try {
    await rename(storage.lockPath, retiredPath);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw new SyncoraError("LOCK001", "Unable to retire the stale checkpoint lock.", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  const retiredBytes = await readBoundedLockRecordBytes(retiredPath, {
    containmentRoot: storage.locksRoot,
    code: "LOCK001",
    label: "Retired checkpoint lock",
    allowTransientMissing: false,
    containmentBinding: storage.locksBinding,
  });
  if (!retiredBytes?.equals(finalObservation.bytes)) {
    throw new SyncoraError(
      "LOCK001",
      `Retired checkpoint lock identity could not be proven: ${retiredPath}`,
    );
  }
  await rm(retiredPath);
  await assertCheckpointLockStorage(storage);
  if (hooks.afterStaleRetire) await hooks.afterStaleRetire();
  return true;
}

async function tryCreateCheckpointLock(storage) {
  const token = randomUUID();
  const payload = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    token,
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
  })}\n`, "utf8");
  let handle;
  try {
    await assertCheckpointLockStorage(storage);
    handle = await open(storage.lockPath, "wx", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST" || error?.code === "ENOENT") return null;
    throw new SyncoraError("LOCK001", "Unable to create the checkpoint lock.", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    await handle.writeFile(payload);
    await handle.sync();
    const opened = await handle.stat();
    const current = await lstat(storage.lockPath);
    await assertCheckpointLockStorage(storage);
    if (!sameLockIdentity(opened, current)) {
      throw new SyncoraError(
        "LOCK001",
        "Checkpoint lock ownership changed during exclusive creation.",
      );
    }
  } catch (error) {
    await handle.close().catch(() => undefined);
    // Leave an incompletely published lock in place. The recovery guard makes
    // removing it by an uncertain path less safe than failing closed.
    if (error instanceof SyncoraError) throw error;
    throw new SyncoraError("LOCK001", "Unable to publish the checkpoint lock.", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  await handle.close();
  return { token };
}

function validLockPolicy(policy) {
  return (
    Number.isFinite(policy.timeoutMs) &&
    policy.timeoutMs >= 0 &&
    Number.isFinite(policy.pollMs) &&
    policy.pollMs >= 1 &&
    Number.isFinite(policy.staleMs) &&
    policy.staleMs >= 1
  );
}

function checkpointLockTimeout(policy, storage, blocker, guardObservation = null) {
  if (blocker === "recovery-guard") {
    const owner = guardObservation?.record
      ? ` (owner PID ${guardObservation.record.pid}, created ${guardObservation.record.createdAt})`
      : " (record is incomplete or malformed)";
    return new SyncoraError(
      "LOCK002",
      `Timed out after ${policy.timeoutMs}ms waiting for the checkpoint recovery guard ${storage.recoveryGuardPath}${owner}. The guard is never recovered automatically; verify that no lock operation is active before removing an orphaned guard.`,
    );
  }
  return new SyncoraError(
    "LOCK002",
    `Timed out after ${policy.timeoutMs}ms waiting for the checkpoint lock.`,
  );
}

async function acquireCheckpointRecoveryGuard(storage, policy, started, hooks) {
  while (true) {
    await assertCheckpointLockStorage(storage);
    const guard = await tryAcquireRecoveryGuard({
      lockPath: storage.lockPath,
      containmentRoot: storage.locksRoot,
      code: "LOCK001",
      label: "checkpoint recovery guard",
      containmentBinding: storage.locksBinding,
    });
    if (guard) {
      if (hooks.afterRecoveryGuardAcquired) {
        await hooks.afterRecoveryGuardAcquired();
      }
      return guard;
    }
    const observation = await inspectRecoveryGuard({
      lockPath: storage.lockPath,
      containmentRoot: storage.locksRoot,
      code: "LOCK001",
      label: "Checkpoint recovery guard",
      containmentBinding: storage.locksBinding,
    });
    if (hooks.afterRecoveryGuardBlocked) {
      await hooks.afterRecoveryGuardBlocked(observation);
    }
    if (performance.now() - started >= policy.timeoutMs) {
      throw checkpointLockTimeout(
        policy,
        storage,
        "recovery-guard",
        observation,
      );
    }
    await delay(policy.pollMs);
  }
}

async function acquireLock(storage, overrides = {}) {
  const { hooks = {}, ...timingOverrides } = overrides;
  const policy = { ...CHECKPOINT_LOCK_POLICY, ...timingOverrides };
  if (!validLockPolicy(policy)) {
    throw new SyncoraError("LOCK001", "Checkpoint lock policy is invalid.");
  }
  const started = performance.now();
  while (true) {
    const guard = await acquireCheckpointRecoveryGuard(
      storage,
      policy,
      started,
      hooks,
    );
    let ownership = null;
    let blocker = "checkpoint-lock";
    let operationError;
    try {
      const observation = await inspectCheckpointLock(storage);
      if (observation === null) {
        ownership = await tryCreateCheckpointLock(storage);
      } else if (
        (await staleCheckpointLock(observation, policy)) &&
        (await retireStaleCheckpointLock(storage, observation, policy, hooks))
      ) {
        ownership = await tryCreateCheckpointLock(storage);
      }
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      try {
        await releaseRecoveryGuard(guard, {
          code: "LOCK001",
          label: "checkpoint recovery guard",
        });
        await assertCheckpointLockStorage(storage);
      } catch (releaseError) {
        if (operationError === undefined) throw releaseError;
      }
    }
    if (ownership) return ownership;
    if (performance.now() - started >= policy.timeoutMs) {
      throw checkpointLockTimeout(policy, storage, blocker);
    }
    await delay(policy.pollMs);
  }
}

async function releaseLock(storage, ownership, overrides = {}) {
  const { hooks = {}, ...timingOverrides } = overrides;
  const policy = { ...CHECKPOINT_LOCK_POLICY, ...timingOverrides };
  if (!validLockPolicy(policy)) {
    throw new SyncoraError("LOCK001", "Checkpoint lock policy is invalid.");
  }
  const guard = await acquireCheckpointRecoveryGuard(
    storage,
    policy,
    performance.now(),
    hooks,
  );
  let operationError;
  try {
    const observation = await inspectCheckpointLock(storage);
    if (observation?.record?.token !== ownership.token) {
      throw new SyncoraError(
        "LOCK001",
        "Checkpoint lock ownership changed before release.",
      );
    }
    await assertCheckpointLockStorage(storage);
    await rm(storage.lockPath);
    await assertCheckpointLockStorage(storage);
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      await releaseRecoveryGuard(guard, {
        code: "LOCK001",
        label: "checkpoint recovery guard",
      });
      await assertCheckpointLockStorage(storage);
    } catch (releaseError) {
      if (operationError === undefined) throw releaseError;
    }
  }
}

export async function withCheckpointLock(storage, action, overrides = {}) {
  const ownership = await acquireLock(storage, overrides);
  let operationError;
  try {
    return await action();
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      await releaseLock(storage, ownership, overrides);
    } catch (releaseError) {
      if (operationError === undefined) throw releaseError;
    }
  }
}

export function checkpointIdParts(value) {
  if (!validCheckpointId(value)) return null;
  const [, workspacePrefix, rootPrefix, epoch, sequenceText] = value.split(".");
  const sequence = Number.parseInt(sequenceText, 36);
  if (!Number.isSafeInteger(sequence) || sequence < 1) return null;
  return { workspacePrefix, rootPrefix, epoch, sequence };
}

export function shaIdentity(namespace, value) {
  const digest = createHash("sha256")
    .update(`${namespace}\n`, "utf8")
    .update(value, "utf8")
    .digest("hex");
  return `sha256:${digest}`;
}

export function createCheckpointId({
  workspaceIdentity,
  graphRootIdentity,
  epoch,
  sequence,
  runtimeIdentity,
}) {
  const workspaceDigest = workspaceIdentity.slice("sha256:".length);
  const rootDigest = graphRootIdentity.slice("sha256:".length);
  const epochCompact = epoch.replaceAll("-", "").toLowerCase();
  const sequenceText = sequence.toString(36);
  const binding = createHash("sha256")
    .update("syncora-checkpoint-id-v1\n")
    .update(workspaceIdentity)
    .update("\n")
    .update(graphRootIdentity)
    .update("\n")
    .update(epoch)
    .update("\n")
    .update(String(sequence))
    .update("\n")
    .update(runtimeIdentity)
    .digest("hex")
    .slice(0, 32);
  return `cp1.${workspaceDigest.slice(0, 16)}.${rootDigest.slice(0, 16)}.${epochCompact}.${sequenceText}.${binding}`;
}

export function checkpointIdMatchesEnvironment(id, environment) {
  const parts = checkpointIdParts(id);
  if (!parts) return { ok: false, reason: "malformed" };
  if (parts.workspacePrefix !== environment.workspaceIdentity.slice("sha256:".length, 23)) {
    return { ok: false, reason: "workspace" };
  }
  if (parts.rootPrefix !== environment.graphRootIdentity.slice("sha256:".length, 23)) {
    return { ok: false, reason: "root" };
  }
  return { ok: true, parts };
}
