import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
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
  return realpath(await mkdtemp(join(tmpdir(), "syncora-context-hardening-")));
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
summary: ${JSON.stringify(`Summary for ${id}`)}
${kind === "decision" ? `decision_key: ${decisionKey}\nsupersedes: []\nsuperseded_by: []` : ""}
${listField("applies_to", appliesTo)}
${listField("source_refs", sourceRefs)}
---

# ${id}

${body}
`;
}

function legacyNote({ id, scope = "workspace", body }) {
  return `---
id: ${id}
kind: session
scope: ${scope}
state: complete
authority: historical
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
  return destination;
}

async function setup(workspace) {
  run(["setup", "--workspace", workspace, "--no-patch-agents"]);
}

function contextArgs(workspace, extra = [], format = "json") {
  return [
    "context",
    "--workspace",
    workspace,
    "--intent",
    "Implement authentication token rotation evidence controls",
    "--no-cache",
    "--format",
    format,
    ...extra,
  ];
}

function context(workspace, extra = []) {
  return JSON.parse(run(contextArgs(workspace, extra)).stdout);
}

test("budget preset lookup rejects inherited object names from CLI and config", async () => {
  const workspace = await temporaryWorkspace();
  try {
    await setup(workspace);
    for (const preset of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
      const failed = run(contextArgs(workspace, ["--budget", preset]), 1);
      assert.equal(JSON.parse(failed.stderr).error.code, "CONTEXT_BUDGET_INVALID");
    }

    const configPath = join(workspace, ".syncora", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.context.defaultBudget = "toString";
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    const failed = run(contextArgs(workspace), 1);
    assert.equal(JSON.parse(failed.stderr).error.code, "CONFIG001");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("typed targets infer one scope even when multiple active project hubs exist", async () => {
  const workspace = await temporaryWorkspace();
  try {
    await setup(workspace);
    await writeNote(
      workspace,
      "knowledge/projects/payments.md",
      currentNote({
        id: "project-payments",
        kind: "project",
        scope: "payments",
        body: "## Current state\n\n- Payment authentication is active.",
      }),
    );
    await writeNote(
      workspace,
      "knowledge/concepts/payment-auth.md",
      currentNote({
        id: "concept-payment-auth",
        kind: "concept",
        scope: "payments",
        appliesTo: ["file:src/payments/auth.ts"],
        body: "Payment authentication rotates credentials.",
      }),
    );

    const result = context(workspace, ["--target", "file:src/payments/auth.ts"]);
    assert.equal(result.request.scope, "payments");
    assert.equal(result.request.scopeResolution, "unique_target_binding");
    assert.equal(result.scopeHub.id, "project-payments");
    assert.ok(result.lanes.working.some((item) => item.sourceId === "concept-payment-auth"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("target bindings spanning multiple scopes fail closed as ambiguous", async () => {
  const workspace = await temporaryWorkspace();
  try {
    await setup(workspace);
    await writeNote(
      workspace,
      "knowledge/projects/payments.md",
      currentNote({
        id: "project-payments",
        kind: "project",
        scope: "payments",
        body: "## Current state\n\n- Payments active.",
      }),
    );
    for (const [scope, path, id] of [
      ["workspace", "knowledge/concepts/workspace-auth.md", "concept-workspace-auth"],
      ["payments", "knowledge/concepts/payment-auth.md", "concept-payment-auth"],
    ]) {
      await writeNote(
        workspace,
        path,
        currentNote({
          id,
          kind: "concept",
          scope,
          appliesTo: ["file:src/shared/auth.ts"],
          body: `${scope} authentication behavior.`,
        }),
      );
    }

    const failed = run(
      contextArgs(workspace, ["--target", "file:src/shared/auth.ts"]),
      1,
    );
    const error = JSON.parse(failed.stderr);
    assert.equal(error.error.code, "CONTEXT_SCOPE_AMBIGUOUS");
    assert.deepEqual(error.error.details.scopes, ["payments", "workspace"]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("ineligible bindings neither infer scope nor suppress unbound targets", async () => {
  const workspace = await temporaryWorkspace();
  try {
    await setup(workspace);
    await writeNote(
      workspace,
      "knowledge/projects/payments.md",
      currentNote({
        id: "project-payments",
        kind: "project",
        scope: "payments",
        body: "## Current state\n\n- Payments active.",
      }),
    );
    await writeNote(
      workspace,
      "knowledge/decisions/proposed-payment-binding.md",
      currentNote({
        id: "decision-proposed-payment-binding",
        kind: "decision",
        scope: "payments",
        state: "proposed",
        decisionKey: "payments.proposed-binding",
        appliesTo: ["file:src/payments/proposed.ts"],
        body: "This proposal cannot route task context.",
      }),
    );

    const inferred = run(
      contextArgs(workspace, ["--target", "file:src/payments/proposed.ts"]),
      1,
    );
    assert.equal(JSON.parse(inferred.stderr).error.code, "CONTEXT_SCOPE_AMBIGUOUS");

    const explicit = context(workspace, [
      "--scope",
      "workspace",
      "--target",
      "file:src/payments/proposed.ts",
    ]);
    assert.deepEqual(explicit.sourceMap.unboundTargets, [
      { kind: "file", ref: "src/payments/proposed.ts" },
    ]);
    assert.equal(
      [...explicit.lanes.mandatory, ...explicit.lanes.working, ...explicit.lanes.evidence]
        .some((item) => item.sourceId === "decision-proposed-payment-binding"),
      false,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("custom hub sections remain eligible and known mode omissions are explicit", async () => {
  const workspace = await temporaryWorkspace();
  try {
    await setup(workspace);
    await writeNote(
      workspace,
      "knowledge/projects/workspace.md",
      currentNote({
        id: "project-workspace",
        kind: "project",
        body: `## Status

- Custom security status must survive implement-mode selection.

## Expansion links

- [[knowledge/concepts/not-needed-now]]`,
      }),
    );

    const result = context(workspace, [
      "--scope",
      "workspace",
      "--mode",
      "implement",
    ]);
    assert.match(result.renderedContext, /Custom security status must survive/u);
    assert.ok(
      result.sourceMap.omitted.some(
        (item) =>
          item.id === "project-workspace#expansion-links" &&
          item.reason === "mode_filter",
      ),
    );
    assert.ok(result.sourceMap.omittedTotal >= 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("hub parsing normalizes ATX headings, ignores fences, and preserves fragment bytes", async () => {
  const workspace = await temporaryWorkspace();
  try {
    await setup(workspace);
    await writeNote(
      workspace,
      "knowledge/projects/workspace.md",
      currentNote({
        id: "project-workspace",
        kind: "project",
        body: `\`\`\`markdown
## Hard constraints

- Fenced example is not governance.
\`\`\`

## Hard   constraints ##

- Preserve this required line with a Markdown break.${"  "}

## Hard constraints

- A repeated heading receives a distinct provenance identity.

## Current   state ##

- Active.`,
      }),
    );

    const result = context(workspace, ["--scope", "workspace", "--mode", "implement"]);
    const hubMandatory = result.lanes.mandatory.filter(
      (item) => item.sourceId === "project-workspace",
    );
    assert.deepEqual(
      hubMandatory.map((item) => item.fragment),
      ["hard-constraints", "hard-constraints-2"],
    );
    assert.ok(
      result.lanes.working.some(
        (item) =>
          item.sourceId === "project-workspace" &&
          item.fragment === "current-state",
      ),
    );
    assert.match(
      result.renderedContext,
      /Preserve this required line with a Markdown break\.  \n/u,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("long valid targets keep lexical discovery within its separate query ceiling", async () => {
  const workspace = await temporaryWorkspace();
  try {
    await setup(workspace);
    const path = Array.from(
      { length: 32 },
      (_, index) => `segment${String(index).padStart(2, "0")}${"x".repeat(112)}`,
    ).join("/");
    assert.ok([...path].length < 4_096);

    const result = context(workspace, [
      "--scope",
      "workspace",
      "--target",
      `file:${path}`,
    ]);
    assert.ok([...result.discovery.lexicalQuery].length <= 2_048);
    assert.equal(result.sourceMap.unboundTargets.length, 1);
    assert.equal(result.sourceMap.unboundTargets[0].kind, "file");
    assert.equal(result.sourceMap.unboundTargets[0].refTruncated, true);
    assert.equal(result.sourceMap.unboundTargets[0].refCharacters, [...path].length);
    assert.match(result.sourceMap.unboundTargets[0].ref, /^sha256:/u);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("long target-match provenance remains distinct and request-linked", async () => {
  const workspace = await temporaryWorkspace();
  try {
    await setup(workspace);
    const common = `src/${"a".repeat(230)}/${"b".repeat(230)}/${"c".repeat(100)}`;
    const paths = [`${common}/one.ts`, `${common}/two.ts`];
    await writeNote(
      workspace,
      "knowledge/concepts/long-targets.md",
      currentNote({
        id: "concept-long-targets",
        kind: "concept",
        appliesTo: paths.map((path) => `file:${path}`),
        body: "Both long targets apply to this bounded concept.",
      }),
    );

    const result = context(workspace, [
      "--scope",
      "workspace",
      ...paths.flatMap((path) => ["--target", `file:${path}`]),
      "--budget",
      "standard",
    ]);
    const selected = result.lanes.working.find(
      (item) => item.sourceId === "concept-long-targets",
    );
    assert.ok(selected);
    const matchDigests = selected.targetMatches.map((item) => item.normalizedTargetRef);
    const requestDigests = result.request.targets.map((item) => item.normalizedRef);
    assert.equal(new Set(matchDigests).size, 2);
    assert.deepEqual([...matchDigests].sort(), [...requestDigests].sort());
    assert.ok(matchDigests.every((value) => value.startsWith("sha256:")));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("legacy untyped applies_to warns but never gains typed selection authority", async () => {
  const workspace = await temporaryWorkspace();
  try {
    await setup(workspace);
    await writeNote(
      workspace,
      "knowledge/concepts/legacy-binding.md",
      currentNote({
        id: "concept-legacy-binding",
        kind: "concept",
        appliesTo: ["src/auth/session.ts"],
        body: "Authentication token rotation evidence controls for the legacy binding.",
      }),
    );

    const result = context(workspace, [
      "--scope",
      "workspace",
      "--target",
      "file:src/auth/session.ts",
    ]);
    const warning = result.warnings.find((item) => item.code === "CONTEXT_BINDING_UNTYPED");
    assert.ok(warning);
    assert.ok(
      warning.details.examples.some((item) => item.path === "knowledge/concepts/legacy-binding.md"),
    );
    const selected = result.lanes.working.find(
      (item) => item.sourceId === "concept-legacy-binding",
    );
    assert.ok(selected, "lexical discovery may still include the legacy note as working context");
    assert.deepEqual(selected.targetMatches ?? [], []);
    assert.equal(selected.reasons.includes("target_binding"), false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("binding warnings report bounded examples with complete population counts", async () => {
  const workspace = await temporaryWorkspace();
  try {
    await setup(workspace);
    await Promise.all(
      Array.from({ length: 22 }, (_, index) =>
        writeNote(
          workspace,
          `knowledge/concepts/legacy-binding-${String(index).padStart(2, "0")}.md`,
          currentNote({
            id: `concept-legacy-binding-${String(index).padStart(2, "0")}`,
            kind: "concept",
            appliesTo: [`legacy/path-${String(index).padStart(2, "0")}.ts`],
            body: "Legacy binding warning evidence.",
          }),
        )),
    );

    const result = context(workspace, [
      "--scope",
      "workspace",
      "--target",
      "file:src/unbound.ts",
      "--budget",
      "deep",
    ]);
    const warning = result.warnings.find(
      (item) => item.code === "CONTEXT_BINDING_UNTYPED",
    );
    assert.ok(warning);
    assert.equal(warning.details.matchingNotes, 22);
    assert.equal(warning.details.matchingBindings, 22);
    assert.equal(warning.details.examples.length, 20);
    assert.equal(warning.details.examplesTruncated, true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("history mode can expose explicitly searched unpromoted evidence without promoting it", async () => {
  const workspace = await temporaryWorkspace();
  try {
    await setup(workspace);
    await writeNote(
      workspace,
      "knowledge/sessions/legacy-rotation.md",
      legacyNote({
        id: "legacy-rotation",
        body: "Legacy authentication token rotation evidence controls used a manual ledger.",
      }),
    );

    const ordinary = context(workspace, ["--mode", "implement"]);
    assert.equal(
      ordinary.lanes.evidence.some((item) => item.sourceId === "legacy-rotation"),
      false,
    );

    const history = context(workspace, ["--mode", "history"]);
    const selected = history.lanes.evidence.find((item) => item.sourceId === "legacy-rotation");
    assert.ok(selected);
    assert.equal(selected.authorityClass, "unpromoted");
    assert.ok(selected.reasons.includes("explicit_history_unpromoted"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("authority conflicts are represented as controlled mandatory metadata", async () => {
  const workspace = await temporaryWorkspace();
  try {
    await setup(workspace);
    for (const [suffix, body] of [["one", "Use one rotation window."], ["two", "Use two rotation windows."]]) {
      await writeNote(
        workspace,
        `knowledge/decisions/conflict-${suffix}.md`,
        currentNote({
          id: `decision-conflict-${suffix}`,
          kind: "decision",
          decisionKey: "auth.rotation-window",
          body,
        }),
      );
    }

    const result = context(workspace, ["--scope", "workspace"]);
    const conflicts = result.lanes.mandatory.filter((item) => item.kind === "conflict");
    assert.ok(conflicts.length >= 2);
    assert.ok(conflicts.every((item) => item.reasons.includes("unresolved_authority_conflict")));
    assert.ok(result.sourceMap.conflicting.length >= 2);
    assert.match(result.renderedContext, /Conflict code: AUTH002/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("more than 32 unresolved authority conflicts fail visibly", async () => {
  const workspace = await temporaryWorkspace();
  try {
    await setup(workspace);
    await Promise.all(
      Array.from({ length: 33 }, (_, index) =>
        writeNote(
          workspace,
          `knowledge/decisions/conflict-${String(index).padStart(2, "0")}.md`,
          currentNote({
            id: `decision-conflict-${String(index).padStart(2, "0")}`,
            kind: "decision",
            decisionKey: "auth.excessive-conflicts",
            body: `Conflicting authentication policy ${index}.`,
          }),
        )),
    );

    const failed = run(contextArgs(workspace, ["--scope", "workspace"]), 1);
    const error = JSON.parse(failed.stderr);
    assert.equal(error.error.code, "CONTEXT_LIMIT_EXCEEDED");
    assert.equal(error.error.details.conflicts, 33);
    assert.equal(error.error.details.limit, 32);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("massive source_refs metadata stays compact and reports the exact serialized size", async () => {
  const workspace = await temporaryWorkspace();
  try {
    await setup(workspace);
    const sourceRefs = Array.from(
      { length: 240 },
      (_, index) => `evidence-${String(index).padStart(3, "0")}-${"x".repeat(215)}`,
    );
    await writeNote(
      workspace,
      "knowledge/concepts/source-ref-pressure.md",
      currentNote({
        id: "concept-source-ref-pressure",
        kind: "concept",
        appliesTo: ["file:src/auth/session.ts"],
        sourceRefs,
        body: "Authentication token rotation evidence controls remain bounded.",
      }),
    );

    const result = run(contextArgs(workspace, [
      "--scope",
      "workspace",
      "--target",
      "file:src/auth/session.ts",
      "--budget",
      "standard",
    ]));
    const report = JSON.parse(result.stdout);
    const serializedCharacters = [...result.stdout].length;
    const selected = report.lanes.working.find(
      (item) => item.sourceId === "concept-source-ref-pressure",
    );

    assert.ok(selected);
    assert.equal(selected.sourceRefs.length, 4);
    assert.equal(selected.sourceRefsTotal, 240);
    assert.equal(selected.sourceRefsTruncated, true);
    assert.equal(report.outputBudget.serializedCharacters, serializedCharacters);
    assert.ok(serializedCharacters <= report.outputBudget.maximumCharacters);
    assert.equal(result.stdout.includes("evidence-239-"), false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("ineligible linked notes do not consume the bounded graph-neighbor allowance", async () => {
  const workspace = await temporaryWorkspace();
  try {
    await setup(workspace);
    const unusableLinks = Array.from(
      { length: 64 },
      (_, index) => `[[knowledge/decisions/a-unusable-${String(index).padStart(2, "0")}]]`,
    );
    await writeNote(
      workspace,
      "knowledge/projects/workspace.md",
      currentNote({
        id: "project-workspace",
        kind: "project",
        body: "## Current state\n\n- Active.\n\n## Active accepted decisions\n\n- [[knowledge/decisions/00-neighbor-seed]]",
      }),
    );
    await writeNote(
      workspace,
      "knowledge/decisions/00-neighbor-seed.md",
      currentNote({
        id: "decision-neighbor-seed",
        kind: "decision",
        decisionKey: "graph.neighbor-seed",
        body: [...unusableLinks, "[[knowledge/references/z-eligible-neighbor]]"].join("\n"),
      }),
    );
    await Promise.all(
      Array.from({ length: 64 }, (_, index) =>
        writeNote(
          workspace,
          `knowledge/decisions/a-unusable-${String(index).padStart(2, "0")}.md`,
          currentNote({
            id: `decision-unusable-${String(index).padStart(2, "0")}`,
            kind: "decision",
            state: "proposed",
            decisionKey: `graph.unusable-${String(index).padStart(2, "0")}`,
            body: "Proposed decision is not a graph-neighbor publication candidate.",
          }),
        )),
    );
    await writeNote(
      workspace,
      "knowledge/references/z-eligible-neighbor.md",
      currentNote({
        id: "reference-eligible-neighbor",
        kind: "reference",
        body: "Opaque supporting record selected only through its graph edge.",
      }),
    );

    const result = context(workspace, ["--scope", "workspace", "--budget", "deep"]);
    const eligible = result.lanes.evidence.find(
      (item) => item.sourceId === "reference-eligible-neighbor",
    );
    assert.ok(eligible);
    assert.ok(eligible.reasons.includes("bounded_graph_neighbor"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a hostile metadata report that exceeds the total ceiling fails visibly", async () => {
  const workspace = await temporaryWorkspace();
  try {
    await setup(workspace);
    await Promise.all(
      Array.from({ length: 20 }, (_, noteIndex) =>
        writeNote(
          workspace,
          `knowledge/concepts/untyped-pressure-${String(noteIndex).padStart(2, "0")}.md`,
          currentNote({
            id: `concept-untyped-pressure-${String(noteIndex).padStart(2, "0")}`,
            kind: "concept",
            appliesTo: Array.from(
              { length: 10 },
              (_, bindingIndex) =>
                `legacy-${String(noteIndex).padStart(2, "0")}-${String(bindingIndex).padStart(2, "0")}-${"z".repeat(210)}`,
            ),
            body: "Opaque record.",
          }),
        )),
    );

    const failed = run(contextArgs(workspace, [
      "--scope",
      "workspace",
      "--target",
      "file:src/hostile.ts",
      "--budget",
      "lean",
    ]), 1);
    const error = JSON.parse(failed.stderr);
    assert.equal(error.error.code, "CONTEXT_OUTPUT_EXCEEDED");
    assert.ok(error.error.details.serializedCharacters > error.error.details.maximumCharacters);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("evidence is reserved before a larger optional working note consumes the lean budget", async () => {
  const workspace = await temporaryWorkspace();
  try {
    await setup(workspace);
    await writeNote(
      workspace,
      "knowledge/concepts/large-working.md",
      currentNote({
        id: "concept-large-working",
        kind: "concept",
        appliesTo: ["file:src/auth/session.ts"],
        body: `Authentication token rotation working model ${"working-material ".repeat(270)}`,
      }),
    );
    await writeNote(
      workspace,
      "knowledge/references/small-evidence.md",
      currentNote({
        id: "reference-small-evidence",
        kind: "reference",
        appliesTo: ["file:src/auth/session.ts"],
        body: `Authentication token rotation evidence controls ${"audit-proof ".repeat(20)}`,
      }),
    );

    const result = context(workspace, [
      "--scope",
      "workspace",
      "--target",
      "file:src/auth/session.ts",
      "--budget",
      "lean",
    ]);
    assert.ok(result.lanes.evidence.some((item) => item.sourceId === "reference-small-evidence"));
    assert.equal(
      result.lanes.working.some((item) => item.sourceId === "concept-large-working"),
      false,
    );
    assert.ok(
      result.sourceMap.omitted.some(
        (item) => item.sourceId === "concept-large-working" && item.reason === "character_budget",
      ),
    );
    assert.ok(result.budget.usedCharacters <= result.budget.maximumCharacters);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("text rendering escapes terminal controls and bidi overrides from selected note content", async () => {
  const workspace = await temporaryWorkspace();
  try {
    await setup(workspace);
    const escape = "\u001b";
    const override = "\u202e";
    await writeNote(
      workspace,
      "knowledge/projects/workspace.md",
      currentNote({
        id: "project-workspace",
        kind: "project",
        body: `## Current state\n\n- Authentication ${escape}[31mRED${escape}[0m ${override}spoofed.`,
      }),
    );

    const rendered = run(contextArgs(workspace, [], "text")).stdout;
    const json = context(workspace);
    assert.equal(rendered.includes(escape), false);
    assert.equal(rendered.includes(override), false);
    assert.match(rendered, /\\u001b\[31mRED\\u001b\[0m/);
    assert.match(rendered, /\\u202espoofed/);
    assert.ok([...rendered].length <= json.outputBudget.maximumCharacters);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
