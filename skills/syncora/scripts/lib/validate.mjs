import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";

import { applyAuthorityValidation } from "./authority-validator.mjs";
import { SyncoraError } from "./cli.mjs";
import { discoverMarkdownFiles } from "./graph-scanner.mjs";
import { buildLinkGraph } from "./link-resolver.mjs";
import { parseNote } from "./note-parser.mjs";
import {
  readSyncoraConfigIfPresent,
  resolveGraphContext,
  resolveWorkspace,
  samePath,
} from "./workspace.mjs";
import { withCanonicalReadInterlock } from "./writer-interlock.mjs";

export const VALIDATION_POLICY = Object.freeze({
  noteSchemaVersion: 1,
  maxNoteBytes: 262_144,
  maxLinksPerNote: 256,
  maxUniqueLinkReferences: 250_000,
  maxResolvedLinkEdges: 250_000,
  maxFrontmatterBytes: 65_536,
  maxHubCharacters: 12_000,
  maxHubLinks: 64,
  maxPortablePathCharacters: 4_096,
  maxPortablePathBytes: 4_096,
  maxPortableSegmentCharacters: 240,
  maxPortableSegmentBytes: 240,
  maxDirectories: 10_000,
  maxDepth: 64,
  maxMarkdownFiles: 50_000,
  maxTotalBytes: 536_870_912,
});
export const VALIDATION_SPECIFICATION = "syncora-validation-v1";

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 };
const AUTHORITY_CLASSES = [
  "canonical",
  "routing",
  "supporting",
  "historical",
  "transient",
  "unpromoted",
  "quarantined",
];

function portableCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function mapConcurrent(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(items.length, 1)) }, () => worker()),
  );
  return results;
}

export function graphRevision(notes) {
  const hash = createHash("sha256");
  hash.update("syncora-graph-revision-v1\n");
  for (const note of [...notes].sort((left, right) =>
    portableCompare(left.path, right.path))) {
    hash.update(note.path, "utf8");
    hash.update("\0");
    hash.update(note.rawSha256 ?? "unreadable", "utf8");
    hash.update("\n");
  }
  return `sha256:${hash.digest("hex")}`;
}

function sortFindings(findings) {
  return findings.sort((left, right) =>
    (SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity]) ||
    portableCompare(left.code, right.code) ||
    portableCompare(left.path ?? "", right.path ?? "") ||
    portableCompare(left.details?.normalizedTarget ?? "", right.details?.normalizedTarget ?? "") ||
    ((left.location?.byteOffset ?? -1) - (right.location?.byteOffset ?? -1)),
  );
}

function aggregateFindings(findings) {
  const groups = new Map();
  for (const finding of findings) {
    const key = [finding.severity, finding.code, finding.message, finding.quarantined].join("\0");
    const group = groups.get(key) ?? {
      code: finding.code,
      severity: finding.severity,
      message: finding.message,
      quarantined: finding.quarantined,
      occurrences: 0,
      examples: [],
    };
    group.occurrences += 1;
    if (group.examples.length < 10) {
      group.examples.push({
        ...(finding.path ? { path: finding.path } : {}),
        ...(finding.location ? { location: finding.location } : {}),
        ...(finding.details ? { details: finding.details } : {}),
      });
    }
    groups.set(key, group);
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      omittedExamples: Math.max(0, group.occurrences - group.examples.length),
      ...(group.occurrences === 1 && group.examples[0]?.path
        ? { path: group.examples[0].path }
        : {}),
      ...(group.occurrences === 1 && group.examples[0]?.location
        ? { location: group.examples[0].location }
        : {}),
    }))
    .sort((left, right) =>
      (SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity]) ||
      portableCompare(left.code, right.code) ||
      portableCompare(left.message, right.message),
    );
}

function countBy(items, key) {
  return items.reduce((count, item) => count + Number(item === key), 0);
}

export async function inspectWorkspaceUnlocked(options, settings = {}) {
  const workspace = await resolveWorkspace(options.workspace);
  const graph = await resolveGraphContext(workspace, {
    allowExternalGraphRoot: options.allowExternalGraphRoot,
  });
  const scan = await discoverMarkdownFiles(graph.resolvedGraphPath, VALIDATION_POLICY);
  const notes = await mapConcurrent(scan.files, 16, (file) =>
    parseNote(file, graph.resolvedGraphPath, VALIDATION_POLICY, {
      includeLexicalSource: settings.includeLexicalSource === true,
    }),
  );

  let finalRoot;
  try {
    finalRoot = await realpath(graph.graphPath);
  } catch (error) {
    throw new SyncoraError("READ001", "Graph root disappeared during validation.", {
      cause: error.message,
    });
  }
  if (!samePath(finalRoot, graph.resolvedGraphPath)) {
    throw new SyncoraError("READ001", "Graph root identity changed during validation.");
  }

  applyAuthorityValidation(notes, VALIDATION_POLICY);
  const linkGraph = buildLinkGraph(notes, VALIDATION_POLICY);
  const rawFindings = sortFindings([
    ...scan.findings,
    ...notes.flatMap((note) => note.diagnostics),
  ]);
  const diagnostics = aggregateFindings(rawFindings);
  const countsByCode = Object.create(null);
  for (const finding of rawFindings) {
    countsByCode[finding.code] = (countsByCode[finding.code] ?? 0) + 1;
  }
  const byCode = Object.fromEntries(
    Object.entries(countsByCode).sort(([left], [right]) => portableCompare(left, right)),
  );
  const authority = Object.fromEntries(
    AUTHORITY_CLASSES.map((classification) => [
      classification,
      countBy(notes.map((note) => note.authorityClass), classification),
    ]),
  );
  const errorCount = rawFindings.filter((item) => item.severity === "error").length;
  const warningCount = rawFindings.filter((item) => item.severity === "warning").length;

  const report = {
    reportSchemaVersion: 1,
    validationSpecification: VALIDATION_SPECIFICATION,
    ok: errorCount === 0,
    command: "validate",
    mode: "read-only",
    workspace: workspace.realPath,
    graph: {
      root: graph.resolvedGraphPath,
      external: graph.external,
      revision: graphRevision(notes),
    },
    policy: { ...VALIDATION_POLICY },
    summary: {
      valid: errorCount === 0,
      files: {
        discovered: notes.length,
        parsed: notes.filter((note) => note.authorityClass !== "quarantined").length,
        quarantined: authority.quarantined,
        skipped: scan.findings.filter((item) => item.code === "PATH002").length,
        totalBytes: scan.totalBytes,
      },
      schema: {
        current: countBy(notes.map((note) => note.schemaStatus), "current"),
        legacy: countBy(notes.map((note) => note.schemaStatus), "legacy"),
        future: countBy(notes.map((note) => note.schemaStatus), "future"),
        invalid: countBy(notes.map((note) => note.schemaStatus), "invalid"),
      },
      authority,
      links: linkGraph.summary,
      aliases: linkGraph.aliases,
      diagnostics: {
        info: rawFindings.filter((item) => item.severity === "info").length,
        warning: warningCount,
        error: errorCount,
        byCode,
      },
    },
    diagnostics,
  };

  return { report, notes, linkGraph, workspace, graph, scan };
}

export async function inspectWorkspace(options, settings = {}) {
  const workspace = await resolveWorkspace(options.workspace);
  if (!await readSyncoraConfigIfPresent(workspace.realPath)) {
    return inspectWorkspaceUnlocked(options, settings);
  }
  return withCanonicalReadInterlock(
    options,
    () => inspectWorkspaceUnlocked(options, settings),
    settings.readInterlockCapability,
  );
}

export async function validateWorkspace(options) {
  return (await inspectWorkspace(options)).report;
}
