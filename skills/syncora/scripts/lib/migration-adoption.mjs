import { lstat, readFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyFilePlans,
  describePlan,
} from "./atomic-file.mjs";
import {
  inspectAgentHooks,
  planAgentMigrationCutover,
  verifyAgentPatchPlans,
} from "./agent-patcher.mjs";
import { loadAndValidateAuthorityManifest } from "./authority-manifest.mjs";
import { authorityRootIdentity } from "./authority-inventory.mjs";
import { SyncoraError } from "./cli.mjs";
import { withMigrationLocks } from "./migration-lock.mjs";
import { loadStagedNotes } from "./migration-shadow.mjs";
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
import {
  applyRecovery,
  prepareRecovery,
  previewRecovery,
  readRecovery,
  recoveryPlanSha256,
  rollbackRecovery,
  verifyRecoveryBlobs,
} from "./migration-transaction.mjs";
import { inspectWorkspace, VALIDATION_POLICY } from "./validate.mjs";
import {
  readSyncoraConfigIfPresent,
  readSyncoraLocalConfigIfPresent,
  resolveGraphContext,
  resolveWorkspace,
  samePath,
} from "./workspace.mjs";

const MODULE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIRECTORY = join(MODULE_DIRECTORY, "..", "..", "assets", "templates");

export const MIGRATION_ADOPTION_POLICY = Object.freeze({
  receiptSchemaVersion: 1,
  receiptSpecification: "syncora-cutover-receipt-v1",
  verificationSpecification: "syncora-verification-v1",
  retirementSpecification: "syncora-retirement-v1",
});

function adoptionError(code, message, details = undefined) {
  return new SyncoraError(code, message, details);
}

function portableRelative(root, path) {
  return relative(root, path).split(sep).join("/");
}

function portableIdentity(path) {
  return path.normalize("NFC").toLowerCase();
}

function legacyArchivePath(migrationId, sourcePath) {
  return `archive/migrations/${migrationId}/${sourcePath}`;
}

async function modeIfPresent(path) {
  try {
    return Number((await lstat(path, { bigint: true })).mode);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function template(name) {
  return readFile(join(TEMPLATE_DIRECTORY, name));
}

function patchedRuntimeConfig(existing, fallback) {
  const source = existing ?? fallback;
  const parsed = parseStrictJson(source, "Syncora runtime configuration");
  const next = {
    ...parsed,
    agentPatching: {
      ...(parsed.agentPatching && typeof parsed.agentPatching === "object"
        ? parsed.agentPatching
        : {}),
      enabled: true,
    },
  };
  return Buffer.from(`${JSON.stringify(next, null, 2)}\n`, "utf8");
}

async function loadEnvironment(options) {
  const workspace = await resolveWorkspace(options.workspace);
  const graph = await resolveGraphContext(workspace, {
    allowExternalGraphRoot: options.allowExternalGraphRoot,
  });
  const paths = migrationPaths(graph.resolvedGraphPath, options.migrationId);
  await assertMigrationRoot(paths);
  const rootIdentity = authorityRootIdentity(graph.resolvedGraphPath);
  const loadedState = await readMigrationState(paths, {
    migrationId: options.migrationId,
    workspaceIdentity: workspaceIdentity(workspace.realPath),
    rootIdentity,
  });
  if (!loadedState) {
    throw adoptionError("MIGRATE006", "Migration state does not exist. Run the stage phase first.");
  }
  return { workspace, graph, paths, rootIdentity, loadedState };
}

async function resolveMigrationLockRoots(options) {
  const workspace = await resolveWorkspace(options.workspace);
  const graph = await resolveGraphContext(workspace, {
    allowExternalGraphRoot: options.allowExternalGraphRoot,
  });
  return {
    workspacePath: workspace.realPath,
    graphRoot: graph.resolvedGraphPath,
  };
}

function assertEnvironmentMatchesLocks(environment, lockRoots) {
  if (!lockRoots) return;
  if (
    !samePath(environment.workspace.realPath, lockRoots.workspacePath) ||
    !samePath(environment.graph.resolvedGraphPath, lockRoots.graphRoot)
  ) {
    throw adoptionError(
      "MIGRATE007",
      "Workspace or graph root changed after migration locks were selected.",
    );
  }
}

function recoveryBindings(environment) {
  return {
    workspaceIdentity: environment.loadedState.value.workspaceIdentity,
    rootIdentity: environment.loadedState.value.rootIdentity,
    manifestSha256: environment.loadedState.value.baseline.manifestSha256,
  };
}

async function readEnvironmentRecovery(
  environment,
  { required = false, allowStateBindingTransition = false } = {},
) {
  const loaded = await readRecovery(
    environment.paths,
    environment.loadedState.value.migrationId,
    recoveryBindings(environment),
  );
  if (!loaded) {
    if (required) {
      throw adoptionError("MIGRATE008", "Migration recovery journal is missing.");
    }
    return null;
  }
  const reference = environment.loadedState.value.artifacts.recovery;
  const boundPlan = environment.loadedState.value.baseline.recoveryPlanSha256;
  if (boundPlan === null || loaded.value.planSha256 !== boundPlan) {
    throw adoptionError(
      "MIGRATE008",
      "Migration recovery plan does not match its prepared state binding.",
    );
  }
  if (
    reference !== null &&
    taggedSha256(loaded.bytes) !== reference.sha256 &&
    !(allowStateBindingTransition && loaded.value.status === "rolled-back")
  ) {
    throw adoptionError(
      "MIGRATE008",
      "Migration recovery journal does not match its state artifact binding.",
    );
  }
  return loaded;
}

async function bindPreparedCutoverState(environment, recovery) {
  const planSha256 = recoveryPlanSha256(recovery);
  const currentPlan = environment.loadedState.value.baseline.recoveryPlanSha256;
  if (currentPlan !== null && currentPlan !== planSha256) {
    throw adoptionError(
      "MIGRATE008",
      "Prepared cutover state is bound to a different recovery plan.",
    );
  }
  if (environment.loadedState.value.status === "cutover-prepared") {
    return environment.loadedState;
  }
  if (environment.loadedState.value.status !== "shadow-verified") {
    throw adoptionError(
      "MIGRATE006",
      `Recovery preparation is unavailable from ${environment.loadedState.value.status}.`,
    );
  }
  assertMigrationTransition(
    environment.loadedState.value.status,
    "cutover-prepared",
  );
  const nextState = {
    ...environment.loadedState.value,
    status: "cutover-prepared",
    updatedAt: new Date().toISOString(),
    baseline: {
      ...environment.loadedState.value.baseline,
      recoveryPlanSha256: planSha256,
    },
  };
  const stateBytes = serializeMigrationJson(nextState);
  await applyFilePlans(bindMigrationStoragePlans(environment.paths, [{
    path: environment.paths.state,
    before: environment.loadedState.bytes,
    after: stateBytes,
    displayPath: environment.paths.state,
  }]));
  environment.loadedState = { bytes: stateBytes, value: nextState };
  return environment.loadedState;
}

async function assertReceiptRecoveryBinding(environment, loadedRecovery) {
  const receipt = await loadCutoverReceipt(environment);
  if (
    receipt.value.recoveryPlanSha256 !==
    recoveryPlanSha256(loadedRecovery.value)
  ) {
    throw adoptionError(
      "MIGRATE008",
      "Migration recovery plan does not match the cutover receipt.",
    );
  }
  if (
    loadedRecovery.value.status !== "rolled-back" &&
    receipt.value.recoverySha256 !== taggedSha256(loadedRecovery.bytes)
  ) {
    throw adoptionError(
      "MIGRATE008",
      "Migration recovery journal does not match the cutover receipt.",
    );
  }
  return receipt;
}

async function loadReviewedArtifacts(environment, options) {
  const manifestArtifact = await verifyArtifactReference(
    environment.paths,
    environment.loadedState.value.artifacts.manifest,
    "Reviewed manifest",
  );
  const validated = await loadAndValidateAuthorityManifest({
    workspace: environment.workspace.realPath,
    allowExternalGraphRoot: options.allowExternalGraphRoot,
    manifestPath: manifestArtifact.path,
  });
  if (
    !validated.actionable ||
    validated.manifestSha256 !== environment.loadedState.value.baseline.manifestSha256 ||
    validated.snapshot.bindings.graphRevision !== environment.loadedState.value.baseline.graphRevision
  ) {
    throw adoptionError("MIGRATE005", "Reviewed manifest or graph baseline is stale.");
  }
  const staged = await loadStagedNotes(
    environment.paths,
    environment.loadedState.value,
    validated,
  );
  return { validated, staged };
}

async function assertShadowGate(environment) {
  const reportArtifact = await verifyArtifactReference(
    environment.paths,
    environment.loadedState.value.artifacts.shadowReport,
    "Shadow report",
  );
  const fixturesArtifact = await verifyArtifactReference(
    environment.paths,
    environment.loadedState.value.artifacts.fixtures,
    "Shadow fixtures",
  );
  const report = parseStrictJson(reportArtifact.bytes, "Shadow report");
  if (
    report.kind !== "syncora-shadow-report-v1" ||
    report.migrationId !== environment.loadedState.value.migrationId ||
    report.manifestSha256 !== environment.loadedState.value.baseline.manifestSha256 ||
    report.fixtureSha256 !== taggedSha256(fixturesArtifact.bytes) ||
    !/^sha256:[0-9a-f]{64}$/.test(report.virtualGraphRevision ?? "") ||
    report.summary?.pass !== true ||
    report.summary?.failed !== 0
  ) {
    throw adoptionError("MIGRATE012", "Recorded shadow comparison does not satisfy the cutover gate.");
  }
  return { report, reportArtifact, fixturesArtifact };
}

async function loadStoredManifest(environment) {
  const artifact = await verifyArtifactReference(
    environment.paths,
    environment.loadedState.value.artifacts.manifest,
    "Reviewed manifest",
  );
  const manifest = parseStrictJson(artifact.bytes, "Reviewed manifest");
  if (
    manifest.manifestSchemaVersion !== 2 ||
    manifest.kind !== "syncora.authority-promotion" ||
    manifest.status !== "reviewed" ||
    !Array.isArray(manifest.dispositions) ||
    !Array.isArray(manifest.operations) ||
    taggedSha256(artifact.bytes) !== environment.loadedState.value.baseline.manifestSha256
  ) {
    throw adoptionError("MIGRATE005", "Stored reviewed manifest does not match migration state.");
  }
  const targets = manifest.operations.map((operation) => ({
    operationId: operation.operationId,
    ...operation.target,
  }));
  if (targets.length !== environment.loadedState.value.baseline.targetCount) {
    throw adoptionError("MIGRATE005", "Stored reviewed manifest target count diverged.");
  }
  return { artifact, manifest, targets };
}

async function runtimeRecords(environment) {
  const { workspace, graph } = environment;
  const configPath = join(workspace.realPath, ".syncora", "config.json");
  const configInfo = await readSyncoraConfigIfPresent(workspace.realPath);
  const configBefore = configInfo?.buffer ?? null;
  const configAfter = patchedRuntimeConfig(
    configBefore,
    await template("config.json"),
  );
  const gitignorePath = join(workspace.realPath, ".syncora", ".gitignore");
  const gitignoreBefore = await readMigrationBytes(
    gitignorePath,
    workspace.realPath,
    VALIDATION_POLICY.maxNoteBytes,
    "Workspace Syncora ignore file",
  );
  const gitignoreAfter = gitignoreBefore ?? await template("syncora.gitignore");
  const records = [
    {
      root: "workspace",
      path: ".syncora/config.json",
      category: "runtime",
      before: configBefore,
      after: configAfter,
      mode: await modeIfPresent(configPath),
    },
    {
      root: "workspace",
      path: ".syncora/.gitignore",
      category: "runtime",
      before: gitignoreBefore,
      after: gitignoreAfter,
      mode: await modeIfPresent(gitignorePath),
    },
  ];
  if (graph.external) {
    const localPath = join(workspace.realPath, ".syncora", "local.json");
    const localInfo = await readSyncoraLocalConfigIfPresent(workspace.realPath);
    const localBefore = localInfo?.buffer ?? null;
    const localAfter = localBefore ?? Buffer.from(
      `${JSON.stringify({
        schemaVersion: 1,
        externalGraphRoots: [graph.resolvedGraphPath],
      }, null, 2)}\n`,
      "utf8",
    );
    records.push({
      root: "workspace",
      path: ".syncora/local.json",
      category: "runtime",
      before: localBefore,
      after: localAfter,
      mode: await modeIfPresent(localPath),
    });
  }
  const graphIgnorePath = join(graph.resolvedGraphPath, ".syncora", ".gitignore");
  const graphIgnoreBefore = await readMigrationBytes(
    graphIgnorePath,
    graph.resolvedGraphPath,
    VALIDATION_POLICY.maxNoteBytes,
    "Graph Syncora ignore file",
  );
  records.push({
    root: "graph",
    path: ".syncora/.gitignore",
    category: "runtime",
    before: graphIgnoreBefore,
    after: graphIgnoreBefore ?? Buffer.from("*\n!.gitignore\n", "utf8"),
    mode: await modeIfPresent(graphIgnorePath),
  });
  return records;
}

async function graphTargetRecords(environment, reviewed) {
  const entries = new Map(reviewed.staged.index.entries.map((entry) => [entry.path, entry]));
  const records = [];
  for (const target of reviewed.validated.targets) {
    const entry = entries.get(target.path);
    const internalPath = join(environment.paths.root, ...entry.content.split("/"));
    const after = await readMigrationTargetBytes(
      internalPath,
      environment.paths.root,
      VALIDATION_POLICY.maxNoteBytes,
      "Staged cutover target",
    );
    if (after === null || taggedSha256(after) !== target.contentSha256) {
      throw adoptionError(
        "MIGRATE010",
        `Staged cutover target is missing or no longer matches reviewed bytes: ${target.path}`,
      );
    }
    const targetPath = join(environment.graph.resolvedGraphPath, ...target.path.split("/"));
    const before = await readMigrationTargetBytes(
      targetPath,
      environment.graph.resolvedGraphPath,
      VALIDATION_POLICY.maxNoteBytes,
      "Current graph target",
    );
    const beforeHash = before === null ? null : taggedSha256(before);
    if (beforeHash !== target.expectedPriorSha256) {
      throw adoptionError("MIGRATE005", `Target changed after staging: ${target.path}`);
    }
    if (before !== null && !before.equals(after)) {
      const archivePath = legacyArchivePath(
        environment.loadedState.value.migrationId,
        target.path,
      );
      if (portableIdentity(target.path).startsWith("archive/migrations/")) {
        throw adoptionError(
          "MIGRATE010",
          `Migration target overlaps its durable legacy archive namespace: ${target.path}`,
        );
      }
      const archiveAbsolute = join(
        environment.graph.resolvedGraphPath,
        ...archivePath.split("/"),
      );
      const archiveBefore = await readMigrationTargetBytes(
        archiveAbsolute,
        environment.graph.resolvedGraphPath,
        VALIDATION_POLICY.maxNoteBytes,
        "Durable legacy archive target",
      );
      if (archiveBefore !== null) {
        throw adoptionError(
          "MIGRATE009",
          `Durable legacy archive target already exists: ${archivePath}`,
        );
      }
      records.push({
        root: "graph",
        path: archivePath,
        category: "archive",
        before: null,
        after: before,
        mode: await modeIfPresent(targetPath),
      });
    }
    records.push({
      root: "graph",
      path: target.path,
      category: "graph",
      before,
      after,
      mode: await modeIfPresent(targetPath),
    });
  }
  return records;
}

async function agentRecords(environment, options) {
  const planned = await planAgentMigrationCutover(environment.workspace.realPath);
  await verifyAgentPatchPlans(environment.workspace.realPath, planned.plans);
  const exactPredecessor = planned.warnings.some(
    (item) => item.code === "LEGACY_AGENT_WORKFLOW_CUTOVER",
  );
  if (!exactPredecessor && options.confirmPredecessorReviewed !== true) {
    throw adoptionError(
      "MIGRATE013",
      "No exact predecessor workflow block was found. Inspect every active agent-instruction file, remove any custom predecessor activation, then rerun cutover with --confirm-predecessor-reviewed.",
    );
  }
  if (!exactPredecessor) {
    planned.warnings.push({
      code: "PREDECESSOR_REVIEW_ATTESTED",
      message: "No exact predecessor block was present; cutover relies on the explicit review attestation.",
    });
  }
  const records = [];
  for (const plan of planned.plans) {
    const path = portableRelative(environment.workspace.realPath, plan.path);
    const predecessor = Buffer.from("<!-- BEGIN KNOWLEDGE GRAPH WORKFLOW -->", "utf8");
    records.push({
      root: "workspace",
      path,
      category: path.startsWith(".syncora/")
        ? "runtime"
        : plan.before?.includes(predecessor)
          ? "agent-cutover"
          : "agent",
      before: plan.before,
      after: plan.after,
      mode: await modeIfPresent(plan.path),
    });
  }
  return {
    records,
    warnings: planned.warnings,
    predecessorReview: exactPredecessor
      ? "exact-marker-replaced"
      : "operator-confirmed-absent",
  };
}

function predecessorReviewFromRecovery(recovery) {
  return recovery.records.some((record) => record.category === "agent-cutover")
    ? "exact-marker-replaced"
    : "operator-confirmed-absent";
}

async function finalizeCutover(environment, recoveryResult, shadow) {
  const inspection = await inspectWorkspace({
    workspace: environment.workspace.realPath,
    allowExternalGraphRoot: environment.graph.external
      ? environment.graph.resolvedGraphPath
      : undefined,
  });
  if (!inspection.report.ok) {
    throw adoptionError("MIGRATE013", "Cutover graph does not validate after publication.", {
      errors: inspection.report.summary.diagnostics.error,
    });
  }
  if (inspection.report.graph.revision !== shadow.report.virtualGraphRevision) {
    throw adoptionError(
      "MIGRATE013",
      "Cutover graph revision differs from the exact graph that passed shadow validation.",
      {
        expected: shadow.report.virtualGraphRevision,
        actual: inspection.report.graph.revision,
      },
    );
  }
  const hooks = await inspectAgentHooks(environment.workspace.realPath);
  if (
    hooks.some((hook) => hook.legacyKnowledgeGraphWorkflow) ||
    !hooks.some((hook) => hook.marker === "present" && hook.version === 2)
  ) {
    throw adoptionError("MIGRATE013", "Agent-instruction cutover did not replace predecessor activation.");
  }
  const now = new Date().toISOString();
  const receipt = {
    schemaVersion: MIGRATION_ADOPTION_POLICY.receiptSchemaVersion,
    kind: MIGRATION_ADOPTION_POLICY.receiptSpecification,
    migrationId: environment.loadedState.value.migrationId,
    manifestSha256: environment.loadedState.value.baseline.manifestSha256,
    shadowReportSha256: shadow.reportArtifact
      ? taggedSha256(shadow.reportArtifact.bytes)
      : environment.loadedState.value.artifacts.shadowReport.sha256,
    recoverySha256: taggedSha256(recoveryResult.bytes),
    recoveryPlanSha256: recoveryPlanSha256(recoveryResult.recovery),
    beforeGraphRevision: environment.loadedState.value.baseline.graphRevision,
    afterGraphRevision: inspection.report.graph.revision,
    appliedAt: now,
    targetCount: environment.loadedState.value.baseline.targetCount,
    predecessorReview: predecessorReviewFromRecovery(recoveryResult.recovery),
    agentHooks: hooks,
  };
  const receiptBytes = serializeMigrationJson(receipt);
  const nextState = {
    ...environment.loadedState.value,
    status: "cutover-applied",
    updatedAt: now,
    artifacts: {
      ...environment.loadedState.value.artifacts,
      recovery: artifactReference(environment.paths, environment.paths.recovery, recoveryResult.bytes),
      cutoverReceipt: artifactReference(environment.paths, environment.paths.cutoverReceipt, receiptBytes),
    },
  };
  assertMigrationTransition(environment.loadedState.value.status, nextState.status);
  const stateBytes = serializeMigrationJson(nextState);
  await applyFilePlans(bindMigrationStoragePlans(environment.paths, [
    {
      path: environment.paths.cutoverReceipt,
      before: await readMigrationBytes(
        environment.paths.cutoverReceipt,
        environment.paths.root,
        undefined,
        "Cutover receipt",
      ),
      after: receiptBytes,
      displayPath: environment.paths.cutoverReceipt,
    },
    {
      path: environment.paths.state,
      before: environment.loadedState.bytes,
      after: stateBytes,
      displayPath: environment.paths.state,
    },
  ]));
  return { receipt, receiptBytes, nextState, stateBytes, inspection, hooks };
}

export async function cutoverMigration(options) {
  let lockRoots = null;
  const operation = async () => {
    const environment = await loadEnvironment(options);
    assertEnvironmentMatchesLocks(environment, lockRoots);
    if (environment.loadedState.value.status === "cutover-applied") {
      const verified = await verifyActiveMigration(environment, options);
      const recovery = await readEnvironmentRecovery(environment, { required: true });
      if (!recovery || recovery.value.status !== "applied") {
        throw adoptionError("MIGRATE008", "Applied cutover recovery evidence is missing.");
      }
      await assertReceiptRecoveryBinding(environment, recovery);
      return {
        ok: true,
        command: "migrate",
        phase: "cutover",
        workspace: environment.workspace.realPath,
        graph: {
          root: environment.graph.resolvedGraphPath,
          revision: verified.inspection.report.graph.revision,
        },
        migrationId: environment.loadedState.value.migrationId,
        status: environment.loadedState.value.status,
        dryRun: options.dryRun,
        summary: {
          published: 0,
          already: recovery.value.records.length,
          total: recovery.value.records.length,
          targets: verified.reviewed.targets.length,
          agentHooks: verified.hooks.length,
          idempotent: true,
        },
        changes: [],
        warnings: [],
      };
    }
    if (!new Set(["shadow-verified", "cutover-prepared"]).has(
      environment.loadedState.value.status,
    )) {
      throw adoptionError("MIGRATE006", "Cutover requires a passing recorded shadow comparison.");
    }
    const shadow = await assertShadowGate(environment);
    const roots = {
      workspacePath: environment.workspace.realPath,
      graphRoot: environment.graph.resolvedGraphPath,
    };
    let recoveryLoaded = await readEnvironmentRecovery(environment);
    let warnings = [];
    let preview;
    let reviewed = null;
    if (!recoveryLoaded) {
      reviewed = await loadReviewedArtifacts(environment, options);
      const agents = await agentRecords(environment, options);
      warnings = agents.warnings;
      const records = [
        ...await graphTargetRecords(environment, reviewed),
        ...await runtimeRecords(environment),
        ...agents.records,
      ];
      if (options.dryRun) {
        return {
          ok: true,
          command: "migrate",
          phase: "cutover",
          workspace: environment.workspace.realPath,
          migrationId: environment.loadedState.value.migrationId,
          status: environment.loadedState.value.status,
          dryRun: true,
          summary: { records: records.length, targets: reviewed.validated.targets.length },
          changes: records.map((record) => ({
            action:
              record.before === null ? "create" :
                record.after === null ? "delete" :
                  record.before.equals(record.after) ? "unchanged" : "update",
            path: `${record.root}:${record.path}`,
          })),
          warnings,
        };
      }
      recoveryLoaded = await prepareRecovery(
        {
          paths: environment.paths,
          migrationId: environment.loadedState.value.migrationId,
          ...recoveryBindings(environment),
          records,
        },
        {
          beforePublish: ({ recovery }) =>
            bindPreparedCutoverState(environment, recovery),
        },
      );
    } else if (options.dryRun) {
      preview = await previewRecovery({
        roots,
        recovery: recoveryLoaded.value,
        direction: "forward",
      });
      return {
        ok: true,
        command: "migrate",
        phase: "cutover",
        workspace: environment.workspace.realPath,
        migrationId: environment.loadedState.value.migrationId,
        status: environment.loadedState.value.status,
        dryRun: true,
        summary: preview,
        changes: recoveryLoaded.value.records.map((record) => ({
          action: "update",
          path: `${record.root}:${record.path}`,
        })),
        warnings,
      };
    }
    const recovery = recoveryLoaded.recovery ?? recoveryLoaded.value;
    const applied = await applyRecovery({
      paths: environment.paths,
      roots,
      recovery,
    });
    const finalized = await finalizeCutover(environment, applied, shadow);
    return {
      ok: true,
      command: "migrate",
      phase: "cutover",
      workspace: environment.workspace.realPath,
      graph: {
        root: environment.graph.resolvedGraphPath,
        revision: finalized.receipt.afterGraphRevision,
      },
      migrationId: environment.loadedState.value.migrationId,
      status: finalized.nextState.status,
      dryRun: false,
      summary: {
        ...applied.summary,
        targets: environment.loadedState.value.baseline.targetCount,
        agentHooks: finalized.hooks.length,
        predecessorReview: finalized.receipt.predecessorReview,
      },
      changes: applied.recovery.records.map((record) => ({
        action: record.beforeSha256 === record.afterSha256 ? "unchanged" : "update",
        path: `${record.root}:${record.path}`,
      })),
      warnings,
    };
  };
  if (options.dryRun) return operation();
  lockRoots = await resolveMigrationLockRoots(options);
  return withMigrationLocks(
    lockRoots,
    operation,
  );
}

async function loadCutoverReceipt(environment) {
  const artifact = await verifyArtifactReference(
    environment.paths,
    environment.loadedState.value.artifacts.cutoverReceipt,
    "Cutover receipt",
  );
  const value = parseStrictJson(artifact.bytes, "Cutover receipt");
  if (
    value.kind !== MIGRATION_ADOPTION_POLICY.receiptSpecification ||
    value.migrationId !== environment.loadedState.value.migrationId ||
    value.manifestSha256 !== environment.loadedState.value.baseline.manifestSha256 ||
    !/^sha256:[0-9a-f]{64}$/.test(value.recoveryPlanSha256 ?? "") ||
    !new Set(["exact-marker-replaced", "operator-confirmed-absent"]).has(
      value.predecessorReview,
    )
  ) {
    throw adoptionError("MIGRATE013", "Cutover receipt does not match migration state.");
  }
  return { ...artifact, value };
}

async function loadVerificationReport(environment) {
  const artifact = await verifyArtifactReference(
    environment.paths,
    environment.loadedState.value.artifacts.verification,
    "Migration verification",
  );
  const value = parseStrictJson(artifact.bytes, "Migration verification");
  const receipt = await loadCutoverReceipt(environment);
  if (
    value.schemaVersion !== 1 ||
    value.kind !== MIGRATION_ADOPTION_POLICY.verificationSpecification ||
    value.migrationId !== environment.loadedState.value.migrationId ||
    value.cutoverReceiptSha256 !== taggedSha256(receipt.bytes) ||
    value.graphRevision !== receipt.value.afterGraphRevision ||
    value.targets !== environment.loadedState.value.baseline.targetCount ||
    value.pass !== true ||
    !Array.isArray(value.agentHooks) ||
    typeof value.verifiedAt !== "string" ||
    !Number.isFinite(Date.parse(value.verifiedAt))
  ) {
    throw adoptionError("MIGRATE013", "Migration verification artifact is inconsistent.");
  }
  return { ...artifact, value, receipt };
}

async function verifyActiveMigration(environment, options) {
  const receipt = await loadCutoverReceipt(environment);
  const recovery = await readEnvironmentRecovery(environment, { required: true });
  if (
    recovery.value.status !== "applied" ||
    receipt.value.recoverySha256 !== taggedSha256(recovery.bytes) ||
    receipt.value.recoveryPlanSha256 !== recoveryPlanSha256(recovery.value)
  ) {
    throw adoptionError(
      "MIGRATE008",
      "Active cutover does not match its applied recovery evidence.",
    );
  }
  const reviewed = await loadStoredManifest(environment);
  const inspection = await inspectWorkspace({
    workspace: environment.workspace.realPath,
    allowExternalGraphRoot: environment.graph.external
      ? environment.graph.resolvedGraphPath
      : undefined,
  });
  if (
    !inspection.report.ok ||
    inspection.report.graph.revision !== receipt.value.afterGraphRevision
  ) {
    throw adoptionError("MIGRATE013", "Active graph does not match the cutover receipt.");
  }
  for (const target of reviewed.targets) {
    const path = join(environment.graph.resolvedGraphPath, ...target.path.split("/"));
    const bytes = await readMigrationTargetBytes(
      path,
      environment.graph.resolvedGraphPath,
      VALIDATION_POLICY.maxNoteBytes,
      "Active migration target",
    );
    if (bytes === null || taggedSha256(bytes) !== target.contentSha256) {
      throw adoptionError("MIGRATE013", `Cutover target no longer matches reviewed bytes: ${target.path}`);
    }
  }
  const hooks = await inspectAgentHooks(environment.workspace.realPath);
  if (
    hooks.some((item) => item.legacyKnowledgeGraphWorkflow) ||
    !hooks.some((item) => item.marker === "present" && item.version === 2)
  ) {
    throw adoptionError("MIGRATE013", "Agent activation no longer matches the cutover receipt.");
  }
  return { receipt, reviewed, inspection, hooks };
}

export async function verifyMigration(options) {
  let lockRoots = null;
  const operation = async () => {
    const environment = await loadEnvironment(options);
    assertEnvironmentMatchesLocks(environment, lockRoots);
    if (!new Set(["cutover-applied", "verified"]).has(environment.loadedState.value.status)) {
      throw adoptionError("MIGRATE006", "Verification requires an applied cutover.");
    }
    const verified = await verifyActiveMigration(environment, options);
    if (environment.loadedState.value.status === "verified") {
      const existing = await loadVerificationReport(environment);
      return {
        ok: true,
        command: "migrate",
        phase: "verify",
        workspace: environment.workspace.realPath,
        graph: {
          root: environment.graph.resolvedGraphPath,
          revision: existing.value.graphRevision,
        },
        migrationId: environment.loadedState.value.migrationId,
        status: environment.loadedState.value.status,
        dryRun: options.dryRun,
        summary: {
          targets: existing.value.targets,
          agentHooks: verified.hooks.length,
          pass: true,
          idempotent: true,
        },
        changes: [],
      };
    }
    const now = new Date().toISOString();
    const report = {
      schemaVersion: 1,
      kind: MIGRATION_ADOPTION_POLICY.verificationSpecification,
      migrationId: environment.loadedState.value.migrationId,
      cutoverReceiptSha256: taggedSha256(verified.receipt.bytes),
      graphRevision: verified.inspection.report.graph.revision,
      verifiedAt: now,
      targets: verified.reviewed.targets.length,
      agentHooks: verified.hooks,
      pass: true,
    };
    const reportBytes = serializeMigrationJson(report);
    const nextState = {
      ...environment.loadedState.value,
      status: "verified",
      updatedAt: environment.loadedState.value.status === "verified"
        ? environment.loadedState.value.updatedAt
        : now,
      artifacts: {
        ...environment.loadedState.value.artifacts,
        verification: artifactReference(environment.paths, environment.paths.verification, reportBytes),
      },
    };
    assertMigrationTransition(environment.loadedState.value.status, nextState.status);
    const stateBytes = serializeMigrationJson(nextState);
    const plans = [
      {
        path: environment.paths.verification,
        before: await readMigrationBytes(
          environment.paths.verification,
          environment.paths.root,
          undefined,
          "Migration verification",
        ),
        after: reportBytes,
        displayPath: environment.paths.verification,
      },
      {
        path: environment.paths.state,
        before: environment.loadedState.bytes,
        after: stateBytes,
        displayPath: environment.paths.state,
      },
    ];
    if (!options.dryRun) {
      await applyFilePlans(bindMigrationStoragePlans(environment.paths, plans));
    }
    return {
      ok: true,
      command: "migrate",
      phase: "verify",
      workspace: environment.workspace.realPath,
      graph: {
        root: environment.graph.resolvedGraphPath,
        revision: report.graphRevision,
      },
      migrationId: environment.loadedState.value.migrationId,
      status: nextState.status,
      dryRun: options.dryRun,
      summary: { targets: report.targets, agentHooks: report.agentHooks.length, pass: true },
      changes: plans.map((plan) => describePlan(plan, environment.workspace.realPath)),
    };
  };
  if (options.dryRun) return operation();
  lockRoots = await resolveMigrationLockRoots(options);
  return withMigrationLocks(
    lockRoots,
    operation,
  );
}

export async function rollbackMigration(options) {
  let lockRoots = null;
  const operation = async () => {
    const environment = await loadEnvironment(options);
    assertEnvironmentMatchesLocks(environment, lockRoots);
    if (!new Set(["cutover-prepared", "cutover-applied", "verified", "retired", "rolled-back"]).has(environment.loadedState.value.status)) {
      throw adoptionError(
        "MIGRATE006",
        "Rollback requires an interrupted, applied, verified, retired, or already rolled-back cutover.",
      );
    }
    const loadedRecovery = await readEnvironmentRecovery(environment, {
      required: true,
      allowStateBindingTransition:
        environment.loadedState.value.status !== "rolled-back",
    });
    if (!loadedRecovery) {
      throw adoptionError("MIGRATE008", "Rollback recovery journal is missing.");
    }
    if (new Set(["cutover-applied", "verified", "retired"]).has(
      environment.loadedState.value.status,
    )) {
      await assertReceiptRecoveryBinding(environment, loadedRecovery);
    }
    const roots = {
      workspacePath: environment.workspace.realPath,
      graphRoot: environment.graph.resolvedGraphPath,
    };
    if (environment.loadedState.value.status === "rolled-back") {
      if (loadedRecovery.value.status !== "rolled-back") {
        throw adoptionError("MIGRATE008", "Rolled-back state does not match its recovery journal.");
      }
      const preview = await previewRecovery({
        roots,
        recovery: loadedRecovery.value,
        direction: "backward",
      });
      if (preview.pending !== 0) {
        throw adoptionError(
          "MIGRATE009",
          "Rolled-back files no longer match the retained pre-cutover baseline.",
          preview,
        );
      }
      if (environment.loadedState.value.artifacts.cutoverReceipt !== null) {
        await assertReceiptRecoveryBinding(environment, loadedRecovery);
      }
      return {
        ok: true,
        command: "migrate",
        phase: "rollback",
        workspace: environment.workspace.realPath,
        migrationId: environment.loadedState.value.migrationId,
        status: environment.loadedState.value.status,
        dryRun: options.dryRun,
        summary: { ...preview, restored: 0, idempotent: true },
        changes: [],
      };
    }
    if (options.dryRun) {
      const preview = await previewRecovery({
        roots,
        recovery: loadedRecovery.value,
        direction: "backward",
      });
      return {
        ok: true,
        command: "migrate",
        phase: "rollback",
        workspace: environment.workspace.realPath,
        migrationId: environment.loadedState.value.migrationId,
        status: environment.loadedState.value.status,
        dryRun: true,
        summary: preview,
        changes: loadedRecovery.value.records.map((record) => ({
          action: "restore",
          path: `${record.root}:${record.path}`,
        })),
      };
    }
    let rolledBack;
    if (loadedRecovery.value.status === "rolled-back") {
      const preview = await previewRecovery({
        roots,
        recovery: loadedRecovery.value,
        direction: "backward",
      });
      if (preview.pending !== 0) {
        throw adoptionError(
          "MIGRATE009",
          "Interrupted rollback journal does not match restored workspace bytes.",
          preview,
        );
      }
      rolledBack = {
        recovery: loadedRecovery.value,
        bytes: loadedRecovery.bytes,
        summary: { restored: 0, already: preview.already, total: preview.total },
      };
    } else {
      rolledBack = await rollbackRecovery({
        paths: environment.paths,
        roots,
        recovery: loadedRecovery.value,
      });
    }
    const now = new Date().toISOString();
    const nextState = {
      ...environment.loadedState.value,
      status: "rolled-back",
      updatedAt: now,
      artifacts: {
        ...environment.loadedState.value.artifacts,
        recovery: artifactReference(environment.paths, environment.paths.recovery, rolledBack.bytes),
      },
    };
    if (environment.loadedState.value.status !== "rolled-back") {
      assertMigrationTransition(environment.loadedState.value.status, nextState.status);
    }
    const stateBytes = serializeMigrationJson(nextState);
    await applyFilePlans(bindMigrationStoragePlans(environment.paths, [{
      path: environment.paths.state,
      before: environment.loadedState.bytes,
      after: stateBytes,
      displayPath: environment.paths.state,
    }]));
    return {
      ok: true,
      command: "migrate",
      phase: "rollback",
      workspace: environment.workspace.realPath,
      migrationId: environment.loadedState.value.migrationId,
      status: nextState.status,
      dryRun: false,
      summary: rolledBack.summary,
      changes: rolledBack.recovery.records.map((record) => ({
        action: "restore",
        path: `${record.root}:${record.path}`,
      })),
    };
  };
  if (options.dryRun) return operation();
  lockRoots = await resolveMigrationLockRoots(options);
  return withMigrationLocks(
    lockRoots,
    operation,
  );
}

export async function retireMigration(options) {
  let lockRoots = null;
  const operation = async () => {
    const environment = await loadEnvironment(options);
    assertEnvironmentMatchesLocks(environment, lockRoots);
    if (!new Set(["verified", "retired"]).has(environment.loadedState.value.status)) {
      throw adoptionError("MIGRATE006", "Retirement requires a verified cutover.");
    }
    const verified = await verifyActiveMigration(environment, options);
    const verification = await loadVerificationReport(environment);
    const loadedRecovery = await readEnvironmentRecovery(environment, { required: true });
    if (!loadedRecovery || loadedRecovery.value.status !== "applied") {
      throw adoptionError("MIGRATE008", "Retirement requires retained applied recovery evidence.");
    }
    await assertReceiptRecoveryBinding(environment, loadedRecovery);
    await verifyRecoveryBlobs({
      paths: environment.paths,
      recovery: loadedRecovery.value,
    });
    const graphRecoveryByPath = new Map(
      loadedRecovery.value.records
        .filter((record) => record.root === "graph")
        .map((record) => [portableIdentity(record.path), record.beforeSha256]),
    );
    const archiveRecoveryByPath = new Map(
      loadedRecovery.value.records
        .filter((record) => record.root === "graph" && record.category === "archive")
        .map((record) => [portableIdentity(record.path), record.afterSha256]),
    );
    let retainedSources = 0;
    for (const disposition of verified.reviewed.manifest.dispositions) {
      const sourcePath = join(
        environment.graph.resolvedGraphPath,
        ...disposition.path.split("/"),
      );
      const live = await readMigrationTargetBytes(
        sourcePath,
        environment.graph.resolvedGraphPath,
        VALIDATION_POLICY.maxNoteBytes,
        "Legacy source retention",
      );
      const liveHash = live === null ? null : taggedSha256(live);
      const recoveredHash = graphRecoveryByPath.get(portableIdentity(disposition.path));
      if (liveHash !== disposition.expectedSha256) {
        const archivePath = legacyArchivePath(
          environment.loadedState.value.migrationId,
          disposition.path,
        );
        const archive = await readMigrationTargetBytes(
          join(
            environment.graph.resolvedGraphPath,
            ...archivePath.split("/"),
          ),
          environment.graph.resolvedGraphPath,
          VALIDATION_POLICY.maxNoteBytes,
          "Durable legacy archive",
        );
        const archiveHash = archive === null ? null : taggedSha256(archive);
        if (
          recoveredHash !== disposition.expectedSha256 ||
          archiveRecoveryByPath.get(portableIdentity(archivePath)) !==
            disposition.expectedSha256 ||
          archiveHash !== disposition.expectedSha256
        ) {
          throw adoptionError(
            "MIGRATE014",
            `Legacy source is not retained as durable Markdown and recovery evidence: ${disposition.path}`,
          );
        }
      }
      retainedSources += 1;
    }
    const dispositionCounts = verified.reviewed.manifest.dispositions.reduce(
      (counts, item) => ({
        ...counts,
        [item.disposition]: (counts[item.disposition] ?? 0) + 1,
      }),
      {},
    );
    if (environment.loadedState.value.status === "retired") {
      const artifact = await verifyArtifactReference(
        environment.paths,
        environment.loadedState.value.artifacts.retirement,
        "Migration retirement",
      );
      const existing = parseStrictJson(artifact.bytes, "Migration retirement");
      if (
        existing.schemaVersion !== 1 ||
        existing.kind !== MIGRATION_ADOPTION_POLICY.retirementSpecification ||
        existing.migrationId !== environment.loadedState.value.migrationId ||
        existing.verificationSha256 !== taggedSha256(verification.bytes) ||
        existing.predecessorActivationRemoved !== true ||
        existing.defaultLegacyAuthorityRemoved !== true ||
        existing.originalBytesRetained !== true ||
        existing.rollbackRetained !== true ||
        existing.retainedSources !== retainedSources ||
        JSON.stringify(existing.dispositions) !== JSON.stringify(dispositionCounts)
      ) {
        throw adoptionError("MIGRATE014", "Migration retirement artifact is inconsistent.");
      }
      return {
        ok: true,
        command: "migrate",
        phase: "retire",
        workspace: environment.workspace.realPath,
        migrationId: environment.loadedState.value.migrationId,
        status: environment.loadedState.value.status,
        dryRun: options.dryRun,
        summary: {
          retainedSources,
          rollbackRetained: true,
          predecessorActivationRemoved: true,
          idempotent: true,
        },
        changes: [],
      };
    }
    const now = new Date().toISOString();
    const receipt = {
      schemaVersion: 1,
      kind: MIGRATION_ADOPTION_POLICY.retirementSpecification,
      migrationId: environment.loadedState.value.migrationId,
      verificationSha256: taggedSha256(verification.bytes),
      retiredAt: now,
      predecessorActivationRemoved: true,
      defaultLegacyAuthorityRemoved: true,
      originalBytesRetained: true,
      rollbackRetained: true,
      retainedSources,
      dispositions: dispositionCounts,
    };
    const receiptBytes = serializeMigrationJson(receipt);
    const nextState = {
      ...environment.loadedState.value,
      status: "retired",
      updatedAt: environment.loadedState.value.status === "retired"
        ? environment.loadedState.value.updatedAt
        : now,
      artifacts: {
        ...environment.loadedState.value.artifacts,
        retirement: artifactReference(environment.paths, environment.paths.retirement, receiptBytes),
      },
    };
    assertMigrationTransition(environment.loadedState.value.status, nextState.status);
    const stateBytes = serializeMigrationJson(nextState);
    const plans = [
      {
        path: environment.paths.retirement,
        before: await readMigrationBytes(
          environment.paths.retirement,
          environment.paths.root,
          undefined,
          "Migration retirement",
        ),
        after: receiptBytes,
        displayPath: environment.paths.retirement,
      },
      {
        path: environment.paths.state,
        before: environment.loadedState.bytes,
        after: stateBytes,
        displayPath: environment.paths.state,
      },
    ];
    if (!options.dryRun) {
      await applyFilePlans(bindMigrationStoragePlans(environment.paths, plans));
    }
    return {
      ok: true,
      command: "migrate",
      phase: "retire",
      workspace: environment.workspace.realPath,
      migrationId: environment.loadedState.value.migrationId,
      status: nextState.status,
      dryRun: options.dryRun,
      summary: {
        retainedSources,
        rollbackRetained: true,
        predecessorActivationRemoved: true,
      },
      changes: plans.map((plan) => describePlan(plan, environment.workspace.realPath)),
    };
  };
  if (options.dryRun) return operation();
  lockRoots = await resolveMigrationLockRoots(options);
  return withMigrationLocks(
    lockRoots,
    operation,
  );
}

export async function migrationStatus(options) {
  const environment = await loadEnvironment(options);
  const inspection = await inspectWorkspace({
    workspace: environment.workspace.realPath,
    allowExternalGraphRoot: environment.graph.external
      ? environment.graph.resolvedGraphPath
      : undefined,
  });
  const recovery = await readEnvironmentRecovery(environment);
  return {
    ok: true,
    command: "migrate",
    phase: "status",
    workspace: environment.workspace.realPath,
    graph: {
      root: environment.graph.resolvedGraphPath,
      revision: inspection.report.graph.revision,
    },
    migrationId: environment.loadedState.value.migrationId,
    status: environment.loadedState.value.status,
    dryRun: false,
    summary: {
      sources: environment.loadedState.value.baseline.sourceCount,
      targets: environment.loadedState.value.baseline.targetCount,
      baselineGraphRevision: environment.loadedState.value.baseline.graphRevision,
      graphValid: inspection.report.ok,
      recovery: recovery?.value.status ?? null,
      artifacts: Object.fromEntries(
        Object.entries(environment.loadedState.value.artifacts).map(([key, value]) => [key, value !== null]),
      ),
    },
    changes: [],
  };
}
