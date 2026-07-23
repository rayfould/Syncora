import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  resolveCanonicalOwnerFromNotes,
} from "../../skills/syncora/scripts/lib/canonical-owner.mjs";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const cli = join(
  testDirectory,
  "..",
  "..",
  "skills",
  "syncora",
  "scripts",
  "syncora.mjs",
);

function parsedNote({
  path,
  id,
  kind,
  scope = "workspace",
  state = "active",
  authorityClass = "canonical",
  decisionKey = undefined,
}) {
  return {
    path,
    rawSha256: createHash("sha256").update(path).digest("hex"),
    currentSchema: true,
    authorityClass,
    frontmatter: {
      id,
      kind,
      scope,
      state,
      authority: "canonical",
      schema_version: 1,
      ...(decisionKey === undefined ? {} : { decision_key: decisionKey }),
    },
  };
}

function currentNote({
  id,
  kind,
  scope = "workspace",
  state = "active",
  decisionKey = undefined,
}) {
  return `---
id: ${id}
kind: ${kind}
scope: ${scope}
state: ${state}
authority: canonical
schema_version: 1
created: 2026-07-22
updated: 2026-07-22
summary: ${JSON.stringify(`Summary for ${id}`)}
${decisionKey === undefined ? "" : `decision_key: ${decisionKey}\n`}---

# ${id}
`;
}

function run(args, expectedStatus = 0) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
  });
  assert.equal(
    result.status,
    expectedStatus,
    `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result;
}

test("canonical owner resolution deterministically selects hubs, decisions, and concepts", () => {
  const notes = [
    parsedNote({
      path: "knowledge/projects/workspace.md",
      id: "project-workspace",
      kind: "project",
    }),
    parsedNote({
      path: "knowledge/decisions/cache.md",
      id: "decision-cache",
      kind: "decision",
      state: "accepted",
      decisionKey: "Cache.Policy",
    }),
    parsedNote({
      path: "knowledge/concepts/runtime.md",
      id: "concept-runtime",
      kind: "concept",
    }),
  ];

  const hub = resolveCanonicalOwnerFromNotes(notes, {
    scope: "workspace",
    ownerKind: "project",
  });
  assert.equal(hub.state, "owner_found");
  assert.equal(hub.owner.path, "knowledge/projects/workspace.md");
  assert.match(hub.owner.expectedPriorSha256, /^sha256:[0-9a-f]{64}$/u);

  const decision = resolveCanonicalOwnerFromNotes(notes, {
    scope: "WORKSPACE",
    ownerKind: "decision",
    ownerKey: "cache.policy",
  });
  assert.equal(decision.owner.path, "knowledge/decisions/cache.md");

  const concept = resolveCanonicalOwnerFromNotes(notes, {
    scope: "workspace",
    ownerKind: "concept",
    ownerKey: "CONCEPT-RUNTIME",
    explicitOwner: "knowledge/concepts/runtime.md",
  });
  assert.equal(concept.owner.path, "knowledge/concepts/runtime.md");
});

test("canonical owner resolution returns bounded missing and ambiguous states without guessing", () => {
  const missing = resolveCanonicalOwnerFromNotes([], {
    scope: "workspace",
    ownerKind: "decision",
    ownerKey: "missing",
  });
  assert.equal(missing.state, "owner_missing");
  assert.equal(missing.owner, null);
  assert.throws(
    () => resolveCanonicalOwnerFromNotes([
      { path: "legacy.md", currentSchema: false, frontmatter: { id: 7 } },
    ], {
      scope: "workspace",
      ownerKind: "decision",
      ownerKey: "missing",
      explicitOwner: "legacy.md",
    }),
    (error) => error.code === "OWNER003",
  );

  const notes = Array.from({ length: 20 }, (_, index) =>
    parsedNote({
      path: `knowledge/projects/${String(index).padStart(2, "0")}.md`,
      id: `project-${index}`,
      kind: "project",
      authorityClass: "quarantined",
    }));
  const ambiguous = resolveCanonicalOwnerFromNotes(notes, {
    scope: "workspace",
    ownerKind: "project",
  });
  assert.equal(ambiguous.state, "owner_ambiguous");
  assert.equal(ambiguous.candidateCount, 20);
  assert.equal(ambiguous.candidates.length, 16);
  assert.equal(ambiguous.omittedCandidateCount, 4);
  assert.deepEqual(
    ambiguous.candidates.map((item) => item.path),
    [...ambiguous.candidates.map((item) => item.path)].sort(),
  );
});

test("canonical owner resolution rejects quarantined or mismatched explicit owners", () => {
  const quarantined = parsedNote({
    path: "knowledge/projects/workspace.md",
    id: "project-workspace",
    kind: "project",
    authorityClass: "quarantined",
  });
  assert.throws(
    () => resolveCanonicalOwnerFromNotes([quarantined], {
      scope: "workspace",
      ownerKind: "project",
    }),
    (error) => error.code === "OWNER002",
  );

  const valid = { ...quarantined, authorityClass: "canonical" };
  assert.throws(
    () => resolveCanonicalOwnerFromNotes([valid], {
      scope: "workspace",
      ownerKind: "project",
      explicitOwner: "knowledge/projects/other.md",
    }),
    (error) => error.code === "OWNER003",
  );
});

test("resolve-owner CLI stays read-only and returns only bounded owner metadata", async () => {
  const workspace = await realpath(
    await mkdtemp(join(tmpdir(), "syncora-owner-")),
  );
  try {
    const hubPath = join(workspace, "local", "knowledge", "projects", "workspace.md");
    await mkdir(dirname(hubPath), { recursive: true });
    await mkdir(join(workspace, ".syncora"), { recursive: true });
    await writeFile(
      join(workspace, ".syncora", "config.json"),
      `${JSON.stringify({ schemaVersion: 1, graphRoot: "local" }, null, 2)}\n`,
    );
    const hubBytes = currentNote({
      id: "project-workspace",
      kind: "project",
    });
    await writeFile(hubPath, hubBytes);

    const result = JSON.parse(run([
      "resolve-owner",
      "--workspace",
      workspace,
      "--scope",
      "workspace",
      "--owner-kind",
      "project",
      "--format",
      "json",
    ]).stdout);
    assert.equal(result.ok, true);
    assert.equal(result.mode, "read-only");
    assert.equal(result.state, "owner_found");
    assert.equal(result.owner.path, "knowledge/projects/workspace.md");
    assert.equal("body" in result.owner, false);
    assert.equal(await readFile(hubPath, "utf8"), hubBytes);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
