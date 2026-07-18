import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  validateProjectedGraph,
} from "../../skills/syncora/scripts/lib/projected-graph.mjs";
import { inspectWorkspace } from "../../skills/syncora/scripts/lib/validate.mjs";

function currentNote({
  id,
  kind,
  scope = "workspace",
  state = "active",
  authority = "canonical",
  title = id,
  decisionKey = undefined,
  body = "",
  newline = "\n",
  bom = false,
}) {
  const lines = [
    "---",
    `id: ${id}`,
    `kind: ${kind}`,
    `scope: ${scope}`,
    `state: ${state}`,
    `authority: ${authority}`,
    "schema_version: 1",
    "created: 2026-07-17",
    "updated: 2026-07-17",
    `summary: ${JSON.stringify(`Summary for ${id}`)}`,
    ...(decisionKey === undefined ? [] : [`decision_key: ${decisionKey}`]),
    "---",
    "",
    `# ${title}`,
    "",
    body,
    "",
  ];
  const bytes = Buffer.from(lines.join(newline), "utf8");
  return bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]) : bytes;
}

async function writeGraphNote(workspace, path, bytes) {
  const destination = join(workspace, "local", ...path.split("/"));
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, bytes);
  return destination;
}

async function fixture() {
  const workspace = await mkdtemp(join(tmpdir(), "syncora-projected-"));
  const atlas = currentNote({ id: "atlas-root", kind: "atlas", title: "Atlas" });
  const hub = currentNote({
    id: "project-workspace",
    kind: "project",
    title: "Workspace",
    body: "Current project state.",
  });
  await writeGraphNote(workspace, "index.md", atlas);
  await writeGraphNote(workspace, "knowledge/projects/workspace.md", hub);
  const inspection = await inspectWorkspace({ workspace });
  return { workspace, atlas, hub, inspection };
}

test("projected validation builds create, update, delete, and move post-images without writes", async () => {
  const environment = await fixture();
  const sourcePath = "knowledge/concepts/source.md";
  const destinationPath = "knowledge/concepts/moved.md";
  const source = currentNote({ id: "concept-source", kind: "concept", body: "Source body." });
  const removedPath = "knowledge/references/removed.md";
  const removed = currentNote({
    id: "reference-removed",
    kind: "reference",
    authority: "supporting",
  });
  try {
    await writeGraphNote(environment.workspace, sourcePath, source);
    await writeGraphNote(environment.workspace, removedPath, removed);
    const inspection = await inspectWorkspace({ workspace: environment.workspace });
    const beforeHub = await readFile(join(environment.workspace, "local", "knowledge", "projects", "workspace.md"));
    const updatedHub = currentNote({
      id: "project-workspace",
      kind: "project",
      title: "Workspace",
      body: "Projected state only.",
    });
    const createdPath = "knowledge/concepts/created.md";
    const created = currentNote({ id: "concept-created", kind: "concept" });

    const result = validateProjectedGraph(inspection, [
      { path: "knowledge/projects/workspace.md", before: beforeHub, after: updatedHub },
      { path: createdPath, before: null, after: created },
      { path: removedPath, before: removed, after: null },
      { path: sourcePath, before: source, after: null },
      { path: destinationPath, before: null, after: source },
    ]);

    assert.equal(result.ok, true);
    assert.equal(result.report.summary.changes.create, 2);
    assert.equal(result.report.summary.changes.update, 1);
    assert.equal(result.report.summary.changes.delete, 2);
    assert.equal(result.notesByPath.has(sourcePath), false);
    assert.equal(result.notesByPath.has(removedPath), false);
    assert.equal(result.notesByPath.get(destinationPath).frontmatter.id, "concept-source");
    assert.equal(result.notesByPath.get(createdPath).frontmatter.id, "concept-created");
    assert.equal(result.graphRevision, result.report.graph.revision);
    assert.notEqual(result.graphRevision, inspection.report.graph.revision);
    assert.deepEqual(
      await readFile(join(environment.workspace, "local", "knowledge", "projects", "workspace.md")),
      beforeHub,
    );
    await assert.rejects(readFile(join(environment.workspace, "local", ...createdPath.split("/"))));
    assert.deepEqual(await readFile(join(environment.workspace, "local", ...sourcePath.split("/"))), source);
  } finally {
    await rm(environment.workspace, { recursive: true, force: true });
  }
});

test("projected parsing preserves exact BOM, Unicode, newline, and raw-hash metadata", async () => {
  const environment = await fixture();
  try {
    const path = "knowledge/concepts/unicode.md";
    const before = currentNote({
      id: "concept-unicode",
      kind: "concept",
      body: "Before café.",
      newline: "\r\n",
      bom: true,
    });
    await writeGraphNote(environment.workspace, path, before);
    const inspection = await inspectWorkspace({ workspace: environment.workspace });
    const after = currentNote({
      id: "concept-unicode",
      kind: "concept",
      body: "After 🧠 café.",
      newline: "\r\n",
      bom: true,
    });
    const result = validateProjectedGraph(inspection, [{ path, before, after }]);
    const parsed = result.notesByPath.get(path);

    assert.equal(result.ok, true);
    assert.equal(parsed.encoding.bom, true);
    assert.equal(parsed.encoding.newline, "crlf");
    assert.equal(parsed.rawSha256, createHash("sha256").update(after).digest("hex"));
    assert.match(parsed.lexicalSource.body, /After 🧠 café/);
    assert.deepEqual(await readFile(join(environment.workspace, "local", ...path.split("/"))), before);
  } finally {
    await rm(environment.workspace, { recursive: true, force: true });
  }
});

test("new schema, link, authority, and portable-path errors fail with introduced fingerprints", async () => {
  const environment = await fixture();
  try {
    const decision = currentNote({
      id: "decision-first",
      kind: "decision",
      state: "accepted",
      decisionKey: "workspace.choice",
    });
    await writeGraphNote(environment.workspace, "knowledge/decisions/first.md", decision);
    const inspection = await inspectWorkspace({ workspace: environment.workspace });
    const duplicate = currentNote({
      id: "decision-second",
      kind: "decision",
      state: "accepted",
      decisionKey: "workspace.choice",
      body: "[[missing-target]]",
    });
    const result = validateProjectedGraph(inspection, [{
      path: "knowledge/decisions/second.md",
      before: null,
      after: duplicate,
    }]);

    assert.equal(result.ok, false);
    assert.ok(result.report.summary.introducedErrors >= 2);
    assert.ok(result.errorFingerprints.introduced.count >= 2);
    assert.match(result.errorFingerprints.introduced.digest, /^sha256:[0-9a-f]{64}$/);
    assert.ok(result.findings.examples.some((finding) => finding.code === "AUTH002"));
    assert.ok(result.findings.examples.some((finding) => finding.code === "LINK003"));

    const collision = validateProjectedGraph(inspection, [{
      path: "Knowledge/Projects/WORKSPACE.md",
      before: null,
      after: currentNote({ id: "project-other", kind: "project", scope: "other" }),
    }]);
    assert.equal(collision.ok, false);
    assert.ok(collision.findings.examples.some((finding) => finding.code === "PATH001"));
  } finally {
    await rm(environment.workspace, { recursive: true, force: true });
  }
});

test("unrelated legacy errors may persist, but a touched authority conflict blocks", async () => {
  const environment = await fixture();
  try {
    await writeGraphNote(
      environment.workspace,
      "knowledge/concepts/broken.md",
      Buffer.from("---\nid: broken\nkind: concept\n---\n\n# Broken\n", "utf8"),
    );
    const first = currentNote({
      id: "decision-conflict-one",
      kind: "decision",
      state: "accepted",
      decisionKey: "conflicting.choice",
    });
    const second = currentNote({
      id: "decision-conflict-two",
      kind: "decision",
      state: "accepted",
      decisionKey: "conflicting.choice",
    });
    const firstPath = "knowledge/decisions/conflict-one.md";
    await writeGraphNote(environment.workspace, firstPath, first);
    await writeGraphNote(environment.workspace, "knowledge/decisions/conflict-two.md", second);
    const inspection = await inspectWorkspace({ workspace: environment.workspace });
    assert.equal(inspection.report.ok, false);

    const additive = currentNote({
      id: "concept-unrelated",
      kind: "concept",
      scope: "workspace",
    });
    const unrelated = validateProjectedGraph(inspection, [{
      path: "knowledge/concepts/unrelated.md",
      before: null,
      after: additive,
    }]);
    assert.equal(unrelated.ok, true);
    assert.equal(unrelated.errorFingerprints.introduced.count, 0);
    assert.ok(unrelated.errorFingerprints.persistent.count > 0);

    const updatedFirst = currentNote({
      id: "decision-conflict-one",
      kind: "decision",
      state: "accepted",
      decisionKey: "conflicting.choice",
      body: "Body changed while conflict remains.",
    });
    const affected = validateProjectedGraph(inspection, [{
      path: firstPath,
      before: first,
      after: updatedFirst,
    }]);
    assert.equal(affected.errorFingerprints.introduced.count, 0);
    assert.equal(affected.ok, false);
    assert.ok(affected.report.summary.affectedAuthorityConflicts > 0);
  } finally {
    await rm(environment.workspace, { recursive: true, force: true });
  }
});

test("projected inputs reject stale prior bytes and repeated portable identities", async () => {
  const environment = await fixture();
  try {
    const path = "knowledge/projects/workspace.md";
    const after = currentNote({ id: "project-workspace", kind: "project", body: "After." });
    assert.throws(
      () => validateProjectedGraph(environment.inspection, [{
        path,
        before: Buffer.from("stale", "utf8"),
        after,
      }]),
      (error) => error?.code === "WRITE001",
    );
    assert.throws(
      () => validateProjectedGraph(environment.inspection, [
        {
          path: "knowledge/concepts/Case.md",
          before: null,
          after: currentNote({ id: "concept-case-one", kind: "concept" }),
        },
        {
          path: "knowledge/concepts/case.md",
          before: null,
          after: currentNote({ id: "concept-case-two", kind: "concept" }),
        },
      ]),
      (error) => error?.code === "WRITE003",
    );
  } finally {
    await rm(environment.workspace, { recursive: true, force: true });
  }
});

test("error-fingerprint reports stay bounded under adversarial projected failures", async () => {
  const environment = await fixture();
  try {
    const changes = Array.from({ length: 80 }, (_, index) => ({
      path: `knowledge/concepts/invalid-${index}.md`,
      before: null,
      after: Buffer.from(
        `---\nid: invalid-${index}\nkind: concept\nschema_version: 1\n---\n`,
        "utf8",
      ),
    }));
    const result = validateProjectedGraph(environment.inspection, changes);
    assert.equal(result.ok, false);
    assert.ok(result.errorFingerprints.introduced.count > 64);
    assert.equal(result.errorFingerprints.introduced.examples.length, 64);
    assert.equal(result.errorFingerprints.introduced.truncated, true);
    assert.equal(
      result.errorFingerprints.introduced.omitted,
      result.errorFingerprints.introduced.count - 64,
    );
  } finally {
    await rm(environment.workspace, { recursive: true, force: true });
  }
});
