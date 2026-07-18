import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DRIFT_STATE_POLICY,
  createDriftState,
  driftArtifactPath,
  driftStatePaths,
  driftWorkspaceIdentityHex,
  parseDriftArtifactBytes,
  parseDriftFinding,
  parseDriftStateBytes,
  publishDriftFinding,
  readDriftFinding,
  readDriftFindingSourceBytes,
  readDriftState,
  sealDriftFinding,
  sealDriftObservation,
  sealDriftProposalBinding,
  sealDriftRefresh,
  serializeDriftState,
  writeDriftState,
} from "../../skills/syncora/scripts/lib/drift-state.mjs";

function digest(value) {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

const WORKSPACE_A = digest("workspace-a");
const WORKSPACE_B = digest("workspace-b");
const GRAPH_IDENTITY = digest("graph-root");
const POLICY_REVISION = digest("drift-policy-v1");
const UPDATED_AT = "2026-07-17T12:00:00.000Z";

function artifactOptions(workspaceIdentity = WORKSPACE_A) {
  return {
    workspaceIdentity,
    graphRootIdentity: GRAPH_IDENTITY,
    policyRevision: POLICY_REVISION,
  };
}

function stateWithFinding() {
  const observation = sealDriftObservation({
    ...artifactOptions(),
    payload: { baseline: "abc123", provider: "git" },
  });
  const finding = sealDriftFinding({
    ...artifactOptions(),
    payload: {
      note: "knowledge/decisions/auth.md",
      sources: [{ path: "src/auth.mjs", sha256: digest("auth source") }],
    },
  });
  const refresh = sealDriftRefresh({
    ...artifactOptions(),
    payload: { afterTextRequired: true, findingId: finding.id },
  });
  const binding = sealDriftProposalBinding({
    ...artifactOptions(),
    payload: { findingId: finding.id, proposalId: `proposal_${"a".repeat(64)}` },
  });
  const state = {
    schemaVersion: 1,
    kind: "syncora.drift.state",
    workspaceIdentity: WORKSPACE_A,
    graphRootIdentity: GRAPH_IDENTITY,
    policyRevision: POLICY_REVISION,
    updatedAt: UPDATED_AT,
    latestObservation: {
      observationId: observation.id,
      observationDigest: observation.digest,
    },
    activeFindings: [
      {
        findingId: finding.id,
        findingDigest: finding.digest,
        refreshId: refresh.id,
        refreshDigest: refresh.digest,
        note: {
          path: "knowledge/decisions/auth.md",
          sha256: digest("canonical note"),
        },
        proposalBindingIds: [binding.id],
      },
    ],
  };
  return { binding, finding, observation, refresh, state };
}

function scaleFinding(index) {
  const findingHex = createHash("sha256").update(`finding-${index}`, "utf8").digest("hex");
  const refreshHex = createHash("sha256").update(`refresh-${index}`, "utf8").digest("hex");
  return {
    findingId: `finding_${findingHex}`,
    findingDigest: `sha256:${findingHex}`,
    refreshId: `refresh_${refreshHex}`,
    refreshDigest: `sha256:${refreshHex}`,
    note: {
      path: `knowledge/concepts/scale-${String(index).padStart(5, "0")}.md`,
      sha256: digest(`note-${index}`),
    },
    proposalBindingIds: [],
  };
}

test("drift artifacts seal and publish deterministically with exact immutable bytes", async () => {
  const graphRoot = await mkdtemp(join(tmpdir(), "syncora-drift-artifact-"));
  try {
    assert.equal(DRIFT_STATE_POLICY.maximumStateBytes, 16_777_216);
    assert.equal(DRIFT_STATE_POLICY.maximumArtifactBytes, 16_777_216);
    assert.equal(DRIFT_STATE_POLICY.maximumActiveFindings, 10_000);
    assert.equal(Object.isFrozen(DRIFT_STATE_POLICY), true);

    const left = sealDriftFinding({
      ...artifactOptions(),
      payload: {
        zeta: [3, 2, 1],
        alpha: { second: true, first: "value" },
      },
    });
    const right = sealDriftFinding({
      ...artifactOptions(),
      payload: {
        alpha: { first: "value", second: true },
        zeta: [3, 2, 1],
      },
    });
    assert.equal(left.id, right.id);
    assert.equal(left.digest, right.digest);
    assert.deepEqual(left.bytes, right.bytes);
    assert.match(left.id, /^finding_[0-9a-f]{64}$/u);

    const first = await publishDriftFinding({
      graphRoot,
      ...artifactOptions(),
      payload: right.payload,
    });
    const retry = await publishDriftFinding({
      graphRoot,
      ...artifactOptions(),
      payload: left.payload,
    });
    assert.equal(first.id, left.id);
    assert.equal(first.publication.created, true);
    assert.equal(retry.publication.created, false);
    assert.equal(retry.publication.idempotent, true);

    const loaded = await readDriftFinding({
      graphRoot,
      workspaceIdentity: WORKSPACE_A,
      graphRootIdentity: GRAPH_IDENTITY,
      policyRevision: POLICY_REVISION,
      id: left.id,
    });
    assert.equal(loaded.id, left.id);
    assert.deepEqual(loaded.payload, left.payload);
    assert.deepEqual(
      await readDriftFindingSourceBytes({
        graphRoot,
        workspaceIdentity: WORKSPACE_A,
        findingId: left.id,
      }),
      left.bytes,
    );

    const parsed = parseDriftArtifactBytes(left.bytes, {
      id: left.id,
      kind: "finding",
      workspaceIdentity: WORKSPACE_A,
    });
    assert.equal(parsed.digest, left.digest);
    assert.throws(
      () => parseDriftFinding({ ...left.value, extra: true }),
      (error) => error?.code === "DRIFT001",
    );
  } finally {
    await rm(graphRoot, { recursive: true, force: true });
  }
});

test("drift state preserves one actionable finding for every note at the 10,000-note gate", () => {
  const base = createDriftState({
    workspaceIdentity: WORKSPACE_A,
    graphRootIdentity: GRAPH_IDENTITY,
    policyRevision: POLICY_REVISION,
    updatedAt: UPDATED_AT,
  });
  const activeFindings = Array.from(
    { length: DRIFT_STATE_POLICY.maximumActiveFindings },
    (_, index) => scaleFinding(index),
  ).sort((left, right) => left.findingId.localeCompare(right.findingId));
  const bytes = serializeDriftState({ ...base, activeFindings });
  const parsed = parseDriftStateBytes(bytes, artifactOptions());
  assert.equal(parsed.activeFindings.length, 10_000);
  assert.ok(bytes.length < DRIFT_STATE_POLICY.maximumStateBytes);

  const excessive = [...activeFindings, scaleFinding(10_000)]
    .sort((left, right) => left.findingId.localeCompare(right.findingId));
  assert.throws(
    () => serializeDriftState({ ...base, activeFindings: excessive }),
    (error) => error?.code === "DRIFT005",
  );
});

test("drift state is workspace-sharded, strict, bounded, and atomically replaceable", async () => {
  const graphRoot = await mkdtemp(join(tmpdir(), "syncora-drift-state-"));
  try {
    const { state } = stateWithFinding();
    const first = await writeDriftState({ graphRoot, state });
    const second = await writeDriftState({ graphRoot, state });
    assert.deepEqual(first.bytes, second.bytes);
    assert.equal(
      first.path,
      join(
        graphRoot,
        ".syncora",
        "drift",
        "workspaces",
        driftWorkspaceIdentityHex(WORKSPACE_A),
        "state.json",
      ),
    );
    assert.deepEqual(
      await readDriftState({
        graphRoot,
        workspaceIdentity: WORKSPACE_A,
        graphRootIdentity: GRAPH_IDENTITY,
        policyRevision: POLICY_REVISION,
      }),
      parseDriftStateBytes(serializeDriftState(state)),
    );

    const empty = createDriftState({
      ...artifactOptions(WORKSPACE_B),
      updatedAt: UPDATED_AT,
    });
    await writeDriftState({ graphRoot, state: empty });
    assert.deepEqual(
      await readDriftState({ graphRoot, workspaceIdentity: WORKSPACE_B }),
      empty,
    );
    assert.notEqual(
      driftStatePaths(graphRoot, WORKSPACE_A).statePath,
      driftStatePaths(graphRoot, WORKSPACE_B).statePath,
    );
  } finally {
    await rm(graphRoot, { recursive: true, force: true });
  }
});

test("missing drift state and artifacts are read without creating storage", async () => {
  const graphRoot = await mkdtemp(join(tmpdir(), "syncora-drift-pure-read-"));
  const paths = driftStatePaths(graphRoot, WORKSPACE_A);
  try {
    assert.equal(await readDriftState({
      graphRoot,
      workspaceIdentity: WORKSPACE_A,
      graphRootIdentity: GRAPH_IDENTITY,
      policyRevision: POLICY_REVISION,
    }), null);
    assert.equal(await readDriftFinding({
      graphRoot,
      workspaceIdentity: WORKSPACE_A,
      graphRootIdentity: GRAPH_IDENTITY,
      policyRevision: POLICY_REVISION,
      id: `finding_${"a".repeat(64)}`,
    }), null);
    await assert.rejects(access(paths.driftRoot));
  } finally {
    await rm(graphRoot, { recursive: true, force: true });
  }
});

test("corrupt, future, and identity-mismatched state fails closed and is not reset", async () => {
  const graphRoot = await mkdtemp(join(tmpdir(), "syncora-drift-corrupt-"));
  const paths = driftStatePaths(graphRoot, WORKSPACE_A);
  try {
    await mkdir(paths.workspaceRoot, { recursive: true });
    await writeFile(paths.statePath, "{not-json}\n", "utf8");
    await assert.rejects(
      readDriftState({ graphRoot, workspaceIdentity: WORKSPACE_A }),
      (error) => error?.code === "DRIFT001",
    );
    await assert.rejects(
      writeDriftState({ graphRoot, state: stateWithFinding().state }),
      (error) => error?.code === "DRIFT001",
    );

    const future = {
      ...createDriftState({ ...artifactOptions(), updatedAt: UPDATED_AT }),
      schemaVersion: 999,
    };
    await writeFile(paths.statePath, `${JSON.stringify(future)}\n`, "utf8");
    await assert.rejects(
      readDriftState({ graphRoot, workspaceIdentity: WORKSPACE_A }),
      (error) => error?.code === "SCHEMA001",
    );

    await writeFile(paths.statePath, serializeDriftState(stateWithFinding().state));
    await assert.rejects(
      readDriftState({
        graphRoot,
        workspaceIdentity: WORKSPACE_A,
        graphRootIdentity: digest("wrong graph"),
      }),
      (error) => error?.code === "DRIFT003",
    );
  } finally {
    await rm(graphRoot, { recursive: true, force: true });
  }
});

test("artifact paths isolate workspaces and reject copied cross-workspace evidence", async () => {
  const graphRoot = await mkdtemp(join(tmpdir(), "syncora-drift-isolation-"));
  try {
    const published = await publishDriftFinding({
      graphRoot,
      ...artifactOptions(WORKSPACE_A),
      payload: { evidence: "workspace-a" },
    });
    assert.equal(
      await readDriftFinding({
        graphRoot,
        workspaceIdentity: WORKSPACE_B,
        id: published.id,
      }),
      null,
    );

    const pathsB = driftStatePaths(graphRoot, WORKSPACE_B);
    const copiedPath = driftArtifactPath(pathsB, "finding", published.id);
    await mkdir(pathsB.findings, { recursive: true });
    await writeFile(copiedPath, published.bytes);
    await assert.rejects(
      readDriftFinding({
        graphRoot,
        workspaceIdentity: WORKSPACE_B,
        id: published.id,
      }),
      (error) => error?.code === "DRIFT003",
    );
  } finally {
    await rm(graphRoot, { recursive: true, force: true });
  }
});

test("drift storage rejects unsafe directory and state path components", async () => {
  const unsafeRoot = await mkdtemp(join(tmpdir(), "syncora-drift-unsafe-"));
  const unsafeArtifactRoot = await mkdtemp(
    join(tmpdir(), "syncora-drift-unsafe-artifact-"),
  );
  const unsafeStateRoot = await mkdtemp(
    join(tmpdir(), "syncora-drift-unsafe-state-"),
  );
  try {
    await writeFile(join(unsafeRoot, ".syncora"), "not a directory\n", "utf8");
    await assert.rejects(
      readDriftState({ graphRoot: unsafeRoot, workspaceIdentity: WORKSPACE_A }),
      (error) => error?.code === "DRIFT002",
    );

    const artifactPaths = driftStatePaths(unsafeArtifactRoot, WORKSPACE_A);
    await mkdir(artifactPaths.workspaceRoot, { recursive: true });
    await writeFile(artifactPaths.findings, "not a directory\n", "utf8");
    await assert.rejects(
      publishDriftFinding({
        graphRoot: unsafeArtifactRoot,
        ...artifactOptions(),
        payload: { evidence: "unsafe" },
      }),
      (error) => error?.code === "DRIFT002",
    );

    const statePaths = driftStatePaths(unsafeStateRoot, WORKSPACE_A);
    await mkdir(statePaths.statePath, { recursive: true });
    await assert.rejects(
      readDriftState({ graphRoot: unsafeStateRoot, workspaceIdentity: WORKSPACE_A }),
      (error) => error?.code === "DRIFT002",
    );
  } finally {
    await rm(unsafeRoot, { recursive: true, force: true });
    await rm(unsafeArtifactRoot, { recursive: true, force: true });
    await rm(unsafeStateRoot, { recursive: true, force: true });
  }
});
