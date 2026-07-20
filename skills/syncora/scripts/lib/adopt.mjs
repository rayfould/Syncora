import { dirname, join } from "node:path";

import {
  buildAdoptionBundle,
  loadAndValidateAdoptionBundle,
} from "./adoption-bundle.mjs";
import { SyncoraError } from "./cli.mjs";
import {
  cutoverMigration,
  migrationStatus,
  retireMigration,
  rollbackMigration,
  verifyMigration,
} from "./migration-adoption.mjs";
import {
  resolveMigrationLockRoots,
  withMigrationLocks,
} from "./migration-lock.mjs";
import { shadowMigration } from "./migration-shadow.mjs";
import { stageMigration } from "./migration-stage.mjs";

const DEFAULT_LIFECYCLE = Object.freeze({
  status: migrationStatus,
  stage: stageMigration,
  shadow: shadowMigration,
  cutover: cutoverMigration,
  verify: verifyMigration,
  retire: retireMigration,
  rollback: rollbackMigration,
});

function resolvedArtifactOptions(options, bundle) {
  return {
    ...options,
    migrationId: bundle.migrationId,
    manifest: bundle.manifest.path,
    stagedContent: bundle.stagedContent.path,
    fixtures: bundle.fixtures.path,
    expectedManifestSha256: bundle.manifest.sha256,
    expectedTargets: bundle.stagedContent.targets.map(
      ({ path, sha256, byteLength }) => ({
        path,
        contentSha256: sha256,
        byteLength,
      }),
    ),
    expectedFixturesSha256: bundle.fixtures.sha256,
  };
}

function phaseRecord(result) {
  return {
    phase: result.phase,
    status: result.status,
    summary: result.summary ?? {},
  };
}

function errorRecord(error) {
  return {
    code: error instanceof SyncoraError ? error.code : "INTERNAL001",
    message: error instanceof Error ? error.message : String(error),
    ...(error?.details === undefined ? {} : { details: error.details }),
  };
}

function adoptionFailure(
  error,
  phase,
  completedPhases,
  currentStatus,
  automaticRollback = undefined,
) {
  const code = error instanceof SyncoraError ? error.code : "INTERNAL001";
  const message = error instanceof Error ? error.message : String(error);
  const recoveryMessage = automaticRollback
    ? " Exact automatic rollback restored the pre-cutover bytes; this migration ID is now terminal, so prepare a fresh reviewed bundle with a new ID."
    : " Fix the reported gate and rerun the same adopt command to resume safely.";
  return new SyncoraError(
    code,
    `${message} Adoption stopped during ${phase}.${recoveryMessage}`,
    {
      cause: error?.details,
      adoption: {
        phase,
        currentStatus,
        completedPhases,
        ...(automaticRollback ? { automaticRollback } : {}),
      },
    },
  );
}

function recoveryRequired(error, rollbackError, phase, currentStatus, completedPhases) {
  return new SyncoraError(
    "MIGRATE017",
    `Adoption failed during ${phase}, and exact automatic rollback could not be proven. Conflicting current bytes were not overwritten, but other published migration bytes may remain active; recovery is required for migration ${currentStatus?.migrationId ?? "state"}.`,
    {
      original: errorRecord(error),
      rollback: errorRecord(rollbackError),
      adoption: {
        phase,
        currentStatus: currentStatus?.status ?? null,
        completedPhases,
        recoveryRequired: true,
      },
    },
  );
}

async function readStartingStatus(options, lifecycle, lockCapability) {
  try {
    return await lifecycle.status(
      { ...options, phase: "status", dryRun: false },
      { lockCapability },
    );
  } catch (error) {
    if (
      error instanceof SyncoraError &&
      error.code === "MIGRATE006" &&
      error.message.startsWith("Migration state does not exist")
    ) {
      return null;
    }
    throw error;
  }
}

function reviewedPackOutput(options) {
  return options.output ?? join(dirname(options.manifest), "adoption-bundle-v1.json");
}

async function prepareReviewedPack(options, hooks = {}) {
  const prepared = await buildAdoptionBundle(
    {
      ...options,
      output: reviewedPackOutput(options),
      dryRun: options.dryRun === true,
      expectedDescriptorSha256: options.expectedBundleDigest,
    },
    hooks,
  );
  if (options.dryRun) {
    return {
      ok: true,
      command: "adopt",
      workspace: prepared.workspace,
      migrationId: prepared.migrationId,
      status: "review-required",
      dryRun: true,
      review: {
        bundleOutput: prepared.output,
        bundleSha256: prepared.descriptor.sha256,
        manifest: prepared.manifest,
        stagedContent: prepared.stagedContent,
        fixtures: prepared.fixtures,
      },
      summary: {
        bundleSha256: prepared.descriptor.sha256,
        completedPhases: [],
        finalStatus: "review-required",
        rollbackRetained: false,
        idempotent: false,
      },
      phases: [],
      warnings: [],
      changes: [],
    };
  }
  return prepared;
}

export async function adoptWorkspace(
  options,
  lifecycle = DEFAULT_LIFECYCLE,
  hooks = {},
) {
  if (options.bundle && options.dryRun) {
    throw new SyncoraError(
      "CLI005",
      "A sealed adoption bundle is already reviewable and does not support adopt --dry-run.",
    );
  }
  if (!options.bundle && !options.dryRun && !options.expectedBundleDigest) {
    throw new SyncoraError(
      "CLI002",
      "Final reviewed-pack adoption requires --expected-bundle-digest from adopt --dry-run.",
    );
  }
  const prepared = options.bundle
    ? null
    : await prepareReviewedPack(options, hooks.bundle);
  if (prepared?.dryRun) return prepared;
  const bundlePath = options.bundle ?? prepared.output;
  const bundle = await loadAndValidateAdoptionBundle(bundlePath, hooks.load);
  if (
    options.expectedBundleDigest !== undefined &&
    options.expectedBundleDigest !== bundle.descriptor.sha256
  ) {
    throw new SyncoraError(
      "MIGRATE016",
      "The adoption bundle does not match the reviewed digest.",
      {
        expected: options.expectedBundleDigest,
        actual: bundle.descriptor.sha256,
      },
    );
  }
  const runtimeOptions = resolvedArtifactOptions(
    { ...options, bundle: bundlePath, dryRun: false },
    bundle,
  );
  const lockRoots = await resolveMigrationLockRoots(runtimeOptions);
  const result = await withMigrationLocks(lockRoots, (lockCapability) =>
    adoptWorkspaceLocked({
      bundle,
      runtimeOptions,
      lifecycle,
      lockCapability,
    }));
  return prepared
    ? {
        ...result,
        review: {
          bundleOutput: prepared.output,
          bundleSha256: prepared.descriptor.sha256,
          manifest: prepared.manifest,
          stagedContent: prepared.stagedContent,
          fixtures: prepared.fixtures,
        },
      }
    : result;
}

async function adoptWorkspaceLocked({
  bundle,
  runtimeOptions,
  lifecycle,
  lockCapability,
}) {
  const starting = await readStartingStatus(
    runtimeOptions,
    lifecycle,
    lockCapability,
  );
  let currentStatus = starting?.status ?? null;
  let lastResult = starting;
  let lastGraph = starting?.graph;
  const phases = [];
  const warnings = [];
  let activePhase = null;

  if (starting) {
    if (starting.summary.manifestSha256 !== bundle.manifest.sha256) {
      throw new SyncoraError(
        "MIGRATE016",
        "The reviewed bundle manifest does not match the persisted migration state.",
      );
    }
    if (
      starting.status !== "staged" &&
      starting.summary.fixtureSha256 !== bundle.fixtures.sha256
    ) {
      throw new SyncoraError(
        "MIGRATE016",
        "The reviewed bundle fixtures do not match the persisted migration state.",
      );
    }
  }

  const runPhase = async (phase, operation) => {
    activePhase = phase;
    const result = await operation(
      { ...runtimeOptions, phase },
      { lockCapability },
    );
    warnings.push(...(result.warnings ?? []));
    currentStatus = result.status;
    lastResult = result;
    lastGraph = result.graph ?? lastGraph;
    if (!result.ok) {
      throw new SyncoraError(
        "MIGRATE012",
        `The ${phase} gate did not pass.`,
        { summary: result.summary },
      );
    }
    phases.push(phaseRecord(result));
    activePhase = null;
  };

  if (currentStatus === "rolled-back") {
    throw new SyncoraError(
      "MIGRATE006",
      "This migration was rolled back and cannot be adopted again under the same migration ID. Prepare a fresh reviewed bundle with a new migration ID.",
    );
  }

  try {
    if (currentStatus === null || currentStatus === "staged") {
      await runPhase("stage", lifecycle.stage);
    }
    if (currentStatus === "staged") {
      await runPhase("shadow", lifecycle.shadow);
    }
    if (currentStatus === "shadow-verified" || currentStatus === "cutover-prepared") {
      await runPhase("cutover", lifecycle.cutover);
    }
    if (currentStatus === "cutover-applied") {
      await runPhase("verify", lifecycle.verify);
    }
    if (currentStatus === "verified") {
      await runPhase("retire", lifecycle.retire);
    }

    if (currentStatus !== "retired") {
      throw new SyncoraError(
        "MIGRATE006",
        `Adoption cannot continue from migration state: ${currentStatus ?? "missing"}.`,
        { completedPhases: phases.map((item) => item.phase) },
      );
    }
  } catch (error) {
    const failedPhase = activePhase ?? "routing";
    const completedPhases = phases.map((item) => item.phase);
    if (new Set(["cutover", "verify"]).has(failedPhase)) {
      let observed;
      try {
        observed = await lifecycle.status(
          {
            ...runtimeOptions,
            phase: "status",
            dryRun: false,
          },
          { lockCapability },
        );
      } catch (statusError) {
        throw recoveryRequired(
          error,
          statusError,
          failedPhase,
          null,
          completedPhases,
        );
      }
      currentStatus = observed.status;
      if (new Set(["cutover-prepared", "cutover-applied", "verified"]).has(
        observed.status,
      )) {
        try {
          const rolledBack = await lifecycle.rollback(
            { ...runtimeOptions, phase: "rollback", dryRun: false },
            { lockCapability },
          );
          throw adoptionFailure(
            error,
            failedPhase,
            completedPhases,
            rolledBack.status,
            {
              status: rolledBack.status,
              summary: rolledBack.summary,
            },
          );
        } catch (rollbackError) {
          if (
            rollbackError instanceof SyncoraError &&
            rollbackError.details?.adoption?.automaticRollback
          ) {
            throw rollbackError;
          }
          throw recoveryRequired(
            error,
            rollbackError,
            failedPhase,
            observed,
            completedPhases,
          );
        }
      }
    }
    throw adoptionFailure(
      error,
      failedPhase,
      completedPhases,
      currentStatus,
    );
  }

  return {
    ok: true,
    command: "adopt",
    workspace: lastResult?.workspace ?? runtimeOptions.workspace,
    graph: lastGraph,
    migrationId: runtimeOptions.migrationId,
    status: currentStatus,
    dryRun: false,
    summary: {
      bundleSha256: bundle.descriptor.sha256,
      startedAt: starting?.status ?? "not-staged",
      completedPhases: phases.map((item) => item.phase),
      finalStatus: currentStatus,
      rollbackRetained: true,
      idempotent: phases.length === 0,
    },
    phases,
    warnings,
  };
}
