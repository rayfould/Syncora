import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";

import {
  assertMigrationTransition,
  migrationPaths,
  readMigrationTargetBytes,
  readMigrationState,
  serializeMigrationJson,
  taggedSha256,
  validateMigrationState,
  workspaceIdentity,
} from "../../skills/syncora/scripts/lib/migration-state.mjs";

function stateFor(workspace, migrationId = "legacy-adoption") {
  const now = "2026-07-16T12:00:00.000Z";
  const artifact = (path) => ({ path, sha256: taggedSha256(path) });
  return {
    schemaVersion: 1,
    kind: "syncora.adoption",
    migrationId,
    status: "staged",
    workspaceIdentity: workspaceIdentity(workspace),
    rootIdentity: taggedSha256("root"),
    createdAt: now,
    updatedAt: now,
    baseline: {
      graphRevision: taggedSha256("graph"),
      policyRevision: taggedSha256("policy"),
      manifestSha256: taggedSha256("manifest"),
      recoveryPlanSha256: null,
      sourceCount: 2,
      targetCount: 1,
    },
    artifacts: {
      manifest: artifact("reviewed-manifest.json"),
      stagedContent: artifact("staged-content.json"),
      fixtures: null,
      shadowReport: null,
      recovery: null,
      cutoverReceipt: null,
      verification: null,
      retirement: null,
    },
  };
}

test("migration state binds identity, exact fields, and supported transitions", async () => {
  const workspace = await realpath(
    await mkdtemp(join(tmpdir(), "syncora-state-")),
  );
  const graph = join(workspace, "local");
  const paths = migrationPaths(graph, "legacy-adoption");
  try {
    await mkdir(paths.root, { recursive: true });
    const state = stateFor(workspace);
    await writeFile(paths.state, serializeMigrationJson(state));
    const loaded = await readMigrationState(paths, {
      migrationId: "legacy-adoption",
      workspaceIdentity: workspaceIdentity(workspace),
      rootIdentity: state.rootIdentity,
    });
    assert.deepEqual(loaded.value, state);

    assert.doesNotThrow(() => assertMigrationTransition("staged", "shadow-verified"));
    assert.doesNotThrow(() => assertMigrationTransition("shadow-verified", "cutover-prepared"));
    assert.doesNotThrow(() => assertMigrationTransition("cutover-prepared", "cutover-applied"));
    assert.doesNotThrow(() => assertMigrationTransition("shadow-verified", "rolled-back"));
    assert.doesNotThrow(() => assertMigrationTransition("retired", "rolled-back"));
    assert.throws(
      () => assertMigrationTransition("staged", "cutover-applied"),
      (error) => error?.code === "MIGRATE006",
    );
    assert.throws(
      () => validateMigrationState({ ...state, unknown: true }),
      (error) => error?.code === "MIGRATE004",
    );
    assert.throws(
      () => validateMigrationState({ ...state, schemaVersion: 999 }),
      (error) => error?.code === "SCHEMA001",
    );
    await assert.rejects(
      readMigrationState(paths, { workspaceIdentity: taggedSha256("other") }),
      (error) => error?.code === "MIGRATE005",
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("migration state rejects malformed and oversized state before use", async () => {
  const workspace = await realpath(
    await mkdtemp(join(tmpdir(), "syncora-state-")),
  );
  const paths = migrationPaths(join(workspace, "local"), "bounded");
  try {
    await mkdir(paths.root, { recursive: true });
    await writeFile(paths.state, Buffer.alloc(1_048_577, 0x20));
    await assert.rejects(
      readMigrationState(paths),
      (error) => error?.code === "MIGRATE004",
    );
    await writeFile(paths.state, Buffer.from([0xff, 0xfe]));
    await assert.rejects(
      readMigrationState(paths),
      (error) => error?.code === "MIGRATE004",
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("high-volume migration target reads stay in-process and bounded", async () => {
  const workspace = await realpath(
    await mkdtemp(join(tmpdir(), "syncora-target-read-scale-")),
  );
  const graph = join(workspace, "local");
  const path = join(graph, "knowledge", "note.md");
  const expected = Buffer.from("bounded migration note\n", "utf8");
  try {
    await mkdir(join(graph, "knowledge"), { recursive: true });
    await writeFile(path, expected);
    const started = performance.now();
    for (let index = 0; index < 1_000; index += 1) {
      const bytes = await readMigrationTargetBytes(
        path,
        graph,
        1_024,
        "Scale-gate target",
      );
      assert.deepEqual(bytes, expected);
    }
    const elapsed = performance.now() - started;
    assert.ok(
      elapsed < 15_000,
      `1,000 bounded target reads exceeded the 15s scale gate (${elapsed.toFixed(0)}ms).`,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
