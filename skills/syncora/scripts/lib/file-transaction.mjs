import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import {
  ATOMIC_FILE_DURABILITY,
  syncDirectoryEntry,
  writeBufferAtomic,
} from "./atomic-file.mjs";
import { SyncoraError } from "./cli.mjs";
import { publishImmutableFile } from "./immutable-file.mjs";
import { withPatchLock } from "./patch-lock.mjs";
import { createStableDirectoryGuard } from "./stable-directory.mjs";
import {
  isWithin,
  readBoundedRegularFileIfPresent,
  samePath,
} from "./workspace.mjs";

export const FILE_TRANSACTION_POLICY = Object.freeze({
  schemaVersion: 1,
  maximumRecords: 1_024,
  maximumFileBytes: 262_144,
  maximumTotalPreparedBytes: 67_108_864,
  maximumJournalBytes: 4_194_304,
  maximumControlBytes: 65_536,
  maximumPathCharacters: 4_096,
  maximumPathBytes: 4_096,
  maximumSegmentCharacters: 240,
  maximumSegmentBytes: 240,
  maximumTransactionIdCharacters: 128,
});

export const FILE_TRANSACTION_DURABILITY = Object.freeze({
  fileContentSync: ATOMIC_FILE_DURABILITY.fileContentSync,
  parentDirectorySync: ATOMIC_FILE_DURABILITY.parentDirectorySync,
  processCrashRecovery: true,
  windowsPowerLossGuarantee: ATOMIC_FILE_DURABILITY.windowsPowerLossGuarantee,
});

const JOURNAL_KIND = "syncora.file-transaction";
const ACTIVE_KIND = "syncora.active-file-transaction";
const TERMINAL_STATES = new Set(["finalized", "rolled-back"]);
const JOURNAL_STATES = new Set([
  "prepared",
  "applying",
  "awaiting-finalization",
  "finalized-pending-receipt",
  "finalized",
  "rolling-back",
  "rolled-back",
]);
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
const UNSAFE_SEGMENT = /[<>:"|?*\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u;

function transactionError(code, message, details = undefined) {
  return new SyncoraError(code, message, details);
}

function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function exactKeys(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw transactionError("WRITE006", `${label} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    !actual.every((key, index) => key === expected[index])
  ) {
    throw transactionError("WRITE006", `${label} has missing or unknown fields.`);
  }
}

function validDigest(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw transactionError("WRITE006", `${label} must be a SHA-256 digest.`);
  }
  return value;
}

function validTransactionId(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    [...value].length > FILE_TRANSACTION_POLICY.maximumTransactionIdCharacters ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value) ||
    value === "." ||
    value === ".."
  ) {
    throw transactionError("WRITE006", "Transaction ID is invalid or unbounded.");
  }
  return value;
}

function portablePath(value, label) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/u.test(value) ||
    [...value].length > FILE_TRANSACTION_POLICY.maximumPathCharacters ||
    Buffer.byteLength(value, "utf8") > FILE_TRANSACTION_POLICY.maximumPathBytes
  ) {
    throw transactionError("WRITE002", `${label} is not a bounded portable relative path.`);
  }
  const segments = value.split("/");
  if (
    segments.some((segment) =>
      segment.length === 0 ||
      segment === "." ||
      segment === ".." ||
      segment.endsWith(".") ||
      segment.endsWith(" ") ||
      [...segment].length > FILE_TRANSACTION_POLICY.maximumSegmentCharacters ||
      Buffer.byteLength(segment, "utf8") > FILE_TRANSACTION_POLICY.maximumSegmentBytes ||
      WINDOWS_RESERVED.test(segment) ||
      UNSAFE_SEGMENT.test(segment)
    )
  ) {
    throw transactionError("WRITE002", `${label} contains an unsafe path segment.`);
  }
  const normalized = value.normalize("NFC");
  const lower = normalized.toLowerCase();
  const first = lower.split("/", 1)[0];
  if (
    new Set([".git", ".obsidian", ".syncora", "node_modules"]).has(first) ||
    lower === ".claude/worktrees" ||
    lower.startsWith(".claude/worktrees/") ||
    lower === "archive/migrations" ||
    lower.startsWith("archive/migrations/")
  ) {
    throw transactionError("WRITE002", `${label} targets reserved runtime or archive storage.`);
  }
  return normalized;
}

function fileBytes(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (!Buffer.isBuffer(value)) {
    throw transactionError("WRITE006", `${label} must be a Buffer${nullable ? " or null" : ""}.`);
  }
  if (value.length > FILE_TRANSACTION_POLICY.maximumFileBytes) {
    throw transactionError("WRITE006", `${label} exceeds the file byte limit.`);
  }
  return value;
}

function modeValue(value, label) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0 || value > 0o7777) {
    throw transactionError("WRITE006", `${label} is not a bounded file mode.`);
  }
  return value;
}

function rootRelativePath(root, path) {
  const result = relative(root, path);
  if (result === ".." || result.startsWith(`..${sep}`) || isAbsolute(result)) {
    throw transactionError("WRITE002", `Transaction target escapes its graph root: ${path}`);
  }
  return result;
}

async function metadataIfPresent(path, options = undefined) {
  try {
    return await lstat(path, options);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function resolveGraphRoot(graphRoot) {
  if (!isAbsolute(graphRoot)) {
    throw transactionError("WRITE002", "Graph root must be an absolute resolved path.");
  }
  const before = await metadataIfPresent(graphRoot, { bigint: true });
  if (!before?.isDirectory() || before.isSymbolicLink()) {
    throw transactionError("WRITE002", `Graph root is not a safe directory: ${graphRoot}`);
  }
  const resolved = await realpath(graphRoot);
  const after = await lstat(graphRoot, { bigint: true });
  if (
    !samePath(graphRoot, resolved) ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.mode !== after.mode
  ) {
    throw transactionError("WRITE002", "Graph root changed or resolves through an alias.");
  }
  const rootIdentity = digest(Buffer.from(JSON.stringify({
    path: process.platform === "win32" ? resolved.toLowerCase() : resolved,
    dev: after.dev.toString(),
    ino: after.ino.toString(),
  }), "utf8"));
  return { graphRoot: resolved, rootIdentity };
}

export function fileTransactionPaths(graphRoot, transactionId) {
  validTransactionId(transactionId);
  const runtimeRoot = join(graphRoot, ".syncora");
  const transactionsRoot = join(runtimeRoot, "transactions", "files");
  const transactionRoot = join(transactionsRoot, transactionId);
  return Object.freeze({
    graphRoot,
    runtimeRoot,
    transactionsRoot,
    active: join(transactionsRoot, "active.json"),
    transactionRoot,
    journal: join(transactionRoot, "journal.json"),
    blobs: join(transactionRoot, "blobs"),
  });
}

function absoluteTarget(graphRoot, portable) {
  const path = join(graphRoot, ...portable.split("/"));
  rootRelativePath(graphRoot, path);
  return path;
}

async function nearestExistingAncestor(path) {
  let current = path;
  while (true) {
    const metadata = await metadataIfPresent(current);
    if (metadata) return { path: current, metadata };
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function assertSafeParent(graphRoot, path) {
  const ancestor = await nearestExistingAncestor(dirname(path));
  if (!ancestor || !ancestor.metadata.isDirectory() || ancestor.metadata.isSymbolicLink()) {
    throw transactionError("WRITE002", `Transaction parent is unsafe: ${path}`);
  }
  const resolved = await realpath(ancestor.path);
  if (!isWithin(graphRoot, resolved) || !samePath(resolved, ancestor.path)) {
    throw transactionError("WRITE002", `Transaction parent escapes the graph root: ${path}`);
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

async function readHandleBounded(handle, expectedBytes) {
  if (
    !Number.isSafeInteger(expectedBytes) ||
    expectedBytes < 0 ||
    expectedBytes > FILE_TRANSACTION_POLICY.maximumFileBytes
  ) {
    throw transactionError("WRITE006", "Transaction target has an invalid size.");
  }
  const result = Buffer.allocUnsafe(expectedBytes + 1);
  let offset = 0;
  while (offset < result.length) {
    const { bytesRead } = await handle.read(result, offset, result.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > FILE_TRANSACTION_POLICY.maximumFileBytes) {
    throw transactionError("WRITE006", "Transaction target grew beyond its byte limit.");
  }
  return result.subarray(0, offset);
}

async function readCurrent(graphRoot, record) {
  const path = absoluteTarget(graphRoot, record.path);
  await assertSafeParent(graphRoot, path);
  const before = await metadataIfPresent(path, { bigint: true });
  if (!before) return { path, bytes: null, mode: null };
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
    throw transactionError("WRITE002", `Transaction target is not a safe unique regular file: ${record.path}`);
  }
  if (before.size > BigInt(FILE_TRANSACTION_POLICY.maximumFileBytes)) {
    throw transactionError("WRITE006", `Transaction target exceeds its byte limit: ${record.path}`);
  }
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const nonBlock = fsConstants.O_NONBLOCK ?? 0;
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | noFollow | nonBlock);
    const openedBefore = await handle.stat({ bigint: true });
    if (!sameFileIdentity(before, openedBefore)) {
      throw transactionError("WRITE001", `Transaction target changed while opening: ${record.path}`);
    }
    const bytes = await readHandleBounded(handle, Number(openedBefore.size));
    const openedAfter = await handle.stat({ bigint: true });
    const pathAfter = await lstat(path, { bigint: true });
    await assertSafeParent(graphRoot, path);
    if (
      !sameFileIdentity(openedBefore, openedAfter) ||
      !sameFileIdentity(openedAfter, pathAfter) ||
      bytes.length !== Number(openedAfter.size)
    ) {
      throw transactionError("WRITE001", `Transaction target changed while reading: ${record.path}`);
    }
    return {
      path,
      bytes,
      mode: process.platform === "win32" ? null : Number(openedAfter.mode & 0o7777n),
    };
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}

function stateHash(bytes) {
  return bytes === null ? null : digest(bytes);
}

function stateMatches(current, sha256, mode) {
  return stateHash(current.bytes) === sha256 && (
    sha256 === null ||
    process.platform === "win32" ||
    mode === null ||
    current.mode === mode
  );
}

function blobReference(bytes) {
  return bytes === null ? null : `${digest(bytes).slice("sha256:".length)}.bin`;
}

function normalizeChanges(changes) {
  if (!Array.isArray(changes) || changes.length < 1) {
    throw transactionError("WRITE006", "A file transaction requires at least one change.");
  }
  if (changes.length > FILE_TRANSACTION_POLICY.maximumRecords) {
    throw transactionError("WRITE006", "File transaction change count exceeds its limit.");
  }
  const records = [];
  let totalPreparedBytes = 0;
  const add = (record) => {
    for (const bytes of [record.before, record.after]) {
      if (bytes !== null) totalPreparedBytes += bytes.length;
    }
    records.push(record);
  };
  for (let changeIndex = 0; changeIndex < changes.length; changeIndex += 1) {
    const change = changes[changeIndex];
    if (change === null || typeof change !== "object" || Array.isArray(change)) {
      throw transactionError("WRITE006", `Change ${changeIndex} must be an object.`);
    }
    const kind = change.kind;
    if (!new Set(["create", "update", "delete", "move"]).has(kind)) {
      throw transactionError("WRITE006", `Change ${changeIndex} has an unsupported kind.`);
    }
    if (kind === "move") {
      const fromPath = portablePath(change.fromPath, `Change ${changeIndex} fromPath`);
      const toPath = portablePath(change.toPath, `Change ${changeIndex} toPath`);
      if (fromPath.toLowerCase() === toPath.toLowerCase()) {
        throw transactionError("WRITE006", `Change ${changeIndex} move paths collide portably.`);
      }
      const before = fileBytes(change.before, `Change ${changeIndex} before`);
      const after = change.after === undefined
        ? before
        : fileBytes(change.after, `Change ${changeIndex} after`);
      const mode = modeValue(change.mode, `Change ${changeIndex} mode`);
      add({ changeIndex, leg: "move-destination", path: toPath, before: null, after, requestedMode: mode });
      add({ changeIndex, leg: "move-source", path: fromPath, before, after: null, requestedMode: null });
      continue;
    }
    const path = portablePath(change.path, `Change ${changeIndex} path`);
    const mode = modeValue(change.mode, `Change ${changeIndex} mode`);
    if (kind === "create") {
      add({ changeIndex, leg: "single", path, before: null, after: fileBytes(change.after, `Change ${changeIndex} after`), requestedMode: mode });
    } else if (kind === "update") {
      const before = fileBytes(change.before, `Change ${changeIndex} before`);
      const after = fileBytes(change.after, `Change ${changeIndex} after`);
      if (before.equals(after) && mode === null) {
        throw transactionError("WRITE006", `Change ${changeIndex} is an unbounded no-op.`);
      }
      add({ changeIndex, leg: "single", path, before, after, requestedMode: mode });
    } else {
      add({ changeIndex, leg: "single", path, before: fileBytes(change.before, `Change ${changeIndex} before`), after: null, requestedMode: null });
    }
  }
  if (records.length > FILE_TRANSACTION_POLICY.maximumRecords) {
    throw transactionError("WRITE006", "Expanded file transaction record count exceeds its limit.");
  }
  if (totalPreparedBytes > FILE_TRANSACTION_POLICY.maximumTotalPreparedBytes) {
    throw transactionError("WRITE006", "File transaction exceeds its prepared-byte limit.");
  }
  records.sort((left, right) =>
    Number(left.after === null) - Number(right.after === null) ||
    left.path.localeCompare(right.path) ||
    left.changeIndex - right.changeIndex ||
    left.leg.localeCompare(right.leg)
  );
  const seen = new Set();
  for (const record of records) {
    const key = record.path.normalize("NFC").toLowerCase();
    if (seen.has(key)) {
      throw transactionError("WRITE006", `Transaction repeats a portable target: ${record.path}`);
    }
    seen.add(key);
  }
  const inputPlan = records.map((record) => ({
    path: record.path,
    changeIndex: record.changeIndex,
    leg: record.leg,
    beforeSha256: stateHash(record.before),
    afterSha256: stateHash(record.after),
    requestedMode: record.requestedMode,
  }));
  return { records, inputPlanSha256: digest(Buffer.from(JSON.stringify(inputPlan), "utf8")) };
}

function validateRecord(record, index) {
  exactKeys(record, [
    "index", "changeIndex", "leg", "path", "beforeSha256", "afterSha256",
    "beforeBlob", "afterBlob", "beforeMode", "afterMode",
  ], `Transaction record ${index}`);
  if (record.index !== index || !Number.isSafeInteger(record.changeIndex) || record.changeIndex < 0) {
    throw transactionError("WRITE006", `Transaction record ${index} order is invalid.`);
  }
  if (!new Set(["single", "move-destination", "move-source"]).has(record.leg)) {
    throw transactionError("WRITE006", `Transaction record ${index} leg is invalid.`);
  }
  portablePath(record.path, `Transaction record ${index} path`);
  validDigest(record.beforeSha256, `Transaction record ${index} beforeSha256`, { nullable: true });
  validDigest(record.afterSha256, `Transaction record ${index} afterSha256`, { nullable: true });
  for (const pair of [["beforeBlob", "beforeSha256"], ["afterBlob", "afterSha256"]]) {
    const [blobKey, hashKey] = pair;
    if (record[hashKey] === null) {
      if (record[blobKey] !== null) throw transactionError("WRITE006", `Transaction record ${index} blob binding is inconsistent.`);
    } else if (record[blobKey] !== `${record[hashKey].slice("sha256:".length)}.bin`) {
      throw transactionError("WRITE006", `Transaction record ${index} blob binding is invalid.`);
    }
  }
  modeValue(record.beforeMode, `Transaction record ${index} beforeMode`);
  modeValue(record.afterMode, `Transaction record ${index} afterMode`);
  return record;
}

function planSha256(journal) {
  return digest(Buffer.from(JSON.stringify({
    schemaVersion: journal.schemaVersion,
    kind: journal.kind,
    transactionId: journal.transactionId,
    transactionDigest: journal.transactionDigest,
    rootIdentity: journal.rootIdentity,
    inputPlanSha256: journal.inputPlanSha256,
    records: journal.records,
  }), "utf8"));
}

function validateJournal(value, expected = {}) {
  exactKeys(value, [
    "schemaVersion", "kind", "transactionId", "transactionDigest", "rootIdentity",
    "inputPlanSha256", "planSha256", "status", "receiptSha256", "createdAt",
    "updatedAt", "records",
  ], "File transaction journal");
  if (value.schemaVersion !== FILE_TRANSACTION_POLICY.schemaVersion) {
    throw transactionError("SCHEMA001", `Unsupported file transaction schema: ${value.schemaVersion}`);
  }
  if (value.kind !== JOURNAL_KIND) throw transactionError("WRITE006", "File transaction journal kind is invalid.");
  validTransactionId(value.transactionId);
  for (const key of ["transactionDigest", "rootIdentity", "inputPlanSha256", "planSha256"]) {
    validDigest(value[key], `File transaction ${key}`);
    if (expected[key] && value[key] !== expected[key]) {
      throw transactionError("WRITE006", `File transaction ${key} does not match.`);
    }
  }
  if (expected.transactionId && value.transactionId !== expected.transactionId) {
    throw transactionError("WRITE006", "File transaction ID does not match.");
  }
  if (!JOURNAL_STATES.has(value.status)) throw transactionError("WRITE006", "File transaction state is invalid.");
  validDigest(value.receiptSha256, "File transaction receiptSha256", { nullable: true });
  const receiptBound = new Set(["finalized-pending-receipt", "finalized"]).has(value.status);
  if (receiptBound !== (value.receiptSha256 !== null)) {
    throw transactionError("WRITE006", "Committed file transaction receipt binding is inconsistent.");
  }
  for (const key of ["createdAt", "updatedAt"]) {
    if (typeof value[key] !== "string" || value[key].length > 64 || Number.isNaN(Date.parse(value[key]))) {
      throw transactionError("WRITE006", `File transaction ${key} is invalid.`);
    }
  }
  if (!Array.isArray(value.records) || value.records.length < 1 || value.records.length > FILE_TRANSACTION_POLICY.maximumRecords) {
    throw transactionError("WRITE006", "File transaction record count is invalid.");
  }
  value.records.forEach(validateRecord);
  const seen = new Set();
  for (const record of value.records) {
    const key = record.path.normalize("NFC").toLowerCase();
    if (seen.has(key)) throw transactionError("WRITE006", `File transaction repeats a target: ${record.path}`);
    seen.add(key);
  }
  if (value.planSha256 !== planSha256(value)) throw transactionError("WRITE006", "File transaction plan digest is invalid.");
  return value;
}

function validateActive(value, expected = {}) {
  exactKeys(value, [
    "schemaVersion", "kind", "transactionId", "transactionDigest",
    "rootIdentity", "planSha256", "createdAt",
  ], "Active file transaction marker");
  if (value.schemaVersion !== FILE_TRANSACTION_POLICY.schemaVersion) {
    throw transactionError("SCHEMA001", `Unsupported active transaction schema: ${value.schemaVersion}`);
  }
  if (value.kind !== ACTIVE_KIND) throw transactionError("WRITE006", "Active file transaction marker kind is invalid.");
  validTransactionId(value.transactionId);
  for (const key of ["transactionDigest", "rootIdentity", "planSha256"]) {
    validDigest(value[key], `Active transaction ${key}`);
    if (expected[key] && value[key] !== expected[key]) throw transactionError("WRITE007", `Active transaction ${key} does not match.`);
  }
  if (expected.transactionId && value.transactionId !== expected.transactionId) {
    throw transactionError("WRITE007", `Another canonical writer is active: ${value.transactionId}`);
  }
  if (typeof value.createdAt !== "string" || value.createdAt.length > 64 || Number.isNaN(Date.parse(value.createdAt))) {
    throw transactionError("WRITE006", "Active transaction timestamp is invalid.");
  }
  return value;
}

async function readControl(path, directory, maximumBytes, label) {
  const directoryMetadata = await metadataIfPresent(directory);
  if (!directoryMetadata) return null;
  const bytes = await readBoundedRegularFileIfPresent(path, {
    containmentRoot: directory,
    maximumBytes,
    code: "WRITE006",
    label,
  });
  if (bytes === null) return null;
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw transactionError("WRITE006", `${label} is invalid JSON or UTF-8.`);
  }
  return { bytes, value };
}

async function readJournalAt(paths, expected = {}) {
  const loaded = await readControl(
    paths.journal,
    paths.transactionRoot,
    FILE_TRANSACTION_POLICY.maximumJournalBytes,
    "File transaction journal",
  );
  if (!loaded) return null;
  return { bytes: loaded.bytes, value: validateJournal(loaded.value, expected) };
}

async function readActiveAt(paths, expected = {}) {
  const loaded = await readControl(
    paths.active,
    paths.transactionsRoot,
    FILE_TRANSACTION_POLICY.maximumControlBytes,
    "Active file transaction marker",
  );
  if (!loaded) return null;
  return { bytes: loaded.bytes, value: validateActive(loaded.value, expected) };
}

async function boundary(hooks, name, details = {}) {
  await hooks?.boundary?.(name, Object.freeze({ ...details }));
}

async function writeControlAtomic({ path, directory, root, value, expectedBytes, label }) {
  const bytes = jsonBytes(value);
  const maximum = path.endsWith("journal.json")
    ? FILE_TRANSACTION_POLICY.maximumJournalBytes
    : FILE_TRANSACTION_POLICY.maximumControlBytes;
  if (bytes.length > maximum) throw transactionError("WRITE006", `${label} exceeds its byte limit.`);
  const guard = createStableDirectoryGuard(root, directory, { code: "WRITE006", label: `${label} directory` });
  await guard.prepare();
  await writeBufferAtomic(path, bytes, 0o600, async () => {
    await guard.assert();
    const current = await readBoundedRegularFileIfPresent(path, {
      containmentRoot: directory,
      maximumBytes: maximum,
      code: "WRITE006",
      label,
    });
    const matches = current === null
      ? expectedBytes === null
      : Buffer.isBuffer(expectedBytes) && current.equals(expectedBytes);
    if (!matches) throw transactionError("WRITE001", `${label} changed before publication.`);
  }, () => guard.prepare());
  return bytes;
}

function digestFilename(value) {
  return validDigest(value, "Transaction ownership digest").slice("sha256:".length);
}

function activePublishResiduePath(paths, active) {
  return join(paths.transactionsRoot, `.syncora-active-${digestFilename(active.planSha256)}.pending`);
}

function activeReleaseResiduePath(paths, active) {
  return join(paths.transactionsRoot, `.syncora-active-${digestFilename(active.planSha256)}.retired`);
}

async function removeExactResidue({
  root,
  directory,
  path,
  expectedBytes,
  maximumBytes,
  label,
  code = "WRITE006",
  allowPartialOwned = false,
}) {
  const directoryMetadata = await metadataIfPresent(directory);
  if (!directoryMetadata) return false;
  if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
    throw transactionError(code, `${label} directory is not a safe directory.`);
  }
  const guard = createStableDirectoryGuard(root, directory, {
    code,
    label: `${label} directory`,
  });
  await guard.prepare();
  await guard.assert();
  const current = await readBoundedRegularFileIfPresent(path, {
    containmentRoot: directory,
    maximumBytes,
    code,
    label,
  });
  if (current === null) return false;
  if (!current.equals(expectedBytes) && !allowPartialOwned) {
    throw transactionError(code, `${label} exists with bytes not owned by this transaction.`, {
      expectedSha256: digest(expectedBytes),
      currentSha256: digest(current),
    });
  }
  await guard.assert();
  await rm(path);
  await syncDirectoryEntry(directory);
  return true;
}

async function writeActiveExclusive(paths, active, hooks) {
  const bytes = jsonBytes(active);
  const guard = createStableDirectoryGuard(paths.graphRoot, paths.transactionsRoot, {
    code: "WRITE006",
    label: "Active transaction directory",
  });
  await guard.prepare();
  const temporaryPath = activePublishResiduePath(paths, active);
  await removeExactResidue({
    root: paths.graphRoot,
    directory: paths.transactionsRoot,
    path: temporaryPath,
    expectedBytes: bytes,
    maximumBytes: FILE_TRANSACTION_POLICY.maximumControlBytes,
    label: "Pending active transaction marker",
    allowPartialOwned: true,
  });
  await boundary(hooks, "prepare.before-active", { transactionId: active.transactionId });
  await guard.assert();
  try {
    await publishImmutableFile({
      root: paths.transactionsRoot,
      path: paths.active,
      temporaryPath,
      bytes,
      maximumBytes: FILE_TRANSACTION_POLICY.maximumControlBytes,
      code: "WRITE006",
      collisionCode: "WRITE007",
      label: "Active file transaction marker",
    }, {
      afterTemporarySync: () => boundary(hooks, "prepare.active-after-temporary", {
        transactionId: active.transactionId,
      }),
      beforePublish: () => boundary(hooks, "prepare.active-before-publish", {
        transactionId: active.transactionId,
      }),
      afterPublish: () => boundary(hooks, "prepare.active-after-publish", {
        transactionId: active.transactionId,
      }),
    });
  } catch (error) {
    if (error?.code === "IMMUTABLE002") {
      throw transactionError("WRITE007", "Another canonical writer became active.");
    }
    throw error;
  }
  await guard.assert();
  await boundary(hooks, "prepare.after-active", { transactionId: active.transactionId });
  return bytes;
}

async function removeActiveOwned(paths, loadedActive, hooks, prefix) {
  const guard = createStableDirectoryGuard(paths.graphRoot, paths.transactionsRoot, {
    code: "WRITE006",
    label: "Active transaction directory",
  });
  await guard.prepare();
  await boundary(hooks, `${prefix}.before-active-release`, { transactionId: loadedActive.value.transactionId });
  await guard.assert();
  const latest = await readActiveAt(paths, {
    transactionId: loadedActive.value.transactionId,
    transactionDigest: loadedActive.value.transactionDigest,
    rootIdentity: loadedActive.value.rootIdentity,
    planSha256: loadedActive.value.planSha256,
  });
  if (!latest || !latest.bytes.equals(loadedActive.bytes)) {
    throw transactionError("WRITE007", "Active transaction marker changed before release.");
  }
  const retired = activeReleaseResiduePath(paths, loadedActive.value);
  await removeExactResidue({
    root: paths.graphRoot,
    directory: paths.transactionsRoot,
    path: retired,
    expectedBytes: loadedActive.bytes,
    maximumBytes: FILE_TRANSACTION_POLICY.maximumControlBytes,
    label: "Retired active transaction marker",
  });
  await rename(paths.active, retired);
  await syncDirectoryEntry(paths.transactionsRoot);
  await boundary(hooks, `${prefix}.after-active-retire`, { transactionId: loadedActive.value.transactionId });
  const retiredBytes = await readBoundedRegularFileIfPresent(retired, {
    containmentRoot: paths.transactionsRoot,
    maximumBytes: FILE_TRANSACTION_POLICY.maximumControlBytes,
    code: "WRITE006",
    label: "Retired active transaction marker",
  });
  if (!retiredBytes?.equals(loadedActive.bytes)) {
    throw transactionError("WRITE007", "Active transaction marker changed during release.", { retired });
  }
  await rm(retired);
  await syncDirectoryEntry(paths.transactionsRoot);
  await boundary(hooks, `${prefix}.after-active-release`, { transactionId: loadedActive.value.transactionId });
}

function activeMarkerFromJournal(journal) {
  return {
    schemaVersion: FILE_TRANSACTION_POLICY.schemaVersion,
    kind: ACTIVE_KIND,
    transactionId: journal.transactionId,
    transactionDigest: journal.transactionDigest,
    rootIdentity: journal.rootIdentity,
    planSha256: journal.planSha256,
    createdAt: journal.createdAt,
  };
}

async function cleanupActiveResidues(paths, journal) {
  const marker = activeMarkerFromJournal(journal);
  const bytes = jsonBytes(marker);
  await removeExactResidue({
    root: paths.graphRoot,
    directory: paths.transactionsRoot,
    path: activePublishResiduePath(paths, marker),
    expectedBytes: bytes,
    maximumBytes: FILE_TRANSACTION_POLICY.maximumControlBytes,
    label: "Pending active transaction marker",
    allowPartialOwned: true,
  });
  await removeExactResidue({
    root: paths.graphRoot,
    directory: paths.transactionsRoot,
    path: activeReleaseResiduePath(paths, marker),
    expectedBytes: bytes,
    maximumBytes: FILE_TRANSACTION_POLICY.maximumControlBytes,
    label: "Retired active transaction marker",
  });
}

async function loadBlob(paths, reference, expectedHash) {
  if (reference === null) return null;
  const bytes = await readBoundedRegularFileIfPresent(join(paths.blobs, reference), {
    containmentRoot: paths.blobs,
    maximumBytes: FILE_TRANSACTION_POLICY.maximumFileBytes,
    code: "WRITE006",
    label: "File transaction blob",
  });
  if (bytes === null || digest(bytes) !== expectedHash) {
    throw transactionError("WRITE006", `File transaction blob is missing or corrupt: ${reference}`);
  }
  return bytes;
}

function recordResiduePaths(paths, journal, record, direction) {
  const parent = dirname(absoluteTarget(paths.graphRoot, record.path));
  const owner = digestFilename(journal.planSha256);
  const stem = `.syncora-txn-${owner}-${record.index}-${direction}`;
  return {
    parent,
    temporary: join(parent, `${stem}.stage`),
    retired: join(parent, `${stem}.retired`),
  };
}

async function cleanupRecordResidues(paths, journal) {
  for (const record of journal.records) {
    for (const direction of ["forward", "backward"]) {
      const residue = recordResiduePaths(paths, journal, record, direction);
      const desired = desiredState(record, direction);
      if (desired.blob !== null) {
        const bytes = await loadBlob(paths, desired.blob, desired.sha256);
        await removeExactResidue({
          root: paths.graphRoot,
          directory: residue.parent,
          path: residue.temporary,
          expectedBytes: bytes,
          maximumBytes: FILE_TRANSACTION_POLICY.maximumFileBytes,
          label: `Transaction ${direction} staging residue`,
          allowPartialOwned: true,
        });
      }
      if (desired.sha256 === null) {
        const expectedBlob = direction === "forward" ? record.beforeBlob : record.afterBlob;
        const expectedSha256 = direction === "forward" ? record.beforeSha256 : record.afterSha256;
        if (expectedBlob !== null) {
          const bytes = await loadBlob(paths, expectedBlob, expectedSha256);
          await removeExactResidue({
            root: paths.graphRoot,
            directory: residue.parent,
            path: residue.retired,
            expectedBytes: bytes,
            maximumBytes: FILE_TRANSACTION_POLICY.maximumFileBytes,
            label: `Transaction ${direction} retired residue`,
          });
        }
      }
    }
  }
}

async function cleanupTransactionResidues(paths, journal) {
  await cleanupRecordResidues(paths, journal);
  await cleanupActiveResidues(paths, journal);
}

async function writeBlobs(paths, records, hooks) {
  const guard = createStableDirectoryGuard(paths.graphRoot, paths.blobs, {
    code: "WRITE006",
    label: "File transaction blob directory",
  });
  await guard.prepare();
  await syncDirectoryEntry(paths.transactionRoot);
  const blobs = new Map();
  for (const record of records) {
    for (const bytes of [record.before, record.after]) {
      if (bytes !== null) blobs.set(blobReference(bytes), bytes);
    }
  }
  for (const [reference, bytes] of [...blobs.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const path = join(paths.blobs, reference);
    const existing = await readBoundedRegularFileIfPresent(path, {
      containmentRoot: paths.blobs,
      maximumBytes: FILE_TRANSACTION_POLICY.maximumFileBytes,
      code: "WRITE006",
      label: "File transaction blob",
    });
    if (existing !== null && !existing.equals(bytes)) {
      throw transactionError("WRITE006", `Content-addressed blob is corrupt: ${reference}`);
    }
    if (existing === null) {
      await boundary(hooks, "prepare.before-blob", { reference });
      await writeBufferAtomic(path, bytes, 0o600, async () => {
        await guard.assert();
        const latest = await readBoundedRegularFileIfPresent(path, {
          containmentRoot: paths.blobs,
          maximumBytes: FILE_TRANSACTION_POLICY.maximumFileBytes,
          code: "WRITE006",
          label: "File transaction blob",
        });
        if (latest !== null && !latest.equals(bytes)) {
          throw transactionError("WRITE006", `Content-addressed blob changed: ${reference}`);
        }
      }, () => guard.prepare());
      await boundary(hooks, "prepare.after-blob", { reference });
    }
  }
}

async function updateJournal(paths, loaded, status, receiptSha256, hooks, prefix) {
  const next = {
    ...loaded.value,
    status,
    receiptSha256,
    updatedAt: new Date().toISOString(),
  };
  validateJournal(next, { transactionId: loaded.value.transactionId });
  await boundary(hooks, `${prefix}.before-journal`, { transactionId: next.transactionId, status });
  const bytes = await writeControlAtomic({
    path: paths.journal,
    directory: paths.transactionRoot,
    root: paths.graphRoot,
    value: next,
    expectedBytes: loaded.bytes,
    label: "File transaction journal",
  });
  await boundary(hooks, `${prefix}.after-journal`, { transactionId: next.transactionId, status });
  return { bytes, value: next };
}

function expectedState(record, direction) {
  return direction === "forward"
    ? { sha256: record.beforeSha256, mode: record.beforeMode }
    : { sha256: record.afterSha256, mode: record.afterMode };
}

function desiredState(record, direction) {
  return direction === "forward"
    ? { sha256: record.afterSha256, mode: record.afterMode, blob: record.afterBlob }
    : { sha256: record.beforeSha256, mode: record.beforeMode, blob: record.beforeBlob };
}

async function preflight(graphRoot, records, direction) {
  const conflicts = [];
  let total = 0;
  for (const record of records) {
    const current = await readCurrent(graphRoot, record);
    const expected = expectedState(record, direction);
    const desired = desiredState(record, direction);
    if (!stateMatches(current, expected.sha256, expected.mode) && !stateMatches(current, desired.sha256, desired.mode)) {
      total += 1;
      if (conflicts.length < 16) conflicts.push({
        path: record.path,
        currentSha256: stateHash(current.bytes),
        expectedSha256: expected.sha256,
        desiredSha256: desired.sha256,
      });
    }
  }
  if (total > 0) {
    throw transactionError(direction === "forward" ? "WRITE001" : "WRITE005", `File transaction ${direction} preflight found concurrent bytes.`, {
      conflicts,
      conflictsTotal: total,
      conflictsTruncated: total > conflicts.length,
    });
  }
}

async function assertPostimage(graphRoot, records, code = "WRITE001") {
  for (const record of records) {
    const current = await readCurrent(graphRoot, record);
    if (!stateMatches(current, record.afterSha256, record.afterMode)) {
      throw transactionError(code, `Committed transaction post-image changed: ${record.path}`);
    }
  }
}

async function publishRecord(paths, journal, record, direction, hooks) {
  const expected = expectedState(record, direction);
  const desired = desiredState(record, direction);
  const residue = recordResiduePaths(paths, journal, record, direction);
  const current = await readCurrent(paths.graphRoot, record);
  if (stateMatches(current, desired.sha256, desired.mode)) return "already";
  if (!stateMatches(current, expected.sha256, expected.mode)) {
    throw transactionError(direction === "forward" ? "WRITE001" : "WRITE005", `Transaction target changed: ${record.path}`);
  }
  const desiredBytes = await loadBlob(paths, desired.blob, desired.sha256);
  const parentGuard = createStableDirectoryGuard(paths.graphRoot, dirname(current.path), {
    code: direction === "forward" ? "WRITE001" : "WRITE005",
    label: "File transaction publication directory",
  });
  await parentGuard.prepare();
  await boundary(hooks, `${direction}.record.before`, { index: record.index, path: record.path });
  if (desiredBytes === null) {
    await parentGuard.assert();
    const latest = await readCurrent(paths.graphRoot, record);
    if (!stateMatches(latest, expected.sha256, expected.mode)) {
      throw transactionError(direction === "forward" ? "WRITE001" : "WRITE005", `Delete target changed before rename: ${record.path}`);
    }
    const retired = residue.retired;
    await boundary(hooks, `${direction}.record.before-rename`, { index: record.index, path: record.path });
    await rename(current.path, retired);
    await syncDirectoryEntry(dirname(current.path));
    await boundary(hooks, `${direction}.record.after-rename`, { index: record.index, path: record.path });
    const retiredBytes = await readBoundedRegularFileIfPresent(retired, {
      containmentRoot: dirname(current.path),
      maximumBytes: FILE_TRANSACTION_POLICY.maximumFileBytes,
      code: direction === "forward" ? "WRITE001" : "WRITE005",
      label: "Retired transaction target",
    });
    if (stateHash(retiredBytes) !== expected.sha256) {
      throw transactionError(direction === "forward" ? "WRITE001" : "WRITE005", `Delete target changed during rename: ${record.path}`, { retired });
    }
    await rm(retired);
    await syncDirectoryEntry(dirname(current.path));
  } else {
    let publicationCheck = 0;
    await writeBufferAtomic(current.path, desiredBytes, desired.mode ?? undefined, async () => {
      await parentGuard.assert();
      await boundary(hooks, publicationCheck === 0
        ? `${direction}.record.before-temporary`
        : `${direction}.record.before-rename`, { index: record.index, path: record.path });
      publicationCheck += 1;
      const latest = await readCurrent(paths.graphRoot, record);
      if (!stateMatches(latest, expected.sha256, expected.mode)) {
        throw transactionError(direction === "forward" ? "WRITE001" : "WRITE005", `Transaction target changed before publish: ${record.path}`);
      }
    }, () => parentGuard.prepare(), {
      temporaryPath: residue.temporary,
      afterTemporarySync: () => boundary(hooks, `${direction}.record.after-temporary`, {
        index: record.index,
        path: record.path,
      }),
    });
  }
  await parentGuard.assert();
  const verified = await readCurrent(paths.graphRoot, record);
  if (!stateMatches(verified, desired.sha256, desired.mode)) {
    throw transactionError(direction === "forward" ? "WRITE001" : "WRITE005", `Transaction target did not publish exact bytes: ${record.path}`);
  }
  await boundary(hooks, `${direction}.record.after`, { index: record.index, path: record.path });
  return "published";
}

async function requireActive(paths, journal) {
  const active = await readActiveAt(paths, {
    transactionId: journal.transactionId,
    transactionDigest: journal.transactionDigest,
    rootIdentity: journal.rootIdentity,
    planSha256: journal.planSha256,
  });
  if (!active) throw transactionError("WRITE007", "Active file transaction marker is missing.");
  return active;
}

async function clearTerminalActiveIfPresent(paths, rootIdentity, hooks) {
  const active = await readActiveAt(paths);
  if (!active) return null;
  if (active.value.rootIdentity !== rootIdentity) {
    throw transactionError("WRITE007", "Active transaction belongs to another graph identity.");
  }
  const activePaths = fileTransactionPaths(paths.graphRoot, active.value.transactionId);
  const journal = await readJournalAt(activePaths, {
    transactionId: active.value.transactionId,
    transactionDigest: active.value.transactionDigest,
    rootIdentity,
    planSha256: active.value.planSha256,
  });
  if (!journal || !TERMINAL_STATES.has(journal.value.status)) {
    throw transactionError("WRITE007", `Another canonical writer is active: ${active.value.transactionId}`);
  }
  await removeActiveOwned(paths, active, hooks, "cleanup");
  await cleanupTransactionResidues(activePaths, journal.value);
  return active.value.transactionId;
}

export async function readActiveFileTransaction(graphRoot) {
  const root = await resolveGraphRoot(graphRoot);
  const paths = fileTransactionPaths(root.graphRoot, "read-active");
  const active = await readActiveAt(paths);
  return active?.value ?? null;
}

export async function assertFileTransactionAvailable({ graphRoot, transactionId = undefined }) {
  const root = await resolveGraphRoot(graphRoot);
  const paths = fileTransactionPaths(root.graphRoot, transactionId ?? "availability-check");
  const active = await readActiveAt(paths);
  if (active && active.value.transactionId !== transactionId) {
    const activePaths = fileTransactionPaths(
      root.graphRoot,
      active.value.transactionId,
    );
    const journal = await readJournalAt(activePaths, {
      transactionId: active.value.transactionId,
      transactionDigest: active.value.transactionDigest,
      rootIdentity: root.rootIdentity,
      planSha256: active.value.planSha256,
    });
    if (journal && TERMINAL_STATES.has(journal.value.status)) {
      return null;
    }
    throw transactionError("WRITE007", `Another canonical writer is active: ${active.value.transactionId}`);
  }
  return active?.value ?? null;
}

export async function readFileTransaction({ graphRoot, transactionId }) {
  const root = await resolveGraphRoot(graphRoot);
  const paths = fileTransactionPaths(root.graphRoot, transactionId);
  const journal = await readJournalAt(paths, { transactionId, rootIdentity: root.rootIdentity });
  return journal?.value ?? null;
}

export async function prepareFileTransaction({
  graphRoot,
  transactionId,
  transactionDigest,
  changes,
}, hooks = {}) {
  validTransactionId(transactionId);
  validDigest(transactionDigest, "Transaction digest");
  const normalized = normalizeChanges(changes);
  const root = await resolveGraphRoot(graphRoot);
  return withPatchLock(root.graphRoot, async () => {
    const currentRoot = await resolveGraphRoot(root.graphRoot);
    if (currentRoot.rootIdentity !== root.rootIdentity) throw transactionError("WRITE002", "Graph root changed before prepare.");
    const paths = fileTransactionPaths(root.graphRoot, transactionId);
    const rootGuard = createStableDirectoryGuard(root.graphRoot, paths.transactionRoot, {
      code: "WRITE006",
      label: "File transaction directory",
    });
    await rootGuard.prepare();
    await syncDirectoryEntry(paths.transactionsRoot);
    const existing = await readJournalAt(paths, { transactionId, transactionDigest, rootIdentity: root.rootIdentity });
    if (existing) {
      if (existing.value.inputPlanSha256 !== normalized.inputPlanSha256) {
        throw transactionError("WRITE006", "Transaction ID already binds another input plan.");
      }
      if (!TERMINAL_STATES.has(existing.value.status)) {
        const active = await readActiveAt(paths);
        if (!active && existing.value.status === "prepared") {
          await writeActiveExclusive(paths, activeMarkerFromJournal(existing.value), hooks);
        } else {
          await requireActive(paths, existing.value);
        }
        await cleanupTransactionResidues(paths, existing.value);
      }
      return { journal: existing.value, created: false };
    }
    await clearTerminalActiveIfPresent(paths, root.rootIdentity, hooks);
    const active = await readActiveAt(paths);
    if (active) throw transactionError("WRITE007", `Another canonical writer is active: ${active.value.transactionId}`);

    const inspected = [];
    for (const record of normalized.records) {
      const current = await readCurrent(root.graphRoot, record);
      if (stateHash(current.bytes) !== stateHash(record.before)) {
        throw transactionError("WRITE001", `Transaction before bytes are stale: ${record.path}`);
      }
      inspected.push({ record, current });
    }
    const sourceModes = new Map(inspected
      .filter(({ record }) => record.leg === "move-source")
      .map(({ record, current }) => [record.changeIndex, current.mode]));
    const records = inspected.map(({ record, current }, index) => ({
      index,
      changeIndex: record.changeIndex,
      leg: record.leg,
      path: record.path,
      beforeSha256: stateHash(record.before),
      afterSha256: stateHash(record.after),
      beforeBlob: blobReference(record.before),
      afterBlob: blobReference(record.after),
      beforeMode: current.mode,
      afterMode: record.after === null
        ? null
        : record.requestedMode ?? (
          record.leg === "move-destination"
            ? sourceModes.get(record.changeIndex) ?? null
            : current.mode
        ),
    }));
    await writeBlobs(paths, normalized.records, hooks);
    const now = new Date().toISOString();
    const journal = {
      schemaVersion: FILE_TRANSACTION_POLICY.schemaVersion,
      kind: JOURNAL_KIND,
      transactionId,
      transactionDigest,
      rootIdentity: root.rootIdentity,
      inputPlanSha256: normalized.inputPlanSha256,
      planSha256: null,
      status: "prepared",
      receiptSha256: null,
      createdAt: now,
      updatedAt: now,
      records,
    };
    journal.planSha256 = planSha256(journal);
    validateJournal(journal, { transactionId, transactionDigest, rootIdentity: root.rootIdentity });
    await boundary(hooks, "prepare.before-journal", { transactionId });
    const journalBytes = await writeControlAtomic({
      path: paths.journal,
      directory: paths.transactionRoot,
      root: paths.graphRoot,
      value: journal,
      expectedBytes: null,
      label: "File transaction journal",
    });
    await boundary(hooks, "prepare.after-journal", { transactionId });
    const marker = activeMarkerFromJournal(journal);
    try {
      await writeActiveExclusive(paths, marker, hooks);
    } catch (error) {
      if (error?.code !== "WRITE007") throw error;
      const raced = await readActiveAt(paths);
      if (!raced || raced.value.transactionId !== transactionId || raced.value.planSha256 !== journal.planSha256) throw error;
    }
    const durableJournal = await readJournalAt(paths, { transactionId, transactionDigest, rootIdentity: root.rootIdentity });
    if (!durableJournal?.bytes.equals(journalBytes)) throw transactionError("WRITE006", "Prepared transaction journal did not remain exact.");
    return { journal, created: true };
  });
}

export async function applyFileTransaction({ graphRoot, transactionId, transactionDigest }, hooks = {}) {
  validTransactionId(transactionId);
  validDigest(transactionDigest, "Transaction digest");
  const root = await resolveGraphRoot(graphRoot);
  return withPatchLock(root.graphRoot, async () => {
    const paths = fileTransactionPaths(root.graphRoot, transactionId);
    let loaded = await readJournalAt(paths, { transactionId, transactionDigest, rootIdentity: root.rootIdentity });
    if (!loaded) throw transactionError("WRITE006", "File transaction journal does not exist.");
    if (loaded.value.status === "finalized") {
      await cleanupTransactionResidues(paths, loaded.value);
      return { journal: loaded.value, summary: { published: 0, already: loaded.value.records.length, total: loaded.value.records.length }, changed: false };
    }
    if (loaded.value.status === "rolled-back" || loaded.value.status === "rolling-back") {
      throw transactionError("WRITE008", "A rolled-back file transaction cannot be applied.");
    }
    await requireActive(paths, loaded.value);
    await cleanupTransactionResidues(paths, loaded.value);
    if (loaded.value.status === "finalized-pending-receipt") {
      await assertPostimage(root.graphRoot, loaded.value.records);
      return { journal: loaded.value, summary: { published: 0, already: loaded.value.records.length, total: loaded.value.records.length }, changed: false };
    }
    if (loaded.value.status === "awaiting-finalization") {
      await preflight(root.graphRoot, loaded.value.records, "forward");
      return { journal: loaded.value, summary: { published: 0, already: loaded.value.records.length, total: loaded.value.records.length }, changed: false };
    }
    await boundary(hooks, "apply.before-preflight", { transactionId });
    await preflight(root.graphRoot, loaded.value.records, "forward");
    await boundary(hooks, "apply.after-preflight", { transactionId });
    if (loaded.value.status !== "applying") {
      loaded = await updateJournal(paths, loaded, "applying", null, hooks, "apply");
    }
    let published = 0;
    let already = 0;
    for (const record of loaded.value.records) {
      const outcome = await publishRecord(paths, loaded.value, record, "forward", hooks);
      if (outcome === "published") published += 1;
      else already += 1;
    }
    loaded = await updateJournal(paths, loaded, "awaiting-finalization", null, hooks, "apply");
    await cleanupRecordResidues(paths, loaded.value);
    return { journal: loaded.value, summary: { published, already, total: loaded.value.records.length }, changed: published > 0 };
  });
}

export async function commitFileTransaction({
  graphRoot,
  transactionId,
  transactionDigest,
  receiptSha256,
}, hooks = {}) {
  validTransactionId(transactionId);
  validDigest(transactionDigest, "Transaction digest");
  validDigest(receiptSha256, "Receipt digest");
  const root = await resolveGraphRoot(graphRoot);
  return withPatchLock(root.graphRoot, async () => {
    const paths = fileTransactionPaths(root.graphRoot, transactionId);
    let loaded = await readJournalAt(paths, { transactionId, transactionDigest, rootIdentity: root.rootIdentity });
    if (!loaded) throw transactionError("WRITE006", "File transaction journal does not exist.");
    if (new Set(["finalized-pending-receipt", "finalized"]).has(loaded.value.status)) {
      if (loaded.value.receiptSha256 !== receiptSha256) {
        throw transactionError("WRITE008", "Committed transaction binds another receipt.");
      }
      if (loaded.value.status === "finalized-pending-receipt") {
        await requireActive(paths, loaded.value);
        await cleanupTransactionResidues(paths, loaded.value);
        await assertPostimage(root.graphRoot, loaded.value.records);
      }
      return { journal: loaded.value, changed: false };
    }
    if (loaded.value.status !== "awaiting-finalization") {
      throw transactionError("WRITE008", "Only a fully published transaction can be committed.");
    }
    await requireActive(paths, loaded.value);
    await cleanupTransactionResidues(paths, loaded.value);
    await boundary(hooks, "commit.before-postimage", { transactionId });
    await assertPostimage(root.graphRoot, loaded.value.records);
    await boundary(hooks, "commit.after-postimage", { transactionId });
    loaded = await updateJournal(
      paths,
      loaded,
      "finalized-pending-receipt",
      receiptSha256,
      hooks,
      "commit",
    );
    return { journal: loaded.value, changed: true };
  });
}

export async function finalizeFileTransaction({
  graphRoot,
  transactionId,
  transactionDigest,
  receiptSha256,
  receiptPublished,
}, hooks = {}) {
  validTransactionId(transactionId);
  validDigest(transactionDigest, "Transaction digest");
  validDigest(receiptSha256, "Receipt digest");
  if (receiptPublished !== true) {
    throw transactionError("WRITE008", "Receipt publication must be confirmed before final release.");
  }
  const root = await resolveGraphRoot(graphRoot);
  return withPatchLock(root.graphRoot, async () => {
    const paths = fileTransactionPaths(root.graphRoot, transactionId);
    let loaded = await readJournalAt(paths, { transactionId, transactionDigest, rootIdentity: root.rootIdentity });
    if (!loaded) throw transactionError("WRITE006", "File transaction journal does not exist.");
    if (loaded.value.status === "finalized") {
      if (loaded.value.receiptSha256 !== receiptSha256) {
        throw transactionError("WRITE008", "Finalized transaction binds another receipt.");
      }
      await cleanupTransactionResidues(paths, loaded.value);
      const active = await readActiveAt(paths);
      if (active?.value.transactionId === transactionId) {
        await removeActiveOwned(paths, active, hooks, "finalize");
      }
      await cleanupActiveResidues(paths, loaded.value);
      return { journal: loaded.value, changed: false };
    }
    if (loaded.value.status !== "finalized-pending-receipt") {
      throw transactionError("WRITE008", "Only a committed transaction can be released after receipt publication.");
    }
    if (loaded.value.receiptSha256 !== receiptSha256) {
      throw transactionError("WRITE008", "Committed transaction binds another receipt.");
    }
    const active = await requireActive(paths, loaded.value);
    await cleanupTransactionResidues(paths, loaded.value);
    await boundary(hooks, "finalize.before-postimage", { transactionId });
    await assertPostimage(root.graphRoot, loaded.value.records);
    await boundary(hooks, "finalize.after-postimage", { transactionId });
    loaded = await updateJournal(paths, loaded, "finalized", receiptSha256, hooks, "finalize");
    await removeActiveOwned(paths, active, hooks, "finalize");
    await cleanupTransactionResidues(paths, loaded.value);
    return { journal: loaded.value, changed: true };
  });
}

export async function rollbackFileTransaction({ graphRoot, transactionId, transactionDigest }, hooks = {}) {
  validTransactionId(transactionId);
  validDigest(transactionDigest, "Transaction digest");
  const root = await resolveGraphRoot(graphRoot);
  return withPatchLock(root.graphRoot, async () => {
    const paths = fileTransactionPaths(root.graphRoot, transactionId);
    let loaded = await readJournalAt(paths, { transactionId, transactionDigest, rootIdentity: root.rootIdentity });
    if (!loaded) throw transactionError("WRITE006", "File transaction journal does not exist.");
    if (new Set(["finalized-pending-receipt", "finalized"]).has(loaded.value.status)) {
      throw transactionError("WRITE008", "A committed file transaction can never be rolled back.");
    }
    if (loaded.value.status === "rolled-back") {
      const active = await readActiveAt(paths);
      if (active?.value.transactionId === transactionId) await removeActiveOwned(paths, active, hooks, "rollback");
      await cleanupTransactionResidues(paths, loaded.value);
      return { journal: loaded.value, summary: { restored: 0, already: loaded.value.records.length, total: loaded.value.records.length }, changed: false };
    }
    let active = await readActiveAt(paths);
    if (active && active.value.transactionId !== transactionId) {
      throw transactionError("WRITE007", `Another canonical writer is active: ${active.value.transactionId}`);
    }
    if (!active) {
      const marker = {
        schemaVersion: FILE_TRANSACTION_POLICY.schemaVersion,
        kind: ACTIVE_KIND,
        transactionId,
        transactionDigest,
        rootIdentity: root.rootIdentity,
        planSha256: loaded.value.planSha256,
        createdAt: loaded.value.createdAt,
      };
      await writeActiveExclusive(paths, marker, hooks);
      active = await readActiveAt(paths, { transactionId, transactionDigest, rootIdentity: root.rootIdentity, planSha256: loaded.value.planSha256 });
    } else {
      validateActive(active.value, { transactionId, transactionDigest, rootIdentity: root.rootIdentity, planSha256: loaded.value.planSha256 });
    }
    await cleanupTransactionResidues(paths, loaded.value);
    const reversed = [...loaded.value.records].reverse();
    await boundary(hooks, "rollback.before-preflight", { transactionId });
    await preflight(root.graphRoot, reversed, "backward");
    await boundary(hooks, "rollback.after-preflight", { transactionId });
    if (loaded.value.status !== "rolling-back") {
      loaded = await updateJournal(paths, loaded, "rolling-back", null, hooks, "rollback");
    }
    let restored = 0;
    let already = 0;
    for (const record of reversed) {
      const outcome = await publishRecord(paths, loaded.value, record, "backward", hooks);
      if (outcome === "published") restored += 1;
      else already += 1;
    }
    loaded = await updateJournal(paths, loaded, "rolled-back", null, hooks, "rollback");
    await cleanupRecordResidues(paths, loaded.value);
    await removeActiveOwned(paths, active, hooks, "rollback");
    await cleanupTransactionResidues(paths, loaded.value);
    return { journal: loaded.value, summary: { restored, already, total: loaded.value.records.length }, changed: restored > 0 };
  });
}
