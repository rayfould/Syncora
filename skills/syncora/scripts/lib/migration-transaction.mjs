import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import { writeBufferAtomic } from "./atomic-file.mjs";
import { SyncoraError } from "./cli.mjs";
import {
  assertMigrationRoot,
  MIGRATION_STATE_POLICY,
  readMigrationBytes,
  readMigrationTargetBytes,
  serializeMigrationJson,
  taggedSha256,
  writeMigrationJson,
} from "./migration-state.mjs";
import { createStableDirectoryGuard } from "./stable-directory.mjs";
import {
  isWithin,
  samePath,
} from "./workspace.mjs";

export const MIGRATION_TRANSACTION_POLICY = Object.freeze({
  schemaVersion: 1,
  maximumRecords: 60_000,
  maximumRecordPathCharacters: 4_096,
  maximumBlobBytes: 16_777_216,
  maximumTotalPreparedBytes: 536_870_912,
});

const ROOTS = new Set(["graph", "workspace"]);
const CATEGORIES = new Set(["archive", "graph", "runtime", "agent-cutover", "agent"]);
const CATEGORY_ORDER = Object.freeze({
  archive: 0,
  graph: 1,
  runtime: 2,
  "agent-cutover": 3,
  agent: 4,
});

function transactionError(code, message, details = undefined) {
  return new SyncoraError(code, message, details);
}

function portablePath(value, label) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MIGRATION_TRANSACTION_POLICY.maximumRecordPathCharacters ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value) ||
    value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw transactionError("MIGRATE008", `${label} is not a portable relative path.`);
  }
  return value;
}

function nullableHash(value, label) {
  if (value !== null && !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw transactionError("MIGRATE008", `${label} is not a nullable SHA-256 value.`);
  }
  return value;
}

function exactKeys(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw transactionError("MIGRATE008", `${label} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    !actual.every((key, index) => key === expected[index])
  ) {
    throw transactionError("MIGRATE008", `${label} has missing or unknown fields.`);
  }
}

function rootPath(roots, root) {
  if (!ROOTS.has(root)) {
    throw transactionError("MIGRATE008", `Unsupported transaction root: ${root}`);
  }
  return root === "graph" ? roots.graphRoot : roots.workspacePath;
}

function absoluteRecordPath(roots, record) {
  const root = rootPath(roots, record.root);
  const path = join(root, ...record.path.split("/"));
  const result = relative(root, path);
  if (
    result === ".." ||
    result.startsWith(`..${sep}`) ||
    isAbsolute(result)
  ) {
    throw transactionError("MIGRATE008", `Transaction path escapes ${record.root}: ${record.path}`);
  }
  return { root, path };
}

async function nearestExistingAncestor(path) {
  let candidate = path;
  while (true) {
    try {
      return { path: candidate, metadata: await lstat(candidate) };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const parent = dirname(candidate);
    if (parent === candidate) return null;
    candidate = parent;
  }
}

async function assertSafeParent(root, path) {
  const ancestor = await nearestExistingAncestor(dirname(path));
  if (
    !ancestor ||
    !ancestor.metadata.isDirectory() ||
    ancestor.metadata.isSymbolicLink()
  ) {
    throw transactionError("MIGRATE008", `Transaction parent is unsafe: ${path}`);
  }
  const resolved = await realpath(ancestor.path);
  if (!isWithin(root, resolved) || !samePath(resolved, ancestor.path)) {
    throw transactionError("MIGRATE008", `Transaction parent escapes its trusted root: ${path}`);
  }
}

function sameFileIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.birthtimeNs === right.birthtimeNs
  );
}

async function readHandleBounded(handle, maximumBytes, expectedBytes) {
  if (
    !Number.isSafeInteger(expectedBytes) ||
    expectedBytes < 0 ||
    expectedBytes > maximumBytes
  ) {
    throw transactionError(
      "MIGRATE008",
      "Migration transaction target has an invalid expected size.",
    );
  }
  // The extra byte detects growth after the handle snapshot without allocating
  // the policy maximum for every small note in a large migration.
  const buffer = Buffer.allocUnsafe(expectedBytes + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      buffer.length - offset,
      offset,
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > maximumBytes) {
    throw transactionError(
      "MIGRATE008",
      "Migration transaction target grew beyond its byte limit while read.",
    );
  }
  return buffer.subarray(0, offset);
}

async function readCurrent(roots, record) {
  const resolved = absoluteRecordPath(roots, record);
  await assertSafeParent(resolved.root, resolved.path);
  let metadata;
  try {
    metadata = await lstat(resolved.path, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return { ...resolved, bytes: null, mode: null };
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw transactionError("MIGRATE008", `Transaction target is not a safe regular file: ${resolved.path}`);
  }
  if (metadata.size > BigInt(MIGRATION_TRANSACTION_POLICY.maximumBlobBytes)) {
    throw transactionError("MIGRATE008", `Transaction target exceeds its byte limit: ${resolved.path}`);
  }
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const nonBlock = fsConstants.O_NONBLOCK ?? 0;
  let handle;
  try {
    handle = await open(resolved.path, fsConstants.O_RDONLY | noFollow | nonBlock);
    const openedBefore = await handle.stat({ bigint: true });
    if (!sameFileIdentity(metadata, openedBefore)) {
      throw transactionError(
        "MIGRATE009",
        `Migration target changed while its handle opened: ${record.path}`,
      );
    }
    const bytes = await readHandleBounded(
      handle,
      MIGRATION_TRANSACTION_POLICY.maximumBlobBytes,
      Number(openedBefore.size),
    );
    const openedAfter = await handle.stat({ bigint: true });
    const pathAfter = await lstat(resolved.path, { bigint: true });
    await assertSafeParent(resolved.root, resolved.path);
    if (
      !sameFileIdentity(openedBefore, openedAfter) ||
      !sameFileIdentity(openedAfter, pathAfter) ||
      bytes.length !== Number(openedAfter.size)
    ) {
      throw transactionError(
        "MIGRATE009",
        `Migration target changed while it was read: ${record.path}`,
      );
    }
    return { ...resolved, bytes, mode: Number(openedAfter.mode) };
  } catch (error) {
    if (error instanceof SyncoraError) throw error;
    throw transactionError(
      "MIGRATE008",
      `Migration target could not be read safely: ${record.path}`,
      { cause: error.message },
    );
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}

function contentHash(bytes) {
  return bytes === null ? null : taggedSha256(bytes);
}

function blobReference(bytes) {
  if (bytes === null) return null;
  const hash = taggedSha256(bytes);
  return `blobs/${hash.slice("sha256:".length)}.bin`;
}

async function loadBlob(paths, reference, expectedHash) {
  if (reference === null) {
    if (expectedHash !== null) {
      throw transactionError("MIGRATE008", "Recovery record is missing a required blob reference.");
    }
    return null;
  }
  portablePath(reference, "Recovery blob path");
  if (!reference.startsWith("blobs/") || !reference.endsWith(".bin")) {
    throw transactionError("MIGRATE008", "Recovery blob path is outside the blob store.");
  }
  const path = join(paths.root, ...reference.split("/"));
  const bytes = await readMigrationTargetBytes(
    path,
    paths.root,
    MIGRATION_TRANSACTION_POLICY.maximumBlobBytes,
    "Migration recovery blob",
  );
  if (bytes === null || taggedSha256(bytes) !== expectedHash) {
    throw transactionError("MIGRATE008", `Migration recovery blob is missing or corrupt: ${reference}`);
  }
  return bytes;
}

function validateRecoveryRecord(record, index) {
  exactKeys(
    record,
    [
      "index",
      "root",
      "path",
      "category",
      "beforeSha256",
      "afterSha256",
      "beforeBlob",
      "afterBlob",
      "mode",
    ],
    `Recovery record ${index}`,
  );
  if (record.index !== index) {
    throw transactionError("MIGRATE008", "Recovery record order is not canonical.");
  }
  if (!ROOTS.has(record.root) || !CATEGORIES.has(record.category)) {
    throw transactionError("MIGRATE008", `Recovery record ${index} has an invalid root or category.`);
  }
  portablePath(record.path, `Recovery record ${index} path`);
  nullableHash(record.beforeSha256, `Recovery record ${index} beforeSha256`);
  nullableHash(record.afterSha256, `Recovery record ${index} afterSha256`);
  for (const key of ["beforeBlob", "afterBlob"]) {
    if (record[key] !== null) portablePath(record[key], `Recovery record ${index} ${key}`);
  }
  if ((record.beforeSha256 === null) !== (record.beforeBlob === null)) {
    throw transactionError("MIGRATE008", `Recovery record ${index} before binding is inconsistent.`);
  }
  if ((record.afterSha256 === null) !== (record.afterBlob === null)) {
    throw transactionError("MIGRATE008", `Recovery record ${index} after binding is inconsistent.`);
  }
  if (record.mode !== null && (!Number.isSafeInteger(record.mode) || record.mode < 0)) {
    throw transactionError("MIGRATE008", `Recovery record ${index} mode is invalid.`);
  }
  return record;
}

export function validateRecovery(value, expected = {}) {
  exactKeys(
    value,
    [
      "schemaVersion",
      "kind",
      "migrationId",
      "workspaceIdentity",
      "rootIdentity",
      "manifestSha256",
      "planSha256",
      "status",
      "createdAt",
      "updatedAt",
      "records",
    ],
    "Migration recovery journal",
  );
  if (value.schemaVersion !== MIGRATION_TRANSACTION_POLICY.schemaVersion) {
    throw transactionError("SCHEMA001", `Unsupported recovery schema: ${value.schemaVersion}`);
  }
  if (value.kind !== "syncora.migration-recovery") {
    throw transactionError("MIGRATE008", "Migration recovery kind is invalid.");
  }
  if (expected.migrationId && value.migrationId !== expected.migrationId) {
    throw transactionError("MIGRATE008", "Migration recovery belongs to another migration.");
  }
  for (const field of ["workspaceIdentity", "rootIdentity", "manifestSha256"]) {
    if (typeof value[field] !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value[field])) {
      throw transactionError("MIGRATE008", `Migration recovery ${field} is invalid.`);
    }
    if (expected[field] && value[field] !== expected[field]) {
      throw transactionError("MIGRATE008", `Migration recovery ${field} does not match its migration state.`);
    }
  }
  if (!new Set(["prepared", "applying", "applied", "rolled-back"]).has(value.status)) {
    throw transactionError("MIGRATE008", `Migration recovery status is invalid: ${value.status}`);
  }
  if (
    !Array.isArray(value.records) ||
    value.records.length > MIGRATION_TRANSACTION_POLICY.maximumRecords
  ) {
    throw transactionError("MIGRATE008", "Migration recovery record count is invalid.");
  }
  value.records.forEach(validateRecoveryRecord);
  const identities = new Set();
  for (const record of value.records) {
    const key = `${record.root}\0${process.platform === "win32" ? record.path.toLowerCase() : record.path}`;
    if (identities.has(key)) {
      throw transactionError("MIGRATE008", `Migration recovery repeats a target: ${record.path}`);
    }
    identities.add(key);
  }
  if (
    typeof value.planSha256 !== "string" ||
    value.planSha256 !== recoveryPlanSha256(value)
  ) {
    throw transactionError("MIGRATE008", "Migration recovery plan digest is invalid.");
  }
  return value;
}

export function recoveryPlanSha256(recovery) {
  const payload = {
    schemaVersion: recovery.schemaVersion,
    kind: recovery.kind,
    migrationId: recovery.migrationId,
    workspaceIdentity: recovery.workspaceIdentity,
    rootIdentity: recovery.rootIdentity,
    manifestSha256: recovery.manifestSha256,
    records: recovery.records,
  };
  return taggedSha256(Buffer.from(JSON.stringify(payload), "utf8"));
}

export async function prepareRecovery({
  paths,
  migrationId,
  workspaceIdentity,
  rootIdentity,
  manifestSha256,
  records,
}, hooks = {}) {
  await assertMigrationRoot(paths);
  if (!Array.isArray(records) || records.length > MIGRATION_TRANSACTION_POLICY.maximumRecords) {
    throw transactionError("MIGRATE008", "Migration transaction record count exceeds its limit.");
  }
  const ordered = [...records].sort(
    (left, right) =>
      CATEGORY_ORDER[left.category] - CATEGORY_ORDER[right.category] ||
      left.root.localeCompare(right.root) ||
      left.path.localeCompare(right.path),
  );
  const seen = new Set();
  const recoveryRecords = [];
  const blobs = new Map();
  let totalBytes = 0;
  for (let index = 0; index < ordered.length; index += 1) {
    const record = ordered[index];
    if (!ROOTS.has(record.root) || !CATEGORIES.has(record.category)) {
      throw transactionError("MIGRATE008", "Migration transaction record root or category is invalid.");
    }
    portablePath(record.path, "Migration transaction path");
    const key = `${record.root}\0${process.platform === "win32" ? record.path.toLowerCase() : record.path}`;
    if (seen.has(key)) {
      throw transactionError("MIGRATE008", `Migration transaction repeats a target: ${record.path}`);
    }
    seen.add(key);
    for (const bytes of [record.before, record.after]) {
      if (bytes !== null && !Buffer.isBuffer(bytes)) {
        throw transactionError("MIGRATE008", "Migration transaction content must be a Buffer or null.");
      }
      if (bytes !== null && bytes.length > MIGRATION_TRANSACTION_POLICY.maximumBlobBytes) {
        throw transactionError("MIGRATE008", `Migration transaction blob exceeds its limit: ${record.path}`);
      }
      if (bytes !== null) {
        totalBytes += bytes.length;
        blobs.set(blobReference(bytes), bytes);
      }
    }
    recoveryRecords.push({
      index,
      root: record.root,
      path: record.path,
      category: record.category,
      beforeSha256: contentHash(record.before),
      afterSha256: contentHash(record.after),
      beforeBlob: blobReference(record.before),
      afterBlob: blobReference(record.after),
      mode: record.mode ?? null,
    });
  }
  if (totalBytes > MIGRATION_TRANSACTION_POLICY.maximumTotalPreparedBytes) {
    throw transactionError("MIGRATE008", "Migration transaction exceeds its prepared-byte limit.");
  }

  const blobsGuard = createStableDirectoryGuard(paths.graphRoot, paths.blobs, {
    code: "MIGRATE008",
    label: "Migration recovery blob directory",
  });
  await blobsGuard.prepare();
  await assertMigrationRoot(paths);
  for (const [reference, bytes] of blobs) {
    const path = join(paths.root, ...reference.split("/"));
    const existing = await readMigrationTargetBytes(
      path,
      paths.root,
      MIGRATION_TRANSACTION_POLICY.maximumBlobBytes,
      "Migration recovery blob",
    );
    if (existing !== null && !existing.equals(bytes)) {
      throw transactionError("MIGRATE008", `Content-addressed migration blob is corrupt: ${reference}`);
    }
    if (existing === null) {
      await writeBufferAtomic(
        path,
        bytes,
        undefined,
        async () => {
          await blobsGuard.assert();
          await assertMigrationRoot(paths);
        },
        () => blobsGuard.prepare(),
      );
    }
  }

  const now = new Date().toISOString();
  const recovery = {
    schemaVersion: MIGRATION_TRANSACTION_POLICY.schemaVersion,
    kind: "syncora.migration-recovery",
    migrationId,
    workspaceIdentity,
    rootIdentity,
    manifestSha256,
    planSha256: null,
    status: "prepared",
    createdAt: now,
    updatedAt: now,
    records: recoveryRecords,
  };
  recovery.planSha256 = recoveryPlanSha256(recovery);
  validateRecovery(recovery, { migrationId });
  await hooks.beforePublish?.({ recovery });
  const recoveryGuard = createStableDirectoryGuard(
    paths.graphRoot,
    dirname(paths.recovery),
    { code: "MIGRATE008", label: "Migration recovery directory" },
  );
  await recoveryGuard.prepare();
  const bytes = await writeMigrationJson(
    paths.recovery,
    recovery,
    async () => {
      await recoveryGuard.assert();
      await assertMigrationRoot(paths);
    },
    () => recoveryGuard.prepare(),
  );
  return { recovery, bytes };
}

async function publishRecord(roots, paths, record, direction) {
  const current = await readCurrent(roots, record);
  const expectedCurrent = direction === "forward" ? record.beforeSha256 : record.afterSha256;
  const desiredHash = direction === "forward" ? record.afterSha256 : record.beforeSha256;
  const desiredBlob = direction === "forward" ? record.afterBlob : record.beforeBlob;
  const currentHash = contentHash(current.bytes);
  if (currentHash === desiredHash) return "already";
  if (currentHash !== expectedCurrent) {
    throw transactionError(
      "MIGRATE009",
      `Migration transaction found concurrent bytes at ${record.root}:${record.path}.`,
      { expectedCurrent, desiredHash, currentHash },
    );
  }
  const desired = await loadBlob(paths, desiredBlob, desiredHash);
  const parentGuard = createStableDirectoryGuard(
    current.root,
    dirname(current.path),
    { code: "MIGRATE009", label: "Migration publication directory" },
  );
  await parentGuard.prepare();
  if (desired === null) {
    await parentGuard.assert();
    const latest = await readCurrent(roots, record);
    if (contentHash(latest.bytes) !== expectedCurrent) {
      throw transactionError(
        "MIGRATE009",
        `Migration delete target changed before publish: ${record.path}`,
      );
    }
    const quarantinePath = join(
      dirname(current.path),
      `.syncora-delete-${randomUUID()}`,
    );
    await rename(current.path, quarantinePath);
    await parentGuard.assert();
    const moved = await readMigrationTargetBytes(
      quarantinePath,
      current.root,
      MIGRATION_TRANSACTION_POLICY.maximumBlobBytes,
      "Quarantined migration target",
    );
    if (contentHash(moved) !== expectedCurrent) {
      let originalMissing = false;
      try {
        await lstat(current.path);
      } catch (error) {
        if (error?.code === "ENOENT") originalMissing = true;
        else throw error;
      }
      if (originalMissing) {
        await parentGuard.assert();
        await rename(quarantinePath, current.path);
      }
      throw transactionError(
        "MIGRATE009",
        `Migration delete target changed during atomic quarantine: ${record.path}`,
        { quarantinePath: originalMissing ? null : quarantinePath },
      );
    }
    await parentGuard.assert();
    await rm(quarantinePath);
  } else {
    await parentGuard.assert();
    await writeBufferAtomic(current.path, desired, record.mode ?? undefined, async () => {
      await parentGuard.assert();
      const latest = await readCurrent(roots, record);
      if (contentHash(latest.bytes) !== expectedCurrent) {
        throw transactionError("MIGRATE009", `Migration target changed before publish: ${record.path}`);
      }
    }, () => parentGuard.prepare());
  }
  await parentGuard.assert();
  const verified = await readCurrent(roots, record);
  if (contentHash(verified.bytes) !== desiredHash) {
    throw transactionError("MIGRATE009", `Migration target did not publish exact bytes: ${record.path}`);
  }
  return "published";
}

async function preflightRecords(roots, records, direction) {
  const conflicts = [];
  for (const record of records) {
    const current = await readCurrent(roots, record);
    const currentHash = contentHash(current.bytes);
    const expectedCurrent = direction === "forward" ? record.beforeSha256 : record.afterSha256;
    const desiredHash = direction === "forward" ? record.afterSha256 : record.beforeSha256;
    if (currentHash !== expectedCurrent && currentHash !== desiredHash) {
      conflicts.push({ root: record.root, path: record.path, currentHash, expectedCurrent, desiredHash });
    }
  }
  if (conflicts.length > 0) {
    throw transactionError("MIGRATE009", "Migration transaction has concurrent conflicts.", {
      conflicts: conflicts.slice(0, 20),
      omitted: Math.max(0, conflicts.length - 20),
    });
  }
}

export async function previewRecovery({ roots, recovery, direction = "forward" }) {
  validateRecovery(recovery, { migrationId: recovery.migrationId });
  if (!new Set(["forward", "backward"]).has(direction)) {
    throw transactionError("MIGRATE008", `Unsupported recovery preview direction: ${direction}`);
  }
  const records = direction === "forward"
    ? recovery.records
    : [...recovery.records].reverse();
  await preflightRecords(roots, records, direction);
  let pending = 0;
  let already = 0;
  for (const record of records) {
    const current = await readCurrent(roots, record);
    const desired = direction === "forward" ? record.afterSha256 : record.beforeSha256;
    if (contentHash(current.bytes) === desired) already += 1;
    else pending += 1;
  }
  return { pending, already, total: records.length };
}

async function updateRecovery(paths, recovery, status) {
  const next = { ...recovery, status, updatedAt: new Date().toISOString() };
  validateRecovery(next, { migrationId: recovery.migrationId });
  const guard = createStableDirectoryGuard(
    paths.graphRoot,
    dirname(paths.recovery),
    { code: "MIGRATE008", label: "Migration recovery directory" },
  );
  await guard.prepare();
  const bytes = await writeMigrationJson(
    paths.recovery,
    next,
    async () => {
      await guard.assert();
      await assertMigrationRoot(paths);
    },
    () => guard.prepare(),
  );
  return { recovery: next, bytes };
}

export async function applyRecovery({ paths, roots, recovery }) {
  validateRecovery(recovery, { migrationId: recovery.migrationId });
  if (recovery.status === "rolled-back") {
    throw transactionError("MIGRATE006", "A rolled-back migration cannot be applied again.");
  }
  await preflightRecords(roots, recovery.records, "forward");
  let active = recovery;
  if (active.status !== "applying") {
    active = (await updateRecovery(paths, active, "applying")).recovery;
  }
  let published = 0;
  let already = 0;
  for (const record of active.records) {
    const outcome = await publishRecord(roots, paths, record, "forward");
    if (outcome === "published") published += 1;
    else already += 1;
  }
  const finalized = await updateRecovery(paths, active, "applied");
  return { ...finalized, summary: { published, already, total: active.records.length } };
}

export async function rollbackRecovery({ paths, roots, recovery }) {
  validateRecovery(recovery, { migrationId: recovery.migrationId });
  await preflightRecords(roots, [...recovery.records].reverse(), "backward");
  let restored = 0;
  let already = 0;
  for (const record of [...recovery.records].reverse()) {
    const outcome = await publishRecord(roots, paths, record, "backward");
    if (outcome === "published") restored += 1;
    else already += 1;
  }
  const finalized = await updateRecovery(paths, recovery, "rolled-back");
  return { ...finalized, summary: { restored, already, total: recovery.records.length } };
}

export async function readRecovery(paths, migrationId, expected = {}) {
  const bytes = await readMigrationBytes(
    paths.recovery,
    paths.root,
    MIGRATION_STATE_POLICY.maximumArtifactBytes,
    "Migration recovery journal",
  );
  if (bytes === null) return null;
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw transactionError("MIGRATE008", "Migration recovery journal is invalid JSON or UTF-8.");
  }
  return {
    bytes,
    value: validateRecovery(value, { migrationId, ...expected }),
  };
}

export async function verifyRecoveryBlobs({ paths, recovery }) {
  validateRecovery(recovery, { migrationId: recovery.migrationId });
  let verified = 0;
  for (const record of recovery.records) {
    await loadBlob(paths, record.beforeBlob, record.beforeSha256);
    await loadBlob(paths, record.afterBlob, record.afterSha256);
    verified += Number(record.beforeBlob !== null) + Number(record.afterBlob !== null);
  }
  return { records: recovery.records.length, blobs: verified };
}

export function recoveryDigest(recovery) {
  return taggedSha256(serializeMigrationJson(recovery));
}
