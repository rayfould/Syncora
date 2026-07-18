import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { parseArgv } from "../../skills/syncora/scripts/lib/cli.mjs";
import {
  checkChangedWorkspace,
  parseDriftObservationPayload,
} from "../../skills/syncora/scripts/lib/drift-check.mjs";
import {
  driftStatePaths,
  readDriftFinding,
  readDriftObservation,
  readDriftRefresh,
  readDriftState,
  resolveDriftArtifactPath,
  sealDriftFinding,
  sealDriftObservation,
  sealDriftRefresh,
} from "../../skills/syncora/scripts/lib/drift-state.mjs";
import { resolveGovernedEnvironment } from "../../skills/syncora/scripts/lib/governed-environment.mjs";
import { initializeWorkspace } from "../../skills/syncora/scripts/lib/init.mjs";
import { withPatchLock } from "../../skills/syncora/scripts/lib/patch-lock.mjs";

async function temporaryDirectory(t, prefix = "syncora-drift-check-") {
  const path = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function commandOptions(command, workspace, extra = []) {
  return parseArgv([
    command,
    "--workspace",
    workspace,
    ...extra,
  ]).options;
}

async function initializedWorkspace(t, options = {}) {
  const workspace = await temporaryDirectory(t);
  let graph = join(workspace, "local");
  const extra = ["--no-patch-agents"];
  if (options.externalGraph) {
    graph = options.externalGraph;
    await symlink(
      graph,
      join(workspace, "local"),
      process.platform === "win32" ? "junction" : "dir",
    );
    extra.push("--allow-external-graph-root", graph);
  }
  await initializeWorkspace(commandOptions("init", workspace, extra));
  return { workspace, graph: await realpath(graph) };
}

async function attachInitializedWorkspace(t, externalGraph, initializedSource) {
  const workspace = await temporaryDirectory(t);
  const config = await readFile(join(initializedSource, ".syncora", "config.json"));
  await symlink(
    externalGraph,
    join(workspace, "local"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await Promise.all([
    write(
      join(workspace, ".syncora", "config.json"),
      config,
    ),
    write(
      join(workspace, ".syncora", "local.json"),
      `${JSON.stringify({ schemaVersion: 1, externalGraphRoots: [externalGraph] })}\n`,
    ),
  ]);
  return { workspace, graph: await realpath(externalGraph) };
}

async function write(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}

function noteText({
  id,
  kind = "concept",
  state = "active",
  authority = "canonical",
  appliesTo = [],
  schemaVersion = 1,
}) {
  return [
    "---",
    `id: ${id}`,
    `kind: ${kind}`,
    "scope: workspace",
    `state: ${state}`,
    `authority: ${authority}`,
    ...(schemaVersion === null ? [] : [`schema_version: ${schemaVersion}`]),
    "created: 2026-07-18",
    "updated: 2026-07-18",
    `summary: ${JSON.stringify(`Drift contract fixture for ${id}.`)}`,
    `applies_to: ${appliesTo.length === 0 ? "[]" : ""}`,
    ...appliesTo.map((item) => `  - ${JSON.stringify(item)}`),
    "source_refs: []",
    "---",
    "",
    `# ${id}`,
    "",
    `Canonical fixture body for ${id}.`,
    "",
  ].join("\n");
}

async function addNote(graph, filename, values) {
  const path = join(graph, "knowledge", "concepts", filename);
  await write(path, noteText(values));
  return path;
}

function checkOptions(workspace, extra = []) {
  return commandOptions("check", workspace, ["--changed", ...extra]);
}

async function stateContext(workspace, extra = []) {
  const options = checkOptions(workspace, extra);
  const environment = await resolveGovernedEnvironment(options);
  const state = await readDriftState({
    graphRoot: environment.graphRoot,
    workspaceIdentity: environment.workspaceIdentity,
    graphRootIdentity: environment.graphRootIdentity,
    policyRevision: environment.policyRevision,
  });
  return { environment, state };
}

async function activeFinding(environment, entry) {
  return readDriftFinding({
    graphRoot: environment.graphRoot,
    workspaceIdentity: environment.workspaceIdentity,
    graphRootIdentity: environment.graphRootIdentity,
    policyRevision: environment.policyRevision,
    id: entry.findingId,
  });
}

async function writeDriftArtifact(graph, workspaceIdentity, kind, artifact) {
  await write(
    resolveDriftArtifactPath({
      graphRoot: graph,
      workspaceIdentity,
      kind,
      id: artifact.id,
    }),
    artifact.bytes,
  );
}

async function rebindDriftStatePolicy({ graph, environment, state, policyRevision }) {
  const observationReferences = new Map();
  if (state.latestObservation) {
    observationReferences.set(
      state.latestObservation.observationId,
      {
        id: state.latestObservation.observationId,
        digest: state.latestObservation.observationDigest,
      },
    );
  }
  const active = [];
  for (const entry of state.activeFindings) {
    const finding = await readDriftFinding({
      graphRoot: graph,
      workspaceIdentity: environment.workspaceIdentity,
      graphRootIdentity: environment.graphRootIdentity,
      policyRevision: state.policyRevision,
      id: entry.findingId,
    });
    const refresh = await readDriftRefresh({
      graphRoot: graph,
      workspaceIdentity: environment.workspaceIdentity,
      graphRootIdentity: environment.graphRootIdentity,
      policyRevision: state.policyRevision,
      id: entry.refreshId,
    });
    assert.ok(finding);
    assert.ok(refresh);
    for (const reference of [
      finding.payload.observationBefore,
      finding.payload.observationCurrent,
    ]) {
      observationReferences.set(reference.id, reference);
    }
    active.push({ entry, finding, refresh });
  }

  const observations = new Map();
  for (const reference of observationReferences.values()) {
    const observation = await readDriftObservation({
      graphRoot: graph,
      workspaceIdentity: environment.workspaceIdentity,
      graphRootIdentity: environment.graphRootIdentity,
      policyRevision: state.policyRevision,
      id: reference.id,
    });
    assert.ok(observation);
    assert.equal(observation.digest, reference.digest);
    const rebound = sealDriftObservation({
      workspaceIdentity: environment.workspaceIdentity,
      graphRootIdentity: environment.graphRootIdentity,
      policyRevision,
      payload: observation.payload,
    });
    await writeDriftArtifact(
      graph,
      environment.workspaceIdentity,
      "observation",
      rebound,
    );
    observations.set(reference.id, rebound);
  }

  const reboundActive = [];
  for (const { entry, finding, refresh } of active) {
    const before = observations.get(finding.payload.observationBefore.id);
    const current = observations.get(finding.payload.observationCurrent.id);
    assert.ok(before);
    assert.ok(current);
    const reboundFinding = sealDriftFinding({
      workspaceIdentity: environment.workspaceIdentity,
      graphRootIdentity: environment.graphRootIdentity,
      policyRevision,
      payload: {
        ...finding.payload,
        observationBefore: { id: before.id, digest: before.digest },
        observationCurrent: { id: current.id, digest: current.digest },
      },
    });
    await writeDriftArtifact(
      graph,
      environment.workspaceIdentity,
      "finding",
      reboundFinding,
    );
    const reboundReference = {
      id: reboundFinding.id,
      digest: reboundFinding.digest,
    };
    const reboundRefresh = sealDriftRefresh({
      workspaceIdentity: environment.workspaceIdentity,
      graphRootIdentity: environment.graphRootIdentity,
      policyRevision,
      payload: {
        ...refresh.payload,
        finding: reboundReference,
        requiredSourceRefs: refresh.payload.requiredSourceRefs.map((source) =>
          source.type === "drift-finding"
            ? {
                ...source,
                ref: reboundFinding.id,
                expectedSha256: reboundFinding.digest,
              }
            : source),
      },
    });
    await writeDriftArtifact(
      graph,
      environment.workspaceIdentity,
      "refresh",
      reboundRefresh,
    );
    reboundActive.push({
      entry: {
        ...entry,
        findingId: reboundFinding.id,
        findingDigest: reboundFinding.digest,
        refreshId: reboundRefresh.id,
        refreshDigest: reboundRefresh.digest,
      },
      finding: reboundFinding,
      refresh: reboundRefresh,
    });
  }

  const latest = state.latestObservation === null
    ? null
    : observations.get(state.latestObservation.observationId);
  const reboundState = {
    ...state,
    policyRevision,
    latestObservation: latest === null
      ? null
      : {
          observationId: latest.id,
          observationDigest: latest.digest,
        },
    activeFindings: reboundActive.map(({ entry }) => entry),
  };
  await writeFile(
    driftStatePaths(graph, environment.workspaceIdentity).statePath,
    `${JSON.stringify(reboundState)}\n`,
    "utf8",
  );
  return { state: reboundState, active: reboundActive, observations };
}

async function replaceReboundActiveFinding({
  graph,
  environment,
  rebound,
  policyRevision,
  payload,
}) {
  assert.equal(rebound.active.length, 1);
  const prior = rebound.active[0];
  const finding = sealDriftFinding({
    workspaceIdentity: environment.workspaceIdentity,
    graphRootIdentity: environment.graphRootIdentity,
    policyRevision,
    payload,
  });
  await writeDriftArtifact(
    graph,
    environment.workspaceIdentity,
    "finding",
    finding,
  );
  const refresh = sealDriftRefresh({
    workspaceIdentity: environment.workspaceIdentity,
    graphRootIdentity: environment.graphRootIdentity,
    policyRevision,
    payload: {
      ...prior.refresh.payload,
      finding: { id: finding.id, digest: finding.digest },
      requiredSourceRefs: prior.refresh.payload.requiredSourceRefs.map((source) =>
        source.type === "drift-finding"
          ? {
              ...source,
              ref: finding.id,
              expectedSha256: finding.digest,
            }
          : source),
    },
  });
  await writeDriftArtifact(
    graph,
    environment.workspaceIdentity,
    "refresh",
    refresh,
  );
  const state = {
    ...rebound.state,
    activeFindings: [{
      ...prior.entry,
      findingId: finding.id,
      findingDigest: finding.digest,
      refreshId: refresh.id,
      refreshDigest: refresh.digest,
    }],
  };
  await writeFile(
    driftStatePaths(graph, environment.workspaceIdentity).statePath,
    `${JSON.stringify(state)}\n`,
    "utf8",
  );
  return { state, finding, refresh };
}

async function treeManifest(root) {
  const records = [];
  async function walk(path) {
    const entries = await readdir(path, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const full = join(path, entry.name);
      const portable = relative(root, full).replaceAll("\\", "/");
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        records.push(`directory:${portable}`);
        await walk(full);
      } else if (entry.isFile()) {
        const bytes = await readFile(full);
        records.push(
          `file:${portable}:sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        );
      } else {
        records.push(`link:${portable}`);
      }
    }
  }
  await walk(root);
  return records;
}

test("the first check establishes an honest baseline and file, module, and glob changes create exact findings without mutating Markdown", async (t) => {
  const { workspace, graph } = await initializedWorkspace(t);
  const sources = {
    file: join(workspace, "src", "app.ts"),
    module: join(workspace, "src", "auth", "token.ts"),
    glob: join(workspace, "tests", "auth.test.ts"),
  };
  await Promise.all([
    write(sources.file, "export const app = 1;\n"),
    write(sources.module, "export const token = 1;\n"),
    write(sources.glob, "export const testCase = 1;\n"),
    addNote(graph, "file-bound.md", {
      id: "concept-file-bound",
      appliesTo: ["file:src/app.ts"],
    }),
    addNote(graph, "module-bound.md", {
      id: "concept-module-bound",
      appliesTo: ["module:src/auth"],
    }),
    addNote(graph, "glob-bound.md", {
      id: "concept-glob-bound",
      appliesTo: ["path_glob:tests/*.test.ts"],
    }),
  ]);
  const markdownBefore = await Promise.all([
    readFile(join(graph, "knowledge", "concepts", "file-bound.md")),
    readFile(join(graph, "knowledge", "concepts", "module-bound.md")),
    readFile(join(graph, "knowledge", "concepts", "glob-bound.md")),
  ]);

  const baseline = await checkChangedWorkspace(checkOptions(workspace));
  assert.equal(baseline.state, "baseline-established");
  assert.deepEqual(baseline.summary, {
    changedPaths: 0,
    renames: 0,
    affectedNotes: 0,
    activeFindings: 0,
    newFindings: 0,
    resolvedFindings: 0,
    trackedNotes: 3,
    trackedBindings: 3,
    trackedFiles: 3,
  });
  assert.deepEqual(baseline.findings, []);

  await Promise.all([
    writeFile(sources.file, "export const app = 2;\n"),
    writeFile(sources.module, "export const token = 2;\n"),
    writeFile(sources.glob, "export const testCase = 2;\n"),
  ]);
  const changed = await checkChangedWorkspace(checkOptions(workspace));
  assert.equal(changed.state, "findings-created");
  assert.equal(changed.summary.changedPaths, 3);
  assert.equal(changed.summary.affectedNotes, 3);
  assert.equal(changed.summary.activeFindings, 3);
  assert.equal(changed.findings.length, 3);
  assert.deepEqual(
    changed.findings.map((finding) => finding.note.path).sort(),
    [
      "knowledge/concepts/file-bound.md",
      "knowledge/concepts/glob-bound.md",
      "knowledge/concepts/module-bound.md",
    ],
  );
  const changedState = await stateContext(workspace);
  const exactFindings = await Promise.all(
    changedState.state.activeFindings.map((entry) =>
      activeFinding(changedState.environment, entry)),
  );
  assert.ok(exactFindings.every((finding) =>
    finding.payload.changedSources.length === 1 &&
    finding.payload.changedSources[0].change === "modified"));
  const markdownAfter = await Promise.all([
    readFile(join(graph, "knowledge", "concepts", "file-bound.md")),
    readFile(join(graph, "knowledge", "concepts", "module-bound.md")),
    readFile(join(graph, "knowledge", "concepts", "glob-bound.md")),
  ]);
  assert.deepEqual(markdownAfter, markdownBefore);
});

test("observation artifacts normalize shared evidence and reject false catalog fingerprints", async (t) => {
  const { workspace, graph } = await initializedWorkspace(t);
  await Promise.all([
    write(join(workspace, "src", "shared", "a.ts"), "a\n"),
    write(join(workspace, "src", "shared", "b.ts"), "b\n"),
    addNote(graph, "shared-a.md", {
      id: "concept-shared-a",
      appliesTo: ["module:src/shared"],
    }),
    addNote(graph, "shared-b.md", {
      id: "concept-shared-b",
      appliesTo: ["module:src/shared"],
    }),
  ]);
  await checkChangedWorkspace(checkOptions(workspace));
  const { environment, state } = await stateContext(workspace);
  const observation = await readDriftObservation({
    graphRoot: environment.graphRoot,
    workspaceIdentity: environment.workspaceIdentity,
    graphRootIdentity: environment.graphRootIdentity,
    policyRevision: environment.policyRevision,
    id: state.latestObservation.observationId,
  });
  assert.equal(observation.payload.files.length, 2);
  assert.equal(observation.payload.bindings.length, 1);
  assert.equal(observation.payload.notes.length, 2);
  assert.deepEqual(
    observation.payload.notes.map((note) => note.bindings),
    [["module:src/shared"], ["module:src/shared"]],
  );
  const scaleNotes = Array.from({ length: 10_000 }, (_, index) => ({
    ...observation.payload.notes[0],
    path: `knowledge/concepts/scale-${String(index).padStart(5, "0")}.md`,
  }));
  const scalePayload = {
    ...observation.payload,
    notes: scaleNotes,
    coverage: {
      ...observation.payload.coverage,
      eligibleNotes: 10_000,
      trackedNotes: 10_000,
    },
  };
  const parsedScale = parseDriftObservationPayload(scalePayload);
  assert.equal(parsedScale.notes.length, 10_000);
  assert.equal(parsedScale.bindings.length, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(scalePayload)) < 16_777_216);
  assert.throws(
    () => parseDriftObservationPayload({
      ...observation.payload,
      bindings: [{
        ...observation.payload.bindings[0],
        fingerprint: `sha256:${"f".repeat(64)}`,
      }],
    }),
    (error) => error?.code === "DRIFT001",
  );
  assert.throws(
    () => parseDriftObservationPayload({
      ...observation.payload,
      files: [...observation.payload.files].reverse(),
    }),
    (error) => error?.code === "DRIFT001",
  );
});

test("module observations report exact added, deleted, and unambiguous renamed source evidence", async (t) => {
  const { workspace, graph } = await initializedWorkspace(t);
  const root = join(workspace, "src", "assets");
  await Promise.all([
    write(join(root, "deleted.txt"), "delete me\n"),
    write(join(root, "old.txt"), "rename me exactly\n"),
    addNote(graph, "assets.md", {
      id: "concept-assets",
      appliesTo: ["module:src/assets"],
    }),
  ]);
  await checkChangedWorkspace(checkOptions(workspace));

  await Promise.all([
    rm(join(root, "deleted.txt")),
    rename(join(root, "old.txt"), join(root, "renamed.txt")),
    write(join(root, "added.txt"), "new source\n"),
  ]);
  const result = await checkChangedWorkspace(checkOptions(workspace));
  assert.equal(result.state, "findings-created");
  assert.equal(result.summary.changedPaths, 4);
  assert.equal(result.summary.renames, 1);
  const { environment, state } = await stateContext(workspace);
  assert.equal(state.activeFindings.length, 1);
  const finding = await activeFinding(environment, state.activeFindings[0]);
  assert.deepEqual(
    finding.payload.changedSources.map((source) => ({
      path: source.path,
      change: source.change,
      renamedFrom: source.renamedFrom,
    })),
    [
      { path: "src/assets/added.txt", change: "added", renamedFrom: null },
      { path: "src/assets/deleted.txt", change: "deleted", renamedFrom: null },
      { path: "src/assets/renamed.txt", change: "renamed", renamedFrom: "src/assets/old.txt" },
    ],
  );
});

test("later source evolution supersedes one active finding with one cumulative actionable head", async (t) => {
  const { workspace, graph } = await initializedWorkspace(t);
  const source = join(workspace, "src", "state.ts");
  await Promise.all([
    write(source, "export const state = 1;\n"),
    addNote(graph, "state.md", {
      id: "concept-state",
      appliesTo: ["file:src/state.ts"],
    }),
  ]);
  await checkChangedWorkspace(checkOptions(workspace));
  await writeFile(source, "export const state = 2;\n");
  const first = await checkChangedWorkspace(checkOptions(workspace));
  const firstId = first.findings[0].id;
  const firstDigest = first.findings[0].digest;

  const repeated = await checkChangedWorkspace(checkOptions(workspace));
  assert.equal(repeated.state, "findings-active");
  assert.equal(repeated.summary.newFindings, 0);
  assert.deepEqual(repeated.findings.map((finding) => finding.id), [firstId]);

  await writeFile(source, "export const state = 3;\n");
  const evolved = await checkChangedWorkspace(checkOptions(workspace));
  assert.equal(evolved.state, "findings-created");
  assert.equal(evolved.summary.newFindings, 1);
  assert.equal(evolved.summary.activeFindings, 1);
  assert.equal(evolved.summary.resolvedFindings, 1);
  assert.notEqual(evolved.findings[0].id, firstId);
  const { environment, state } = await stateContext(workspace);
  const replacement = await activeFinding(environment, state.activeFindings[0]);
  assert.deepEqual(replacement.payload.supersedes, [{ id: firstId, digest: firstDigest }]);

  const stableAgain = await checkChangedWorkspace(checkOptions(workspace));
  assert.equal(stableAgain.state, "findings-active");
  assert.equal(stableAgain.summary.newFindings, 0);
  assert.equal(stableAgain.summary.activeFindings, 1);
  assert.equal(stableAgain.findings[0].id, replacement.id);
});

test("an exact source revert resolves its active finding without manufacturing reverse drift", async (t) => {
  const { workspace, graph } = await initializedWorkspace(t);
  const source = join(workspace, "src", "revert.ts");
  const original = "export const reverted = false;\n";
  await Promise.all([
    write(source, original),
    addNote(graph, "revert.md", {
      id: "concept-revert",
      appliesTo: ["file:src/revert.ts"],
    }),
  ]);
  await checkChangedWorkspace(checkOptions(workspace));
  await writeFile(source, "export const reverted = true;\n");
  const changed = await checkChangedWorkspace(checkOptions(workspace));
  assert.equal(changed.summary.activeFindings, 1);

  await writeFile(source, original);
  const reverted = await checkChangedWorkspace(checkOptions(workspace));
  assert.equal(reverted.state, "current");
  assert.equal(reverted.summary.resolvedFindings, 1);
  assert.equal(reverted.summary.newFindings, 0);
  assert.equal(reverted.summary.activeFindings, 0);
});

test("acknowledgement requires the exact active finding digest and never edits its canonical note", async (t) => {
  const { workspace, graph } = await initializedWorkspace(t);
  const source = join(workspace, "src", "ack.ts");
  const note = await addNote(graph, "ack.md", {
    id: "concept-ack",
    appliesTo: ["file:src/ack.ts"],
  });
  await write(source, "export const ack = 1;\n");
  await checkChangedWorkspace(checkOptions(workspace));
  await writeFile(source, "export const ack = 2;\n");
  const changed = await checkChangedWorkspace(checkOptions(workspace));
  const finding = changed.findings[0];
  const noteBefore = await readFile(note);

  await assert.rejects(
    checkChangedWorkspace(checkOptions(workspace, [
      "--acknowledge-current",
      finding.id,
      "--finding-digest",
      `sha256:${"0".repeat(64)}`,
      "--reason",
      "Reviewed against the implementation.",
    ])),
    (error) => error?.code === "DRIFT008",
  );
  assert.equal((await stateContext(workspace)).state.activeFindings.length, 1);

  await writeFile(note, Buffer.concat([noteBefore, Buffer.from("\nDirect edit.\n")]));
  await assert.rejects(
    checkChangedWorkspace(checkOptions(workspace, [
      "--acknowledge-current",
      finding.id,
      "--finding-digest",
      finding.digest,
      "--reason",
      "Reviewed against the implementation.",
    ])),
    (error) =>
      error?.code === "PROPOSAL003" &&
      /canonical note changed, moved, or disappeared/u.test(error.message),
  );
  assert.equal((await stateContext(workspace)).state.activeFindings.length, 1);
  await writeFile(note, noteBefore);

  const acknowledged = await checkChangedWorkspace(checkOptions(workspace, [
    "--acknowledge-current",
    finding.id,
    "--finding-digest",
    finding.digest,
    "--reason",
    "Reviewed against the implementation.",
  ]));
  assert.equal(acknowledged.state, "acknowledged-current");
  assert.equal(acknowledged.summary.activeFindings, 0);
  assert.equal((await stateContext(workspace)).state.activeFindings.length, 0);
  assert.deepEqual(await readFile(note), noteBefore);
});

test("legacy, ineligible, untyped, and symbol-only bindings never gain automatic selection authority", async (t) => {
  const { workspace, graph } = await initializedWorkspace(t);
  await Promise.all([
    write(join(workspace, "src", "legacy.ts"), "legacy v1\n"),
    write(join(workspace, "src", "session.ts"), "session v1\n"),
    write(join(workspace, "src", "symbol.ts"), "symbol v1\n"),
    addNote(graph, "legacy-schema.md", {
      id: "concept-legacy-schema",
      appliesTo: ["file:src/legacy.ts"],
      schemaVersion: null,
    }),
    addNote(graph, "session.md", {
      id: "session-ineligible",
      kind: "session",
      authority: "historical",
      appliesTo: ["file:src/session.ts"],
    }),
    addNote(graph, "untyped.md", {
      id: "concept-untyped",
      appliesTo: ["src/legacy.ts"],
    }),
    addNote(graph, "symbol.md", {
      id: "concept-symbol",
      appliesTo: ["symbol:buildThing", "component:ThingPanel"],
    }),
  ]);
  const baseline = await checkChangedWorkspace(checkOptions(workspace));
  assert.equal(baseline.state, "no-tracked-sources-degraded");
  assert.equal(baseline.summary.trackedNotes, 0);
  const warningCodes = baseline.warnings.map((item) => item.code);
  assert.ok(warningCodes.includes("DRIFT_BINDING_COVERAGE"));
  assert.ok(warningCodes.includes("DRIFT_BINDING_UNTYPED"));

  await Promise.all([
    writeFile(join(workspace, "src", "legacy.ts"), "legacy v2\n"),
    writeFile(join(workspace, "src", "session.ts"), "session v2\n"),
    writeFile(join(workspace, "src", "symbol.ts"), "symbol v2\n"),
  ]);
  const after = await checkChangedWorkspace(checkOptions(workspace));
  assert.equal(after.state, "completed-degraded");
  assert.equal(after.summary.newFindings, 0);
  assert.equal(after.summary.activeFindings, 0);
});

test("missing, excluded, and symbol-only coverage is visibly degraded", async (t) => {
  const missing = await initializedWorkspace(t);
  await addNote(missing.graph, "missing.md", {
    id: "concept-missing",
    appliesTo: ["file:src/does-not-exist.ts"],
  });
  const missingResult = await checkChangedWorkspace(checkOptions(missing.workspace));
  assert.equal(missingResult.state, "baseline-established-degraded");
  assert.ok(missingResult.warnings.some((entry) => entry.code === "DRIFT_SOURCE_MISSING"));

  const excluded = await initializedWorkspace(t);
  await addNote(excluded.graph, "excluded.md", {
    id: "concept-excluded",
    appliesTo: ["module:node_modules/package"],
  });
  const excludedResult = await checkChangedWorkspace(checkOptions(excluded.workspace));
  assert.equal(excludedResult.state, "baseline-established-degraded");
  assert.ok(excludedResult.warnings.some((entry) => entry.code === "DRIFT_SOURCE_EXCLUDED"));

  const symbolic = await initializedWorkspace(t);
  await addNote(symbolic.graph, "symbolic.md", {
    id: "concept-symbolic",
    appliesTo: ["symbol:RuntimeController"],
  });
  const symbolicResult = await checkChangedWorkspace(checkOptions(symbolic.workspace));
  assert.equal(symbolicResult.state, "no-tracked-sources-degraded");
  assert.ok(symbolicResult.warnings.some((entry) => entry.code === "DRIFT_BINDING_COVERAGE"));
});

test("one external graph shards drift state by exact workspace identity", async (t) => {
  const externalGraph = await temporaryDirectory(t, "syncora-drift-shared-graph-");
  let first;
  let second;
  try {
    first = await initializedWorkspace(t, { externalGraph });
    second = await attachInitializedWorkspace(t, externalGraph, first.workspace);
  } catch (error) {
    if (["EPERM", "EACCES", "ENOSYS"].includes(error?.code)) {
      t.skip(`directory links unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  await addNote(externalGraph, "shared.md", {
    id: "concept-shared",
    appliesTo: ["file:src/shared.ts"],
  });
  await Promise.all([
    write(join(first.workspace, "src", "shared.ts"), "first v1\n"),
    write(join(second.workspace, "src", "shared.ts"), "second v1\n"),
  ]);
  const allow = ["--allow-external-graph-root", externalGraph];
  await checkChangedWorkspace(checkOptions(first.workspace, allow));
  await checkChangedWorkspace(checkOptions(second.workspace, allow));
  const firstContext = await stateContext(first.workspace, allow);
  const secondContext = await stateContext(second.workspace, allow);
  assert.notEqual(firstContext.environment.workspaceIdentity, secondContext.environment.workspaceIdentity);
  assert.notEqual(
    driftStatePaths(externalGraph, firstContext.environment.workspaceIdentity).statePath,
    driftStatePaths(externalGraph, secondContext.environment.workspaceIdentity).statePath,
  );

  await writeFile(join(first.workspace, "src", "shared.ts"), "first v2\n");
  const firstChanged = await checkChangedWorkspace(checkOptions(first.workspace, allow));
  const secondCurrent = await checkChangedWorkspace(checkOptions(second.workspace, allow));
  assert.equal(firstChanged.summary.activeFindings, 1);
  assert.equal(secondCurrent.state, "current");
  assert.equal(secondCurrent.summary.activeFindings, 0);
});

test("dry-run publishes no drift authority and releases its canonical read interlock", async (t) => {
  const { workspace, graph } = await initializedWorkspace(t);
  await Promise.all([
    write(join(workspace, "src", "dry.ts"), "dry source\n"),
    addNote(graph, "dry.md", {
      id: "concept-dry",
      appliesTo: ["file:src/dry.ts"],
    }),
  ]);
  const before = await treeManifest(graph);
  const result = await checkChangedWorkspace(checkOptions(workspace, ["--dry-run"]));
  const after = await treeManifest(graph);
  assert.equal(result.state, "baseline-established-dry-run");
  const withoutInterlockScratch = (records) => records.filter(
    (record) =>
      record !== "directory:.syncora" &&
      record !== "directory:.syncora/locks",
  );
  assert.deepEqual(withoutInterlockScratch(after), withoutInterlockScratch(before));
  const environment = await resolveGovernedEnvironment(checkOptions(workspace));
  await assert.rejects(access(join(graph, ".syncora", "drift")));
  assert.deepEqual(await readdir(join(graph, ".syncora", "locks")), []);
  await assert.rejects(access(driftStatePaths(graph, environment.workspaceIdentity).statePath));
});

test("dry-run holds the canonical read interlock until its complete preview finishes", async (t) => {
  const { workspace, graph } = await initializedWorkspace(t);
  await Promise.all([
    write(join(workspace, "src", "serialized.ts"), "serialized source\n"),
    addNote(graph, "serialized.md", {
      id: "concept-serialized",
      appliesTo: ["file:src/serialized.ts"],
    }),
  ]);
  const dryRunEntered = deferred();
  const releaseDryRun = deferred();
  const writerObservedOwner = deferred();
  let sourcePaused = false;
  let writerEntered = false;
  const dryRun = checkChangedWorkspace(
    checkOptions(workspace, ["--dry-run"]),
    {
      source: {
        async beforeFileOpen() {
          if (sourcePaused) return;
          sourcePaused = true;
          dryRunEntered.resolve();
          await releaseDryRun.promise;
        },
      },
    },
  );
  await dryRunEntered.promise;
  const writer = withPatchLock(
    graph,
    async () => {
      writerEntered = true;
    },
    {
      pollMs: 5,
      timeoutMs: 5_000,
      hooks: {
        afterLiveOwnerObserved() {
          writerObservedOwner.resolve();
        },
      },
    },
  );
  try {
    await writerObservedOwner.promise;
    assert.equal(writerEntered, false);
  } finally {
    releaseDryRun.resolve();
  }
  const [result] = await Promise.all([dryRun, writer]);
  assert.equal(result.state, "baseline-established-dry-run");
  assert.equal(writerEntered, true);
  assert.deepEqual(await readdir(join(graph, ".syncora", "locks")), []);
});

test("explicit rebaseline requires retained policy-incompatible state", async (t) => {
  await t.test("no retained state", async (subtest) => {
    const { workspace, graph } = await initializedWorkspace(subtest);
    for (const dryRun of [false, true]) {
      await assert.rejects(
        checkChangedWorkspace(checkOptions(workspace, [
          "--rebaseline",
          "--reason",
          "There is no prior baseline to migrate.",
          ...(dryRun ? ["--dry-run"] : []),
        ])),
        (error) =>
          error?.code === "DRIFT_REBASELINE_NOT_REQUIRED" &&
          /without --rebaseline/u.test(error.message),
      );
    }
    const environment = await resolveGovernedEnvironment(checkOptions(workspace));
    await assert.rejects(
      access(driftStatePaths(graph, environment.workspaceIdentity).statePath),
    );
  });

  await t.test("current compatible state with an active finding", async (subtest) => {
    const { workspace, graph } = await initializedWorkspace(subtest);
    const source = join(workspace, "src", "compatible.ts");
    await Promise.all([
      write(source, "before\n"),
      addNote(graph, "compatible.md", {
        id: "concept-compatible-rebaseline",
        appliesTo: ["file:src/compatible.ts"],
      }),
    ]);
    await checkChangedWorkspace(checkOptions(workspace));
    await writeFile(source, "after\n");
    await checkChangedWorkspace(checkOptions(workspace));
    const { environment, state } = await stateContext(workspace);
    assert.equal(state.activeFindings.length, 1);
    const statePath = driftStatePaths(graph, environment.workspaceIdentity).statePath;
    const before = await readFile(statePath);

    await assert.rejects(
      checkChangedWorkspace(checkOptions(workspace, [
        "--rebaseline",
        "--reason",
        "A reason must not bypass a compatible active finding.",
      ])),
      (error) =>
        error?.code === "DRIFT_REBASELINE_NOT_REQUIRED" &&
        /current policy/u.test(error.message),
    );
    assert.deepEqual(await readFile(statePath), before);
    const retained = await readDriftState({
      graphRoot: graph,
      workspaceIdentity: environment.workspaceIdentity,
      graphRootIdentity: environment.graphRootIdentity,
      policyRevision: environment.policyRevision,
    });
    assert.equal(retained.activeFindings.length, 1);
  });
});

test("corrupt drift state fails closed and is never silently rebaselined", async (t) => {
  const { workspace, graph } = await initializedWorkspace(t);
  await Promise.all([
    write(join(workspace, "src", "corrupt.ts"), "source\n"),
    addNote(graph, "corrupt.md", {
      id: "concept-corrupt",
      appliesTo: ["file:src/corrupt.ts"],
    }),
  ]);
  await checkChangedWorkspace(checkOptions(workspace));
  const environment = await resolveGovernedEnvironment(checkOptions(workspace));
  const statePath = driftStatePaths(graph, environment.workspaceIdentity).statePath;
  const corrupt = Buffer.from("{not-json}\n", "utf8");
  await writeFile(statePath, corrupt);

  await assert.rejects(
    checkChangedWorkspace(checkOptions(workspace)),
    (error) => error?.code === "DRIFT001",
  );
  assert.deepEqual(await readFile(statePath), corrupt);
});

test("explicit rebaseline rejects prior state without its exact latest observation", async (t) => {
  const { workspace, graph } = await initializedWorkspace(t);
  await Promise.all([
    write(join(workspace, "src", "missing-observation.ts"), "source\n"),
    addNote(graph, "missing-observation.md", {
      id: "concept-missing-observation",
      appliesTo: ["file:src/missing-observation.ts"],
    }),
  ]);
  await checkChangedWorkspace(checkOptions(workspace));
  const { environment, state } = await stateContext(workspace);
  const previousPolicyRevision = `sha256:${"b".repeat(64)}`;
  const rebound = await rebindDriftStatePolicy({
    graph,
    environment,
    state,
    policyRevision: previousPolicyRevision,
  });
  const statePath = driftStatePaths(graph, environment.workspaceIdentity).statePath;
  const missingObservationState = Buffer.from(
    `${JSON.stringify({ ...rebound.state, latestObservation: null })}\n`,
    "utf8",
  );
  await writeFile(statePath, missingObservationState);

  await assert.rejects(
    checkChangedWorkspace(checkOptions(workspace, [
      "--rebaseline",
      "--reason",
      "Review a prior baseline before replacing it.",
    ])),
    (error) => error?.code === "DRIFT003" && /no latest observation/u.test(error.message),
  );
  assert.deepEqual(await readFile(statePath), missingObservationState);
});

test("explicit rebaseline rejects malformed or state-mismatched latest observation evidence", async (t) => {
  const { workspace, graph } = await initializedWorkspace(t);
  await Promise.all([
    write(join(workspace, "src", "invalid-observation.ts"), "source\n"),
    addNote(graph, "invalid-observation.md", {
      id: "concept-invalid-observation",
      appliesTo: ["file:src/invalid-observation.ts"],
    }),
  ]);
  await checkChangedWorkspace(checkOptions(workspace));
  const { environment, state: currentState } = await stateContext(workspace);
  const previousPolicyRevision = `sha256:${"c".repeat(64)}`;
  const rebound = await rebindDriftStatePolicy({
    graph,
    environment,
    state: currentState,
    policyRevision: previousPolicyRevision,
  });
  const state = rebound.state;
  const observation = await readDriftObservation({
    graphRoot: graph,
    workspaceIdentity: environment.workspaceIdentity,
    graphRootIdentity: environment.graphRootIdentity,
    policyRevision: previousPolicyRevision,
    id: state.latestObservation.observationId,
  });
  const malformed = sealDriftObservation({
    workspaceIdentity: environment.workspaceIdentity,
    graphRootIdentity: environment.graphRootIdentity,
    policyRevision: state.policyRevision,
    payload: { ...observation.payload, unexpectedSemanticField: true },
  });
  await write(
    resolveDriftArtifactPath({
      graphRoot: graph,
      workspaceIdentity: environment.workspaceIdentity,
      kind: "observation",
      id: malformed.id,
    }),
    malformed.bytes,
  );
  const statePath = driftStatePaths(graph, environment.workspaceIdentity).statePath;
  const malformedState = Buffer.from(
    `${JSON.stringify({
      ...state,
      latestObservation: {
        observationId: malformed.id,
        observationDigest: malformed.digest,
      },
    })}\n`,
    "utf8",
  );
  await writeFile(statePath, malformedState);
  await assert.rejects(
    checkChangedWorkspace(checkOptions(workspace, [
      "--rebaseline",
      "--reason",
      "Validate the prior observation before replacing it.",
    ])),
    (error) =>
      error?.code === "DRIFT003" &&
      /semantically invalid/u.test(error.message),
  );
  assert.deepEqual(await readFile(statePath), malformedState);

  const mismatchedState = Buffer.from(
    `${JSON.stringify({
      ...state,
      latestObservation: {
        observationId: observation.id,
        observationDigest: `sha256:${"f".repeat(64)}`,
      },
    })}\n`,
    "utf8",
  );
  await writeFile(statePath, mismatchedState);
  await assert.rejects(
    checkChangedWorkspace(checkOptions(workspace, [
      "--rebaseline",
      "--reason",
      "Validate exact prior observation identity before replacing it.",
    ])),
    (error) => error?.code === "DRIFT003" && /mismatched observation/u.test(error.message),
  );
  assert.deepEqual(await readFile(statePath), mismatchedState);
});

test("explicit rebaseline rejects semantically malformed active finding and refresh artifacts", async (t) => {
  for (const malformedKind of ["finding", "refresh"]) {
    await t.test(malformedKind, async (subtest) => {
      const { workspace, graph } = await initializedWorkspace(subtest);
      const source = join(workspace, "src", `${malformedKind}.ts`);
      await Promise.all([
        write(source, "before\n"),
        addNote(graph, `${malformedKind}.md`, {
          id: `concept-malformed-${malformedKind}`,
          appliesTo: [`file:src/${malformedKind}.ts`],
        }),
      ]);
      await checkChangedWorkspace(checkOptions(workspace));
      await writeFile(source, "after\n");
      await checkChangedWorkspace(checkOptions(workspace));
      const { environment, state: currentState } = await stateContext(workspace);
      const previousPolicyRevision = malformedKind === "finding"
        ? `sha256:${"d".repeat(64)}`
        : `sha256:${"e".repeat(64)}`;
      const rebound = await rebindDriftStatePolicy({
        graph,
        environment,
        state: currentState,
        policyRevision: previousPolicyRevision,
      });
      const state = rebound.state;
      const entry = state.activeFindings[0];
      const finding = rebound.active[0].finding;
      const sealed = malformedKind === "finding"
        ? sealDriftFinding({
            workspaceIdentity: environment.workspaceIdentity,
            graphRootIdentity: environment.graphRootIdentity,
            policyRevision: previousPolicyRevision,
            payload: { ...finding.payload, unexpectedSemanticField: true },
          })
        : sealDriftRefresh({
            workspaceIdentity: environment.workspaceIdentity,
            graphRootIdentity: environment.graphRootIdentity,
            policyRevision: previousPolicyRevision,
            payload: {
              specification: "syncora-drift-refresh-v1",
              finding: { id: entry.findingId, digest: entry.findingDigest },
            },
          });
      await write(
        resolveDriftArtifactPath({
          graphRoot: graph,
          workspaceIdentity: environment.workspaceIdentity,
          kind: malformedKind,
          id: sealed.id,
        }),
        sealed.bytes,
      );
      const activeEntry = malformedKind === "finding"
        ? { ...entry, findingId: sealed.id, findingDigest: sealed.digest }
        : { ...entry, refreshId: sealed.id, refreshDigest: sealed.digest };
      const statePath = driftStatePaths(graph, environment.workspaceIdentity).statePath;
      const malformedState = Buffer.from(
        `${JSON.stringify({ ...state, activeFindings: [activeEntry] })}\n`,
        "utf8",
      );
      await writeFile(statePath, malformedState);

      await assert.rejects(
        checkChangedWorkspace(checkOptions(workspace, [
          "--rebaseline",
          "--reason",
          "Review every prior active artifact before replacing policy state.",
        ])),
        (error) => error?.code === "DRIFT003",
      );
      assert.deepEqual(await readFile(statePath), malformedState);
    });
  }
});

test("explicit rebaseline rejects well-shaped active findings with forged observation lineage", async (t) => {
  for (const forgedKind of ["missing-observation", "inconsistent-evidence"]) {
    await t.test(forgedKind, async (subtest) => {
      const { workspace, graph } = await initializedWorkspace(subtest);
      const source = join(workspace, "src", `${forgedKind}.ts`);
      await Promise.all([
        write(source, "before\n"),
        addNote(graph, `${forgedKind}.md`, {
          id: `concept-forged-${forgedKind}`,
          appliesTo: [`file:src/${forgedKind}.ts`],
        }),
      ]);
      await checkChangedWorkspace(checkOptions(workspace));
      await writeFile(source, "after\n");
      await checkChangedWorkspace(checkOptions(workspace));
      const { environment, state } = await stateContext(workspace);
      const previousPolicyRevision = forgedKind === "missing-observation"
        ? `sha256:${"1".repeat(64)}`
        : `sha256:${"2".repeat(64)}`;
      const rebound = await rebindDriftStatePolicy({
        graph,
        environment,
        state,
        policyRevision: previousPolicyRevision,
      });
      const original = rebound.active[0].finding.payload;
      const payload = forgedKind === "missing-observation"
        ? {
            ...original,
            observationCurrent: {
              id: `observation_${"0".repeat(64)}`,
              digest: `sha256:${"0".repeat(64)}`,
            },
          }
        : {
            ...original,
            matchedBindings: original.matchedBindings.map((binding, index) =>
              index === 0
                ? { ...binding, beforeFingerprint: `sha256:${"9".repeat(64)}` }
                : binding),
          };
      const forged = await replaceReboundActiveFinding({
        graph,
        environment,
        rebound,
        policyRevision: previousPolicyRevision,
        payload,
      });
      const statePath = driftStatePaths(graph, environment.workspaceIdentity).statePath;
      const before = await readFile(statePath);

      await assert.rejects(
        checkChangedWorkspace(checkOptions(workspace, [
          "--rebaseline",
          "--reason",
          "Forged but well-shaped evidence must not be retired.",
        ])),
        (error) =>
          error?.code === "DRIFT003" &&
          (forgedKind === "missing-observation"
            ? /unavailable current observation/u.test(error.message)
            : /not derived from its exact observations/u.test(error.message)),
      );
      assert.deepEqual(await readFile(statePath), before);
      assert.equal(forged.state.activeFindings.length, 1);
    });
  }
});

test("policy drift fails with one recovery command and explicit rebaseline records a new baseline", async (t) => {
  const { workspace, graph } = await initializedWorkspace(t);
  await Promise.all([
    write(join(workspace, "src", "policy.ts"), "policy source\n"),
    addNote(graph, "policy.md", {
      id: "concept-policy",
      appliesTo: ["file:src/policy.ts"],
    }),
  ]);
  await checkChangedWorkspace(checkOptions(workspace));
  const { environment, state } = await stateContext(workspace);
  const previousPolicyRevision = `sha256:${"a".repeat(64)}`;
  const currentObservation = await readDriftObservation({
    graphRoot: graph,
    workspaceIdentity: environment.workspaceIdentity,
    graphRootIdentity: environment.graphRootIdentity,
    policyRevision: environment.policyRevision,
    id: state.latestObservation.observationId,
  });
  const previousObservation = sealDriftObservation({
    workspaceIdentity: environment.workspaceIdentity,
    graphRootIdentity: environment.graphRootIdentity,
    policyRevision: previousPolicyRevision,
    payload: currentObservation.payload,
  });
  await write(
    resolveDriftArtifactPath({
      graphRoot: graph,
      workspaceIdentity: environment.workspaceIdentity,
      kind: "observation",
      id: previousObservation.id,
    }),
    previousObservation.bytes,
  );
  await writeFile(
    driftStatePaths(graph, environment.workspaceIdentity).statePath,
    `${JSON.stringify({
      ...state,
      policyRevision: previousPolicyRevision,
      latestObservation: {
        observationId: previousObservation.id,
        observationDigest: previousObservation.digest,
      },
    })}\n`,
  );

  await assert.rejects(
    checkChangedWorkspace(checkOptions(workspace)),
    (error) =>
      error?.code === "DRIFT_POLICY_MISMATCH" &&
      /--rebaseline/u.test(error.message),
  );
  const result = await checkChangedWorkspace(checkOptions(workspace, [
    "--rebaseline",
    "--reason",
    "Upgrade the exact drift policy baseline.",
  ]));
  assert.equal(result.state, "baseline-reestablished");
  assert.equal(result.rebaseline.previousPolicyRevision, previousPolicyRevision);
  assert.equal(result.rebaseline.currentPolicyRevision, environment.policyRevision);
  assert.match(result.rebaseline.recordId, /^disposition_[0-9a-f]{64}$/u);
  const refreshed = await readDriftState({
    graphRoot: graph,
    workspaceIdentity: environment.workspaceIdentity,
    graphRootIdentity: environment.graphRootIdentity,
    policyRevision: environment.policyRevision,
  });
  assert.equal(refreshed.activeFindings.length, 0);
  assert.equal(refreshed.policyRevision, environment.policyRevision);
});

test("explicit rebaseline dispositions every active finding instead of silently dropping it", async (t) => {
  const { workspace, graph } = await initializedWorkspace(t);
  const source = join(workspace, "src", "retire.ts");
  await Promise.all([
    write(source, "before\n"),
    addNote(graph, "retire.md", {
      id: "concept-retire",
      appliesTo: ["file:src/retire.ts"],
    }),
  ]);
  await checkChangedWorkspace(checkOptions(workspace));
  await writeFile(source, "after\n");
  const finding = await checkChangedWorkspace(checkOptions(workspace));
  assert.equal(finding.summary.activeFindings, 1);
  const { environment, state: currentState } = await stateContext(workspace);
  const previousPolicyRevision = `sha256:${"3".repeat(64)}`;
  await rebindDriftStatePolicy({
    graph,
    environment,
    state: currentState,
    policyRevision: previousPolicyRevision,
  });

  const result = await checkChangedWorkspace(checkOptions(workspace, [
    "--rebaseline",
    "--reason",
    "Retire active findings while upgrading the reviewed drift policy.",
  ]));
  assert.equal(result.state, "baseline-reestablished");
  assert.equal(result.summary.resolvedFindings, 1);
  assert.equal(result.rebaseline.retiredFindings, 1);
  assert.equal(result.rebaseline.previousPolicyRevision, previousPolicyRevision);
  const { state } = await stateContext(workspace);
  assert.equal(state.activeFindings.length, 0);
  const dispositionFiles = await readdir(driftStatePaths(
    graph,
    (await resolveGovernedEnvironment(checkOptions(workspace))).workspaceIdentity,
  ).dispositions);
  assert.ok(dispositionFiles.length >= 2);
});
