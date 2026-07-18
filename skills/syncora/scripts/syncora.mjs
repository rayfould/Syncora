#!/usr/bin/env node

import { applyFilePlans, describePlan } from "./lib/atomic-file.mjs";
import { adoptWorkspace } from "./lib/adopt.mjs";
import { buildAdoptionBundle } from "./lib/adoption-bundle.mjs";
import {
  planAgentPatch,
  planAgentUnpatch,
  verifyAgentPatchPlans,
} from "./lib/agent-patcher.mjs";
import { inventoryAuthority } from "./lib/authority-inventory.mjs";
import { readBacklinks } from "./lib/backlinks.mjs";
import { checkpointWorkspace } from "./lib/checkpoint.mjs";
import {
  VERSION,
  helpText,
  parseArgv,
  renderError,
  renderResult,
  SyncoraError,
} from "./lib/cli.mjs";
import { diagnoseWorkspace } from "./lib/doctor.mjs";
import { applyGovernedProposal } from "./lib/governed-apply.mjs";
import {
  createGovernedProposal,
  inspectGovernedProposal,
} from "./lib/governed-capture.mjs";
import { reviewGovernedProposal } from "./lib/governed-review.mjs";
import { initializeWorkspace } from "./lib/init.mjs";
import {
  cutoverMigration,
  migrationStatus,
  retireMigration,
  rollbackMigration,
  verifyMigration,
} from "./lib/migration-adoption.mjs";
import { shadowMigration } from "./lib/migration-shadow.mjs";
import { stageMigration } from "./lib/migration-stage.mjs";
import { withPatchLock } from "./lib/patch-lock.mjs";
import { searchWorkspace } from "./lib/search.mjs";
import { compileTaskContext } from "./lib/task-context.mjs";
import { validateWorkspace } from "./lib/validate.mjs";
import {
  requireInitializedWorkspace,
  resolveWorkspace,
} from "./lib/workspace.mjs";

async function runAgentCommand(command, options) {
  const workspace = await resolveWorkspace(options.workspace);
  await requireInitializedWorkspace(workspace.realPath);
  const createPlan = () =>
    command === "patch-agents"
      ? planAgentPatch(workspace.realPath)
      : planAgentUnpatch(workspace.realPath);
  const planned = options.dryRun
    ? await createPlan()
    : await withPatchLock(workspace.realPath, async () => {
        const nextPlan = await createPlan();
        await verifyAgentPatchPlans(workspace.realPath, nextPlan.plans);
        await applyFilePlans(nextPlan.plans);
        return nextPlan;
      });

  return {
    ok: true,
    command,
    workspace: workspace.realPath,
    dryRun: options.dryRun,
    changes: planned.plans.map((item) =>
      describePlan(item, workspace.realPath),
    ),
    warnings: planned.warnings,
  };
}

async function runMigration(options) {
  if (options.phase === "authority") return inventoryAuthority(options);
  if (options.phase === "stage") return stageMigration(options);
  if (options.phase === "shadow") return shadowMigration(options);
  if (options.phase === "cutover") return cutoverMigration(options);
  if (options.phase === "verify") return verifyMigration(options);
  if (options.phase === "rollback") return rollbackMigration(options);
  if (options.phase === "retire") return retireMigration(options);
  return migrationStatus(options);
}

async function main() {
  const rawArguments = process.argv.slice(2);
  const formatIndex = rawArguments.indexOf("--format");
  let format = rawArguments[formatIndex + 1] === "json" ? "json" : "text";
  try {
    const parsed = parseArgv(rawArguments);
    format = parsed.options.format ?? "text";

    if (parsed.command === "help") {
      process.stdout.write(`${helpText(parsed.options.topic)}\n`);
      return;
    }
    if (parsed.command === "version") {
      process.stdout.write(`${VERSION}\n`);
      return;
    }

    let result;
    if (parsed.command === "adopt") {
      result = await adoptWorkspace(parsed.options);
    } else if (parsed.command === "apply") {
      result = await applyGovernedProposal(parsed.options);
    } else if (parsed.command === "bundle") {
      result = await buildAdoptionBundle(parsed.options);
    } else if (parsed.command === "capture") {
      result = await createGovernedProposal({
        ...parsed.options,
        command: "capture",
      });
    } else if (parsed.command === "doctor") {
      result = await diagnoseWorkspace(parsed.options);
    } else if (parsed.command === "backlinks") {
      result = await readBacklinks(parsed.options);
    } else if (parsed.command === "checkpoint") {
      result = await checkpointWorkspace(parsed.options);
    } else if (parsed.command === "context") {
      result = await compileTaskContext(parsed.options);
    } else if (parsed.command === "init" || parsed.command === "setup") {
      result = await initializeWorkspace(parsed.options);
      if (parsed.command === "setup") result = { ...result, command: "setup" };
    } else if (parsed.command === "migrate") {
      result = await runMigration(parsed.options);
    } else if (parsed.command === "propose") {
      result = parsed.options.input
        ? await createGovernedProposal({
            ...parsed.options,
            command: "propose",
          })
        : await inspectGovernedProposal(parsed.options);
    } else if (parsed.command === "review") {
      result = await reviewGovernedProposal(parsed.options);
    } else if (parsed.command === "search") {
      result = await searchWorkspace(parsed.options);
    } else if (parsed.command === "validate") {
      result = await validateWorkspace(parsed.options);
    } else {
      result = await runAgentCommand(parsed.command, parsed.options);
    }

    process.stdout.write(renderResult(result, format));
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(renderError(error, format));
    process.exitCode = 1;
  }
}

await main();
