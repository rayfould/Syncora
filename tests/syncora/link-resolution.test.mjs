import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const cli = join(testDirectory, "..", "..", "skills", "syncora", "scripts", "syncora.mjs");

function run(args, expectedStatus = 0) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
  assert.equal(
    result.status,
    expectedStatus,
    `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result;
}

async function temporaryWorkspace() {
  return realpath(await mkdtemp(join(tmpdir(), "syncora-links-")));
}

function currentNote({ id, kind = "concept", pathScope = "workspace", body = "", schema = 1 }) {
  return `---
id: ${id}
kind: ${kind}
scope: ${pathScope}
state: active
authority: canonical
schema_version: ${schema}
created: 2026-07-15
updated: 2026-07-15
summary: ${JSON.stringify(`Summary for ${id}`)}
---

# ${id}

${body}
`;
}

async function writeNote(workspace, path, content) {
  const destination = join(workspace, "local", ...path.split("/"));
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, content, "utf8");
}

function diagnostic(report, code) {
  return report.diagnostics.find((item) => item.code === code);
}

test("exact paths beat aliases while unique IDs resolve and referential defects do not quarantine", async () => {
  const workspace = await temporaryWorkspace();
  try {
    await writeNote(
      workspace,
      "knowledge/concepts/alpha.md",
      currentNote({ id: "concept-alpha" }),
    );
    await writeNote(
      workspace,
      "knowledge/other/alpha.md",
      currentNote({ id: "other-alpha" }),
    );
    await writeNote(
      workspace,
      "knowledge/concepts/unique.md",
      currentNote({ id: "unique-id" }),
    );
    await writeNote(
      workspace,
      "knowledge/projects/workspace.md",
      currentNote({
        id: "project-workspace",
        kind: "project",
        body: [
          "[[knowledge/concepts/alpha.md#Part|Exact]]",
          "[[unique-id]]",
          "[[alpha]]",
          "[[missing]]",
          "[[#Local heading]]",
        ].join("\n"),
      }),
    );

    const report = JSON.parse(
      run(["validate", "--workspace", workspace, "--format", "json"], 1).stdout,
    );
    assert.deepEqual(report.summary.links, {
      uniqueReferences: 4,
      resolvedReferences: 2,
      unresolvedReferences: 1,
      ambiguousReferences: 1,
      resolvedEdges: 2,
      backlinkEdges: 2,
      linksToQuarantinedTargets: 0,
    });
    assert.equal(report.summary.authority.canonical, 4);
    assert.equal(diagnostic(report, "LINK003").severity, "error");
    const ambiguous = diagnostic(report, "LINK004");
    assert.equal(ambiguous.severity, "error");
    assert.deepEqual(
      ambiguous.examples[0].details.candidates,
      ["knowledge/concepts/alpha.md", "knowledge/other/alpha.md"],
    );

    const exactBacklinks = JSON.parse(
      run([
        "backlinks",
        "--workspace",
        workspace,
        "--note",
        "knowledge/concepts/alpha",
        "--format",
        "json",
      ]).stdout,
    );
    assert.equal(exactBacklinks.target.resolution, "exact");
    assert.deepEqual(
      exactBacklinks.backlinks.map((item) => item.path),
      ["knowledge/projects/workspace.md"],
    );

    const aliasBacklinks = JSON.parse(
      run([
        "backlinks",
        "--workspace",
        workspace,
        "--note",
        "unique-id",
        "--format",
        "json",
      ]).stdout,
    );
    assert.equal(aliasBacklinks.target.resolution, "alias");
    assert.equal(aliasBacklinks.backlinks[0].method, "alias");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("legacy broken links warn while portable exact identity normalizes case separators and Unicode", async () => {
  const workspace = await temporaryWorkspace();
  try {
    await writeNote(
      workspace,
      "knowledge/concepts/Caf\u00e9.md",
      currentNote({ id: "concept-cafe" }),
    );
    await writeNote(workspace, "one/shared.md", currentNote({ id: "shared-one" }));
    await writeNote(workspace, "two/shared.md", currentNote({ id: "shared-two" }));
    await writeNote(
      workspace,
      "legacy.md",
      [
        "# Legacy",
        "[[KNOWLEDGE\\CONCEPTS\\Cafe\u0301.MD#Heading|Cafe]]",
        "[[shared]]",
        "[[absent]]",
      ].join("\n"),
    );

    const report = JSON.parse(
      run(["validate", "--workspace", workspace, "--format", "json"]).stdout,
    );
    assert.equal(report.ok, true);
    assert.equal(report.summary.links.resolvedReferences, 1);
    assert.equal(report.summary.links.ambiguousReferences, 1);
    assert.equal(report.summary.links.unresolvedReferences, 1);
    assert.equal(diagnostic(report, "LINK003").severity, "warning");
    assert.equal(diagnostic(report, "LINK004").severity, "warning");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("repeated spellings and cycles produce one deterministic backlink edge per source-target pair", async () => {
  const workspace = await temporaryWorkspace();
  try {
    await writeNote(
      workspace,
      "a.md",
      currentNote({
        id: "note-a",
        body: "[[b]]\n[[b.md#One]]\n[[note-b|ID spelling]]",
      }),
    );
    await writeNote(
      workspace,
      "b.md",
      currentNote({ id: "note-b", body: "[[a]]" }),
    );

    const report = JSON.parse(
      run(["validate", "--workspace", workspace, "--format", "json"]).stdout,
    );
    assert.equal(report.summary.links.uniqueReferences, 3);
    assert.equal(report.summary.links.resolvedReferences, 3);
    assert.equal(report.summary.links.resolvedEdges, 2);

    const backlinks = JSON.parse(
      run([
        "backlinks",
        "--workspace",
        workspace,
        "--note",
        "b",
        "--format",
        "json",
      ]).stdout,
    );
    assert.equal(backlinks.summary.total, 1);
    assert.equal(backlinks.backlinks[0].references, 2);
    assert.equal(backlinks.backlinks[0].occurrences, 3);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("exact links retain quarantined targets as non-authoritative topology", async () => {
  const workspace = await temporaryWorkspace();
  try {
    await writeNote(
      workspace,
      "knowledge/concepts/future.md",
      currentNote({ id: "future-note", schema: 999 }),
    );
    await writeNote(
      workspace,
      "knowledge/projects/workspace.md",
      currentNote({
        id: "project-workspace",
        kind: "project",
        body: "[[knowledge/concepts/future]]",
      }),
    );

    const report = JSON.parse(
      run(["validate", "--workspace", workspace, "--format", "json"], 1).stdout,
    );
    assert.equal(report.summary.links.resolvedReferences, 1);
    assert.equal(report.summary.links.unresolvedReferences, 0);
    assert.equal(report.summary.links.linksToQuarantinedTargets, 1);
    assert.equal(diagnostic(report, "LINK003"), undefined);

    const backlinks = JSON.parse(
      run([
        "backlinks",
        "--workspace",
        workspace,
        "--note",
        "knowledge/concepts/future",
        "--format",
        "json",
      ]).stdout,
    );
    assert.equal(backlinks.target.authorityClass, "quarantined");
    assert.equal(backlinks.backlinks.length, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
