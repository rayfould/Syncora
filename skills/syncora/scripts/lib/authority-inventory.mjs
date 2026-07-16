import { createHash } from "node:crypto";

import { AUTHORITY_SEMANTICS } from "./authority-validator.mjs";
import { stringifyJson, SyncoraError } from "./cli.mjs";
import { NOTE_SCHEMA_SEMANTICS } from "./note-parser.mjs";
import {
  inspectWorkspace,
  VALIDATION_POLICY,
  VALIDATION_SPECIFICATION,
} from "./validate.mjs";
import { samePath } from "./workspace.mjs";

export const AUTHORITY_INVENTORY_POLICY = Object.freeze({
  specification: "syncora-authority-inventory-v1",
  cursorVersion: 1,
  defaultLimit: 20,
  maxLimit: 100,
  maxCursorCharacters: 8_192,
  maxDiagnosticCodes: 16,
  maxReportBytes: 65_536,
});

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function normalizedRoot(root) {
  return process.platform === "win32"
    ? root.replaceAll("\\", "/").toLowerCase()
    : root;
}

export function authorityRootIdentity(graphRoot) {
  return sha256(`syncora-authority-root-v1\n${normalizedRoot(graphRoot)}`);
}

export function authorityPolicyRevision() {
  return sha256(
    JSON.stringify({
      validationSpecification: VALIDATION_SPECIFICATION,
      validation: VALIDATION_POLICY,
      noteSchemaSemantics: NOTE_SCHEMA_SEMANTICS,
      authoritySemantics: AUTHORITY_SEMANTICS,
      inventory: AUTHORITY_INVENTORY_POLICY,
    }),
  );
}

function migrateError(code, message, details = undefined) {
  return new SyncoraError(code, message, details);
}

function cursorContent(payload) {
  return {
    v: payload.v,
    spec: payload.spec,
    revision: payload.revision,
    policy: payload.policy,
    root: payload.root,
    position: payload.position,
    after: payload.after,
    source: payload.source,
  };
}

function cursorChecksum(payload) {
  return sha256(
    `syncora-authority-cursor-v1\n${JSON.stringify(cursorContent(payload))}`,
  );
}

function encodeCursor(payload) {
  const content = cursorContent(payload);
  const envelope = { ...content, checksum: cursorChecksum(content) };
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
}

function decodeCursor(token) {
  if (
    typeof token !== "string" ||
    token.length < 1 ||
    token.length > AUTHORITY_INVENTORY_POLICY.maxCursorCharacters ||
    !/^[A-Za-z0-9_-]+$/.test(token)
  ) {
    throw migrateError("MIGRATE002", "Authority inventory cursor is malformed.");
  }

  let bytes;
  let decoded;
  try {
    bytes = Buffer.from(token, "base64url");
    if (bytes.toString("base64url") !== token) throw new Error("noncanonical");
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw migrateError("MIGRATE002", "Authority inventory cursor is malformed.");
  }

  let payload;
  try {
    payload = JSON.parse(decoded);
  } catch {
    throw migrateError("MIGRATE002", "Authority inventory cursor is malformed.");
  }

  const expectedKeys = [
    "after",
    "checksum",
    "policy",
    "position",
    "revision",
    "root",
    "source",
    "spec",
    "v",
  ];
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    Object.getPrototypeOf(payload) !== Object.prototype ||
    JSON.stringify(Object.keys(payload).sort()) !== JSON.stringify(expectedKeys)
  ) {
    throw migrateError("MIGRATE002", "Authority inventory cursor is malformed.");
  }
  if (
    payload.v !== AUTHORITY_INVENTORY_POLICY.cursorVersion ||
    payload.spec !== AUTHORITY_INVENTORY_POLICY.specification ||
    typeof payload.revision !== "string" ||
    typeof payload.policy !== "string" ||
    typeof payload.root !== "string" ||
    !Number.isSafeInteger(payload.position) ||
    payload.position < 0 ||
    typeof payload.after !== "string" ||
    payload.after.length < 1 ||
    !/^sha256:[a-f0-9]{64}$/.test(payload.source) ||
    !/^sha256:[a-f0-9]{64}$/.test(payload.checksum) ||
    payload.checksum !== cursorChecksum(payload)
  ) {
    throw migrateError("MIGRATE002", "Authority inventory cursor is incompatible.");
  }
  return payload;
}

function classification(note) {
  if (note.authorityClass === "quarantined") return "blocked";
  if (note.currentSchema) return "current-schema";
  return "review-required";
}

function queueEntry(note) {
  if (!/^[a-f0-9]{64}$/.test(note.rawSha256 ?? "")) {
    throw new SyncoraError(
      "READ001",
      `Authority inventory cannot bind an exact source hash: ${note.path}`,
    );
  }
  const allReasonCodes = [...new Set(note.diagnostics.map((item) => item.code))]
    .sort();
  const reasonCodes = allReasonCodes.slice(
    0,
    AUTHORITY_INVENTORY_POLICY.maxDiagnosticCodes,
  );
  return {
    source: {
      path: note.path,
      sha256: `sha256:${note.rawSha256}`,
      byteLength: note.byteLength,
    },
    classification: classification(note),
    schemaStatus: note.schemaStatus,
    authorityClass: note.authorityClass,
    reasonCodes,
    reasonCodeCount: allReasonCodes.length,
    omittedReasonCodes: Math.max(0, allReasonCodes.length - reasonCodes.length),
  };
}

function assertCompleteRead(inspection) {
  if ((inspection.report.summary.diagnostics.byCode.READ001 ?? 0) > 0) {
    throw new SyncoraError(
      "READ001",
      "Authority inventory cannot use an incomplete graph read.",
    );
  }
  for (const note of inspection.notes) {
    if (!/^[a-f0-9]{64}$/.test(note.rawSha256 ?? "")) {
      throw new SyncoraError(
        "READ001",
        `Authority inventory cannot bind an exact source hash: ${note.path}`,
      );
    }
  }
}

function cursorFor({
  graphRevision,
  policyRevision,
  rootIdentity,
  position,
  after,
  source,
}) {
  const cursor = encodeCursor({
    v: AUTHORITY_INVENTORY_POLICY.cursorVersion,
    spec: AUTHORITY_INVENTORY_POLICY.specification,
    revision: graphRevision,
    policy: policyRevision,
    root: rootIdentity,
    position,
    after,
    source,
  });
  if (cursor.length > AUTHORITY_INVENTORY_POLICY.maxCursorCharacters) {
    throw migrateError(
      "MIGRATE003",
      "Authority inventory cursor exceeds its bounded size.",
      { maxCursorCharacters: AUTHORITY_INVENTORY_POLICY.maxCursorCharacters },
    );
  }
  return cursor;
}

function resolveStart(queue, cursorToken, bindings) {
  if (!cursorToken) return 0;
  const cursor = decodeCursor(cursorToken);
  if (
    cursor.revision !== bindings.graphRevision ||
    cursor.policy !== bindings.policyRevision ||
    cursor.root !== bindings.rootIdentity
  ) {
    throw migrateError(
      "MIGRATE002",
      "Authority inventory cursor is stale or belongs to another graph or policy.",
      {
        restartRequired: true,
        graphRevision: bindings.graphRevision,
        policyRevision: bindings.policyRevision,
        rootIdentity: bindings.rootIdentity,
      },
    );
  }
  const entry = queue[cursor.position];
  if (
    !entry ||
    entry.source.path !== cursor.after ||
    entry.source.sha256 !== cursor.source
  ) {
    throw migrateError(
      "MIGRATE002",
      "Authority inventory cursor does not identify a source in this inventory.",
      { restartRequired: true },
    );
  }
  return cursor.position + 1;
}

export async function verifyAuthoritySnapshot(options, snapshot, hooks = {}) {
  const inspection = snapshot.inspection ?? snapshot;
  await hooks.beforeFinalInspection?.({ inspection });
  let verified;
  try {
    verified = await inspectWorkspace(options);
  } catch (error) {
    throw new SyncoraError(
      "READ001",
      "Graph could not be reverified before authority inventory publication.",
      {
        cause: error instanceof Error ? error.message : String(error),
        ...(error?.code ? { sourceCode: error.code } : {}),
      },
    );
  }
  assertCompleteRead(verified);
  if (
    !samePath(verified.graph.resolvedGraphPath, inspection.graph.resolvedGraphPath) ||
    verified.report.graph.revision !== inspection.report.graph.revision
  ) {
    throw new SyncoraError(
      "READ001",
      "Graph content or root identity changed during authority inventory.",
    );
  }
}

function count(queue, value) {
  return queue.reduce(
    (total, entry) => total + Number(entry.classification === value),
    0,
  );
}

function reportFor({
  inspection,
  queue,
  start,
  entries,
  limit,
  bindings,
  truncatedByBytes,
}) {
  const consumed = start + entries.length;
  const omittedAfter = Math.max(0, queue.length - consumed);
  const nextCursor = omittedAfter > 0 && entries.length > 0
    ? cursorFor({
        graphRevision: bindings.graphRevision,
        policyRevision: bindings.policyRevision,
        rootIdentity: bindings.rootIdentity,
        position: consumed - 1,
        after: entries.at(-1).source.path,
        source: entries.at(-1).source.sha256,
      })
    : null;
  const currentSchema = count(queue, "current-schema");
  const reviewRequired = count(queue, "review-required");
  const blocked = count(queue, "blocked");
  const validation = inspection.report.summary;

  return {
    reportSchemaVersion: 1,
    ok: true,
    command: "migrate",
    phase: "authority",
    mode: "read-only-inventory",
    dryRun: true,
    workspace: inspection.workspace.realPath,
    graph: inspection.report.graph,
    planner: {
      specification: AUTHORITY_INVENTORY_POLICY.specification,
      validationSpecification: VALIDATION_SPECIFICATION,
      policyRevision: bindings.policyRevision,
      rootIdentity: bindings.rootIdentity,
      selectionAuthority: "none",
      sourceMutation: "none",
      ordering: "portable-path-ascending",
      approvedManifest: false,
      manifestAcceptance: "reviewed-v2-stage-gated",
      promotionOperations: 0,
      maxReportBytes: AUTHORITY_INVENTORY_POLICY.maxReportBytes,
    },
    summary: {
      graphValid: validation.valid,
      inventoryComplete: true,
      reviewQueueEmpty:
        reviewRequired === 0 &&
        blocked === 0 &&
        validation.files.skipped === 0,
      promotionReady: false,
      discovered: queue.length,
      currentSchema,
      reviewRequired,
      blocked,
      skippedPaths: validation.files.skipped,
      validationErrors: validation.diagnostics.error,
      validationWarnings: validation.diagnostics.warning,
    },
    page: {
      requestedLimit: limit,
      returned: entries.length,
      omittedBefore: start,
      omittedAfter,
      complete: start === 0 && omittedAfter === 0,
      endReached: omittedAfter === 0,
      truncatedByBytes,
      nextCursor,
    },
    queue: entries,
  };
}

function serializedBytes(report) {
  return Buffer.byteLength(`${stringifyJson(report)}\n`, "utf8");
}

export async function inspectAuthoritySnapshot(options) {
  const inspection = await inspectWorkspace(options);
  assertCompleteRead(inspection);

  const queue = inspection.notes.map(queueEntry);
  const bindings = {
    graphRevision: inspection.report.graph.revision,
    policyRevision: authorityPolicyRevision(),
    rootIdentity: authorityRootIdentity(inspection.graph.resolvedGraphPath),
  };
  return { inspection, queue, bindings };
}

export async function inventoryAuthority(options, hooks = {}) {
  const snapshot = await inspectAuthoritySnapshot(options);
  const { inspection, queue, bindings } = snapshot;
  const start = resolveStart(queue, options.cursor, bindings);

  const available = queue.slice(start, start + options.limit);
  const entries = [];
  let truncatedByBytes = false;
  for (const entry of available) {
    const trialEntries = [...entries, entry];
    const trial = reportFor({
      inspection,
      queue,
      start,
      entries: trialEntries,
      limit: options.limit,
      bindings,
      truncatedByBytes: false,
    });
    if (serializedBytes(trial) > AUTHORITY_INVENTORY_POLICY.maxReportBytes) {
      truncatedByBytes = true;
      break;
    }
    entries.push(entry);
  }

  if (entries.length === 0 && start < queue.length) {
    throw migrateError(
      "MIGRATE003",
      "One authority inventory row exceeds the bounded report size.",
      { maxReportBytes: AUTHORITY_INVENTORY_POLICY.maxReportBytes },
    );
  }

  const report = reportFor({
    inspection,
    queue,
    start,
    entries,
    limit: options.limit,
    bindings,
    truncatedByBytes,
  });
  if (serializedBytes(report) > AUTHORITY_INVENTORY_POLICY.maxReportBytes) {
    throw migrateError(
      "MIGRATE003",
      "Authority inventory report exceeds its bounded output size.",
      { maxReportBytes: AUTHORITY_INVENTORY_POLICY.maxReportBytes },
    );
  }
  await verifyAuthoritySnapshot(options, snapshot, hooks);
  return report;
}
