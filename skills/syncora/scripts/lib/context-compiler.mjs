import {
  buildLexicalIndex,
  LEXICAL_PROFILES,
  searchLexicalIndex,
} from "./lexical-index.mjs";
import { SyncoraError } from "./cli.mjs";

export const CONTEXT_COMPILER_POLICY = Object.freeze({
  specification: "syncora-context-compiler-v1",
  minimumBudgetCharacters: 1_000,
  maximumBudgetCharacters: 64_000,
  maximumCases: 100,
  maximumIdentifiersPerCase: 256,
  maximumSelectedNotes: 100,
});

function portableCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compilerError(message, details = undefined) {
  return new SyncoraError("CONTEXT001", message, details);
}

function boundedIdentifier(value, label) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 200 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)
  ) {
    throw compilerError(`${label} is not a bounded identifier.`);
  }
  return value;
}

function identifierList(value, label) {
  if (
    !Array.isArray(value) ||
    value.length > CONTEXT_COMPILER_POLICY.maximumIdentifiersPerCase
  ) {
    throw compilerError(`${label} must be a bounded identifier array.`);
  }
  const result = value.map((item) => boundedIdentifier(item, label));
  if (new Set(result).size !== result.length) {
    throw compilerError(`${label} contains duplicate identifiers.`);
  }
  return result;
}

export function validateContextCase(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw compilerError("Context fixture case must be an object.");
  }
  const expected = [
    "caseId",
    "scope",
    "query",
    "budgetCharacters",
    "requiredIds",
    "evidenceIds",
    "forbiddenIds",
  ];
  const actual = Object.keys(value).sort();
  if (
    actual.length !== expected.length ||
    !actual.every((key, index) => key === [...expected].sort()[index])
  ) {
    throw compilerError("Context fixture case has missing or unknown fields.", {
      expected: [...expected].sort(),
      actual,
    });
  }
  const caseId = boundedIdentifier(value.caseId, "caseId");
  const scope = boundedIdentifier(value.scope, "scope");
  if (
    typeof value.query !== "string" ||
    value.query.trim().length < 1 ||
    [...value.query].length > 2_048
  ) {
    throw compilerError("Context fixture query must contain bounded text.");
  }
  if (
    !Number.isSafeInteger(value.budgetCharacters) ||
    value.budgetCharacters < CONTEXT_COMPILER_POLICY.minimumBudgetCharacters ||
    value.budgetCharacters > CONTEXT_COMPILER_POLICY.maximumBudgetCharacters
  ) {
    throw compilerError("Context fixture budget is outside the supported range.");
  }
  return {
    caseId,
    scope,
    query: value.query,
    budgetCharacters: value.budgetCharacters,
    requiredIds: identifierList(value.requiredIds, "requiredIds"),
    evidenceIds: identifierList(value.evidenceIds, "evidenceIds"),
    forbiddenIds: identifierList(value.forbiddenIds, "forbiddenIds"),
  };
}

function noteCost(note) {
  return Math.max(1, note.characterLength ?? 0);
}

function compactNote(note, lane, score = null) {
  return {
    lane,
    path: note.path,
    id: note.frontmatter.id,
    kind: note.frontmatter.kind,
    scope: note.frontmatter.scope,
    authorityClass: note.authorityClass,
    sourceSha256: `sha256:${note.rawSha256}`,
    characters: noteCost(note),
    ...(score === null ? {} : { score }),
  };
}

function sourceRefs(note) {
  const refs = note.frontmatter.source_refs;
  return Array.isArray(refs)
    ? refs.filter((item) => typeof item === "string" && item.length > 0)
    : [];
}

export async function compileContextPack({
  notes,
  graphRevision,
  rootIdentity,
  fixture,
}) {
  const request = validateContextCase(fixture);
  const usable = notes.filter(
    (note) =>
      note.currentSchema &&
      note.authorityClass !== "quarantined" &&
      typeof note.rawSha256 === "string" &&
      note.lexicalSource,
  );
  const byId = new Map();
  const duplicateIds = new Set();
  for (const note of usable) {
    const id = note.frontmatter.id;
    if (byId.has(id)) duplicateIds.add(id);
    else byId.set(id, note);
  }

  const missingRequiredIds = [];
  const missingEvidenceIds = [];
  const mandatory = [];
  const evidence = [];
  const selectedIds = new Set();

  function addUnique(target, note) {
    if (!note || selectedIds.has(note.frontmatter.id)) return;
    selectedIds.add(note.frontmatter.id);
    target.push(note);
  }

  for (const note of usable
    .filter(
      (item) =>
        item.frontmatter.kind === "atlas" &&
        item.frontmatter.state === "active",
    )
    .sort((left, right) => portableCompare(left.path, right.path))) {
    addUnique(mandatory, note);
  }
  for (const note of usable
    .filter(
      (item) =>
        item.frontmatter.kind === "project" &&
        item.frontmatter.state === "active" &&
        item.frontmatter.scope === request.scope,
    )
    .sort((left, right) => portableCompare(left.path, right.path))) {
    addUnique(mandatory, note);
  }
  for (const id of request.requiredIds) {
    const note = byId.get(id);
    if (!note) missingRequiredIds.push(id);
    else addUnique(mandatory, note);
  }
  for (const id of request.evidenceIds) {
    const note = byId.get(id);
    if (!note) missingEvidenceIds.push(id);
    else addUnique(evidence, note);
  }

  const omittedMandatoryForLimit = [];
  if (mandatory.length > CONTEXT_COMPILER_POLICY.maximumSelectedNotes) {
    omittedMandatoryForLimit.push(
      ...mandatory
        .splice(CONTEXT_COMPILER_POLICY.maximumSelectedNotes)
        .map((note) => note.frontmatter.id),
    );
  }
  const remainingEvidenceSlots = Math.max(
    0,
    CONTEXT_COMPILER_POLICY.maximumSelectedNotes - mandatory.length,
  );
  if (evidence.length > remainingEvidenceSlots) {
    omittedMandatoryForLimit.push(
      ...evidence
        .splice(remainingEvidenceSlots)
        .map((note) => note.frontmatter.id),
    );
  }

  const index = await buildLexicalIndex({
    notes: usable,
    cachedPayload: null,
    graphRevision,
    rootIdentity,
    profile: LEXICAL_PROFILES.DEFAULT,
  });
  const ranked = searchLexicalIndex({
    payload: index.payload,
    notes: usable,
    query: request.query,
    limit: 50,
    includeHistory: false,
  });

  let usedCharacters = [...mandatory, ...evidence]
    .reduce((total, note) => total + noteCost(note), 0);
  const working = [];
  const omittedForBudget = [];
  const omittedForLimit = [];
  const forbidden = new Set(request.forbiddenIds);
  const scoreByPath = new Map(ranked.results.map((item) => [item.path, item.score]));
  for (const result of ranked.results) {
    const note = usable.find((item) => item.path === result.path);
    if (
      !note ||
      selectedIds.has(note.frontmatter.id) ||
      forbidden.has(note.frontmatter.id) ||
      note.frontmatter.scope !== request.scope
    ) {
      continue;
    }
    const cost = noteCost(note);
    if (
      mandatory.length + working.length + evidence.length >=
        CONTEXT_COMPILER_POLICY.maximumSelectedNotes
    ) {
      omittedForLimit.push(note.frontmatter.id);
      continue;
    }
    if (usedCharacters + cost > request.budgetCharacters) {
      omittedForBudget.push(note.frontmatter.id);
      continue;
    }
    addUnique(working, note);
    usedCharacters += cost;
  }

  const selected = [...mandatory, ...working, ...evidence];
  const forbiddenSelectedIds = selected
    .map((note) => note.frontmatter.id)
    .filter((id) => forbidden.has(id));
  const missingSourceMapIds = selected
    .filter((note) => sourceRefs(note).length === 0)
    .map((note) => note.frontmatter.id)
    .sort(portableCompare);
  const overflow = usedCharacters > request.budgetCharacters;
  const missingScopeHub = !mandatory.some(
    (note) =>
      note.frontmatter.kind === "project" &&
      note.frontmatter.scope === request.scope &&
      note.frontmatter.state === "active",
  );
  const duplicateSelectedIds = [...duplicateIds]
    .filter((id) => selectedIds.has(id))
    .sort(portableCompare);

  return {
    caseId: request.caseId,
    scope: request.scope,
    query: request.query,
    budget: {
      maximumCharacters: request.budgetCharacters,
      usedCharacters,
      overflow,
      omittedForBudget,
      omittedForLimit,
    },
    lanes: {
      mandatory: mandatory.map((note) => compactNote(note, "mandatory")),
      working: working.map((note) =>
        compactNote(note, "working", scoreByPath.get(note.path) ?? 0)),
      evidence: evidence.map((note) => compactNote(note, "evidence")),
    },
    sourceMap: selected.map((note) => ({
      id: note.frontmatter.id,
      path: note.path,
      sourceSha256: `sha256:${note.rawSha256}`,
      sourceRefs: sourceRefs(note),
    })),
    diagnostics: {
      missingRequiredIds,
      missingEvidenceIds,
      forbiddenSelectedIds,
      duplicateSelectedIds,
      missingSourceMapIds,
      missingScopeHub,
      omittedMandatoryForLimit,
    },
    pass:
      !overflow &&
      !missingScopeHub &&
      missingRequiredIds.length === 0 &&
      missingEvidenceIds.length === 0 &&
      forbiddenSelectedIds.length === 0 &&
      duplicateSelectedIds.length === 0 &&
      missingSourceMapIds.length === 0 &&
      omittedMandatoryForLimit.length === 0,
  };
}
