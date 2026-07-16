#!/usr/bin/env node

import { applyFilePlans, describePlan } from "./lib/atomic-file.mjs";
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
import { initializeWorkspace } from "./lib/init.mjs";
import { withPatchLock } from "./lib/patch-lock.mjs";
import { searchWorkspace } from "./lib/search.mjs";
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
    if (parsed.command === "doctor") {
      result = await diagnoseWorkspace(parsed.options);
    } else if (parsed.command === "backlinks") {
      result = await readBacklinks(parsed.options);
    } else if (parsed.command === "checkpoint") {
      result = await checkpointWorkspace(parsed.options);
    } else if (parsed.command === "init") {
      result = await initializeWorkspace(parsed.options);
    } else if (parsed.command === "migrate") {
      result = await inventoryAuthority(parsed.options);
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
