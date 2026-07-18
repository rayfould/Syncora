import { randomUUID } from "node:crypto";
import { link, lstat, open, realpath, rm } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";

import { SyncoraError } from "./cli.mjs";
import {
  readBoundedRegularFileIfPresent,
  samePath,
} from "./workspace.mjs";

export const LOCK_RECORD_MAX_BYTES = 4_096;

const RECOVERY_GUARD_SCHEMA_VERSION = 1;

function exactKeys(value, expected) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}

function validIso(value) {
  if (typeof value !== "string" || value.length > 40) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function validRecoveryGuardRecord(value) {
  return (
    exactKeys(value, ["schemaVersion", "token", "pid", "createdAt"]) &&
    value.schemaVersion === RECOVERY_GUARD_SCHEMA_VERSION &&
    typeof value.token === "string" &&
    /^[0-9a-f-]{36}$/i.test(value.token) &&
    Number.isInteger(value.pid) &&
    value.pid > 0 &&
    validIso(value.createdAt)
  );
}

export function parseRecoveryGuardRecord(bytes) {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value = JSON.parse(text);
    return validRecoveryGuardRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function sameFileIdentity(left, right) {
  if (
    !left?.isFile() ||
    !right?.isFile() ||
    left.isSymbolicLink() ||
    right.isSymbolicLink()
  ) {
    return false;
  }
  if (
    left.dev !== 0n ||
    left.ino !== 0n ||
    right.dev !== 0n ||
    right.ino !== 0n
  ) {
    return left.dev === right.dev && left.ino === right.ino;
  }
  return (
    left.mode === right.mode &&
    left.size === right.size &&
    left.birthtimeNs === right.birthtimeNs &&
    left.mtimeNs === right.mtimeNs
  );
}

function protocolError(code, message, details = undefined) {
  return new SyncoraError(code, message, details);
}

function isWithin(parent, child) {
  const result = relative(parent, child);
  return (
    result === "" ||
    (!result.startsWith(`..${sep}`) && result !== ".." && !isAbsolute(result))
  );
}

function directoryIdentity(metadata) {
  return {
    dev: metadata.dev,
    ino: metadata.ino,
    mode: metadata.mode,
    birthtimeNs: metadata.birthtimeNs,
  };
}

function sameDirectoryIdentity(left, right) {
  if (!left || !right) return false;
  if (
    left.dev !== 0n ||
    left.ino !== 0n ||
    right.dev !== 0n ||
    right.ino !== 0n
  ) {
    return left.dev === right.dev && left.ino === right.ino;
  }
  return left.mode === right.mode && left.birthtimeNs === right.birthtimeNs;
}

export async function captureStableDirectoryBinding(
  path,
  { code, label, containmentRoot },
) {
  let metadata;
  let resolvedPath;
  let resolvedContainment;
  try {
    metadata = await lstat(path, { bigint: true });
    resolvedPath = await realpath(path);
    resolvedContainment = await realpath(containmentRoot);
  } catch (error) {
    if (error instanceof SyncoraError) throw error;
    throw protocolError(code, `${label} could not be inspected safely: ${path}`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw protocolError(code, `${label} is not a safe directory: ${path}`);
  }
  if (!samePath(resolvedPath, path)) {
    throw protocolError(
      code,
      `${label} resolves through a symlink, junction, or alias: ${path}`,
    );
  }
  if (!isWithin(resolvedContainment, resolvedPath)) {
    throw protocolError(code, `${label} escapes ${containmentRoot}: ${resolvedPath}`);
  }
  return Object.freeze({
    path,
    resolvedPath,
    containmentRoot,
    resolvedContainment,
    identity: Object.freeze(directoryIdentity(metadata)),
  });
}

export async function assertStableDirectoryBinding(
  binding,
  { code, label },
) {
  const current = await captureStableDirectoryBinding(binding.path, {
    code,
    label,
    containmentRoot: binding.containmentRoot,
  });
  if (
    !samePath(current.resolvedPath, binding.resolvedPath) ||
    !samePath(current.resolvedContainment, binding.resolvedContainment) ||
    !sameDirectoryIdentity(current.identity, binding.identity)
  ) {
    throw protocolError(code, `${label} identity changed: ${binding.path}`);
  }
  return current;
}

export function recoveryGuardPath(lockPath) {
  return `${lockPath}.recovery`;
}

export async function readBoundedLockRecordBytes(
  path,
  {
    containmentRoot,
    code,
    label,
    allowTransientMissing = true,
    containmentBinding,
  },
) {
  await assertStableDirectoryBinding(containmentBinding, {
    code,
    label: `${label} trusted directory`,
  });
  const bytes = await readBoundedRegularFileIfPresent(path, {
    containmentRoot,
    maximumBytes: LOCK_RECORD_MAX_BYTES,
    code,
    label,
    allowTransientMissing,
  });
  await assertStableDirectoryBinding(containmentBinding, {
    code,
    label: `${label} trusted directory`,
  });
  return bytes;
}

export async function inspectRecoveryGuard({
  lockPath,
  containmentRoot,
  code,
  label,
  containmentBinding,
}) {
  const path = recoveryGuardPath(lockPath);
  let bytes;
  try {
    bytes = await readBoundedLockRecordBytes(path, {
      containmentRoot,
      code,
      label,
      allowTransientMissing: true,
      containmentBinding,
    });
  } catch (error) {
    // A short-lived guard can be released and replaced while a contender is
    // observing it. Treat only the bounded reader's explicit stable-change
    // result as transient; unsafe types and other read failures still close.
    if (error instanceof SyncoraError && error.details?.reason === "changed") {
      return null;
    }
    throw error;
  }
  if (bytes === null) return null;
  return {
    path,
    record: parseRecoveryGuardRecord(bytes),
  };
}

export async function tryAcquireRecoveryGuard({
  lockPath,
  containmentRoot,
  code,
  label,
  containmentBinding,
}) {
  const path = recoveryGuardPath(lockPath);
  const temporaryPath = `${path}.candidate-${process.pid}-${randomUUID()}`;
  const token = randomUUID();
  const record = {
    schemaVersion: RECOVERY_GUARD_SCHEMA_VERSION,
    token,
    pid: process.pid,
    createdAt: new Date().toISOString(),
  };
  const payload = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
  if (payload.length > LOCK_RECORD_MAX_BYTES) {
    throw protocolError(code, `${label} record exceeds its bounded byte limit.`);
  }

  let handle;
  let published = false;
  try {
    await assertStableDirectoryBinding(containmentBinding, {
      code,
      label: `${label} trusted directory`,
    });
    handle = await open(temporaryPath, "wx+", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST" || error?.code === "ENOENT") return null;
    if (error instanceof SyncoraError) throw error;
    throw protocolError(code, `Unable to create ${label}: ${path}`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    await handle.writeFile(payload);
    await handle.sync();
    const opened = await handle.stat({ bigint: true });
    await assertStableDirectoryBinding(containmentBinding, {
      code,
      label: `${label} trusted directory`,
    });
    try {
      await link(temporaryPath, path);
      published = true;
    } catch (error) {
      if (error?.code === "EEXIST") {
        await handle.close().catch(() => undefined);
        await rm(temporaryPath).catch(() => undefined);
        return null;
      }
      throw error;
    }
    const current = await lstat(path, { bigint: true });
    if (!sameFileIdentity(opened, current)) {
      throw protocolError(
        code,
        `${label} ownership changed during exclusive creation: ${path}`,
      );
    }
    await rm(temporaryPath);
    return { path, token, record, payload, handle, containmentBinding };
  } catch (error) {
    if (published) {
      try {
        const opened = await handle.stat({ bigint: true });
        const current = await lstat(path, { bigint: true });
        if (sameFileIdentity(opened, current)) await rm(path);
      } catch {
        // Ownership could not be re-proven; leave the complete published guard
        // in place and fail closed rather than removing a possible replacement.
      }
    }
    await handle.close().catch(() => undefined);
    await rm(temporaryPath).catch(() => undefined);
    // The public path is linked only after complete bytes are durable, so a
    // contender can never observe an empty or partially written guard.
    if (error instanceof SyncoraError) throw error;
    throw protocolError(code, `Unable to publish ${label}: ${path}`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function releaseRecoveryGuard(guard, { code, label }) {
  let ownershipProven = false;
  let inspectionError;
  try {
    await assertStableDirectoryBinding(guard.containmentBinding, {
      code,
      label: `${label} trusted directory`,
    });
    const openedBefore = await guard.handle.stat({ bigint: true });
    const current = await lstat(guard.path, { bigint: true });
    const observed = Buffer.alloc(guard.payload.length + 1);
    const { bytesRead } = await guard.handle.read(
      observed,
      0,
      observed.length,
      0,
    );
    const openedAfter = await guard.handle.stat({ bigint: true });
    ownershipProven =
      sameFileIdentity(openedBefore, current) &&
      sameFileIdentity(openedBefore, openedAfter) &&
      bytesRead === guard.payload.length &&
      observed.subarray(0, bytesRead).equals(guard.payload) &&
      parseRecoveryGuardRecord(observed.subarray(0, bytesRead))?.token ===
        guard.token;
  } catch (error) {
    inspectionError = error;
    ownershipProven = false;
  } finally {
    await guard.handle.close().catch(() => undefined);
  }

  if (inspectionError instanceof SyncoraError) throw inspectionError;

  if (!ownershipProven) {
    throw protocolError(
      code,
      `${label} ownership could not be proven before release: ${guard.path}`,
    );
  }

  try {
    await rm(guard.path);
    await assertStableDirectoryBinding(guard.containmentBinding, {
      code,
      label: `${label} trusted directory`,
    });
  } catch (error) {
    if (error instanceof SyncoraError) throw error;
    throw protocolError(code, `Unable to release ${label}: ${guard.path}`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}
