import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { compileContextPack } from "../../skills/syncora/scripts/lib/context-compiler.mjs";

function note({ id, kind, scope = "workspace", authorityClass, body, sourceRefs = ["legacy.md@sha256:abc"] }) {
  const text = `# ${id}\n\n${body}\n`;
  const sha = createHash("sha256").update(text).digest("hex");
  return {
    path: `knowledge/${kind}s/${id}.md`,
    rawSha256: sha,
    currentSchema: true,
    authorityClass,
    characterLength: text.length,
    title: id,
    diagnostics: [],
    frontmatter: {
      id,
      kind,
      scope,
      state: "active",
      authority: kind === "atlas" || kind === "project" || kind === "decision" || kind === "concept"
        ? "canonical"
        : "supporting",
      schema_version: 1,
      summary: `Summary ${id}`,
      source_refs: sourceRefs,
    },
    lexicalSource: {
      path: `knowledge/${kind}s/${id}.md`,
      id,
      title: id,
      summary: `Summary ${id}`,
      body: text,
    },
  };
}

const fixture = {
  caseId: "migration-routing",
  scope: "workspace",
  query: "authentication token policy",
  budgetCharacters: 4_000,
  requiredIds: ["decision-auth"],
  evidenceIds: [],
  forbiddenIds: ["concept-obsolete"],
};

test("context compiler preserves mandatory lanes, provenance, and explicit budget accounting", async () => {
  const notes = [
    note({ id: "atlas-root", kind: "atlas", authorityClass: "routing", body: "Route to workspace." }),
    note({ id: "project-workspace", kind: "project", authorityClass: "canonical", body: "Authentication project hub." }),
    note({ id: "decision-auth", kind: "decision", authorityClass: "canonical", body: "Use short-lived authentication tokens." }),
    note({ id: "concept-auth", kind: "concept", authorityClass: "canonical", body: "Authentication token rotation policy." }),
    note({ id: "concept-obsolete", kind: "concept", authorityClass: "canonical", body: "Authentication token policy obsolete." }),
  ];
  const result = await compileContextPack({
    notes,
    graphRevision: "sha256:" + "1".repeat(64),
    rootIdentity: "sha256:" + "2".repeat(64),
    fixture,
  });
  assert.equal(result.pass, true);
  assert.deepEqual(
    result.lanes.mandatory.map((item) => item.id),
    ["atlas-root", "project-workspace", "decision-auth"],
  );
  assert.ok(result.lanes.working.some((item) => item.id === "concept-auth"));
  assert.equal(result.lanes.working.some((item) => item.id === "concept-obsolete"), false);
  assert.equal(result.sourceMap.length, result.lanes.mandatory.length + result.lanes.working.length);
  assert.equal(result.budget.overflow, false);
});

test("context compiler fails shadow cases on missing provenance or mandatory overflow", async () => {
  const longBody = "x".repeat(1_200);
  const notes = [
    note({ id: "atlas-root", kind: "atlas", authorityClass: "routing", body: longBody }),
    note({ id: "project-workspace", kind: "project", authorityClass: "canonical", body: longBody }),
    note({
      id: "decision-auth",
      kind: "decision",
      authorityClass: "canonical",
      body: longBody,
      sourceRefs: [],
    }),
  ];
  const result = await compileContextPack({
    notes,
    graphRevision: "sha256:" + "3".repeat(64),
    rootIdentity: "sha256:" + "4".repeat(64),
    fixture: { ...fixture, budgetCharacters: 1_000 },
  });
  assert.equal(result.pass, false);
  assert.equal(result.budget.overflow, true);
  assert.deepEqual(result.diagnostics.missingSourceMapIds, ["decision-auth"]);
});

test("context compiler reserves evidence budget and fails closed above the note ceiling", async () => {
  const required = Array.from({ length: 101 }, (_, index) => `decision-${index}`);
  const notes = [
    note({ id: "atlas-root", kind: "atlas", authorityClass: "routing", body: "Route." }),
    note({ id: "project-workspace", kind: "project", authorityClass: "canonical", body: "Hub." }),
    ...required.map((id) =>
      note({ id, kind: "decision", authorityClass: "canonical", body: "Required authority." })),
  ];
  const result = await compileContextPack({
    notes,
    graphRevision: "sha256:" + "5".repeat(64),
    rootIdentity: "sha256:" + "6".repeat(64),
    fixture: {
      ...fixture,
      budgetCharacters: 64_000,
      requiredIds: required,
      evidenceIds: [],
    },
  });
  assert.equal(result.pass, false);
  assert.ok(result.diagnostics.omittedMandatoryForLimit.length > 0);
  assert.ok(
    result.lanes.mandatory.length +
      result.lanes.working.length +
      result.lanes.evidence.length <= 100,
  );
});
