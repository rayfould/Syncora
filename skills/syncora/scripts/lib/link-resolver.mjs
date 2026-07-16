import { posix } from "node:path";

import { isUnsafeWikiTarget } from "./wiki-links.mjs";

const AUTHORITATIVE_SOURCES = new Set(["canonical", "routing"]);

function portableCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function withoutMarkdownExtension(value) {
  return value.replace(/\.md$/i, "");
}

export function normalizeLinkIdentity(value) {
  return withoutMarkdownExtension(value.trim().replaceAll("\\", "/"))
    .normalize("NFC")
    .toLowerCase();
}

function sourceSeverity(note) {
  if (AUTHORITATIVE_SOURCES.has(note.authorityClass)) return "error";
  if (note.authorityClass === "quarantined") return "info";
  return "warning";
}

function addCandidate(index, key, note) {
  if (!key) return;
  const candidates = index.get(key) ?? new Map();
  candidates.set(note.path, note);
  index.set(key, candidates);
}

function noteAliases(note) {
  const aliases = [];
  const filename = withoutMarkdownExtension(posix.basename(note.path));
  if (filename.toLowerCase() !== "readme") aliases.push(filename);
  if (typeof note.frontmatter.id === "string" && note.frontmatter.id.trim() !== "") {
    aliases.push(note.frontmatter.id);
  }
  return aliases;
}

function sortedCandidates(candidates) {
  return [...candidates.values()].sort((left, right) =>
    portableCompare(left.path, right.path),
  );
}

function resolutionDiagnostic(note, code, message, target, normalizedTarget, phase, candidates = []) {
  const paths = candidates.map((candidate) => candidate.path);
  note.diagnostics.push({
    code,
    severity: sourceSeverity(note),
    message,
    path: note.path,
    quarantined: false,
    details: {
      target,
      normalizedTarget,
      phase,
      candidateCount: paths.length,
      candidates: paths.slice(0, 10),
      omittedCandidates: Math.max(0, paths.length - 10),
    },
  });
}

function buildIndexes(notes) {
  const exact = new Map();
  const aliases = new Map();

  for (const note of notes) {
    addCandidate(exact, normalizeLinkIdentity(note.path), note);
    for (const alias of noteAliases(note)) {
      addCandidate(aliases, normalizeLinkIdentity(alias), note);
    }
  }

  return { exact, aliases };
}

function createResolver(indexes) {
  return (target) => {
    if (typeof target !== "string" || target.trim() === "" || isUnsafeWikiTarget(target)) {
      return { status: "unsafe", target, normalizedTarget: "", phase: "none", candidates: [] };
    }

    const normalizedTarget = normalizeLinkIdentity(target);
    const exactCandidates = sortedCandidates(indexes.exact.get(normalizedTarget) ?? new Map());
    if (exactCandidates.length === 1) {
      return {
        status: "resolved",
        target,
        normalizedTarget,
        phase: "exact",
        note: exactCandidates[0],
        candidates: exactCandidates,
      };
    }
    if (exactCandidates.length > 1) {
      return {
        status: "ambiguous",
        target,
        normalizedTarget,
        phase: "exact",
        candidates: exactCandidates,
      };
    }

    const aliasCandidates = sortedCandidates(indexes.aliases.get(normalizedTarget) ?? new Map());
    if (aliasCandidates.length === 1) {
      return {
        status: "resolved",
        target,
        normalizedTarget,
        phase: "alias",
        note: aliasCandidates[0],
        candidates: aliasCandidates,
      };
    }
    if (aliasCandidates.length > 1) {
      return {
        status: "ambiguous",
        target,
        normalizedTarget,
        phase: "alias",
        candidates: aliasCandidates,
      };
    }

    return {
      status: "unresolved",
      target,
      normalizedTarget,
      phase: "alias",
      candidates: [],
    };
  };
}

function uniqueReferences(note) {
  const references = new Map();
  for (const reference of note.linkReferences ?? []) {
    if (reference.unsafe || isUnsafeWikiTarget(reference.target)) continue;
    const normalizedTarget = normalizeLinkIdentity(reference.target);
    if (!normalizedTarget) continue;
    const existing = references.get(normalizedTarget);
    if (existing) {
      existing.occurrences += reference.occurrences;
      existing.targets.add(reference.target);
      continue;
    }
    references.set(normalizedTarget, {
      normalizedTarget,
      target: reference.target,
      targets: new Set([reference.target]),
      occurrences: reference.occurrences,
    });
  }
  return [...references.values()].sort((left, right) =>
    portableCompare(left.normalizedTarget, right.normalizedTarget),
  );
}

export function buildLinkGraph(notes) {
  const indexes = buildIndexes(notes);
  const resolveReference = createResolver(indexes);
  const edgesByPair = new Map();
  let uniqueReferenceCount = 0;
  let resolvedReferenceCount = 0;
  let unresolvedReferenceCount = 0;
  let ambiguousReferenceCount = 0;
  let linksToQuarantinedTargets = 0;

  for (const source of notes) {
    for (const reference of uniqueReferences(source)) {
      uniqueReferenceCount += 1;
      const resolution = resolveReference(reference.target);
      if (resolution.status === "unresolved") {
        unresolvedReferenceCount += 1;
        resolutionDiagnostic(
          source,
          "LINK003",
          "Wiki-link target does not resolve by exact path or unique alias.",
          reference.target,
          reference.normalizedTarget,
          resolution.phase,
        );
        continue;
      }
      if (resolution.status === "ambiguous") {
        ambiguousReferenceCount += 1;
        resolutionDiagnostic(
          source,
          "LINK004",
          "Wiki-link target is ambiguous.",
          reference.target,
          reference.normalizedTarget,
          resolution.phase,
          resolution.candidates,
        );
        continue;
      }
      if (resolution.status !== "resolved") continue;

      resolvedReferenceCount += 1;
      if (resolution.note.authorityClass === "quarantined") {
        linksToQuarantinedTargets += 1;
      }
      const edgeKey = `${source.path}\0${resolution.note.path}`;
      const existing = edgesByPair.get(edgeKey);
      if (existing) {
        if (resolution.phase === "exact") existing.method = "exact";
        existing.references += 1;
        existing.occurrences += reference.occurrences;
      } else {
        edgesByPair.set(edgeKey, {
          sourcePath: source.path,
          sourceAuthority: source.authorityClass,
          targetPath: resolution.note.path,
          targetAuthority: resolution.note.authorityClass,
          method: resolution.phase,
          references: 1,
          occurrences: reference.occurrences,
        });
      }
    }
  }

  const edges = [...edgesByPair.values()].sort((left, right) =>
    portableCompare(left.targetPath, right.targetPath) ||
    portableCompare(left.sourcePath, right.sourcePath),
  );
  const backlinks = new Map();
  for (const edge of edges) {
    const entries = backlinks.get(edge.targetPath) ?? [];
    entries.push(edge);
    backlinks.set(edge.targetPath, entries);
  }

  const ambiguousAliases = [...indexes.aliases.values()].filter(
    (candidates) => candidates.size > 1,
  ).length;

  return {
    edges,
    backlinks,
    resolveReference,
    aliases: {
      keys: indexes.aliases.size,
      ambiguousKeys: ambiguousAliases,
    },
    summary: {
      uniqueReferences: uniqueReferenceCount,
      resolvedReferences: resolvedReferenceCount,
      unresolvedReferences: unresolvedReferenceCount,
      ambiguousReferences: ambiguousReferenceCount,
      resolvedEdges: edges.length,
      backlinkEdges: edges.length,
      linksToQuarantinedTargets,
    },
  };
}
