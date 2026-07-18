import { createHash } from "node:crypto";

import { applyAuthorityValidation } from "./authority-validator.mjs";
import { SyncoraError } from "./cli.mjs";
import { isNonPortableGraphPath } from "./graph-scanner.mjs";
import { buildLinkGraph, normalizeLinkIdentity } from "./link-resolver.mjs";
import { parseNoteBytes } from "./note-parser.mjs";
import { graphRevision, VALIDATION_POLICY } from "./validate.mjs";

export const PROJECTED_GRAPH_POLICY = Object.freeze({
  specification: "syncora-projected-graph-v1",
  maximumChanges: 10_000,
  maximumSingleChangeBytes: 16_777_216,
  maximumTotalChangeBytes: 67_108_864,
  maximumFindingExamples: 64,
  maximumExamplePathCharacters: 512,
  maximumExampleMessageCharacters: 512,
});

const RECOMPUTED_CODES = new Set([
  "PATH001",
  "ID001",
  "HUB001",
  "HUB002",
  "AUTH001",
  "AUTH002",
  "AUTH003",
  "LINK003",
  "LINK004",
]);

const AFFECTED_CONFLICT_CODES = new Set([
  "PATH001",
  "ID001",
  "HUB001",
  "HUB002",
  "AUTH001",
  "AUTH002",
  "AUTH003",
  "LINK004",
]);

const DETAIL_INSENSITIVE_FINGERPRINT_CODES = new Set([
  "PATH001",
  "ID001",
  "HUB001",
  "AUTH001",
  "AUTH002",
  "AUTH003",
]);

function projectedError(code, message, details = undefined) {
  return new SyncoraError(code, message, details);
}

function portableCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function portableIdentity(path) {
  return path.normalize("NFC").toLowerCase();
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function taggedDigest(values) {
  const hash = createHash("sha256");
  hash.update("syncora-projected-finding-set-v1\n");
  for (const value of values) {
    hash.update(value, "utf8");
    hash.update("\n");
  }
  return `sha256:${hash.digest("hex")}`;
}

function exactKeys(value, expected, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw projectedError("WRITE001", `${label} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    !actual.every((key, index) => key === wanted[index])
  ) {
    throw projectedError("WRITE001", `${label} has missing or unknown fields.`, {
      expected: wanted,
      actual,
    });
  }
}

function assertInspection(inspection) {
  if (
    inspection === null ||
    typeof inspection !== "object" ||
    !Array.isArray(inspection.notes) ||
    typeof inspection.report?.graph?.revision !== "string" ||
    typeof inspection.graph?.resolvedGraphPath !== "string"
  ) {
    throw projectedError(
      "READ001",
      "Projected validation requires one complete inspectWorkspace result.",
    );
  }
  const currentRevision = graphRevision(inspection.notes);
  if (currentRevision !== inspection.report.graph.revision) {
    throw projectedError(
      "READ001",
      "The supplied inspection no longer matches its recorded graph revision.",
    );
  }
}

function assertPortableChangePath(path) {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.includes("\\") ||
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path) ||
    path.split("/").some((segment) => segment === "" || segment === "." || segment === "..") ||
    !path.toLowerCase().endsWith(".md")
  ) {
    throw projectedError(
      "WRITE002",
      `Projected change path is not a portable graph-relative Markdown path: ${String(path)}`,
    );
  }
  return path;
}

function cloneFrontmatter(frontmatter) {
  const clone = { ...frontmatter };
  for (const key of ["supersedes", "superseded_by", "applies_to", "source_refs"]) {
    if (Array.isArray(frontmatter?.[key])) clone[key] = [...frontmatter[key]];
  }
  return clone;
}

function cloneBaselineNote(note) {
  const diagnostics = (note.diagnostics ?? [])
    .filter((finding) => !RECOMPUTED_CODES.has(finding.code))
    .map((finding) => ({ ...finding }));
  const quarantined = diagnostics.some(
    (finding) => finding.severity === "error" && finding.quarantined !== false,
  );
  return {
    ...note,
    frontmatter: cloneFrontmatter(note.frontmatter),
    links: [...(note.links ?? [])],
    linkReferences: (note.linkReferences ?? []).map((reference) => ({ ...reference })),
    diagnostics,
    authorityClass: quarantined
      ? "quarantined"
      : note.currentSchema
        ? "pending"
        : "unpromoted",
    ...(note.lexicalSource
      ? { lexicalSource: { ...note.lexicalSource } }
      : {}),
  };
}

function boundedPaths(paths) {
  const ordered = [...paths].sort(portableCompare);
  const examples = ordered.slice(0, 16);
  return {
    paths: examples,
    ...(ordered.length > examples.length
      ? {
          pathsTotal: ordered.length,
          pathsOmitted: ordered.length - examples.length,
          pathsTruncated: true,
        }
      : {}),
  };
}

function applyPortablePathCollisions(notes) {
  const groups = new Map();
  for (const note of notes) {
    const key = portableIdentity(note.path);
    const matches = groups.get(key) ?? [];
    matches.push(note);
    groups.set(key, matches);
  }
  for (const matches of groups.values()) {
    if (matches.length < 2) continue;
    const details = boundedPaths(matches.map((note) => note.path));
    for (const note of matches) {
      note.diagnostics.push({
        code: "PATH001",
        severity: "error",
        message: "Path participates in a cross-platform canonical collision.",
        path: note.path,
        quarantined: true,
        details,
      });
      note.authorityClass = "quarantined";
    }
  }
}

function baselineByPath(inspection) {
  const notes = new Map();
  for (const note of inspection.notes) {
    if (notes.has(note.path)) {
      throw projectedError(
        "READ001",
        `The supplied inspection repeats a graph path: ${note.path}`,
      );
    }
    notes.set(note.path, note);
  }
  return notes;
}

function normalizeChanges(changes, baseline) {
  if (!Array.isArray(changes) || changes.length > PROJECTED_GRAPH_POLICY.maximumChanges) {
    throw projectedError(
      "WRITE001",
      `Projected changes must be an array with at most ${PROJECTED_GRAPH_POLICY.maximumChanges} entries.`,
    );
  }
  const identities = new Set();
  const normalized = [];
  let totalBytes = 0;
  for (let index = 0; index < changes.length; index += 1) {
    const change = changes[index];
    exactKeys(change, ["path", "before", "after"], `Projected change ${index}`);
    const path = assertPortableChangePath(change.path);
    for (const key of ["before", "after"]) {
      const value = change[key];
      if (value !== null && !Buffer.isBuffer(value)) {
        throw projectedError(
          "WRITE001",
          `Projected change ${index}.${key} must be a Buffer or null.`,
        );
      }
      if (value !== null) {
        if (value.length > PROJECTED_GRAPH_POLICY.maximumSingleChangeBytes) {
          throw projectedError(
            "WRITE001",
            `Projected change bytes exceed the per-file limit: ${path}`,
          );
        }
        totalBytes += value.length;
      }
    }
    if (totalBytes > PROJECTED_GRAPH_POLICY.maximumTotalChangeBytes) {
      throw projectedError("WRITE001", "Projected changes exceed the total byte limit.");
    }
    if (change.before === null && change.after === null) {
      throw projectedError("WRITE001", `Projected change has no before or after bytes: ${path}`);
    }
    const identity = portableIdentity(path);
    if (identities.has(identity)) {
      throw projectedError(
        "WRITE003",
        `Projected changes repeat a cross-platform target identity: ${path}`,
      );
    }
    identities.add(identity);

    const current = baseline.get(path);
    if (change.before === null) {
      if (current !== undefined) {
        throw projectedError("WRITE001", `Projected create target already exists: ${path}`);
      }
    } else if (
      current === undefined ||
      current.rawSha256 === null ||
      current.byteLength !== change.before.length ||
      current.rawSha256 !== sha256(change.before)
    ) {
      throw projectedError(
        "WRITE001",
        `Projected prior bytes do not match the inspected graph: ${path}`,
      );
    }

    normalized.push(Object.freeze({
      path,
      before: change.before,
      after: change.after,
      action:
        change.before === null
          ? "create"
          : change.after === null
            ? "delete"
            : change.before.equals(change.after)
              ? "unchanged"
              : "update",
    }));
  }
  return normalized;
}

function findingFingerprint(finding) {
  const payload = {
    code: finding.code ?? "UNKNOWN",
    severity: finding.severity ?? "error",
    path: finding.path ?? null,
    message: finding.message ?? "",
    ...(finding.location ? { location: finding.location } : {}),
    ...(
      finding.details !== undefined &&
      !DETAIL_INSENSITIVE_FINGERPRINT_CODES.has(finding.code)
        ? { details: finding.details }
        : {}
    ),
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`;
}

function flattenFindings(notes, scanFindings = [], globalFindings = []) {
  return [
    ...scanFindings.map((finding) => ({ ...finding })),
    ...notes.flatMap((note) => note.diagnostics ?? []),
    ...globalFindings,
  ].sort((left, right) =>
    portableCompare(left.severity ?? "", right.severity ?? "") ||
    portableCompare(left.code ?? "", right.code ?? "") ||
    portableCompare(left.path ?? "", right.path ?? "") ||
    portableCompare(left.message ?? "", right.message ?? ""));
}

function errorIndex(findings) {
  const index = new Map();
  for (const finding of findings) {
    if (finding.severity !== "error") continue;
    const fingerprint = findingFingerprint(finding);
    if (!index.has(fingerprint)) index.set(fingerprint, finding);
  }
  return index;
}

function boundedText(value, maximumCharacters) {
  const characters = [...String(value ?? "")];
  if (characters.length <= maximumCharacters) return characters.join("");
  return `${characters.slice(0, maximumCharacters - 1).join("")}\u2026`;
}

function boundedFindingSet(index) {
  const fingerprints = [...index.keys()].sort(portableCompare);
  const examples = fingerprints
    .slice(0, PROJECTED_GRAPH_POLICY.maximumFindingExamples)
    .map((fingerprint) => {
      const finding = index.get(fingerprint);
      return {
        fingerprint,
        code: boundedText(finding.code, 64),
        path: finding.path === undefined
          ? null
          : boundedText(
              finding.path,
              PROJECTED_GRAPH_POLICY.maximumExamplePathCharacters,
            ),
        message: boundedText(
          finding.message,
          PROJECTED_GRAPH_POLICY.maximumExampleMessageCharacters,
        ),
      };
    });
  return Object.freeze({
    count: fingerprints.length,
    digest: taggedDigest(fingerprints),
    examples,
    omitted: Math.max(0, fingerprints.length - examples.length),
    truncated: fingerprints.length > examples.length,
  });
}

function boundedFindings(findings) {
  const ordered = findings
    .map((finding) => ({ finding, fingerprint: findingFingerprint(finding) }))
    .sort((left, right) =>
      portableCompare(left.finding.severity ?? "", right.finding.severity ?? "") ||
      portableCompare(left.finding.code ?? "", right.finding.code ?? "") ||
      portableCompare(left.finding.path ?? "", right.finding.path ?? "") ||
      portableCompare(left.fingerprint, right.fingerprint));
  const examples = ordered
    .slice(0, PROJECTED_GRAPH_POLICY.maximumFindingExamples)
    .map(({ finding, fingerprint }) => ({
      fingerprint,
      severity: boundedText(finding.severity, 16),
      code: boundedText(finding.code, 64),
      path: finding.path === undefined || finding.path === null
        ? null
        : boundedText(
            finding.path,
            PROJECTED_GRAPH_POLICY.maximumExamplePathCharacters,
          ),
      message: boundedText(
        finding.message,
        PROJECTED_GRAPH_POLICY.maximumExampleMessageCharacters,
      ),
    }));
  return Object.freeze({
    count: ordered.length,
    examples,
    omitted: Math.max(0, ordered.length - examples.length),
    truncated: ordered.length > examples.length,
  });
}

function selectIndex(source, predicate) {
  return new Map([...source].filter(([fingerprint]) => predicate(fingerprint)));
}

function comparisonFor(baselineFindings, projectedFindings) {
  const baseline = errorIndex(baselineFindings);
  const projected = errorIndex(projectedFindings);
  const introduced = selectIndex(projected, (fingerprint) => !baseline.has(fingerprint));
  const resolved = selectIndex(baseline, (fingerprint) => !projected.has(fingerprint));
  const persistent = selectIndex(projected, (fingerprint) => baseline.has(fingerprint));
  return Object.freeze({
    baseline: boundedFindingSet(baseline),
    projected: boundedFindingSet(projected),
    introduced: boundedFindingSet(introduced),
    resolved: boundedFindingSet(resolved),
    persistent: boundedFindingSet(persistent),
  });
}

function noteScope(note) {
  return typeof note?.frontmatter?.scope === "string"
    ? note.frontmatter.scope.normalize("NFC").toLowerCase()
    : null;
}

function normalizedFrontmatterValue(note, field) {
  const value = note?.frontmatter?.[field];
  return typeof value === "string" ? value.normalize("NFC").toLowerCase() : null;
}

function addImpact(impact, note) {
  if (!note) return;
  const id = normalizedFrontmatterValue(note, "id");
  if (id !== null) impact.ids.add(id);
  const scope = noteScope(note);
  const kind = note?.frontmatter?.kind;
  if (kind === "project" && scope !== null) impact.hubScopes.add(scope);
  if (kind === "decision" && scope !== null) impact.decisionScopes.add(scope);
  impact.linkIdentities.add(normalizeLinkIdentity(note.path));
  impact.linkIdentities.add(normalizeLinkIdentity(note.path.split("/").at(-1)));
  if (id !== null) impact.linkIdentities.add(normalizeLinkIdentity(id));
}

function conflictIsAffected(finding, note, impact) {
  if (impact.paths.has(note.path)) return true;
  const scope = noteScope(note);
  if (finding.code === "PATH001") {
    return impact.pathIdentities.has(portableIdentity(note.path));
  }
  if (finding.code === "ID001") {
    const id = normalizedFrontmatterValue(note, "id");
    return id !== null && impact.ids.has(id);
  }
  if (finding.code === "HUB001" || finding.code === "HUB002") {
    return scope !== null && impact.hubScopes.has(scope);
  }
  if (finding.code.startsWith("AUTH")) {
    return (
      note?.frontmatter?.kind === "decision" &&
      scope !== null &&
      impact.decisionScopes.has(scope)
    );
  }
  if (finding.code === "LINK004") {
    const target = finding.details?.normalizedTarget;
    return typeof target === "string" && impact.linkIdentities.has(target);
  }
  return false;
}

function affectedAuthorityConflicts(notesByPath, impact) {
  const conflicts = new Map();
  for (const note of notesByPath.values()) {
    for (const finding of note.diagnostics ?? []) {
      if (finding.severity !== "error" || !AFFECTED_CONFLICT_CODES.has(finding.code)) continue;
      if (!conflictIsAffected(finding, note, impact)) continue;
      const fingerprint = findingFingerprint(finding);
      if (!conflicts.has(fingerprint)) conflicts.set(fingerprint, finding);
    }
  }
  return boundedFindingSet(conflicts);
}

function globalFinding(code, message, details = undefined) {
  return {
    code,
    severity: "error",
    message,
    path: null,
    quarantined: false,
    ...(details === undefined ? {} : { details }),
  };
}

/**
 * Build and validate the exact in-memory post-image of an inspected graph.
 * This function performs no filesystem writes. The caller must still recheck
 * exact current bytes while holding the graph write lock before publication.
 */
export function validateProjectedGraph(inspection, changes) {
  assertInspection(inspection);
  const originalByPath = baselineByPath(inspection);
  const normalizedChanges = normalizeChanges(changes, originalByPath);
  const notesByPath = new Map(
    [...originalByPath].map(([path, note]) => [path, cloneBaselineNote(note)]),
  );
  const impact = {
    paths: new Set(),
    pathIdentities: new Set(),
    ids: new Set(),
    hubScopes: new Set(),
    decisionScopes: new Set(),
    linkIdentities: new Set(),
  };

  for (const change of normalizedChanges) {
    impact.paths.add(change.path);
    impact.pathIdentities.add(portableIdentity(change.path));
    const previous = originalByPath.get(change.path);
    addImpact(impact, previous);
    if (change.after === null) {
      notesByPath.delete(change.path);
      continue;
    }
    const parsed = parseNoteBytes(
      {
        path: change.path,
        nonPortablePath: isNonPortableGraphPath(change.path, VALIDATION_POLICY),
      },
      change.after,
      VALIDATION_POLICY,
      { includeLexicalSource: true },
    );
    addImpact(impact, parsed);
    notesByPath.set(change.path, parsed);
  }

  const notes = [...notesByPath.values()].sort((left, right) =>
    portableCompare(left.path, right.path));
  applyPortablePathCollisions(notes);
  applyAuthorityValidation(notes, VALIDATION_POLICY);

  const globalFindings = [];
  let linkGraph = null;
  try {
    linkGraph = buildLinkGraph(notes, VALIDATION_POLICY);
  } catch (error) {
    if (!(error instanceof SyncoraError) || error.code !== "LINK005") throw error;
    globalFindings.push(globalFinding(error.code, error.message, error.details));
  }

  const totalBytes = notes.reduce((total, note) => total + note.byteLength, 0);
  if (notes.length > VALIDATION_POLICY.maxMarkdownFiles) {
    globalFindings.push(globalFinding(
      "GRAPH003",
      "Projected graph Markdown file limit exceeded.",
      { files: notes.length, limit: VALIDATION_POLICY.maxMarkdownFiles },
    ));
  }
  if (totalBytes > VALIDATION_POLICY.maxTotalBytes) {
    globalFindings.push(globalFinding(
      "GRAPH003",
      "Projected graph total byte limit exceeded.",
      { bytes: totalBytes, limit: VALIDATION_POLICY.maxTotalBytes },
    ));
  }

  const scanFindings = inspection.scan?.findings ?? [];
  const baselineFindings = flattenFindings(inspection.notes, scanFindings);
  const projectedFindings = flattenFindings(notes, scanFindings, globalFindings);
  const errorFingerprints = comparisonFor(baselineFindings, projectedFindings);
  const boundedProjectedFindings = boundedFindings(projectedFindings);
  const authorityConflicts = affectedAuthorityConflicts(notesByPath, impact);
  const revision = graphRevision(notes);
  const ok =
    errorFingerprints.introduced.count === 0 &&
    authorityConflicts.count === 0;

  const report = Object.freeze({
    reportSchemaVersion: 1,
    specification: PROJECTED_GRAPH_POLICY.specification,
    ok,
    mode: "read-only-post-image",
    graph: {
      root: inspection.graph.resolvedGraphPath,
      baselineRevision: inspection.report.graph.revision,
      revision,
    },
    summary: {
      changes: {
        total: normalizedChanges.length,
        create: normalizedChanges.filter((change) => change.action === "create").length,
        update: normalizedChanges.filter((change) => change.action === "update").length,
        delete: normalizedChanges.filter((change) => change.action === "delete").length,
        unchanged: normalizedChanges.filter((change) => change.action === "unchanged").length,
      },
      files: notes.length,
      totalBytes,
      baselineErrors: errorFingerprints.baseline.count,
      projectedErrors: errorFingerprints.projected.count,
      introducedErrors: errorFingerprints.introduced.count,
      resolvedErrors: errorFingerprints.resolved.count,
      persistentErrors: errorFingerprints.persistent.count,
      affectedAuthorityConflicts: authorityConflicts.count,
      degraded: errorFingerprints.projected.count > 0,
    },
    errorFingerprints,
    affectedAuthorityConflicts: authorityConflicts,
    findings: boundedProjectedFindings,
  });

  return {
    ok,
    report,
    graphRevision: revision,
    notes,
    notesByPath,
    linkGraph,
    changes: normalizedChanges,
    findings: boundedProjectedFindings,
    errorFingerprints,
  };
}
