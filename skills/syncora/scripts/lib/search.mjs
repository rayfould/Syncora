import {
  lexicalRootIdentity,
  readLexicalCache,
  resolveLexicalCache,
  writeLexicalCache,
} from "./lexical-cache.mjs";
import {
  buildLexicalIndex,
  lexicalProfile,
  searchLexicalIndex,
  validateSearchQuery,
} from "./lexical-index.mjs";
import { parseNote } from "./note-parser.mjs";
import { SyncoraError } from "./cli.mjs";
import {
  inspectWorkspaceUnlocked as inspectWorkspace,
  VALIDATION_POLICY,
} from "./validate.mjs";
import {
  requireInitializedWorkspace,
  resolveWorkspace,
  samePath,
} from "./workspace.mjs";
import { withCanonicalReadInterlock } from "./writer-interlock.mjs";

function cacheState(cacheRead, built, graphRevision, noCache) {
  if (noCache) return "memory";
  if (
    cacheRead.payload?.graphRevision === graphRevision &&
    built.stats.rebuilt === 0 &&
    built.stats.removed === 0
  ) {
    return "hit";
  }
  if (built.stats.reused > 0) return "incremental";
  return "rebuilt";
}

function lexicalSourceLoader(inspection) {
  const filesByPath = new Map(inspection.scan.files.map((file) => [file.path, file]));
  return async (note) => {
    const file = filesByPath.get(note.path);
    if (!file) {
      throw new SyncoraError("READ001", `Indexed note disappeared: ${note.path}`);
    }
    const reparsed = await parseNote(
      file,
      inspection.graph.resolvedGraphPath,
      VALIDATION_POLICY,
      { includeLexicalSource: true },
    );
    if (
      reparsed.rawSha256 !== note.rawSha256 ||
      !reparsed.lexicalSource ||
      reparsed.diagnostics.some((item) => item.code === "READ001")
    ) {
      throw new SyncoraError(
        "READ001",
        `Note changed or became unreadable during lexical materialization: ${note.path}`,
      );
    }
    return { ...note, lexicalSource: reparsed.lexicalSource };
  };
}

async function verifyStableGraph(options, inspection) {
  let verified;
  try {
    verified = await inspectWorkspace(options);
  } catch (error) {
    throw new SyncoraError("READ001", "Graph could not be reverified after indexing.", {
      cause: error instanceof Error ? error.message : String(error),
      ...(error?.code ? { sourceCode: error.code } : {}),
    });
  }
  if (
    (verified.report.summary.diagnostics.byCode.READ001 ?? 0) > 0 ||
    !samePath(verified.graph.resolvedGraphPath, inspection.graph.resolvedGraphPath) ||
    verified.report.graph.revision !== inspection.report.graph.revision
  ) {
    throw new SyncoraError(
      "READ001",
      "Graph content or root identity changed while the lexical index was being built.",
    );
  }
}

async function searchWorkspaceUnlocked(options, hooks = {}, settings = {}) {
  const workspace = await resolveWorkspace(options.workspace);
  await requireInitializedWorkspace(workspace.realPath);
  validateSearchQuery(options.query);

  const inspection = await inspectWorkspace(options);
  if ((inspection.report.summary.diagnostics.byCode.READ001 ?? 0) > 0) {
    throw new SyncoraError(
      "READ001",
      "Search cannot index an incomplete graph read.",
    );
  }

  let cacheContext = null;
  let cacheRead = { payload: null, state: "disabled", warning: null };
  const warnings = [];
  const profile = lexicalProfile(options.includeHistory);
  if (!options.noCache) {
    try {
      cacheContext = await resolveLexicalCache(
        inspection.workspace.realPath,
        inspection.graph.resolvedGraphPath,
        profile,
      );
      await hooks.afterCacheResolve?.(cacheContext);
      cacheRead = await readLexicalCache(cacheContext);
    } catch (error) {
      warnings.push({
        code: "CACHE001",
        message: "Search used an in-memory index because the cache location is unavailable.",
        details: {
          cause: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  const rootIdentity = cacheContext?.rootIdentity ??
    lexicalRootIdentity(inspection.graph.resolvedGraphPath);
  const built = await buildLexicalIndex({
    notes: inspection.notes,
    cachedPayload: cacheRead.payload,
    graphRevision: inspection.report.graph.revision,
    rootIdentity,
    profile,
    loadLexicalSource: lexicalSourceLoader(inspection),
  });
  await hooks.beforeFinalVerify?.({ built, cacheContext, inspection });
  await verifyStableGraph(options, inspection);
  const searched = searchLexicalIndex({
    payload: built.payload,
    notes: inspection.notes,
    query: options.query,
    limit: options.limit,
    includeHistory: options.includeHistory,
  });

  if (cacheRead.warning) warnings.push(cacheRead.warning);
  let published = false;
  let publicationFailed = false;
  const shouldPublish = !options.noCache && cacheContext !== null && (
    cacheRead.payload?.graphRevision !== inspection.report.graph.revision ||
    built.stats.rebuilt > 0 ||
    built.stats.removed > 0
  );
  if (shouldPublish) {
    try {
      await hooks.beforeCachePublish?.(cacheContext);
      await writeLexicalCache(cacheContext, built.payload);
      published = true;
    } catch (error) {
      publicationFailed = true;
      warnings.push({
        code: "CACHE001",
        message: "Search used the source-derived in-memory index because cache publication failed.",
        details: {
          cause: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  const state = cacheState(
    cacheRead,
    built,
    inspection.report.graph.revision,
    options.noCache || cacheContext === null || publicationFailed,
  );
  const report = {
    reportSchemaVersion: 1,
    ok: true,
    command: "search",
    mode: "canonical-read-only",
    workspace: inspection.workspace.realPath,
    graph: inspection.report.graph,
    query: options.query,
    queryTerms: searched.queryTerms,
    includeHistory: options.includeHistory,
    index: {
      specification: built.payload.indexSpecId,
      revision: built.payload.indexRevision,
      profile,
      selectionAuthority: "none",
    },
    cache: {
      state,
      published,
      path: cacheContext?.cacheFile ?? null,
      reused: built.stats.reused,
      rebuilt: built.stats.rebuilt,
      removed: built.stats.removed,
      postings: built.stats.postings,
    },
    summary: {
      graphValid: inspection.report.summary.valid,
      validationErrors: inspection.report.summary.diagnostics.error,
      validationWarnings: inspection.report.summary.diagnostics.warning,
      indexed: searched.totalIndexed,
      eligible: searched.eligibleDocuments,
      matches: searched.matches,
      returned: searched.results.length,
      omitted: Math.max(0, searched.matches - searched.results.length),
    },
    results: searched.results,
    warnings,
  };
  if (settings.withValidatedSnapshot === true) {
    return { report, inspection };
  }
  return report;
}

export async function searchWorkspace(options, hooks = {}, settings = {}) {
  return withCanonicalReadInterlock(
    options,
    () => searchWorkspaceUnlocked(options, hooks, settings),
    settings.readInterlockCapability,
  );
}
