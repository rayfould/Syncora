import { SyncoraError } from "./cli.mjs";
import { inspectWorkspace } from "./validate.mjs";

export async function readBacklinks(options) {
  const inspection = await inspectWorkspace(options);
  const resolution = inspection.linkGraph.resolveReference(options.note);

  if (resolution.status === "unsafe") {
    throw new SyncoraError("LINK002", "Backlink target is unsafe.", {
      target: options.note,
    });
  }
  if (resolution.status === "unresolved") {
    throw new SyncoraError("LINK003", "Backlink target does not resolve.", {
      target: options.note,
      normalizedTarget: resolution.normalizedTarget,
    });
  }
  if (resolution.status === "ambiguous") {
    const candidates = resolution.candidates.map((candidate) => candidate.path);
    throw new SyncoraError("LINK004", "Backlink target is ambiguous.", {
      target: options.note,
      normalizedTarget: resolution.normalizedTarget,
      phase: resolution.phase,
      candidateCount: candidates.length,
      candidates: candidates.slice(0, 10),
      omittedCandidates: Math.max(0, candidates.length - 10),
    });
  }

  const backlinks = inspection.linkGraph.backlinks.get(resolution.note.path) ?? [];
  const limit = options.limit;
  return {
    reportSchemaVersion: 1,
    ok: true,
    command: "backlinks",
    mode: "canonical-read-only",
    workspace: inspection.workspace.realPath,
    graph: inspection.report.graph,
    query: options.note,
    target: {
      path: resolution.note.path,
      id: typeof resolution.note.frontmatter.id === "string"
        ? resolution.note.frontmatter.id
        : null,
      title: resolution.note.title,
      authorityClass: resolution.note.authorityClass,
      resolution: resolution.phase,
    },
    summary: {
      graphValid: inspection.report.summary.valid,
      total: backlinks.length,
      returned: Math.min(backlinks.length, limit),
      omitted: Math.max(0, backlinks.length - limit),
      validationErrors: inspection.report.summary.diagnostics.error,
      validationWarnings: inspection.report.summary.diagnostics.warning,
    },
    backlinks: backlinks.slice(0, limit).map((edge) => ({
      path: edge.sourcePath,
      authorityClass: edge.sourceAuthority,
      method: edge.method,
      references: edge.references,
      occurrences: edge.occurrences,
    })),
  };
}
