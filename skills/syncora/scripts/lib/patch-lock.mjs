import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { performance } from "node:perf_hooks";

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

const LOCK_SCHEMA_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_MS = 25;
const DEFAULT_STALE_MS = 5 * 60 * 1_000;

function lockError(message) {
  return new SyncoraError("PATCH005", message);
}

function lockPaths(workspacePath) {
  const runtimeDirectory = join(workspacePath, ".syncora");
  const directory = join(runtimeDirectory, "locks");
  return {
    workspacePath,
    runtimeDirectory,
    directory,
    path: join(directory, "agent-patcher.lock"),
    recoveryGuardPath: recoveryGuardPath(
      join(directory, "agent-patcher.lock"),
    ),
  };
}

function assertContained(workspacePath, targetPath) {
  const targetRelative = relative(workspacePath, targetPath);
  if (
    targetRelative === ".." ||
    targetRelative.startsWith(`..${sep}`) ||
    isAbsolute(targetRelative)
  ) {
    throw lockError(`Patch lock path escapes the workspace: ${targetPath}`);
  }
  return targetRelative;
}

async function metadataIfPresent(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function ensureSafeLockDirectory(workspacePath, directoryPath) {
  const targetRelative = assertContained(workspacePath, directoryPath);
  let currentPath = workspacePath;
  for (const segment of targetRelative.split(sep).filter(Boolean)) {
    currentPath = join(currentPath, segment);
    let metadata = await metadataIfPresent(currentPath);
    if (metadata === null) {
      try {
        await mkdir(currentPath);
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
      metadata = await metadataIfPresent(currentPath);
    }
    if (
      metadata === null ||
      metadata.isSymbolicLink() ||
      !metadata.isDirectory()
    ) {
      throw lockError(
        `Patch lock directory contains a symlink, junction, or unexpected file type: ${currentPath}`,
      );
    }
  }
}

async function capturePatchLockBindings(workspacePath, paths) {
  const runtimeBinding = await captureStableDirectoryBinding(
    paths.runtimeDirectory,
    {
      code: "PATCH005",
      label: "Patch runtime directory",
      containmentRoot: workspacePath,
    },
  );
  const directoryBinding = await captureStableDirectoryBinding(paths.directory, {
    code: "PATCH005",
    label: "Patch lock directory",
    containmentRoot: paths.runtimeDirectory,
  });
  await assertStableDirectoryBinding(runtimeBinding, {
    code: "PATCH005",
    label: "Patch runtime directory",
  });
  return { ...paths, runtimeBinding, directoryBinding };
}

async function assertPatchLockBindings(paths) {
  await assertStableDirectoryBinding(paths.runtimeBinding, {
    code: "PATCH005",
    label: "Patch runtime directory",
  });
  await assertStableDirectoryBinding(paths.directoryBinding, {
    code: "PATCH005",
    label: "Patch lock directory",
  });
}

function validLockRecord(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.schemaVersion === LOCK_SCHEMA_VERSION &&
    typeof value.token === "string" &&
    value.token.length >= 16 &&
    value.token.length <= 128 &&
    Number.isInteger(value.pid) &&
    value.pid > 0 &&
    typeof value.createdAt === "string" &&
    Number.isFinite(Date.parse(value.createdAt))
  );
}

async function inspectExistingLock(paths) {
  const lockPath = paths.path;
  const directoryPath = dirname(lockPath);
  await assertPatchLockBindings(paths);
  const raw = await readBoundedLockRecordBytes(lockPath, {
    containmentRoot: directoryPath,
    code: "PATCH005",
    label: "Patch lock",
    allowTransientMissing: true,
    containmentBinding: paths.directoryBinding,
  });
  await assertPatchLockBindings(paths);
  if (raw === null) return null;
  const metadata = await metadataIfPresent(lockPath);
  if (metadata === null) return null;
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw lockError(
      `Patch lock is a symlink, junction, or unexpected file type: ${lockPath}`,
    );
  }

  let record = null;
  try {
    const candidate = JSON.parse(raw.toString("utf8"));
    if (validLockRecord(candidate)) record = candidate;
  } catch {
    // A creator can be observed between exclusive creation and its first write.
  }
  return { metadata, raw, record };
}

function processIsAlive(pid) {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function staleLock(observation, nowMs, staleMs) {
  const createdMs = observation.record
    ? Date.parse(observation.record.createdAt)
    : observation.metadata.mtimeMs;
  const ageMs = nowMs - createdMs;
  if (!Number.isFinite(ageMs) || ageMs < staleMs) return false;
  return observation.record === null || !processIsAlive(observation.record.pid);
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

function sameLockObservation(left, right) {
  return (
    left !== null &&
    right !== null &&
    sameLockIdentity(left.metadata, right.metadata) &&
    left.raw.equals(right.raw)
  );
}

async function retireStaleLock(
  paths,
  observation,
  staleMs,
  hooks,
) {
  const { directory: directoryPath, path: lockPath } = paths;
  if (hooks.beforeStaleRetire) await hooks.beforeStaleRetire();
  const finalObservation = await inspectExistingLock(paths);
  if (
    !sameLockObservation(observation, finalObservation) ||
    !staleLock(finalObservation, Date.now(), staleMs)
  ) {
    return false;
  }
  const retiredPath = join(
    directoryPath,
    `.agent-patcher.lock.stale-${randomUUID()}`,
  );
  await assertPatchLockBindings(paths);
  try {
    await rename(lockPath, retiredPath);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  const retiredBytes = await readBoundedLockRecordBytes(retiredPath, {
    containmentRoot: directoryPath,
    code: "PATCH005",
    label: "Retired patch lock",
    allowTransientMissing: false,
    containmentBinding: paths.directoryBinding,
  });
  if (!retiredBytes?.equals(finalObservation.raw)) {
    throw lockError(
      `Retired patch lock identity could not be proven: ${retiredPath}`,
    );
  }
  await rm(retiredPath);
  await assertPatchLockBindings(paths);
  if (hooks.afterStaleRetire) await hooks.afterStaleRetire();
  return true;
}

async function tryCreateLock(paths, token, nowMs) {
  const lockPath = paths.path;
  let handle;
  try {
    await assertPatchLockBindings(paths);
    handle = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST" || error?.code === "ENOENT") return false;
    throw error;
  }

  const record = {
    schemaVersion: LOCK_SCHEMA_VERSION,
    token,
    pid: process.pid,
    createdAt: new Date(nowMs).toISOString(),
  };
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
    await handle.sync();
    const opened = await handle.stat();
    const current = await lstat(lockPath);
    await assertPatchLockBindings(paths);
    if (!sameLockIdentity(opened, current)) {
      throw lockError(
        `Patch lock ownership changed during exclusive creation: ${lockPath}`,
      );
    }
  } catch (error) {
    await handle.close().catch(() => undefined);
    // An incompletely published lock is left in place. Removing by path after
    // ownership became uncertain could delete a replacement.
    throw error;
  }
  await handle.close();
  return true;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function patchGuardTimeout(paths, timeoutMs, observation) {
  const owner = observation?.record
    ? ` (owner PID ${observation.record.pid}, created ${observation.record.createdAt})`
    : " (record is incomplete or malformed)";
  return lockError(
    `Timed out after ${timeoutMs}ms waiting for the patch-lock recovery guard ${paths.recoveryGuardPath}${owner}. The guard is never recovered automatically; verify that no patch operation is active before removing an orphaned guard.`,
  );
}

async function acquirePatchRecoveryGuard(
  workspacePath,
  paths,
  timeoutMs,
  pollMs,
  startedAt,
  hooks,
) {
  while (true) {
    await ensureSafeLockDirectory(workspacePath, paths.directory);
    await assertPatchLockBindings(paths);
    if (hooks.beforeRecoveryGuardAcquire) {
      await hooks.beforeRecoveryGuardAcquire();
    }
    const guard = await tryAcquireRecoveryGuard({
      lockPath: paths.path,
      containmentRoot: paths.directory,
      code: "PATCH005",
      label: "patch-lock recovery guard",
      containmentBinding: paths.directoryBinding,
    });
    if (guard) {
      if (hooks.afterRecoveryGuardAcquired) {
        await hooks.afterRecoveryGuardAcquired();
      }
      return guard;
    }
    const observation = await inspectRecoveryGuard({
      lockPath: paths.path,
      containmentRoot: paths.directory,
      code: "PATCH005",
      label: "Patch-lock recovery guard",
      containmentBinding: paths.directoryBinding,
    });
    if (hooks.afterRecoveryGuardBlocked) {
      await hooks.afterRecoveryGuardBlocked(observation);
    }
    if (performance.now() - startedAt >= timeoutMs) {
      throw patchGuardTimeout(paths, timeoutMs, observation);
    }
    await wait(pollMs);
  }
}

async function acquirePatchLock(workspacePath, options) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const hooks = options.hooks ?? {};
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs < 0 ||
    !Number.isFinite(pollMs) ||
    pollMs < 1 ||
    !Number.isFinite(staleMs) ||
    staleMs < 1
  ) {
    throw lockError("Patch lock timing options are invalid.");
  }

  const initialPaths = lockPaths(workspacePath);
  await ensureSafeLockDirectory(workspacePath, initialPaths.directory);
  const paths = await capturePatchLockBindings(workspacePath, initialPaths);
  const { path } = paths;
  const token = randomUUID();
  const startedAt = performance.now();

  while (performance.now() - startedAt <= timeoutMs) {
    const guard = await acquirePatchRecoveryGuard(
      workspacePath,
      paths,
      timeoutMs,
      pollMs,
      startedAt,
      hooks,
    );
    let acquired = false;
    let operationError;
    try {
      const observation = await inspectExistingLock(paths);
      if (observation === null) {
        acquired = await tryCreateLock(paths, token, Date.now());
      } else if (
        staleLock(observation, Date.now(), staleMs) &&
        (await retireStaleLock(paths, observation, staleMs, hooks))
      ) {
        acquired = await tryCreateLock(paths, token, Date.now());
      }
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      try {
        await releaseRecoveryGuard(guard, {
          code: "PATCH005",
          label: "patch-lock recovery guard",
        });
        await assertPatchLockBindings(paths);
      } catch (releaseError) {
        if (operationError === undefined) throw releaseError;
      }
    }
    if (acquired) return { ...paths, token };
    await wait(pollMs);
  }

  throw lockError(`Timed out waiting for the workspace patch lock: ${path}`);
}

async function releasePatchLock(workspacePath, lock, options) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const hooks = options.hooks ?? {};
  const guard = await acquirePatchRecoveryGuard(
    workspacePath,
    lock,
    timeoutMs,
    pollMs,
    performance.now(),
    hooks,
  );
  let operationError;
  try {
    const observation = await inspectExistingLock(lock);
    if (observation?.record?.token !== lock.token) {
      throw lockError(`Patch lock ownership changed before release: ${lock.path}`);
    }
    await assertPatchLockBindings(lock);
    await rm(lock.path);
    await assertPatchLockBindings(lock);
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      await releaseRecoveryGuard(guard, {
        code: "PATCH005",
        label: "patch-lock recovery guard",
      });
      await assertPatchLockBindings(lock);
    } catch (releaseError) {
      if (operationError === undefined) throw releaseError;
    }
  }
}

export async function withPatchLock(
  workspacePath,
  operation,
  options = {},
) {
  const lock = await acquirePatchLock(workspacePath, options);
  let operationError;
  try {
    return await operation();
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      await releasePatchLock(workspacePath, lock, options);
    } catch (releaseError) {
      if (operationError === undefined) throw releaseError;
    }
  }
}
