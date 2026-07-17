import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { compileTaskContext } from "../../skills/syncora/scripts/lib/task-context.mjs";

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
  return realpath(await mkdtemp(join(tmpdir(), "syncora-task-context-")));
}

function listField(name, values = []) {
  return values.length === 0
    ? `${name}: []`
    : `${name}:\n${values.map((value) => `  - ${JSON.stringify(value)}`).join("\n")}`;
}

function currentNote({
  id,
  kind,
  scope = "workspace",
  state = kind === "decision" ? "accepted" : kind === "session" ? "complete" : "active",
  authority = kind === "reference"
    ? "supporting"
    : kind === "session"
      ? "historical"
      : "canonical",
  summary = `Summary for ${id}`,
  body = "",
  appliesTo = [],
  sourceRefs = [],
  decisionKey = id,
}) {
  return `---
id: ${id}
kind: ${kind}
scope: ${scope}
state: ${state}
authority: ${authority}
schema_version: 1
created: 2026-07-16
updated: 2026-07-16
summary: ${JSON.stringify(summary)}
${kind === "decision" ? `decision_key: ${decisionKey}\nsupersedes: []\nsuperseded_by: []` : ""}
${listField("applies_to", appliesTo)}
${listField("source_refs", sourceRefs)}
---

# ${id}

${body}
`;
}

async function writeNote(workspace, path, content) {
  const destination = join(workspace, "local", ...path.split("/"));
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, content, "utf8");
  return destination;
}

async function markdownManifest(root) {
  const files = [];
  async function walk(path) {
    const entries = await readdir(path, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        const bytes = await readFile(full);
        files.push({
          path: relative(root, full).replaceAll("\\", "/"),
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
      }
    }
  }
  await walk(root);
  return files;
}

function context(workspace, extra = []) {
  return JSON.parse(run([
    "context",
    "--workspace",
    workspace,
    "--intent",
    "Implement secure authentication token rotation",
    "--format",
    "json",
    ...extra,
  ]).stdout);
}

async function initializeFixture(workspace) {
  run(["setup", "--workspace", workspace, "--no-patch-agents"]);
  await writeNote(
    workspace,
    "knowledge/projects/workspace.md",
    currentNote({
      id: "project-workspace",
      kind: "project",
      body: `## Objective

- Build secure authentication.

## Current state

- Token rotation is active.

## Hard constraints

- Never store raw refresh tokens.

## Active accepted decisions

- [[knowledge/decisions/scope-policy]]
- [[knowledge/decisions/token-policy]]

## Work now

- Implement session renewal.

## Blockers

- None.

## Next actions

- Update the authentication service.`,
    }),
  );
  await writeNote(
    workspace,
    "knowledge/decisions/scope-policy.md",
    currentNote({
      id: "decision-scope-policy",
      kind: "decision",
      decisionKey: "auth.scope-policy",
      body: "All authentication paths require audit events.",
    }),
  );
  await writeNote(
    workspace,
    "knowledge/decisions/token-policy.md",
    currentNote({
      id: "decision-token-policy",
      kind: "decision",
      decisionKey: "auth.token-policy",
      appliesTo: ["file:src/auth/session.ts"],
      body: "Use rotating, hashed refresh tokens. [[knowledge/references/auth-evidence]]",
    }),
  );
  await writeNote(
    workspace,
    "knowledge/decisions/proposed-policy.md",
    currentNote({
      id: "decision-proposed-policy",
      kind: "decision",
      state: "proposed",
      decisionKey: "auth.proposed-policy",
      appliesTo: ["file:src/auth/session.ts"],
      body: "This proposed decision must not enter context.",
    }),
  );
  await writeNote(
    workspace,
    "knowledge/concepts/token-rotation.md",
    currentNote({
      id: "concept-token-rotation",
      kind: "concept",
      appliesTo: ["module:src/auth"],
      body: "Token rotation invalidates the previous refresh token.",
    }),
  );
  await writeNote(
    workspace,
    "knowledge/references/auth-evidence.md",
    currentNote({
      id: "reference-auth-evidence",
      kind: "reference",
      body: "Authentication evidence supports hashed token storage.",
    }),
  );
  await writeNote(
    workspace,
    "knowledge/sessions/auth-history.md",
    currentNote({
      id: "session-auth-history",
      kind: "session",
      body: "Historical authentication token rotation experiment.",
    }),
  );
}

test("untouched setup immediately compiles deterministic bounded context without mutating Markdown", async () => {
  const workspace = await temporaryWorkspace();
  try {
    run(["setup", "--workspace", workspace, "--no-patch-agents"]);
    const before = await markdownManifest(join(workspace, "local"));
    const cold = context(workspace, ["--mode", "orient"]);
    const warm = context(workspace, ["--mode", "orient"]);
    assert.equal(cold.ok, true);
    assert.equal(cold.request.scope, "workspace");
    assert.equal(cold.request.scopeResolution, "single_active_hub");
    assert.equal(cold.scopeHub.id, "project-workspace");
    assert.ok(cold.lanes.mandatory.some((item) => item.fragment === "hard-constraints"));
    assert.equal(cold.renderedContext, warm.renderedContext);
    assert.equal(cold.contextPackId, warm.contextPackId);
    assert.ok(cold.budget.usedCharacters <= cold.budget.maximumCharacters);
    assert.deepEqual(await markdownManifest(join(workspace, "local")), before);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("task context separates governing decisions, working concepts, evidence, and history", async () => {
  const workspace = await temporaryWorkspace();
  try {
    await initializeFixture(workspace);
    const result = context(workspace, [
      "--mode",
      "implement",
      "--target",
      "file:src/auth/session.ts",
    ]);
    assert.deepEqual(
      result.lanes.mandatory
        .filter((item) => item.kind === "decision")
        .map((item) => item.sourceId),
      ["decision-scope-policy", "decision-token-policy"],
    );
    assert.ok(result.lanes.mandatory.some((item) => item.fragment === "hard-constraints"));
    assert.ok(result.lanes.working.some((item) => item.sourceId === "concept-token-rotation"));
    assert.ok(result.lanes.evidence.some((item) => item.sourceId === "reference-auth-evidence"));
    assert.equal(
      [...result.lanes.mandatory, ...result.lanes.working, ...result.lanes.evidence]
        .some((item) => item.sourceId === "decision-proposed-policy"),
      false,
    );
    assert.equal(result.renderedContext.includes("Historical authentication"), false);
    assert.match(result.renderedContext, /Use rotating, hashed refresh tokens/);
    assert.match(result.renderedContext, /Never store raw refresh tokens/);

    const historical = context(workspace, ["--mode", "history"]);
    assert.ok(historical.lanes.evidence.some((item) => item.sourceId === "session-auth-history"));
    assert.equal(
      historical.lanes.evidence.some((item) => item.kind === "decision"),
      false,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("mandatory overflow fails visibly while oversized optional context is omitted whole", async () => {
  const workspace = await temporaryWorkspace();
  try {
    run(["setup", "--workspace", workspace, "--no-patch-agents"]);
    await writeNote(
      workspace,
      "knowledge/projects/workspace.md",
      currentNote({
        id: "project-workspace",
        kind: "project",
        body: `## Hard constraints\n\n- ${"mandatory ".repeat(180)}\n\n## Current state\n\n- Active.`,
      }),
    );
    const failed = run([
      "context",
      "--workspace",
      workspace,
      "--intent",
      "Read mandatory constraints",
      "--max-characters",
      "1000",
      "--format",
      "json",
    ], 1);
    const error = JSON.parse(failed.stderr);
    assert.equal(error.error.code, "CONTEXT_BUDGET_EXCEEDED");
    assert.ok(error.error.details.requiredCharacters > 1000);

    await writeNote(
      workspace,
      "knowledge/projects/workspace.md",
      currentNote({
        id: "project-workspace",
        kind: "project",
        body: "## Hard constraints\n\n- Keep context bounded.\n\n## Current state\n\n- Active.",
      }),
    );
    await writeNote(
      workspace,
      "knowledge/concepts/oversized.md",
      currentNote({
        id: "concept-oversized",
        kind: "concept",
        body: `Authentication token rotation oversizedcontext ${"supportingmaterial ".repeat(4_000)}`,
      }),
    );
    const result = context(workspace, ["--budget", "standard"]);
    assert.equal(result.ok, true);
    assert.ok(result.budget.usedCharacters <= 12_000);
    assert.equal(result.renderedContext.includes("supportingmaterial"), false);
    assert.ok(result.sourceMap.omitted.some((item) => item.sourceId === "concept-oversized"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("selected-note mutation during hydration fails before context publication", async () => {
  const workspace = await temporaryWorkspace();
  try {
    await initializeFixture(workspace);
    let changed = false;
    await assert.rejects(
      compileTaskContext(
        {
          workspace,
          intent: "Implement secure authentication token rotation",
          scope: "workspace",
          mode: "implement",
          budget: "standard",
          maxCharacters: undefined,
          targets: ["file:src/auth/session.ts"],
          noCache: true,
          allowExternalGraphRoot: undefined,
        },
        {
          async beforeMaterialize({ path }) {
            if (changed || path !== "knowledge/decisions/token-policy.md") return;
            changed = true;
            await writeNote(
              workspace,
              path,
              currentNote({
                id: "decision-token-policy",
                kind: "decision",
                decisionKey: "auth.token-policy",
                appliesTo: ["file:src/auth/session.ts"],
                body: "Concurrent replacement.",
              }),
            );
          },
        },
      ),
      (error) => error?.code === "READ001",
    );
    assert.equal(changed, true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
