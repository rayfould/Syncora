import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { writeBufferAtomic } from "./atomic-file.mjs";
import { SyncoraError } from "./cli.mjs";
import { publishImmutableFile } from "./immutable-file.mjs";
import { createStableDirectoryGuard } from "./stable-directory.mjs";
import {
  isWithin,
  readBoundedRegularFileIfPresent,
  samePath,
} from "./workspace.mjs";

export const DRIFT_STATE_SCHEMA_VERSION = 1;
export const DRIFT_ARTIFACT_SCHEMA_VERSION = 1;

export const DRIFT_STATE_POLICY = Object.freeze({
  maximumStateBytes: 16_777_216,
  maximumArtifactBytes: 16_777_216,
  maximumActiveFindings: 10_000,
  maximumProposalBindingsPerFinding: 256,
  maximumProposalBindingShards: 50_000,
  maximumProposalBindingArtifacts: 1_048_576,
  maximumNotePathCharacters: 1_024,
  maximumPayloadDepth: 32,
  maximumPayloadNodes: 1_048_576,
  maximumPayloadStringCharacters: 16_777_216,
  maximumPayloadKeyCharacters: 1_024,
});

export const DRIFT_ARTIFACT_KINDS = Object.freeze({
  OBSERVATION: "observation",
  FINDING: "finding",
  REFRESH: "refresh",
  PROPOSAL_BINDING: "proposal-binding",
  DISPOSITION: "disposition",
});

const TAGGED_SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const ARTIFACT_DEFINITIONS = Object.freeze({
  observation: Object.freeze({
    storedKind: "syncora.drift.observation",
    directory: "observations",
    idPrefix: "observation_",
  }),
  finding: Object.freeze({
    storedKind: "syncora.drift.finding",
    directory: "findings",
    idPrefix: "finding_",
  }),
  refresh: Object.freeze({
    storedKind: "syncora.drift.refresh",
    directory: "refresh",
    idPrefix: "refresh_",
  }),
  "proposal-binding": Object.freeze({
    storedKind: "syncora.drift.proposal-binding",
    directory: "proposal-bindings",
    idPrefix: "proposal_binding_",
  }),
  disposition: Object.freeze({
    storedKind: "syncora.drift.disposition",
    directory: "dispositions",
    idPrefix: "disposition_",
  }),
});

function driftError(code, message, details = undefined) {
  return new SyncoraError(code, message, details);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected, label, code = "DRIFT001") {
  if (!isPlainObject(value)) {
    throw driftError(code, `${label} must be a JSON object.`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    !actual.every((key, index) => key === wanted[index])
  ) {
    throw driftError(code, `${label} contains missing or unknown fields.`);
  }
}

function hasValidUnicode(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function boundedString(value, label, maximum, { allowNewlines = false } = {}) {
  const forbidden = allowNewlines
    ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u
    : /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
  if (
    typeof value !== "string" ||
    !hasValidUnicode(value) ||
    value !== value.normalize("NFC") ||
    [...value].length < 1 ||
    [...value].length > maximum ||
    forbidden.test(value)
  ) {
    throw driftError("DRIFT001", `${label} is invalid or exceeds its bound.`);
  }
  return value;
}

function taggedSha256(value, label) {
  if (typeof value !== "string" || !TAGGED_SHA256_PATTERN.test(value)) {
    throw driftError("DRIFT001", `${label} must be a lowercase tagged SHA-256 value.`);
  }
  return value;
}

function canonicalIso(value, label) {
  if (typeof value !== "string" || value.length > 40) {
    throw driftError("DRIFT001", `${label} must be a canonical ISO-8601 timestamp.`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw driftError("DRIFT001", `${label} must be a canonical ISO-8601 timestamp.`);
  }
  return value;
}

function artifactDefinition(kindOrStoredKind) {
  const shortKind = Object.hasOwn(ARTIFACT_DEFINITIONS, kindOrStoredKind)
    ? kindOrStoredKind
    : Object.keys(ARTIFACT_DEFINITIONS).find(
        (kind) => ARTIFACT_DEFINITIONS[kind].storedKind === kindOrStoredKind,
      );
  if (!shortKind) {
    throw driftError("DRIFT001", "Drift artifact kind is unsupported.", {
      kind: kindOrStoredKind,
    });
  }
  return Object.freeze({ kind: shortKind, ...ARTIFACT_DEFINITIONS[shortKind] });
}

function artifactId(value, definition, label = "Drift artifact ID") {
  const pattern = new RegExp(`^${definition.idPrefix}[0-9a-f]{64}$`, "u");
  if (typeof value !== "string" || !pattern.test(value)) {
    throw driftError("DRIFT001", `${label} is malformed.`);
  }
  return value;
}

function portableNotePath(value) {
  const normalized = boundedString(
    value,
    "Drift finding note path",
    DRIFT_STATE_POLICY.maximumNotePathCharacters,
  );
  if (
    normalized.startsWith("/") ||
    normalized.endsWith("/") ||
    normalized.includes("\\") ||
    /^[A-Za-z]:/u.test(normalized) ||
    normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw driftError("DRIFT001", "Drift finding note path must be portable and graph-relative.");
  }
  return normalized;
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Buffer.isBuffer(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function normalizeJsonValue(value, label = "Drift artifact payload") {
  let nodes = 0;
  function visit(current, depth) {
    nodes += 1;
    if (nodes > DRIFT_STATE_POLICY.maximumPayloadNodes) {
      throw driftError("DRIFT005", `${label} exceeds the JSON node limit.`, {
        limit: DRIFT_STATE_POLICY.maximumPayloadNodes,
      });
    }
    if (depth > DRIFT_STATE_POLICY.maximumPayloadDepth) {
      throw driftError("DRIFT005", `${label} exceeds the JSON nesting limit.`, {
        limit: DRIFT_STATE_POLICY.maximumPayloadDepth,
      });
    }
    if (current === null || typeof current === "boolean") return current;
    if (typeof current === "number") {
      if (!Number.isSafeInteger(current)) {
        throw driftError("DRIFT001", `${label} may contain only safe integer numbers.`);
      }
      return current;
    }
    if (typeof current === "string") {
      return boundedString(
        current,
        `${label} string`,
        DRIFT_STATE_POLICY.maximumPayloadStringCharacters,
        { allowNewlines: true },
      );
    }
    if (Array.isArray(current)) {
      return current.map((entry) => visit(entry, depth + 1));
    }
    if (!isPlainObject(current)) {
      throw driftError("DRIFT001", `${label} contains a non-JSON value.`);
    }
    const normalized = {};
    for (const key of Object.keys(current).sort()) {
      const safeKey = boundedString(
        key,
        `${label} key`,
        DRIFT_STATE_POLICY.maximumPayloadKeyCharacters,
      );
      normalized[safeKey] = visit(current[key], depth + 1);
    }
    return normalized;
  }
  const normalized = visit(value, 0);
  if (!isPlainObject(normalized)) {
    throw driftError("DRIFT001", `${label} must be a JSON object.`);
  }
  return normalized;
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function decodeJsonBytes(bytes, label, maximumBytes) {
  if (!Buffer.isBuffer(bytes)) {
    throw driftError("DRIFT001", `${label} must be read as bytes.`);
  }
  if (bytes.length > maximumBytes) {
    throw driftError("DRIFT005", `${label} exceeds its byte limit.`, {
      bytes: bytes.length,
      limit: maximumBytes,
    });
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw driftError("DRIFT001", `${label} is not valid UTF-8.`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw driftError("DRIFT001", `${label} is not valid JSON.`);
  }
}

function contentDigest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function assertMaximumBytes(value, label) {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > DRIFT_STATE_POLICY.maximumArtifactBytes
  ) {
    throw driftError("DRIFT005", `${label} byte limit is invalid.`);
  }
  return value;
}

export function driftWorkspaceIdentityHex(workspaceIdentity) {
  return taggedSha256(workspaceIdentity, "Drift workspace identity").slice("sha256:".length);
}

export function driftStatePaths(graphRoot, workspaceIdentity) {
  if (typeof graphRoot !== "string" || !isAbsolute(graphRoot)) {
    throw driftError("DRIFT002", "Drift graph root must be an absolute path.");
  }
  const normalizedGraphRoot = resolve(graphRoot);
  const workspaceHex = driftWorkspaceIdentityHex(workspaceIdentity);
  const driftRoot = join(normalizedGraphRoot, ".syncora", "drift");
  const workspacesRoot = join(driftRoot, "workspaces");
  const workspaceRoot = join(workspacesRoot, workspaceHex);
  return Object.freeze({
    graphRoot: normalizedGraphRoot,
    driftRoot,
    workspacesRoot,
    workspaceRoot,
    statePath: join(workspaceRoot, "state.json"),
    observations: join(workspaceRoot, "observations"),
    findings: join(workspaceRoot, "findings"),
    refresh: join(workspaceRoot, "refresh"),
    proposalBindings: join(workspaceRoot, "proposal-bindings"),
    dispositions: join(workspaceRoot, "dispositions"),
  });
}

export function driftArtifactPath(paths, kind, id, options = {}) {
  if (!isPlainObject(paths) || typeof paths.graphRoot !== "string") {
    throw driftError("DRIFT002", "Drift artifact paths must come from driftStatePaths().");
  }
  const definition = artifactDefinition(kind);
  const safeId = artifactId(id, definition);
  let directory = paths[
    definition.directory === "proposal-bindings"
      ? "proposalBindings"
      : definition.directory
  ];
  if (typeof directory !== "string") {
    throw driftError("DRIFT002", "Drift artifact directory is unavailable.");
  }
  if (definition.kind === "proposal-binding") {
    const findingDefinition = artifactDefinition("finding");
    const findingId = artifactId(
      options.findingId,
      findingDefinition,
      "Proposal-binding finding ID",
    );
    directory = join(directory, findingId);
  }
  return join(directory, `${safeId}.json`);
}

export function resolveDriftArtifactPath({
  graphRoot,
  workspaceIdentity,
  kind,
  id,
  findingId = undefined,
}) {
  return driftArtifactPath(
    driftStatePaths(graphRoot, workspaceIdentity),
    kind,
    id,
    { findingId },
  );
}

function parseLatestObservation(value) {
  if (value === null) return null;
  exactKeys(
    value,
    ["observationId", "observationDigest"],
    "Drift latest observation",
  );
  const definition = artifactDefinition("observation");
  return {
    observationId: artifactId(value.observationId, definition, "Drift observation ID"),
    observationDigest: taggedSha256(
      value.observationDigest,
      "Drift observation digest",
    ),
  };
}

function parseActiveFinding(value, index) {
  const label = `Drift active finding ${index + 1}`;
  exactKeys(
    value,
    [
      "findingId",
      "findingDigest",
      "refreshId",
      "refreshDigest",
      "note",
      "proposalBindingIds",
    ],
    label,
  );
  exactKeys(value.note, ["path", "sha256"], `${label} note`);
  if (
    !Array.isArray(value.proposalBindingIds) ||
    value.proposalBindingIds.length > DRIFT_STATE_POLICY.maximumProposalBindingsPerFinding
  ) {
    throw driftError("DRIFT005", `${label} proposal bindings exceed their bound.`);
  }
  const findingDefinition = artifactDefinition("finding");
  const refreshDefinition = artifactDefinition("refresh");
  const bindingDefinition = artifactDefinition("proposal-binding");
  const proposalBindingIds = value.proposalBindingIds.map((entry) =>
    artifactId(entry, bindingDefinition, `${label} proposal binding ID`),
  );
  if (
    new Set(proposalBindingIds).size !== proposalBindingIds.length ||
    proposalBindingIds.some((entry, bindingIndex) =>
      bindingIndex > 0 && proposalBindingIds[bindingIndex - 1] >= entry)
  ) {
    throw driftError("DRIFT001", `${label} proposal binding IDs must be unique and sorted.`);
  }
  return {
    findingId: artifactId(value.findingId, findingDefinition, `${label} ID`),
    findingDigest: taggedSha256(value.findingDigest, `${label} digest`),
    refreshId: artifactId(value.refreshId, refreshDefinition, `${label} refresh ID`),
    refreshDigest: taggedSha256(value.refreshDigest, `${label} refresh digest`),
    note: {
      path: portableNotePath(value.note.path),
      sha256: taggedSha256(value.note.sha256, `${label} note digest`),
    },
    proposalBindingIds,
  };
}

export function parseDriftState(value, expected = {}) {
  exactKeys(
    value,
    [
      "schemaVersion",
      "kind",
      "workspaceIdentity",
      "graphRootIdentity",
      "policyRevision",
      "updatedAt",
      "latestObservation",
      "activeFindings",
    ],
    "Drift state",
  );
  if (!Number.isInteger(value.schemaVersion)) {
    throw driftError("DRIFT001", "Drift state schema version is invalid.");
  }
  if (value.schemaVersion > DRIFT_STATE_SCHEMA_VERSION) {
    throw driftError(
      "SCHEMA001",
      `Drift state schema ${value.schemaVersion} is newer than supported schema ${DRIFT_STATE_SCHEMA_VERSION}.`,
    );
  }
  if (value.schemaVersion !== DRIFT_STATE_SCHEMA_VERSION) {
    throw driftError("DRIFT001", `Drift state schema ${value.schemaVersion} is unsupported.`);
  }
  if (value.kind !== "syncora.drift.state") {
    throw driftError("DRIFT001", "Drift state kind is invalid.");
  }
  const workspaceIdentity = taggedSha256(value.workspaceIdentity, "Drift workspace identity");
  const graphRootIdentity = taggedSha256(value.graphRootIdentity, "Drift graph-root identity");
  const policyRevision = taggedSha256(value.policyRevision, "Drift policy revision");
  if (
    (expected.workspaceIdentity && expected.workspaceIdentity !== workspaceIdentity) ||
    (expected.graphRootIdentity && expected.graphRootIdentity !== graphRootIdentity) ||
    (expected.policyRevision && expected.policyRevision !== policyRevision)
  ) {
    throw driftError("DRIFT003", "Drift state identity binding does not match this environment.", {
      expected,
      current: { workspaceIdentity, graphRootIdentity, policyRevision },
    });
  }
  if (
    !Array.isArray(value.activeFindings) ||
    value.activeFindings.length > DRIFT_STATE_POLICY.maximumActiveFindings
  ) {
    throw driftError("DRIFT005", "Drift state exceeds the active-finding limit.", {
      limit: DRIFT_STATE_POLICY.maximumActiveFindings,
    });
  }
  const activeFindings = value.activeFindings.map(parseActiveFinding);
  if (
    new Set(activeFindings.map((entry) => entry.findingId)).size !== activeFindings.length ||
    new Set(activeFindings.map((entry) => entry.note.path)).size !== activeFindings.length ||
    activeFindings.some(
      (entry, index) => index > 0 && activeFindings[index - 1].findingId >= entry.findingId,
    )
  ) {
    throw driftError(
      "DRIFT001",
      "Active drift findings must have unique notes and unique, sorted IDs.",
    );
  }
  return deepFreeze({
    schemaVersion: DRIFT_STATE_SCHEMA_VERSION,
    kind: "syncora.drift.state",
    workspaceIdentity,
    graphRootIdentity,
    policyRevision,
    updatedAt: canonicalIso(value.updatedAt, "Drift state updatedAt"),
    latestObservation: parseLatestObservation(value.latestObservation),
    activeFindings,
  });
}

export function serializeDriftState(value) {
  const state = parseDriftState(value);
  const bytes = Buffer.from(`${canonicalJson(state)}\n`, "utf8");
  if (bytes.length > DRIFT_STATE_POLICY.maximumStateBytes) {
    throw driftError("DRIFT005", "Drift state exceeds its byte limit.", {
      bytes: bytes.length,
      limit: DRIFT_STATE_POLICY.maximumStateBytes,
    });
  }
  return bytes;
}

export function parseDriftStateBytes(bytes, expected = {}) {
  const value = decodeJsonBytes(
    bytes,
    "Drift state",
    DRIFT_STATE_POLICY.maximumStateBytes,
  );
  return parseDriftState(value, expected);
}

export function createDriftState({
  workspaceIdentity,
  graphRootIdentity,
  policyRevision,
  updatedAt = new Date().toISOString(),
}) {
  return parseDriftState({
    schemaVersion: DRIFT_STATE_SCHEMA_VERSION,
    kind: "syncora.drift.state",
    workspaceIdentity,
    graphRootIdentity,
    policyRevision,
    updatedAt,
    latestObservation: null,
    activeFindings: [],
  });
}

async function prepareWorkspaceGuard(paths, label = "Drift workspace storage") {
  const guard = createStableDirectoryGuard(paths.graphRoot, paths.workspaceRoot, {
    code: "DRIFT002",
    label,
  });
  await guard.prepare();
  return guard;
}

async function existingDirectoryGuard(paths, directory, label) {
  const relativePath = relative(paths.graphRoot, directory);
  if (relativePath === ".." || relativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw driftError("DRIFT002", `${label} escapes its graph storage root.`);
  }
  let cursor = paths.graphRoot;
  for (const segment of relativePath.split(/[\\/]/u).filter(Boolean)) {
    cursor = join(cursor, segment);
    let metadata;
    try {
      metadata = await lstat(cursor);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw driftError("DRIFT002", `${label} could not be inspected safely.`, {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw driftError("DRIFT002", `${label} contains an unsafe ancestor.`);
    }
    let resolved;
    try {
      resolved = await realpath(cursor);
    } catch (error) {
      throw driftError("DRIFT002", `${label} could not be resolved safely.`, {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    if (!samePath(resolved, cursor) || !isWithin(paths.graphRoot, resolved)) {
      throw driftError("DRIFT002", `${label} escapes or aliases its graph storage root.`);
    }
  }
  const guard = createStableDirectoryGuard(paths.graphRoot, directory, {
    code: "DRIFT002",
    label,
  });
  await guard.prepare();
  return guard;
}

async function readStateBytes(paths, guard) {
  await guard.assert();
  const bytes = await readBoundedRegularFileIfPresent(paths.statePath, {
    containmentRoot: paths.workspaceRoot,
    maximumBytes: DRIFT_STATE_POLICY.maximumStateBytes,
    code: "DRIFT002",
    label: "Drift state",
    allowTransientMissing: true,
    beforeOpen: () => guard.assert(),
    beforeHandleOpen: () => guard.assert(),
    afterRead: () => guard.assert(),
  });
  await guard.assert();
  return bytes;
}

export async function readDriftState({
  graphRoot,
  workspaceIdentity,
  graphRootIdentity = undefined,
  policyRevision = undefined,
}) {
  const paths = driftStatePaths(graphRoot, workspaceIdentity);
  const guard = await existingDirectoryGuard(
    paths,
    paths.workspaceRoot,
    "Drift workspace storage",
  );
  if (guard === null) return null;
  const bytes = await readStateBytes(paths, guard);
  if (bytes === null) return null;
  return parseDriftStateBytes(bytes, {
    workspaceIdentity,
    graphRootIdentity,
    policyRevision,
  });
}

export async function writeDriftState({
  graphRoot,
  state,
  expectedPreviousPolicyRevision = undefined,
}) {
  const parsed = parseDriftState(state);
  const priorPolicyRevision = expectedPreviousPolicyRevision === undefined
    ? parsed.policyRevision
    : taggedSha256(expectedPreviousPolicyRevision, "Expected prior drift policy revision");
  const paths = driftStatePaths(graphRoot, parsed.workspaceIdentity);
  const guard = await prepareWorkspaceGuard(paths);
  const before = await readStateBytes(paths, guard);
  if (before !== null) {
    parseDriftStateBytes(before, {
      workspaceIdentity: parsed.workspaceIdentity,
      graphRootIdentity: parsed.graphRootIdentity,
      policyRevision: priorPolicyRevision,
    });
  }
  const bytes = serializeDriftState(parsed);
  const assertUnchanged = async () => {
    await guard.assert();
    const current = await readStateBytes(paths, guard);
    const unchanged = before === null ? current === null : current?.equals(before);
    if (!unchanged) {
      throw driftError("DRIFT001", "Drift state changed after preflight.", {
        path: paths.statePath,
      });
    }
  };
  await writeBufferAtomic(
    paths.statePath,
    bytes,
    0o600,
    assertUnchanged,
    () => guard.prepare(),
  );
  await guard.assert();
  return Object.freeze({ path: paths.statePath, bytes, state: parsed });
}

export function parseDriftArtifact(value, expected = {}) {
  exactKeys(
    value,
    [
      "schemaVersion",
      "kind",
      "workspaceIdentity",
      "graphRootIdentity",
      "policyRevision",
      "payload",
    ],
    "Drift artifact",
  );
  if (!Number.isInteger(value.schemaVersion)) {
    throw driftError("DRIFT001", "Drift artifact schema version is invalid.");
  }
  if (value.schemaVersion > DRIFT_ARTIFACT_SCHEMA_VERSION) {
    throw driftError(
      "SCHEMA001",
      `Drift artifact schema ${value.schemaVersion} is newer than supported schema ${DRIFT_ARTIFACT_SCHEMA_VERSION}.`,
    );
  }
  if (value.schemaVersion !== DRIFT_ARTIFACT_SCHEMA_VERSION) {
    throw driftError("DRIFT001", `Drift artifact schema ${value.schemaVersion} is unsupported.`);
  }
  const definition = artifactDefinition(value.kind);
  if (expected.kind && artifactDefinition(expected.kind).kind !== definition.kind) {
    throw driftError("DRIFT003", "Drift artifact kind does not match its requested collection.");
  }
  const workspaceIdentity = taggedSha256(value.workspaceIdentity, "Drift artifact workspace identity");
  const graphRootIdentity = taggedSha256(value.graphRootIdentity, "Drift artifact graph-root identity");
  const policyRevision = taggedSha256(value.policyRevision, "Drift artifact policy revision");
  if (
    (expected.workspaceIdentity && expected.workspaceIdentity !== workspaceIdentity) ||
    (expected.graphRootIdentity && expected.graphRootIdentity !== graphRootIdentity) ||
    (expected.policyRevision && expected.policyRevision !== policyRevision)
  ) {
    throw driftError("DRIFT003", "Drift artifact identity binding does not match this environment.");
  }
  return deepFreeze({
    schemaVersion: DRIFT_ARTIFACT_SCHEMA_VERSION,
    kind: definition.storedKind,
    workspaceIdentity,
    graphRootIdentity,
    policyRevision,
    payload: normalizeJsonValue(value.payload),
  });
}

function serializeDriftArtifactValue(value) {
  const bytes = Buffer.from(`${canonicalJson(value)}\n`, "utf8");
  if (bytes.length > DRIFT_STATE_POLICY.maximumArtifactBytes) {
    throw driftError("DRIFT005", "Drift artifact exceeds its byte limit.", {
      bytes: bytes.length,
      limit: DRIFT_STATE_POLICY.maximumArtifactBytes,
    });
  }
  return bytes;
}

export function parseDriftArtifactBytes(bytes, expected = {}) {
  const parsed = parseDriftArtifact(
    decodeJsonBytes(
      bytes,
      "Drift artifact",
      DRIFT_STATE_POLICY.maximumArtifactBytes,
    ),
    expected,
  );
  const canonicalBytes = serializeDriftArtifactValue(parsed);
  if (!canonicalBytes.equals(bytes)) {
    throw driftError("DRIFT001", "Drift artifact bytes are not in canonical form.");
  }
  const definition = artifactDefinition(parsed.kind);
  const digest = contentDigest(bytes);
  const id = `${definition.idPrefix}${digest.slice("sha256:".length)}`;
  if (expected.id && artifactId(expected.id, definition) !== id) {
    throw driftError("DRIFT003", "Drift artifact content does not match its content-derived ID.", {
      expectedId: expected.id,
      currentId: id,
    });
  }
  return Object.freeze({
    id,
    digest,
    kind: definition.kind,
    bytes: Buffer.from(bytes),
    value: parsed,
    payload: parsed.payload,
  });
}

export function sealDriftArtifact({
  kind,
  workspaceIdentity,
  graphRootIdentity,
  policyRevision,
  payload,
}) {
  const definition = artifactDefinition(kind);
  const value = parseDriftArtifact({
    schemaVersion: DRIFT_ARTIFACT_SCHEMA_VERSION,
    kind: definition.storedKind,
    workspaceIdentity,
    graphRootIdentity,
    policyRevision,
    payload,
  });
  const bytes = serializeDriftArtifactValue(value);
  return parseDriftArtifactBytes(bytes, { kind: definition.kind });
}

export async function publishDriftArtifact(options, hooks = {}) {
  const sealed = sealDriftArtifact(options);
  const paths = driftStatePaths(options.graphRoot, sealed.value.workspaceIdentity);
  const findingId = sealed.kind === "proposal-binding"
    ? artifactId(
        sealed.payload?.finding?.id,
        artifactDefinition("finding"),
        "Proposal-binding finding ID",
      )
    : undefined;
  const path = driftArtifactPath(paths, sealed.kind, sealed.id, { findingId });
  const publication = await publishImmutableFile(
    {
      root: paths.graphRoot,
      path,
      bytes: sealed.bytes,
      maximumBytes: DRIFT_STATE_POLICY.maximumArtifactBytes,
      code: "DRIFT002",
      collisionCode: "DRIFT004",
      label: `Drift ${sealed.kind} artifact`,
    },
    hooks,
  );
  return Object.freeze({ ...sealed, path, publication });
}

export async function readDriftArtifact({
  graphRoot,
  workspaceIdentity,
  kind,
  id,
  findingId = undefined,
  graphRootIdentity = undefined,
  policyRevision = undefined,
  maximumBytes = DRIFT_STATE_POLICY.maximumArtifactBytes,
}) {
  const limit = assertMaximumBytes(maximumBytes, "Drift artifact");
  const paths = driftStatePaths(graphRoot, workspaceIdentity);
  const path = driftArtifactPath(paths, kind, id, { findingId });
  const definition = artifactDefinition(kind);
  const directory = dirname(path);
  const guard = await existingDirectoryGuard(
    paths,
    directory,
    `Drift ${definition.kind} artifact directory`,
  );
  if (guard === null) return null;
  const bytes = await readBoundedRegularFileIfPresent(path, {
    containmentRoot: directory,
    maximumBytes: limit,
    code: "DRIFT002",
    label: `Drift ${definition.kind} artifact`,
    allowTransientMissing: true,
    beforeOpen: () => guard.assert(),
    beforeHandleOpen: () => guard.assert(),
    afterRead: () => guard.assert(),
  });
  await guard.assert();
  if (bytes === null) return null;
  return parseDriftArtifactBytes(bytes, {
    id,
    kind: definition.kind,
    workspaceIdentity,
    graphRootIdentity,
    policyRevision,
  });
}

function typedParser(kind) {
  return (value, expected = {}) => parseDriftArtifact(value, { ...expected, kind });
}

function typedBytesParser(kind) {
  return (bytes, expected = {}) => parseDriftArtifactBytes(bytes, { ...expected, kind });
}

function typedSeal(kind) {
  return (options) => sealDriftArtifact({ ...options, kind });
}

function typedPublish(kind) {
  return (options, hooks = {}) => publishDriftArtifact({ ...options, kind }, hooks);
}

function typedRead(kind) {
  return (options) => readDriftArtifact({ ...options, kind });
}

export const parseDriftObservation = typedParser("observation");
export const parseDriftFinding = typedParser("finding");
export const parseDriftRefresh = typedParser("refresh");
export const parseDriftProposalBinding = typedParser("proposal-binding");
export const parseDriftDisposition = typedParser("disposition");

export const parseDriftObservationBytes = typedBytesParser("observation");
export const parseDriftFindingBytes = typedBytesParser("finding");
export const parseDriftRefreshBytes = typedBytesParser("refresh");
export const parseDriftProposalBindingBytes = typedBytesParser("proposal-binding");
export const parseDriftDispositionBytes = typedBytesParser("disposition");

export const sealDriftObservation = typedSeal("observation");
export const sealDriftFinding = typedSeal("finding");
export const sealDriftRefresh = typedSeal("refresh");
export const sealDriftProposalBinding = typedSeal("proposal-binding");
export const sealDriftDisposition = typedSeal("disposition");

export const publishDriftObservation = typedPublish("observation");
export const publishDriftFinding = typedPublish("finding");
export const publishDriftRefresh = typedPublish("refresh");
export const publishDriftProposalBinding = typedPublish("proposal-binding");
export const publishDriftDisposition = typedPublish("disposition");

export const readDriftObservation = typedRead("observation");
export const readDriftFinding = typedRead("finding");
export const readDriftRefresh = typedRead("refresh");
export const readDriftProposalBinding = typedRead("proposal-binding");
export const readDriftDisposition = typedRead("disposition");

export async function listDriftProposalBindings({
  graphRoot,
  workspaceIdentity,
  graphRootIdentity = undefined,
  policyRevision = undefined,
  findingIds = undefined,
}) {
  const paths = driftStatePaths(graphRoot, workspaceIdentity);
  const guard = await existingDirectoryGuard(
    paths,
    paths.proposalBindings,
    "Drift proposal-binding directory",
  );
  if (guard === null) return Object.freeze([]);
  let shards;
  if (findingIds !== undefined) {
    if (!Array.isArray(findingIds) || findingIds.length > DRIFT_STATE_POLICY.maximumActiveFindings) {
      throw driftError("DRIFT005", "Requested proposal-binding shards exceed their bound.");
    }
    shards = findingIds.map((id) =>
      artifactId(id, artifactDefinition("finding"), "Proposal-binding finding ID"));
    if (new Set(shards).size !== shards.length) {
      throw driftError("DRIFT001", "Requested proposal-binding shards must be unique.");
    }
    shards.sort();
  } else {
    const entries = await readdir(paths.proposalBindings, { withFileTypes: true });
    if (entries.length > DRIFT_STATE_POLICY.maximumProposalBindingShards) {
      throw driftError("DRIFT005", "Drift proposal-binding shard listing exceeds its bound.", {
        count: entries.length,
        limit: DRIFT_STATE_POLICY.maximumProposalBindingShards,
      });
    }
    shards = entries.map((entry) => {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw driftError("DRIFT002", "Drift proposal-binding root contains an unsafe entry.", {
          entry: entry.name,
        });
      }
      return artifactId(
        entry.name,
        artifactDefinition("finding"),
        "Proposal-binding shard name",
      );
    }).sort();
  }
  const bindings = [];
  for (const findingId of shards) {
    const directory = join(paths.proposalBindings, findingId);
    const shardGuard = await existingDirectoryGuard(
      paths,
      directory,
      `Drift proposal-binding shard ${findingId}`,
    );
    if (shardGuard === null) continue;
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.length > DRIFT_STATE_POLICY.maximumProposalBindingsPerFinding) {
      throw driftError("DRIFT005", "One drift finding exceeds its proposal-binding bound.", {
        findingId,
        count: entries.length,
        limit: DRIFT_STATE_POLICY.maximumProposalBindingsPerFinding,
      });
    }
    const names = entries.map((entry) => {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw driftError("DRIFT002", "Drift proposal-binding shard contains an unsafe entry.", {
          findingId,
          entry: entry.name,
        });
      }
      if (!/^proposal_binding_[0-9a-f]{64}\.json$/u.test(entry.name)) {
        throw driftError("DRIFT002", "Drift proposal-binding shard contains an unknown entry.", {
          findingId,
          entry: entry.name,
        });
      }
      return entry.name;
    }).sort();
    for (const name of names) {
      if (bindings.length >= DRIFT_STATE_POLICY.maximumProposalBindingArtifacts) {
        throw driftError("DRIFT005", "Drift proposal-binding listing exceeds its total bound.");
      }
      const id = name.slice(0, -".json".length);
      const binding = await readDriftProposalBinding({
        graphRoot: paths.graphRoot,
        workspaceIdentity,
        graphRootIdentity,
        policyRevision,
        findingId,
        id,
      });
      if (binding === null || binding.payload?.finding?.id !== findingId) {
        throw driftError("DRIFT002", "Drift proposal binding disappeared or crossed its shard.", {
          findingId,
          id,
        });
      }
      bindings.push(binding);
    }
    await shardGuard.assert();
  }
  await guard.assert();
  return Object.freeze(bindings);
}

export async function readDriftFindingSourceBytes({
  graphRoot,
  workspaceIdentity,
  findingId,
  graphRootIdentity = undefined,
  policyRevision = undefined,
  maximumBytes = DRIFT_STATE_POLICY.maximumArtifactBytes,
}) {
  const artifact = await readDriftFinding({
    graphRoot,
    workspaceIdentity,
    id: findingId,
    graphRootIdentity,
    policyRevision,
    maximumBytes,
  });
  return artifact === null ? null : Buffer.from(artifact.bytes);
}
