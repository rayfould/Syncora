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
  planAgentPatch,
  verifyAgentPatchPlans,
} from "./agent-patcher.mjs";
import { SyncoraError } from "./cli.mjs";
import { withPatchLock } from "./patch-lock.mjs";
import { inspectWorkspace } from "./validate.mjs";
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

export async function initializeWorkspace(options) {
  const workspace = await resolveWorkspace(options.workspace);
  const graph = await resolveGraphContext(workspace, {
    allowExternalGraphRoot: options.allowExternalGraphRoot,
  });
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
  const legacyHooks = (await inspectAgentHooks(workspace.realPath)).filter(
    (item) => item.legacyKnowledgeGraphWorkflow,
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
  if (legacyHooks.length > 0 || graphRequiresAdoption) {
    throw new SyncoraError(
      "MIGRATE015",
      "Existing knowledge or predecessor agent instructions require the reversible adoption workflow; normal init will not modify this workspace.",
      {
        graphEntries: preexistingGraphEntries.slice(0, 16),
        omittedGraphEntries: Math.max(0, preexistingGraphEntries.length - 16),
        predecessorAgentFiles: legacyHooks.map((item) => item.path),
        next: "Run syncora migrate --phase authority --dry-run, prepare a reviewed v2 manifest and staged target bundle, then continue with stage and shadow.",
      },
    );
  }

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
      const patch = await planAgentPatch(workspace.realPath);
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

  if (options.patchAgents && !options.dryRun) {
    await withPatchLock(workspace.realPath, applyInitialization);
  } else {
    await applyInitialization();
  }

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
