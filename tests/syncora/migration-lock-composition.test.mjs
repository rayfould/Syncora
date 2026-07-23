import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { inspectAuthoritySnapshot } from "../../skills/syncora/scripts/lib/authority-inventory.mjs";
import {
  cutoverMigration,
  retireMigration,
  rollbackMigration,
  verifyMigration,
} from "../../skills/syncora/scripts/lib/migration-adoption.mjs";
import {
  resolveMigrationLockRoots,
  withMigrationLocks,
} from "../../skills/syncora/scripts/lib/migration-lock.mjs";
import { shadowMigration } from "../../skills/syncora/scripts/lib/migration-shadow.mjs";
import { stageMigration } from "../../skills/syncora/scripts/lib/migration-stage.mjs";

function taggedSha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function write(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}

function canonicalNote(target, title, body) {
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
    "supersedes: []",
    "superseded_by: []",
    "applies_to: []",
    "source_refs:",
    ...target.sourceRefs.map(
      (source) => `  - ${JSON.stringify(`${source.path}@${source.expectedSha256}`)}`,
    ),
    "---",
    "",
    `# ${title}`,
    "",
    body,
    "",
  ].join("\n"), "utf8");
}

async function lifecycleFixture() {
  const workspace = await realpath(
    await mkdtemp(join(tmpdir(), "syncora-lock-composition-")),
  );
  const graph = join(workspace, "local");
  const pack = join(workspace, "review");
  const stagedContent = join(pack, "staged-content");
  const manifest = join(pack, "authority-promotion-manifest-v2.json");
  const fixtures = join(pack, "shadow-fixtures-v1.json");
  const legacyAtlas = Buffer.from("# Legacy atlas\n\nOld routing authority.\n", "utf8");
  await write(join(graph, "index.md"), legacyAtlas);
  await write(join(workspace, "AGENTS.md"), Buffer.from([
    "# Custom instructions",
    "",
    "<!-- BEGIN KNOWLEDGE GRAPH WORKFLOW -->",
    "Always load the entire predecessor graph.",
    "<!-- END KNOWLEDGE GRAPH WORKFLOW -->",
    "",
  ].join("\n"), "utf8"));

  const snapshot = await inspectAuthoritySnapshot({ workspace });
  const source = snapshot.queue.find((entry) => entry.source.path === "index.md").source;
  const sourceRef = { path: source.path, expectedSha256: source.sha256 };
  const atlasTarget = {
    path: "index.md",
    expectedPriorSha256: source.sha256,
    id: "atlas-root",
    kind: "atlas",
    scope: "workspace",
    state: "active",
    authority: "canonical",
    schemaVersion: 1,
    created: "2026-07-16",
    updated: "2026-07-16",
    summary: "Routes durable workspace context through one canonical atlas.",
    decisionKey: null,
    supersedes: [],
    supersededBy: [],
    appliesTo: [],
    sourceRefs: [sourceRef],
  };
  const projectTarget = {
    ...atlasTarget,
    path: "knowledge/projects/workspace.md",
    expectedPriorSha256: null,
    id: "project-workspace",
    kind: "project",
    summary: "Central authority hub for the migrated workspace.",
  };
  const targets = [atlasTarget, projectTarget];
  const targetBytes = [
    canonicalNote(
      atlasTarget,
      "Local Knowledge Atlas",
      "- [[knowledge/projects/workspace]]",
    ),
    canonicalNote(
      projectTarget,
      "Workspace",
      "Central authority hub for the migrated workspace.",
    ),
  ];
  for (let index = 0; index < targets.length; index += 1) {
    targets[index].contentSha256 = taggedSha256(targetBytes[index]);
    await write(
      join(stagedContent, ...targets[index].path.split("/")),
      targetBytes[index],
    );
  }

  const manifestBytes = Buffer.from(`${JSON.stringify({
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
      reviewedBy: "migration-lock-test",
      reviewedAt: "2026-07-16",
      reason: "Exercise one-lock lifecycle composition.",
    },
    dispositions: [{
      path: source.path,
      expectedSha256: source.sha256,
      disposition: "promote-via-targets",
    }],
    operations: targets.map((target, index) => ({
      operationId: `promote-${index + 1}`,
      sources: [sourceRef],
      target,
    })),
  }, null, 2)}\n`, "utf8");
  const fixtureBytes = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    kind: "syncora-shadow-fixtures-v1",
    cases: [{
      caseId: "atlas-context",
      scope: "workspace",
      query: "canonical local knowledge atlas",
      budgetCharacters: 4_000,
      requiredIds: [],
      evidenceIds: [],
      forbiddenIds: [],
    }],
  }, null, 2)}\n`, "utf8");
  await write(manifest, manifestBytes);
  await write(fixtures, fixtureBytes);

  return {
    workspace,
    graph,
    stagedContent,
    manifest,
    fixtures,
    manifestSha256: taggedSha256(manifestBytes),
    fixturesSha256: taggedSha256(fixtureBytes),
    expectedTargets: targets.map((target, index) => ({
      path: target.path,
      contentSha256: target.contentSha256,
      byteLength: targetBytes[index].length,
    })),
  };
}

function capabilityError(error) {
  return error?.code === "MIGRATE007" && /lock (capability|roots)/.test(error.message);
}

test("one unforgeable outer-lock capability composes the full lifecycle", async () => {
  const fixture = await lifecycleFixture();
  const common = {
    workspace: fixture.workspace,
    migrationId: "outer-lock-lifecycle",
    allowExternalGraphRoot: undefined,
    dryRun: false,
  };
  const lockRoots = await resolveMigrationLockRoots(common);
  const stageOptions = {
    ...common,
    manifest: fixture.manifest,
    stagedContent: fixture.stagedContent,
    expectedManifestSha256: fixture.manifestSha256,
    expectedTargets: fixture.expectedTargets,
  };
  const shadowOptions = {
    ...common,
    fixtures: fixture.fixtures,
    expectedFixturesSha256: fixture.fixturesSha256,
  };

  try {
    await assert.rejects(
      stageMigration(stageOptions, { lockRoots }),
      capabilityError,
    );
    await assert.rejects(
      stageMigration(stageOptions, { lockCapability: {} }),
      capabilityError,
    );

    let expiredCapability;
    const statuses = await withMigrationLocks(lockRoots, async (lockCapability) => {
      expiredCapability = lockCapability;
      await assert.rejects(
        stageMigration(stageOptions, { lockCapability: {} }),
        capabilityError,
      );
      await assert.rejects(
        stageMigration({
          ...stageOptions,
          expectedManifestSha256: `sha256:${"0".repeat(64)}`,
        }, { lockCapability }),
        (error) => error?.code === "MIGRATE016" && /manifest bytes/.test(error.message),
      );
      await assert.rejects(
        stageMigration({
          ...stageOptions,
          expectedTargets: [{
            ...fixture.expectedTargets[0],
            byteLength: fixture.expectedTargets[0].byteLength + 1,
          }],
        }, { lockCapability }),
        (error) => error?.code === "MIGRATE016" && /target/.test(error.message),
      );
      const staged = await stageMigration(stageOptions, { lockCapability });

      await assert.rejects(
        shadowMigration(shadowOptions, { lockCapability: {} }),
        capabilityError,
      );
      await assert.rejects(
        shadowMigration({
          ...shadowOptions,
          expectedFixturesSha256: `sha256:${"f".repeat(64)}`,
        }, { lockCapability }),
        (error) => error?.code === "MIGRATE016" && /fixture bytes/.test(error.message),
      );
      const shadowed = await shadowMigration(shadowOptions, { lockCapability });
      assert.equal(shadowed.ok, true, JSON.stringify(shadowed.summary));

      const cutover = await cutoverMigration(common, { lockCapability });

      const verified = await verifyMigration(common, { lockCapability });

      const retired = await retireMigration(common, { lockCapability });

      const rolledBack = await rollbackMigration(common, { lockCapability });
      return [staged, shadowed, cutover, verified, retired, rolledBack]
        .map((result) => result.status);
    });

    await assert.rejects(
      stageMigration(stageOptions, { lockCapability: expiredCapability }),
      capabilityError,
    );

    assert.deepEqual(statuses, [
      "staged",
      "shadow-verified",
      "cutover-applied",
      "verified",
      "retired",
      "rolled-back",
    ]);
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});
