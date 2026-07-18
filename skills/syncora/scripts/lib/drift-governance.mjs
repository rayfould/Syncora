import { SyncoraError } from "./cli.mjs";
import {
  publishDriftProposalBinding,
  readDriftFinding,
  readDriftState,
} from "./drift-state.mjs";
import { observeBoundSources } from "./drift-source.mjs";
import {
  assertDriftFindingId,
  assertPortableGraphPath,
  assertPortableWorkspacePath,
  assertProposalId,
  assertTaggedSha256,
  taggedContentSha256,
} from "./proposal-schema.mjs";

export const DRIFT_FINDING_SPECIFICATION = "syncora-drift-finding-v1";
export const DRIFT_PROPOSAL_BINDING_SPECIFICATION =
  "syncora-drift-proposal-binding-v1";

const FINDING_OPERATIONS = new Set([
  "hub.refresh",
  "decision.accept",
  "note.update",
]);
const FINDING_NOTE_KINDS = new Set([
  "project",
  "decision",
  "concept",
  "reference",
]);
const FINDING_AUTHORITIES = new Set(["canonical", "supporting"]);
const CHANGE_KINDS = new Set(["added", "modified", "deleted", "renamed"]);
const BINDING_KINDS = new Set(["file", "module", "path_glob"]);
const ARTIFACT_ID = Object.freeze({
  observation: /^observation_[0-9a-f]{64}$/u,
  finding: /^finding_[0-9a-f]{64}$/u,
  proposal: /^proposal_[0-9a-f]{64}$/u,
});

function governanceError(message, details = undefined) {
  return new SyncoraError("PROPOSAL003", message, details);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected, label) {
  if (!isPlainObject(value)) throw governanceError(`${label} must be a JSON object.`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    !actual.every((key, index) => key === wanted[index])
  ) {
    throw governanceError(`${label} contains missing or unknown fields.`, {
      actual,
      expected: wanted,
    });
  }
}

function boundedText(value, label, maximum = 4_096) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    [...value].length > maximum ||
    value !== value.normalize("NFC") ||
    /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)
  ) {
    throw governanceError(`${label} must be bounded, normalized text.`);
  }
  return value;
}

function nullableTaggedSha256(value, label) {
  return value === null ? null : assertTaggedSha256(value, label);
}

function nullableBytes(value, label) {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0 || value > 16_777_216) {
    throw governanceError(`${label} must be a bounded byte count or null.`);
  }
  return value;
}

function artifactRef(value, label, pattern) {
  exactKeys(value, ["id", "digest"], label);
  if (typeof value.id !== "string" || !pattern.test(value.id)) {
    throw governanceError(`${label} ID is malformed.`);
  }
  return {
    id: value.id,
    digest: assertTaggedSha256(value.digest, `${label} digest`),
  };
}

function parseFindingNote(value) {
  exactKeys(
    value,
    ["path", "sha256", "kind", "scope", "authorityClass"],
    "Drift finding note",
  );
  if (!FINDING_NOTE_KINDS.has(value.kind)) {
    throw governanceError("Drift finding note kind is unsupported.");
  }
  if (!FINDING_AUTHORITIES.has(value.authorityClass)) {
    throw governanceError("Drift finding cannot grant refresh authority to this note.");
  }
  return {
    path: assertPortableGraphPath(value.path, "Drift finding note path"),
    sha256: assertTaggedSha256(value.sha256, "Drift finding note digest"),
    kind: value.kind,
    scope: boundedText(value.scope, "Drift finding note scope", 256),
    authorityClass: value.authorityClass,
  };
}

function parseMatchedBinding(value, index) {
  const label = `Drift finding matched binding ${index + 1}`;
  exactKeys(
    value,
    ["specifier", "kind", "ref", "beforeFingerprint", "currentFingerprint"],
    label,
  );
  if (!BINDING_KINDS.has(value.kind)) {
    throw governanceError(`${label} kind is unsupported.`);
  }
  const ref = value.kind === "path_glob"
    ? boundedText(value.ref, `${label} ref`)
    : assertPortableWorkspacePath(value.ref, `${label} ref`);
  return {
    specifier: boundedText(value.specifier, `${label} specifier`),
    kind: value.kind,
    ref,
    beforeFingerprint: assertTaggedSha256(
      value.beforeFingerprint,
      `${label} prior fingerprint`,
    ),
    currentFingerprint: assertTaggedSha256(
      value.currentFingerprint,
      `${label} current fingerprint`,
    ),
  };
}

function parseChangedSource(value, index) {
  const label = `Drift finding changed source ${index + 1}`;
  exactKeys(
    value,
    [
      "path",
      "change",
      "beforeSha256",
      "currentSha256",
      "beforeBytes",
      "currentBytes",
      "renamedFrom",
    ],
    label,
  );
  if (!CHANGE_KINDS.has(value.change)) {
    throw governanceError(`${label} change kind is unsupported.`);
  }
  const parsed = {
    path: assertPortableWorkspacePath(value.path, `${label} path`),
    change: value.change,
    beforeSha256: nullableTaggedSha256(value.beforeSha256, `${label} prior digest`),
    currentSha256: nullableTaggedSha256(value.currentSha256, `${label} current digest`),
    beforeBytes: nullableBytes(value.beforeBytes, `${label} prior bytes`),
    currentBytes: nullableBytes(value.currentBytes, `${label} current bytes`),
    renamedFrom: value.renamedFrom === null
      ? null
      : assertPortableWorkspacePath(value.renamedFrom, `${label} renamedFrom`),
  };
  if (
    (parsed.change === "added" &&
      (parsed.beforeSha256 !== null || parsed.currentSha256 === null)) ||
    (parsed.change === "deleted" &&
      (parsed.beforeSha256 === null || parsed.currentSha256 !== null)) ||
    (parsed.change === "modified" &&
      (parsed.beforeSha256 === null || parsed.currentSha256 === null ||
        (parsed.beforeSha256 === parsed.currentSha256 &&
          parsed.beforeBytes === parsed.currentBytes))) ||
    (parsed.change === "renamed" && parsed.renamedFrom === null) ||
    (parsed.change === "renamed" &&
      (parsed.beforeSha256 === null || parsed.currentSha256 === null ||
        parsed.beforeSha256 !== parsed.currentSha256 ||
        parsed.beforeBytes !== parsed.currentBytes ||
        parsed.renamedFrom === parsed.path)) ||
    (parsed.change !== "renamed" && parsed.renamedFrom !== null) ||
    (parsed.beforeSha256 === null) !== (parsed.beforeBytes === null) ||
    (parsed.currentSha256 === null) !== (parsed.currentBytes === null)
  ) {
    throw governanceError(`${label} digest, size, and change semantics disagree.`);
  }
  return parsed;
}

function parseSupersededFindings(value) {
  if (!Array.isArray(value) || value.length > 256) {
    throw governanceError("Drift finding supersession exceeds its bound.");
  }
  const parsed = value.map((entry, index) =>
    artifactRef(entry, `Superseded drift finding ${index + 1}`, ARTIFACT_ID.finding));
  for (let index = 0; index < parsed.length; index += 1) {
    if (
      index > 0 &&
      parsed[index - 1].id >= parsed[index].id
    ) {
      throw governanceError(
        "Superseded drift finding references must be unique and sorted.",
      );
    }
  }
  return parsed;
}

export function parseDriftFindingPayload(value) {
  exactKeys(
    value,
    [
      "specification",
      "status",
      "authority",
      "graphRevision",
      "observationBefore",
      "observationCurrent",
      "supersedes",
      "note",
      "matchedBindings",
      "changedSources",
      "recommendedOperation",
      "afterTextRequired",
    ],
    "Drift finding payload",
  );
  if (
    value.specification !== DRIFT_FINDING_SPECIFICATION ||
    value.status !== "potentially-stale" ||
    value.authority !== "zero" ||
    value.afterTextRequired !== true ||
    !FINDING_OPERATIONS.has(value.recommendedOperation)
  ) {
    throw governanceError("Drift finding policy fields are invalid.");
  }
  if (
    !Array.isArray(value.matchedBindings) ||
    value.matchedBindings.length < 1 ||
    value.matchedBindings.length > 256 ||
    !Array.isArray(value.changedSources) ||
    value.changedSources.length < 1 ||
    value.changedSources.length > 10_000
  ) {
    throw governanceError("Drift finding evidence is empty or exceeds its bound.");
  }
  const parsed = {
    specification: DRIFT_FINDING_SPECIFICATION,
    status: "potentially-stale",
    authority: "zero",
    graphRevision: assertTaggedSha256(value.graphRevision, "Drift graph revision"),
    observationBefore: artifactRef(
      value.observationBefore,
      "Prior drift observation",
      ARTIFACT_ID.observation,
    ),
    observationCurrent: artifactRef(
      value.observationCurrent,
      "Current drift observation",
      ARTIFACT_ID.observation,
    ),
    supersedes: parseSupersededFindings(value.supersedes),
    note: parseFindingNote(value.note),
    matchedBindings: value.matchedBindings.map(parseMatchedBinding),
    changedSources: value.changedSources.map(parseChangedSource),
    recommendedOperation: value.recommendedOperation,
    afterTextRequired: true,
  };
  if (
    new Set(parsed.matchedBindings.map((entry) => entry.specifier)).size !==
      parsed.matchedBindings.length ||
    new Set(parsed.changedSources.map((entry) => entry.path)).size !==
      parsed.changedSources.length ||
    parsed.matchedBindings.some((entry, index) =>
      index > 0 && parsed.matchedBindings[index - 1].specifier >= entry.specifier) ||
    parsed.changedSources.some((entry, index) =>
      index > 0 && parsed.changedSources[index - 1].path >= entry.path)
  ) {
    throw governanceError(
      "Drift finding bindings and changed source paths must be unique and sorted.",
    );
  }
  return Object.freeze(parsed);
}

export function parseDriftProposalBindingPayload(value) {
  exactKeys(
    value,
    ["specification", "finding", "proposal", "operation", "note"],
    "Drift proposal binding payload",
  );
  if (value.specification !== DRIFT_PROPOSAL_BINDING_SPECIFICATION) {
    throw governanceError("Drift proposal binding specification is unsupported.");
  }
  exactKeys(value.operation, ["id", "kind"], "Drift proposal binding operation");
  exactKeys(value.note, ["path"], "Drift proposal binding note");
  if (!FINDING_OPERATIONS.has(value.operation.kind)) {
    throw governanceError("Drift proposal binding operation kind is unsupported.");
  }
  return Object.freeze({
    specification: DRIFT_PROPOSAL_BINDING_SPECIFICATION,
    finding: artifactRef(value.finding, "Bound drift finding", ARTIFACT_ID.finding),
    proposal: artifactRef(value.proposal, "Bound drift proposal", ARTIFACT_ID.proposal),
    operation: {
      id: boundedText(value.operation.id, "Bound drift operation ID", 200),
      kind: value.operation.kind,
    },
    note: {
      path: assertPortableGraphPath(value.note.path, "Bound drift note path"),
    },
  });
}

const NO_GIT_ADVISORY_HOOKS = Object.freeze({
  runGit: async () => ({
    code: 1,
    stdout: Buffer.alloc(0),
    stderr: Buffer.from("Git advisory is not needed for freshness verification.", "utf8"),
  }),
});

/**
 * Revalidate one finding against both the active-state index and the complete
 * raw-byte fingerprint of every binding that created it. The immutable finding
 * is evidence, not a freshness oracle: this read-only check is what makes later
 * file additions, edits, deletions, and acknowledgement fail closed.
 */
export async function verifyDriftFindingFreshness(
  environment,
  { findingId: rawFindingId, findingDigest: rawFindingDigest, maximumArtifactBytes },
) {
  const findingId = assertDriftFindingId(rawFindingId);
  const findingDigest = assertTaggedSha256(
    rawFindingDigest,
    "Drift finding freshness digest",
  );
  const state = await readDriftState({
    graphRoot: environment.graphRoot,
    workspaceIdentity: environment.workspaceIdentity,
    graphRootIdentity: environment.graphRootIdentity,
    policyRevision: environment.policyRevision,
  });
  const activeFinding = state?.activeFindings.find(
    (entry) => entry.findingId === findingId,
  );
  if (!activeFinding || activeFinding.findingDigest !== findingDigest) {
    throw governanceError(
      "A drift finding is missing, resolved, acknowledged, or digest-mismatched.",
      { findingId },
    );
  }

  const artifact = await readDriftFinding({
    graphRoot: environment.graphRoot,
    workspaceIdentity: environment.workspaceIdentity,
    graphRootIdentity: environment.graphRootIdentity,
    policyRevision: environment.policyRevision,
    id: findingId,
    ...(maximumArtifactBytes === undefined ? {} : { maximumBytes: maximumArtifactBytes }),
  });
  if (artifact === null || artifact.digest !== findingDigest) {
    throw governanceError("The exact active drift finding is unavailable.", {
      findingId,
    });
  }
  const finding = parseDriftFindingPayload(artifact.payload);
  const { readCanonicalNoteBytes } = await import("./governed-environment.mjs");
  const noteBytes = await readCanonicalNoteBytes(environment, finding.note.path, {
    code: "PROPOSAL003",
    label: "Drift finding canonical note",
  });
  if (noteBytes === null || taggedContentSha256(noteBytes) !== finding.note.sha256) {
    throw governanceError(
      "The canonical note changed, moved, or disappeared after the drift finding was published.",
      { findingId, notePath: finding.note.path },
    );
  }
  const observation = await observeBoundSources({
    workspacePath: environment.workspacePath,
    graphPath: environment.graphRoot,
    bindings: finding.matchedBindings.map(({ specifier, kind, ref }) => ({
      specifier,
      kind,
      ref,
    })),
    hooks: NO_GIT_ADVISORY_HOOKS,
  });
  const observed = new Map(
    observation.bindings.map((binding) => [binding.specifier, binding]),
  );
  for (const expected of finding.matchedBindings) {
    const current = observed.get(expected.specifier);
    if (
      current === undefined ||
      current.kind !== expected.kind ||
      current.ref !== expected.ref ||
      current.fingerprint !== expected.currentFingerprint
    ) {
      throw governanceError(
        "A bound source changed after the drift finding was published.",
        {
          findingId,
          specifier: expected.specifier,
          expectedFingerprint: expected.currentFingerprint,
          currentFingerprint: current?.fingerprint ?? null,
        },
      );
    }
  }
  if (observed.size !== finding.matchedBindings.length) {
    throw governanceError("Drift freshness observation returned unexpected bindings.", {
      findingId,
    });
  }
  return Object.freeze({
    findingId,
    findingDigest,
    artifactBytes: Buffer.from(artifact.bytes),
    finding,
    observation,
  });
}

export async function validateDriftProposalInput(environment, input) {
  const operations = Array.isArray(input?.operations) ? input.operations : [];
  const driftRefs = operations.flatMap((operation) =>
    (operation.sourceRefs ?? [])
      .filter((source) => source.type === "drift-finding")
      .map((source) => ({ operation, source })));
  if (input.origin !== "drift") {
    if (driftRefs.length > 0) {
      throw governanceError("Only a drift-origin proposal may reference a drift finding.");
    }
    return Object.freeze([]);
  }
  if (driftRefs.length < 1) {
    throw governanceError("A drift-origin proposal must exact-bind at least one active finding.");
  }

  const verified = [];
  const seen = new Set();
  const freshness = new Map();
  for (const { operation, source } of driftRefs) {
    const findingId = assertDriftFindingId(source.ref);
    const identity = `${operation.operationId}\0${findingId}`;
    const freshnessKey = `${findingId}\0${source.expectedSha256}`;
    let current = freshness.get(freshnessKey);
    if (current === undefined) {
      current = await verifyDriftFindingFreshness(environment, {
        findingId,
        findingDigest: source.expectedSha256,
      });
      freshness.set(freshnessKey, current);
    }
    if (seen.has(identity)) continue;
    seen.add(identity);
    const { finding } = current;
    const noteChange = operation.changes.find(
      (change) => change.path === finding.note.path,
    );
    if (
      operation.kind !== finding.recommendedOperation ||
      !noteChange ||
      noteChange.expectedPriorSha256 !== finding.note.sha256
    ) {
      throw governanceError("A drift proposal must repair the bound finding's exact note with its recommended operation.", {
        findingId,
        notePath: finding.note.path,
        expectedPriorSha256: finding.note.sha256,
        recommendedOperation: finding.recommendedOperation,
      });
    }
    verified.push(Object.freeze({
      findingId,
      findingDigest: current.findingDigest,
      operationId: operation.operationId,
      operationKind: operation.kind,
      notePath: finding.note.path,
    }));
  }
  return Object.freeze(verified);
}

export async function publishDriftProposalBindings({
  environment,
  proposal,
  validatedFindings,
}) {
  assertProposalId(proposal.proposalId);
  assertTaggedSha256(proposal.proposalDigest, "Drift proposal digest");
  const publications = [];
  for (const finding of validatedFindings) {
    const publication = await publishDriftProposalBinding({
      graphRoot: environment.graphRoot,
      workspaceIdentity: environment.workspaceIdentity,
      graphRootIdentity: environment.graphRootIdentity,
      policyRevision: environment.policyRevision,
      payload: {
        specification: DRIFT_PROPOSAL_BINDING_SPECIFICATION,
        finding: {
          id: finding.findingId,
          digest: finding.findingDigest,
        },
        proposal: {
          id: proposal.proposalId,
          digest: proposal.proposalDigest,
        },
        operation: {
          id: finding.operationId,
          kind: finding.operationKind,
        },
        note: { path: finding.notePath },
      },
    });
    parseDriftProposalBindingPayload(publication.payload);
    publications.push(publication);
  }
  return Object.freeze(publications);
}
