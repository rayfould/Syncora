import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import {
  applyFilePlans,
  describePlan,
} from "./atomic-file.mjs";
import { validateAdoptionHubHierarchy } from "./adoption-hierarchy.mjs";
import {
  AUTHORITY_MANIFEST_POLICY,
  loadAndValidateAuthorityManifest,
} from "./authority-manifest.mjs";
import { applyAuthorityValidation } from "./authority-validator.mjs";
import { SyncoraError } from "./cli.mjs";
import { buildLinkGraph } from "./link-resolver.mjs";
import {
  assertMigrationLockCapability,
  readMigrationLockCapability,
  withMigrationGraphLock,
} from "./migration-lock.mjs";
import {
  artifactReference,
  assertMigrationRoot,
  bindMigrationStoragePlans,
  migrationPaths,
  readMigrationBytes,
  readMigrationState,
  readMigrationTargetBytes,
  serializeMigrationJson,
  taggedSha256,
  validateMigrationState,
  workspaceIdentity,
} from "./migration-state.mjs";
import { parseNote } from "./note-parser.mjs";
import { VALIDATION_POLICY } from "./validate.mjs";
import {
  isWithin,
  resolveGraphContext,
  resolveWorkspace,
  samePath,
} from "./workspace.mjs";
import { assertNoNonterminalFileTransaction } from "./writer-interlock.mjs";

export const MIGRATION_STAGE_POLICY = Object.freeze({
  specification: "syncora-staged-content-v1",
  schemaVersion: 1,
  maximumTargets: 10_000,
  maximumTotalTargetBytes: 67_108_864,
});

function stageError(code, message, details = undefined) {
  return new SyncoraError(code, message, details);
}

function assertExpectedBundleBindings(options, validated, entries) {
  if (
    options.expectedManifestSha256 !== undefined &&
    options.expectedManifestSha256 !== validated.manifestSha256
  ) {
    throw stageError(
      "MIGRATE016",
      "Reviewed manifest bytes do not match the adoption bundle binding.",
    );
  }
  if (options.expectedTargets === undefined) return;
  if (!Array.isArray(options.expectedTargets)) {
    throw stageError("MIGRATE016", "Expected adoption target bindings must be an array.");
  }
  const expectedByPath = new Map();
  for (const target of options.expectedTargets) {
    if (
      target === null ||
      typeof target !== "object" ||
      Array.isArray(target) ||
      typeof target.path !== "string" ||
      typeof target.contentSha256 !== "string" ||
      !Number.isSafeInteger(target.byteLength) ||
      expectedByPath.has(target.path)
    ) {
      throw stageError("MIGRATE016", "Expected adoption target bindings are invalid.");
    }
    expectedByPath.set(target.path, target);
  }
  if (expectedByPath.size !== entries.length) {
    throw stageError(
      "MIGRATE016",
      "Staged targets do not match the adoption bundle inventory.",
    );
  }
  for (const entry of entries) {
    const expected = expectedByPath.get(entry.path);
    if (
      !expected ||
      expected.contentSha256 !== entry.contentSha256 ||
      expected.byteLength !== entry.byteLength
    ) {
      throw stageError(
        "MIGRATE016",
        `Staged target does not match the adoption bundle binding: ${entry.path}`,
      );
    }
  }
}

function portableRelative(root, path) {
  const value = relative(root, path).split(sep).join("/");
  if (value === "" || value === ".." || value.startsWith("../") || isAbsolute(value)) {
    throw stageError("MIGRATE010", `Staged path escapes its root: ${path}`);
  }
  return value;
}

async function stableFile(path, root, maximumBytes, label) {
  const bytes = await readMigrationTargetBytes(
    path,
    root,
    maximumBytes,
    label,
  );
  if (bytes === null) {
    throw stageError("MIGRATE010", `${label} is missing: ${path}`);
  }
  const resolved = await realpath(path);
  if (!isWithin(root, resolved)) {
    throw stageError("MIGRATE010", `${label} escapes the staged-content root: ${path}`);
  }
  const after = await lstat(path, { bigint: true });
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    after.size > BigInt(maximumBytes) ||
    bytes.length !== Number(after.size)
  ) {
    throw stageError("READ001", `${label} changed while it was being read: ${path}`);
  }
  return {
    bytes,
    metadata: after,
    resolved,
    size: Number(after.size),
  };
}

async function resolveStagedContentRoot(value) {
  if (!isAbsolute(value ?? "")) {
    throw stageError("MIGRATE010", "--staged-content requires an absolute directory path.");
  }
  const metadata = await lstat(value);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw stageError("MIGRATE010", `Staged-content root is not a safe directory: ${value}`);
  }
  const resolved = await realpath(value);
  if (resolved !== value && process.platform !== "win32") {
    throw stageError("MIGRATE010", `Staged-content root must not use an alias: ${value}`);
  }
  return resolved;
}

function canonicalSourceRefs(target) {
  return target.sourceRefs.map(
    (reference) => `${reference.path}@${reference.expectedSha256}`,
  );
}

function expectedFrontmatter(target) {
  return {
    id: target.id,
    kind: target.kind,
    scope: target.scope,
    state: target.state,
    authority: target.authority,
    schema_version: target.schemaVersion,
    created: target.created,
    updated: target.updated,
    summary: target.summary,
    ...(target.decisionKey === null ? {} : { decision_key: target.decisionKey }),
    supersedes: [...target.supersedes],
    superseded_by: [...target.supersededBy],
    applies_to: [...target.appliesTo],
    source_refs: canonicalSourceRefs(target),
  };
}

function compareFrontmatter(note, target) {
  const expected = expectedFrontmatter(target);
  const actualKeys = Object.keys(note.frontmatter).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    !actualKeys.every((key, index) => key === expectedKeys[index])
  ) {
    throw stageError(
      "MIGRATE010",
      `Staged target frontmatter has missing or unreviewed fields: ${target.path}`,
      { expectedKeys, actualKeys },
    );
  }
  for (const key of expectedKeys) {
    if (JSON.stringify(note.frontmatter[key]) !== JSON.stringify(expected[key])) {
      throw stageError(
        "MIGRATE010",
        `Staged target frontmatter does not match the reviewed manifest: ${target.path}`,
        { field: key },
      );
    }
  }
}

function cloneNote(note) {
  return {
    ...note,
    frontmatter: {
      ...note.frontmatter,
      supersedes: [...(note.frontmatter.supersedes ?? [])],
      superseded_by: [...(note.frontmatter.superseded_by ?? [])],
      applies_to: [...(note.frontmatter.applies_to ?? [])],
      source_refs: [...(note.frontmatter.source_refs ?? [])],
    },
    links: [...note.links],
    linkReferences: [...(note.linkReferences ?? [])],
    diagnostics: [],
  };
}

export function validateStagedAuthorityGraph(originalNotes, stagedNotes, targetPaths) {
  const combined = [
    ...originalNotes
      .filter((note) => !targetPaths.has(note.path))
      .map(cloneNote),
    ...stagedNotes.map(cloneNote),
  ];
  applyAuthorityValidation(combined, VALIDATION_POLICY);
  const linkGraph = buildLinkGraph(combined, VALIDATION_POLICY);
  const errors = combined.flatMap((note) =>
    note.diagnostics
      .filter((item) => item.severity === "error")
      .map((item) => ({ code: item.code, path: note.path })),
  );
  if (errors.length > 0) {
    throw stageError(
      "MIGRATE010",
      "Staged authority graph does not pass semantic and link validation.",
      { errors: errors.slice(0, 50), omitted: Math.max(0, errors.length - 50) },
    );
  }
  validateAdoptionHubHierarchy(combined, linkGraph);
  return combined;
}

export async function parseStagedTarget({ stagedRoot, target, file }) {
  const parsed = await parseNote(
    {
      path: target.path,
      absolutePath: file.resolved,
      realPath: file.resolved,
      size: file.size,
      mtimeMs: Number(file.metadata.mtimeNs) / 1_000_000,
    },
    stagedRoot,
    VALIDATION_POLICY,
    {
      includeLexicalSource: true,
      preloadedBuffer: file.bytes,
    },
  );
  if (!parsed.currentSchema || parsed.diagnostics.some((item) => item.severity === "error")) {
    throw stageError("MIGRATE010", `Staged target is not a valid schema-v1 note: ${target.path}`, {
      codes: [...new Set(parsed.diagnostics.map((item) => item.code))].sort(),
    });
  }
  if (`sha256:${parsed.rawSha256}` !== target.contentSha256) {
    throw stageError(
      "MIGRATE010",
      `Staged target changed between its bounded read and semantic parse: ${target.path}`,
    );
  }
  compareFrontmatter(parsed, target);
  return parsed;
}

async function collectStagedTargets(validated, stagedRoot, paths) {
  const entries = [];
  const notes = [];
  const contentPlans = new Map();
  let totalBytes = 0;
  for (const target of validated.targets) {
    const sourcePath = join(stagedRoot, ...target.path.split("/"));
    const file = await stableFile(
      sourcePath,
      stagedRoot,
      VALIDATION_POLICY.maxNoteBytes,
      "Staged target",
    );
    const hash = taggedSha256(file.bytes);
    if (hash !== target.contentSha256) {
      throw stageError("MIGRATE010", `Staged target hash does not match the manifest: ${target.path}`);
    }
    totalBytes += file.bytes.length;
    if (totalBytes > MIGRATION_STAGE_POLICY.maximumTotalTargetBytes) {
      throw stageError("MIGRATE010", "Staged target bundle exceeds its total byte limit.");
    }
    const parsed = await parseStagedTarget({ stagedRoot, target, file });
    notes.push(parsed);
    const contentPath = join(paths.content, `${hash.slice("sha256:".length)}.md`);
    const before = await readMigrationTargetBytes(
      contentPath,
      paths.root,
      VALIDATION_POLICY.maxNoteBytes,
      "Content-addressed staged target",
    );
    if (before !== null && !before.equals(file.bytes)) {
      throw stageError("MIGRATE010", `Content-addressed staged target is corrupt: ${contentPath}`);
    }
    contentPlans.set(contentPath, {
      path: contentPath,
      before,
      after: file.bytes,
      displayPath: portableRelative(paths.graphRoot, contentPath),
    });
    entries.push({
      operationId: target.operationId,
      path: target.path,
      contentSha256: hash,
      byteLength: file.bytes.length,
      content: portableRelative(paths.root, contentPath),
    });
  }
  return { entries, notes, contentPlans: [...contentPlans.values()], totalBytes };
}

function stagedContentArtifact({ migrationId, validated, collected }) {
  return {
    schemaVersion: MIGRATION_STAGE_POLICY.schemaVersion,
    kind: MIGRATION_STAGE_POLICY.specification,
    migrationId,
    manifestSha256: validated.manifestSha256,
    graphRevision: validated.snapshot.bindings.graphRevision,
    targetCount: collected.entries.length,
    totalBytes: collected.totalBytes,
    entries: collected.entries,
  };
}

export async function stageMigration(options, execution = {}) {
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
      throw stageError(
        "MIGRATE007",
        "Graph root changed after the migration lock was selected.",
      );
    }
    await assertNoNonterminalFileTransaction(lockedGraph.resolvedGraphPath);
    const validated = await loadAndValidateAuthorityManifest({
      workspace: workspace.realPath,
      allowExternalGraphRoot: options.allowExternalGraphRoot,
      manifestPath: options.manifest,
    });
    if (!validated.actionable || validated.manifest.manifestSchemaVersion !== AUTHORITY_MANIFEST_POLICY.actionableSchemaVersion) {
      throw stageError("MIGRATE010", "Only an actionable reviewed manifest v2 can be staged.");
    }
    if (validated.snapshot.queue.some((entry) => entry.classification === "blocked")) {
      throw stageError(
        "MIGRATE010",
        "Blocked graph sources must be remediated before adoption can be staged.",
      );
    }
    const stagedRoot = await resolveStagedContentRoot(options.stagedContent);
    const collected = await collectStagedTargets(validated, stagedRoot, paths);
    assertExpectedBundleBindings(options, validated, collected.entries);
    const targetPaths = new Set(validated.targets.map((target) => target.path));
    validateStagedAuthorityGraph(validated.inspection.notes, collected.notes, targetPaths);

    const stagedContent = stagedContentArtifact({
      migrationId: options.migrationId,
      validated,
      collected,
    });
    const manifestBytes = validated.manifestBytes;
    const stagedBytes = serializeMigrationJson(stagedContent);
    const existingState = await readMigrationState(paths, {
      migrationId: options.migrationId,
      workspaceIdentity: workspaceIdentity(workspace.realPath),
      rootIdentity: validated.snapshot.bindings.rootIdentity,
    });
    const now = new Date().toISOString();
    const state = {
      schemaVersion: 1,
      kind: "syncora.adoption",
      migrationId: options.migrationId,
      status: "staged",
      workspaceIdentity: workspaceIdentity(workspace.realPath),
      rootIdentity: validated.snapshot.bindings.rootIdentity,
      createdAt: existingState?.value.createdAt ?? now,
      updatedAt: now,
      baseline: {
        graphRevision: validated.snapshot.bindings.graphRevision,
        policyRevision: validated.snapshot.bindings.policyRevision,
        manifestSha256: validated.manifestSha256,
        recoveryPlanSha256: null,
        sourceCount: validated.snapshot.queue.length,
        targetCount: validated.targets.length,
      },
      artifacts: {
        manifest: artifactReference(paths, paths.manifest, manifestBytes),
        stagedContent: artifactReference(paths, paths.stagedContent, stagedBytes),
        fixtures: null,
        shadowReport: null,
        recovery: null,
        cutoverReceipt: null,
        verification: null,
        retirement: null,
      },
    };
    validateMigrationState(state, {
      migrationId: options.migrationId,
      workspaceIdentity: state.workspaceIdentity,
      rootIdentity: state.rootIdentity,
    });
    if (existingState) {
      if (
        existingState.value.status !== "staged" ||
        existingState.value.baseline.manifestSha256 !== state.baseline.manifestSha256
      ) {
        throw stageError("MIGRATE006", "Existing migration state cannot be replaced by this stage operation.");
      }
      state.createdAt = existingState.value.createdAt;
      state.updatedAt = existingState.value.updatedAt;
    }
    const stateBytes = serializeMigrationJson(state);
    const plans = [
      ...collected.contentPlans,
      {
        path: paths.manifest,
        before: await readMigrationBytes(
          paths.manifest,
          paths.root,
          undefined,
          "Reviewed migration manifest",
        ),
        after: manifestBytes,
        displayPath: portableRelative(paths.graphRoot, paths.manifest),
      },
      {
        path: paths.stagedContent,
        before: await readMigrationBytes(
          paths.stagedContent,
          paths.root,
          undefined,
          "Staged-content index",
        ),
        after: stagedBytes,
        displayPath: portableRelative(paths.graphRoot, paths.stagedContent),
      },
      {
        path: paths.state,
        before: existingState?.bytes ?? null,
        after: stateBytes,
        displayPath: portableRelative(paths.graphRoot, paths.state),
      },
    ];
    if (!options.dryRun) {
      await applyFilePlans(bindMigrationStoragePlans(paths, plans));
    } else {
      await assertNoNonterminalFileTransaction(lockedGraph.resolvedGraphPath);
    }
    return {
      ok: true,
      command: "migrate",
      phase: "stage",
      workspace: workspace.realPath,
      graph: { root: graph.resolvedGraphPath, revision: state.baseline.graphRevision },
      migrationId: options.migrationId,
      status: state.status,
      dryRun: options.dryRun,
      summary: {
        sources: state.baseline.sourceCount,
        targets: state.baseline.targetCount,
        stagedBytes: collected.totalBytes,
      },
      changes: plans.map((plan) => describePlan(plan, workspace.realPath)),
    };
  };
  if (lockCapability !== undefined) return operation();
  if (options.dryRun) {
    try {
      await lstat(paths.syncoraRoot);
    } catch (error) {
      if (error?.code === "ENOENT") {
        // The first legacy-adoption preview must not create runtime or lock
        // state. An active generic transaction necessarily has this root.
        return operation();
      }
      throw error;
    }
  }
  return withMigrationGraphLock(graph.resolvedGraphPath, operation);
}
