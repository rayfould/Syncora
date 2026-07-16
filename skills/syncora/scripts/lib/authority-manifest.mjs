import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

import {
  AUTHORITY_INVENTORY_POLICY,
  authorityPolicyRevision,
  authorityRootIdentity,
  inspectAuthoritySnapshot,
  verifyAuthoritySnapshot,
} from "./authority-inventory.mjs";
import { applyAuthorityValidation } from "./authority-validator.mjs";
import { SyncoraError } from "./cli.mjs";
import { isNonPortableGraphPath } from "./graph-scanner.mjs";
import { NOTE_SCHEMA_SEMANTICS } from "./note-parser.mjs";
import {
  VALIDATION_POLICY,
  VALIDATION_SPECIFICATION,
} from "./validate.mjs";
import {
  readBoundedRegularFileIfPresent,
  samePath,
} from "./workspace.mjs";

export const AUTHORITY_MANIFEST_POLICY = Object.freeze({
  supportedSchemaVersions: [1, 2],
  actionableSchemaVersion: 2,
  maxManifestBytes: 16_777_216,
  maxJsonDepth: 64,
  maxDispositions: 50_000,
  maxOperations: 10_000,
  maxSourcesPerOperation: 256,
  maxRelationsPerTarget: 256,
  maxDiagnostics: 100,
});

const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const UNSAFE_TEXT_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/;
const KINDS = new Set([
  "atlas",
  "project",
  "decision",
  "concept",
  "reference",
  "session",
  "inbox",
]);
const AUTHORITIES = new Set([
  "canonical",
  "supporting",
  "historical",
  "transient",
]);
const DISPOSITIONS = new Set([
  "promote-via-targets",
  "evidence-only",
  "defer",
]);

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function portableIdentity(value) {
  return value.normalize("NFC").toLowerCase();
}

function characterLength(value) {
  return [...value].length;
}

function plainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

function sameSnapshot(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.birthtimeNs === right.birthtimeNs
  );
}

function unpairedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function parseStrictJson(text) {
  let offset = 0;

  function fail() {
    throw new SyncoraError(
      "MANIFEST001",
      "Reviewed authority manifest is not strict JSON.",
    );
  }

  function whitespace() {
    while (offset < text.length && /[\u0009\u000a\u000d\u0020]/.test(text[offset])) {
      offset += 1;
    }
  }

  function string() {
    if (text[offset] !== '"') fail();
    const start = offset;
    offset += 1;
    while (offset < text.length) {
      const code = text.charCodeAt(offset);
      if (code <= 0x1f) fail();
      if (text[offset] === '"') {
        offset += 1;
        let parsed;
        try {
          parsed = JSON.parse(text.slice(start, offset));
        } catch {
          fail();
        }
        if (unpairedSurrogate(parsed)) fail();
        return parsed;
      }
      if (text[offset] === "\\") {
        offset += 1;
        if (offset >= text.length) fail();
        if (text[offset] === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(offset + 1, offset + 5))) {
            fail();
          }
          offset += 5;
          continue;
        }
        if (!/["\\/bfnrt]/.test(text[offset])) fail();
      }
      offset += 1;
    }
    fail();
  }

  function value(depth) {
    if (depth > AUTHORITY_MANIFEST_POLICY.maxJsonDepth) fail();
    whitespace();
    if (text[offset] === "{") return object(depth + 1);
    if (text[offset] === "[") return array(depth + 1);
    if (text[offset] === '"') return string();
    for (const [literal, parsed] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ]) {
      if (text.startsWith(literal, offset)) {
        offset += literal.length;
        return parsed;
      }
    }
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(
      text.slice(offset),
    );
    if (!match) fail();
    offset += match[0].length;
    const parsed = Number(match[0]);
    if (!Number.isFinite(parsed)) fail();
    return parsed;
  }

  function object(depth) {
    const result = Object.create(null);
    const keys = new Set();
    offset += 1;
    whitespace();
    if (text[offset] === "}") {
      offset += 1;
      return result;
    }
    while (offset < text.length) {
      whitespace();
      const key = string();
      if (keys.has(key)) {
        throw new SyncoraError(
          "MANIFEST001",
          "Reviewed authority manifest contains a duplicate object key.",
        );
      }
      keys.add(key);
      whitespace();
      if (text[offset] !== ":") fail();
      offset += 1;
      result[key] = value(depth);
      whitespace();
      if (text[offset] === "}") {
        offset += 1;
        return result;
      }
      if (text[offset] !== ",") fail();
      offset += 1;
    }
    fail();
  }

  function array(depth) {
    const result = [];
    offset += 1;
    whitespace();
    if (text[offset] === "]") {
      offset += 1;
      return result;
    }
    while (offset < text.length) {
      result.push(value(depth));
      whitespace();
      if (text[offset] === "]") {
        offset += 1;
        return result;
      }
      if (text[offset] !== ",") fail();
      offset += 1;
    }
    fail();
  }

  whitespace();
  const parsed = value(0);
  whitespace();
  if (offset !== text.length) fail();
  return parsed;
}

function collector() {
  const examples = [];
  const byCode = new Map();
  let occurrences = 0;
  return {
    add(code, message, pointer) {
      occurrences += 1;
      byCode.set(code, (byCode.get(code) ?? 0) + 1);
      if (examples.length < AUTHORITY_MANIFEST_POLICY.maxDiagnostics) {
        examples.push({ code, message, pointer });
      }
    },
    count(code) {
      return byCode.get(code) ?? 0;
    },
    summary() {
      return {
        occurrences,
        omitted: Math.max(0, occurrences - examples.length),
        byCode: Object.fromEntries([...byCode].sort(([left], [right]) =>
          left.localeCompare(right))),
        examples: [...examples].sort((left, right) =>
          left.code.localeCompare(right.code) ||
          left.pointer.localeCompare(right.pointer) ||
          left.message.localeCompare(right.message)),
      };
    },
  };
}

function exactKeys(value, expected, pointer, findings) {
  if (!plainObject(value)) {
    findings.add("MANIFEST001", "Value must be an object.", pointer);
    return false;
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    findings.add(
      "MANIFEST001",
      "Object has missing or unknown fields.",
      pointer,
    );
    return false;
  }
  return true;
}

function boundedString(value, minimum, maximum, { safe = true } = {}) {
  return (
    typeof value === "string" &&
    characterLength(value) >= minimum &&
    characterLength(value) <= maximum &&
    !unpairedSurrogate(value) &&
    (!safe || !UNSAFE_TEXT_PATTERN.test(value))
  );
}

function boundedIdentifier(value) {
  return (
    boundedString(
      value,
      1,
      NOTE_SCHEMA_SEMANTICS.maxIdentifierCharacters,
    ) && IDENTIFIER_PATTERN.test(value)
  );
}

function validDate(value) {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1];
}

function portableMarkdownPath(value, { target = false } = {}) {
  if (typeof value !== "string") return false;
  if (
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value) ||
    value.includes("\\") ||
    value.includes("//") ||
    isNonPortableGraphPath(value, VALIDATION_POLICY)
  ) {
    return false;
  }
  const segments = value.split("/");
  if (
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    return false;
  }
  const lowered = segments.map((segment) => segment.toLowerCase());
  if (
    lowered.some((segment) =>
      [".git", ".obsidian", ".syncora", "node_modules"].includes(segment)) ||
    (lowered[0] === ".claude" && lowered[1] === "worktrees")
  ) {
    return false;
  }
  if (target && lowered[0] === "archive" && lowered[1] === "migrations") {
    return false;
  }
  return target ? value.endsWith(".md") : /\.md$/i.test(value);
}

function validateSourceReference(value, pointer, findings) {
  if (!exactKeys(value, ["path", "expectedSha256"], pointer, findings)) {
    return false;
  }
  let valid = true;
  if (!portableMarkdownPath(value.path)) {
    findings.add("MANIFEST001", "Source path is not portable Markdown.", `${pointer}/path`);
    valid = false;
  }
  if (typeof value.expectedSha256 !== "string" || !HASH_PATTERN.test(value.expectedSha256)) {
    findings.add("MANIFEST001", "Source hash is invalid.", `${pointer}/expectedSha256`);
    valid = false;
  }
  return valid;
}

function validateRelationList(value, pointer, findings) {
  if (!Array.isArray(value) || value.length > AUTHORITY_MANIFEST_POLICY.maxRelationsPerTarget) {
    findings.add("MANIFEST001", "Relation list is invalid or excessive.", pointer);
    return false;
  }
  let valid = true;
  const seen = new Set();
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (!boundedString(item, 1, NOTE_SCHEMA_SEMANTICS.maxRelationCharacters)) {
      findings.add("MANIFEST001", "Relation value is invalid or excessive.", `${pointer}/${index}`);
      valid = false;
      continue;
    }
    const identity = item.normalize("NFC");
    if (seen.has(identity)) {
      findings.add("MANIFEST001", "Relation list contains a duplicate.", `${pointer}/${index}`);
      valid = false;
    }
    seen.add(identity);
  }
  return valid;
}

function expectedAuthority(kind) {
  if (["atlas", "project", "decision", "concept"].includes(kind)) return "canonical";
  if (kind === "reference") return "supporting";
  if (kind === "session") return "historical";
  if (kind === "inbox") return "transient";
  return null;
}

function validateTarget(value, pointer, findings, version) {
  const fields = [
    "path",
    "expectedPriorSha256",
    "id",
    "kind",
    "scope",
    "state",
    "authority",
    "schemaVersion",
    "created",
    "updated",
    "summary",
    "decisionKey",
    "supersedes",
    "supersededBy",
    "appliesTo",
    ...(version === 2 ? ["contentSha256", "sourceRefs"] : []),
  ];
  if (!exactKeys(value, fields, pointer, findings)) return false;
  let valid = true;
  function reject(condition, message, field) {
    if (condition) return;
    findings.add("MANIFEST001", message, `${pointer}/${field}`);
    valid = false;
  }
  reject(portableMarkdownPath(value.path, { target: true }), "Target path is not portable lowercase Markdown.", "path");
  reject(
    value.expectedPriorSha256 === null ||
      (typeof value.expectedPriorSha256 === "string" && HASH_PATTERN.test(value.expectedPriorSha256)),
    "Prior target hash is invalid.",
    "expectedPriorSha256",
  );
  reject(boundedIdentifier(value.id), "Target ID is invalid.", "id");
  reject(KINDS.has(value.kind), "Target kind is invalid.", "kind");
  reject(boundedIdentifier(value.scope), "Target scope is invalid.", "scope");
  reject(
    boundedString(value.state, 1, NOTE_SCHEMA_SEMANTICS.maxStateCharacters) &&
      IDENTIFIER_PATTERN.test(value.state),
    "Target state is invalid.",
    "state",
  );
  reject(AUTHORITIES.has(value.authority), "Target authority is invalid.", "authority");
  reject(value.schemaVersion === 1, "Target schemaVersion must equal 1.", "schemaVersion");
  reject(validDate(value.created), "Target created date is invalid.", "created");
  reject(validDate(value.updated), "Target updated date is invalid.", "updated");
  if (validDate(value.created) && validDate(value.updated)) {
    reject(value.created <= value.updated, "Target updated date precedes created date.", "updated");
  }
  reject(
    boundedString(value.summary, 1, NOTE_SCHEMA_SEMANTICS.maxSummaryCharacters),
    "Target summary is invalid or excessive.",
    "summary",
  );
  if (value.kind === "decision") {
    reject(boundedIdentifier(value.decisionKey), "Decision key is invalid.", "decisionKey");
  } else {
    reject(value.decisionKey === null, "Non-decision target must use a null decisionKey.", "decisionKey");
  }
  if (KINDS.has(value.kind)) {
    reject(value.authority === expectedAuthority(value.kind), "Target authority violates its kind ceiling.", "authority");
  }
  valid = validateRelationList(value.supersedes, `${pointer}/supersedes`, findings) && valid;
  valid = validateRelationList(value.supersededBy, `${pointer}/supersededBy`, findings) && valid;
  valid = validateRelationList(value.appliesTo, `${pointer}/appliesTo`, findings) && valid;
  if (value.kind !== "decision" && ((value.supersedes?.length ?? 0) > 0 || (value.supersededBy?.length ?? 0) > 0)) {
    findings.add("MANIFEST001", "Only decisions may declare supersession.", pointer);
    valid = false;
  }

  if (version === 2) {
    reject(
      typeof value.contentSha256 === "string" && HASH_PATTERN.test(value.contentSha256),
      "Target staged-content hash is invalid.",
      "contentSha256",
    );
    if (!Array.isArray(value.sourceRefs) || value.sourceRefs.length < 1 || value.sourceRefs.length > AUTHORITY_MANIFEST_POLICY.maxSourcesPerOperation) {
      findings.add("MANIFEST001", "Target sourceRefs is invalid or excessive.", `${pointer}/sourceRefs`);
      valid = false;
    } else {
      for (let index = 0; index < value.sourceRefs.length; index += 1) {
        valid = validateSourceReference(
          value.sourceRefs[index],
          `${pointer}/sourceRefs/${index}`,
          findings,
        ) && valid;
      }
    }
  }
  return valid;
}

function validateManifestShape(manifest, findings) {
  if (!plainObject(manifest)) {
    findings.add("MANIFEST001", "Manifest must be an object.", "$");
    return null;
  }
  if (!AUTHORITY_MANIFEST_POLICY.supportedSchemaVersions.includes(manifest.manifestSchemaVersion)) {
    findings.add("MANIFEST001", "Manifest schema version is unsupported.", "$/manifestSchemaVersion");
    return null;
  }
  const version = manifest.manifestSchemaVersion;
  if (!exactKeys(
    manifest,
    ["manifestSchemaVersion", "kind", "status", "source", "review", "dispositions", "operations"],
    "$",
    findings,
  )) return null;
  if (manifest.kind !== "syncora.authority-promotion") {
    findings.add("MANIFEST001", "Manifest kind is invalid.", "$/kind");
  }
  if (manifest.status !== "reviewed") {
    findings.add("MANIFEST001", "Manifest status must be reviewed.", "$/status");
  }

  if (exactKeys(
    manifest.source,
    ["inventorySpecification", "validationSpecification", "reportSchemaVersion", "policyRevision", "rootIdentity", "graphRevision"],
    "$/source",
    findings,
  )) {
    if (manifest.source.inventorySpecification !== AUTHORITY_INVENTORY_POLICY.specification) {
      findings.add("MANIFEST001", "Inventory specification is unsupported.", "$/source/inventorySpecification");
    }
    if (manifest.source.validationSpecification !== VALIDATION_SPECIFICATION) {
      findings.add("MANIFEST001", "Validation specification is unsupported.", "$/source/validationSpecification");
    }
    if (manifest.source.reportSchemaVersion !== 1) {
      findings.add("MANIFEST001", "Inventory report schema is unsupported.", "$/source/reportSchemaVersion");
    }
    for (const field of ["policyRevision", "rootIdentity", "graphRevision"]) {
      if (typeof manifest.source[field] !== "string" || !HASH_PATTERN.test(manifest.source[field])) {
        findings.add("MANIFEST001", "Snapshot binding hash is invalid.", `$/source/${field}`);
      }
    }
  }

  if (exactKeys(manifest.review, ["reviewedBy", "reviewedAt", "reason"], "$/review", findings)) {
    if (!boundedString(manifest.review.reviewedBy, 1, 200)) {
      findings.add("MANIFEST001", "Reviewer identity is invalid.", "$/review/reviewedBy");
    }
    if (!validDate(manifest.review.reviewedAt)) {
      findings.add("MANIFEST001", "Review date is invalid.", "$/review/reviewedAt");
    }
    if (!boundedString(manifest.review.reason, 1, 2_000)) {
      findings.add("MANIFEST001", "Review reason is invalid or excessive.", "$/review/reason");
    }
  }

  if (!Array.isArray(manifest.dispositions) || manifest.dispositions.length > AUTHORITY_MANIFEST_POLICY.maxDispositions) {
    findings.add("MANIFEST001", "Disposition list is invalid or excessive.", "$/dispositions");
  } else {
    for (let index = 0; index < manifest.dispositions.length; index += 1) {
      const disposition = manifest.dispositions[index];
      const pointer = `$/dispositions/${index}`;
      if (!exactKeys(disposition, ["path", "expectedSha256", "disposition"], pointer, findings)) continue;
      if (!portableMarkdownPath(disposition.path)) {
        findings.add("MANIFEST001", "Disposition path is not portable Markdown.", `${pointer}/path`);
      }
      if (typeof disposition.expectedSha256 !== "string" || !HASH_PATTERN.test(disposition.expectedSha256)) {
        findings.add("MANIFEST001", "Disposition hash is invalid.", `${pointer}/expectedSha256`);
      }
      if (!DISPOSITIONS.has(disposition.disposition)) {
        findings.add("MANIFEST001", "Disposition value is invalid.", `${pointer}/disposition`);
      }
    }
  }

  if (!Array.isArray(manifest.operations) || manifest.operations.length > AUTHORITY_MANIFEST_POLICY.maxOperations) {
    findings.add("MANIFEST001", "Operation list is invalid or excessive.", "$/operations");
  } else {
    for (let index = 0; index < manifest.operations.length; index += 1) {
      const operation = manifest.operations[index];
      const pointer = `$/operations/${index}`;
      if (!exactKeys(operation, ["operationId", "sources", "target"], pointer, findings)) continue;
      if (!boundedIdentifier(operation.operationId)) {
        findings.add("MANIFEST001", "Operation ID is invalid.", `${pointer}/operationId`);
      }
      if (!Array.isArray(operation.sources) || operation.sources.length < 1 || operation.sources.length > AUTHORITY_MANIFEST_POLICY.maxSourcesPerOperation) {
        findings.add("MANIFEST001", "Operation sources are invalid or excessive.", `${pointer}/sources`);
      } else {
        for (let sourceIndex = 0; sourceIndex < operation.sources.length; sourceIndex += 1) {
          validateSourceReference(
            operation.sources[sourceIndex],
            `${pointer}/sources/${sourceIndex}`,
            findings,
          );
        }
      }
      validateTarget(operation.target, `${pointer}/target`, findings, version);
    }
  }
  return version;
}

function throwFindings(findings) {
  const summary = findings.summary();
  const code = findings.count("MANIFEST001") > 0
    ? "MANIFEST001"
    : findings.count("MANIFEST002") > 0
      ? "MANIFEST002"
      : "MANIFEST003";
  throw new SyncoraError(
    code,
    "Reviewed authority manifest failed deterministic validation.",
    summary,
  );
}

async function readManifestFile(manifestPath) {
  if (typeof manifestPath !== "string" || !isAbsolute(manifestPath)) {
    throw new SyncoraError(
      "MANIFEST001",
      "Authority manifest path must be absolute.",
    );
  }
  const parentPath = dirname(manifestPath);
  let parentRealPath;
  let resolvedPath;
  let before;
  try {
    parentRealPath = await realpath(parentPath);
    resolvedPath = await realpath(manifestPath);
    before = await lstat(manifestPath, { bigint: true });
  } catch (error) {
    throw new SyncoraError(
      "MANIFEST001",
      "Authority manifest could not be inspected safely.",
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
  if (
    !samePath(dirname(resolvedPath), parentRealPath) ||
    before.isSymbolicLink() ||
    !before.isFile()
  ) {
    throw new SyncoraError(
      "MANIFEST001",
      "Authority manifest must be a direct regular file, not a link.",
    );
  }
  if (before.size > BigInt(AUTHORITY_MANIFEST_POLICY.maxManifestBytes)) {
    throw new SyncoraError(
      "MANIFEST001",
      `Authority manifest exceeds ${AUTHORITY_MANIFEST_POLICY.maxManifestBytes} bytes.`,
    );
  }
  let bytes;
  let after;
  let finalResolvedPath;
  try {
    bytes = await readBoundedRegularFileIfPresent(resolvedPath, {
      containmentRoot: parentRealPath,
      maximumBytes: AUTHORITY_MANIFEST_POLICY.maxManifestBytes,
      code: "MANIFEST001",
      label: "Authority manifest",
    });
    after = await lstat(resolvedPath, { bigint: true });
    finalResolvedPath = await realpath(manifestPath);
  } catch (error) {
    throw new SyncoraError(
      "MANIFEST001",
      "Authority manifest could not be read safely.",
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
  if (
    bytes === null ||
    bytes.length !== Number(after.size) ||
    !sameSnapshot(before, after) ||
    !samePath(resolvedPath, finalResolvedPath) ||
    bytes.length > AUTHORITY_MANIFEST_POLICY.maxManifestBytes
  ) {
    throw new SyncoraError(
      "MANIFEST002",
      "Authority manifest changed while it was being read.",
    );
  }
  return { bytes, metadata: after, resolvedPath, parentRealPath };
}

function decodeManifest(bytes) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new SyncoraError(
      "MANIFEST001",
      "Authority manifest is not valid UTF-8.",
    );
  }
  if (text.charCodeAt(0) === 0xfeff) {
    throw new SyncoraError(
      "MANIFEST001",
      "Authority manifest must not contain a UTF-8 BOM.",
    );
  }
  return parseStrictJson(text);
}

function cloneAuthorityNote(note) {
  return {
    path: note.path,
    currentSchema: true,
    authorityClass: "pending",
    frontmatter: {
      ...note.frontmatter,
      supersedes: [...(note.frontmatter.supersedes ?? [])],
      superseded_by: [...(note.frontmatter.superseded_by ?? [])],
      applies_to: [...(note.frontmatter.applies_to ?? [])],
      source_refs: [...(note.frontmatter.source_refs ?? [])],
    },
    characterLength: note.characterLength,
    links: [...note.links],
    diagnostics: [],
  };
}

function syntheticTarget(operation) {
  const target = operation.target;
  return {
    path: target.path,
    currentSchema: true,
    authorityClass: "pending",
    frontmatter: {
      id: target.id,
      kind: target.kind,
      scope: target.scope,
      state: target.state,
      authority: target.authority,
      schema_version: target.schemaVersion,
      created: target.created,
      updated: target.updated,
      summary: target.summary,
      ...(target.decisionKey === null ? {} : { decision_key: target.decisionKey }),
      supersedes: [...target.supersedes],
      superseded_by: [...target.supersededBy],
      applies_to: [...target.appliesTo],
      source_refs: [],
    },
    characterLength: 0,
    links: [],
    diagnostics: [],
  };
}

function sourceReferenceKey(reference) {
  return `${portableIdentity(reference.path)}\0${reference.expectedSha256}`;
}

function sameSourceReferenceSet(left, right) {
  if (left.length !== right.length) return false;
  const leftKeys = left.map(sourceReferenceKey).sort();
  const rightKeys = right.map(sourceReferenceKey).sort();
  return leftKeys.every((value, index) => value === rightKeys[index]);
}

function validateBindingsAndSemantics(manifest, version, snapshot, findings) {
  const { inspection, queue, bindings } = snapshot;
  const expectedBindings = {
    inventorySpecification: AUTHORITY_INVENTORY_POLICY.specification,
    validationSpecification: VALIDATION_SPECIFICATION,
    reportSchemaVersion: 1,
    policyRevision: authorityPolicyRevision(),
    rootIdentity: authorityRootIdentity(inspection.graph.resolvedGraphPath),
    graphRevision: inspection.report.graph.revision,
  };
  for (const [field, expected] of Object.entries(expectedBindings)) {
    if (manifest.source[field] !== expected) {
      findings.add("MANIFEST002", "Manifest snapshot binding does not match the current graph.", `$/source/${field}`);
    }
  }
  if (
    bindings.graphRevision !== expectedBindings.graphRevision ||
    bindings.policyRevision !== expectedBindings.policyRevision ||
    bindings.rootIdentity !== expectedBindings.rootIdentity
  ) {
    findings.add("MANIFEST002", "Authority snapshot bindings are internally inconsistent.", "$/source");
  }

  const queueByPath = new Map(queue.map((entry) => [entry.source.path, entry]));
  const reviewRequired = new Map(
    queue.filter((entry) => entry.classification === "review-required")
      .map((entry) => [entry.source.path, entry]),
  );
  const dispositionByPath = new Map();
  const dispositionPortablePaths = new Set();
  for (let index = 0; index < manifest.dispositions.length; index += 1) {
    const disposition = manifest.dispositions[index];
    const pointer = `$/dispositions/${index}`;
    const pathIdentity = portableIdentity(disposition.path);
    if (dispositionByPath.has(disposition.path) || dispositionPortablePaths.has(pathIdentity)) {
      findings.add("MANIFEST003", "Source has more than one disposition.", pointer);
      continue;
    }
    dispositionByPath.set(disposition.path, disposition);
    dispositionPortablePaths.add(pathIdentity);
    const source = reviewRequired.get(disposition.path);
    if (!source) {
      findings.add("MANIFEST003", "Disposition does not identify a review-required source.", pointer);
    } else if (source.source.sha256 !== disposition.expectedSha256) {
      findings.add("MANIFEST002", "Disposition source hash is stale.", `${pointer}/expectedSha256`);
    }
  }
  for (const [path, source] of reviewRequired) {
    const disposition = dispositionByPath.get(path);
    if (!disposition) {
      findings.add("MANIFEST003", "Review-required source has no disposition.", `graph:${path}`);
    } else if (disposition.expectedSha256 !== source.source.sha256) {
      findings.add("MANIFEST002", "Disposition source hash is stale.", `graph:${path}`);
    }
  }

  const operationIds = new Set();
  const targetPaths = new Set();
  const promotedParticipation = new Map();
  const graphByPortablePath = new Map();
  for (const entry of queue) {
    const key = portableIdentity(entry.source.path);
    const matches = graphByPortablePath.get(key) ?? [];
    matches.push(entry);
    graphByPortablePath.set(key, matches);
  }

  for (let index = 0; index < manifest.operations.length; index += 1) {
    const operation = manifest.operations[index];
    const pointer = `$/operations/${index}`;
    const operationIdentity = portableIdentity(operation.operationId);
    if (operationIds.has(operationIdentity)) {
      findings.add("MANIFEST003", "Operation ID is duplicated.", `${pointer}/operationId`);
    }
    operationIds.add(operationIdentity);

    const targetIdentity = portableIdentity(operation.target.path);
    if (targetPaths.has(targetIdentity)) {
      findings.add("MANIFEST003", "Target path is assigned by more than one operation.", `${pointer}/target/path`);
    }
    targetPaths.add(targetIdentity);

    const actualTargets = graphByPortablePath.get(targetIdentity) ?? [];
    if (actualTargets.length > 1) {
      findings.add("MANIFEST002", "Target path is ambiguous in the current graph.", `${pointer}/target/path`);
    } else if (actualTargets.length === 0) {
      if (operation.target.expectedPriorSha256 !== null) {
        findings.add("MANIFEST002", "Target expected a prior file that does not exist.", `${pointer}/target/expectedPriorSha256`);
      }
    } else {
      const current = actualTargets[0];
      if (
        current.source.path !== operation.target.path ||
        operation.target.expectedPriorSha256 !== current.source.sha256
      ) {
        findings.add("MANIFEST002", "Prior target path or hash is stale.", `${pointer}/target/expectedPriorSha256`);
      }
    }

    const seenSources = new Set();
    for (let sourceIndex = 0; sourceIndex < operation.sources.length; sourceIndex += 1) {
      const sourceReference = operation.sources[sourceIndex];
      const sourcePointer = `${pointer}/sources/${sourceIndex}`;
      const sourceIdentity = portableIdentity(sourceReference.path);
      if (seenSources.has(sourceIdentity)) {
        findings.add("MANIFEST003", "Operation contains the same source more than once.", sourcePointer);
        continue;
      }
      seenSources.add(sourceIdentity);
      const source = reviewRequired.get(sourceReference.path);
      const disposition = dispositionByPath.get(sourceReference.path);
      if (!source) {
        findings.add("MANIFEST003", "Operation source is not review-required.", sourcePointer);
        continue;
      }
      if (source.source.sha256 !== sourceReference.expectedSha256) {
        findings.add("MANIFEST002", "Operation source hash is stale.", `${sourcePointer}/expectedSha256`);
      }
      if (disposition?.disposition !== "promote-via-targets") {
        findings.add("MANIFEST003", "Operation source is not marked promote-via-targets.", sourcePointer);
      }
      promotedParticipation.set(
        sourceReference.path,
        (promotedParticipation.get(sourceReference.path) ?? 0) + 1,
      );
    }
    if (version === AUTHORITY_MANIFEST_POLICY.actionableSchemaVersion &&
        !sameSourceReferenceSet(operation.sources, operation.target.sourceRefs)) {
      findings.add("MANIFEST003", "Actionable target sourceRefs must exactly equal its operation sources.", `${pointer}/target/sourceRefs`);
    }
  }

  for (const disposition of manifest.dispositions) {
    const participation = promotedParticipation.get(disposition.path) ?? 0;
    if (disposition.disposition === "promote-via-targets" && participation === 0) {
      findings.add("MANIFEST003", "Promoted source participates in no operation.", `source:${disposition.path}`);
    }
    if (disposition.disposition !== "promote-via-targets" && participation > 0) {
      findings.add("MANIFEST003", "Evidence-only or deferred source participates in an operation.", `source:${disposition.path}`);
    }
  }

  const replacedPaths = new Set(
    manifest.operations.map((operation) => portableIdentity(operation.target.path)),
  );
  const overlay = inspection.notes
    .filter((note) => note.currentSchema && !replacedPaths.has(portableIdentity(note.path)))
    .map(cloneAuthorityNote);
  overlay.push(...manifest.operations.map(syntheticTarget));
  applyAuthorityValidation(overlay, VALIDATION_POLICY);
  for (const note of overlay) {
    for (const diagnostic of note.diagnostics) {
      if (!["ID001", "HUB001", "HUB002", "AUTH001", "AUTH002", "AUTH003"].includes(diagnostic.code)) {
        continue;
      }
      findings.add(
        "MANIFEST003",
        `Post-promotion authority overlay violates ${diagnostic.code}.`,
        `graph:${note.path}`,
      );
    }
  }

  return {
    reviewRequired: reviewRequired.size,
    currentSchema: queue.filter((entry) => entry.classification === "current-schema").length,
    blocked: queue.filter((entry) => entry.classification === "blocked").length,
    queueByPath,
  };
}

export async function loadAndValidateAuthorityManifest(options, hooks = {}) {
  if (!plainObject(options)) {
    throw new SyncoraError(
      "MANIFEST001",
      "Authority manifest validation options must be an object.",
    );
  }
  const initialFile = await readManifestFile(options.manifestPath);
  const manifestBytes = initialFile.bytes;
  const manifestSha256 = sha256(manifestBytes);
  const manifest = decodeManifest(manifestBytes);
  const findings = collector();
  const version = validateManifestShape(manifest, findings);
  if (version === null || findings.count("MANIFEST001") > 0) {
    throwFindings(findings);
  }

  const authoritySnapshot = await inspectAuthoritySnapshot({
    workspace: options.workspace,
    allowExternalGraphRoot: options.allowExternalGraphRoot,
  });
  validateBindingsAndSemantics(
    manifest,
    version,
    authoritySnapshot,
    findings,
  );
  if (findings.summary().occurrences > 0) throwFindings(findings);

  try {
    await verifyAuthoritySnapshot(
      {
        workspace: options.workspace,
        allowExternalGraphRoot: options.allowExternalGraphRoot,
      },
      authoritySnapshot,
      hooks,
    );
  } catch (error) {
    throw new SyncoraError(
      "MANIFEST002",
      "Authority graph changed during manifest validation.",
      { sourceCode: error?.code ?? "READ001" },
    );
  }
  await hooks.beforeFinalManifestRead?.();
  let finalFile;
  try {
    finalFile = await readManifestFile(options.manifestPath);
  } catch (error) {
    throw new SyncoraError(
      "MANIFEST002",
      "Authority manifest changed during semantic validation.",
      { sourceCode: error?.code ?? "MANIFEST001" },
    );
  }
  if (
    !initialFile.bytes.equals(finalFile.bytes) ||
    !sameSnapshot(initialFile.metadata, finalFile.metadata) ||
    !samePath(initialFile.resolvedPath, finalFile.resolvedPath)
  ) {
    throw new SyncoraError(
      "MANIFEST002",
      "Authority manifest changed during semantic validation.",
    );
  }

  const operations = manifest.operations.map((operation) => ({
    operationId: operation.operationId,
    sources: [...operation.sources]
      .map((source) => ({ ...source }))
      .sort((left, right) =>
        portableIdentity(left.path).localeCompare(portableIdentity(right.path)) ||
        left.expectedSha256.localeCompare(right.expectedSha256)),
    target: {
      ...operation.target,
      supersedes: [...operation.target.supersedes],
      supersededBy: [...operation.target.supersededBy],
      appliesTo: [...operation.target.appliesTo],
      ...(operation.target.sourceRefs
        ? {
            sourceRefs: operation.target.sourceRefs.map((source) => ({
              ...source,
            })),
          }
        : {}),
    },
  }));
  const targets = operations.map((operation) => ({
    operationId: operation.operationId,
    ...operation.target,
  }));

  return {
    manifest,
    manifestBytes,
    manifestSha256,
    actionable:
      version === AUTHORITY_MANIFEST_POLICY.actionableSchemaVersion,
    inspection: authoritySnapshot.inspection,
    snapshot: {
      queue: authoritySnapshot.queue,
      bindings: authoritySnapshot.bindings,
    },
    operations,
    targets,
  };
}
