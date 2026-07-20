import { lstat, mkdir, readFile, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyFilePlans,
  describePlan,
  readOptionalBuffer,
} from "./atomic-file.mjs";
import {
  inspectAgentHooks,
  planAgentMigrationCutover,
  planAgentPatch,
  verifyAgentPatchPlans,
} from "./agent-patcher.mjs";
import { SyncoraError } from "./cli.mjs";
import {
  assertMigrationLockRoots,
  withMigrationLocks,
} from "./migration-lock.mjs";
import { withPatchLock } from "./patch-lock.mjs";
import { inspectWorkspaceUnlocked as inspectWorkspace } from "./validate.mjs";
import { assertNoNonterminalFileTransaction } from "./writer-interlock.mjs";
import {
  readSyncoraConfigIfPresent,
  resolveGraphContext,
  resolveWorkspace,
} from "./workspace.mjs";

const MODULE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIRECTORY = join(
  MODULE_DIRECTORY,
  "..",
  "..",
  "assets",
  "templates",
);

async function template(name) {
  return readFile(join(TEMPLATE_DIRECTORY, name), "utf8");
}

function render(source, values) {
  return source.replace(/\{\{([a-z_]+)\}\}/g, (match, key) => {
    if (!(key in values)) {
      throw new SyncoraError("TEMPLATE001", `Missing template value: ${key}`);
    }
    return values[key];
  });
}

function filePlan(path, before, after, displayPath) {
  return { path, before, after, displayPath };
}

async function createIfMissing(path, content, displayPath) {
  const before = await readOptionalBuffer(path);
  return filePlan(
    path,
    before,
    before ?? Buffer.from(content, "utf8"),
    displayPath,
  );
}

function portablePath(workspacePath, path) {
  return path
    .slice(workspacePath.length + (path === workspacePath ? 0 : 1))
    .replaceAll("\\", "/");
}

function safeWorkspaceName(workspacePath) {
  return basename(workspacePath).replace(/[\r\n\t]+/g, " ").trim() || "Workspace";
}

function sameDirectoryIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.ctimeNs === right.ctimeNs &&
    left.mtimeNs === right.mtimeNs
  );
}

async function metadataIfPresent(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function inspectPreexistingGraph(graphRoot) {
  let before;
  try {
    before = await lstat(graphRoot, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw new SyncoraError(
      "READ001",
      `Unable to inspect the graph root before initialization: ${graphRoot}`,
      { cause: error.message },
    );
  }
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new SyncoraError(
      "READ001",
      `Graph root is not a stable regular directory: ${graphRoot}`,
    );
  }

  let entries;
  let after;
  try {
    entries = await readdir(graphRoot, { withFileTypes: true });
    after = await lstat(graphRoot, { bigint: true });
  } catch (error) {
    throw new SyncoraError(
      "READ001",
      `Unable to enumerate the graph root before initialization: ${graphRoot}`,
      { cause: error.message },
    );
  }
  if (!sameDirectoryIdentity(before, after)) {
    throw new SyncoraError(
      "READ001",
      "Graph root changed while initialization safety was being evaluated.",
    );
  }

  return entries
    .map((entry) => entry.name)
    .filter((name) => ![".git", ".syncora"].includes(name.toLowerCase()))
    .sort();
}

async function isRecognizedSyncoraGraph(workspace, graph, options) {
  try {
    const inspection = await inspectWorkspace({
      workspace: workspace.realPath,
      allowExternalGraphRoot: options.allowExternalGraphRoot,
    });
    const activeAtlases = inspection.notes.filter(
      (note) =>
        note.currentSchema &&
        note.frontmatter.kind === "atlas" &&
        note.frontmatter.state === "active" &&
        note.authorityClass === "routing",
    );
    const activeProjectHubs = inspection.notes.filter(
      (note) =>
        note.currentSchema &&
        note.frontmatter.kind === "project" &&
        note.frontmatter.state === "active" &&
        note.authorityClass === "canonical",
    );
    return (
      inspection.report.ok &&
      activeAtlases.length === 1 &&
      activeProjectHubs.length >= 1 &&
      inspection.graph.resolvedGraphPath === graph.resolvedGraphPath
    );
  } catch {
    return false;
  }
}

async function initializeWorkspaceUnlocked(options, expectedLockRoots = undefined) {
  const workspace = await resolveWorkspace(options.workspace);
  const graph = await resolveGraphContext(workspace, {
    allowExternalGraphRoot: options.allowExternalGraphRoot,
  });
  if (expectedLockRoots !== undefined) {
    assertMigrationLockRoots(expectedLockRoots, {
      workspacePath: workspace.realPath,
      graphRoot: graph.resolvedGraphPath,
    });
    await assertNoNonterminalFileTransaction(graph.resolvedGraphPath);
  }
  const today = new Date().toISOString().slice(0, 10);
  const workspaceName = safeWorkspaceName(workspace.realPath);
  const plans = [];
  const warnings = [];

  if (graph.external) {
    warnings.push({
      code: "EXTERNAL_GRAPH_ROOT",
      message: `Graph writes are allowlisted at ${graph.resolvedGraphPath}.`,
    });
  }

  const existingConfig = await readSyncoraConfigIfPresent(workspace.realPath);
  const inspectedHooks = await inspectAgentHooks(workspace.realPath);
  const legacyHooks = inspectedHooks.filter(
    (item) => item.legacyKnowledgeGraphWorkflow,
  );
  const customPredecessorHooks = inspectedHooks.filter(
    (item) => item.possibleCustomPredecessorActivation,
  );
  const preexistingGraphEntries = await inspectPreexistingGraph(
    graph.resolvedGraphPath,
  );
  const recognizedExistingGraph =
    existingConfig && preexistingGraphEntries.length > 0
      ? await isRecognizedSyncoraGraph(workspace, graph, options)
      : false;
  const graphRequiresAdoption =
    preexistingGraphEntries.length > 0 && !recognizedExistingGraph;
  if (
    graphRequiresAdoption ||
    (legacyHooks.length > 0 && !options.patchAgents) ||
    (
      customPredecessorHooks.length > 0 &&
      options.patchAgents
    )
  ) {
    const customPredecessorReviewRequired =
      customPredecessorHooks.length > 0 &&
      options.patchAgents;
    throw new SyncoraError(
      "MIGRATE015",
      graphRequiresAdoption
        ? "Existing knowledge requires the reversible adoption workflow; greenfield setup will not modify this workspace."
        : customPredecessorReviewRequired
          ? "Possible custom predecessor activation remains outside the exact predecessor block and must be removed before setup can add Syncora instructions."
          : "A predecessor workflow can only be replaced when setup agent patching is enabled.",
      {
        graphEntries: preexistingGraphEntries.slice(0, 16),
        omittedGraphEntries: Math.max(0, preexistingGraphEntries.length - 16),
        predecessorAgentFiles: legacyHooks.map((item) => item.path),
        customPredecessorAgentFiles: customPredecessorHooks.map((item) => item.path),
        predecessorReviewConfirmed: options.confirmPredecessorReviewed === true,
        next: graphRequiresAdoption
          ? "Run syncora adopt with reviewed manifest, staged content, and shadow fixtures; validate the bounded preview internally, then rerun adopt with its digest to complete migration and retirement without another confirmation."
          : customPredecessorReviewRequired
            ? "Inspect every active agent instruction file, remove custom predecessor activation outside the exact predecessor block, then rerun syncora setup --confirm-predecessor-reviewed."
            : "Rerun syncora setup without --no-patch-agents so the exact predecessor marker can be replaced atomically.",
      },
    );
  }
  const replacePredecessorWorkflow = legacyHooks.length > 0;

  const configPath = join(workspace.realPath, ".syncora", "config.json");
  const config = JSON.parse(await template("config.json"));
  config.agentPatching.enabled = options.patchAgents;
  plans.push(
    await createIfMissing(
      configPath,
      `${JSON.stringify(config, null, 2)}\n`,
      ".syncora/config.json",
    ),
  );

  plans.push(
    await createIfMissing(
      join(workspace.realPath, ".syncora", ".gitignore"),
      await template("syncora.gitignore"),
      ".syncora/.gitignore",
    ),
  );

  plans.push(
    await createIfMissing(
      join(graph.resolvedGraphPath, ".syncora", ".gitignore"),
      "*\n!.gitignore\n",
      graph.external
        ? join(graph.resolvedGraphPath, ".syncora", ".gitignore")
        : portablePath(
            workspace.realPath,
            join(graph.resolvedGraphPath, ".syncora", ".gitignore"),
          ),
    ),
  );

  if (graph.nextLocalConfig) {
    const before = await readOptionalBuffer(graph.localConfigPath);
    plans.push(
      filePlan(
        graph.localConfigPath,
        before,
        Buffer.from(`${JSON.stringify(graph.nextLocalConfig, null, 2)}\n`, "utf8"),
        ".syncora/local.json",
      ),
    );
  }

  const indexPath = join(graph.resolvedGraphPath, "index.md");
  plans.push(
    await createIfMissing(
      indexPath,
      render(await template("index.md"), { date: today }),
      graph.external
        ? indexPath
        : portablePath(workspace.realPath, indexPath),
    ),
  );

  const hubPath = join(
    graph.resolvedGraphPath,
    "knowledge",
    "projects",
    "workspace.md",
  );
  plans.push(
    await createIfMissing(
      hubPath,
      render(await template("project-hub.md"), {
        date: today,
        workspace_name: workspaceName,
        workspace_summary_json: JSON.stringify(
          `Central project hub for ${workspaceName}.`,
        ),
      }),
      graph.external ? hubPath : portablePath(workspace.realPath, hubPath),
    ),
  );

  const directories = [
    join(graph.resolvedGraphPath, "knowledge", "concepts"),
    join(graph.resolvedGraphPath, "knowledge", "decisions"),
    join(graph.resolvedGraphPath, "knowledge", "projects"),
    join(graph.resolvedGraphPath, "knowledge", "references"),
    join(graph.resolvedGraphPath, "knowledge", "sessions"),
    join(graph.resolvedGraphPath, "inbox"),
  ];

  async function applyInitialization() {
    let patchPlans = [];
    if (options.patchAgents) {
      const patch = replacePredecessorWorkflow
        ? await planAgentMigrationCutover(workspace.realPath)
        : await planAgentPatch(workspace.realPath);
      patchPlans = patch.plans;
      plans.push(...patchPlans);
      warnings.push(...patch.warnings);
    }

    if (options.dryRun) return;
    if (patchPlans.length > 0) {
      await verifyAgentPatchPlans(workspace.realPath, patchPlans);
    }
    for (const directory of directories) {
      await mkdir(directory, { recursive: true });
    }
    await applyFilePlans(plans);
  }

  await applyInitialization();

  return {
    ok: true,
    command: "init",
    workspace: workspace.realPath,
    graphRoot: graph.resolvedGraphPath,
    externalGraphRoot: graph.external,
    dryRun: options.dryRun,
    changes: plans.map((item) => describePlan(item, workspace.realPath)),
    warnings,
  };
}

export async function initializeWorkspace(options) {
  const workspace = await resolveWorkspace(options.workspace);
  const graph = await resolveGraphContext(workspace, {
    allowExternalGraphRoot: options.allowExternalGraphRoot,
  });
  const lockRoots = Object.freeze({
    workspacePath: workspace.realPath,
    graphRoot: graph.resolvedGraphPath,
  });
  const operation = () => initializeWorkspaceUnlocked(options, lockRoots);

  const graphMetadata = await metadataIfPresent(graph.resolvedGraphPath);
  const existingConfig = await readSyncoraConfigIfPresent(workspace.realPath);
  if (!existingConfig) {
    if (options.dryRun) {
      // An uninitialized preview must not create lock infrastructure. It has
      // no governed canonical state yet, and the planner performs no writes.
      return initializeWorkspaceUnlocked(options);
    }

    // Refuse legacy authority before acquiring locks can create operational
    // directories. A successful plan is rebuilt under the applicable lock.
    await initializeWorkspaceUnlocked({ ...options, dryRun: true });
  }
  if (graphMetadata === null) {
    if (options.dryRun) {
      // A greenfield preview must not create either lock root or any Syncora
      // state. There is no canonical graph to serialize yet.
      return initializeWorkspaceUnlocked(options);
    }

    // A greenfield internal graph has no canonical state or graph lock root to
    // serialize yet. Preserve dry-run purity; for a real setup, hold the
    // workspace lock and prove the graph is still absent before creating it.
    return withPatchLock(workspace.realPath, async () => {
      if (await metadataIfPresent(graph.resolvedGraphPath) !== null) {
        throw new SyncoraError(
          "WRITE007",
          "Graph root appeared while greenfield setup was acquiring its workspace lock; rerun setup so both roots can be locked.",
        );
      }
      return initializeWorkspaceUnlocked(options);
    });
  }

  // Setup touches both workspace state/agent files and canonical graph files.
  // Acquire graph then workspace, including previews, so setup cannot
  // observe or create a mixed state while a governed transaction is active.
  return withMigrationLocks(lockRoots, operation);
}
