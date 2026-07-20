const APPROVAL_SUMMARY_POLICY = Object.freeze({
  maximumPurposeCharacters: 480,
  maximumRepresentativePaths: 8,
  maximumAffectedAreas: 6,
  maximumOperationKinds: 10,
  maximumAuthorityReasons: 3,
  maximumWarnings: 4,
});

function boundedText(value, maximum) {
  if (typeof value !== "string") return "";
  const normalized = value.replace(/\s+/gu, " ").trim();
  const characters = [...normalized];
  if (characters.length <= maximum) return normalized;
  return `${characters.slice(0, Math.max(0, maximum - 1)).join("")}…`;
}

function pathArea(path) {
  const segments = path.split("/");
  if (segments.length <= 1) return "graph root";
  if (segments[0] === "knowledge" && segments.length > 2) {
    return `${segments[0]}/${segments[1]}`;
  }
  return segments[0];
}

function countBy(values, keyFor) {
  const counts = new Map();
  for (const value of values) {
    const key = keyFor(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function rankedCounts(counts, maximum) {
  return [...counts]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name))
    .slice(0, maximum);
}

function uniquePaths(paths) {
  const seen = new Set();
  const result = [];
  for (const path of paths) {
    const identity = path.normalize("NFC").toLowerCase();
    if (seen.has(identity)) continue;
    seen.add(identity);
    result.push(path);
  }
  return result;
}

function representativePaths(paths, rankedAreas) {
  const ordered = [...uniquePaths(paths)].sort((left, right) => left.localeCompare(right));
  const selected = [];
  const selectedIdentities = new Set();
  const add = (path) => {
    const identity = path.normalize("NFC").toLowerCase();
    if (selectedIdentities.has(identity)) return;
    selectedIdentities.add(identity);
    selected.push(path);
  };

  for (const { name } of rankedAreas) {
    const candidate = ordered.find((path) => pathArea(path) === name);
    if (candidate) add(candidate);
    if (selected.length === APPROVAL_SUMMARY_POLICY.maximumRepresentativePaths) break;
  }
  for (const path of ordered) {
    if (selected.length === APPROVAL_SUMMARY_POLICY.maximumRepresentativePaths) break;
    add(path);
  }
  return {
    paths: selected,
    omitted: Math.max(0, ordered.length - selected.length),
  };
}

function pathOverview(paths) {
  const unique = uniquePaths(paths);
  const areaCounts = countBy(unique, pathArea);
  const areas = rankedCounts(
    areaCounts,
    APPROVAL_SUMMARY_POLICY.maximumAffectedAreas,
  ).map(({ name, count }) => ({ area: name, count }));
  const examples = representativePaths(
    unique,
    areas.map(({ area, count }) => ({ name: area, count })),
  );
  return {
    affectedAreas: areas,
    omittedAreaCount: Math.max(0, areaCounts.size - areas.length),
    representativePaths: examples.paths,
    omittedPathCount: examples.omitted,
  };
}

function operationKindCounts(operations) {
  return rankedCounts(
    countBy(operations, (operation) => operation.kind),
    APPROVAL_SUMMARY_POLICY.maximumOperationKinds,
  ).map(({ name, count }) => ({ kind: name, count }));
}

function actionFor(change) {
  if (change.expectedPriorSha256 === null) return "create";
  if (change.afterSha256 === null) return "delete";
  return "update";
}

export function governedApprovalSummary(summary, artifact, { dryRun = false } = {}) {
  const changes = summary.operations.flatMap((operation) => operation.changes);
  const actionCounts = countBy(changes, actionFor);
  const overview = pathOverview(changes.map((change) => change.path));
  const warnings = [];
  if (summary.assessment.duplicateCandidates.length > 0) {
    warnings.push(
      `${summary.assessment.duplicateCandidates.length} possible duplicate note candidate(s) require attention.`,
    );
  }
  if (summary.assessment.projectedValidation.findingCount > 0) {
    warnings.push(
      `The projected graph contains ${summary.assessment.projectedValidation.findingCount} validation finding(s).`,
    );
  }

  const authorityReasons = summary.assessment.authorityImpact.reasons.slice(
    0,
    APPROVAL_SUMMARY_POLICY.maximumAuthorityReasons,
  );
  return Object.freeze({
    kind: "syncora.knowledge-change-summary",
    title: "Syncora knowledge update summary",
    purpose: boundedText(summary.reason, APPROVAL_SUMMARY_POLICY.maximumPurposeCharacters),
    changes: Object.freeze({
      total: summary.changeCount,
      creates: actionCounts.get("create") ?? 0,
      updates: actionCounts.get("update") ?? 0,
      deletes: actionCounts.get("delete") ?? 0,
    }),
    operations: Object.freeze({
      total: summary.operationCount,
      kinds: Object.freeze(operationKindCounts(summary.operations)),
      omittedKindCount: Math.max(
        0,
        new Set(summary.operations.map((operation) => operation.kind)).size -
          APPROVAL_SUMMARY_POLICY.maximumOperationKinds,
      ),
    }),
    authorityImpact: Object.freeze({
      level: summary.assessment.authorityImpact.level,
      reasons: Object.freeze(authorityReasons),
      omittedReasonCount: Math.max(
        0,
        summary.assessment.authorityImpact.reasons.length - authorityReasons.length,
      ),
    }),
    affectedAreas: Object.freeze(overview.affectedAreas),
    omittedAreaCount: overview.omittedAreaCount,
    representativePaths: Object.freeze(overview.representativePaths),
    omittedPathCount: overview.omittedPathCount,
    warnings: Object.freeze(
      warnings.slice(0, APPROVAL_SUMMARY_POLICY.maximumWarnings),
    ),
    fullDetails: Object.freeze({
      available: !dryRun && typeof artifact?.path === "string",
      path: typeof artifact?.path === "string" ? artifact.path : null,
      optional: true,
    }),
    canonicalMarkdownChanged: false,
    automatic: true,
  });
}

export function adoptionPreviewSummary(manifest, {
  fixtureCount,
  reviewPackPath,
  sourceInventory = [],
} = {}) {
  const targets = manifest.operations.map((operation) => operation.target.path);
  const overview = pathOverview(targets);
  const dispositions = countBy(
    manifest.dispositions,
    (disposition) => disposition.disposition,
  );
  const inventory = countBy(
    sourceInventory,
    (entry) => entry.classification,
  );
  const warnings = [];
  if ((inventory.get("blocked") ?? 0) > 0) {
    warnings.push(
      `The source inventory contains ${inventory.get("blocked")} blocked note(s); inspect their reviewed replacement handling if needed.`,
    );
  }
  if ((dispositions.get("defer") ?? 0) > 0) {
    warnings.push(
      `${dispositions.get("defer")} legacy note(s) remain deferred rather than promoted.`,
    );
  }
  return Object.freeze({
    kind: "syncora.adoption-preview-summary",
    title: "Syncora adoption preview",
    purpose: boundedText(
      manifest.review.reason,
      APPROVAL_SUMMARY_POLICY.maximumPurposeCharacters,
    ),
    sourceNotes: Object.freeze({
      total: sourceInventory.length || manifest.dispositions.length,
      currentSchema: inventory.get("current-schema") ?? 0,
      reviewRequired: inventory.get("review-required") ?? manifest.dispositions.length,
      blocked: inventory.get("blocked") ?? 0,
      reviewed: manifest.dispositions.length,
      promoted: dispositions.get("promote-via-targets") ?? 0,
      evidenceOnly: dispositions.get("evidence-only") ?? 0,
      deferred: dispositions.get("defer") ?? 0,
    }),
    targetNotes: manifest.operations.length,
    shadowChecks: fixtureCount ?? 0,
    affectedAreas: Object.freeze(overview.affectedAreas),
    omittedAreaCount: overview.omittedAreaCount,
    representativePaths: Object.freeze(overview.representativePaths),
    omittedPathCount: overview.omittedPathCount,
    agentInstructions: "Replace the retired predecessor workflow with Syncora instructions.",
    preservation: "Retain legacy source notes and rollback evidence.",
    warnings: Object.freeze(
      warnings.slice(0, APPROVAL_SUMMARY_POLICY.maximumWarnings),
    ),
    fullDetails: Object.freeze({
      available: typeof reviewPackPath === "string",
      path: typeof reviewPackPath === "string" ? reviewPackPath : null,
      optional: true,
    }),
    canonicalMarkdownChanged: false,
    automatic: true,
  });
}

export { APPROVAL_SUMMARY_POLICY };
