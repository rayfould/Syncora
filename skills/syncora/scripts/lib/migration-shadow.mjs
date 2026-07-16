import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

import {
  applyFilePlans,
  describePlan,
} from "./atomic-file.mjs";
import { loadAndValidateAuthorityManifest } from "./authority-manifest.mjs";
import { authorityRootIdentity } from "./authority-inventory.mjs";
import {
  compileContextPack,
  CONTEXT_COMPILER_POLICY,
  validateContextCase,
} from "./context-compiler.mjs";
import { SyncoraError } from "./cli.mjs";
import {
  assertMigrationLockCapability,
  readMigrationLockCapability,
  withMigrationGraphLock,
} from "./migration-lock.mjs";
import {
  parseStagedTarget,
  validateStagedAuthorityGraph,
} from "./migration-stage.mjs";
import {
  artifactReference,
  assertMigrationRoot,
  assertMigrationTransition,
  bindMigrationStoragePlans,
  migrationPaths,
  parseStrictJson,
  readMigrationBytes,
  readMigrationTargetBytes,
  readMigrationState,
  serializeMigrationJson,
  taggedSha256,
  verifyArtifactReference,
  workspaceIdentity,
} from "./migration-state.mjs";
import { graphRevision, inspectWorkspace, VALIDATION_POLICY } from "./validate.mjs";
import {
  isWithin,
  resolveGraphContext,
  resolveWorkspace,
  samePath,
} from "./workspace.mjs";

export const MIGRATION_SHADOW_POLICY = Object.freeze({
  schemaVersion: 1,
  fixtureSpecification: "syncora-shadow-fixtures-v1",
  reportSpecification: "syncora-shadow-report-v1",
  maximumFixtureBytes: 1_048_576,
});

function shadowError(code, message, details = undefined) {
  return new SyncoraError(code, message, details);
}

function exactKeys(value, expected, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw shadowError("MIGRATE011", `${label} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    !actual.every((key, index) => key === wanted[index])
  ) {
    throw shadowError("MIGRATE011", `${label} has missing or unknown fields.`);
  }
}

async function stableExternalFile(path, maximumBytes, label) {
  if (!isAbsolute(path ?? "")) {
    throw shadowError("MIGRATE011", `${label} path must be absolute.`);
  }
  const bytes = await readMigrationTargetBytes(
    path,
    dirname(path),
    maximumBytes,
    label,
  );
  if (bytes === null) {
    throw shadowError("MIGRATE011", `${label} is missing.`);
  }
  const resolved = await realpath(path);
  const after = await lstat(path, { bigint: true });
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    after.size > BigInt(maximumBytes) ||
    bytes.length !== Number(after.size)
  ) {
    throw shadowError("READ001", `${label} changed while it was being read.`);
  }
  return { path: resolved, bytes };
}

function validateFixtures(value) {
  exactKeys(value, ["schemaVersion", "kind", "cases"], "Shadow fixtures");
  if (
    value.schemaVersion !== MIGRATION_SHADOW_POLICY.schemaVersion ||
    value.kind !== MIGRATION_SHADOW_POLICY.fixtureSpecification
  ) {
    throw shadowError("MIGRATE011", "Shadow fixture schema or kind is unsupported.");
  }
  if (
    !Array.isArray(value.cases) ||
    value.cases.length < 1 ||
    value.cases.length > CONTEXT_COMPILER_POLICY.maximumCases
  ) {
    throw shadowError("MIGRATE011", "Shadow fixtures require a bounded non-empty case list.");
  }
  const cases = value.cases.map(validateContextCase);
  const ids = new Set();
  for (const item of cases) {
    if (ids.has(item.caseId)) {
      throw shadowError("MIGRATE011", `Shadow fixture case is duplicated: ${item.caseId}`);
    }
    ids.add(item.caseId);
  }
  return { ...value, cases };
}

export function validateStagedContentIndex(value, state) {
  exactKeys(
    value,
    [
      "schemaVersion",
      "kind",
      "migrationId",
      "manifestSha256",
      "graphRevision",
      "targetCount",
      "totalBytes",
      "entries",
    ],
    "Staged-content index",
  );
  if (
    value.schemaVersion !== 1 ||
    value.kind !== "syncora-staged-content-v1" ||
    value.migrationId !== state.migrationId ||
    value.manifestSha256 !== state.baseline.manifestSha256 ||
    value.graphRevision !== state.baseline.graphRevision ||
    value.targetCount !== state.baseline.targetCount ||
    !Array.isArray(value.entries) ||
    value.entries.length !== value.targetCount
  ) {
    throw shadowError("MIGRATE011", "Staged-content index does not match migration state.");
  }
  return value;
}

export async function loadStagedNotes(paths, state, validated) {
  const artifact = await verifyArtifactReference(
    paths,
    state.artifacts.stagedContent,
    "Staged-content index",
  );
  const index = validateStagedContentIndex(
    parseStrictJson(artifact.bytes, "Staged-content index"),
    state,
  );
  const targetByPath = new Map(validated.targets.map((target) => [target.path, target]));
  const notes = [];
  let measuredBytes = 0;
  for (const entry of index.entries) {
    exactKeys(
      entry,
      ["operationId", "path", "contentSha256", "byteLength", "content"],
      "Staged-content entry",
    );
    const target = targetByPath.get(entry.path);
    if (
      !target ||
      entry.operationId !== target.operationId ||
      entry.contentSha256 !== target.contentSha256 ||
      typeof entry.content !== "string" ||
      !entry.content.startsWith("content/") ||
      entry.content.includes("..")
    ) {
      throw shadowError("MIGRATE011", `Staged-content entry is inconsistent: ${entry.path}`);
    }
    const path = join(paths.root, ...entry.content.split("/"));
    const bytes = await readMigrationTargetBytes(
      path,
      paths.root,
      VALIDATION_POLICY.maxNoteBytes,
      "Staged target",
    );
    if (
      bytes === null ||
      bytes.length !== entry.byteLength ||
      taggedSha256(bytes) !== entry.contentSha256
    ) {
      throw shadowError("MIGRATE011", `Staged target content is missing or corrupt: ${entry.path}`);
    }
    measuredBytes += bytes.length;
    const metadata = await lstat(path, { bigint: true });
    const resolved = await realpath(path);
    if (!isWithin(paths.root, resolved)) {
      throw shadowError("MIGRATE011", `Staged target escapes migration storage: ${entry.path}`);
    }
    notes.push(
      await parseStagedTarget({
        stagedRoot: paths.root,
        target,
        file: {
          bytes,
          metadata,
          resolved,
          size: bytes.length,
        },
      }),
    );
  }
  if (measuredBytes !== index.totalBytes) {
    throw shadowError("MIGRATE011", "Staged-content byte accounting diverged.");
  }
  return { index, notes };
}

export async function shadowMigration(options, execution = {}) {
  const workspace = await resolveWorkspace(options.workspace);
  const graph = await resolveGraphContext(workspace, {
    allowExternalGraphRoot: options.allowExternalGraphRoot,
  });
  const paths = migrationPaths(graph.resolvedGraphPath, options.migrationId);
  const lockCapability = readMigrationLockCapability(execution);
  if (lockCapability !== undefined) {
    assertMigrationLockCapability(lockCapability, {
      workspacePath: workspace.realPath,
      graphRoot: graph.resolvedGraphPath,
    });
  }
  const operation = async () => {
    await assertMigrationRoot(paths);
    const lockedGraph = await resolveGraphContext(workspace, {
      allowExternalGraphRoot: options.allowExternalGraphRoot,
    });
    if (lockCapability !== undefined) {
      assertMigrationLockCapability(lockCapability, {
        workspacePath: workspace.realPath,
        graphRoot: lockedGraph.resolvedGraphPath,
      });
    }
    if (!samePath(lockedGraph.resolvedGraphPath, graph.resolvedGraphPath)) {
      throw shadowError(
        "MIGRATE007",
        "Graph root changed after the migration lock was selected.",
      );
    }
    const rootIdentity = authorityRootIdentity(graph.resolvedGraphPath);
    const loadedState = await readMigrationState(paths, {
      migrationId: options.migrationId,
      workspaceIdentity: workspaceIdentity(workspace.realPath),
      rootIdentity,
    });
    if (!loadedState) {
      throw shadowError("MIGRATE006", "Migration must be staged before shadow validation.");
    }
    if (!new Set(["staged", "shadow-verified"]).has(loadedState.value.status)) {
      throw shadowError("MIGRATE006", `Shadow validation is unavailable from ${loadedState.value.status}.`);
    }
    const manifestArtifact = await verifyArtifactReference(
      paths,
      loadedState.value.artifacts.manifest,
      "Reviewed manifest",
    );
    const validated = await loadAndValidateAuthorityManifest({
      workspace: workspace.realPath,
      allowExternalGraphRoot: options.allowExternalGraphRoot,
      manifestPath: manifestArtifact.path,
    });
    if (
      validated.manifestSha256 !== loadedState.value.baseline.manifestSha256 ||
      validated.snapshot.bindings.graphRevision !== loadedState.value.baseline.graphRevision
    ) {
      throw shadowError("MIGRATE005", "Migration baseline is stale.");
    }
    const staged = await loadStagedNotes(paths, loadedState.value, validated);
    const live = await inspectWorkspace(
      {
        workspace: workspace.realPath,
        allowExternalGraphRoot: options.allowExternalGraphRoot,
      },
      { includeLexicalSource: true },
    );
    if (live.report.graph.revision !== loadedState.value.baseline.graphRevision) {
      throw shadowError("MIGRATE005", "Graph changed after migration staging.");
    }
    const targetPaths = new Set(validated.targets.map((target) => target.path));
    const combined = validateStagedAuthorityGraph(
      live.notes,
      staged.notes,
      targetPaths,
    );
    const fixturesFile = await stableExternalFile(
      options.fixtures,
      MIGRATION_SHADOW_POLICY.maximumFixtureBytes,
      "Shadow fixtures",
    );
    const fixtureSha256 = taggedSha256(fixturesFile.bytes);
    if (
      options.expectedFixturesSha256 !== undefined &&
      options.expectedFixturesSha256 !== fixtureSha256
    ) {
      throw shadowError(
        "MIGRATE016",
        "Shadow fixture bytes do not match the adoption bundle binding.",
      );
    }
    const fixtures = validateFixtures(
      parseStrictJson(fixturesFile.bytes, "Shadow fixtures"),
    );
    const virtualRevision = graphRevision(combined);
    const cases = [];
    for (const fixture of fixtures.cases) {
      cases.push(
        await compileContextPack({
          notes: combined,
          graphRevision: virtualRevision,
          rootIdentity,
          fixture,
        }),
      );
    }
    const passed = cases.filter((item) => item.pass).length;
    const report = {
      schemaVersion: MIGRATION_SHADOW_POLICY.schemaVersion,
      kind: MIGRATION_SHADOW_POLICY.reportSpecification,
      migrationId: options.migrationId,
      manifestSha256: loadedState.value.baseline.manifestSha256,
      stagedContentSha256: loadedState.value.artifacts.stagedContent.sha256,
      fixtureSha256,
      compilerSpecification: CONTEXT_COMPILER_POLICY.specification,
      baselineGraphRevision: loadedState.value.baseline.graphRevision,
      virtualGraphRevision: virtualRevision,
      summary: {
        cases: cases.length,
        passed,
        failed: cases.length - passed,
        pass: passed === cases.length,
      },
      cases,
    };
    const fixtureBytes = fixturesFile.bytes;
    const reportBytes = serializeMigrationJson(report);
    const nextStatus = report.summary.pass ? "shadow-verified" : "staged";
    assertMigrationTransition(loadedState.value.status, nextStatus);
    const now = new Date().toISOString();
    const nextState = {
      ...loadedState.value,
      status: nextStatus,
      updatedAt:
        loadedState.value.status === nextStatus &&
        loadedState.value.artifacts.fixtures?.sha256 === taggedSha256(fixtureBytes) &&
        loadedState.value.artifacts.shadowReport?.sha256 === taggedSha256(reportBytes)
          ? loadedState.value.updatedAt
          : now,
      artifacts: {
        ...loadedState.value.artifacts,
        fixtures: artifactReference(paths, paths.fixtures, fixtureBytes),
        shadowReport: artifactReference(paths, paths.shadowReport, reportBytes),
      },
    };
    const stateBytes = serializeMigrationJson(nextState);
    const plans = [
      {
        path: paths.fixtures,
        before: await readMigrationBytes(
          paths.fixtures,
          paths.root,
          MIGRATION_SHADOW_POLICY.maximumFixtureBytes,
          "Shadow fixtures",
        ),
        after: fixtureBytes,
        displayPath: paths.fixtures,
      },
      {
        path: paths.shadowReport,
        before: await readMigrationBytes(
          paths.shadowReport,
          paths.root,
          undefined,
          "Shadow report",
        ),
        after: reportBytes,
        displayPath: paths.shadowReport,
      },
      {
        path: paths.state,
        before: loadedState.bytes,
        after: stateBytes,
        displayPath: paths.state,
      },
    ];
    if (!options.dryRun) {
      await applyFilePlans(bindMigrationStoragePlans(paths, plans));
    }
    return {
      ok: report.summary.pass,
      command: "migrate",
      phase: "shadow",
      workspace: workspace.realPath,
      graph: { root: graph.resolvedGraphPath, revision: virtualRevision },
      migrationId: options.migrationId,
      status: nextStatus,
      dryRun: options.dryRun,
      summary: report.summary,
      changes: plans.map((plan) => describePlan(plan, workspace.realPath)),
    };
  };
  return options.dryRun || lockCapability !== undefined
    ? operation()
    : withMigrationGraphLock(graph.resolvedGraphPath, operation);
}
