import { createHash } from "node:crypto";
import { join } from "node:path";

import { SyncoraError } from "./cli.mjs";
import { readCanonicalNoteBytes } from "./governed-environment.mjs";
import {
  immutableSha256,
  publishImmutableFile,
  readImmutableFile,
} from "./immutable-file.mjs";
import {
  canonicalProposalJson,
  parseSealedProposal,
  serializeProposal,
  taggedContentSha256,
} from "./proposal-schema.mjs";
import { prepareProposalStore, proposalStorePaths } from "./proposal-store.mjs";
import { REVIEW_ARTIFACT_POLICY } from "./review-artifact-policy.mjs";
import { createStableDirectoryGuard } from "./stable-directory.mjs";

export { REVIEW_ARTIFACT_POLICY } from "./review-artifact-policy.mjs";

const ARTIFACT_ID_PATTERN = /^artifact_[0-9a-f]{64}$/u;

function artifactError(code, message, details = undefined) {
  return new SyncoraError(code, message, details);
}

function exactKeys(value, expected, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw artifactError("REVIEW001", `${label} must be a JSON object.`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    !actual.every((key, index) => key === wanted[index])
  ) {
    throw artifactError("REVIEW001", `${label} contains missing or unknown fields.`);
  }
}

function semanticDigest(domain, value) {
  return `sha256:${createHash("sha256")
    .update(`${domain}\n`, "utf8")
    .update(canonicalProposalJson(value), "utf8")
    .digest("hex")}`;
}

function artifactIdFor(digest) {
  return `artifact_${digest.slice("sha256:".length)}`;
}

function safeJson(value) {
  return JSON.stringify(value)
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function decodeExactUtf8(bytes, label) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw artifactError("REVIEW001", `${label} is not valid UTF-8.`);
  }
}

function exactTextRecords(text, prefix) {
  if (text.length === 0) return [`${prefix} <empty>`];
  const records = [];
  let offset = 0;
  let line = 1;
  while (offset < text.length) {
    let cursor = offset;
    while (cursor < text.length && text[cursor] !== "\r" && text[cursor] !== "\n") {
      cursor += 1;
    }
    if (cursor < text.length) {
      if (text[cursor] === "\r" && text[cursor + 1] === "\n") cursor += 2;
      else cursor += 1;
    }
    const exact = text.slice(offset, cursor);
    records.push(`${prefix} ${String(line).padStart(6, "0")} ${safeJson(exact)}`);
    offset = cursor;
    line += 1;
  }
  return records;
}

function actorLabel(proposal) {
  return canonicalProposalJson(proposal.actor);
}

async function materializePriorText(environment, proposal) {
  if (
    !environment ||
    typeof environment.graphRoot !== "string" ||
    environment.graphRoot.length === 0
  ) {
    throw artifactError("REVIEW001", "Review artifact environment is invalid.");
  }
  const cache = new Map();
  for (const operation of proposal.operations) {
    for (const change of operation.changes) {
      let cached = cache.get(change.path);
      if (cached === undefined) {
        const before = await readCanonicalNoteBytes(environment, change.path);
        cached = Object.freeze({
          before,
          digest: before === null ? null : taggedContentSha256(before),
        });
        cache.set(change.path, cached);
      }
      const { digest } = cached;
      if (digest !== change.expectedPriorSha256) {
        throw artifactError(
          "WRITE001",
          "Canonical note bytes changed before review artifact publication.",
          {
            path: change.path,
            expectedSha256: change.expectedPriorSha256,
            currentSha256: digest,
          },
        );
      }
    }
  }
  return cache;
}

function renderArtifact(proposal, priorByPath) {
  const lines = [
    "# Syncora governed review artifact",
    "",
    `Specification: ${REVIEW_ARTIFACT_POLICY.specification}`,
    `Proposal ID: ${proposal.proposalId}`,
    `Proposal digest: ${proposal.proposalDigest}`,
    `Intent digest: ${proposal.intentDigest}`,
    `Expected graph revision: ${proposal.bindings.expectedGraphRevision}`,
    `Created at: ${proposal.createdAt}`,
    "",
    "Every untrusted value and note line below is JSON-escaped and prefixed.",
    "The B/A records preserve exact UTF-8 text, including line-ending escapes.",
    "The byte lengths and SHA-256 values bind the exact before/after bytes.",
    "",
    `M actor ${safeJson(actorLabel(proposal))}`,
    `M reason ${safeJson(proposal.reason)}`,
    `M origin ${safeJson(proposal.origin)}`,
    `M correctsProposalId ${safeJson(proposal.correctsProposalId)}`,
  ];

  let ordinal = 0;
  for (const operation of proposal.operations) {
    lines.push("", `## Operation ${safeJson(operation.operationId)}`);
    lines.push(`M operationKind ${safeJson(operation.kind)}`);
    for (const [index, source] of operation.sourceRefs.entries()) {
      lines.push(`S ${String(index + 1).padStart(4, "0")} ${safeJson(canonicalProposalJson(source))}`);
    }
    for (const change of operation.changes) {
      ordinal += 1;
      const before = priorByPath.get(change.path)?.before ?? null;
      const after = change.afterText === null ? null : Buffer.from(change.afterText, "utf8");
      lines.push("", `### Change ${ordinal}`);
      lines.push(`M path ${safeJson(change.path)}`);
      lines.push(`M expectedPriorSha256 ${safeJson(change.expectedPriorSha256)}`);
      lines.push(`M afterSha256 ${safeJson(change.afterSha256)}`);
      lines.push(`M beforeBytes ${before === null ? "null" : before.length}`);
      lines.push(`M afterBytes ${after === null ? "null" : after.length}`);
      lines.push("#### Before (exact JSON-escaped text records)");
      if (before === null) lines.push("B <absent>");
      else lines.push(...exactTextRecords(decodeExactUtf8(before, `Prior note ${change.path}`), "B"));
      lines.push("#### After (exact JSON-escaped text records)");
      if (after === null) lines.push("A <absent>");
      else lines.push(...exactTextRecords(change.afterText, "A"));
    }
  }
  return Buffer.from(`${lines.join("\n")}\n`, "utf8");
}

function artifactMetadata(paths, binding) {
  return Object.freeze({
    path: join(paths.reviewArtifactBlobs, `${binding.artifactId}.md`),
    digest: binding.artifactDigest,
    byteLength: binding.byteLength,
    specification: binding.specification,
    bindingDigest: binding.bindingDigest,
  });
}

function parseBinding(value) {
  exactKeys(value, [
    "schemaVersion",
    "kind",
    "specification",
    "proposalId",
    "proposalDigest",
    "artifactId",
    "artifactDigest",
    "byteLength",
    "bindingDigest",
  ], "Review artifact binding");
  if (
    value.schemaVersion !== 1 ||
    value.kind !== "syncora.review-artifact-binding" ||
    value.specification !== REVIEW_ARTIFACT_POLICY.specification ||
    typeof value.proposalId !== "string" ||
    !/^proposal_[0-9a-f]{64}$/u.test(value.proposalId) ||
    typeof value.proposalDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(value.proposalDigest) ||
    typeof value.artifactDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(value.artifactDigest) ||
    typeof value.artifactId !== "string" ||
    !ARTIFACT_ID_PATTERN.test(value.artifactId) ||
    value.artifactId !== artifactIdFor(value.artifactDigest) ||
    !Number.isSafeInteger(value.byteLength) ||
    value.byteLength < 1 ||
    value.byteLength > REVIEW_ARTIFACT_POLICY.maximumArtifactBytes
  ) {
    throw artifactError("REVIEW001", "Review artifact binding is invalid.");
  }
  const withoutDigest = {
    schemaVersion: 1,
    kind: "syncora.review-artifact-binding",
    specification: value.specification,
    proposalId: value.proposalId,
    proposalDigest: value.proposalDigest,
    artifactId: value.artifactId,
    artifactDigest: value.artifactDigest,
    byteLength: value.byteLength,
  };
  const bindingDigest = semanticDigest("syncora-review-artifact-binding-v1", withoutDigest);
  if (value.bindingDigest !== bindingDigest) {
    throw artifactError("REVIEW001", "Review artifact binding digest is invalid.");
  }
  return Object.freeze({ ...withoutDigest, bindingDigest });
}

function createBinding(proposal, bytes) {
  const artifactDigest = immutableSha256(bytes);
  const withoutDigest = {
    schemaVersion: 1,
    kind: "syncora.review-artifact-binding",
    specification: REVIEW_ARTIFACT_POLICY.specification,
    proposalId: proposal.proposalId,
    proposalDigest: proposal.proposalDigest,
    artifactId: artifactIdFor(artifactDigest),
    artifactDigest,
    byteLength: bytes.length,
  };
  return parseBinding({
    ...withoutDigest,
    bindingDigest: semanticDigest("syncora-review-artifact-binding-v1", withoutDigest),
  });
}

async function bindingDirectory(paths, proposalId) {
  const directory = join(paths.reviewArtifactBindings, proposalId);
  const guard = createStableDirectoryGuard(paths.graphRoot, directory, {
    code: "REVIEW001",
    label: "Review artifact binding shard",
  });
  await guard.prepare();
  return directory;
}

function bindingFileName(proposalDigest) {
  return `${proposalDigest.slice("sha256:".length)}.json`;
}

function serializeBinding(binding) {
  const bytes = Buffer.from(`${JSON.stringify(binding, null, 2)}\n`, "utf8");
  if (bytes.length > REVIEW_ARTIFACT_POLICY.maximumBindingBytes) {
    throw artifactError("REVIEW001", "Review artifact binding exceeds its byte limit.");
  }
  return bytes;
}

function parseBindingBytes(bytes) {
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw artifactError("REVIEW001", "Review artifact binding is not valid UTF-8 JSON.");
  }
  return parseBinding(value);
}

export async function buildReviewArtifact({ environment, proposal }) {
  const parsed = parseSealedProposal(proposal);
  // Exercise the sealed-size parser as part of the boundary, too.
  serializeProposal(parsed);
  if (
    environment.graphRootIdentity !== parsed.bindings.graphRootIdentity ||
    environment.workspaceIdentity !== parsed.bindings.workspaceIdentity
  ) {
    throw artifactError(
      "REVIEW001",
      "Review artifact proposal is bound to a different workspace or graph.",
    );
  }
  const priorByPath = await materializePriorText(environment, parsed);
  const bytes = renderArtifact(parsed, priorByPath);
  if (bytes.length > REVIEW_ARTIFACT_POLICY.maximumArtifactBytes) {
    throw artifactError(
      "REVIEW001",
      "Human review artifact exceeds its bounded local size.",
      { bytes: bytes.length, limit: REVIEW_ARTIFACT_POLICY.maximumArtifactBytes },
    );
  }
  // Building is the dry-run boundary and must not create governance state.
  const paths = proposalStorePaths(environment.graphRoot);
  const binding = createBinding(parsed, bytes);
  return Object.freeze({
    bytes,
    binding,
    artifact: artifactMetadata(paths, binding),
  });
}

/** Publish the content and its proposal-digest binding before proposal publication. */
export async function publishReviewArtifact({ environment, proposal }, hooks = {}) {
  const built = await buildReviewArtifact({ environment, proposal });
  const paths = await prepareProposalStore(environment.graphRoot);
  const artifactPath = join(paths.reviewArtifactBlobs, `${built.binding.artifactId}.md`);
  const artifactPublication = await publishImmutableFile({
    root: paths.graphRoot,
    path: artifactPath,
    bytes: built.bytes,
    maximumBytes: REVIEW_ARTIFACT_POLICY.maximumArtifactBytes,
    code: "REVIEW001",
    collisionCode: "REVIEW002",
    label: "Immutable human review artifact",
  }, hooks.artifact);
  const directory = await bindingDirectory(paths, built.binding.proposalId);
  const bindingPath = join(directory, bindingFileName(built.binding.proposalDigest));
  const bindingPublication = await publishImmutableFile({
    root: paths.graphRoot,
    path: bindingPath,
    bytes: serializeBinding(built.binding),
    maximumBytes: REVIEW_ARTIFACT_POLICY.maximumBindingBytes,
    code: "REVIEW001",
    collisionCode: "REVIEW002",
    label: "Immutable review artifact binding",
  }, hooks.binding);
  return Object.freeze({
    created: artifactPublication.created || bindingPublication.created,
    idempotent: artifactPublication.idempotent && bindingPublication.idempotent,
    artifact: built.artifact,
  });
}

export async function readReviewArtifactBinding({ graphRoot, proposalId, proposalDigest }) {
  if (
    typeof proposalId !== "string" ||
    !/^proposal_[0-9a-f]{64}$/u.test(proposalId) ||
    typeof proposalDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(proposalDigest)
  ) {
    throw artifactError("REVIEW001", "Review artifact lookup identity is invalid.");
  }
  const paths = await prepareProposalStore(graphRoot);
  const directory = await bindingDirectory(paths, proposalId);
  const loaded = await readImmutableFile({
    root: paths.graphRoot,
    path: join(directory, bindingFileName(proposalDigest)),
    maximumBytes: REVIEW_ARTIFACT_POLICY.maximumBindingBytes,
    code: "REVIEW001",
    label: "Immutable review artifact binding",
  });
  if (loaded === null) return null;
  const binding = parseBindingBytes(loaded.bytes);
  if (binding.proposalId !== proposalId || binding.proposalDigest !== proposalDigest) {
    throw artifactError("REVIEW001", "Review artifact binding lookup does not match its contents.");
  }
  return binding;
}

/** Verify exact artifact availability before a digest can be approved. */
export async function verifyReviewArtifact({ graphRoot, proposal }) {
  const parsed = parseSealedProposal(proposal);
  const paths = await prepareProposalStore(graphRoot);
  const binding = await readReviewArtifactBinding({
    graphRoot,
    proposalId: parsed.proposalId,
    proposalDigest: parsed.proposalDigest,
  });
  if (binding === null) {
    throw artifactError(
      "REVIEW001",
      "Exact human review artifact is missing; recreate the proposal before approval.",
    );
  }
  const artifactPath = join(paths.reviewArtifactBlobs, `${binding.artifactId}.md`);
  const loaded = await readImmutableFile({
    root: paths.graphRoot,
    path: artifactPath,
    maximumBytes: REVIEW_ARTIFACT_POLICY.maximumArtifactBytes,
    code: "REVIEW001",
    label: "Immutable human review artifact",
  });
  if (
    loaded === null ||
    loaded.byteLength !== binding.byteLength ||
    loaded.sha256 !== binding.artifactDigest
  ) {
    throw artifactError(
      "REVIEW001",
      "Human review artifact is missing or does not match its proposal binding.",
    );
  }
  const expectedHeader = Buffer.from(
    `# Syncora governed review artifact\n\nSpecification: ${binding.specification}\nProposal ID: ${binding.proposalId}\nProposal digest: ${binding.proposalDigest}\n`,
    "utf8",
  );
  if (!loaded.bytes.subarray(0, expectedHeader.length).equals(expectedHeader)) {
    throw artifactError("REVIEW001", "Human review artifact header is inconsistent.");
  }
  return artifactMetadata(paths, binding);
}
