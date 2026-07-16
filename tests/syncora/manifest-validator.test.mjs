import assert from "node:assert/strict";
import {
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
import { fileURLToPath } from "node:url";

import {
  AUTHORITY_MANIFEST_POLICY,
  loadAndValidateAuthorityManifest,
} from "../../skills/syncora/scripts/lib/authority-manifest.mjs";
import {
  AUTHORITY_INVENTORY_POLICY,
  inspectAuthoritySnapshot,
} from "../../skills/syncora/scripts/lib/authority-inventory.mjs";
import {
  inspectWorkspace,
  VALIDATION_SPECIFICATION,
} from "../../skills/syncora/scripts/lib/validate.mjs";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(testDirectory, "..", "..");
const HASH_A = `sha256:${"a".repeat(64)}`;

async function temporaryWorkspace() {
  return realpath(await mkdtemp(join(tmpdir(), "syncora-manifest-")));
}

async function writeNote(workspace, path, content) {
  const destination = join(workspace, "local", ...path.split("/"));
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, content, "utf8");
  return destination;
}

function listField(name, values) {
  return `${name}:${values.length === 0 ? " []" : `\n${values.map((item) => `  - ${item}`).join("\n")}`}`;
}

function currentNote({
  id,
  kind = "concept",
  scope = "workspace",
  state = "active",
  authority = "canonical",
  created = "2026-07-15",
  updated = "2026-07-15",
  decisionKey = undefined,
  supersedes = [],
  supersededBy = [],
}) {
  return `---
id: ${id}
kind: ${kind}
scope: ${scope}
state: ${state}
authority: ${authority}
schema_version: 1
created: ${created}
updated: ${updated}
summary: ${JSON.stringify(`Summary for ${id}`)}
${decisionKey === undefined ? "" : `decision_key: ${decisionKey}`}
${listField("supersedes", supersedes)}
${listField("superseded_by", supersededBy)}
---

# ${id}
`;
}

async function manifestFor(workspace, options = {}) {
  const snapshot = await inspectAuthoritySnapshot({ workspace });
  const sources = snapshot.queue.filter(
    (entry) => entry.classification === "review-required",
  );
  const sourceRefs = sources.map((entry) => ({
    path: entry.source.path,
    expectedSha256: entry.source.sha256,
  }));
  const manifest = {
    manifestSchemaVersion: options.version ?? 2,
    kind: "syncora.authority-promotion",
    status: "reviewed",
    source: {
      inventorySpecification: AUTHORITY_INVENTORY_POLICY.specification,
      validationSpecification: VALIDATION_SPECIFICATION,
      reportSchemaVersion: 1,
      policyRevision: snapshot.bindings.policyRevision,
      rootIdentity: snapshot.bindings.rootIdentity,
      graphRevision: snapshot.bindings.graphRevision,
    },
    review: {
      reviewedBy: "fixture-reviewer",
      reviewedAt: "2026-07-16",
      reason: "Fixture review",
    },
    dispositions: sourceRefs.map((source) => ({
      ...source,
      disposition: "promote-via-targets",
    })),
    operations: [
      {
        operationId: "promote-workspace-hub",
        sources: sourceRefs,
        target: {
          path: "knowledge/projects/workspace.md",
          expectedPriorSha256: null,
          id: "project-workspace",
          kind: "project",
          scope: "workspace",
          state: "active",
          authority: "canonical",
          schemaVersion: 1,
          created: "2026-07-16",
          updated: "2026-07-16",
          summary: "Canonical workspace hub.",
          decisionKey: null,
          supersedes: [],
          supersededBy: [],
          appliesTo: [],
          contentSha256: HASH_A,
          sourceRefs: sourceRefs.map((source) => ({ ...source })),
        },
      },
    ],
  };
  if (manifest.manifestSchemaVersion === 1) {
    delete manifest.operations[0].target.contentSha256;
    delete manifest.operations[0].target.sourceRefs;
  }
  return manifest;
}

async function writeManifest(workspace, manifest, name = "promotion.json") {
  const path = join(workspace, name);
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return path;
}

test("actionable v2 manifest binds exact content and provenance without mutating the graph", async () => {
  const workspace = await temporaryWorkspace();
  try {
    const legacy = await writeNote(workspace, "legacy.md", "# Legacy workspace\n");
    const before = await readFile(legacy);
    const manifest = await manifestFor(workspace);
    const manifestPath = await writeManifest(workspace, manifest);

    const result = await loadAndValidateAuthorityManifest({
      workspace,
      manifestPath,
    });
    assert.equal(result.actionable, true);
    assert.equal(result.manifest.manifestSchemaVersion, 2);
    assert.match(result.manifestSha256, /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(result.operations[0].sources, manifest.operations[0].sources);
    assert.equal(result.targets[0].contentSha256, HASH_A);
    assert.deepEqual(result.targets[0].sourceRefs, manifest.operations[0].sources);
    assert.deepEqual(await readFile(legacy), before);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("reviewed v1 manifest remains valid but explicitly non-actionable", async () => {
  const workspace = await temporaryWorkspace();
  try {
    await writeNote(workspace, "legacy.md", "# Legacy workspace\n");
    const manifestPath = await writeManifest(
      workspace,
      await manifestFor(workspace, { version: 1 }),
    );
    const result = await loadAndValidateAuthorityManifest({
      workspace,
      manifestPath,
    });
    assert.equal(result.actionable, false);
    assert.equal(result.manifest.manifestSchemaVersion, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("manifest parser rejects duplicate JSON keys and oversized files before semantic use", async () => {
  const workspace = await temporaryWorkspace();
  try {
    await writeNote(workspace, "legacy.md", "# Legacy workspace\n");
    const duplicatePath = join(workspace, "duplicate.json");
    await writeFile(
      duplicatePath,
      '{"manifestSchemaVersion":2,"manifestSchemaVersion":2}',
      "utf8",
    );
    await assert.rejects(
      loadAndValidateAuthorityManifest({ workspace, manifestPath: duplicatePath }),
      (error) => error?.code === "MANIFEST001" && /duplicate object key/.test(error.message),
    );

    const oversizedPath = join(workspace, "oversized.json");
    await writeFile(
      oversizedPath,
      Buffer.alloc(AUTHORITY_MANIFEST_POLICY.maxManifestBytes + 1, 0x20),
    );
    await assert.rejects(
      loadAndValidateAuthorityManifest({ workspace, manifestPath: oversizedPath }),
      (error) => error?.code === "MANIFEST001" && /exceeds/.test(error.message),
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("disposition completeness and actionable source provenance fail closed", async () => {
  const workspace = await temporaryWorkspace();
  try {
    await writeNote(workspace, "legacy.md", "# Legacy workspace\n");
    const manifest = await manifestFor(workspace);
    manifest.dispositions = [];
    manifest.operations[0].target.sourceRefs[0].expectedSha256 = HASH_A;
    const manifestPath = await writeManifest(workspace, manifest);
    await assert.rejects(
      loadAndValidateAuthorityManifest({ workspace, manifestPath }),
      (error) =>
        error?.code === "MANIFEST003" &&
        error.details?.byCode?.MANIFEST003 >= 2,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("graph and source drift invalidate reviewed snapshot bindings", async () => {
  const workspace = await temporaryWorkspace();
  try {
    const legacy = await writeNote(workspace, "legacy.md", "# Legacy workspace\n");
    const manifestPath = await writeManifest(workspace, await manifestFor(workspace));
    await writeFile(legacy, "# Changed legacy workspace\n", "utf8");
    await assert.rejects(
      loadAndValidateAuthorityManifest({ workspace, manifestPath }),
      (error) =>
        error?.code === "MANIFEST002" &&
        error.details?.byCode?.MANIFEST002 >= 1,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("concurrent graph and manifest changes fail with the binding error class", async (t) => {
  await t.test("graph changes during final inspection", async () => {
    const workspace = await temporaryWorkspace();
    try {
      const legacy = await writeNote(workspace, "legacy.md", "# Legacy workspace\n");
      const manifestPath = await writeManifest(workspace, await manifestFor(workspace));
      await assert.rejects(
        loadAndValidateAuthorityManifest(
          { workspace, manifestPath },
          {
            beforeFinalInspection: async () => {
              await writeFile(legacy, "# Concurrent graph change\n", "utf8");
            },
          },
        ),
        (error) =>
          error?.code === "MANIFEST002" &&
          error.details?.sourceCode === "READ001",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  await t.test("manifest changes before its final read", async () => {
    const workspace = await temporaryWorkspace();
    try {
      await writeNote(workspace, "legacy.md", "# Legacy workspace\n");
      const manifestPath = await writeManifest(workspace, await manifestFor(workspace));
      await assert.rejects(
        loadAndValidateAuthorityManifest(
          { workspace, manifestPath },
          {
            beforeFinalManifestRead: async () => {
              await writeFile(manifestPath, "{}\n", "utf8");
            },
          },
        ),
        (error) => error?.code === "MANIFEST002",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

test("post-promotion overlay rejects competing active hubs", async () => {
  const workspace = await temporaryWorkspace();
  try {
    await writeNote(
      workspace,
      "knowledge/projects/current.md",
      currentNote({ id: "project-current", kind: "project" }),
    );
    await writeNote(workspace, "legacy.md", "# Legacy workspace\n");
    const manifestPath = await writeManifest(workspace, await manifestFor(workspace));
    await assert.rejects(
      loadAndValidateAuthorityManifest({ workspace, manifestPath }),
      (error) =>
        error?.code === "MANIFEST003" &&
        error.details?.examples?.some((item) => /HUB001/.test(item.message)),
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("schema-v1 hardening rejects invalid dates and normalized duplicate identities", async () => {
  const workspace = await temporaryWorkspace();
  try {
    await writeNote(
      workspace,
      "knowledge/concepts/one.md",
      currentNote({ id: "Concept-One" }),
    );
    await writeNote(
      workspace,
      "knowledge/concepts/two.md",
      currentNote({ id: "concept-one" }),
    );
    await writeNote(
      workspace,
      "knowledge/concepts/date.md",
      currentNote({ id: "invalid-date", created: "2026-02-30" }),
    );
    const inspection = await inspectWorkspace({ workspace });
    assert.equal(inspection.report.summary.diagnostics.byCode.ID001, 2);
    assert.equal(inspection.report.summary.diagnostics.byCode.SCHEMA003, 1);
    assert.equal(
      inspection.notes.find((note) => note.path.endsWith("date.md")).currentSchema,
      false,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("supersession resolves inside scope and requires reciprocal declarations", async () => {
  const workspace = await temporaryWorkspace();
  try {
    await writeNote(
      workspace,
      "knowledge/decisions/old.md",
      currentNote({
        id: "decision-old",
        kind: "decision",
        state: "superseded",
        decisionKey: "choice.old",
        supersededBy: ["decision-new"],
      }),
    );
    await writeNote(
      workspace,
      "knowledge/decisions/new.md",
      currentNote({
        id: "decision-new",
        kind: "decision",
        state: "accepted",
        decisionKey: "choice.new",
        supersedes: ["decision-old"],
      }),
    );
    let inspection = await inspectWorkspace({ workspace });
    assert.equal(inspection.report.summary.diagnostics.byCode.AUTH003 ?? 0, 0);

    await writeNote(
      workspace,
      "knowledge/decisions/new.md",
      currentNote({
        id: "decision-new",
        kind: "decision",
        scope: "other-scope",
        state: "accepted",
        decisionKey: "choice.new",
        supersedes: ["decision-old"],
      }),
    );
    inspection = await inspectWorkspace({ workspace });
    assert.ok(inspection.report.summary.diagnostics.byCode.AUTH003 >= 2);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("actionable v2 schema requires staged content and structured provenance", async () => {
  const schema = JSON.parse(
    await readFile(
      join(
        repositoryRoot,
        "skills",
        "syncora",
        "assets",
        "schemas",
        "authority-promotion-manifest-v2.schema.json",
      ),
      "utf8",
    ),
  );
  assert.equal(schema.properties.manifestSchemaVersion.const, 2);
  assert.ok(schema.$defs.target.required.includes("contentSha256"));
  assert.ok(schema.$defs.target.required.includes("sourceRefs"));
  assert.equal(
    schema.$defs.target.properties.sourceRefs.items.$ref,
    "#/$defs/sourceReference",
  );
  const reservedArchivePattern = new RegExp(
    schema.$defs.portableTargetMarkdownPath.allOf[2].not.pattern,
  );
  assert.equal(reservedArchivePattern.test("archive/migrations/old/index.md"), true);
});
