import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { SyncoraError } from "./cli.mjs";
import {
  IMMUTABLE_FILE_POLICY,
  immutableSha256,
  publishImmutableFile,
  readImmutableFile,
} from "./immutable-file.mjs";
import {
  PROPOSAL_POLICY,
  PROPOSAL_SCHEMA_VERSION,
  assertPortableGraphPath,
  assertProposalId,
  assertTaggedSha256,
  canonicalProposalJson,
  computeProposalIntent,
  parseSealedProposalBytes,
  sealProposal,
  serializeProposal,
  summarizeProposal,
} from "./proposal-schema.mjs";
import { createStableDirectoryGuard } from "./stable-directory.mjs";
import { samePath } from "./workspace.mjs";

export const PROPOSAL_STORE_POLICY = Object.freeze({
  maximumRecordBytes: 1_048_576,
  maximumBlobBytes: IMMUTABLE_FILE_POLICY.maximumBytes,
  maximumListedReviews: 4_096,
  maximumReviewReasonCharacters: 2_000,
  maximumSummaryCharacters: 2_000,
  maximumRecordChanges: 256,
  maximumMismatches: 256,
  maximumListedOperations: 4_096,
  maximumCorrectionLineageDepth: 256,
});

const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const REVIEW_ID_PATTERN = /^review_[0-9a-f]{64}$/u;
const CONFLICT_ID_PATTERN = /^conflict_[0-9a-f]{64}$/u;
const RECEIPT_ID_PATTERN = /^receipt_[0-9a-f]{64}$/u;
const BLOB_ID_PATTERN = /^blob_[0-9a-f]{64}$/u;
const IDEMPOTENCY_BINDING_ID_PATTERN = /^idempotency_[0-9a-f]{64}$/u;
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u;

function storeError(code, message, details = undefined) {
  return new SyncoraError(code, message, details);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected, label, code = "PROPOSAL001") {
  if (!isPlainObject(value)) {
    throw storeError(code, `${label} must be a JSON object.`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    !actual.every((key, index) => key === wanted[index])
  ) {
    throw storeError(code, `${label} contains missing or unknown fields.`);
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

function boundedString(value, label, maximum, { pattern = undefined } = {}) {
  if (
    typeof value !== "string" ||
    !hasValidUnicode(value) ||
    [...value].length < 1 ||
    [...value].length > maximum ||
    /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value) ||
    (pattern && !pattern.test(value))
  ) {
    throw storeError("PROPOSAL001", `${label} is invalid or exceeds its bound.`);
  }
  return value;
}

function createdAt(value = new Date().toISOString()) {
  if (typeof value !== "string" || value.length > 40) {
    throw storeError("PROPOSAL001", "Record createdAt must be a canonical ISO-8601 timestamp.");
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw storeError("PROPOSAL001", "Record createdAt must be a canonical ISO-8601 timestamp.");
  }
  return value;
}

function semanticDigest(domain, value) {
  return `sha256:${createHash("sha256")
    .update(`${domain}\n`, "utf8")
    .update(canonicalProposalJson(value), "utf8")
    .digest("hex")}`;
}

function contentId(prefix, digest) {
  return `${prefix}_${digest.slice("sha256:".length)}`;
}

function parseJson(bytes, label, code = "PROPOSAL001") {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw storeError(code, `${label} is not valid UTF-8.`);
  }
  if (text.startsWith("\ufeff")) text = text.slice(1);
  try {
    return JSON.parse(text);
  } catch {
    throw storeError(code, `${label} is not valid JSON.`);
  }
}

function serializeJson(value, label) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  if (bytes.length > PROPOSAL_STORE_POLICY.maximumRecordBytes) {
    throw storeError("PROPOSAL001", `${label} exceeds the immutable record byte limit.`, {
      bytes: bytes.length,
      limit: PROPOSAL_STORE_POLICY.maximumRecordBytes,
    });
  }
  return bytes;
}

export function proposalStorePaths(graphRoot) {
  if (typeof graphRoot !== "string" || !isAbsolute(graphRoot)) {
    throw storeError("PROPOSAL004", "Proposal graph root must be an absolute path.");
  }
  const normalized = resolve(graphRoot);
  return Object.freeze({
    graphRoot: normalized,
    syncoraRoot: join(normalized, ".syncora"),
    proposals: join(normalized, ".syncora", "proposals"),
    reviews: join(normalized, ".syncora", "reviews"),
    operations: join(normalized, ".syncora", "operations"),
    transactions: join(normalized, ".syncora", "transactions"),
    blobs: join(normalized, ".syncora", "blobs"),
    reviewArtifacts: join(normalized, ".syncora", "review-artifacts"),
    reviewArtifactBlobs: join(normalized, ".syncora", "review-artifacts", "artifacts"),
    reviewArtifactBindings: join(normalized, ".syncora", "review-artifacts", "bindings"),
  });
}

async function requireSafeGraphRoot(graphRoot) {
  const paths = proposalStorePaths(graphRoot);
  let metadata;
  try {
    metadata = await lstat(paths.graphRoot);
  } catch (error) {
    throw storeError("PROPOSAL004", "Proposal graph root could not be inspected.", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw storeError("PROPOSAL004", "Proposal graph root is not a safe ordinary directory.");
  }
  const resolved = await realpath(paths.graphRoot).catch((error) => {
    throw storeError("PROPOSAL004", "Proposal graph root could not be resolved.", {
      cause: error instanceof Error ? error.message : String(error),
    });
  });
  if (!samePath(resolved, paths.graphRoot)) {
    throw storeError("PROPOSAL004", "Proposal graph root resolves through an unsafe alias.");
  }
  return paths;
}

export async function prepareProposalStore(graphRoot) {
  const paths = await requireSafeGraphRoot(graphRoot);
  for (const target of [
    paths.proposals,
    paths.reviews,
    paths.operations,
    paths.transactions,
    paths.blobs,
    paths.reviewArtifactBlobs,
    paths.reviewArtifactBindings,
  ]) {
    const guard = createStableDirectoryGuard(paths.graphRoot, target, {
      code: "PROPOSAL004",
      label: "Graph-scoped proposal store",
    });
    await guard.prepare();
  }
  return paths;
}

async function prepareProposalRecordDirectory(paths, root, proposalId, label) {
  const id = assertProposalId(proposalId);
  const directory = join(root, id);
  const guard = createStableDirectoryGuard(paths.graphRoot, directory, {
    code: "PROPOSAL004",
    label,
  });
  await guard.prepare();
  return directory;
}

async function readProposalAt(paths, proposalId) {
  const path = join(paths.proposals, `${assertProposalId(proposalId)}.json`);
  const loaded = await readImmutableFile({
    root: paths.graphRoot,
    path,
    maximumBytes: PROPOSAL_POLICY.maximumStoredBytes,
    code: "PROPOSAL001",
    label: "Immutable proposal",
  });
  return loaded === null ? null : parseSealedProposalBytes(loaded.bytes);
}

async function requireStoredProposalDigest(paths, proposalId, proposalDigest, label) {
  const proposal = await readProposalAt(paths, proposalId);
  if (proposal === null) {
    throw storeError("PROPOSAL003", `${label} requires an existing immutable proposal.`);
  }
  if (proposal.proposalDigest !== proposalDigest) {
    throw storeError("PROPOSAL003", `${label} does not bind the stored proposal digest.`, {
      proposalId,
      expectedProposalDigest: proposal.proposalDigest,
      suppliedProposalDigest: proposalDigest,
    });
  }
  return proposal;
}

function parseIdempotencyBinding(value) {
  exactKeys(value, [
    "schemaVersion",
    "kind",
    "bindingId",
    "keyDigest",
    "bindingDigest",
    "idempotencyKey",
    "proposalId",
    "intentDigest",
  ], "Proposal idempotency binding");
  if (
    value.schemaVersion !== PROPOSAL_SCHEMA_VERSION ||
    value.kind !== "syncora.proposal-idempotency-binding"
  ) {
    throw storeError(
      "PROPOSAL001",
      "Proposal idempotency binding schemaVersion or kind is unsupported.",
    );
  }
  const idempotencyKey = boundedString(
    value.idempotencyKey,
    "Proposal idempotency key",
    200,
    { pattern: SAFE_IDENTIFIER_PATTERN },
  );
  const keyDocument = {
    schemaVersion: PROPOSAL_SCHEMA_VERSION,
    kind: "syncora.proposal-idempotency-key",
    idempotencyKey,
  };
  const keyDigest = semanticDigest("syncora-proposal-idempotency-key-v1", keyDocument);
  const bindingId = parseRecordId(
    value.bindingId,
    IDEMPOTENCY_BINDING_ID_PATTERN,
    "Idempotency binding ID",
  );
  if (
    value.keyDigest !== keyDigest ||
    bindingId !== contentId("idempotency", keyDigest)
  ) {
    throw storeError("PROPOSAL001", "Proposal idempotency key identity is invalid.");
  }
  const withoutDigest = {
    schemaVersion: PROPOSAL_SCHEMA_VERSION,
    kind: "syncora.proposal-idempotency-binding",
    bindingId,
    keyDigest,
    idempotencyKey,
    proposalId: assertProposalId(value.proposalId),
    intentDigest: assertTaggedSha256(value.intentDigest, "Bound proposal intent digest"),
  };
  const bindingDigest = semanticDigest(
    "syncora-proposal-idempotency-binding-v1",
    withoutDigest,
  );
  if (value.bindingDigest !== bindingDigest) {
    throw storeError("PROPOSAL001", "Proposal idempotency binding digest is invalid.");
  }
  return Object.freeze({ ...withoutDigest, bindingDigest });
}

function createIdempotencyBinding(proposal) {
  const idempotencyKey = boundedString(
    proposal.idempotencyKey,
    "Proposal idempotency key",
    200,
    { pattern: SAFE_IDENTIFIER_PATTERN },
  );
  const keyDigest = semanticDigest("syncora-proposal-idempotency-key-v1", {
    schemaVersion: PROPOSAL_SCHEMA_VERSION,
    kind: "syncora.proposal-idempotency-key",
    idempotencyKey,
  });
  const withoutDigest = {
    schemaVersion: PROPOSAL_SCHEMA_VERSION,
    kind: "syncora.proposal-idempotency-binding",
    bindingId: contentId("idempotency", keyDigest),
    keyDigest,
    idempotencyKey,
    proposalId: proposal.proposalId,
    intentDigest: proposal.intentDigest,
  };
  return parseIdempotencyBinding({
    ...withoutDigest,
    bindingDigest: semanticDigest(
      "syncora-proposal-idempotency-binding-v1",
      withoutDigest,
    ),
  });
}

async function bindIdempotencyKey(paths, proposal, hooks = {}) {
  const binding = createIdempotencyBinding(proposal);
  const path = join(paths.proposals, `${binding.bindingId}.json`);
  const read = async () => {
    const loaded = await readImmutableFile({
      root: paths.graphRoot,
      path,
      maximumBytes: PROPOSAL_STORE_POLICY.maximumRecordBytes,
      code: "PROPOSAL001",
      label: "Proposal idempotency binding",
    });
    return loaded === null
      ? null
      : parseIdempotencyBinding(parseJson(loaded.bytes, "Proposal idempotency binding"));
  };
  const existing = await read();
  if (existing !== null) {
    if (
      existing.intentDigest !== binding.intentDigest ||
      existing.proposalId !== binding.proposalId
    ) {
      throw storeError(
        "PROPOSAL002",
        "Proposal idempotency key is already bound to a different intent.",
        { idempotencyKey: binding.idempotencyKey },
      );
    }
    return existing;
  }
  try {
    await publishImmutableFile({
      root: paths.graphRoot,
      path,
      bytes: serializeJson(binding, "Proposal idempotency binding"),
      maximumBytes: PROPOSAL_STORE_POLICY.maximumRecordBytes,
      code: "PROPOSAL004",
      collisionCode: "PROPOSAL002",
      label: "Proposal idempotency binding",
    }, hooks);
  } catch (error) {
    if (error?.code !== "PROPOSAL002") throw error;
    const raced = await read();
    if (
      raced !== null &&
      raced.intentDigest === binding.intentDigest &&
      raced.proposalId === binding.proposalId
    ) {
      return raced;
    }
    throw storeError(
      "PROPOSAL002",
      "Proposal idempotency key publication collided with a different intent.",
      { idempotencyKey: binding.idempotencyKey },
    );
  }
  const stored = await read();
  if (
    stored === null ||
    stored.intentDigest !== binding.intentDigest ||
    stored.proposalId !== binding.proposalId
  ) {
    throw storeError("PROPOSAL004", "Proposal idempotency binding could not be verified.");
  }
  return stored;
}

export async function readStoredProposal({ graphRoot, proposalId }) {
  const paths = await prepareProposalStore(graphRoot);
  return readProposalAt(paths, proposalId);
}

export async function readProposalSummary(options) {
  const proposal = await readStoredProposal(options);
  return proposal === null ? null : summarizeProposal(proposal);
}

async function publishSealedAt(paths, proposal, hooks) {
  const path = join(paths.proposals, `${proposal.proposalId}.json`);
  const bytes = serializeProposal(proposal);
  try {
    return await publishImmutableFile({
      root: paths.graphRoot,
      path,
      bytes,
      maximumBytes: PROPOSAL_POLICY.maximumStoredBytes,
      code: "PROPOSAL004",
      collisionCode: "PROPOSAL002",
      label: "Immutable proposal",
    }, hooks);
  } catch (error) {
    if (error?.code !== "PROPOSAL002") throw error;
    const existing = await readProposalAt(paths, proposal.proposalId);
    if (existing !== null && existing.intentDigest === proposal.intentDigest) {
      return Object.freeze({
        created: false,
        idempotent: true,
        path,
        byteLength: serializeProposal(existing).length,
        sha256: immutableSha256(serializeProposal(existing)),
      });
    }
    throw error;
  }
}

export async function publishSealedProposal({ graphRoot, proposal }, hooks = {}) {
  const parsedBytes = serializeProposal(proposal);
  const parsed = parseSealedProposalBytes(parsedBytes);
  const paths = await prepareProposalStore(graphRoot);
  await assertCorrectionLineage({ graphRoot, proposal: parsed, paths });
  await bindIdempotencyKey(paths, parsed, hooks);
  const existing = await readProposalAt(paths, parsed.proposalId);
  if (existing !== null) {
    if (existing.intentDigest !== parsed.intentDigest) {
      throw storeError("PROPOSAL002", "Proposal ID collides with a different immutable intent.");
    }
    return Object.freeze({
      created: false,
      idempotent: true,
      proposal: summarizeProposal(existing),
    });
  }
  const publication = await publishSealedAt(paths, parsed, hooks);
  const stored = await readProposalAt(paths, parsed.proposalId);
  if (stored === null || stored.intentDigest !== parsed.intentDigest) {
    throw storeError("PROPOSAL004", "Published proposal could not be verified.");
  }
  return Object.freeze({
    created: publication.created,
    idempotent: publication.idempotent,
    proposal: summarizeProposal(stored),
  });
}

export async function publishProposal({
  graphRoot,
  input,
  bindings,
  assessment,
  createdAt: timestamp = undefined,
}, hooks = {}) {
  const intent = computeProposalIntent(input, bindings, assessment);
  const proposal = sealProposal(input, bindings, {
    assessment,
    ...(timestamp === undefined ? {} : { createdAt: timestamp }),
  });
  // Validate the complete sealed-size contract before reserving the key.
  serializeProposal(proposal);
  const paths = await prepareProposalStore(graphRoot);
  await assertCorrectionLineage({ graphRoot, proposal, paths });
  await bindIdempotencyKey(paths, proposal, hooks);
  const existing = await readProposalAt(paths, intent.proposalId);
  if (existing !== null) {
    if (existing.intentDigest !== intent.intentDigest) {
      throw storeError("PROPOSAL002", "Proposal ID collides with a different immutable intent.");
    }
    return Object.freeze({
      created: false,
      idempotent: true,
      proposal: summarizeProposal(existing),
    });
  }
  const publication = await publishSealedAt(paths, proposal, hooks);
  const stored = await readProposalAt(paths, proposal.proposalId);
  if (stored === null || stored.intentDigest !== proposal.intentDigest) {
    throw storeError("PROPOSAL004", "Published proposal could not be verified.");
  }
  return Object.freeze({
    created: publication.created,
    idempotent: publication.idempotent,
    proposal: summarizeProposal(stored),
  });
}

function parseRecordId(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw storeError("PROPOSAL001", `${label} is not content-derived.`);
  }
  return value;
}

function sealDerivedRecord({
  kind,
  idName,
  idPrefix,
  intentDigestName,
  recordDigestName,
  intentDomain,
  recordDomain,
  semantic,
  timestamp,
}) {
  const intentDigest = semanticDigest(intentDomain, semantic);
  const withoutDigest = {
    ...semantic,
    [idName]: contentId(idPrefix, intentDigest),
    [intentDigestName]: intentDigest,
    createdAt: createdAt(timestamp),
  };
  const recordDigest = semanticDigest(recordDomain, withoutDigest);
  return Object.freeze({ ...withoutDigest, [recordDigestName]: recordDigest, kind });
}

async function publishDerived({
  paths,
  directory,
  fileName,
  record,
  parse,
  intentDigestName,
  collisionCode,
  label,
  hooks,
  maximumEntries,
}) {
  const path = join(directory, fileName);
  const bytes = serializeJson(record, label);
  const read = async () => {
    const loaded = await readImmutableFile({
      root: paths.graphRoot,
      path,
      maximumBytes: PROPOSAL_STORE_POLICY.maximumRecordBytes,
      code: "PROPOSAL001",
      label,
    });
    return loaded === null ? null : parse(parseJson(loaded.bytes, label));
  };
  const existing = await read();
  if (existing !== null) {
    if (existing[intentDigestName] !== record[intentDigestName]) {
      throw storeError(collisionCode, `${label} content-derived ID collided.`);
    }
    return Object.freeze({ created: false, idempotent: true, record: existing });
  }
  if (maximumEntries !== undefined) {
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.length >= maximumEntries) {
      throw storeError(
        "PROPOSAL004",
        `${label} shard exceeds its safe record bound.`,
        { limit: maximumEntries },
      );
    }
  }
  try {
    const result = await publishImmutableFile({
      root: paths.graphRoot,
      path,
      bytes,
      maximumBytes: PROPOSAL_STORE_POLICY.maximumRecordBytes,
      code: "PROPOSAL004",
      collisionCode,
      label,
    }, hooks);
    const stored = await read();
    if (stored === null || stored[intentDigestName] !== record[intentDigestName]) {
      throw storeError("PROPOSAL004", `${label} could not be verified after publication.`);
    }
    return Object.freeze({ created: result.created, idempotent: result.idempotent, record: stored });
  } catch (error) {
    if (error?.code !== collisionCode) throw error;
    const raced = await read();
    if (raced !== null && raced[intentDigestName] === record[intentDigestName]) {
      return Object.freeze({ created: false, idempotent: true, record: raced });
    }
    throw error;
  }
}

function parseReviewRecord(value) {
  exactKeys(value, [
    "schemaVersion", "kind", "reviewId", "reviewIntentDigest", "reviewDigest",
    "createdAt", "proposalId", "proposalDigest", "decision", "reviewedBy", "reason",
  ], "Proposal review");
  if (value.schemaVersion !== PROPOSAL_SCHEMA_VERSION || value.kind !== "syncora.proposal-review") {
    throw storeError("PROPOSAL001", "Proposal review schemaVersion or kind is unsupported.");
  }
  const semantic = {
    schemaVersion: PROPOSAL_SCHEMA_VERSION,
    kind: "syncora.proposal-review",
    proposalId: assertProposalId(value.proposalId),
    proposalDigest: assertTaggedSha256(value.proposalDigest, "Reviewed proposal digest"),
    decision: new Set(["approve", "reject"]).has(value.decision)
      ? value.decision
      : (() => { throw storeError("PROPOSAL001", "Review decision must be approve or reject."); })(),
    reviewedBy: boundedString(value.reviewedBy, "Reviewer attribution", 200),
    reason: boundedString(value.reason, "Review reason", PROPOSAL_STORE_POLICY.maximumReviewReasonCharacters),
  };
  const reviewIntentDigest = semanticDigest("syncora-proposal-review-intent-v1", semantic);
  const reviewId = parseRecordId(value.reviewId, REVIEW_ID_PATTERN, "Review ID");
  if (reviewId !== contentId("review", reviewIntentDigest) || value.reviewIntentDigest !== reviewIntentDigest) {
    throw storeError("PROPOSAL001", "Proposal review identity does not match its contents.");
  }
  const withoutDigest = {
    ...semantic,
    reviewId,
    reviewIntentDigest,
    createdAt: createdAt(value.createdAt),
  };
  const reviewDigest = semanticDigest("syncora-proposal-review-record-v1", withoutDigest);
  if (value.reviewDigest !== reviewDigest) {
    throw storeError("PROPOSAL001", "Proposal review digest does not match its contents.");
  }
  return Object.freeze({ ...withoutDigest, reviewDigest });
}

export async function publishReviewRecord({
  graphRoot,
  proposalId,
  proposalDigest,
  decision,
  reviewedBy,
  reason,
  createdAt: timestamp = undefined,
}, hooks = {}) {
  const semantic = parseReviewRecord(sealDerivedRecord({
    kind: "syncora.proposal-review",
    idName: "reviewId",
    idPrefix: "review",
    intentDigestName: "reviewIntentDigest",
    recordDigestName: "reviewDigest",
    intentDomain: "syncora-proposal-review-intent-v1",
    recordDomain: "syncora-proposal-review-record-v1",
    semantic: {
      schemaVersion: PROPOSAL_SCHEMA_VERSION,
      kind: "syncora.proposal-review",
      proposalId: assertProposalId(proposalId),
      proposalDigest: assertTaggedSha256(proposalDigest, "Reviewed proposal digest"),
      decision,
      reviewedBy,
      reason,
    },
    timestamp,
  }));
  const paths = await prepareProposalStore(graphRoot);
  await requireStoredProposalDigest(
    paths,
    semantic.proposalId,
    semantic.proposalDigest,
    "Proposal review",
  );
  const directory = await prepareProposalRecordDirectory(
    paths,
    paths.reviews,
    semantic.proposalId,
    "Proposal review shard",
  );
  const result = await publishDerived({
    paths,
    directory,
    fileName: `${semantic.reviewId}.json`,
    record: semantic,
    parse: parseReviewRecord,
    intentDigestName: "reviewIntentDigest",
    collisionCode: "REVIEW002",
    label: "Immutable proposal review",
    hooks,
    maximumEntries: PROPOSAL_STORE_POLICY.maximumListedReviews,
  });
  return Object.freeze({ created: result.created, idempotent: result.idempotent, review: result.record });
}

export async function listReviewRecords({ graphRoot, proposalId }) {
  const id = assertProposalId(proposalId);
  const paths = await prepareProposalStore(graphRoot);
  const directory = await prepareProposalRecordDirectory(
    paths,
    paths.reviews,
    id,
    "Proposal review shard",
  );
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length > PROPOSAL_STORE_POLICY.maximumListedReviews) {
    throw storeError("PROPOSAL004", "Proposal review directory exceeds its safe listing bound.");
  }
  const names = entries
    .filter((entry) => entry.name.startsWith("review_") && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
  const reviews = [];
  for (const name of names) {
    const loaded = await readImmutableFile({
      root: paths.graphRoot,
      path: join(directory, name),
      maximumBytes: PROPOSAL_STORE_POLICY.maximumRecordBytes,
      code: "PROPOSAL001",
      label: "Immutable proposal review",
    });
    if (loaded === null) continue;
    const review = parseReviewRecord(parseJson(loaded.bytes, "Proposal review"));
    if (review.proposalId !== id) {
      throw storeError("PROPOSAL001", "Proposal review shard binding is invalid.");
    }
    reviews.push(review);
  }
  reviews.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.reviewId.localeCompare(right.reviewId));
  return Object.freeze(reviews);
}

function parseMismatch(value, index) {
  const label = `Conflict mismatch ${index + 1}`;
  exactKeys(value, ["path", "expectedSha256", "currentSha256"], label);
  const nullableHash = (entry, hashLabel) => entry === null
    ? null
    : assertTaggedSha256(entry, hashLabel);
  return {
    path: assertPortableGraphPath(value.path, `${label} path`),
    expectedSha256: nullableHash(value.expectedSha256, `${label} expectedSha256`),
    currentSha256: nullableHash(value.currentSha256, `${label} currentSha256`),
  };
}

function parseConflictRecord(value) {
  exactKeys(value, [
    "schemaVersion", "kind", "conflictId", "conflictIntentDigest", "conflictDigest",
    "createdAt", "proposalId", "proposalDigest", "code", "summary", "mismatches",
  ], "Proposal conflict");
  if (value.schemaVersion !== PROPOSAL_SCHEMA_VERSION || value.kind !== "syncora.proposal-conflict") {
    throw storeError("PROPOSAL001", "Proposal conflict schemaVersion or kind is unsupported.");
  }
  if (!Array.isArray(value.mismatches) || value.mismatches.length > PROPOSAL_STORE_POLICY.maximumMismatches) {
    throw storeError("PROPOSAL001", "Proposal conflict mismatch list is excessive.");
  }
  const semantic = {
    schemaVersion: PROPOSAL_SCHEMA_VERSION,
    kind: "syncora.proposal-conflict",
    proposalId: assertProposalId(value.proposalId),
    proposalDigest: assertTaggedSha256(value.proposalDigest, "Conflicted proposal digest"),
    code: boundedString(value.code, "Conflict code", 64, { pattern: /^[A-Z][A-Z0-9_]*$/u }),
    summary: boundedString(value.summary, "Conflict summary", PROPOSAL_STORE_POLICY.maximumSummaryCharacters),
    mismatches: value.mismatches.map(parseMismatch),
  };
  const conflictIntentDigest = semanticDigest("syncora-proposal-conflict-intent-v1", semantic);
  const conflictId = parseRecordId(value.conflictId, CONFLICT_ID_PATTERN, "Conflict ID");
  if (conflictId !== contentId("conflict", conflictIntentDigest) || value.conflictIntentDigest !== conflictIntentDigest) {
    throw storeError("PROPOSAL001", "Proposal conflict identity does not match its contents.");
  }
  const withoutDigest = { ...semantic, conflictId, conflictIntentDigest, createdAt: createdAt(value.createdAt) };
  const conflictDigest = semanticDigest("syncora-proposal-conflict-record-v1", withoutDigest);
  if (value.conflictDigest !== conflictDigest) {
    throw storeError("PROPOSAL001", "Proposal conflict digest does not match its contents.");
  }
  return Object.freeze({ ...withoutDigest, conflictDigest });
}

export async function publishConflictRecord({
  graphRoot, proposalId, proposalDigest, code, summary, mismatches = [], createdAt: timestamp = undefined,
}, hooks = {}) {
  const record = parseConflictRecord(sealDerivedRecord({
    kind: "syncora.proposal-conflict",
    idName: "conflictId",
    idPrefix: "conflict",
    intentDigestName: "conflictIntentDigest",
    recordDigestName: "conflictDigest",
    intentDomain: "syncora-proposal-conflict-intent-v1",
    recordDomain: "syncora-proposal-conflict-record-v1",
    semantic: {
      schemaVersion: PROPOSAL_SCHEMA_VERSION,
      kind: "syncora.proposal-conflict",
      proposalId: assertProposalId(proposalId),
      proposalDigest: assertTaggedSha256(proposalDigest, "Conflicted proposal digest"),
      code,
      summary,
      mismatches,
    },
    timestamp,
  }));
  const paths = await prepareProposalStore(graphRoot);
  await requireStoredProposalDigest(
    paths,
    record.proposalId,
    record.proposalDigest,
    "Proposal conflict",
  );
  const directory = await prepareProposalRecordDirectory(
    paths,
    paths.operations,
    record.proposalId,
    "Proposal operation shard",
  );
  const result = await publishDerived({
    paths,
    directory,
    fileName: `${record.conflictId}.json`,
    record,
    parse: parseConflictRecord,
    intentDigestName: "conflictIntentDigest",
    collisionCode: "CONFLICT002",
    label: "Immutable proposal conflict",
    hooks,
    maximumEntries: PROPOSAL_STORE_POLICY.maximumListedOperations,
  });
  return Object.freeze({ created: result.created, idempotent: result.idempotent, conflict: result.record });
}

function nullableHash(value, label) {
  return value === null ? null : assertTaggedSha256(value, label);
}

function parseReceiptChange(value, index) {
  const label = `Receipt change ${index + 1}`;
  exactKeys(value, ["path", "beforeSha256", "afterSha256"], label);
  return {
    path: assertPortableGraphPath(value.path, `${label} path`),
    beforeSha256: nullableHash(value.beforeSha256, `${label} beforeSha256`),
    afterSha256: nullableHash(value.afterSha256, `${label} afterSha256`),
  };
}

function parseReceiptRecord(value) {
  exactKeys(value, [
    "schemaVersion", "kind", "receiptId", "receiptIntentDigest", "receiptDigest",
    "createdAt", "proposalId", "proposalDigest", "transactionId", "outcome",
    "graphRevisionBefore", "graphRevisionAfter", "changes",
  ], "Proposal receipt");
  if (value.schemaVersion !== PROPOSAL_SCHEMA_VERSION || value.kind !== "syncora.proposal-receipt") {
    throw storeError("PROPOSAL001", "Proposal receipt schemaVersion or kind is unsupported.");
  }
  if (!Array.isArray(value.changes) || value.changes.length > PROPOSAL_STORE_POLICY.maximumRecordChanges) {
    throw storeError("PROPOSAL001", "Proposal receipt change list is excessive.");
  }
  const outcomes = new Set(["applied", "rolled-back", "failed", "recovery-required"]);
  const semantic = {
    schemaVersion: PROPOSAL_SCHEMA_VERSION,
    kind: "syncora.proposal-receipt",
    proposalId: assertProposalId(value.proposalId),
    proposalDigest: assertTaggedSha256(value.proposalDigest, "Receipt proposal digest"),
    transactionId: boundedString(value.transactionId, "Transaction ID", 200, { pattern: SAFE_IDENTIFIER_PATTERN }),
    outcome: outcomes.has(value.outcome)
      ? value.outcome
      : (() => { throw storeError("PROPOSAL001", "Receipt outcome is unsupported."); })(),
    graphRevisionBefore: assertTaggedSha256(value.graphRevisionBefore, "Receipt prior graph revision"),
    graphRevisionAfter: nullableHash(value.graphRevisionAfter, "Receipt resulting graph revision"),
    changes: value.changes.map(parseReceiptChange),
  };
  const receiptIntentDigest = semanticDigest("syncora-proposal-receipt-intent-v1", semantic);
  const receiptId = parseRecordId(value.receiptId, RECEIPT_ID_PATTERN, "Receipt ID");
  if (receiptId !== contentId("receipt", receiptIntentDigest) || value.receiptIntentDigest !== receiptIntentDigest) {
    throw storeError("PROPOSAL001", "Proposal receipt identity does not match its contents.");
  }
  const withoutDigest = { ...semantic, receiptId, receiptIntentDigest, createdAt: createdAt(value.createdAt) };
  const receiptDigest = semanticDigest("syncora-proposal-receipt-record-v1", withoutDigest);
  if (value.receiptDigest !== receiptDigest) {
    throw storeError("PROPOSAL001", "Proposal receipt digest does not match its contents.");
  }
  return Object.freeze({ ...withoutDigest, receiptDigest });
}

export function sealReceiptRecord({
  proposalId,
  proposalDigest,
  transactionId,
  outcome,
  graphRevisionBefore,
  graphRevisionAfter,
  changes = [],
  createdAt: timestamp,
}) {
  if (timestamp === undefined) {
    throw storeError(
      "PROPOSAL001",
      "Precomputed receipt sealing requires a stable createdAt timestamp.",
    );
  }
  return parseReceiptRecord(sealDerivedRecord({
    kind: "syncora.proposal-receipt",
    idName: "receiptId",
    idPrefix: "receipt",
    intentDigestName: "receiptIntentDigest",
    recordDigestName: "receiptDigest",
    intentDomain: "syncora-proposal-receipt-intent-v1",
    recordDomain: "syncora-proposal-receipt-record-v1",
    semantic: {
      schemaVersion: PROPOSAL_SCHEMA_VERSION,
      kind: "syncora.proposal-receipt",
      proposalId: assertProposalId(proposalId),
      proposalDigest: assertTaggedSha256(proposalDigest, "Receipt proposal digest"),
      transactionId,
      outcome,
      graphRevisionBefore,
      graphRevisionAfter,
      changes,
    },
    timestamp,
  }));
}

export async function publishExactReceiptRecord({ graphRoot, receipt }, hooks = {}) {
  const record = parseReceiptRecord(receipt);
  const paths = await prepareProposalStore(graphRoot);
  await requireStoredProposalDigest(
    paths,
    record.proposalId,
    record.proposalDigest,
    "Proposal receipt",
  );
  const directory = await prepareProposalRecordDirectory(
    paths,
    paths.operations,
    record.proposalId,
    "Proposal operation shard",
  );
  const result = await publishDerived({
    paths,
    directory,
    fileName: `${record.receiptId}.json`,
    record,
    parse: parseReceiptRecord,
    intentDigestName: "receiptIntentDigest",
    collisionCode: "RECEIPT002",
    label: "Immutable proposal receipt",
    hooks,
    maximumEntries: PROPOSAL_STORE_POLICY.maximumListedOperations,
  });
  return Object.freeze({ created: result.created, idempotent: result.idempotent, receipt: result.record });
}

export async function publishReceiptRecord({
  graphRoot, proposalId, proposalDigest, transactionId, outcome,
  graphRevisionBefore, graphRevisionAfter, changes = [], createdAt: timestamp = undefined,
}, hooks = {}) {
  const receipt = sealReceiptRecord({
    proposalId,
    proposalDigest,
    transactionId,
    outcome,
    graphRevisionBefore,
    graphRevisionAfter,
    changes,
    createdAt: timestamp ?? new Date().toISOString(),
  });
  return publishExactReceiptRecord({ graphRoot, receipt }, hooks);
}

async function listOperationRecords({
  graphRoot,
  proposalId,
  recordPrefix,
  label,
  parse,
}) {
  const id = assertProposalId(proposalId);
  const paths = await prepareProposalStore(graphRoot);
  const directory = await prepareProposalRecordDirectory(
    paths,
    paths.operations,
    id,
    "Proposal operation shard",
  );
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length > PROPOSAL_STORE_POLICY.maximumListedOperations) {
    throw storeError(
      "PROPOSAL004",
      "Proposal operation record directory exceeds its safe listing bound.",
    );
  }
  const prefix = `${recordPrefix}_`;
  const names = entries
    .filter((entry) => entry.name.startsWith(prefix) && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
  const records = [];
  for (const name of names) {
    const loaded = await readImmutableFile({
      root: paths.graphRoot,
      path: join(directory, name),
      maximumBytes: PROPOSAL_STORE_POLICY.maximumRecordBytes,
      code: "PROPOSAL001",
      label,
    });
    if (loaded === null) continue;
    const record = parse(parseJson(loaded.bytes, label));
    if (record.proposalId !== id) {
      throw storeError("PROPOSAL001", `${label} shard binding is invalid.`);
    }
    records.push(record);
  }
  records.sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt) ||
    canonicalProposalJson(left).localeCompare(canonicalProposalJson(right)));
  return Object.freeze(records);
}

export async function listConflictRecords({ graphRoot, proposalId }) {
  return listOperationRecords({
    graphRoot,
    proposalId,
    recordPrefix: "conflict",
    label: "Immutable proposal conflict",
    parse: parseConflictRecord,
  });
}

export async function listReceiptRecords({ graphRoot, proposalId }) {
  return listOperationRecords({
    graphRoot,
    proposalId,
    recordPrefix: "receipt",
    label: "Immutable proposal receipt",
    parse: parseReceiptRecord,
  });
}

/**
 * Verify that a correction points at an existing terminal proposal in this
 * exact graph. This deliberately runs before proposal publication; a failed
 * correction can therefore never reserve an idempotency key or become
 * reviewable.
 */
export async function assertCorrectionLineage({ graphRoot, proposal, paths: preparedPaths }) {
  const parsed = parseSealedProposalBytes(serializeProposal(proposal));
  if (parsed.correctsProposalId === null) {
    return Object.freeze({ correction: false, correctedProposal: null });
  }
  if (parsed.correctsProposalId === parsed.proposalId) {
    throw storeError("PROPOSAL003", "A proposal cannot correct itself.");
  }
  const paths = preparedPaths ?? await prepareProposalStore(graphRoot);
  const corrected = await readProposalAt(paths, parsed.correctsProposalId);
  if (corrected === null) {
    throw storeError(
      "PROPOSAL003",
      "Corrected proposal does not exist in this graph.",
      { correctsProposalId: parsed.correctsProposalId },
    );
  }
  if (
    corrected.bindings.graphRootIdentity !== parsed.bindings.graphRootIdentity ||
    corrected.bindings.workspaceIdentity !== parsed.bindings.workspaceIdentity
  ) {
    throw storeError(
      "PROPOSAL003",
      "Correction lineage crosses a workspace or graph identity boundary.",
    );
  }

  const [reviews, conflicts] = await Promise.all([
    listReviewRecords({ graphRoot: paths.graphRoot, proposalId: corrected.proposalId }),
    listConflictRecords({ graphRoot: paths.graphRoot, proposalId: corrected.proposalId }),
  ]);
  const rejected = reviews.some((review) => review.decision === "reject");
  if (!rejected && conflicts.length === 0) {
    throw storeError(
      "PROPOSAL003",
      "A correction may only replace a rejected or conflicted terminal proposal.",
      { correctsProposalId: corrected.proposalId },
    );
  }

  const seen = new Set([parsed.proposalId]);
  let cursor = corrected;
  let depth = 0;
  while (cursor !== null) {
    if (seen.has(cursor.proposalId)) {
      throw storeError("PROPOSAL003", "Correction lineage contains a cycle.");
    }
    seen.add(cursor.proposalId);
    depth += 1;
    if (depth > PROPOSAL_STORE_POLICY.maximumCorrectionLineageDepth) {
      throw storeError("PROPOSAL003", "Correction lineage exceeds its safe depth bound.");
    }
    if (cursor.correctsProposalId === null) break;
    const parent = await readProposalAt(paths, cursor.correctsProposalId);
    if (parent === null) {
      throw storeError("PROPOSAL003", "Correction lineage contains a missing proposal.");
    }
    if (
      parent.bindings.graphRootIdentity !== parsed.bindings.graphRootIdentity ||
      parent.bindings.workspaceIdentity !== parsed.bindings.workspaceIdentity
    ) {
      throw storeError(
        "PROPOSAL003",
        "Correction lineage crosses a workspace or graph identity boundary.",
      );
    }
    cursor = parent;
  }
  return Object.freeze({ correction: true, correctedProposal: summarizeProposal(corrected) });
}

export async function publishProposalBlob({ graphRoot, bytes }, hooks = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length > PROPOSAL_STORE_POLICY.maximumBlobBytes) {
    throw storeError("PROPOSAL001", "Proposal blob must be a Buffer no larger than 16 MiB.");
  }
  const digest = immutableSha256(bytes);
  const blobId = contentId("blob", digest);
  if (!BLOB_ID_PATTERN.test(blobId)) {
    throw storeError("PROPOSAL001", "Proposal blob identity is invalid.");
  }
  const paths = await prepareProposalStore(graphRoot);
  const publication = await publishImmutableFile({
    root: paths.graphRoot,
    path: join(paths.blobs, `${blobId}.blob`),
    bytes,
    maximumBytes: PROPOSAL_STORE_POLICY.maximumBlobBytes,
    code: "PROPOSAL004",
    collisionCode: "BLOB002",
    label: "Immutable proposal blob",
  }, hooks);
  return Object.freeze({
    created: publication.created,
    idempotent: publication.idempotent,
    blobId,
    digest,
    byteLength: bytes.length,
  });
}

export async function readProposalBlob({ graphRoot, blobId }) {
  if (typeof blobId !== "string" || !BLOB_ID_PATTERN.test(blobId)) {
    throw storeError("PROPOSAL001", "Proposal blob ID is not content-derived.");
  }
  const paths = await prepareProposalStore(graphRoot);
  const loaded = await readImmutableFile({
    root: paths.graphRoot,
    path: join(paths.blobs, `${blobId}.blob`),
    maximumBytes: PROPOSAL_STORE_POLICY.maximumBlobBytes,
    code: "PROPOSAL001",
    label: "Immutable proposal blob",
  });
  if (loaded === null) return null;
  if (contentId("blob", loaded.sha256) !== blobId) {
    throw storeError("PROPOSAL001", "Proposal blob content does not match its ID.");
  }
  return Object.freeze({
    blobId,
    digest: loaded.sha256,
    byteLength: loaded.byteLength,
    bytes: loaded.bytes,
  });
}
