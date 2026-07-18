import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { adoptWorkspace } from "../../skills/syncora/scripts/lib/adopt.mjs";
import { SyncoraError } from "../../skills/syncora/scripts/lib/cli.mjs";
import {
  cutoverMigration,
  migrationStatus,
  retireMigration,
  rollbackMigration,
  verifyMigration,
} from "../../skills/syncora/scripts/lib/migration-adoption.mjs";
import { inspectAuthoritySnapshot } from "../../skills/syncora/scripts/lib/authority-inventory.mjs";
import { shadowMigration } from "../../skills/syncora/scripts/lib/migration-shadow.mjs";
import { stageMigration } from "../../skills/syncora/scripts/lib/migration-stage.mjs";
import { inspectWorkspace } from "../../skills/syncora/scripts/lib/validate.mjs";

function adoptionLifecycle(overrides = {}) {
  return {
    status: migrationStatus,
    stage: stageMigration,
    shadow: shadowMigration,
    cutover: cutoverMigration,
    verify: verifyMigration,
    retire: retireMigration,
    rollback: rollbackMigration,
    ...overrides,
  };
}

function taggedHash(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function write(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}

function sourceRef(reference) {
  return `${reference.path}@${reference.expectedSha256}`;
}

function stagedNote(target, title, body) {
  const lines = [
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
    ...target.sourceRefs.map((item) => `  - ${JSON.stringify(sourceRef(item))}`),
    "---",
    "",
    `# ${title}`,
    "",
    body,
    "",
  ];
  return Buffer.from(lines.join("\n"), "utf8");
}

function targetBase(values) {
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

async function writeAdoptionDescriptor({
  descriptorPath,
  migrationId,
  manifestPath,
  fixturesPath,
  targets,
  bodies,
}) {
  const [manifestBytes, fixtureBytes] = await Promise.all([
    readFile(manifestPath),
    readFile(fixturesPath),
  ]);
  const targetBindings = targets
    .map((target, index) => ({
      path: target.path,
      sha256: taggedHash(bodies[index]),
      byteLength: bodies[index].length,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const descriptor = {
    schemaVersion: 1,
    kind: "syncora-adoption-bundle-v1",
    migrationId,
    manifest: {
      path: "authority-promotion-manifest-v2.json",
      sha256: taggedHash(manifestBytes),
    },
    stagedContent: {
      root: "staged-content",
      targetCount: targetBindings.length,
      totalBytes: targetBindings.reduce((sum, item) => sum + item.byteLength, 0),
      targets: targetBindings,
    },
    fixtures: {
      path: "shadow-fixtures-v1.json",
      sha256: taggedHash(fixtureBytes),
    },
  };
  await writeFile(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);
}

async function adoptionFixture({
  predecessorWorkflow = true,
  migrationId = "legacy-adoption",
  externalGraph = false,
} = {}) {
  const workspace = await mkdtemp(join(tmpdir(), "syncora-adoption-"));
  const graph = externalGraph
    ? await mkdtemp(join(tmpdir(), "syncora-adoption-graph-"))
    : join(workspace, "local");
  if (externalGraph) {
    await symlink(
      graph,
      join(workspace, "local"),
      process.platform === "win32" ? "junction" : "dir",
    );
  }
  const pack = join(workspace, "review");
  const staged = join(pack, "staged-content");
  const manifestPath = join(pack, "authority-promotion-manifest-v2.json");
  const fixturesPath = join(pack, "shadow-fixtures-v1.json");
  const descriptorPath = join(pack, "adoption-bundle-v1.json");
  const legacyAtlas = Buffer.from("# Legacy atlas\n\nOld routing instructions.\n", "utf8");
  const legacyNote = Buffer.from("# Authentication notes\n\nUse short-lived tokens.\n", "utf8");
  const legacyAgents = Buffer.from(
    (predecessorWorkflow
      ? [
          "# Custom preface",
          "",
          "<!-- BEGIN KNOWLEDGE GRAPH WORKFLOW -->",
          "## Required Skill",
          "Always load the entire old knowledge graph.",
          "<!-- END KNOWLEDGE GRAPH WORKFLOW -->",
          "",
          "# Custom suffix",
          "",
        ]
      : [
          "# Reviewed custom instructions",
          "",
          "Keep project-specific formatting conventions.",
          "",
        ]).join("\n"),
    "utf8",
  );
  await write(join(graph, "index.md"), legacyAtlas);
  await write(join(graph, "notes.md"), legacyNote);
  await write(join(workspace, "AGENTS.md"), legacyAgents);

  const snapshot = await inspectAuthoritySnapshot({
    workspace,
    allowExternalGraphRoot: externalGraph ? graph : undefined,
  });
  const queue = new Map(snapshot.queue.map((entry) => [entry.source.path, entry]));
  const atlasSource = {
    path: "index.md",
    expectedSha256: queue.get("index.md").source.sha256,
  };
  const noteSource = {
    path: "notes.md",
    expectedSha256: queue.get("notes.md").source.sha256,
  };
  const targets = [
    targetBase({
      path: "index.md",
      expectedPriorSha256: atlasSource.expectedSha256,
      id: "atlas-root",
      kind: "atlas",
      state: "active",
      summary: "Routes durable workspace context through one project hub.",
      sourceRefs: [atlasSource],
    }),
    targetBase({
      path: "knowledge/projects/workspace.md",
      expectedPriorSha256: null,
      id: "project-workspace",
      kind: "project",
      state: "active",
      summary: "Central authority hub for the migrated workspace.",
      sourceRefs: [noteSource],
    }),
    targetBase({
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
  const bodies = [
    stagedNote(targets[0], "Local Knowledge Atlas", "- [[knowledge/projects/workspace]]"),
    stagedNote(targets[1], "Workspace", "## Accepted decisions\n\n- [[knowledge/decisions/auth]]"),
    stagedNote(targets[2], "Authentication Token Policy", "Use short-lived authentication tokens."),
  ];
  targets.forEach((target, index) => {
    target.contentSha256 = taggedHash(bodies[index]);
  });
  for (let index = 0; index < targets.length; index += 1) {
    await write(join(staged, ...targets[index].path.split("/")), bodies[index]);
  }
  const operations = targets.map((target, index) => ({
    operationId: `operation-${index + 1}`,
    sources: target.sourceRefs,
    target,
  }));
  const manifest = {
    manifestSchemaVersion: 2,
    kind: "syncora.authority-promotion",
    status: "reviewed",
    source: {
      inventorySpecification: "syncora-authority-inventory-v1",
      validationSpecification: "syncora-validation-v1",
      reportSchemaVersion: 1,
      policyRevision: snapshot.bindings.policyRevision,
      rootIdentity: snapshot.bindings.rootIdentity,
      graphRevision: snapshot.bindings.graphRevision,
    },
    review: {
      reviewedBy: "migration-test",
      reviewedAt: "2026-07-16",
      reason: "Replace competing legacy authority with one reviewed hub.",
    },
    dispositions: [atlasSource, noteSource].map((source) => ({
      path: source.path,
      expectedSha256: source.expectedSha256,
      disposition: "promote-via-targets",
    })),
    operations,
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(fixturesPath, `${JSON.stringify({
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
  await writeAdoptionDescriptor({
    descriptorPath,
    migrationId,
    manifestPath,
    fixturesPath,
    targets,
    bodies,
  });
  return {
    workspace,
    graph,
    pack,
    staged,
    manifestPath,
    fixturesPath,
    descriptorPath,
    migrationId,
    targets,
    bodies,
    legacyAtlas,
    legacyNote,
    legacyAgents,
    externalGraph,
  };
}

async function removeAdoptionFixture(fixture) {
  if (fixture.externalGraph) {
    await rm(join(fixture.workspace, "local"), { force: true }).catch(() => undefined);
  }
  await rm(fixture.workspace, { recursive: true, force: true });
  if (fixture.externalGraph) {
    await rm(fixture.graph, { recursive: true, force: true });
  }
}

test("one adopt command runs the reviewed lifecycle and safely resumes as idempotent", async () => {
  const fixture = await adoptionFixture({ migrationId: "one-command-adoption" });
  const options = {
    workspace: fixture.workspace,
    bundle: fixture.descriptorPath,
    allowExternalGraphRoot: undefined,
    confirmPredecessorReviewed: false,
  };
  try {
    const adopted = await adoptWorkspace(options);
    assert.equal(adopted.ok, true);
    assert.equal(adopted.status, "retired");
    assert.deepEqual(adopted.summary.completedPhases, [
      "stage",
      "shadow",
      "cutover",
      "verify",
      "retire",
    ]);
    assert.equal(adopted.summary.rollbackRetained, true);
    assert.equal(
      (await readFile(join(fixture.workspace, "AGENTS.md"), "utf8")).includes(
      "syncora-agent-hook:begin v3",
      ),
      true,
    );

    const resumed = await adoptWorkspace(options);
    assert.equal(resumed.status, "retired");
    assert.equal(resumed.summary.idempotent, true);
    assert.deepEqual(resumed.summary.completedPhases, []);
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

test("external-graph adoption persists the exact allowlist used after retirement", async (t) => {
  let fixture;
  try {
    fixture = await adoptionFixture({
      migrationId: "external-graph-adoption",
      externalGraph: true,
    });
  } catch (error) {
    if (["EPERM", "EACCES"].includes(error?.code)) {
      t.skip(`Directory links unavailable: ${error.message}`);
      return;
    }
    throw error;
  }
  const staleRoot = await mkdtemp(join(tmpdir(), "syncora-stale-graph-root-"));
  try {
    await write(
      join(fixture.workspace, ".syncora", "local.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        externalGraphRoots: [staleRoot],
      }, null, 2)}\n`,
    );

    const adopted = await adoptWorkspace({
      workspace: fixture.workspace,
      bundle: fixture.descriptorPath,
      allowExternalGraphRoot: fixture.graph,
      confirmPredecessorReviewed: false,
    });
    assert.equal(adopted.status, "retired");
    assert.deepEqual(
      JSON.parse(
        await readFile(join(fixture.workspace, ".syncora", "local.json"), "utf8"),
      ).externalGraphRoots,
      [fixture.graph],
    );

    const inspection = await inspectWorkspace({ workspace: fixture.workspace });
    assert.equal(inspection.report.ok, true);
    assert.equal(inspection.graph.resolvedGraphPath, fixture.graph);
  } finally {
    await removeAdoptionFixture(fixture);
    await rm(staleRoot, { recursive: true, force: true });
  }
});

test("one adopt command stops at a failed phase and resumes after the gate is fixed", async () => {
  const fixture = await adoptionFixture({ migrationId: "resumable-adoption" });
  const options = {
    workspace: fixture.workspace,
    bundle: fixture.descriptorPath,
    allowExternalGraphRoot: undefined,
    confirmPredecessorReviewed: false,
  };
  try {
    const fixtures = JSON.parse(await readFile(fixture.fixturesPath, "utf8"));
    fixtures.cases[0].requiredIds = ["missing-required-note"];
    await writeFile(fixture.fixturesPath, `${JSON.stringify(fixtures, null, 2)}\n`);
    await writeAdoptionDescriptor(fixture);

    await assert.rejects(
      adoptWorkspace(options),
      (error) =>
        error.code === "MIGRATE012" &&
        error.message.includes("Adoption stopped during shadow") &&
        error.details?.adoption?.phase === "shadow" &&
        error.details?.adoption?.currentStatus === "staged" &&
        JSON.stringify(error.details?.adoption?.completedPhases) ===
          JSON.stringify(["stage"]),
    );
    assert.equal((await migrationStatus({
      ...options,
      migrationId: fixture.migrationId,
    })).status, "staged");
    assert.deepEqual(await readFile(join(fixture.graph, "index.md")), fixture.legacyAtlas);
    assert.deepEqual(await readFile(join(fixture.workspace, "AGENTS.md")), fixture.legacyAgents);

    fixtures.cases[0].requiredIds = ["decision-auth"];
    await writeFile(fixture.fixturesPath, `${JSON.stringify(fixtures, null, 2)}\n`);
    await writeAdoptionDescriptor(fixture);
    const resumed = await adoptWorkspace(options);
    assert.equal(resumed.status, "retired");
    assert.deepEqual(resumed.summary.completedPhases, [
      "stage",
      "shadow",
      "cutover",
      "verify",
      "retire",
    ]);
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

test("adopt resumes a reviewed migration from cutover-applied without replaying earlier phases", async () => {
  const fixture = await adoptionFixture({ migrationId: "cutover-applied-resume" });
  const common = {
    workspace: fixture.workspace,
    migrationId: fixture.migrationId,
    allowExternalGraphRoot: undefined,
  };
  const options = {
    workspace: fixture.workspace,
    bundle: fixture.descriptorPath,
    allowExternalGraphRoot: undefined,
    confirmPredecessorReviewed: false,
  };
  try {
    await stageMigration({
      ...common,
      phase: "stage",
      manifest: fixture.manifestPath,
      stagedContent: fixture.staged,
      dryRun: false,
    });
    await shadowMigration({
      ...common,
      phase: "shadow",
      fixtures: fixture.fixturesPath,
      dryRun: false,
    });
    const cutover = await cutoverMigration({
      ...common,
      phase: "cutover",
      dryRun: false,
    });
    assert.equal(cutover.status, "cutover-applied");

    const resumed = await adoptWorkspace(options);
    assert.equal(resumed.status, "retired");
    assert.equal(resumed.summary.startedAt, "cutover-applied");
    assert.deepEqual(resumed.summary.completedPhases, ["verify", "retire"]);
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

test("adopt resumes after an unmarked predecessor is explicitly reviewed", async () => {
  const fixture = await adoptionFixture({
    predecessorWorkflow: false,
    migrationId: "reviewed-unmarked-predecessor",
  });
  const unconfirmed = {
    workspace: fixture.workspace,
    bundle: fixture.descriptorPath,
    allowExternalGraphRoot: undefined,
    confirmPredecessorReviewed: false,
  };
  try {
    await assert.rejects(
      adoptWorkspace(unconfirmed),
      (error) =>
        error.code === "MIGRATE013" &&
        /confirm-predecessor-reviewed/.test(error.message) &&
        error.details?.adoption?.currentStatus === "shadow-verified" &&
        JSON.stringify(error.details?.adoption?.completedPhases) ===
          JSON.stringify(["stage", "shadow"]),
    );
    assert.deepEqual(
      await readFile(join(fixture.workspace, "AGENTS.md")),
      fixture.legacyAgents,
    );

    const resumed = await adoptWorkspace({
      ...unconfirmed,
      confirmPredecessorReviewed: true,
    });
    assert.equal(resumed.status, "retired");
    assert.equal(resumed.summary.startedAt, "shadow-verified");
    assert.deepEqual(resumed.summary.completedPhases, [
      "cutover",
      "verify",
      "retire",
    ]);
    const patchedAgents = await readFile(
      join(fixture.workspace, "AGENTS.md"),
      "utf8",
    );
    assert.match(patchedAgents, /Reviewed custom instructions/);
    assert.match(patchedAgents, /syncora-agent-hook:begin v3/);
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

test("adopt refuses residual custom activation outside an exact predecessor block", async () => {
  const fixture = await adoptionFixture({
    migrationId: "mixed-predecessor-activation",
  });
  const agentsPath = join(fixture.workspace, "AGENTS.md");
  const mixedAgents = Buffer.concat([
    fixture.legacyAgents,
    Buffer.from("Always load local/index.md before every task.\n", "utf8"),
  ]);
  const options = {
    workspace: fixture.workspace,
    bundle: fixture.descriptorPath,
    allowExternalGraphRoot: undefined,
    confirmPredecessorReviewed: true,
  };
  try {
    await writeFile(agentsPath, mixedAgents);
    await assert.rejects(
      adoptWorkspace(options),
      (error) =>
        error.code === "MIGRATE013" &&
        /custom predecessor activation remains/.test(error.message) &&
        JSON.stringify(error.details?.cause?.customPredecessorAgentFiles) ===
          JSON.stringify(["AGENTS.md"]) &&
        error.details?.adoption?.currentStatus === "shadow-verified",
    );
    assert.deepEqual(await readFile(agentsPath), mixedAgents);

    await writeFile(agentsPath, fixture.legacyAgents);
    const resumed = await adoptWorkspace(options);
    assert.equal(resumed.status, "retired");
    assert.equal(resumed.summary.startedAt, "shadow-verified");
    const patched = await readFile(agentsPath, "utf8");
    assert.doesNotMatch(patched, /BEGIN KNOWLEDGE GRAPH WORKFLOW/);
    assert.doesNotMatch(patched, /Always load local\/index\.md/);
    assert.match(patched, /syncora-agent-hook:begin v3/);
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

test("a caught verification failure automatically restores exact pre-cutover bytes", async () => {
  const fixture = await adoptionFixture({ migrationId: "automatic-rollback" });
  const options = {
    workspace: fixture.workspace,
    bundle: fixture.descriptorPath,
    allowExternalGraphRoot: undefined,
    confirmPredecessorReviewed: false,
  };
  try {
    await assert.rejects(
      adoptWorkspace(options, adoptionLifecycle({
        verify: async () => {
          throw new SyncoraError("MIGRATE013", "Injected verification failure.");
        },
      })),
      (error) =>
        error.code === "MIGRATE013" &&
        error.details?.adoption?.automaticRollback?.status === "rolled-back",
    );
    assert.deepEqual(await readFile(join(fixture.graph, "index.md")), fixture.legacyAtlas);
    assert.deepEqual(await readFile(join(fixture.graph, "notes.md")), fixture.legacyNote);
    assert.deepEqual(await readFile(join(fixture.workspace, "AGENTS.md")), fixture.legacyAgents);
    await assert.rejects(readFile(join(fixture.workspace, ".syncora", "config.json")));
    assert.equal((await migrationStatus({
      ...options,
      migrationId: fixture.migrationId,
    })).status, "rolled-back");
    await assert.rejects(
      adoptWorkspace(options),
      (error) => error.code === "MIGRATE006" && /new migration ID/i.test(error.message),
    );
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

test("automatic rollback preserves a concurrent user edit and reports recovery required", async () => {
  const fixture = await adoptionFixture({ migrationId: "rollback-conflict" });
  const options = {
    workspace: fixture.workspace,
    bundle: fixture.descriptorPath,
    allowExternalGraphRoot: undefined,
    confirmPredecessorReviewed: false,
  };
  const concurrentEdit = Buffer.from("# Concurrent user edit\n", "utf8");
  try {
    await assert.rejects(
      adoptWorkspace(options, adoptionLifecycle({
        verify: async () => {
          await writeFile(join(fixture.workspace, "AGENTS.md"), concurrentEdit);
          throw new SyncoraError("MIGRATE013", "Injected verification conflict.");
        },
      })),
      (error) =>
        error.code === "MIGRATE017" &&
        error.details?.adoption?.recoveryRequired === true,
    );
    assert.deepEqual(
      await readFile(join(fixture.workspace, "AGENTS.md")),
      concurrentEdit,
    );
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

test("a retirement failure leaves verified state and the same command resumes retirement", async () => {
  const fixture = await adoptionFixture({ migrationId: "retirement-resume" });
  const options = {
    workspace: fixture.workspace,
    bundle: fixture.descriptorPath,
    allowExternalGraphRoot: undefined,
    confirmPredecessorReviewed: false,
  };
  try {
    await assert.rejects(
      adoptWorkspace(options, adoptionLifecycle({
        retire: async () => {
          throw new SyncoraError("MIGRATE014", "Injected retirement failure.");
        },
      })),
      (error) =>
        error.code === "MIGRATE014" &&
        error.details?.adoption?.currentStatus === "verified",
    );
    assert.equal((await migrationStatus({
      ...options,
      migrationId: fixture.migrationId,
    })).status, "verified");

    const resumed = await adoptWorkspace(options);
    assert.equal(resumed.status, "retired");
    assert.deepEqual(resumed.summary.completedPhases, ["retire"]);
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

test("legacy adoption stages, shadow-tests, atomically cuts over, verifies, retires, and rolls back", async () => {
  const fixture = await adoptionFixture();
  const common = {
    workspace: fixture.workspace,
    migrationId: "legacy-adoption",
    allowExternalGraphRoot: undefined,
  };
  try {
    const stagePreview = await stageMigration({
      ...common,
      phase: "stage",
      manifest: fixture.manifestPath,
      stagedContent: fixture.staged,
      dryRun: true,
    });
    assert.equal(stagePreview.status, "staged");
    await assert.rejects(access(join(fixture.graph, ".syncora")));

    const staged = await stageMigration({
      ...common,
      phase: "stage",
      manifest: fixture.manifestPath,
      stagedContent: fixture.staged,
      dryRun: false,
    });
    assert.equal(staged.summary.targets, 3);
    assert.deepEqual(await readFile(join(fixture.graph, "index.md")), fixture.legacyAtlas);
    assert.deepEqual(await readFile(join(fixture.workspace, "AGENTS.md")), fixture.legacyAgents);

    const shadow = await shadowMigration({
      ...common,
      phase: "shadow",
      fixtures: fixture.fixturesPath,
      dryRun: false,
    });
    assert.equal(shadow.ok, true);
    assert.equal(shadow.status, "shadow-verified");

    const cutoverPreview = await cutoverMigration({
      ...common,
      phase: "cutover",
      dryRun: true,
    });
    assert.equal(cutoverPreview.status, "shadow-verified");
    assert.deepEqual(await readFile(join(fixture.graph, "index.md")), fixture.legacyAtlas);

    const cutover = await cutoverMigration({
      ...common,
      phase: "cutover",
      dryRun: false,
    });
    assert.equal(cutover.status, "cutover-applied");
    const agents = await readFile(join(fixture.workspace, "AGENTS.md"), "utf8");
    assert.equal(agents.includes("BEGIN KNOWLEDGE GRAPH WORKFLOW"), false);
    assert.equal(agents.includes("syncora-agent-hook:begin v3"), true);
    assert.equal(agents.includes("# Custom preface"), true);
    assert.deepEqual(await readFile(join(fixture.graph, "notes.md")), fixture.legacyNote);
    assert.deepEqual(
      await readFile(join(
        fixture.graph,
        "archive",
        "migrations",
        common.migrationId,
        "index.md",
      )),
      fixture.legacyAtlas,
    );
    const activeInspection = await inspectWorkspace({
      workspace: fixture.workspace,
      allowExternalGraphRoot: undefined,
    });
    assert.equal(
      activeInspection.notes.some((note) =>
        note.path.startsWith("archive/migrations/")),
      false,
    );
    const cutoverStatePath = join(
      fixture.graph,
      ".syncora",
      "migrations",
      common.migrationId,
      "state.json",
    );
    const cutoverState = await readFile(cutoverStatePath);
    const repeatedCutover = await cutoverMigration({
      ...common,
      phase: "cutover",
      dryRun: false,
    });
    assert.equal(repeatedCutover.summary.idempotent, true);
    assert.deepEqual(await readFile(cutoverStatePath), cutoverState);

    const verified = await verifyMigration({
      ...common,
      phase: "verify",
      dryRun: false,
    });
    assert.equal(verified.status, "verified");
    const verifiedState = await readFile(cutoverStatePath);
    const repeatedVerify = await verifyMigration({
      ...common,
      phase: "verify",
      dryRun: false,
    });
    assert.equal(repeatedVerify.summary.idempotent, true);
    assert.deepEqual(await readFile(cutoverStatePath), verifiedState);
    const retired = await retireMigration({
      ...common,
      phase: "retire",
      dryRun: false,
    });
    assert.equal(retired.status, "retired");
    assert.equal(retired.summary.rollbackRetained, true);
    const retiredState = await readFile(cutoverStatePath);
    const repeatedRetire = await retireMigration({
      ...common,
      phase: "retire",
      dryRun: false,
    });
    assert.equal(repeatedRetire.summary.idempotent, true);
    assert.deepEqual(await readFile(cutoverStatePath), retiredState);
    assert.equal((await migrationStatus({ ...common, phase: "status", dryRun: false })).status, "retired");

    const rollbackPreview = await rollbackMigration({
      ...common,
      phase: "rollback",
      dryRun: true,
    });
    assert.ok(rollbackPreview.summary.pending > 0);
    const rolledBack = await rollbackMigration({
      ...common,
      phase: "rollback",
      dryRun: false,
    });
    assert.equal(rolledBack.status, "rolled-back");
    assert.deepEqual(await readFile(join(fixture.graph, "index.md")), fixture.legacyAtlas);
    assert.deepEqual(await readFile(join(fixture.graph, "notes.md")), fixture.legacyNote);
    assert.deepEqual(await readFile(join(fixture.workspace, "AGENTS.md")), fixture.legacyAgents);
    await assert.rejects(readFile(join(fixture.graph, "knowledge", "projects", "workspace.md")));
    await assert.rejects(readFile(join(fixture.graph, "knowledge", "decisions", "auth.md")));
    await assert.rejects(readFile(join(
      fixture.graph,
      "archive",
      "migrations",
      common.migrationId,
      "index.md",
    )));
    const rolledBackState = await readFile(cutoverStatePath);
    const repeatedRollback = await rollbackMigration({
      ...common,
      phase: "rollback",
      dryRun: false,
    });
    assert.equal(repeatedRollback.summary.idempotent, true);
    assert.deepEqual(await readFile(cutoverStatePath), rolledBackState);
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

test("rollback recovers an applied cutover whose final state publication was interrupted", async () => {
  const fixture = await adoptionFixture();
  const common = {
    workspace: fixture.workspace,
    migrationId: "interrupted-cutover",
    allowExternalGraphRoot: undefined,
  };
  const statePath = join(
    fixture.graph,
    ".syncora",
    "migrations",
    common.migrationId,
    "state.json",
  );
  try {
    await stageMigration({
      ...common,
      phase: "stage",
      manifest: fixture.manifestPath,
      stagedContent: fixture.staged,
      dryRun: false,
    });
    await shadowMigration({
      ...common,
      phase: "shadow",
      fixtures: fixture.fixturesPath,
      dryRun: false,
    });
    await cutoverMigration({ ...common, phase: "cutover", dryRun: false });

    // Model a process stop after the journaled records published but before the
    // cutover receipt/state pair became durable.
    const finalizedState = JSON.parse(await readFile(statePath, "utf8"));
    const preparedState = {
      ...finalizedState,
      status: "cutover-prepared",
      artifacts: {
        ...finalizedState.artifacts,
        recovery: null,
        cutoverReceipt: null,
        verification: null,
        retirement: null,
      },
    };
    await writeFile(statePath, `${JSON.stringify(preparedState, null, 2)}\n`);
    const rolledBack = await rollbackMigration({
      ...common,
      phase: "rollback",
      dryRun: false,
    });
    assert.equal(rolledBack.status, "rolled-back");
    assert.deepEqual(await readFile(join(fixture.graph, "index.md")), fixture.legacyAtlas);
    assert.deepEqual(await readFile(join(fixture.graph, "notes.md")), fixture.legacyNote);
    assert.deepEqual(await readFile(join(fixture.workspace, "AGENTS.md")), fixture.legacyAgents);
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

test("cutover without an exact predecessor marker requires a durable review attestation", async () => {
  const fixture = await adoptionFixture({ predecessorWorkflow: false });
  const common = {
    workspace: fixture.workspace,
    migrationId: "reviewed-predecessor",
    allowExternalGraphRoot: undefined,
  };
  try {
    await stageMigration({
      ...common,
      phase: "stage",
      manifest: fixture.manifestPath,
      stagedContent: fixture.staged,
      dryRun: false,
    });
    await shadowMigration({
      ...common,
      phase: "shadow",
      fixtures: fixture.fixturesPath,
      dryRun: false,
    });
    await assert.rejects(
      cutoverMigration({ ...common, phase: "cutover", dryRun: false }),
      (error) => error?.code === "MIGRATE013" && /confirm-predecessor-reviewed/.test(error.message),
    );
    assert.deepEqual(await readFile(join(fixture.workspace, "AGENTS.md")), fixture.legacyAgents);

    const cutover = await cutoverMigration({
      ...common,
      phase: "cutover",
      confirmPredecessorReviewed: true,
      dryRun: false,
    });
    assert.equal(cutover.summary.predecessorReview, "operator-confirmed-absent");
    const agents = await readFile(join(fixture.workspace, "AGENTS.md"), "utf8");
    assert.match(agents, /Reviewed custom instructions/);
    assert.match(agents, /syncora-agent-hook:begin v3/);
    await rollbackMigration({ ...common, phase: "rollback", dryRun: false });
    assert.deepEqual(await readFile(join(fixture.workspace, "AGENTS.md")), fixture.legacyAgents);
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});
