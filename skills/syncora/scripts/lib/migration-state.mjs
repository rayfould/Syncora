import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import { writeBufferAtomic } from "./atomic-file.mjs";
import { SyncoraError } from "./cli.mjs";
import { createStableDirectoryGuard } from "./stable-directory.mjs";
import {
  isWithin,
  readBoundedRegularFileIfPresent,
  samePath,
} from "./workspace.mjs";

export const MIGRATION_STATE_POLICY = Object.freeze({
  schemaVersion: 1,
  maximumStateBytes: 1_048_576,
  maximumArtifactBytes: 16_777_216,
  maximumMigrationIdCharacters: 64,
});

export const MIGRATION_STATUSES = Object.freeze([
  "staged",
  "shadow-verified",
  "cutover-prepared",
  "cutover-applied",
  "verified",
  "retired",
  "rolled-back",
]);

const STATUS_TRANSITIONS = Object.freeze({
  staged: new Set(["staged", "shadow-verified"]),
  "shadow-verified": new Set(["staged", "shadow-verified", "cutover-prepared", "rolled-back"]),
  "cutover-prepared": new Set(["cutover-prepared", "cutover-applied", "rolled-back"]),
  "cutover-applied": new Set(["cutover-applied", "verified", "rolled-back"]),
  verified: new Set(["verified", "retired", "rolled-back"]),
  retired: new Set(["retired", "rolled-back"]),
  "rolled-back": new Set(["rolled-back"]),
});

const ARTIFACT_KEYS = Object.freeze([
  "manifest",
  "stagedContent",
  "fixtures",
  "shadowReport",
  "recovery",
  "cutoverReceipt",
  "verification",
  "retirement",
]);

function migrationError(code, message, details = undefined) {
  return new SyncoraError(code, message, details);
}

function exactKeys(value, expected, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw migrationError("MIGRATE004", `${label} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    !actual.every((key, index) => key === wanted[index])
  ) {
    throw migrationError("MIGRATE004", `${label} has missing or unknown fields.`, {
      expected: wanted,
      actual,
    });
  }
}

export function taggedSha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function normalizeMigrationId(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MIGRATION_STATE_POLICY.maximumMigrationIdCharacters ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value)
  ) {
    throw migrationError(
      "MIGRATE004",
      "Migration ID must use 1-64 lowercase letters, digits, or interior hyphens.",
    );
  }
  return value;
}

function portableRelative(root, path) {
  const result = relative(root, path).split(sep).join("/");
  if (
    result === "" ||
    result === ".." ||
    result.startsWith("../") ||
    isAbsolute(result)
  ) {
    throw migrationError("MIGRATE004", `Migration path escapes its root: ${path}`);
  }
  return result;
}

export function migrationPaths(graphRoot, migrationId) {
  const id = normalizeMigrationId(migrationId);
  const syncoraRoot = join(graphRoot, ".syncora");
  const migrationsRoot = join(syncoraRoot, "migrations");
  const root = join(migrationsRoot, id);
  return {
    graphRoot,
    syncoraRoot,
    migrationsRoot,
    root,
    state: join(root, "state.json"),
    manifest: join(root, "reviewed-manifest.json"),
    stagedContent: join(root, "staged-content.json"),
    content: join(root, "content"),
    blobs: join(root, "blobs"),
    fixtures: join(root, "shadow-fixtures.json"),
    shadowReport: join(root, "shadow-report.json"),
    recovery: join(root, "recovery.json"),
    cutoverReceipt: join(root, "receipts", "cutover.json"),
    verification: join(root, "verification.json"),
    retirement: join(root, "retirement.json"),
  };
}

export function workspaceIdentity(workspacePath) {
  const normalized = process.platform === "win32"
    ? workspacePath.replaceAll("\\", "/").toLowerCase()
    : workspacePath;
  return taggedSha256(`syncora-workspace-v1\n${normalized}`);
}

async function safeRead(
  path,
  containmentRoot,
  maximumBytes,
  label,
  { isolateOnWindows = true } = {},
) {
  let before;
  try {
    before = await lstat(path, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink()) {
    throw migrationError("MIGRATE004", `${label} is not a safe regular file: ${path}`);
  }
  if (before.size > BigInt(maximumBytes)) {
    throw migrationError("MIGRATE004", `${label} exceeds its byte limit: ${path}`, {
      maximumBytes,
    });
  }
  const parent = dirname(path);
  let parentMetadata;
  try {
    parentMetadata = await lstat(parent);
  } catch (error) {
    throw migrationError(
      "MIGRATE004",
      `${label} parent could not be inspected safely: ${parent}`,
      { cause: error.message },
    );
  }
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
    throw migrationError("MIGRATE004", `${label} parent is unsafe: ${parent}`);
  }
  const resolvedParent = await realpath(parent);
  if (
    !isWithin(containmentRoot, resolvedParent) ||
    !samePath(resolvedParent, parent)
  ) {
    throw migrationError("MIGRATE004", `${label} parent escapes its trusted root: ${parent}`);
  }
  return readBoundedRegularFileIfPresent(path, {
    containmentRoot: parent,
    maximumBytes,
    code: "MIGRATE004",
    label,
    isolateOnWindows,
  });
}

export async function readMigrationBytes(
  path,
  containmentRoot,
  maximumBytes = MIGRATION_STATE_POLICY.maximumArtifactBytes,
  label = "Migration artifact",
) {
  return safeRead(path, containmentRoot, maximumBytes, label);
}

// Canonical graph notes and transaction targets are read in O(N) migration
// loops. Keep the same bounded handle and identity checks without paying for a
// fresh Windows helper process for every note. Control artifacts continue to
// use readMigrationBytes and retain isolated Windows opens.
export async function readMigrationTargetBytes(
  path,
  containmentRoot,
  maximumBytes = MIGRATION_STATE_POLICY.maximumArtifactBytes,
  label = "Migration target",
) {
  return safeRead(path, containmentRoot, maximumBytes, label, {
    isolateOnWindows: false,
  });
}

export function parseStrictJson(bytes, label) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw migrationError("MIGRATE004", `${label} is not strict UTF-8.`);
  }
  if (text.startsWith("\ufeff") || text.includes("\u0000")) {
    throw migrationError("MIGRATE004", `${label} contains a BOM or embedded NUL.`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw migrationError("MIGRATE004", `${label} is not valid JSON.`);
  }
}

function validateArtifactReference(value, label) {
  if (value === null) return;
  exactKeys(value, ["path", "sha256"], label);
  if (
    typeof value.path !== "string" ||
    value.path.length < 1 ||
    value.path.length > 4_096 ||
    value.path.includes("\\") ||
    value.path.startsWith("/") ||
    value.path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw migrationError("MIGRATE004", `${label}.path is not a portable relative path.`);
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(value.sha256)) {
    throw migrationError("MIGRATE004", `${label}.sha256 is invalid.`);
  }
}

export function validateMigrationState(value, expected = {}) {
  exactKeys(
    value,
    [
      "schemaVersion",
      "kind",
      "migrationId",
      "status",
      "workspaceIdentity",
      "rootIdentity",
      "createdAt",
      "updatedAt",
      "baseline",
      "artifacts",
    ],
    "Migration state",
  );
  if (value.schemaVersion !== MIGRATION_STATE_POLICY.schemaVersion) {
    throw migrationError(
      value.schemaVersion > MIGRATION_STATE_POLICY.schemaVersion ? "SCHEMA001" : "MIGRATE004",
      `Unsupported migration state schema: ${value.schemaVersion}`,
    );
  }
  if (value.kind !== "syncora.adoption") {
    throw migrationError("MIGRATE004", "Migration state kind is invalid.");
  }
  normalizeMigrationId(value.migrationId);
  if (!MIGRATION_STATUSES.includes(value.status)) {
    throw migrationError("MIGRATE004", `Migration state status is invalid: ${value.status}`);
  }
  for (const [key, identity] of [
    ["workspaceIdentity", value.workspaceIdentity],
    ["rootIdentity", value.rootIdentity],
  ]) {
    if (!/^sha256:[0-9a-f]{64}$/.test(identity)) {
      throw migrationError("MIGRATE004", `Migration ${key} is invalid.`);
    }
  }
  for (const key of ["createdAt", "updatedAt"]) {
    if (typeof value[key] !== "string" || !Number.isFinite(Date.parse(value[key]))) {
      throw migrationError("MIGRATE004", `Migration ${key} is invalid.`);
    }
  }
  exactKeys(
    value.baseline,
    [
      "graphRevision",
      "policyRevision",
      "manifestSha256",
      "recoveryPlanSha256",
      "sourceCount",
      "targetCount",
    ],
    "Migration baseline",
  );
  for (const key of ["graphRevision", "policyRevision", "manifestSha256"]) {
    if (!/^sha256:[0-9a-f]{64}$/.test(value.baseline[key])) {
      throw migrationError("MIGRATE004", `Migration baseline ${key} is invalid.`);
    }
  }
  if (
    value.baseline.recoveryPlanSha256 !== null &&
    !/^sha256:[0-9a-f]{64}$/.test(value.baseline.recoveryPlanSha256)
  ) {
    throw migrationError(
      "MIGRATE004",
      "Migration baseline recoveryPlanSha256 is invalid.",
    );
  }
  if (
    new Set([
      "cutover-prepared",
      "cutover-applied",
      "verified",
      "retired",
      "rolled-back",
    ]).has(value.status) &&
    value.baseline.recoveryPlanSha256 === null
  ) {
    throw migrationError(
      "MIGRATE004",
      `Migration status ${value.status} requires a recovery plan binding.`,
    );
  }
  for (const key of ["sourceCount", "targetCount"]) {
    if (!Number.isSafeInteger(value.baseline[key]) || value.baseline[key] < 0) {
      throw migrationError("MIGRATE004", `Migration baseline ${key} is invalid.`);
    }
  }
  exactKeys(value.artifacts, ARTIFACT_KEYS, "Migration artifacts");
  for (const key of ARTIFACT_KEYS) {
    validateArtifactReference(value.artifacts[key], `Migration artifacts.${key}`);
  }
  const requiredArtifacts = {
    staged: ["manifest", "stagedContent"],
    "shadow-verified": ["manifest", "stagedContent", "fixtures", "shadowReport"],
    "cutover-prepared": ["manifest", "stagedContent", "fixtures", "shadowReport"],
    "cutover-applied": ["manifest", "stagedContent", "fixtures", "shadowReport", "recovery", "cutoverReceipt"],
    verified: ["manifest", "stagedContent", "fixtures", "shadowReport", "recovery", "cutoverReceipt", "verification"],
    retired: ["manifest", "stagedContent", "fixtures", "shadowReport", "recovery", "cutoverReceipt", "verification", "retirement"],
    "rolled-back": ["manifest", "stagedContent", "fixtures", "shadowReport", "recovery"],
  }[value.status];
  for (const key of requiredArtifacts) {
    if (value.artifacts[key] === null) {
      throw migrationError(
        "MIGRATE004",
        `Migration status ${value.status} requires artifacts.${key}.`,
      );
    }
  }
  if (expected.migrationId && value.migrationId !== expected.migrationId) {
    throw migrationError("MIGRATE005", "Migration state belongs to another migration ID.");
  }
  if (expected.workspaceIdentity && value.workspaceIdentity !== expected.workspaceIdentity) {
    throw migrationError("MIGRATE005", "Migration state belongs to another workspace.");
  }
  if (expected.rootIdentity && value.rootIdentity !== expected.rootIdentity) {
    throw migrationError("MIGRATE005", "Migration state belongs to another graph root.");
  }
  return value;
}

export async function readMigrationState(paths, expected = {}) {
  const bytes = await readMigrationBytes(
    paths.state,
    paths.root,
    MIGRATION_STATE_POLICY.maximumStateBytes,
    "Migration state",
  );
  if (bytes === null) return null;
  return {
    bytes,
    value: validateMigrationState(parseStrictJson(bytes, "Migration state"), expected),
  };
}

export function artifactReference(paths, path, bytes) {
  return {
    path: portableRelative(paths.root, path),
    sha256: taggedSha256(bytes),
  };
}

export async function verifyArtifactReference(paths, reference, label) {
  validateArtifactReference(reference, label);
  if (reference === null) return null;
  const path = join(paths.root, ...reference.path.split("/"));
  const bytes = await readMigrationBytes(path, paths.root, undefined, label);
  if (bytes === null || taggedSha256(bytes) !== reference.sha256) {
    throw migrationError("MIGRATE005", `${label} is missing or no longer matches its recorded hash.`);
  }
  return { path, bytes };
}

export function assertMigrationTransition(from, to) {
  if (!STATUS_TRANSITIONS[from]?.has(to)) {
    throw migrationError("MIGRATE006", `Migration cannot transition from ${from} to ${to}.`);
  }
}

export function serializeMigrationJson(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function writeMigrationJson(
  path,
  value,
  beforePublish = undefined,
  prepareParent = undefined,
) {
  const bytes = serializeMigrationJson(value);
  if (bytes.length > MIGRATION_STATE_POLICY.maximumArtifactBytes) {
    throw migrationError("MIGRATE004", `Migration artifact exceeds its byte limit: ${path}`);
  }
  await writeBufferAtomic(
    path,
    bytes,
    undefined,
    beforePublish,
    prepareParent,
  );
  return bytes;
}

export function bindMigrationStoragePlans(paths, plans) {
  const guards = new Map();
  return plans.map((plan) => {
    const parent = dirname(plan.path);
    let guard = guards.get(parent);
    if (!guard) {
      guard = createStableDirectoryGuard(paths.graphRoot, parent, {
        code: "MIGRATE004",
        label: "Migration artifact directory",
      });
      guards.set(parent, guard);
    }
    return {
      ...plan,
      readCurrent:
        plan.readCurrent ??
        (() =>
          readMigrationTargetBytes(
            plan.path,
            paths.graphRoot,
            MIGRATION_STATE_POLICY.maximumArtifactBytes,
            "Migration publication target",
          )),
      prepareStorage: async () => {
        await guard.prepare();
        await plan.prepareStorage?.();
      },
      verifyStorage: async () => {
        await guard.assert();
        await plan.verifyStorage?.();
      },
    };
  });
}

export async function assertMigrationRoot(paths) {
  const resolvedGraph = await realpath(paths.graphRoot);
  if (!samePath(resolvedGraph, paths.graphRoot)) {
    throw migrationError("MIGRATE004", "Migration graph root changed identity.");
  }
  if (!isWithin(paths.graphRoot, paths.root)) {
    throw migrationError("MIGRATE004", "Migration runtime escapes the graph root.");
  }
  for (const path of [
    paths.syncoraRoot,
    paths.migrationsRoot,
    paths.root,
    paths.content,
    paths.blobs,
    dirname(paths.cutoverReceipt),
  ]) {
    let metadata;
    try {
      metadata = await lstat(path);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw migrationError(
        "MIGRATE004",
        `Migration directory could not be inspected safely: ${path}`,
        { cause: error.message },
      );
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw migrationError(
        "MIGRATE004",
        `Migration directory is not a regular directory: ${path}`,
      );
    }
    const resolved = await realpath(path);
    if (!samePath(resolved, path) || !isWithin(paths.graphRoot, resolved)) {
      throw migrationError(
        "MIGRATE004",
        `Migration directory uses an alias or escapes the graph root: ${path}`,
      );
    }
  }
}
