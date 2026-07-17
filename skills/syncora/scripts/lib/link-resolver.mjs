import { posix } from "node:path";

import { SyncoraError } from "./cli.mjs";
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

function sortedIndex(index) {
  return new Map(
    [...index.entries()].map(([key, candidates]) => [key, sortedCandidates(candidates)]),
  );
}

function resolutionDiagnostic(note, code, message, target, normalizedTarget, phase, candidates = []) {
  const candidateCount = candidates.length;
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
      candidateCount,
      candidates: candidates.slice(0, 10).map((candidate) => candidate.path),
      omittedCandidates: Math.max(0, candidateCount - 10),
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

  return { exact: sortedIndex(exact), aliases: sortedIndex(aliases) };
}

function createResolver(indexes) {
  return (target) => {
    if (typeof target !== "string" || target.trim() === "" || isUnsafeWikiTarget(target)) {
      return { status: "unsafe", target, normalizedTarget: "", phase: "none", candidates: [] };
    }

    const normalizedTarget = normalizeLinkIdentity(target);
    const exactCandidates = indexes.exact.get(normalizedTarget) ?? [];
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

    const aliasCandidates = indexes.aliases.get(normalizedTarget) ?? [];
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

export function buildLinkGraph(notes, policy = {}) {
  const maximumUniqueReferences = policy.maxUniqueLinkReferences ?? 250_000;
  const maximumResolvedEdges = policy.maxResolvedLinkEdges ?? 250_000;
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
      if (uniqueReferenceCount > maximumUniqueReferences) {
        throw new SyncoraError(
          "LINK005",
          "Graph unique wiki-link reference limit exceeded.",
          { references: uniqueReferenceCount, limit: maximumUniqueReferences },
        );
      }
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
        if (edgesByPair.size >= maximumResolvedEdges) {
          throw new SyncoraError(
            "LINK005",
            "Graph resolved wiki-link edge limit exceeded.",
            { edgesAtLeast: edgesByPair.size + 1, limit: maximumResolvedEdges },
          );
        }
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
  const outgoing = new Map();
  for (const edge of edges) {
    const entries = backlinks.get(edge.targetPath) ?? [];
    entries.push(edge);
    backlinks.set(edge.targetPath, entries);
    const outgoingEntries = outgoing.get(edge.sourcePath) ?? [];
    outgoingEntries.push(edge);
    outgoing.set(edge.sourcePath, outgoingEntries);
  }

  const ambiguousAliases = [...indexes.aliases.values()].filter(
    (candidates) => candidates.length > 1,
  ).length;

  return {
    edges,
    backlinks,
    outgoing,
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
