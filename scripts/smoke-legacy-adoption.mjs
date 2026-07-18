import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceSkillRoot = path.join(repositoryRoot, "skills", "syncora");
const temporaryRoot = await realpath(os.tmpdir());
const sandbox = await mkdtemp(path.join(temporaryRoot, "syncora-adoption-smoke-"));
const installedSkillRoot = path.join(sandbox, "installed", "syncora");
const runtime = path.join(installedSkillRoot, "scripts", "syncora.mjs");
const workspace = path.join(sandbox, "workspace");
const graph = path.join(workspace, "local");
const stagedContent = path.join(sandbox, "reviewed-targets");
const manifestPath = path.join(sandbox, "authority-manifest.json");
const fixturesPath = path.join(sandbox, "shadow-fixtures.json");
const bundlePath = path.join(sandbox, "adoption-bundle-v1.json");
const migrationId = "installed-copy-adoption";

function taggedHash(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function write(target, bytes) {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes);
}

function runRuntime(arguments_) {
  const result = spawnSync(process.execPath, [runtime, ...arguments_, "--format", "json"], {
    cwd: workspace,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const output = [result.error?.message, result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();
    throw new Error(
      `${process.execPath} ${runtime} ${arguments_.join(" ")} failed with status ${result.status}${output ? `\n${output}` : ""}`,
    );
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`Syncora returned invalid JSON for ${arguments_.join(" ")}: ${error.message}`);
  }
}

function migrationArguments(phase, extra = []) {
  return [
    "migrate",
    "--phase",
    phase,
    "--migration-id",
    migrationId,
    "--workspace",
    workspace,
    ...extra,
  ];
}

function sourceReference(source) {
  return {
    path: source.source.path,
    expectedSha256: source.source.sha256,
  };
}

function sourceRefText(reference) {
  return `${reference.path}@${reference.expectedSha256}`;
}

function stagedNote(target, title, body) {
  return Buffer.from([
    "---",
    `id: ${target.id}`,
    `kind: ${target.kind}`,
    `scope: ${target.scope}`,
    `state: ${target.state}`,
    `authority: ${target.authority}`,
    `schema_version: ${target.schemaVersion}`,
    `created: ${target.created}`,
    `updated: ${target.updated}`,
    `summary: ${JSON.stringify(target.summary)}`,
    ...(target.decisionKey === null ? [] : [`decision_key: ${target.decisionKey}`]),
    `supersedes: ${target.supersedes.length === 0 ? "[]" : ""}`,
    ...target.supersedes.map((item) => `  - ${JSON.stringify(item)}`),
    `superseded_by: ${target.supersededBy.length === 0 ? "[]" : ""}`,
    ...target.supersededBy.map((item) => `  - ${JSON.stringify(item)}`),
    `applies_to: ${target.appliesTo.length === 0 ? "[]" : ""}`,
    ...target.appliesTo.map((item) => `  - ${JSON.stringify(item)}`),
    "source_refs:",
    ...target.sourceRefs.map((item) => `  - ${JSON.stringify(sourceRefText(item))}`),
    "---",
    "",
    `# ${title}`,
    "",
    body,
    "",
  ].join("\n"), "utf8");
}

function target(values) {
  return {
    path: values.path,
    expectedPriorSha256: values.expectedPriorSha256,
    id: values.id,
    kind: values.kind,
    scope: "workspace",
    state: values.state,
    authority: "canonical",
    schemaVersion: 1,
    created: "2026-07-16",
    updated: "2026-07-16",
    summary: values.summary,
    decisionKey: values.decisionKey ?? null,
    supersedes: [],
    supersededBy: [],
    appliesTo: [],
    sourceRefs: values.sourceRefs,
  };
}

try {
  await mkdir(path.dirname(installedSkillRoot), { recursive: true });
  await cp(sourceSkillRoot, installedSkillRoot, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  await access(runtime);

  const legacyAtlas = Buffer.from("# Legacy atlas\n\nOld routing instructions.\n", "utf8");
  const legacyNote = Buffer.from("# Authentication notes\n\nUse short-lived tokens.\n", "utf8");
  const legacyAgents = Buffer.from([
    "# Custom preface",
    "",
    "<!-- BEGIN KNOWLEDGE GRAPH WORKFLOW -->",
    "## Required Skill",
    "Always load the entire old knowledge graph.",
    "<!-- END KNOWLEDGE GRAPH WORKFLOW -->",
    "",
    "# Custom suffix",
    "",
  ].join("\n"), "utf8");
  await write(path.join(graph, "index.md"), legacyAtlas);
  await write(path.join(graph, "notes.md"), legacyNote);
  await write(path.join(workspace, "AGENTS.md"), legacyAgents);

  const inventory = runRuntime([
    "migrate",
    "--phase",
    "authority",
    "--dry-run",
    "--limit",
    "100",
    "--workspace",
    workspace,
  ]);
  assert.equal(inventory.page.complete, true);
  const queue = new Map(inventory.queue.map((entry) => [entry.source.path, entry]));
  const atlasSource = sourceReference(queue.get("index.md"));
  const noteSource = sourceReference(queue.get("notes.md"));

  const targets = [
    target({
      path: "index.md",
      expectedPriorSha256: atlasSource.expectedSha256,
      id: "atlas-root",
      kind: "atlas",
      state: "active",
      summary: "Routes durable workspace context through one project hub.",
      sourceRefs: [atlasSource],
    }),
    target({
      path: "knowledge/projects/workspace.md",
      expectedPriorSha256: null,
      id: "project-workspace",
      kind: "project",
      state: "active",
      summary: "Central authority hub for the migrated workspace.",
      sourceRefs: [noteSource],
    }),
    target({
      path: "knowledge/decisions/auth.md",
      expectedPriorSha256: null,
      id: "decision-auth",
      kind: "decision",
      state: "accepted",
      summary: "Authentication uses short-lived tokens.",
      decisionKey: "authentication.tokens",
      sourceRefs: [noteSource],
    }),
  ];
  const targetBodies = [
    stagedNote(targets[0], "Local Knowledge Atlas", "- [[knowledge/projects/workspace]]"),
    stagedNote(targets[1], "Workspace", "## Accepted decisions\n\n- [[knowledge/decisions/auth]]"),
    stagedNote(targets[2], "Authentication Token Policy", "Use short-lived authentication tokens."),
  ];
  for (let index = 0; index < targets.length; index += 1) {
    targets[index].contentSha256 = taggedHash(targetBodies[index]);
    await write(
      path.join(stagedContent, ...targets[index].path.split("/")),
      targetBodies[index],
    );
  }

  const manifest = {
    manifestSchemaVersion: 2,
    kind: "syncora.authority-promotion",
    status: "reviewed",
    source: {
      inventorySpecification: inventory.planner.specification,
      validationSpecification: inventory.planner.validationSpecification,
      reportSchemaVersion: inventory.reportSchemaVersion,
      policyRevision: inventory.planner.policyRevision,
      rootIdentity: inventory.planner.rootIdentity,
      graphRevision: inventory.graph.revision,
    },
    review: {
      reviewedBy: "installed-copy-smoke",
      reviewedAt: "2026-07-16",
      reason: "Exercise reversible replacement of competing legacy authority.",
    },
    dispositions: [atlasSource, noteSource].map((source) => ({
      ...source,
      disposition: "promote-via-targets",
    })),
    operations: targets.map((target_, index) => ({
      operationId: `operation-${index + 1}`,
      sources: target_.sourceRefs,
      target: target_,
    })),
  };
  await write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await write(fixturesPath, `${JSON.stringify({
    schemaVersion: 1,
    kind: "syncora-shadow-fixtures-v1",
    cases: [
      {
        caseId: "authentication-context",
        scope: "workspace",
        query: "authentication token policy",
        budgetCharacters: 4_000,
        requiredIds: ["decision-auth"],
        evidenceIds: [],
        forbiddenIds: [],
      },
    ],
  }, null, 2)}\n`);
  const bundled = runRuntime([
    "bundle",
    "--workspace",
    workspace,
    "--migration-id",
    migrationId,
    "--manifest",
    manifestPath,
    "--staged-content",
    stagedContent,
    "--fixtures",
    fixturesPath,
    "--output",
    bundlePath,
  ]);
  assert.equal(bundled.command, "bundle");
  assert.equal(bundled.changed, true);
  assert.equal(bundled.stagedContent.targetCount, targets.length);

  const adopted = runRuntime([
    "adopt",
    "--workspace",
    workspace,
    "--bundle",
    bundlePath,
  ]);
  assert.equal(adopted.status, "retired");
  assert.deepEqual(adopted.summary.completedPhases, [
    "stage",
    "shadow",
    "cutover",
    "verify",
    "retire",
  ]);
  assert.equal(adopted.summary.rollbackRetained, true);
  const patchedAgents = await readFile(path.join(workspace, "AGENTS.md"), "utf8");
  assert.equal(patchedAgents.includes("BEGIN KNOWLEDGE GRAPH WORKFLOW"), false);
  assert.equal(patchedAgents.includes("syncora-agent-hook:begin v4"), true);
  assert.equal(patchedAgents.includes("# Custom preface"), true);

  const rolledBack = runRuntime(migrationArguments("rollback"));
  assert.equal(rolledBack.status, "rolled-back");
  assert.deepEqual(await readFile(path.join(graph, "index.md")), legacyAtlas);
  assert.deepEqual(await readFile(path.join(graph, "notes.md")), legacyNote);
  assert.deepEqual(await readFile(path.join(workspace, "AGENTS.md")), legacyAgents);
  await assert.rejects(readFile(path.join(graph, "knowledge", "projects", "workspace.md")));
  await assert.rejects(readFile(path.join(graph, "knowledge", "decisions", "auth.md")));
  await assert.rejects(readFile(path.join(workspace, ".syncora", "config.json")));

  console.log("Installed-copy legacy adoption smoke test passed.");
} finally {
  const resolvedSandbox = await realpath(sandbox).catch(() => sandbox);
  const relativeSandbox = path.relative(temporaryRoot, resolvedSandbox);
  if (relativeSandbox && relativeSandbox !== ".." && !relativeSandbox.startsWith(`..${path.sep}`)) {
    await rm(resolvedSandbox, { recursive: true, force: true });
  } else {
    console.error(`Refusing to remove unexpected smoke-test path: ${resolvedSandbox}`);
  }
}
