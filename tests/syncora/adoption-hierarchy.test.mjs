import assert from "node:assert/strict";
import test from "node:test";

import { validateAdoptionHubHierarchy } from "../../skills/syncora/scripts/lib/adoption-hierarchy.mjs";

function note(path, kind, scope, authorityClass = "canonical") {
  return {
    path,
    currentSchema: true,
    authorityClass,
    frontmatter: {
      kind,
      scope,
      state: "active",
    },
  };
}

function graph(edges) {
  const outgoing = new Map();
  for (const [sourcePath, targetPath] of edges) {
    const values = outgoing.get(sourcePath) ?? [];
    values.push({ sourcePath, targetPath });
    outgoing.set(sourcePath, values);
  }
  return { outgoing };
}

const atlas = note("index.md", "atlas", "workspace", "routing");
const workspace = note(
  "knowledge/projects/workspace.md",
  "project",
  "workspace",
);
const runtime = note(
  "knowledge/projects/runtime.md",
  "project",
  "runtime",
);
const website = note(
  "knowledge/projects/website.md",
  "project",
  "website",
);

test("accepts one workspace hub routing to every canonical workstream", () => {
  const result = validateAdoptionHubHierarchy(
    [atlas, workspace, runtime, website],
    graph([
      [atlas.path, workspace.path],
      [workspace.path, runtime.path],
      [workspace.path, website.path],
    ]),
  );

  assert.equal(result.workspaceHub, workspace.path);
  assert.deepEqual(
    result.workstreamHubs.map((item) => item.scope),
    ["runtime", "website"],
  );
});

test("rejects a graph without one canonical workspace hub", () => {
  assert.throws(
    () => validateAdoptionHubHierarchy([atlas, runtime], graph([])),
    (error) =>
      error.code === "MIGRATE010" &&
      /exactly one active canonical workspace hub/.test(error.message),
  );
});

test("rejects an atlas that bypasses the workspace hub", () => {
  assert.throws(
    () =>
      validateAdoptionHubHierarchy(
        [atlas, workspace, runtime],
        graph([
          [atlas.path, workspace.path],
          [atlas.path, runtime.path],
          [workspace.path, runtime.path],
        ]),
      ),
    (error) =>
      error.code === "MIGRATE010" &&
      /not directly to workstream hubs/.test(error.message),
  );
});

test("rejects an orphaned canonical workstream hub", () => {
  assert.throws(
    () =>
      validateAdoptionHubHierarchy(
        [atlas, workspace, runtime],
        graph([[atlas.path, workspace.path]]),
      ),
    (error) =>
      error.code === "MIGRATE010" &&
      /linked directly from the workspace hub/.test(error.message),
  );
});
