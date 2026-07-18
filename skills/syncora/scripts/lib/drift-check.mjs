import { createHash } from "node:crypto";

import { SyncoraError } from "./cli.mjs";
import {
  DRIFT_FINDING_SPECIFICATION,
  parseDriftFindingPayload,
  parseDriftProposalBindingPayload,
  verifyDriftFindingFreshness,
} from "./drift-governance.mjs";
import { observeBoundSources } from "./drift-source.mjs";
import {
  createDriftState,
  listDriftProposalBindings,
  publishDriftDisposition,
  publishDriftFinding,
  publishDriftObservation,
  publishDriftRefresh,
  readDriftFinding,
  readDriftObservation,
  readDriftRefresh,
  readDriftState,
  resolveDriftArtifactPath,
  sealDriftDisposition,
  sealDriftFinding,
  sealDriftObservation,
  sealDriftRefresh,
  writeDriftState,
} from "./drift-state.mjs";
import {
  assertNoActiveMigration,
  resolveGovernedEnvironment,
} from "./governed-environment.mjs";
import {
  assertPortableGraphPath,
  assertPortableWorkspacePath,
  assertTaggedSha256,
} from "./proposal-schema.mjs";
import {
  listReceiptRecords,
  readStoredProposal,
} from "./proposal-store.mjs";
import {
  classifyNoteTargetBindings,
  parseTargetSpecifier,
} from "./target-bindings.mjs";
import { inspectWorkspaceUnlocked } from "./validate.mjs";
import {
  assertNoNonterminalFileTransaction,
  withCanonicalReadInterlock,
} from "./writer-interlock.mjs";

export const DRIFT_OBSERVATION_SPECIFICATION = "syncora-drift-observation-v1";
export const DRIFT_REFRESH_SPECIFICATION = "syncora-drift-refresh-v1";
export const DRIFT_DISPOSITION_SPECIFICATION = "syncora-drift-disposition-v1";

const AUTOMATIC_BINDING_KINDS = new Set(["file", "module", "path_glob"]);
const UNEVALUATED_BINDING_KINDS = new Set(["component", "symbol"]);
const ELIGIBLE_KINDS = new Set(["project", "decision", "concept", "reference"]);
const ELIGIBLE_AUTHORITIES = new Set(["canonical", "supporting"]);
const MAXIMUM_WARNINGS = 64;
const MAXIMUM_RETURNED_FINDINGS = 256;
const MAXIMUM_CHANGED_SOURCES = 10_000;

function driftError(code, message, details = undefined) {
  return new SyncoraError(code, message, details);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected, label) {
  if (!isPlainObject(value)) throw driftError("DRIFT001", `${label} must be a JSON object.`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    !actual.every((key, index) => key === wanted[index])
  ) {
    throw driftError("DRIFT001", `${label} contains missing or unknown fields.`);
  }
}

function tagged(value, label) {
  try {
    return assertTaggedSha256(value, label);
  } catch (error) {
    throw driftError("DRIFT001", `${label} is invalid.`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function boundedCount(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw driftError("DRIFT001", `${label} is invalid or excessive.`);
  }
  return value;
}

function pathKey(value) {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function portableCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function eligibleState(kind, state) {
  if (kind === "decision") return state === "accepted";
  return state === "active";
}

function eligibleNote(note) {
  return (
    note.currentSchema === true &&
    typeof note.rawSha256 === "string" &&
    /^[0-9a-f]{64}$/u.test(note.rawSha256) &&
    ELIGIBLE_KINDS.has(note.frontmatter.kind) &&
    ELIGIBLE_AUTHORITIES.has(note.authorityClass) &&
    eligibleState(note.frontmatter.kind, note.frontmatter.state)
  );
}

function warning(code, message, details = undefined) {
  return Object.freeze({ code, message, ...(details ? { details } : {}) });
}

function compileBindingPlan(notes) {
  const global = new Map();
  const trackedNotes = [];
  const warnings = [];
  let eligibleNotes = 0;
  let untypedBindings = 0;
  let invalidBindings = 0;
  let unevaluatedBindings = 0;

  for (const note of notes) {
    if (!eligibleNote(note)) continue;
    eligibleNotes += 1;
    const classification = classifyNoteTargetBindings(note);
    untypedBindings += classification.untyped.length;
    invalidBindings += classification.invalid.length;
    const noteBindings = new Map();
    for (const raw of note.frontmatter.applies_to ?? []) {
      if (typeof raw !== "string") continue;
      const separator = raw.indexOf(":");
      if (separator < 1) continue;
      const kind = raw.slice(0, separator);
      if (UNEVALUATED_BINDING_KINDS.has(kind)) {
        unevaluatedBindings += 1;
        continue;
      }
      if (!AUTOMATIC_BINDING_KINDS.has(kind)) continue;
      let parsed;
      try {
        parsed = parseTargetSpecifier(raw, "applies_to drift binding");
      } catch {
        continue;
      }
      const specifier = `${parsed.kind}:${parsed.ref}`;
      const binding = { specifier, kind: parsed.kind, ref: parsed.ref };
      noteBindings.set(specifier, binding);
      global.set(specifier, binding);
    }
    if (noteBindings.size > 0) {
      trackedNotes.push({
        path: note.path,
        sha256: `sha256:${note.rawSha256}`,
        kind: note.frontmatter.kind,
        state: note.frontmatter.state,
        scope: note.frontmatter.scope,
        authorityClass: note.authorityClass,
        bindings: [...noteBindings.values()].sort((left, right) =>
          portableCompare(left.specifier, right.specifier)),
      });
    }
  }

  if (untypedBindings > 0) {
    warnings.push(warning(
      "DRIFT_BINDING_UNTYPED",
      `${untypedBindings} legacy applies_to binding(s) were retained as evidence but granted no drift-selection authority.`,
    ));
  }
  if (invalidBindings > 0) {
    warnings.push(warning(
      "DRIFT_BINDING_INVALID",
      `${invalidBindings} malformed typed binding(s) were not evaluated.`,
    ));
  }
  if (unevaluatedBindings > 0) {
    warnings.push(warning(
      "DRIFT_BINDING_COVERAGE",
      `${unevaluatedBindings} symbol or component binding(s) remain unevaluated because no versioned symbol index is available.`,
    ));
  }
  return {
    bindings: [...global.values()].sort((left, right) =>
      portableCompare(left.specifier, right.specifier)),
    notes: trackedNotes.sort((left, right) => portableCompare(left.path, right.path)),
    coverage: {
      eligibleNotes,
      trackedNotes: trackedNotes.length,
      untypedBindings,
      invalidBindings,
      unevaluatedBindings,
    },
    warnings,
  };
}

function observationPayload({ inspection, plan, sources }) {
  const observedBindings = new Map(
    sources.bindings.map((binding) => [binding.specifier, binding]),
  );
  const files = new Map();
  const bindings = sources.bindings.map((binding) => {
    const filePaths = binding.files.map((file) => {
      const identity = pathKey(file.path);
      const existing = files.get(identity);
      if (
        existing !== undefined &&
        (existing.path !== file.path ||
          existing.bytes !== file.bytes ||
          existing.sha256 !== file.sha256)
      ) {
        throw driftError("DRIFT007", "Overlapping bindings produced conflicting file evidence.", {
          path: file.path,
        });
      }
      if (existing === undefined) files.set(identity, { ...file });
      return file.path;
    });
    return {
      specifier: binding.specifier,
      kind: binding.kind,
      ref: binding.ref,
      fingerprint: binding.fingerprint,
      fileCount: binding.fileCount,
      totalBytes: binding.totalBytes,
      files: filePaths,
    };
  });
  const notes = plan.notes.map((note) => ({
    path: note.path,
    sha256: note.sha256,
    kind: note.kind,
    state: note.state,
    scope: note.scope,
    authorityClass: note.authorityClass,
    bindings: note.bindings.map((binding) => {
      const observed = observedBindings.get(binding.specifier);
      if (!observed) {
        throw driftError("DRIFT007", "A planned drift binding has no complete source observation.", {
          note: note.path,
          binding: binding.specifier,
        });
      }
      return observed.specifier;
    }),
  }));
  return {
    specification: DRIFT_OBSERVATION_SPECIFICATION,
    authority: "exact-raw-byte-sha256",
    graphRevision: inspection.report.graph.revision,
    files: [...files.values()].sort((left, right) => portableCompare(left.path, right.path)),
    bindings,
    notes,
    coverage: {
      ...plan.coverage,
      trackedBindings: plan.bindings.length,
      trackedFiles: sources.coverage.uniqueFilesMatched,
      source: { ...sources.coverage },
    },
    git: { ...sources.git },
  };
}

function parseObservationFile(value, label) {
  exactKeys(value, ["path", "bytes", "sha256"], label);
  return {
    path: assertPortableWorkspacePath(value.path, `${label} path`),
    bytes: boundedCount(value.bytes, `${label} bytes`, 16_777_216),
    sha256: tagged(value.sha256, `${label} digest`),
  };
}

function aggregateObservationFileMap(files) {
  const hash = createHash("sha256");
  hash.update("syncora-drift-file-map-v1\0", "utf8");
  for (const file of files) {
    const pathBytes = Buffer.from(file.path, "utf8");
    const pathLength = Buffer.alloc(4);
    pathLength.writeUInt32BE(pathBytes.length);
    const size = Buffer.alloc(8);
    size.writeBigUInt64BE(BigInt(file.bytes));
    hash.update(pathLength);
    hash.update(pathBytes);
    hash.update(size);
    hash.update(Buffer.from(file.sha256.slice("sha256:".length), "hex"));
  }
  return `sha256:${hash.digest("hex")}`;
}

function strictlySorted(values, selector = (value) => value) {
  return values.every((value, index) =>
    index === 0 || portableCompare(selector(values[index - 1]), selector(value)) < 0);
}

function parseObservationBinding(value, index, filesByPath) {
  const label = `Drift observation binding ${index + 1}`;
  exactKeys(
    value,
    ["specifier", "kind", "ref", "fingerprint", "fileCount", "totalBytes", "files"],
    label,
  );
  if (
    !AUTOMATIC_BINDING_KINDS.has(value.kind) ||
    !Array.isArray(value.files) ||
    value.files.length > 50_000
  ) {
    throw driftError("DRIFT001", `${label} is unsupported or malformed.`);
  }
  const parsedSpecifier = parseTargetSpecifier(value.specifier, label);
  if (parsedSpecifier.kind !== value.kind || parsedSpecifier.ref !== value.ref) {
    throw driftError("DRIFT001", `${label} normalized fields disagree.`);
  }
  const filePaths = value.files.map((path, fileIndex) =>
    assertPortableWorkspacePath(path, `${label} file ${fileIndex + 1} path`));
  if (new Set(filePaths.map((path) => path.toLowerCase())).size !== filePaths.length) {
    throw driftError("DRIFT001", `${label} file references must be unique.`);
  }
  const files = filePaths.map((path) => {
    const file = filesByPath.get(pathKey(path));
    if (file === undefined || file.path !== path) {
      throw driftError("DRIFT001", `${label} references unavailable file evidence.`);
    }
    return file;
  });
  if (
    files.length !== boundedCount(value.fileCount, `${label} fileCount`, 50_000) ||
    files.reduce((total, file) => total + file.bytes, 0) !==
      boundedCount(value.totalBytes, `${label} totalBytes`, 536_870_912) ||
    !strictlySorted(files, (file) => file.path) ||
    aggregateObservationFileMap(files) !== tagged(value.fingerprint, `${label} fingerprint`)
  ) {
    throw driftError("DRIFT001", `${label} counts, ordering, or fingerprint disagree.`);
  }
  return {
    specifier: value.specifier,
    kind: value.kind,
    ref: value.ref,
    fingerprint: value.fingerprint,
    fileCount: files.length,
    totalBytes: value.totalBytes,
    files,
  };
}

function parseObservationNote(value, index, bindingsBySpecifier) {
  const label = `Drift observation note ${index + 1}`;
  exactKeys(
    value,
    ["path", "sha256", "kind", "state", "scope", "authorityClass", "bindings"],
    label,
  );
  if (
    !ELIGIBLE_KINDS.has(value.kind) ||
    !ELIGIBLE_AUTHORITIES.has(value.authorityClass) ||
    !eligibleState(value.kind, value.state) ||
    typeof value.scope !== "string" ||
    value.scope.length < 1 ||
    value.scope.length > 256 ||
    !Array.isArray(value.bindings) ||
    value.bindings.length < 1 ||
    value.bindings.length > 256
  ) {
    throw driftError("DRIFT001", `${label} eligibility fields are invalid.`);
  }
  const path = assertPortableGraphPath(value.path, `${label} path`);
  const specifiers = value.bindings.map((specifier, bindingIndex) =>
    boundedTextSpecifier(specifier, `${label} binding ${bindingIndex + 1}`));
  if (!strictlySorted(specifiers)) {
    throw driftError("DRIFT001", `${label} bindings must be unique and sorted.`);
  }
  const bindings = specifiers.map((specifier) => {
    const binding = bindingsBySpecifier.get(specifier);
    if (binding === undefined) {
      throw driftError("DRIFT001", `${label} references unavailable binding evidence.`);
    }
    return binding;
  });
  return {
    path,
    sha256: tagged(value.sha256, `${label} digest`),
    kind: value.kind,
    state: value.state,
    scope: value.scope,
    authorityClass: value.authorityClass,
    bindings,
  };
}

export function parseDriftObservationPayload(value) {
  exactKeys(
    value,
    [
      "specification",
      "authority",
      "graphRevision",
      "files",
      "bindings",
      "notes",
      "coverage",
      "git",
    ],
    "Drift observation payload",
  );
  if (
    value.specification !== DRIFT_OBSERVATION_SPECIFICATION ||
    value.authority !== "exact-raw-byte-sha256" ||
    !Array.isArray(value.files) ||
    value.files.length > 50_000 ||
    !Array.isArray(value.bindings) ||
    value.bindings.length > 10_000 ||
    !Array.isArray(value.notes) ||
    value.notes.length > 50_000 ||
    !isPlainObject(value.coverage) ||
    !isPlainObject(value.git)
  ) {
    throw driftError("DRIFT001", "Drift observation policy fields are invalid.");
  }
  const files = value.files.map((file, index) =>
    parseObservationFile(file, `Drift observation file ${index + 1}`));
  if (
    !strictlySorted(files, (file) => file.path) ||
    new Set(files.map((file) => file.path.toLowerCase())).size !== files.length
  ) {
    throw driftError("DRIFT001", "Drift observation file paths must be unique and sorted.");
  }
  const filesByPath = new Map(files.map((file) => [pathKey(file.path), file]));
  const bindings = value.bindings.map((binding, index) =>
    parseObservationBinding(binding, index, filesByPath));
  if (
    !strictlySorted(bindings, (binding) => binding.specifier) ||
    new Set(bindings.map((binding) => binding.specifier.toLowerCase())).size !== bindings.length
  ) {
    throw driftError("DRIFT001", "Drift observation bindings must be unique and sorted.");
  }
  const bindingsBySpecifier = new Map(
    bindings.map((binding) => [binding.specifier, binding]),
  );
  const notes = value.notes.map((note, index) =>
    parseObservationNote(note, index, bindingsBySpecifier));
  if (
    !strictlySorted(notes, (note) => note.path) ||
    new Set(notes.map((note) => note.path.toLowerCase())).size !== notes.length
  ) {
    throw driftError("DRIFT001", "Drift observation note paths must be unique and sorted.");
  }
  const referencedBindings = new Set(
    notes.flatMap((note) => note.bindings.map((binding) => binding.specifier)),
  );
  const referencedFiles = new Set(
    bindings.flatMap((binding) => binding.files.map((file) => pathKey(file.path))),
  );
  if (
    bindings.some((binding) => !referencedBindings.has(binding.specifier)) ||
    files.some((file) => !referencedFiles.has(pathKey(file.path))) ||
    value.coverage.trackedNotes !== notes.length ||
    value.coverage.trackedBindings !== bindings.length ||
    value.coverage.trackedFiles !== files.length ||
    value.coverage.source?.uniqueFilesMatched !== files.length ||
    value.coverage.source?.totalBytesHashed !==
      files.reduce((total, file) => total + file.bytes, 0)
  ) {
    throw driftError("DRIFT001", "Drift observation catalog and coverage counts disagree.");
  }
  return Object.freeze({
    specification: DRIFT_OBSERVATION_SPECIFICATION,
    authority: "exact-raw-byte-sha256",
    graphRevision: tagged(value.graphRevision, "Drift observation graph revision"),
    files,
    bindings,
    notes,
    coverage: value.coverage,
    git: value.git,
  });
}

function boundedTextSpecifier(value, label) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    [...value].length > 4_096 ||
    value !== value.normalize("NFC") ||
    /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)
  ) {
    throw driftError("DRIFT001", `${label} is invalid or excessive.`);
  }
  return value;
}

function fileMap(binding) {
  return new Map(binding.files.map((file) => [file.path, file]));
}

function sourceChanges(beforeBinding, currentBinding) {
  const before = fileMap(beforeBinding);
  const current = fileMap(currentBinding);
  const deleted = [];
  const added = [];
  const changed = [];
  for (const path of [...new Set([...before.keys(), ...current.keys()])].sort(portableCompare)) {
    const prior = before.get(path) ?? null;
    const next = current.get(path) ?? null;
    if (prior?.sha256 === next?.sha256 && prior?.bytes === next?.bytes) continue;
    if (prior === null) added.push(next);
    else if (next === null) deleted.push(prior);
    else {
      changed.push({
        path,
        change: "modified",
        beforeSha256: prior.sha256,
        currentSha256: next.sha256,
        beforeBytes: prior.bytes,
        currentBytes: next.bytes,
        renamedFrom: null,
      });
    }
  }

  const deletedByDigest = new Map();
  const addedByDigest = new Map();
  for (const file of deleted) {
    const list = deletedByDigest.get(file.sha256) ?? [];
    list.push(file);
    deletedByDigest.set(file.sha256, list);
  }
  for (const file of added) {
    const list = addedByDigest.get(file.sha256) ?? [];
    list.push(file);
    addedByDigest.set(file.sha256, list);
  }
  const pairedDeleted = new Set();
  const pairedAdded = new Set();
  for (const [digest, removed] of deletedByDigest) {
    const created = addedByDigest.get(digest) ?? [];
    if (removed.length !== 1 || created.length !== 1) continue;
    pairedDeleted.add(removed[0].path);
    pairedAdded.add(created[0].path);
    changed.push({
      path: created[0].path,
      change: "renamed",
      beforeSha256: removed[0].sha256,
      currentSha256: created[0].sha256,
      beforeBytes: removed[0].bytes,
      currentBytes: created[0].bytes,
      renamedFrom: removed[0].path,
    });
  }
  for (const file of deleted) {
    if (pairedDeleted.has(file.path)) continue;
    changed.push({
      path: file.path,
      change: "deleted",
      beforeSha256: file.sha256,
      currentSha256: null,
      beforeBytes: file.bytes,
      currentBytes: null,
      renamedFrom: null,
    });
  }
  for (const file of added) {
    if (pairedAdded.has(file.path)) continue;
    changed.push({
      path: file.path,
      change: "added",
      beforeSha256: null,
      currentSha256: file.sha256,
      beforeBytes: null,
      currentBytes: file.bytes,
      renamedFrom: null,
    });
  }
  return changed.sort((left, right) =>
    portableCompare(left.path, right.path) ||
    portableCompare(left.renamedFrom ?? "", right.renamedFrom ?? ""));
}

function recommendedOperation(note) {
  if (note.kind === "project") return "hub.refresh";
  if (note.kind === "decision") return "decision.accept";
  return "note.update";
}

function findingPayload({
  previous,
  current,
  note,
  priorNote,
  ignoredSpecifiers = new Set(),
  supersedes = [],
}) {
  const priorBindings = new Map(priorNote.bindings.map((binding) => [binding.specifier, binding]));
  const matchedBindings = [];
  const changes = new Map();
  for (const binding of note.bindings) {
    if (ignoredSpecifiers.has(binding.specifier)) continue;
    const before = priorBindings.get(binding.specifier);
    if (!before || before.fingerprint === binding.fingerprint) continue;
    matchedBindings.push({
      specifier: binding.specifier,
      kind: binding.kind,
      ref: binding.ref,
      beforeFingerprint: before.fingerprint,
      currentFingerprint: binding.fingerprint,
    });
    for (const changed of sourceChanges(before, binding)) {
      const existing = changes.get(changed.path);
      if (existing === undefined || changed.change === "renamed") {
        changes.set(changed.path, changed);
      } else if (existing.change === "renamed") {
        continue;
      } else if (JSON.stringify(existing) !== JSON.stringify(changed)) {
        throw driftError("DRIFT007", "Overlapping bindings produced conflicting source evidence.", {
          path: changed.path,
        });
      }
      if (changes.size > MAXIMUM_CHANGED_SOURCES) {
        throw driftError("DRIFT005", "One drift finding exceeds the changed-source limit.");
      }
    }
  }
  if (matchedBindings.length === 0) return null;
  const changedSources = [...changes.values()].sort((left, right) =>
    portableCompare(left.path, right.path) ||
    portableCompare(left.renamedFrom ?? "", right.renamedFrom ?? ""));
  if (changedSources.length === 0) {
    throw driftError("DRIFT007", "A changed binding fingerprint has no exact changed-file evidence.");
  }
  return {
    specification: DRIFT_FINDING_SPECIFICATION,
    status: "potentially-stale",
    authority: "zero",
    graphRevision: current.payload.graphRevision,
    observationBefore: { id: previous.id, digest: previous.digest },
    observationCurrent: { id: current.id, digest: current.digest },
    note: {
      path: note.path,
      sha256: note.sha256,
      kind: note.kind,
      scope: note.scope,
      authorityClass: note.authorityClass,
    },
    matchedBindings,
    changedSources,
    supersedes: supersedes.map((entry) => ({ ...entry })),
    recommendedOperation: recommendedOperation(note),
    afterTextRequired: true,
  };
}

function refreshPayload(finding) {
  const exactFiles = finding.payload.changedSources
    .filter((source) => source.currentSha256 !== null)
    .slice(0, 16)
    .map((source) => ({
      type: "file",
      ref: source.path,
      expectedSha256: source.currentSha256,
    }));
  return {
    specification: DRIFT_REFRESH_SPECIFICATION,
    finding: { id: finding.id, digest: finding.digest },
    note: { ...finding.payload.note },
    recommendedOperation: finding.payload.recommendedOperation,
    afterTextRequired: true,
    requiredOrigin: "drift",
    requiredSourceRefs: [
      {
        type: "drift-finding",
        ref: finding.id,
        expectedSha256: finding.digest,
      },
    ],
    supportingSourceRefs: exactFiles,
    next: "Author complete afterText, run propose --input, inspect the exact artifact, review its digest, then apply only after approval.",
  };
}

function stateEntry(finding, refresh, proposalBindingIds = []) {
  return {
    findingId: finding.id,
    findingDigest: finding.digest,
    refreshId: refresh.id,
    refreshDigest: refresh.digest,
    note: {
      path: finding.payload.note.path,
      sha256: finding.payload.note.sha256,
    },
    proposalBindingIds: [...proposalBindingIds].sort(),
  };
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

async function loadActiveFinding(
  environment,
  entry,
  policyRevision = environment.policyRevision,
) {
  const finding = await readDriftFinding({
    graphRoot: environment.graphRoot,
    workspaceIdentity: environment.workspaceIdentity,
    graphRootIdentity: environment.graphRootIdentity,
    policyRevision,
    id: entry.findingId,
  });
  const refresh = await readDriftRefresh({
    graphRoot: environment.graphRoot,
    workspaceIdentity: environment.workspaceIdentity,
    graphRootIdentity: environment.graphRootIdentity,
    policyRevision,
    id: entry.refreshId,
  });
  if (
    finding === null ||
    refresh === null ||
    finding.digest !== entry.findingDigest ||
    refresh.digest !== entry.refreshDigest
  ) {
    throw driftError("DRIFT003", "Active drift state references missing or mismatched evidence.", {
      findingId: entry.findingId,
    });
  }
  let parsedFinding;
  try {
    parsedFinding = parseDriftFindingPayload(finding.payload);
  } catch (error) {
    throw driftError("DRIFT003", "Active drift finding is semantically invalid.", {
      findingId: entry.findingId,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (
    entry.note.path !== parsedFinding.note.path ||
    entry.note.sha256 !== parsedFinding.note.sha256 ||
    canonicalJson(refresh.payload) !== canonicalJson(refreshPayload({
      ...finding,
      payload: parsedFinding,
    }))
  ) {
    throw driftError("DRIFT003", "Active drift evidence does not match its state or refresh work item.", {
      findingId: entry.findingId,
    });
  }
  return {
    finding: { ...finding, payload: parsedFinding },
    refresh,
  };
}

async function loadFindingObservation(
  environment,
  reference,
  policyRevision,
  cache,
  findingId,
  role,
) {
  const cacheKey = `${reference.id}\0${reference.digest}`;
  let observation = cache.get(cacheKey);
  if (observation !== undefined) return observation;

  observation = await readDriftObservation({
    graphRoot: environment.graphRoot,
    workspaceIdentity: environment.workspaceIdentity,
    graphRootIdentity: environment.graphRootIdentity,
    policyRevision,
    id: reference.id,
  });
  if (observation === null || observation.digest !== reference.digest) {
    throw driftError("DRIFT003", `Active drift finding references unavailable ${role} observation evidence.`, {
      findingId,
      observationId: reference.id,
    });
  }
  try {
    observation = {
      ...observation,
      payload: parseDriftObservationPayload(observation.payload),
    };
  } catch (error) {
    throw driftError("DRIFT003", `Active drift finding references semantically invalid ${role} observation evidence.`, {
      findingId,
      observationId: reference.id,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  cache.set(cacheKey, observation);
  return observation;
}

async function validateActiveFindingObservationLineage(
  environment,
  finding,
  policyRevision,
  cache,
) {
  const before = await loadFindingObservation(
    environment,
    finding.payload.observationBefore,
    policyRevision,
    cache,
    finding.id,
    "prior",
  );
  const current = await loadFindingObservation(
    environment,
    finding.payload.observationCurrent,
    policyRevision,
    cache,
    finding.id,
    "current",
  );
  const priorNote = before.payload.notes.find(
    (note) => note.path === finding.payload.note.path,
  );
  const currentNote = current.payload.notes.find(
    (note) => note.path === finding.payload.note.path,
  );
  if (!priorNote || !currentNote) {
    throw driftError("DRIFT003", "Active drift finding observation lineage does not contain its exact note.", {
      findingId: finding.id,
      notePath: finding.payload.note.path,
    });
  }

  const matchedSpecifiers = new Set(
    finding.payload.matchedBindings.map((binding) => binding.specifier),
  );
  const ignoredSpecifiers = new Set(
    currentNote.bindings
      .map((binding) => binding.specifier)
      .filter((specifier) => !matchedSpecifiers.has(specifier)),
  );
  let expected;
  try {
    expected = findingPayload({
      previous: before,
      current,
      note: currentNote,
      priorNote,
      ignoredSpecifiers,
      supersedes: finding.payload.supersedes,
    });
  } catch (error) {
    throw driftError("DRIFT003", "Active drift finding observation lineage is semantically inconsistent.", {
      findingId: finding.id,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (
    expected === null ||
    canonicalJson(expected) !== canonicalJson(finding.payload)
  ) {
    throw driftError("DRIFT003", "Active drift finding evidence is not derived from its exact observations.", {
      findingId: finding.id,
    });
  }
}

async function loadLatestStateObservation(
  environment,
  state,
  policyRevision = environment.policyRevision,
) {
  if (state.latestObservation === null) {
    throw driftError("DRIFT003", "Drift state has no latest observation to validate.");
  }
  const reference = state.latestObservation;
  const observation = await readDriftObservation({
    graphRoot: environment.graphRoot,
    workspaceIdentity: environment.workspaceIdentity,
    graphRootIdentity: environment.graphRootIdentity,
    policyRevision,
    id: reference.observationId,
  });
  if (observation === null || observation.digest !== reference.observationDigest) {
    throw driftError("DRIFT003", "Drift state references a missing or mismatched observation.", {
      observationId: reference.observationId,
    });
  }
  try {
    return {
      ...observation,
      payload: parseDriftObservationPayload(observation.payload),
    };
  } catch (error) {
    throw driftError("DRIFT003", "The latest drift observation is semantically invalid.", {
      observationId: reference.observationId,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

async function loadFindingBaseObservation(environment, finding, cache) {
  const reference = finding.payload.observationBefore;
  let observation = cache.get(reference.id);
  if (observation === undefined) {
    observation = await readDriftObservation({
      graphRoot: environment.graphRoot,
      workspaceIdentity: environment.workspaceIdentity,
      graphRootIdentity: environment.graphRootIdentity,
      policyRevision: environment.policyRevision,
      id: reference.id,
    });
    if (observation === null || observation.digest !== reference.digest) {
      throw driftError("DRIFT003", "A drift finding references unavailable baseline evidence.", {
        findingId: finding.id,
        observationId: reference.id,
      });
    }
    observation = {
      ...observation,
      payload: parseDriftObservationPayload(observation.payload),
    };
    cache.set(reference.id, observation);
  }
  return observation;
}

function bindingIndex(artifacts) {
  const byFinding = new Map();
  for (const artifact of artifacts) {
    const payload = parseDriftProposalBindingPayload(artifact.payload);
    const list = byFinding.get(payload.finding.id) ?? [];
    list.push({ artifact, payload });
    byFinding.set(payload.finding.id, list);
  }
  return byFinding;
}

async function appliedResolution(environment, entry, candidates) {
  for (const candidate of candidates ?? []) {
    if (
      candidate.payload.finding.digest !== entry.findingDigest ||
      candidate.payload.note.path !== entry.note.path
    ) continue;
    const proposal = await readStoredProposal({
      graphRoot: environment.graphRoot,
      proposalId: candidate.payload.proposal.id,
    });
    if (proposal === null) continue;
    if (
      proposal.proposalDigest !== candidate.payload.proposal.digest ||
      proposal.origin !== "drift" ||
      !proposal.operations.some((operation) =>
        operation.operationId === candidate.payload.operation.id &&
        operation.kind === candidate.payload.operation.kind &&
        operation.sourceRefs.some((source) =>
          source.type === "drift-finding" &&
          source.ref === entry.findingId &&
          source.expectedSha256 === entry.findingDigest) &&
        operation.changes.some((change) => change.path === entry.note.path))
    ) {
      throw driftError("DRIFT003", "A drift proposal binding does not match its stored proposal.", {
        findingId: entry.findingId,
        proposalId: proposal.proposalId,
      });
    }
    const receipts = await listReceiptRecords({
      graphRoot: environment.graphRoot,
      proposalId: proposal.proposalId,
    });
    const receipt = receipts.find((item) =>
      item.outcome === "applied" &&
      item.proposalDigest === proposal.proposalDigest &&
      item.changes.some((change) =>
        change.path === entry.note.path && change.afterSha256 !== null));
    if (receipt) return { candidate, proposal, receipt };
  }
  return null;
}

function sourceReverted(finding, currentObservation) {
  const currentNote = currentObservation.payload.notes.find(
    (note) => note.path === finding.payload.note.path,
  );
  if (!currentNote) return false;
  const bindings = new Map(currentNote.bindings.map((binding) => [binding.specifier, binding]));
  return finding.payload.matchedBindings.every((binding) =>
    bindings.get(binding.specifier)?.fingerprint === binding.beforeFingerprint);
}

async function disposition(environment, payload, dryRun) {
  return dryRun
    ? sealDriftDisposition({
        workspaceIdentity: environment.workspaceIdentity,
        graphRootIdentity: environment.graphRootIdentity,
        policyRevision: environment.policyRevision,
        payload,
      })
    : publishDriftDisposition({
        graphRoot: environment.graphRoot,
        workspaceIdentity: environment.workspaceIdentity,
        graphRootIdentity: environment.graphRootIdentity,
        policyRevision: environment.policyRevision,
        payload,
      });
}

function findingSummary(environment, finding, refresh) {
  return {
    id: finding.id,
    digest: finding.digest,
    artifactPath: resolveDriftArtifactPath({
      graphRoot: environment.graphRoot,
      workspaceIdentity: environment.workspaceIdentity,
      kind: "finding",
      id: finding.id,
    }),
    refreshArtifactPath: resolveDriftArtifactPath({
      graphRoot: environment.graphRoot,
      workspaceIdentity: environment.workspaceIdentity,
      kind: "refresh",
      id: refresh.id,
    }),
    note: { ...finding.payload.note },
    changedSources: {
      previewLimit: Math.min(finding.payload.changedSources.length, 16),
      total: finding.payload.changedSources.length,
    },
    recommendedOperation: finding.payload.recommendedOperation,
    afterTextRequired: true,
    nextCommand: "syncora propose --input <absolute-proposal-input.json>",
  };
}

function normalizedDispositionReason(value, label) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    [...value].length > 2_000 ||
    value !== value.normalize("NFC") ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)
  ) {
    throw driftError("DRIFT008", `${label} must be bounded, normalized safe text.`);
  }
  return value;
}

async function acknowledgeFinding(options, environment, inspection, state) {
  if (state === null) {
    throw driftError("DRIFT008", "No drift baseline or active findings exist to acknowledge.");
  }
  const entry = state.activeFindings.find(
    (finding) => finding.findingId === options.acknowledgeCurrent,
  );
  if (!entry || entry.findingDigest !== options.findingDigest) {
    throw driftError("DRIFT008", "Acknowledgement does not exact-bind an active finding.");
  }
  const reason = normalizedDispositionReason(options.reason, "Acknowledgement reason");
  await verifyDriftFindingFreshness(environment, {
    findingId: entry.findingId,
    findingDigest: entry.findingDigest,
  });
  const loaded = await loadActiveFinding(environment, entry);
  const recorded = await disposition(environment, {
    specification: DRIFT_DISPOSITION_SPECIFICATION,
    outcome: "acknowledged-current",
    finding: { id: entry.findingId, digest: entry.findingDigest },
    reason,
    evidence: { notePath: entry.note.path, noteSha256: entry.note.sha256 },
  }, options.dryRun);
  const nextState = {
    ...state,
    updatedAt: new Date().toISOString(),
    activeFindings: state.activeFindings.filter(
      (finding) => finding.findingId !== entry.findingId,
    ),
  };
  if (!options.dryRun) await writeDriftState({ graphRoot: environment.graphRoot, state: nextState });
  return {
    ok: true,
    command: "check",
    mode: "changed",
    state: options.dryRun ? "acknowledgement-validated-dry-run" : "acknowledged-current",
    workspace: environment.workspacePath,
    graph: { root: environment.graphRoot, revision: inspection.report.graph.revision },
    provider: { kind: "fingerprint", baseline: null, baselineInitialized: false },
    dryRun: options.dryRun,
    summary: {
      changedPaths: 0,
      renames: 0,
      affectedNotes: 0,
      activeFindings: nextState.activeFindings.length,
      newFindings: 0,
      resolvedFindings: options.dryRun ? 0 : 1,
      trackedNotes: 0,
      trackedBindings: 0,
      trackedFiles: 0,
    },
    findings: [],
    warnings: [],
    disposition: {
      id: recorded.id,
      digest: recorded.digest,
      findingId: loaded.finding.id,
    },
  };
}

function sourceCoverageWarnings(plan, sources) {
  const warnings = [...plan.warnings];
  if (sources.coverage.missingRootCount > 0) {
    warnings.push(warning(
      "DRIFT_SOURCE_MISSING",
      `${sources.coverage.missingRootCount} bound source root(s) were absent and fingerprinted as exact empty coverage.`,
      {
        roots: sources.coverage.missingRoots,
        truncated: sources.coverage.missingRootsTruncated,
      },
    ));
  }
  if (sources.coverage.skippedDirectoryCount > 0) {
    warnings.push(warning(
      "DRIFT_SOURCE_EXCLUDED",
      `${sources.coverage.skippedDirectoryCount} covered director${sources.coverage.skippedDirectoryCount === 1 ? "y was" : "ies were"} excluded by source-safety policy.`,
      {
        directories: sources.coverage.skippedDirectories,
        truncated: sources.coverage.skippedDirectoriesTruncated,
      },
    ));
  }
  if (sources.git.warning) {
    warnings.push(warning(
      "DRIFT_GIT_ADVISORY",
      `Git hints were unavailable; exact fingerprints remained authoritative: ${sources.git.warning}`,
    ));
  }
  return warnings;
}

function incompleteCoverage(plan, sources) {
  return (
    plan.coverage.untypedBindings > 0 ||
    plan.coverage.invalidBindings > 0 ||
    plan.coverage.unevaluatedBindings > 0 ||
    sources.coverage.missingRootCount > 0 ||
    sources.coverage.skippedDirectoryCount > 0
  );
}

async function rebaselineDriftState({
  options,
  environment,
  inspection,
  priorState,
  plan,
  sources,
  payload,
  current,
}) {
  const reason = normalizedDispositionReason(options.reason, "Rebaseline reason");
  if (priorState !== null) {
    await loadLatestStateObservation(
      environment,
      priorState,
      priorState.policyRevision,
    );
  }
  const observationCache = new Map();
  for (const entry of priorState?.activeFindings ?? []) {
    const loaded = await loadActiveFinding(
      environment,
      entry,
      priorState.policyRevision,
    );
    await validateActiveFindingObservationLineage(
      environment,
      loaded.finding,
      priorState.policyRevision,
      observationCache,
    );
  }

  let publishedObservation = current;
  let rebaselineRecord;
  if (!options.dryRun) {
    publishedObservation = await publishDriftObservation({
      graphRoot: environment.graphRoot,
      workspaceIdentity: environment.workspaceIdentity,
      graphRootIdentity: environment.graphRootIdentity,
      policyRevision: environment.policyRevision,
      payload,
    });
    rebaselineRecord = await disposition(environment, {
      specification: DRIFT_DISPOSITION_SPECIFICATION,
      outcome: "explicit-rebaseline",
      reason,
      previous: priorState === null
        ? null
        : {
            policyRevision: priorState.policyRevision,
            updatedAt: priorState.updatedAt,
            latestObservation: priorState.latestObservation,
            activeFindings: priorState.activeFindings.length,
          },
      replacement: {
        policyRevision: environment.policyRevision,
        observationId: publishedObservation.id,
        observationDigest: publishedObservation.digest,
      },
    }, false);
    for (const entry of priorState?.activeFindings ?? []) {
      await disposition(environment, {
        specification: DRIFT_DISPOSITION_SPECIFICATION,
        outcome: "retired-explicit-rebaseline",
        finding: { id: entry.findingId, digest: entry.findingDigest },
        reason,
        evidence: {
          priorPolicyRevision: priorState.policyRevision,
          replacementObservationId: publishedObservation.id,
          replacementObservationDigest: publishedObservation.digest,
        },
      }, false);
    }
    const nextState = createDriftState({
      workspaceIdentity: environment.workspaceIdentity,
      graphRootIdentity: environment.graphRootIdentity,
      policyRevision: environment.policyRevision,
    });
    await writeDriftState({
      graphRoot: environment.graphRoot,
      expectedPreviousPolicyRevision:
        priorState?.policyRevision ?? environment.policyRevision,
      state: {
        ...nextState,
        updatedAt: new Date().toISOString(),
        latestObservation: {
          observationId: publishedObservation.id,
          observationDigest: publishedObservation.digest,
        },
      },
    });
  } else {
    rebaselineRecord = await disposition(environment, {
      specification: DRIFT_DISPOSITION_SPECIFICATION,
      outcome: "explicit-rebaseline",
      reason,
      previous: priorState === null
        ? null
        : {
            policyRevision: priorState.policyRevision,
            updatedAt: priorState.updatedAt,
            latestObservation: priorState.latestObservation,
            activeFindings: priorState.activeFindings.length,
          },
      replacement: {
        policyRevision: environment.policyRevision,
        observationId: current.id,
        observationDigest: current.digest,
      },
    }, true);
    for (const entry of priorState?.activeFindings ?? []) {
      await disposition(environment, {
        specification: DRIFT_DISPOSITION_SPECIFICATION,
        outcome: "retired-explicit-rebaseline",
        finding: { id: entry.findingId, digest: entry.findingDigest },
        reason,
        evidence: {
          priorPolicyRevision: priorState.policyRevision,
          replacementObservationId: current.id,
          replacementObservationDigest: current.digest,
        },
      }, true);
    }
  }

  const degraded = incompleteCoverage(plan, sources);
  const baseState = priorState === null ? "baseline-established" : "baseline-reestablished";
  const warnings = sourceCoverageWarnings(plan, sources);
  return {
    ok: true,
    command: "check",
    mode: "changed",
    state: `${baseState}${degraded ? "-degraded" : ""}${options.dryRun ? "-dry-run" : ""}`,
    workspace: environment.workspacePath,
    graph: { root: environment.graphRoot, revision: inspection.report.graph.revision },
    provider: {
      kind: "fingerprint",
      baseline: sources.git.baseline ?? null,
      baselineInitialized: sources.git.baselineEstablished === true,
      gitHintsAvailable: sources.git.hintsAvailable === true,
    },
    dryRun: options.dryRun,
    summary: {
      changedPaths: 0,
      renames: 0,
      affectedNotes: 0,
      activeFindings: 0,
      newFindings: 0,
      resolvedFindings: priorState?.activeFindings.length ?? 0,
      trackedNotes: plan.notes.length,
      trackedBindings: plan.bindings.length,
      trackedFiles: sources.coverage.uniqueFilesMatched,
    },
    findings: [],
    warnings: warnings.slice(0, MAXIMUM_WARNINGS),
    omittedWarnings: Math.max(0, warnings.length - MAXIMUM_WARNINGS),
    rebaseline: {
      previousPolicyRevision: priorState?.policyRevision ?? null,
      currentPolicyRevision: environment.policyRevision,
      retiredFindings: priorState?.activeFindings.length ?? 0,
      recordId: rebaselineRecord.id,
      recordDigest: rebaselineRecord.digest,
      reason,
    },
  };
}

async function checkChangedUnlocked(options, hooks) {
  const environment = await resolveGovernedEnvironment(options);
  await assertNoActiveMigration(environment);
  await assertNoNonterminalFileTransaction(environment.graphRoot);
  const inspection = await inspectWorkspaceUnlocked(options);
  if (!inspection.report.ok || (inspection.report.summary.diagnostics.byCode.READ001 ?? 0) > 0) {
    throw driftError("DRIFT007", "Drift detection requires one complete valid graph read.", {
      validationErrors: inspection.report.summary.diagnostics.error,
    });
  }
  let state;
  try {
    state = await readDriftState({
      graphRoot: environment.graphRoot,
      workspaceIdentity: environment.workspaceIdentity,
      graphRootIdentity: environment.graphRootIdentity,
      policyRevision: options.rebaseline ? undefined : environment.policyRevision,
    });
  } catch (error) {
    if (!options.rebaseline && error?.code === "DRIFT003") {
      const priorState = await readDriftState({
        graphRoot: environment.graphRoot,
        workspaceIdentity: environment.workspaceIdentity,
        graphRootIdentity: environment.graphRootIdentity,
      });
      if (priorState && priorState.policyRevision !== environment.policyRevision) {
        throw driftError(
          "DRIFT_POLICY_MISMATCH",
          "Changed-source policy changed; run check --changed --rebaseline --reason <text> in the foreground.",
          {
            previousPolicyRevision: priorState.policyRevision,
            currentPolicyRevision: environment.policyRevision,
          },
        );
      }
    }
    throw error;
  }
  if (options.rebaseline) {
    if (state === null) {
      throw driftError(
        "DRIFT_REBASELINE_NOT_REQUIRED",
        "No retained changed-source state exists to rebaseline; run check --changed without --rebaseline to establish an honest first baseline.",
      );
    }
    if (state.policyRevision === environment.policyRevision) {
      throw driftError(
        "DRIFT_REBASELINE_NOT_REQUIRED",
        "Retained changed-source state already uses the current policy; run check --changed without --rebaseline and resolve active findings through their normal exact transitions.",
        { policyRevision: environment.policyRevision },
      );
    }
  }
  if (options.acknowledgeCurrent !== undefined) {
    return acknowledgeFinding(options, environment, inspection, state);
  }

  let previous = null;
  if (!options.rebaseline && state?.latestObservation) {
    previous = await loadLatestStateObservation(environment, state);
  }

  const plan = compileBindingPlan(inspection.notes);
  const sources = await observeBoundSources({
    workspacePath: environment.workspacePath,
    graphPath: environment.graphRoot,
    bindings: plan.bindings,
    gitBaseline: previous?.payload.git?.baseline ?? null,
    hooks: hooks.source,
  });
  const payload = observationPayload({ inspection, plan, sources });
  const sealedObservation = sealDriftObservation({
    workspaceIdentity: environment.workspaceIdentity,
    graphRootIdentity: environment.graphRootIdentity,
    policyRevision: environment.policyRevision,
    payload,
  });
  const current = { ...sealedObservation, payload: parseDriftObservationPayload(payload) };

  const finalInspection = await inspectWorkspaceUnlocked(options);
  if (
    finalInspection.report.graph.revision !== inspection.report.graph.revision ||
    finalInspection.graph.resolvedGraphPath !== inspection.graph.resolvedGraphPath
  ) {
    throw driftError("DRIFT007", "Canonical graph changed during drift observation.");
  }

  if (options.rebaseline) {
    return rebaselineDriftState({
      options,
      environment,
      inspection,
      priorState: state,
      plan,
      sources,
      payload,
      current,
    });
  }

  const bindingArtifacts = state?.activeFindings.length
    ? await listDriftProposalBindings({
        graphRoot: environment.graphRoot,
        workspaceIdentity: environment.workspaceIdentity,
        graphRootIdentity: environment.graphRootIdentity,
        policyRevision: environment.policyRevision,
        findingIds: state.activeFindings.map((finding) => finding.findingId),
      })
    : [];
  const proposalsByFinding = bindingIndex(bindingArtifacts);
  const unresolved = [];
  const resolved = [];
  const revertedSpecifiersByNote = new Map();
  const loadedActive = new Map();
  for (const entry of state?.activeFindings ?? []) {
    const loaded = await loadActiveFinding(environment, entry);
    loadedActive.set(entry.findingId, loaded);
    const applied = await appliedResolution(
      environment,
      entry,
      proposalsByFinding.get(entry.findingId),
    );
    const reverted = !applied && sourceReverted(loaded.finding, current);
    if (applied || reverted) {
      if (reverted) {
        const ignored = revertedSpecifiersByNote.get(entry.note.path) ?? new Set();
        for (const binding of loaded.finding.payload.matchedBindings) {
          ignored.add(binding.specifier);
        }
        revertedSpecifiersByNote.set(entry.note.path, ignored);
      }
      const recorded = await disposition(environment, applied
        ? {
            specification: DRIFT_DISPOSITION_SPECIFICATION,
            outcome: "resolved-applied",
            finding: { id: entry.findingId, digest: entry.findingDigest },
            reason: "An applied exact drift proposal repaired the affected note.",
            evidence: {
              proposalId: applied.proposal.proposalId,
              proposalDigest: applied.proposal.proposalDigest,
              receiptId: applied.receipt.receiptId,
              receiptDigest: applied.receipt.receiptDigest,
            },
          }
        : {
            specification: DRIFT_DISPOSITION_SPECIFICATION,
            outcome: "resolved-source-reverted",
            finding: { id: entry.findingId, digest: entry.findingDigest },
            reason: "All matched source fingerprints returned exactly to their pre-finding values.",
            evidence: {
              observationId: current.id,
              observationDigest: current.digest,
            },
          }, options.dryRun);
      resolved.push({ entry, recorded });
      continue;
    }
    const proposalIds = (proposalsByFinding.get(entry.findingId) ?? [])
      .filter((candidate) => candidate.payload.finding.digest === entry.findingDigest)
      .map((candidate) => candidate.artifact.id)
      .sort();
    if (proposalIds.length > 256) {
      throw driftError("DRIFT005", "One finding exceeds the proposal-binding limit.");
    }
    unresolved.push({ ...entry, proposalBindingIds: proposalIds });
  }

  const newArtifacts = [];
  if (previous !== null) {
    const priorNotes = new Map(previous.payload.notes.map((note) => [note.path, note]));
    const activeByNote = new Map(unresolved.map((entry) => [entry.note.path, entry]));
    const observationCache = new Map([[previous.id, previous]]);
    for (const note of current.payload.notes) {
      const priorNote = priorNotes.get(note.path);
      if (!priorNote) continue;
      const transition = findingPayload({
        previous,
        current,
        note,
        priorNote,
        ignoredSpecifiers: revertedSpecifiersByNote.get(note.path) ?? new Set(),
      });
      if (!transition) continue;
      const activeEntry = activeByNote.get(note.path);
      let nextPayload = transition;
      if (activeEntry) {
        const active = loadedActive.get(activeEntry.findingId);
        if (!active) {
          throw driftError("DRIFT003", "Active drift evidence was not loaded for supersession.", {
            findingId: activeEntry.findingId,
          });
        }
        const base = await loadFindingBaseObservation(
          environment,
          active.finding,
          observationCache,
        );
        const baseNote = base.payload.notes.find((entry) => entry.path === note.path);
        if (!baseNote) {
          throw driftError("DRIFT003", "Active drift baseline no longer contains its bound note.", {
            findingId: activeEntry.findingId,
            notePath: note.path,
          });
        }
        nextPayload = findingPayload({
          previous: base,
          current,
          note,
          priorNote: baseNote,
          supersedes: [{
            id: activeEntry.findingId,
            digest: activeEntry.findingDigest,
          }],
        });
        if (!nextPayload) {
          throw driftError(
            "DRIFT007",
            "Source evolution could not be coalesced with its active finding.",
            { findingId: activeEntry.findingId, notePath: note.path },
          );
        }
      }
      const sealedFinding = sealDriftFinding({
        workspaceIdentity: environment.workspaceIdentity,
        graphRootIdentity: environment.graphRootIdentity,
        policyRevision: environment.policyRevision,
        payload: nextPayload,
      });
      const finding = { ...sealedFinding, payload: parseDriftFindingPayload(nextPayload) };
      const nextRefreshPayload = refreshPayload(finding);
      const sealedRefresh = sealDriftRefresh({
        workspaceIdentity: environment.workspaceIdentity,
        graphRootIdentity: environment.graphRootIdentity,
        policyRevision: environment.policyRevision,
        payload: nextRefreshPayload,
      });
      newArtifacts.push({ finding, refresh: sealedRefresh });
    }
  }

  const supersededBy = new Map();
  for (const artifact of newArtifacts) {
    for (const reference of artifact.finding.payload.supersedes) {
      const entry = unresolved.find((candidate) => candidate.findingId === reference.id);
      if (!entry || entry.findingDigest !== reference.digest || supersededBy.has(reference.id)) {
        throw driftError("DRIFT003", "Finding supersession does not exact-bind one active predecessor.", {
          findingId: reference.id,
        });
      }
      supersededBy.set(reference.id, { entry, artifact });
    }
  }
  for (let index = unresolved.length - 1; index >= 0; index -= 1) {
    if (supersededBy.has(unresolved[index].findingId)) unresolved.splice(index, 1);
  }

  const known = new Set(unresolved.map((entry) => entry.findingId));
  const genuinelyNew = [];
  for (const artifact of newArtifacts) {
    if (known.has(artifact.finding.id)) continue;
    known.add(artifact.finding.id);
    unresolved.push(stateEntry(artifact.finding, artifact.refresh));
    genuinelyNew.push(artifact);
  }
  if (unresolved.length > 10_000) {
    throw driftError("DRIFT005", "Active drift findings exceed the state limit.");
  }

  let publishedObservation = current;
  if (!options.dryRun) {
    publishedObservation = await publishDriftObservation({
      graphRoot: environment.graphRoot,
      workspaceIdentity: environment.workspaceIdentity,
      graphRootIdentity: environment.graphRootIdentity,
      policyRevision: environment.policyRevision,
      payload,
    });
    for (const artifact of genuinelyNew) {
      await publishDriftFinding({
        graphRoot: environment.graphRoot,
        workspaceIdentity: environment.workspaceIdentity,
        graphRootIdentity: environment.graphRootIdentity,
        policyRevision: environment.policyRevision,
        payload: artifact.finding.payload,
      });
      await publishDriftRefresh({
        graphRoot: environment.graphRoot,
        workspaceIdentity: environment.workspaceIdentity,
        graphRootIdentity: environment.graphRootIdentity,
        policyRevision: environment.policyRevision,
        payload: artifact.refresh.payload,
      });
    }
    for (const { entry, artifact } of supersededBy.values()) {
      const recorded = await disposition(environment, {
        specification: DRIFT_DISPOSITION_SPECIFICATION,
        outcome: "superseded-source-evolution",
        finding: { id: entry.findingId, digest: entry.findingDigest },
        reason: "Later bound-source evolution was coalesced into one replacement finding.",
        evidence: {
          replacementFindingId: artifact.finding.id,
          replacementFindingDigest: artifact.finding.digest,
        },
      }, false);
      resolved.push({ entry, recorded });
    }
    const nextState = state ?? createDriftState({
      workspaceIdentity: environment.workspaceIdentity,
      graphRootIdentity: environment.graphRootIdentity,
      policyRevision: environment.policyRevision,
    });
    await writeDriftState({
      graphRoot: environment.graphRoot,
      state: {
        ...nextState,
        updatedAt: new Date().toISOString(),
        latestObservation: {
          observationId: publishedObservation.id,
          observationDigest: publishedObservation.digest,
        },
        activeFindings: unresolved.sort((left, right) =>
          portableCompare(left.findingId, right.findingId)),
      },
    });
  } else {
    for (const { entry, artifact } of supersededBy.values()) {
      const recorded = await disposition(environment, {
        specification: DRIFT_DISPOSITION_SPECIFICATION,
        outcome: "superseded-source-evolution",
        finding: { id: entry.findingId, digest: entry.findingDigest },
        reason: "Later bound-source evolution was coalesced into one replacement finding.",
        evidence: {
          replacementFindingId: artifact.finding.id,
          replacementFindingDigest: artifact.finding.digest,
        },
      }, true);
      resolved.push({ entry, recorded });
    }
  }

  const activeSummaries = [];
  for (const entry of unresolved.slice(0, MAXIMUM_RETURNED_FINDINGS)) {
    let loaded = loadedActive.get(entry.findingId);
    if (!loaded) {
      const created = genuinelyNew.find((item) => item.finding.id === entry.findingId);
      if (created) loaded = created;
    }
    if (loaded) activeSummaries.push(findingSummary(environment, loaded.finding, loaded.refresh));
  }

  const changedPaths = new Set();
  let renames = 0;
  for (const artifact of genuinelyNew) {
    for (const changed of artifact.finding.payload.changedSources) {
      changedPaths.add(changed.path);
      if (changed.change === "renamed") {
        changedPaths.add(changed.renamedFrom);
        renames += 1;
      }
    }
  }
  const warnings = sourceCoverageWarnings(plan, sources);
  const coverageIsIncomplete = incompleteCoverage(plan, sources);
  let terminalState;
  if (previous === null) {
    const baselineState = plan.bindings.length === 0
      ? "no-tracked-sources"
      : "baseline-established";
    terminalState = coverageIsIncomplete ? `${baselineState}-degraded` : baselineState;
  }
  else if (genuinelyNew.length > 0) terminalState = "findings-created";
  else if (unresolved.length > 0) terminalState = "findings-active";
  else if (coverageIsIncomplete) terminalState = "completed-degraded";
  else if (plan.bindings.length === 0) terminalState = "no-tracked-sources";
  else terminalState = "current";

  return {
    ok: true,
    command: "check",
    mode: "changed",
    state: options.dryRun ? `${terminalState}-dry-run` : terminalState,
    workspace: environment.workspacePath,
    graph: { root: environment.graphRoot, revision: inspection.report.graph.revision },
    provider: {
      kind: "fingerprint",
      baseline: sources.git.baseline ?? null,
      baselineInitialized: sources.git.baselineEstablished === true,
      gitHintsAvailable: sources.git.hintsAvailable === true,
    },
    dryRun: options.dryRun,
    summary: {
      changedPaths: changedPaths.size,
      renames,
      affectedNotes: genuinelyNew.length,
      activeFindings: unresolved.length,
      newFindings: genuinelyNew.length,
      resolvedFindings: resolved.length,
      trackedNotes: plan.notes.length,
      trackedBindings: plan.bindings.length,
      trackedFiles: sources.coverage.uniqueFilesMatched,
    },
    findings: activeSummaries,
    omittedFindings: Math.max(0, unresolved.length - activeSummaries.length),
    warnings: warnings.slice(0, MAXIMUM_WARNINGS),
    omittedWarnings: Math.max(0, warnings.length - MAXIMUM_WARNINGS),
  };
}

export async function checkChangedWorkspace(options, hooks = {}) {
  return withCanonicalReadInterlock(
    options,
    () => checkChangedUnlocked(options, hooks),
  );
}
