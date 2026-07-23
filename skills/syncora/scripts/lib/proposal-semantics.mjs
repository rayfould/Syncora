import { createHash } from "node:crypto";

import { SyncoraError } from "./cli.mjs";
import { parseNoteBytes } from "./note-parser.mjs";
import {
  assertPortableGraphPath,
  canonicalProposalJson,
  parseProposalAssessment,
  parseProposalInput,
  PROPOSAL_POLICY,
  taggedContentSha256,
} from "./proposal-schema.mjs";
import { graphRevision, VALIDATION_POLICY } from "./validate.mjs";

export const PROPOSAL_SEMANTICS_POLICY = Object.freeze({
  specification: "syncora-proposal-semantics-v1",
  duplicateSimilarityThreshold: 0.55,
  maximumDuplicateCandidates: PROPOSAL_POLICY.maximumDuplicateCandidates,
  maximumDuplicateTokens: 512,
  maximumDuplicateComparisons: 65_536,
  maximumDuplicateTokenPostings: 4_194_304,
});

const IMPACT_RANK = Object.freeze({
  none: 0,
  supporting: 1,
  "canonical-content": 2,
  "authority-changing": 3,
});

const IMPACT_REASONS = Object.freeze({
  authorityTopology:
    "A note changes canonical identity, type, scope, authority, decision state, or authority topology.",
  canonicalRemoval:
    "A canonical or routing note is moved or removed.",
  decisionAcceptance:
    "An accepted canonical decision is created or changed.",
  hubActivation:
    "An active canonical project hub is created or activated.",
  routingCreation:
    "A canonical routing note is created.",
  canonicalContent:
    "Canonical content changes without changing authority topology.",
  supporting:
    "Supporting evidence is created, changed, moved, or removed.",
  nonAuthoritative:
    "Only historical or transient material is created or changed.",
});

const TOPOLOGY_FIELDS = Object.freeze([
  "id",
  "kind",
  "scope",
  "authority",
  "decision_key",
]);

const CANONICAL_CREATION_KINDS = Object.freeze(new Set([
  "concept",
  "decision",
]));

function semanticError(message, details = undefined) {
  return new SyncoraError("PROPOSAL003", message, details);
}

function portableCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function portableIdentity(value) {
  return typeof value === "string"
    ? value.normalize("NFC").toLowerCase()
    : "";
}

function exactKeys(value, expected, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw semanticError(`${label} must be an object.`);
  }
  const actual = Object.keys(value).sort(portableCompare);
  const wanted = [...expected].sort(portableCompare);
  if (
    actual.length !== wanted.length ||
    !actual.every((key, index) => key === wanted[index])
  ) {
    throw semanticError(`${label} contains missing or unknown fields.`, {
      actual,
      expected: wanted,
    });
  }
}

function bytesEqual(left, right) {
  if (left === null || right === null) return left === right;
  return Buffer.isBuffer(left) && Buffer.isBuffer(right) && left.equals(right);
}

function exactValue(left, right) {
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => exactValue(value, right[index]));
  }
  return left === right;
}

function normalizedRelationSet(note, field) {
  return new Set(
    (note?.frontmatter?.[field] ?? []).map((value) => portableIdentity(value)),
  );
}

function relationsUseUniquePortableIdentities(note) {
  for (const field of ["supersedes", "superseded_by"]) {
    const values = note?.frontmatter?.[field] ?? [];
    if (normalizedRelationSet(note, field).size !== values.length) return false;
  }
  return true;
}

function setDifference(left, right) {
  return [...left].filter((value) => !right.has(value)).sort(portableCompare);
}

function sameSet(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function noteAliases(note) {
  return new Set(
    [note?.frontmatter?.id, note?.frontmatter?.decision_key]
      .filter((value) => typeof value === "string" && value !== "")
      .map((value) => portableIdentity(value)),
  );
}

function relationTargets(value, target) {
  return noteAliases(target).has(portableIdentity(value));
}

function sha256Tagged(bytes) {
  return taggedContentSha256(bytes);
}

function baselineIndex(inspection) {
  if (
    inspection === null ||
    typeof inspection !== "object" ||
    !Array.isArray(inspection.notes) ||
    typeof inspection.report?.graph?.revision !== "string"
  ) {
    throw semanticError("Proposal semantics require one complete current inspection.");
  }
  if (graphRevision(inspection.notes) !== inspection.report.graph.revision) {
    throw semanticError("The supplied inspection does not match its graph revision.");
  }
  const byPath = new Map();
  for (const note of inspection.notes) {
    if (byPath.has(note.path)) {
      throw semanticError("The supplied inspection repeats a graph path.", {
        path: note.path,
      });
    }
    byPath.set(note.path, note);
  }
  return byPath;
}

function projectedIndex(projection, inspection, exactChanges) {
  if (
    projection === null ||
    typeof projection !== "object" ||
    !Array.isArray(projection.notes) ||
    !Array.isArray(projection.changes) ||
    typeof projection.graphRevision !== "string" ||
    projection.report?.graph?.baselineRevision !== inspection.report.graph.revision
  ) {
    throw semanticError(
      "Proposal semantics require the projected result for the supplied inspection.",
    );
  }
  if (
    projection.graphRevision !== projection.report?.graph?.revision ||
    projection.graphRevision !== graphRevision(projection.notes)
  ) {
    throw semanticError("The supplied projected result has an inconsistent graph revision.");
  }
  if (projection.changes.length !== exactChanges.length) {
    throw semanticError("The projected result does not cover every exact proposal change.");
  }
  for (let index = 0; index < exactChanges.length; index += 1) {
    const exact = exactChanges[index];
    const projected = projection.changes[index];
    if (
      projected?.path !== exact.path ||
      !bytesEqual(projected?.before, exact.before) ||
      !bytesEqual(projected?.after, exact.after)
    ) {
      throw semanticError("The projected result is not bound to the exact proposal changes.", {
        change: index + 1,
        path: exact.path,
      });
    }
  }
  const introduced = projection.errorFingerprints?.introduced?.count;
  const affected = projection.report?.summary?.affectedAuthorityConflicts;
  if (projection.ok !== true || introduced !== 0 || affected !== 0) {
    throw semanticError("The exact proposal post-image does not pass projected validation.", {
      introducedErrors: Number.isSafeInteger(introduced) ? introduced : null,
      affectedAuthorityConflicts: Number.isSafeInteger(affected) ? affected : null,
    });
  }
  if (
    !Number.isSafeInteger(projection.findings?.count) ||
    projection.findings.count < 0 ||
    projection.findings.count > PROPOSAL_POLICY.maximumValidationFindings
  ) {
    throw semanticError("Projected validation findings exceed the governed proposal limit.", {
      findings: projection.findings?.count ?? null,
      limit: PROPOSAL_POLICY.maximumValidationFindings,
    });
  }
  const byPath = new Map();
  for (const note of projection.notes) {
    if (byPath.has(note.path)) {
      throw semanticError("The projected post-image repeats a graph path.", {
        path: note.path,
      });
    }
    byPath.set(note.path, note);
  }
  return byPath;
}

function bindExactChanges(input, inspectionByPath, exactChanges) {
  if (!Array.isArray(exactChanges)) {
    throw semanticError("Flattened exact proposal changes must be an array.");
  }
  const declared = input.operations.flatMap((operation) =>
    operation.changes.map((change) => ({ operation, change })));
  if (declared.length !== exactChanges.length) {
    throw semanticError("Flattened exact changes do not match the proposal operation count.", {
      declared: declared.length,
      exact: exactChanges.length,
    });
  }

  const contextsByOperation = new Map(input.operations.map((operation) => [operation, []]));
  for (let index = 0; index < declared.length; index += 1) {
    const { operation, change } = declared[index];
    const exact = exactChanges[index];
    exactKeys(exact, ["path", "before", "after"], `Exact proposal change ${index + 1}`);
    if (exact.path !== change.path) {
      throw semanticError("Flattened exact changes are not in declared operation order.", {
        operationId: operation.operationId,
        declaredPath: change.path,
        exactPath: exact.path,
      });
    }
    for (const field of ["before", "after"]) {
      if (exact[field] !== null && !Buffer.isBuffer(exact[field])) {
        throw semanticError(`Exact proposal ${field} content must be a Buffer or null.`, {
          operationId: operation.operationId,
          path: exact.path,
        });
      }
    }
    const expectedAfter = change.afterText === null
      ? null
      : Buffer.from(change.afterText, "utf8");
    if (!bytesEqual(exact.after, expectedAfter)) {
      throw semanticError("Exact resulting bytes do not match the declared operation text.", {
        operationId: operation.operationId,
        path: exact.path,
      });
    }
    const current = inspectionByPath.get(exact.path);
    if (current === undefined) {
      if (exact.before !== null || change.expectedPriorSha256 !== null) {
        throw semanticError("A create operation is not bound to an absent current path.", {
          operationId: operation.operationId,
          path: exact.path,
        });
      }
    } else {
      if (
        exact.before === null ||
        current.rawSha256 === null ||
        current.byteLength !== exact.before.length ||
        `sha256:${current.rawSha256}` !== sha256Tagged(exact.before)
      ) {
        throw semanticError("Exact prior bytes do not match the inspected note.", {
          operationId: operation.operationId,
          path: exact.path,
        });
      }
      if (change.expectedPriorSha256 !== sha256Tagged(exact.before)) {
        throw semanticError("An existing-note operation lacks its exact prior hash binding.", {
          operationId: operation.operationId,
          path: exact.path,
        });
      }
    }
    contextsByOperation.get(operation).push({
      declaration: change,
      exact,
      beforeValidated: current ?? null,
    });
  }
  return contextsByOperation;
}

function parseExactNote(path, bytes) {
  if (bytes === null) return null;
  return parseNoteBytes(
    { path, nonPortablePath: false },
    bytes,
    VALIDATION_POLICY,
    { includeLexicalSource: true },
  );
}

function requireValidPostNote(context, projectionByPath, label) {
  if (context.exact.after === null) {
    throw semanticError(`${label} must produce a note.`, {
      path: context.exact.path,
    });
  }
  const note = projectionByPath.get(context.exact.path);
  if (
    note === undefined ||
    note.currentSchema !== true ||
    ["quarantined", "unpromoted", "pending"].includes(note.authorityClass)
  ) {
    throw semanticError(`${label} must produce one valid current-schema note.`, {
      path: context.exact.path,
    });
  }
  if (note.rawSha256 !== sha256Tagged(context.exact.after).slice("sha256:".length)) {
    throw semanticError(`${label} post-image note does not match exact resulting bytes.`, {
      path: context.exact.path,
    });
  }
  return note;
}

function requireCreate(context, projectionByPath, label) {
  if (context.exact.before !== null || context.exact.after === null) {
    throw semanticError(`${label} must be an additive note creation.`, {
      path: context.exact.path,
    });
  }
  return requireValidPostNote(context, projectionByPath, label);
}

function requireUpdate(context, projectionByPath, label) {
  if (
    context.exact.before === null ||
    context.exact.after === null ||
    context.exact.before.equals(context.exact.after)
  ) {
    throw semanticError(`${label} must replace an existing note with changed bytes.`, {
      path: context.exact.path,
    });
  }
  return requireValidPostNote(context, projectionByPath, label);
}

function requireFieldsPreserved(before, after, fields, label, path) {
  const changed = fields.filter(
    (field) => !exactValue(before.frontmatter?.[field], after.frontmatter?.[field]),
  );
  if (changed.length > 0) {
    throw semanticError(`${label} changes fields that must preserve semantic identity.`, {
      path,
      fields: changed,
    });
  }
}

function frontmatterPrefix(bytes) {
  let offset = bytes.length >= 3 && bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))
    ? 3
    : 0;
  const line = () => {
    if (offset >= bytes.length) return null;
    const start = offset;
    while (offset < bytes.length && bytes[offset] !== 0x0a && bytes[offset] !== 0x0d) {
      offset += 1;
    }
    const end = offset;
    if (offset < bytes.length && bytes[offset] === 0x0d) offset += 1;
    if (offset < bytes.length && bytes[offset] === 0x0a) offset += 1;
    return { value: bytes.subarray(start, end).toString("utf8"), end: offset };
  };
  const opening = line();
  if (opening?.value !== "---") return null;
  while (true) {
    const current = line();
    if (current === null) return null;
    if (current.value === "---") return bytes.subarray(0, current.end);
  }
}

function wikiTokens(body) {
  const tokens = [];
  const pattern = /\[\[[^\]\r\n]*\]\]/gu;
  for (const match of body.matchAll(pattern)) tokens.push(match[0]);
  return tokens;
}

function multiset(values) {
  const result = new Map();
  for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
  return result;
}

function linkReferenceCounts(note) {
  const counts = new Map();
  for (const reference of note.linkReferences ?? []) {
    const key = `${portableIdentity(reference.target)}\0${portableIdentity(reference.heading ?? "")}`;
    counts.set(key, {
      count: reference.occurrences,
      target: reference.target,
    });
  }
  return counts;
}

function bodyWithoutWikiLinks(body) {
  return body.replace(/\[\[[^\]\r\n]*\]\]/gu, "").replace(/\s+/gu, " ").trim();
}

function assertLinkAddition(context, projectionByPath, projection) {
  const after = requireUpdate(context, projectionByPath, "link.add");
  const before = parseExactNote(context.exact.path, context.exact.before);
  if (before.currentSchema !== true) {
    throw semanticError("link.add requires an existing current-schema note.", {
      path: context.exact.path,
    });
  }
  const beforePrefix = frontmatterPrefix(context.exact.before);
  const afterPrefix = frontmatterPrefix(context.exact.after);
  if (
    beforePrefix === null ||
    afterPrefix === null ||
    !beforePrefix.equals(afterPrefix)
  ) {
    throw semanticError("link.add must preserve the exact frontmatter bytes.", {
      path: context.exact.path,
    });
  }
  const beforeBody = before.lexicalSource.body;
  const afterBody = parseExactNote(context.exact.path, context.exact.after).lexicalSource.body;
  if (bodyWithoutWikiLinks(beforeBody) !== bodyWithoutWikiLinks(afterBody)) {
    throw semanticError("link.add may add links and whitespace, but cannot change body prose.", {
      path: context.exact.path,
    });
  }
  const priorTokens = multiset(wikiTokens(beforeBody));
  const resultingTokens = multiset(wikiTokens(afterBody));
  for (const [token, count] of priorTokens) {
    if ((resultingTokens.get(token) ?? 0) < count) {
      throw semanticError("link.add cannot remove or rewrite an existing wiki link.", {
        path: context.exact.path,
      });
    }
  }
  const beforeReferences = linkReferenceCounts(before);
  const afterReferences = linkReferenceCounts(after);
  let additions = 0;
  const addedTargets = [];
  for (const [key, reference] of afterReferences) {
    const added = reference.count - (beforeReferences.get(key)?.count ?? 0);
    if (added <= 0) continue;
    additions += added;
    addedTargets.push(reference.target);
  }
  if (additions === 0) {
    throw semanticError("link.add must add at least one parsed wiki-link occurrence.", {
      path: context.exact.path,
    });
  }
  if (typeof projection.linkGraph?.resolveReference !== "function") {
    throw semanticError("link.add requires a complete projected link graph.", {
      path: context.exact.path,
    });
  }
  for (const target of addedTargets.sort(portableCompare)) {
    if (projection.linkGraph.resolveReference(target).status !== "resolved") {
      throw semanticError("link.add must add only unambiguous, resolving wiki links.", {
        path: context.exact.path,
        target,
      });
    }
  }
}

function assertDecisionAccept(context, projectionByPath) {
  const after = context.exact.before === null
    ? requireCreate(context, projectionByPath, "decision.accept")
    : requireUpdate(context, projectionByPath, "decision.accept");
  if (
    after.frontmatter.kind !== "decision" ||
    after.frontmatter.authority !== "canonical" ||
    after.frontmatter.state !== "accepted" ||
    !relationsUseUniquePortableIdentities(after)
  ) {
    throw semanticError("decision.accept must produce one accepted canonical decision.", {
      path: context.exact.path,
    });
  }
  const afterSupersedes = normalizedRelationSet(after, "supersedes");
  const afterSupersededBy = normalizedRelationSet(after, "superseded_by");
  if (context.exact.before === null) {
    if (afterSupersedes.size > 0 || afterSupersededBy.size > 0) {
      throw semanticError("decision.accept cannot disguise a supersession operation.", {
        path: context.exact.path,
      });
    }
    return;
  }
  const before = context.beforeValidated;
  if (
    before?.currentSchema !== true ||
    before.frontmatter.kind !== "decision" ||
    before.frontmatter.authority !== "canonical" ||
    !relationsUseUniquePortableIdentities(before)
  ) {
    throw semanticError("decision.accept updates must start from a canonical decision.", {
      path: context.exact.path,
    });
  }
  requireFieldsPreserved(
    before,
    after,
    ["id", "kind", "scope", "authority", "decision_key"],
    "decision.accept",
    context.exact.path,
  );
  if (
    !sameSet(normalizedRelationSet(before, "supersedes"), afterSupersedes) ||
    !sameSet(normalizedRelationSet(before, "superseded_by"), afterSupersededBy)
  ) {
    throw semanticError("decision.accept cannot disguise a supersession operation.", {
      path: context.exact.path,
    });
  }
}

function assertDecisionIdentityPreserved(context, after) {
  const before = context.beforeValidated;
  if (before === null) {
    if (
      after.frontmatter.kind !== "decision" ||
      after.frontmatter.authority !== "canonical" ||
      !relationsUseUniquePortableIdentities(after)
    ) {
      throw semanticError(
        "decision.supersede may create only one canonical decision successor.",
        { path: context.exact.path },
      );
    }
    return null;
  }
  if (
    before?.currentSchema !== true ||
    before.frontmatter.kind !== "decision" ||
    before.frontmatter.authority !== "canonical" ||
    after.frontmatter.kind !== "decision" ||
    after.frontmatter.authority !== "canonical" ||
    !relationsUseUniquePortableIdentities(before) ||
    !relationsUseUniquePortableIdentities(after)
  ) {
    throw semanticError("decision.supersede requires two existing canonical decisions.", {
      path: context.exact.path,
    });
  }
  requireFieldsPreserved(
    before,
    after,
    ["id", "kind", "scope", "authority", "decision_key"],
    "decision.supersede",
    context.exact.path,
  );
  return before;
}

function supersessionOrientation(successor, predecessor, successorAfter, predecessorAfter) {
  const successorBefore = successor.beforeValidated;
  const predecessorBefore = predecessor.beforeValidated;
  const beforeSuccessorSupersedes = normalizedRelationSet(successorBefore, "supersedes");
  const afterSuccessorSupersedes = normalizedRelationSet(successorAfter, "supersedes");
  const beforePredecessorSupersededBy = normalizedRelationSet(predecessorBefore, "superseded_by");
  const afterPredecessorSupersededBy = normalizedRelationSet(predecessorAfter, "superseded_by");
  const addedFromSuccessor = setDifference(afterSuccessorSupersedes, beforeSuccessorSupersedes);
  const addedToPredecessor = setDifference(afterPredecessorSupersededBy, beforePredecessorSupersededBy);
  return (
    addedFromSuccessor.length === 1 &&
    addedToPredecessor.length === 1 &&
    relationTargets(addedFromSuccessor[0], predecessorAfter) &&
    relationTargets(addedToPredecessor[0], successorAfter) &&
    setDifference(beforeSuccessorSupersedes, afterSuccessorSupersedes).length === 0 &&
    setDifference(beforePredecessorSupersededBy, afterPredecessorSupersededBy).length === 0 &&
    sameSet(
      normalizedRelationSet(successorBefore, "superseded_by"),
      normalizedRelationSet(successorAfter, "superseded_by"),
    ) &&
    sameSet(
      normalizedRelationSet(predecessorBefore, "supersedes"),
      normalizedRelationSet(predecessorAfter, "supersedes"),
    )
  );
}

function assertDecisionSupersede(contexts, projectionByPath) {
  const after = contexts.map((context) =>
    context.exact.before === null
      ? requireCreate(context, projectionByPath, "decision.supersede")
      : requireUpdate(context, projectionByPath, "decision.supersede"));
  contexts.forEach((context, index) => assertDecisionIdentityPreserved(context, after[index]));
  const orientations = [
    { successor: 0, predecessor: 1 },
    { successor: 1, predecessor: 0 },
  ].filter(({ successor, predecessor }) =>
    supersessionOrientation(
      contexts[successor],
      contexts[predecessor],
      after[successor],
      after[predecessor],
    ));
  if (orientations.length !== 1) {
    throw semanticError(
      "decision.supersede must add exactly one new reciprocal predecessor-successor relation.",
      { paths: contexts.map((context) => context.exact.path).sort(portableCompare) },
    );
  }
  const { successor, predecessor } = orientations[0];
  if (
    after[successor].frontmatter.state !== "accepted" ||
    after[predecessor].frontmatter.state !== "superseded" ||
    contexts[successor].beforeValidated?.frontmatter.state === "accepted" ||
    contexts[predecessor].beforeValidated === null ||
    contexts[predecessor].beforeValidated.frontmatter.state === "superseded" ||
    after[successor].frontmatter.scope !== after[predecessor].frontmatter.scope
  ) {
    throw semanticError(
      "decision.supersede must accept one successor and supersede one same-scope predecessor.",
      { paths: contexts.map((context) => context.exact.path).sort(portableCompare) },
    );
  }
}

function assertHubRefresh(context, projectionByPath) {
  const after = requireUpdate(context, projectionByPath, "hub.refresh");
  const before = context.beforeValidated;
  for (const note of [before, after]) {
    if (
      note?.currentSchema !== true ||
      note.frontmatter.kind !== "project" ||
      note.frontmatter.authority !== "canonical" ||
      note.frontmatter.state !== "active"
    ) {
      throw semanticError("hub.refresh requires one existing active canonical project hub.", {
        path: context.exact.path,
      });
    }
  }
  requireFieldsPreserved(
    before,
    after,
    ["id", "kind", "scope", "authority", "state"],
    "hub.refresh",
    context.exact.path,
  );
}

function assertSessionRecord(context, projectionByPath) {
  const after = requireCreate(context, projectionByPath, "session.record");
  if (
    after.frontmatter.kind !== "session" ||
    after.frontmatter.authority !== "historical"
  ) {
    throw semanticError("session.record must create one historical session note.", {
      path: context.exact.path,
    });
  }
}

function assertOperationSemantics(operation, contexts, projectionByPath, projection) {
  switch (operation.kind) {
    case "note.create":
      requireCreate(contexts[0], projectionByPath, "note.create");
      break;
    case "note.update":
      requireUpdate(contexts[0], projectionByPath, "note.update");
      break;
    case "note.move": {
      const removed = contexts.find((context) => context.exact.after === null);
      const created = contexts.find((context) => context.exact.before === null);
      if (
        removed === undefined ||
        created === undefined ||
        removed.exact.before === null ||
        created.exact.after === null ||
        !removed.exact.before.equals(created.exact.after)
      ) {
        throw semanticError("note.move requires one exact deletion and byte-identical creation.", {
          operationId: operation.operationId,
        });
      }
      requireValidPostNote(created, projectionByPath, "note.move destination");
      break;
    }
    case "link.add":
      assertLinkAddition(contexts[0], projectionByPath, projection);
      break;
    case "decision.accept":
      assertDecisionAccept(contexts[0], projectionByPath);
      break;
    case "decision.supersede":
      assertDecisionSupersede(contexts, projectionByPath);
      break;
    case "hub.refresh":
      assertHubRefresh(contexts[0], projectionByPath);
      break;
    case "session.record":
      assertSessionRecord(contexts[0], projectionByPath);
      break;
    default:
      throw semanticError("Proposal operation kind has no executable semantic meaning.", {
        operationId: operation.operationId,
        kind: operation.kind,
      });
  }
}

function declaredCanonical(note) {
  return (
    note?.currentSchema === true &&
    note.frontmatter?.authority === "canonical"
  );
}

function canonicalIdentity(note) {
  if (!declaredCanonical(note)) return null;
  const kind = portableIdentity(note.frontmatter.kind);
  const scope = portableIdentity(note.frontmatter.scope);
  if (kind === "project") return { kind, scope, key: "" };
  if (kind === "decision") {
    return {
      kind,
      scope,
      key: portableIdentity(note.frontmatter.decision_key),
    };
  }
  if (kind === "concept") {
    return {
      kind,
      scope,
      key: portableIdentity(note.frontmatter.id),
    };
  }
  return null;
}

function identityClaims(inspectionByPath, identity, options = {}) {
  const matches = [];
  for (const note of inspectionByPath.values()) {
    const candidate = canonicalIdentity(note);
    if (
      candidate === null ||
      candidate.kind !== identity.kind ||
      candidate.scope !== identity.scope ||
      candidate.key !== identity.key
    ) {
      continue;
    }
    if (options.activeOnly === true && note.frontmatter.state !== "active") {
      continue;
    }
    matches.push(note);
  }
  return matches.sort((left, right) => portableCompare(left.path, right.path));
}

function boundedClaimDetails(operation, identity, claims) {
  return {
    operationId: operation.operationId,
    kind: identity.kind,
    scope: identity.scope,
    key: identity.key,
    paths: claims.slice(0, 16).map((note) => note.path),
    claimCount: claims.length,
    omittedClaims: Math.max(0, claims.length - 16),
  };
}

function requireExistingOwner(
  operation,
  context,
  after,
  inspectionByPath,
  options = {},
) {
  const identity = canonicalIdentity(after);
  if (identity === null) return;
  const claims = identityClaims(inspectionByPath, identity, options);
  if (claims.length !== 1 || claims[0].path !== context.exact.path) {
    throw semanticError(
      claims.length > 1
        ? "Canonical ownership is ambiguous and must be repaired before capture."
        : "The operation does not target the unique existing canonical owner.",
      boundedClaimDetails(operation, identity, claims),
    );
  }
}

function assertCreateAdmission(
  operation,
  context,
  after,
  inspectionByPath,
) {
  const kind = after.frontmatter.kind;
  if (kind === "project" || kind === "atlas") {
    throw semanticError(
      "Ordinary capture cannot create project hubs or atlas routing notes; setup or adoption owns that boundary.",
      { operationId: operation.operationId, path: context.exact.path, kind },
    );
  }
  if (kind === "session" && operation.kind !== "session.record") {
    throw semanticError(
      "Historical session creation must use session.record.",
      { operationId: operation.operationId, path: context.exact.path },
    );
  }
  if (
    kind === "decision" &&
    !["decision.accept", "decision.supersede"].includes(operation.kind)
  ) {
    throw semanticError(
      "Canonical decision creation must use decision.accept or decision.supersede.",
      { operationId: operation.operationId, path: context.exact.path },
    );
  }
  if (!declaredCanonical(after)) return;
  if (!CANONICAL_CREATION_KINDS.has(kind)) {
    throw semanticError(
      "This canonical note kind is not eligible for ordinary capture creation.",
      { operationId: operation.operationId, path: context.exact.path, kind },
    );
  }
  if (kind === "concept" && after.frontmatter.state !== "active") {
    throw semanticError(
      "A newly governed concept must be active.",
      { operationId: operation.operationId, path: context.exact.path },
    );
  }
  if (kind === "decision" && operation.kind === "decision.supersede") return;
  const identity = canonicalIdentity(after);
  const claims = identityClaims(inspectionByPath, identity);
  if (claims.length > 0) {
    throw semanticError(
      claims.length === 1
        ? "A canonical owner already exists; capture must edit it instead of creating a competing note."
        : "Canonical ownership is ambiguous and must be repaired before capture.",
      boundedClaimDetails(operation, identity, claims),
    );
  }
}

function assertCanonicalOwnerAdmission(
  operation,
  contexts,
  inspectionByPath,
  projectionByPath,
) {
  for (const context of contexts) {
    const after = context.exact.after === null
      ? null
      : projectionByPath.get(context.exact.path);
    if (after === null || after === undefined) continue;
    if (context.exact.before === null) {
      // A move relocates one existing identity byte-for-byte; it does not
      // claim that new independently governed knowledge was created.
      if (operation.kind !== "note.move") {
        assertCreateAdmission(operation, context, after, inspectionByPath);
      }
      continue;
    }
    if (!declaredCanonical(after)) continue;
    if (after.frontmatter.kind === "project") {
      if (operation.kind !== "hub.refresh") {
        throw semanticError(
          "Canonical project hubs must be edited with hub.refresh.",
          { operationId: operation.operationId, path: context.exact.path },
        );
      }
      requireExistingOwner(
        operation,
        context,
        after,
        inspectionByPath,
        { activeOnly: true },
      );
      continue;
    }
    if (
      after.frontmatter.kind === "decision" &&
      after.frontmatter.state === "accepted"
    ) {
      if (operation.kind === "decision.supersede") continue;
      if (operation.kind !== "decision.accept") {
        throw semanticError(
          "Accepted canonical decisions must be edited with a decision operation.",
          { operationId: operation.operationId, path: context.exact.path },
        );
      }
      requireExistingOwner(operation, context, after, inspectionByPath);
      continue;
    }
    if (after.frontmatter.kind === "concept") {
      requireExistingOwner(operation, context, after, inspectionByPath);
    }
  }
}

function isCanonical(note) {
  return note?.authorityClass === "canonical" || note?.authorityClass === "routing";
}

function fieldChanged(before, after, field) {
  return !exactValue(before?.frontmatter?.[field], after?.frontmatter?.[field]);
}

function topologyChanged(before, after) {
  if (before === null || after === null) return false;
  if (TOPOLOGY_FIELDS.some((field) => fieldChanged(before, after, field))) return true;
  if (
    !sameSet(normalizedRelationSet(before, "supersedes"), normalizedRelationSet(after, "supersedes")) ||
    !sameSet(normalizedRelationSet(before, "superseded_by"), normalizedRelationSet(after, "superseded_by"))
  ) {
    return true;
  }
  if (
    (before.frontmatter.kind === "decision" || after.frontmatter.kind === "decision") &&
    (before.frontmatter.state === "accepted" || after.frontmatter.state === "accepted" ||
      before.frontmatter.state === "superseded" || after.frontmatter.state === "superseded") &&
    fieldChanged(before, after, "state")
  ) {
    return true;
  }
  return (
    (before.frontmatter.kind === "project" || after.frontmatter.kind === "project") &&
    (before.frontmatter.state === "active" || after.frontmatter.state === "active") &&
    fieldChanged(before, after, "state")
  );
}

function impactForChange(context, projectionByPath) {
  const before = context.beforeValidated;
  const after = context.exact.after === null
    ? null
    : projectionByPath.get(context.exact.path);
  if (topologyChanged(before, after)) {
    return { level: "authority-changing", reason: IMPACT_REASONS.authorityTopology };
  }
  if (after === null) {
    if (isCanonical(before)) {
      return { level: "authority-changing", reason: IMPACT_REASONS.canonicalRemoval };
    }
    if (before?.authorityClass === "supporting") {
      return { level: "supporting", reason: IMPACT_REASONS.supporting };
    }
    return { level: "none", reason: IMPACT_REASONS.nonAuthoritative };
  }
  if (before === null) {
    if (
      after.frontmatter.kind === "decision" &&
      after.frontmatter.authority === "canonical" &&
      after.frontmatter.state === "accepted"
    ) {
      return { level: "authority-changing", reason: IMPACT_REASONS.decisionAcceptance };
    }
    if (
      after.frontmatter.kind === "project" &&
      after.frontmatter.authority === "canonical" &&
      after.frontmatter.state === "active"
    ) {
      return { level: "authority-changing", reason: IMPACT_REASONS.hubActivation };
    }
    if (after.authorityClass === "routing") {
      return { level: "authority-changing", reason: IMPACT_REASONS.routingCreation };
    }
    if (after.authorityClass === "canonical") {
      return { level: "canonical-content", reason: IMPACT_REASONS.canonicalContent };
    }
    if (after.authorityClass === "supporting") {
      return { level: "supporting", reason: IMPACT_REASONS.supporting };
    }
    return { level: "none", reason: IMPACT_REASONS.nonAuthoritative };
  }
  if (
    after.frontmatter.kind === "decision" &&
    after.frontmatter.authority === "canonical" &&
    after.frontmatter.state === "accepted" &&
    before.frontmatter.state !== "accepted"
  ) {
    return { level: "authority-changing", reason: IMPACT_REASONS.decisionAcceptance };
  }
  if (isCanonical(before) || isCanonical(after)) {
    return { level: "canonical-content", reason: IMPACT_REASONS.canonicalContent };
  }
  if (before.authorityClass === "supporting" || after.authorityClass === "supporting") {
    return { level: "supporting", reason: IMPACT_REASONS.supporting };
  }
  return { level: "none", reason: IMPACT_REASONS.nonAuthoritative };
}

function computeAuthorityImpact(contextsByOperation, projectionByPath) {
  let level = "none";
  const reasons = new Set();
  const paths = new Set();
  for (const contexts of contextsByOperation.values()) {
    for (const context of contexts) {
      paths.add(context.exact.path);
      const impact = impactForChange(context, projectionByPath);
      if (IMPACT_RANK[impact.level] > IMPACT_RANK[level]) level = impact.level;
      reasons.add(impact.reason);
    }
  }
  return {
    level,
    reasons: [...reasons].sort(portableCompare),
    paths: [...paths].sort(portableCompare),
  };
}

function boundedTokens(...values) {
  const tokens = new Set();
  for (const value of values) {
    if (typeof value !== "string") continue;
    for (const match of value.normalize("NFKC").toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
      if (match[0].length < 2) continue;
      tokens.add(match[0]);
      if (tokens.size >= PROPOSAL_SEMANTICS_POLICY.maximumDuplicateTokens) {
        return tokens;
      }
    }
  }
  return tokens;
}

function jaccard(left, right) {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) intersection += Number(right.has(token));
  return intersection / (left.size + right.size - intersection);
}

function normalizedText(value) {
  return typeof value === "string"
    ? value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim()
    : "";
}

function boundedReasonPath(path) {
  const characters = [...path];
  if (characters.length <= 320) return path;
  return `${characters.slice(0, 159).join("")}\u2026${characters.slice(-160).join("")}`;
}

function duplicateFeatures(note) {
  const id = normalizedText(note.frontmatter.id);
  const title = normalizedText(note.title);
  const summary = normalizedText(note.frontmatter.summary);
  const kind = normalizedText(note.frontmatter.kind);
  const scope = normalizedText(note.frontmatter.scope);
  const decisionKey = normalizedText(note.frontmatter.decision_key);
  return Object.freeze({
    note,
    id,
    title,
    summary,
    kind,
    scope,
    decisionKey,
    tokens: boundedTokens(id, title, summary),
  });
}

function duplicateSimilarity(created, candidate) {
  if (created.id !== "" && created.id === candidate.id) {
    return { similarity: 1, basis: "an exact note ID match" };
  }
  if (
    created.kind === "decision" &&
    candidate.kind === "decision" &&
    created.scope === candidate.scope &&
    created.decisionKey !== "" &&
    created.decisionKey === candidate.decisionKey
  ) {
    return { similarity: 0.99, basis: "the same decision scope and key" };
  }
  if (created.title !== "" && created.title === candidate.title) {
    return { similarity: 0.95, basis: "an exact title match" };
  }
  if (created.summary !== "" && created.summary === candidate.summary) {
    return { similarity: 0.9, basis: "an exact summary match" };
  }
  const similarity = jaccard(created.tokens, candidate.tokens);
  const adjusted = similarity *
    (created.kind === candidate.kind ? 1 : 0.75) *
    (created.scope === candidate.scope ? 1 : 0.9);
  return {
    similarity: Math.round(adjusted * 1_000_000) / 1_000_000,
    basis: "similar identity, title, and summary tokens",
  };
}

function addDuplicatePosting(index, key, position) {
  if (key === "") return;
  const postings = index.get(key) ?? [];
  postings.push(position);
  index.set(key, postings);
}

function exactDecisionIdentity(features) {
  return features.kind === "decision" && features.decisionKey !== ""
    ? `${features.scope}\u0000${features.decisionKey}`
    : "";
}

function buildDuplicateIndex(notes) {
  const features = notes.map(duplicateFeatures);
  const indexes = {
    id: new Map(),
    title: new Map(),
    summary: new Map(),
    decision: new Map(),
    token: new Map(),
  };
  let tokenPostings = 0;
  features.forEach((entry, position) => {
    addDuplicatePosting(indexes.id, entry.id, position);
    addDuplicatePosting(indexes.title, entry.title, position);
    addDuplicatePosting(indexes.summary, entry.summary, position);
    addDuplicatePosting(indexes.decision, exactDecisionIdentity(entry), position);
    for (const token of entry.tokens) {
      tokenPostings += 1;
      if (tokenPostings > PROPOSAL_SEMANTICS_POLICY.maximumDuplicateTokenPostings) {
        throw semanticError("Duplicate detection exceeds its bounded token-index work limit.", {
          tokenPostings,
          limit: PROPOSAL_SEMANTICS_POLICY.maximumDuplicateTokenPostings,
        });
      }
      addDuplicatePosting(indexes.token, token, position);
    }
  });
  return { features, indexes, tokenPostings };
}

function indexedDuplicatePositions(features, indexes) {
  const positions = new Set();
  const include = (index, key) => {
    if (key === "") return;
    for (const position of index.get(key) ?? []) positions.add(position);
  };
  include(indexes.id, features.id);
  include(indexes.title, features.title);
  include(indexes.summary, features.summary);
  include(indexes.decision, exactDecisionIdentity(features));
  for (const token of features.tokens) include(indexes.token, token);
  return [...positions].sort((left, right) => left - right);
}

function createdKnowledgePaths(input, contextsByOperation) {
  const result = new Set();
  for (const operation of input.operations) {
    if (operation.kind === "note.move") continue;
    for (const context of contextsByOperation.get(operation)) {
      if (context.exact.before === null && context.exact.after !== null) {
        result.add(context.exact.path);
      }
    }
  }
  return result;
}

function duplicateCandidates(input, contextsByOperation, inspectionByPath, projectionByPath) {
  const createdPaths = createdKnowledgePaths(input, contextsByOperation);
  const removedPaths = new Set(
    [...contextsByOperation.values()].flat().filter((context) => context.exact.after === null)
      .map((context) => context.exact.path),
  );
  const bestByCandidate = new Map();
  const existing = [...inspectionByPath.values()]
    .filter((note) => note.currentSchema === true && note.authorityClass !== "quarantined")
    .filter((note) => !removedPaths.has(note.path))
    .filter((note) => {
      try {
        assertPortableGraphPath(note.path);
        return true;
      } catch {
        return false;
      }
    })
    .sort((left, right) => portableCompare(left.path, right.path));
  const duplicateIndex = buildDuplicateIndex(existing);
  let comparisons = 0;

  for (const createdPath of [...createdPaths].sort(portableCompare)) {
    const created = duplicateFeatures(projectionByPath.get(createdPath));
    const positions = indexedDuplicatePositions(created, duplicateIndex.indexes);
    comparisons += positions.length;
    if (comparisons > PROPOSAL_SEMANTICS_POLICY.maximumDuplicateComparisons) {
      throw semanticError("Duplicate detection exceeds its bounded comparison work limit.", {
        comparisons,
        limit: PROPOSAL_SEMANTICS_POLICY.maximumDuplicateComparisons,
      });
    }
    for (const position of positions) {
      const candidate = duplicateIndex.features[position];
      const score = duplicateSimilarity(created, candidate);
      if (score.similarity < PROPOSAL_SEMANTICS_POLICY.duplicateSimilarityThreshold) continue;
      const entry = {
        path: candidate.note.path,
        similarity: score.similarity,
        reason: `Potential duplicate of ${boundedReasonPath(createdPath)} based on ${score.basis}.`,
      };
      const current = bestByCandidate.get(candidate.note.path);
      if (
        current === undefined ||
        entry.similarity > current.similarity ||
        (entry.similarity === current.similarity && portableCompare(entry.reason, current.reason) < 0)
      ) {
        bestByCandidate.set(candidate.note.path, entry);
      }
    }
  }
  return [...bestByCandidate.values()]
    .sort((left, right) =>
      right.similarity - left.similarity ||
      portableCompare(left.path, right.path) ||
      portableCompare(left.reason, right.reason))
    .slice(0, PROPOSAL_SEMANTICS_POLICY.maximumDuplicateCandidates);
}

function projectedValidationDigest(projection) {
  const binding = {
    reportSchemaVersion: projection.report.reportSchemaVersion,
    specification: projection.report.specification,
    ok: projection.ok,
    graph: projection.report.graph,
    summary: projection.report.summary,
    errorFingerprints: projection.errorFingerprints,
    affectedAuthorityConflicts: projection.report.affectedAuthorityConflicts,
    findings: projection.findings,
  };
  return `sha256:${createHash("sha256")
    .update("syncora-projected-validation-assessment-v1\n", "utf8")
    .update(canonicalProposalJson(binding), "utf8")
    .digest("hex")}`;
}

/**
 * Enforce semantic operation meanings against the exact current and projected
 * graph images, then return the kernel-authored proposal assessment.
 *
 * This function is deterministic and performs no filesystem writes.
 */
export function assessProposalSemantics(
  proposalInput,
  inspection,
  exactChanges,
  projectedGraph,
) {
  const input = parseProposalInput(proposalInput);
  const inspectionByPath = baselineIndex(inspection);
  const contextsByOperation = bindExactChanges(input, inspectionByPath, exactChanges);
  const projectionByPath = projectedIndex(projectedGraph, inspection, exactChanges);

  for (const operation of input.operations) {
    assertOperationSemantics(
      operation,
      contextsByOperation.get(operation),
      projectionByPath,
      projectedGraph,
    );
    assertCanonicalOwnerAdmission(
      operation,
      contextsByOperation.get(operation),
      inspectionByPath,
      projectionByPath,
    );
  }

  return parseProposalAssessment({
    authorityImpact: computeAuthorityImpact(contextsByOperation, projectionByPath),
    reviewRequired: true,
    projectedValidation: {
      valid: true,
      findingCount: projectedGraph.findings.count,
      digest: projectedValidationDigest(projectedGraph),
      projectedGraphRevision: projectedGraph.graphRevision,
    },
    duplicateCandidates: duplicateCandidates(
      input,
      contextsByOperation,
      inspectionByPath,
      projectionByPath,
    ),
  });
}
