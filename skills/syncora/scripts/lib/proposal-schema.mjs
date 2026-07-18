import { createHash } from "node:crypto";

import { SyncoraError } from "./cli.mjs";

export const PROPOSAL_SCHEMA_VERSION = 1;

export const PROPOSAL_OPERATION_KINDS = Object.freeze([
  "note.create",
  "note.update",
  "note.move",
  "link.add",
  "decision.accept",
  "decision.supersede",
  "hub.refresh",
  "session.record",
]);

export const PROPOSAL_POLICY = Object.freeze({
  specification: "syncora-proposal-schema-v1",
  maximumInputBytes: 16_777_216,
  maximumStoredBytes: 16_777_216,
  maximumOperations: 64,
  maximumChanges: 256,
  maximumChangesPerOperation: 256,
  maximumSourceReferencesPerOperation: 256,
  maximumSourceReferencesTotal: 512,
  maximumSourceFileBytes: 16_777_216,
  maximumVerifiedSourceBytes: 67_108_864,
  maximumNoteBytes: 262_144,
  maximumIdentifierCharacters: 200,
  maximumReasonCharacters: 2_000,
  maximumReferenceCharacters: 4_096,
  maximumPathBytes: 4_096,
  maximumPathSegmentBytes: 240,
  maximumAuthorityReasons: 32,
  maximumAuthorityReasonCharacters: 512,
  maximumDuplicateCandidates: 20,
  maximumValidationFindings: 4_096,
});

const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u;
const PROPOSAL_ID_PATTERN = /^proposal_[0-9a-f]{64}$/u;
const OPERATION_KIND_SET = new Set(PROPOSAL_OPERATION_KINDS);
const ORIGINS = new Set(["capture", "manual", "drift", "repair"]);
const ACTOR_TYPES = new Set(["human", "model", "system", "agent"]);
const SOURCE_REFERENCE_TYPES = new Set([
  "binding",
  "component",
  "concept",
  "context-pack",
  "decision",
  "external",
  "file",
  "module",
  "note",
  "operation",
  "path-glob",
  "project",
  "session",
  "symbol",
  "user",
]);
const AUTHORITY_LEVELS = new Set([
  "none",
  "supporting",
  "canonical-content",
  "authority-changing",
]);

function proposalError(message, details = undefined) {
  return new SyncoraError("PROPOSAL001", message, details);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected, label) {
  if (!isPlainObject(value)) {
    throw proposalError(`${label} must be a JSON object.`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    !actual.every((key, index) => key === wanted[index])
  ) {
    throw proposalError(`${label} contains missing or unknown fields.`, {
      actual,
      expected: wanted,
    });
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

function boundedString(value, {
  label,
  minimum = 1,
  maximum,
  pattern = undefined,
  allowNewlines = false,
}) {
  if (typeof value !== "string" || !hasValidUnicode(value)) {
    throw proposalError(`${label} must be a valid Unicode string.`);
  }
  const characters = [...value].length;
  if (characters < minimum || characters > maximum) {
    throw proposalError(`${label} must contain ${minimum} through ${maximum} characters.`);
  }
  const forbidden = allowNewlines
    ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u
    : /[\u0000-\u001f\u007f-\u009f]/u;
  if (forbidden.test(value) || /[\u202a-\u202e\u2066-\u2069]/u.test(value)) {
    throw proposalError(`${label} contains unsafe control characters.`);
  }
  if (pattern && !pattern.test(value)) {
    throw proposalError(`${label} has an invalid format.`);
  }
  return value;
}

function identifier(value, label) {
  return boundedString(value, {
    label,
    maximum: PROPOSAL_POLICY.maximumIdentifierCharacters,
    pattern: IDENTIFIER_PATTERN,
  });
}

export function assertTaggedSha256(value, label = "Digest") {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    throw proposalError(`${label} must be a lowercase tagged SHA-256 value.`);
  }
  return value;
}

export function assertProposalId(value, label = "Proposal ID") {
  if (typeof value !== "string" || !PROPOSAL_ID_PATTERN.test(value)) {
    throw proposalError(`${label} must be a content-derived proposal ID.`);
  }
  return value;
}

function portableSegment(segment, label) {
  const bytes = Buffer.byteLength(segment, "utf8");
  if (bytes === 0 || bytes > PROPOSAL_POLICY.maximumPathSegmentBytes) {
    throw proposalError(`${label} contains an empty or oversized path segment.`);
  }
  if (segment === "." || segment === ".." || /[. ]$/u.test(segment)) {
    throw proposalError(`${label} contains a nonportable path segment.`);
  }
  if (/[<>:"|?*]/u.test(segment)) {
    throw proposalError(`${label} contains characters unsafe on supported hosts.`);
  }
  const stem = segment.split(".", 1)[0].toUpperCase();
  if (
    /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$)$/u.test(stem) ||
    /^(?:COM|LPT)[1-9¹²³]$/u.test(stem)
  ) {
    throw proposalError(`${label} contains a reserved device name.`);
  }
}

export function assertPortableGraphPath(value, label = "Graph-relative path") {
  if (typeof value !== "string" || !hasValidUnicode(value)) {
    throw proposalError(`${label} must be a valid Unicode string.`);
  }
  if (
    value.length === 0 ||
    value !== value.normalize("NFC") ||
    value.startsWith("/") ||
    value.includes("\\") ||
    /^[A-Za-z]:/u.test(value) ||
    /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value) ||
    Buffer.byteLength(value, "utf8") > PROPOSAL_POLICY.maximumPathBytes
  ) {
    throw proposalError(`${label} is not a bounded portable graph-relative path.`);
  }
  const segments = value.split("/");
  for (const segment of segments) portableSegment(segment, label);
  const folded = segments.map((segment) => segment.toLowerCase());
  const pair = folded.slice(0, 2).join("/");
  if (
    folded.some((segment) =>
      new Set([".syncora", ".git", ".obsidian", "node_modules"]).has(segment)) ||
    new Set([".claude/worktrees", "archive/migrations"]).has(pair)
  ) {
    throw proposalError(`${label} targets a noncanonical or excluded graph area.`);
  }
  if (!value.endsWith(".md")) {
    throw proposalError(`${label} must target a lowercase .md note.`);
  }
  return value;
}

export function assertPortableWorkspacePath(
  value,
  label = "Workspace-relative path",
) {
  if (typeof value !== "string" || !hasValidUnicode(value)) {
    throw proposalError(`${label} must be a valid Unicode string.`);
  }
  if (
    value.length === 0 ||
    value !== value.normalize("NFC") ||
    value.startsWith("/") ||
    value.includes("\\") ||
    /^[A-Za-z]:/u.test(value) ||
    /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value) ||
    Buffer.byteLength(value, "utf8") > PROPOSAL_POLICY.maximumPathBytes
  ) {
    throw proposalError(`${label} is not a bounded portable workspace-relative path.`);
  }
  const segments = value.split("/");
  for (const segment of segments) portableSegment(segment, label);
  if (new Set([".git", ".syncora"]).has(segments[0].toLowerCase())) {
    throw proposalError(`${label} targets private runtime state.`);
  }
  return value;
}

function noteText(value, label) {
  if (value === null) return null;
  if (typeof value !== "string" || !hasValidUnicode(value) || value.includes("\0")) {
    throw proposalError(`${label} must be null or valid UTF-8 note text.`);
  }
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > PROPOSAL_POLICY.maximumNoteBytes) {
    throw proposalError(`${label} exceeds the canonical note byte limit.`, {
      bytes,
      limit: PROPOSAL_POLICY.maximumNoteBytes,
    });
  }
  return value;
}

function parseActor(value) {
  exactKeys(value, ["type", "id", "runtime"], "Proposal actor");
  if (!ACTOR_TYPES.has(value.type)) {
    throw proposalError("Proposal actor type is unsupported.");
  }
  return {
    type: value.type,
    id: identifier(value.id, "Proposal actor ID"),
    runtime: value.runtime === null
      ? null
      : boundedString(value.runtime, {
          label: "Proposal actor runtime",
          maximum: 200,
        }),
  };
}

function parseSourceReference(value, pointer) {
  exactKeys(value, ["type", "ref", "expectedSha256"], pointer);
  if (!SOURCE_REFERENCE_TYPES.has(value.type)) {
    throw proposalError(`${pointer} type is unsupported.`);
  }
  const rawRef = boundedString(value.ref, {
      label: `${pointer} ref`,
      maximum: PROPOSAL_POLICY.maximumReferenceCharacters,
    });
  if (rawRef !== rawRef.normalize("NFC")) {
    throw proposalError(`${pointer} ref must use NFC Unicode normalization.`);
  }
  const ref = value.type === "note"
    ? assertPortableGraphPath(rawRef, `${pointer} ref`)
    : value.type === "file"
      ? assertPortableWorkspacePath(rawRef, `${pointer} ref`)
      : rawRef;
  const expectedSha256 = value.expectedSha256 === null
    ? null
    : assertTaggedSha256(value.expectedSha256, `${pointer} expectedSha256`);
  if ((value.type === "file" || value.type === "note") && expectedSha256 === null) {
    throw proposalError(`${pointer} must bind locally resolvable bytes with expectedSha256.`);
  }
  if (value.type !== "file" && value.type !== "note" && expectedSha256 !== null) {
    throw proposalError(`${pointer} cannot claim a digest for an unresolvable source type.`);
  }
  return { type: value.type, ref, expectedSha256 };
}

function parseChange(value, pointer) {
  exactKeys(value, ["path", "afterText", "expectedPriorSha256"], pointer);
  return {
    path: assertPortableGraphPath(value.path, `${pointer} path`),
    expectedPriorSha256: value.expectedPriorSha256 === null
      ? null
      : assertTaggedSha256(
          value.expectedPriorSha256,
          `${pointer} expectedPriorSha256`,
        ),
    afterText: noteText(value.afterText, `${pointer} afterText`),
  };
}

function requirePriorHash(change, pointer) {
  if (change.expectedPriorSha256 === null) {
    throw proposalError(`${pointer} must bind the exact prior note hash.`);
  }
}

function requireAbsentPrior(change, pointer) {
  if (change.expectedPriorSha256 !== null) {
    throw proposalError(`${pointer} must require the target path to be absent.`);
  }
}

function validateOperationShape(operation, pointer) {
  const changes = operation.changes;
  const requireCount = (count) => {
    if (changes.length !== count) {
      throw proposalError(`${pointer} requires exactly ${count} file change${count === 1 ? "" : "s"}.`);
    }
  };
  const requireAfter = (change, changePointer) => {
    if (change.afterText === null) {
      throw proposalError(`${changePointer} must contain resulting note text.`);
    }
  };

  switch (operation.kind) {
    case "note.create":
    case "session.record":
      requireCount(1);
      requireAfter(changes[0], `${pointer} change`);
      requireAbsentPrior(changes[0], `${pointer} change`);
      break;
    case "note.update":
    case "link.add":
    case "hub.refresh":
      requireCount(1);
      requireAfter(changes[0], `${pointer} change`);
      requirePriorHash(changes[0], `${pointer} change`);
      break;
    case "decision.accept":
      // Accepting a decision may either publish a new decision note (null
      // prior) or transition an existing note (exact prior hash). Exact live
      // state is resolved by the semantic kernel, while the schema ensures
      // omission cannot be misread as creation.
      requireCount(1);
      requireAfter(changes[0], `${pointer} change`);
      break;
    case "note.move": {
      requireCount(2);
      const removed = changes.filter((change) => change.afterText === null);
      const created = changes.filter((change) => change.afterText !== null);
      if (removed.length !== 1 || created.length !== 1) {
        throw proposalError(`${pointer} must contain one source removal and one destination creation.`);
      }
      requirePriorHash(removed[0], `${pointer} source change`);
      requireAbsentPrior(created[0], `${pointer} destination change`);
      if (taggedContentSha256(created[0].afterText) !== removed[0].expectedPriorSha256) {
        throw proposalError(`${pointer} destination bytes must exactly match the bound source bytes.`);
      }
      break;
    }
    case "decision.supersede":
      requireCount(2);
      changes.forEach((change, index) => {
        requireAfter(change, `${pointer} change ${index + 1}`);
        requirePriorHash(change, `${pointer} change ${index + 1}`);
      });
      break;
    default:
      throw proposalError(`${pointer} operation kind is unsupported.`);
  }
}

function parseOperation(value, index) {
  const pointer = `Proposal operation ${index + 1}`;
  exactKeys(value, ["operationId", "kind", "sourceRefs", "changes"], pointer);
  if (!OPERATION_KIND_SET.has(value.kind)) {
    throw proposalError(`${pointer} kind is unsupported.`);
  }
  if (
    !Array.isArray(value.sourceRefs) ||
    value.sourceRefs.length < 1 ||
    value.sourceRefs.length > PROPOSAL_POLICY.maximumSourceReferencesPerOperation
  ) {
    throw proposalError(`${pointer} must contain 1 through 256 provenance references.`);
  }
  if (
    !Array.isArray(value.changes) ||
    value.changes.length < 1 ||
    value.changes.length > PROPOSAL_POLICY.maximumChangesPerOperation
  ) {
    throw proposalError(`${pointer} must contain 1 through 256 file changes.`);
  }
  const operation = {
    operationId: identifier(value.operationId, `${pointer} ID`),
    kind: value.kind,
    sourceRefs: value.sourceRefs.map((entry, sourceIndex) =>
      parseSourceReference(entry, `${pointer} sourceRef ${sourceIndex + 1}`)),
    changes: value.changes.map((entry, changeIndex) =>
      parseChange(entry, `${pointer} change ${changeIndex + 1}`)),
  };
  validateOperationShape(operation, pointer);
  return operation;
}

export function parseProposalInput(value) {
  exactKeys(value, [
    "schemaVersion",
    "kind",
    "idempotencyKey",
    "origin",
    "actor",
    "reason",
    "correctsProposalId",
    "operations",
  ], "Proposal input");
  if (value.schemaVersion !== PROPOSAL_SCHEMA_VERSION || value.kind !== "syncora.proposal-input") {
    throw proposalError("Proposal input schemaVersion or kind is unsupported.");
  }
  if (!ORIGINS.has(value.origin)) {
    throw proposalError("Proposal origin is unsupported.");
  }
  if (
    !Array.isArray(value.operations) ||
    value.operations.length < 1 ||
    value.operations.length > PROPOSAL_POLICY.maximumOperations
  ) {
    throw proposalError("Proposal input must contain 1 through 64 semantic operations.");
  }
  const normalized = {
    schemaVersion: PROPOSAL_SCHEMA_VERSION,
    kind: "syncora.proposal-input",
    idempotencyKey: identifier(value.idempotencyKey, "Proposal idempotency key"),
    origin: value.origin,
    actor: parseActor(value.actor),
    reason: boundedString(value.reason, {
      label: "Proposal reason",
      maximum: PROPOSAL_POLICY.maximumReasonCharacters,
      allowNewlines: true,
    }),
    correctsProposalId: value.correctsProposalId === null
      ? null
      : assertProposalId(value.correctsProposalId, "Corrected proposal ID"),
    operations: value.operations.map((entry, index) =>
      parseOperation(entry, index)),
  };
  const operationIds = new Set();
  const paths = new Set();
  const sourceBindings = new Map();
  let totalChanges = 0;
  let totalSourceReferences = 0;
  for (const operation of normalized.operations) {
    const operationKey = operation.operationId.toLowerCase();
    if (operationIds.has(operationKey)) {
      throw proposalError("Proposal operation IDs must be unique case-insensitively.");
    }
    operationIds.add(operationKey);
    totalChanges += operation.changes.length;
    totalSourceReferences += operation.sourceRefs.length;
    for (const source of operation.sourceRefs) {
      const pathLike = source.type === "file" || source.type === "note";
      const identity = `${source.type}\u0000${pathLike ? source.ref.toLowerCase() : source.ref}`;
      const priorBinding = sourceBindings.get(identity);
      if (
        priorBinding !== undefined &&
        priorBinding.expectedSha256 !== source.expectedSha256
      ) {
        throw proposalError("One normalized source reference has conflicting digest bindings.", {
          type: source.type,
          ref: source.ref,
          firstOperationId: priorBinding.operationId,
          conflictingOperationId: operation.operationId,
        });
      }
      if (priorBinding === undefined) {
        sourceBindings.set(identity, {
          expectedSha256: source.expectedSha256,
          operationId: operation.operationId,
        });
      }
    }
    for (const change of operation.changes) {
      const pathKey = change.path.toLowerCase();
      if (paths.has(pathKey)) {
        throw proposalError("A proposal may change each graph path only once.", {
          path: change.path,
        });
      }
      paths.add(pathKey);
    }
  }
  if (totalChanges > PROPOSAL_POLICY.maximumChanges) {
    throw proposalError("Proposal input exceeds the 256-file-change limit.");
  }
  if (totalSourceReferences > PROPOSAL_POLICY.maximumSourceReferencesTotal) {
    throw proposalError(
      `Proposal input exceeds the ${PROPOSAL_POLICY.maximumSourceReferencesTotal}-source-reference limit.`,
      {
        references: totalSourceReferences,
        limit: PROPOSAL_POLICY.maximumSourceReferencesTotal,
      },
    );
  }
  const bytes = Buffer.byteLength(JSON.stringify(normalized), "utf8");
  if (bytes > PROPOSAL_POLICY.maximumInputBytes) {
    throw proposalError("Proposal input exceeds the 16 MiB byte limit.", {
      bytes,
      limit: PROPOSAL_POLICY.maximumInputBytes,
    });
  }
  return deepFreeze(normalized);
}

function parseJsonBytes(bytes, maximumBytes, label) {
  if (!Buffer.isBuffer(bytes)) {
    throw proposalError(`${label} must be supplied as a Buffer.`);
  }
  if (bytes.length > maximumBytes) {
    throw proposalError(`${label} exceeds its byte limit.`, {
      bytes: bytes.length,
      limit: maximumBytes,
    });
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw proposalError(`${label} is not valid UTF-8.`);
  }
  if (text.startsWith("\ufeff")) text = text.slice(1);
  try {
    return JSON.parse(text);
  } catch {
    throw proposalError(`${label} is not valid JSON.`);
  }
}

export function parseProposalInputBytes(bytes) {
  return parseProposalInput(
    parseJsonBytes(bytes, PROPOSAL_POLICY.maximumInputBytes, "Proposal input"),
  );
}

export function parseProposalBindings(value) {
  exactKeys(value, [
    "workspaceIdentity",
    "graphRootIdentity",
    "expectedGraphRevision",
    "validationSpecification",
    "policyRevision",
  ], "Proposal bindings");
  return deepFreeze({
    workspaceIdentity: assertTaggedSha256(value.workspaceIdentity, "Workspace identity"),
    graphRootIdentity: assertTaggedSha256(value.graphRootIdentity, "Graph root identity"),
    expectedGraphRevision: assertTaggedSha256(
      value.expectedGraphRevision,
      "Expected graph revision",
    ),
    validationSpecification: identifier(
      value.validationSpecification,
      "Validation specification",
    ),
    policyRevision: assertTaggedSha256(value.policyRevision, "Policy revision"),
  });
}

export function parseProposalAssessment(value) {
  exactKeys(value, [
    "authorityImpact",
    "reviewRequired",
    "projectedValidation",
    "duplicateCandidates",
  ], "Kernel proposal assessment");
  exactKeys(value.authorityImpact, ["level", "reasons", "paths"], "Authority impact");
  if (!AUTHORITY_LEVELS.has(value.authorityImpact.level)) {
    throw proposalError("Authority impact level is unsupported.");
  }
  if (
    !Array.isArray(value.authorityImpact.reasons) ||
    value.authorityImpact.reasons.length < 1 ||
    value.authorityImpact.reasons.length > PROPOSAL_POLICY.maximumAuthorityReasons
  ) {
    throw proposalError("Authority impact requires 1 through 32 bounded reasons.");
  }
  if (
    !Array.isArray(value.authorityImpact.paths) ||
    value.authorityImpact.paths.length < 1 ||
    value.authorityImpact.paths.length > PROPOSAL_POLICY.maximumChanges
  ) {
    throw proposalError("Authority impact requires 1 through 256 affected paths.");
  }
  if (value.reviewRequired !== true) {
    throw proposalError("Canonical Markdown proposals currently require explicit review.");
  }
  exactKeys(
    value.projectedValidation,
    ["valid", "findingCount", "digest", "projectedGraphRevision"],
    "Projected validation",
  );
  if (typeof value.projectedValidation.valid !== "boolean") {
    throw proposalError("Projected validation valid must be a boolean.");
  }
  if (
    !Number.isSafeInteger(value.projectedValidation.findingCount) ||
    value.projectedValidation.findingCount < 0 ||
    value.projectedValidation.findingCount > PROPOSAL_POLICY.maximumValidationFindings
  ) {
    throw proposalError("Projected validation findingCount is invalid or excessive.");
  }
  if (
    !Array.isArray(value.duplicateCandidates) ||
    value.duplicateCandidates.length > PROPOSAL_POLICY.maximumDuplicateCandidates
  ) {
    throw proposalError("Duplicate candidates must be an array with no more than 20 entries.");
  }
  const authorityPaths = value.authorityImpact.paths.map((path, index) =>
    assertPortableGraphPath(path, `Authority impact path ${index + 1}`));
  if (new Set(authorityPaths.map((path) => path.toLowerCase())).size !== authorityPaths.length) {
    throw proposalError("Authority impact paths must be unique case-insensitively.");
  }
  const duplicateCandidates = value.duplicateCandidates.map((candidate, index) => {
    const label = `Duplicate candidate ${index + 1}`;
    exactKeys(candidate, ["path", "similarity", "reason"], label);
    if (
      typeof candidate.similarity !== "number" ||
      !Number.isFinite(candidate.similarity) ||
      candidate.similarity < 0 ||
      candidate.similarity > 1
    ) {
      throw proposalError(`${label} similarity must be a finite number from 0 through 1.`);
    }
    return {
      path: assertPortableGraphPath(candidate.path, `${label} path`),
      similarity: Object.is(candidate.similarity, -0) ? 0 : candidate.similarity,
      reason: boundedString(candidate.reason, {
        label: `${label} reason`,
        maximum: PROPOSAL_POLICY.maximumAuthorityReasonCharacters,
      }),
    };
  });
  if (
    new Set(duplicateCandidates.map((candidate) => candidate.path.toLowerCase())).size !==
    duplicateCandidates.length
  ) {
    throw proposalError("Duplicate candidate paths must be unique case-insensitively.");
  }
  return deepFreeze({
    authorityImpact: {
      level: value.authorityImpact.level,
      reasons: value.authorityImpact.reasons.map((reason, index) =>
        boundedString(reason, {
          label: `Authority impact reason ${index + 1}`,
          maximum: PROPOSAL_POLICY.maximumAuthorityReasonCharacters,
        })),
      paths: authorityPaths,
    },
    reviewRequired: true,
    projectedValidation: {
      valid: value.projectedValidation.valid,
      findingCount: value.projectedValidation.findingCount,
      digest: assertTaggedSha256(
        value.projectedValidation.digest,
        "Projected validation digest",
      ),
      projectedGraphRevision: assertTaggedSha256(
        value.projectedValidation.projectedGraphRevision,
        "Projected graph revision",
      ),
    },
    duplicateCandidates,
  });
}

function canonicalValue(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw proposalError("Canonical JSON cannot contain non-finite numbers.");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalValue(entry)).join(",")}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalValue(value[key])}`).join(",")}}`;
  }
  throw proposalError("Canonical JSON contains a non-JSON value.");
}

export function canonicalProposalJson(value) {
  return canonicalValue(value);
}

function domainDigest(domain, value) {
  return `sha256:${createHash("sha256")
    .update(`${domain}\n`, "utf8")
    .update(canonicalProposalJson(value), "utf8")
    .digest("hex")}`;
}

export function taggedContentSha256(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function normalizedIntent(input, bindings, assessment) {
  const parsedInput = parseProposalInput(input);
  const parsedBindings = parseProposalBindings(bindings);
  const parsedAssessment = parseProposalAssessment(assessment);
  const changePaths = new Set(parsedInput.operations.flatMap((operation) =>
    operation.changes.map((change) => change.path.toLowerCase())));
  for (const path of parsedAssessment.authorityImpact.paths) {
    if (!changePaths.has(path.toLowerCase())) {
      throw proposalError("Authority impact paths must be changed by the proposal.", { path });
    }
  }
  return { parsedInput, parsedBindings, parsedAssessment };
}

export function computeProposalIntent(input, bindings, assessment) {
  const { parsedInput, parsedBindings, parsedAssessment } = normalizedIntent(
    input,
    bindings,
    assessment,
  );
  const document = {
    schemaVersion: PROPOSAL_SCHEMA_VERSION,
    input: parsedInput,
    bindings: parsedBindings,
    assessment: parsedAssessment,
  };
  const intentDigest = domainDigest("syncora-proposal-intent-v1", document);
  return deepFreeze({
    proposalId: `proposal_${intentDigest.slice("sha256:".length)}`,
    intentDigest,
    input: parsedInput,
    bindings: parsedBindings,
    assessment: parsedAssessment,
  });
}

function parseCreatedAt(value) {
  if (typeof value !== "string" || value.length > 40) {
    throw proposalError("Proposal createdAt must be a canonical ISO-8601 timestamp.");
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw proposalError("Proposal createdAt must be a canonical ISO-8601 timestamp.");
  }
  return value;
}

function operationsWithResultHashes(operations) {
  return operations.map((operation) => ({
    ...operation,
    changes: operation.changes.map((change) => ({
      ...change,
      afterSha256: change.afterText === null
        ? null
        : taggedContentSha256(change.afterText),
    })),
  }));
}

function inputFromRecord(record) {
  return {
    schemaVersion: PROPOSAL_SCHEMA_VERSION,
    kind: "syncora.proposal-input",
    idempotencyKey: record.idempotencyKey,
    origin: record.origin,
    actor: record.actor,
    reason: record.reason,
    correctsProposalId: record.correctsProposalId,
    operations: record.operations.map((operation) => ({
      operationId: operation.operationId,
      kind: operation.kind,
      sourceRefs: operation.sourceRefs,
      changes: operation.changes.map((change) => ({
        path: change.path,
        expectedPriorSha256: change.expectedPriorSha256,
        afterText: change.afterText,
      })),
    })),
  };
}

export function sealProposal(
  input,
  bindings,
  { assessment, createdAt = new Date().toISOString() } = {},
) {
  const intent = computeProposalIntent(input, bindings, assessment);
  const recordWithoutDigest = {
    schemaVersion: PROPOSAL_SCHEMA_VERSION,
    kind: "syncora.proposal",
    proposalId: intent.proposalId,
    intentDigest: intent.intentDigest,
    createdAt: parseCreatedAt(createdAt),
    idempotencyKey: intent.input.idempotencyKey,
    origin: intent.input.origin,
    actor: intent.input.actor,
    reason: intent.input.reason,
    correctsProposalId: intent.input.correctsProposalId,
    bindings: intent.bindings,
    assessment: intent.assessment,
    operations: operationsWithResultHashes(intent.input.operations),
  };
  const proposalDigest = domainDigest(
    "syncora-proposal-record-v1",
    recordWithoutDigest,
  );
  return deepFreeze({ ...recordWithoutDigest, proposalDigest });
}

function parseStoredChange(value, pointer) {
  exactKeys(
    value,
    ["path", "expectedPriorSha256", "afterText", "afterSha256"],
    pointer,
  );
  const parsed = parseChange({
    path: value.path,
    expectedPriorSha256: value.expectedPriorSha256,
    afterText: value.afterText,
  }, pointer);
  const expectedAfter = parsed.afterText === null
    ? null
    : taggedContentSha256(parsed.afterText);
  if (value.afterSha256 !== expectedAfter) {
    throw proposalError(`${pointer} afterSha256 does not match exact resulting bytes.`);
  }
  return { ...parsed, afterSha256: expectedAfter };
}

function parseStoredOperation(value, index) {
  const pointer = `Stored proposal operation ${index + 1}`;
  exactKeys(value, ["operationId", "kind", "sourceRefs", "changes"], pointer);
  const draft = {
    operationId: value.operationId,
    kind: value.kind,
    sourceRefs: value.sourceRefs,
    changes: value.changes.map((change, changeIndex) => {
      const parsed = parseStoredChange(change, `${pointer} change ${changeIndex + 1}`);
      return {
        path: parsed.path,
        expectedPriorSha256: parsed.expectedPriorSha256,
        afterText: parsed.afterText,
      };
    }),
  };
  const parsed = parseOperation(draft, index);
  return {
    ...parsed,
    changes: value.changes.map((change, changeIndex) =>
      parseStoredChange(change, `${pointer} change ${changeIndex + 1}`)),
  };
}

export function parseSealedProposal(value) {
  exactKeys(value, [
    "schemaVersion",
    "kind",
    "proposalId",
    "intentDigest",
    "proposalDigest",
    "createdAt",
    "idempotencyKey",
    "origin",
    "actor",
    "reason",
    "correctsProposalId",
    "bindings",
    "assessment",
    "operations",
  ], "Stored proposal");
  if (value.schemaVersion !== PROPOSAL_SCHEMA_VERSION || value.kind !== "syncora.proposal") {
    throw proposalError("Stored proposal schemaVersion or kind is unsupported.");
  }
  const candidate = {
    schemaVersion: PROPOSAL_SCHEMA_VERSION,
    kind: "syncora.proposal",
    proposalId: assertProposalId(value.proposalId),
    intentDigest: assertTaggedSha256(value.intentDigest, "Proposal intent digest"),
    createdAt: parseCreatedAt(value.createdAt),
    idempotencyKey: value.idempotencyKey,
    origin: value.origin,
    actor: value.actor,
    reason: value.reason,
    correctsProposalId: value.correctsProposalId,
    bindings: parseProposalBindings(value.bindings),
    assessment: parseProposalAssessment(value.assessment),
    operations: Array.isArray(value.operations)
      ? value.operations.map((operation, index) => parseStoredOperation(operation, index))
      : (() => { throw proposalError("Stored proposal operations must be an array."); })(),
  };
  const parsedInput = parseProposalInput(inputFromRecord(candidate));
  candidate.idempotencyKey = parsedInput.idempotencyKey;
  candidate.origin = parsedInput.origin;
  candidate.actor = parsedInput.actor;
  candidate.reason = parsedInput.reason;
  candidate.correctsProposalId = parsedInput.correctsProposalId;
  const intent = computeProposalIntent(parsedInput, candidate.bindings, candidate.assessment);
  if (candidate.proposalId !== intent.proposalId || candidate.intentDigest !== intent.intentDigest) {
    throw proposalError("Stored proposal content-derived identity does not match its contents.");
  }
  const claimedDigest = assertTaggedSha256(value.proposalDigest, "Proposal digest");
  const proposalDigest = domainDigest("syncora-proposal-record-v1", candidate);
  if (claimedDigest !== proposalDigest) {
    throw proposalError("Stored proposal digest does not match its exact contents.");
  }
  return deepFreeze({ ...candidate, proposalDigest });
}

export function parseSealedProposalBytes(bytes) {
  return parseSealedProposal(
    parseJsonBytes(bytes, PROPOSAL_POLICY.maximumStoredBytes, "Stored proposal"),
  );
}

export function serializeProposal(value) {
  const proposal = parseSealedProposal(value);
  const bytes = Buffer.from(`${JSON.stringify(proposal, null, 2)}\n`, "utf8");
  if (bytes.length > PROPOSAL_POLICY.maximumStoredBytes) {
    throw proposalError("Stored proposal exceeds the 16 MiB sealed-content limit.", {
      bytes: bytes.length,
      limit: PROPOSAL_POLICY.maximumStoredBytes,
    });
  }
  return bytes;
}

export function summarizeProposal(value) {
  const proposal = parseSealedProposal(value);
  const operations = proposal.operations.map((operation) => ({
    operationId: operation.operationId,
    kind: operation.kind,
    sourceRefCount: operation.sourceRefs.length,
    changes: operation.changes.map((change) => ({
      path: change.path,
      expectedPriorSha256: change.expectedPriorSha256,
      afterSha256: change.afterSha256,
      afterBytes: change.afterText === null
        ? 0
        : Buffer.byteLength(change.afterText, "utf8"),
    })),
  }));
  return deepFreeze({
    schemaVersion: PROPOSAL_SCHEMA_VERSION,
    kind: "syncora.proposal-summary",
    proposalId: proposal.proposalId,
    proposalDigest: proposal.proposalDigest,
    intentDigest: proposal.intentDigest,
    createdAt: proposal.createdAt,
    origin: proposal.origin,
    reason: proposal.reason,
    correctsProposalId: proposal.correctsProposalId,
    bindings: proposal.bindings,
    assessment: proposal.assessment,
    operationCount: operations.length,
    changeCount: operations.reduce((total, operation) => total + operation.changes.length, 0),
    operations,
  });
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
