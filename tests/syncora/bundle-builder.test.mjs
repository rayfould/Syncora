import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  buildAdoptionBundle,
  loadAndValidateAdoptionBundle,
} from "../../skills/syncora/scripts/lib/adoption-bundle.mjs";
import { inspectAuthoritySnapshot } from "../../skills/syncora/scripts/lib/authority-inventory.mjs";

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
  return Buffer.from([
    "---",
    `id: ${target.id}`,
    `kind: ${target.kind}`,
    "scope: workspace",
    `state: ${target.state}`,
    "authority: canonical",
    "schema_version: 1",
    "created: 2026-07-16",
    "updated: 2026-07-16",
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

async function builderFixture() {
  const workspace = await realpath(
    await mkdtemp(join(tmpdir(), "syncora-bundle-builder-")),
  );
  const graph = join(workspace, "local");
  const pack = join(workspace, "review");
  const stagedContent = join(pack, "staged-content");
  const manifest = join(pack, "authority-promotion-manifest-v2.json");
  const fixtures = join(pack, "shadow-fixtures-v1.json");
  const output = join(pack, "adoption-bundle-v1.json");
  await write(join(graph, "index.md"), "# Legacy atlas\n\nOld routing.\n");
  await write(join(graph, "notes.md"), "# Authentication\n\nUse short-lived tokens.\n");

  const snapshot = await inspectAuthoritySnapshot({ workspace });
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
  const bodies = [
    stagedNote(targets[0], "Local Knowledge Atlas", "- [[knowledge/projects/workspace]]"),
    stagedNote(targets[1], "Workspace", "## Accepted decisions\n\n- [[knowledge/decisions/auth]]"),
    stagedNote(targets[2], "Authentication Token Policy", "Use short-lived authentication tokens."),
  ];
  for (let index = 0; index < targets.length; index += 1) {
    targets[index].contentSha256 = taggedHash(bodies[index]);
    await write(join(stagedContent, ...targets[index].path.split("/")), bodies[index]);
  }
  await writeFile(manifest, `${JSON.stringify({
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
      reviewedBy: "bundle-builder-test",
      reviewedAt: "2026-07-16",
      reason: "Bind the reviewed migration pack for one-command adoption.",
    },
    dispositions: [atlasSource, noteSource].map((source) => ({
      path: source.path,
      expectedSha256: source.expectedSha256,
      disposition: "promote-via-targets",
    })),
    operations: targets.map((item, index) => ({
      operationId: `operation-${index + 1}`,
      sources: item.sourceRefs,
      target: item,
    })),
  }, null, 2)}\n`);
  await writeFile(fixtures, `${JSON.stringify({
    schemaVersion: 1,
    kind: "syncora-shadow-fixtures-v1",
    cases: [{
      caseId: "authentication-context",
      scope: "workspace",
      query: "authentication token policy",
      budgetCharacters: 4_000,
      requiredIds: ["decision-auth"],
      evidenceIds: [],
      forbiddenIds: [],
    }],
  }, null, 2)}\n`);
  return {
    workspace,
    pack,
    stagedContent,
    manifest,
    fixtures,
    output,
    options: {
      workspace,
      migrationId: "legacy-adoption",
      manifest,
      stagedContent,
      fixtures,
      output,
      dryRun: false,
    },
  };
}

test("bundle builder dry-runs, publishes once, and reruns idempotently", async () => {
  const fixture = await builderFixture();
  try {
    const preview = await buildAdoptionBundle({ ...fixture.options, dryRun: true });
    assert.equal(preview.changed, true);
    await assert.rejects(access(fixture.output), (error) => error?.code === "ENOENT");

    const created = await buildAdoptionBundle(fixture.options);
    const firstBytes = await readFile(fixture.output);
    assert.equal(created.changed, true);
    assert.equal(created.stagedContent.targetCount, 3);
    assert.equal(created.fixtures.caseCount, 1);
    const loaded = await loadAndValidateAdoptionBundle(fixture.output);
    assert.equal(loaded.migrationId, "legacy-adoption");
    assert.equal(loaded.stagedContent.targetCount, 3);

    const repeated = await buildAdoptionBundle(fixture.options);
    assert.equal(repeated.changed, false);
    assert.deepEqual(await readFile(fixture.output), firstBytes);
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

test("bundle builder refuses to overwrite a different descriptor", async () => {
  const fixture = await builderFixture();
  try {
    const existing = Buffer.from("{\"owned\":true}\n", "utf8");
    await writeFile(fixture.output, existing);
    await assert.rejects(
      buildAdoptionBundle(fixture.options),
      (error) => error?.code === "MIGRATE016" && /refusing to overwrite/i.test(error.message),
    );
    assert.deepEqual(await readFile(fixture.output), existing);
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

test("bundle builder requires every source artifact beneath the descriptor directory", async () => {
  const fixture = await builderFixture();
  try {
    const outsideFixtures = join(fixture.workspace, "outside-fixtures.json");
    await writeFile(outsideFixtures, await readFile(fixture.fixtures));
    await assert.rejects(
      buildAdoptionBundle({ ...fixture.options, fixtures: outsideFixtures }),
      (error) => error?.code === "MIGRATE016" && /contained beneath/i.test(error.message),
    );
    await assert.rejects(access(fixture.output), (error) => error?.code === "ENOENT");
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

test("bundle builder validates full fixtures and exact staged target bytes", async (t) => {
  await t.test("fixture contract", async () => {
    const fixture = await builderFixture();
    try {
      await writeFile(fixture.fixtures, JSON.stringify({
        schemaVersion: 1,
        kind: "syncora-shadow-fixtures-v1",
        cases: [{ caseId: "incomplete", query: "missing required fields" }],
      }));
      await assert.rejects(
        buildAdoptionBundle(fixture.options),
        (error) => error?.code === "MIGRATE016" && /invalid context case/i.test(error.message),
      );
    } finally {
      await rm(fixture.workspace, { recursive: true, force: true });
    }
  });

  await t.test("target binding", async () => {
    const fixture = await builderFixture();
    try {
      await writeFile(join(fixture.stagedContent, "index.md"), "# Changed\n");
      await assert.rejects(
        buildAdoptionBundle(fixture.options),
        (error) => error?.code === "MIGRATE016" && /do not match the reviewed manifest/i.test(error.message),
      );
    } finally {
      await rm(fixture.workspace, { recursive: true, force: true });
    }
  });
});

test("bundle builder rejects source mutation before atomic publication", async () => {
  const fixture = await builderFixture();
  try {
    await assert.rejects(
      buildAdoptionBundle(fixture.options, {
        beforePublish: async () => {
          await writeFile(fixture.fixtures, `${await readFile(fixture.fixtures, "utf8")} `);
        },
      }),
      (error) => error?.code === "MIGRATE016" && /changed during validation/i.test(error.message),
    );
    await assert.rejects(access(fixture.output), (error) => error?.code === "ENOENT");
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});
