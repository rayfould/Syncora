import { SyncoraError } from "./cli.mjs";
import { isValidNoteIdentifier } from "./note-parser.mjs";
import { inspectWorkspace } from "./validate.mjs";
import {
  requireInitializedWorkspace,
  resolveWorkspace,
} from "./workspace.mjs";

export const CANONICAL_OWNER_SPECIFICATION =
  "syncora-canonical-owner-v1";
export const CANONICAL_OWNER_KINDS = Object.freeze([
  "project",
  "decision",
  "concept",
]);

const OWNER_KIND_SET = new Set(CANONICAL_OWNER_KINDS);
const MAXIMUM_RETURNED_CANDIDATES = 16;
const MAXIMUM_RETURNED_PATH_CHARACTERS = 256;
const MAXIMUM_EXPLICIT_OWNER_CHARACTERS = 4_096;
const UNSAFE_SCALAR_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u;

function ownerError(code, message, details = undefined) {
  return new SyncoraError(code, message, details);
}

function normalizeIdentity(value) {
  return typeof value === "string"
    ? value.trim().normalize("NFC").toLowerCase()
    : "";
}

function normalizePathIdentity(value) {
  return normalizeIdentity(value.replaceAll("\\", "/").replace(/\.md$/iu, ""));
}

function boundedPath(value) {
  const characters = [...value];
  if (characters.length <= MAXIMUM_RETURNED_PATH_CHARACTERS) return value;
  const marker = "...";
  return `${characters.slice(0, MAXIMUM_RETURNED_PATH_CHARACTERS - marker.length).join("")}${marker}`;
}

function portableCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeQuery(query) {
  if (query === null || typeof query !== "object" || Array.isArray(query)) {
    throw ownerError("OWNER001", "Canonical-owner query must be an object.");
  }
  const scope = typeof query.scope === "string" ? query.scope.trim() : "";
  const ownerKind = typeof query.ownerKind === "string"
    ? query.ownerKind.trim()
    : "";
  const ownerKey = query.ownerKey === undefined || query.ownerKey === null
    ? null
    : typeof query.ownerKey === "string"
      ? query.ownerKey.trim()
      : "";
  const explicitOwner = query.explicitOwner === undefined || query.explicitOwner === null
    ? null
    : typeof query.explicitOwner === "string"
      ? query.explicitOwner.trim()
      : "";

  if (!isValidNoteIdentifier(scope)) {
    throw ownerError(
      "OWNER001",
      "Canonical-owner scope must be a bounded portable identifier.",
    );
  }
  if (!OWNER_KIND_SET.has(ownerKind)) {
    throw ownerError(
      "OWNER001",
      "Canonical-owner kind must be project, decision, or concept.",
    );
  }
  if (ownerKind === "project" && ownerKey !== null) {
    throw ownerError(
      "OWNER001",
      "Project-hub resolution is keyed by scope and does not accept an owner key.",
    );
  }
  if (ownerKind !== "project" && !isValidNoteIdentifier(ownerKey)) {
    throw ownerError(
      "OWNER001",
      "Decision and concept resolution require a bounded portable owner key.",
    );
  }
  if (
    explicitOwner !== null &&
    (
      explicitOwner === "" ||
      [...explicitOwner].length > MAXIMUM_EXPLICIT_OWNER_CHARACTERS ||
      UNSAFE_SCALAR_PATTERN.test(explicitOwner)
    )
  ) {
    throw ownerError(
      "OWNER001",
      "Explicit canonical owner must be a bounded safe graph path or note ID.",
    );
  }

  return Object.freeze({ scope, ownerKind, ownerKey, explicitOwner });
}

function matchesQuery(note, query) {
  if (
    note.currentSchema !== true ||
    note.frontmatter?.authority !== "canonical" ||
    normalizeIdentity(note.frontmatter.scope ?? "") !==
      normalizeIdentity(query.scope) ||
    note.frontmatter.kind !== query.ownerKind
  ) {
    return false;
  }
  if (query.ownerKind === "project") {
    return note.frontmatter.state === "active";
  }
  if (query.ownerKind === "decision") {
    return (
      note.frontmatter.state === "accepted" &&
      normalizeIdentity(note.frontmatter.decision_key ?? "") ===
        normalizeIdentity(query.ownerKey)
    );
  }
  return (
    note.frontmatter.state === "active" &&
    normalizeIdentity(note.frontmatter.id ?? "") ===
      normalizeIdentity(query.ownerKey)
  );
}

function candidateSummary(note) {
  return Object.freeze({
    path: boundedPath(note.path),
    id: note.frontmatter.id,
    kind: note.frontmatter.kind,
    scope: note.frontmatter.scope,
    state: note.frontmatter.state,
    authorityClass: note.authorityClass,
  });
}

function exactExplicitMatches(notes, explicitOwner) {
  const pathIdentity = normalizePathIdentity(explicitOwner);
  const idIdentity = normalizeIdentity(explicitOwner);
  return notes.filter((note) =>
    normalizePathIdentity(note.path) === pathIdentity ||
    normalizeIdentity(note.frontmatter?.id ?? "") === idIdentity,
  );
}

export function resolveCanonicalOwnerFromNotes(notes, rawQuery) {
  if (!Array.isArray(notes)) {
    throw new TypeError("Canonical-owner resolution requires parsed notes.");
  }
  const query = normalizeQuery(rawQuery);
  const candidates = notes
    .filter((note) => matchesQuery(note, query))
    .sort((left, right) => portableCompare(left.path, right.path));

  if (candidates.length > 1) {
    return Object.freeze({
      state: "owner_ambiguous",
      reason: "multiple_canonical_claims",
      request: query,
      owner: null,
      candidates: Object.freeze(
        candidates.slice(0, MAXIMUM_RETURNED_CANDIDATES).map(candidateSummary),
      ),
      candidateCount: candidates.length,
      omittedCandidateCount: Math.max(
        0,
        candidates.length - MAXIMUM_RETURNED_CANDIDATES,
      ),
    });
  }

  if (candidates.length === 0) {
    if (query.explicitOwner !== null) {
      const explicitMatches = exactExplicitMatches(notes, query.explicitOwner);
      throw ownerError(
        "OWNER003",
        "Explicit owner does not identify a canonical owner for this query.",
        {
          explicitOwner: boundedPath(query.explicitOwner),
          matchCount: explicitMatches.length,
        },
      );
    }
    return Object.freeze({
      state: "owner_missing",
      reason: "no_canonical_claim",
      request: query,
      owner: null,
      candidates: Object.freeze([]),
      candidateCount: 0,
      omittedCandidateCount: 0,
    });
  }

  const owner = candidates[0];
  if (query.explicitOwner !== null) {
    const explicitMatches = exactExplicitMatches(notes, query.explicitOwner);
    if (explicitMatches.length !== 1 || explicitMatches[0] !== owner) {
      throw ownerError(
        "OWNER003",
        "Explicit owner does not identify the unique canonical owner for this query.",
        {
          explicitOwner: boundedPath(query.explicitOwner),
          matchCount: explicitMatches.length,
          canonicalOwner: boundedPath(owner.path),
        },
      );
    }
  }
  if (owner.authorityClass !== "canonical") {
    throw ownerError(
      "OWNER002",
      "The matching canonical-owner claim is quarantined or otherwise unusable.",
      {
        path: boundedPath(owner.path),
        authorityClass: owner.authorityClass,
      },
    );
  }

  return Object.freeze({
    state: "owner_found",
    reason: "unique_canonical_claim",
    request: query,
    owner: Object.freeze({
      ...candidateSummary(owner),
      expectedPriorSha256: `sha256:${owner.rawSha256}`,
    }),
    candidates: Object.freeze([]),
    candidateCount: 1,
    omittedCandidateCount: 0,
  });
}

export async function resolveCanonicalOwner(options) {
  const workspace = await resolveWorkspace(options.workspace);
  await requireInitializedWorkspace(workspace.realPath);
  const inspection = await inspectWorkspace(options);
  const resolution = resolveCanonicalOwnerFromNotes(inspection.notes, {
    scope: options.scope,
    ownerKind: options.ownerKind,
    ownerKey: options.ownerKey,
    explicitOwner: options.note,
  });
  return {
    ok: true,
    command: "resolve-owner",
    mode: "read-only",
    workspace: inspection.workspace.realPath,
    graph: {
      root: inspection.graph.resolvedGraphPath,
      revision: inspection.report.graph.revision,
      valid: inspection.report.ok,
      validationErrors: inspection.report.summary.diagnostics.error,
    },
    specification: CANONICAL_OWNER_SPECIFICATION,
    ...resolution,
  };
}
