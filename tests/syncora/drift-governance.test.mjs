import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DRIFT_FINDING_SPECIFICATION,
  DRIFT_PROPOSAL_BINDING_SPECIFICATION,
  parseDriftFindingPayload,
  parseDriftProposalBindingPayload,
  publishDriftProposalBindings,
  validateDriftProposalInput,
} from "../../skills/syncora/scripts/lib/drift-governance.mjs";
import {
  createDriftState,
  listDriftProposalBindings,
  publishDriftFinding,
  publishDriftObservation,
  publishDriftRefresh,
  readDriftState,
  writeDriftState,
} from "../../skills/syncora/scripts/lib/drift-state.mjs";
import {
  parseProposalInput,
  taggedContentSha256,
} from "../../skills/syncora/scripts/lib/proposal-schema.mjs";
import { observeBoundSources } from "../../skills/syncora/scripts/lib/drift-source.mjs";

function digest(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

const WORKSPACE_IDENTITY = digest("drift-governance-workspace");
const GRAPH_ROOT_IDENTITY = digest("drift-governance-graph-root");
const POLICY_REVISION = digest("drift-governance-policy-v1");
const GRAPH_REVISION = digest("drift-governance-graph-revision");
const NOTE_PATH = "knowledge/projects/application.md";
const NOTE_SHA256 = digest("canonical project hub before drift repair");
const SOURCE_A_BYTES = Buffer.from("application current", "utf8");
const SOURCE_B_BYTES = Buffer.from("configuration current", "utf8");
const SOURCE_A = Object.freeze({
  path: "src/application.mjs",
  before: digest("application before"),
  current: digest(SOURCE_A_BYTES),
  beforeBytes: 18,
  currentBytes: SOURCE_A_BYTES.length,
});
const SOURCE_B = Object.freeze({
  path: "config/application.json",
  before: digest("configuration before"),
  current: digest(SOURCE_B_BYTES),
  beforeBytes: 20,
  currentBytes: SOURCE_B_BYTES.length,
});
const FINDING_BINDINGS = Object.freeze([
  Object.freeze({
    specifier: `file:${SOURCE_A.path}`,
    kind: "file",
    ref: SOURCE_A.path,
  }),
  Object.freeze({ specifier: "module:config", kind: "module", ref: "config" }),
  Object.freeze({
    specifier: "path_glob:src/**/*.mjs",
    kind: "path_glob",
    ref: "src/**/*.mjs",
  }),
]);

function observationRef(label) {
  const hexadecimal = createHash("sha256").update(label, "utf8").digest("hex");
  return {
    id: `observation_${hexadecimal}`,
    digest: `sha256:${hexadecimal}`,
  };
}

function findingPayload({
  observationBefore = observationRef("observation-before"),
  observationCurrent = observationRef("observation-current"),
  currentFingerprints = new Map(),
} = {}) {
  return {
    specification: DRIFT_FINDING_SPECIFICATION,
    status: "potentially-stale",
    authority: "zero",
    graphRevision: GRAPH_REVISION,
    observationBefore,
    observationCurrent,
    supersedes: [],
    note: {
      path: NOTE_PATH,
      sha256: NOTE_SHA256,
      kind: "project",
      scope: "application",
      authorityClass: "canonical",
    },
    matchedBindings: FINDING_BINDINGS.map((binding, index) => ({
      ...binding,
      beforeFingerprint: digest(`prior binding ${index}`),
      currentFingerprint:
        currentFingerprints.get(binding.specifier) ?? digest(`current binding ${index}`),
    })),
    changedSources: [
      {
        path: SOURCE_B.path,
        change: "modified",
        beforeSha256: SOURCE_B.before,
        currentSha256: SOURCE_B.current,
        beforeBytes: SOURCE_B.beforeBytes,
        currentBytes: SOURCE_B.currentBytes,
        renamedFrom: null,
      },
      {
        path: SOURCE_A.path,
        change: "modified",
        beforeSha256: SOURCE_A.before,
        currentSha256: SOURCE_A.current,
        beforeBytes: SOURCE_A.beforeBytes,
        currentBytes: SOURCE_A.currentBytes,
        renamedFrom: null,
      },
      {
        path: "src/removed-compatibility.mjs",
        change: "deleted",
        beforeSha256: digest("removed compatibility source"),
        currentSha256: null,
        beforeBytes: 28,
        currentBytes: null,
        renamedFrom: null,
      },
    ],
    recommendedOperation: "hub.refresh",
    afterTextRequired: true,
  };
}

function proposalInput(fixture, {
  origin = "drift",
  operationKind = "hub.refresh",
  changePath = NOTE_PATH,
  expectedPriorSha256 = NOTE_SHA256,
  sourceRefs = undefined,
} = {}) {
  return parseProposalInput({
    schemaVersion: 1,
    kind: "syncora.proposal-input",
    idempotencyKey: `drift-governance-${origin}-${operationKind.replace(".", "-")}`,
    origin,
    actor: {
      type: "agent",
      id: "syncora-drift-governance-test",
      runtime: process.version,
    },
    reason: "Refresh the exact project hub against the active changed-file finding.",
    correctsProposalId: null,
    operations: [
      {
        operationId: "refresh-application-project-hub",
        kind: operationKind,
        sourceRefs: sourceRefs ?? [{
          type: "drift-finding",
          ref: fixture.finding.id,
          expectedSha256: fixture.finding.digest,
        }],
        changes: [
          {
            path: changePath,
            expectedPriorSha256,
            afterText: [
              "---",
              "id: project-application",
              "type: project",
              "status: active",
              "---",
              "",
              "# Application",
              "",
              "Current truth after reviewed drift repair.",
              "",
            ].join("\n"),
          },
        ],
      },
    ],
  });
}

async function driftFixture({ active = true } = {}) {
  const workspacePath = await realpath(
    await mkdtemp(join(tmpdir(), "syncora-drift-governance-")),
  );
  const graphRoot = join(workspacePath, "local");
  await mkdir(join(workspacePath, "src"), { recursive: true });
  await mkdir(join(workspacePath, "config"), { recursive: true });
  await mkdir(join(graphRoot, "knowledge", "projects"), { recursive: true });
  await writeFile(join(workspacePath, SOURCE_A.path), SOURCE_A_BYTES);
  await writeFile(join(workspacePath, SOURCE_B.path), SOURCE_B_BYTES);
  await writeFile(join(graphRoot, NOTE_PATH), "canonical project hub before drift repair");
  const sourceObservation = await observeBoundSources({
    workspacePath,
    graphPath: graphRoot,
    bindings: FINDING_BINDINGS,
    hooks: {
      runGit: async () => ({ code: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }),
    },
  });
  const currentFingerprints = new Map(
    sourceObservation.bindings.map((binding) => [binding.specifier, binding.fingerprint]),
  );
  const environment = {
    workspacePath,
    graphRoot,
    workspaceIdentity: WORKSPACE_IDENTITY,
    graphRootIdentity: GRAPH_ROOT_IDENTITY,
    policyRevision: POLICY_REVISION,
  };
  const artifactOptions = {
    graphRoot,
    workspaceIdentity: WORKSPACE_IDENTITY,
    graphRootIdentity: GRAPH_ROOT_IDENTITY,
    policyRevision: POLICY_REVISION,
  };
  const observationBefore = await publishDriftObservation({
    ...artifactOptions,
    payload: { sequence: "before" },
  });
  const observationCurrent = await publishDriftObservation({
    ...artifactOptions,
    payload: { sequence: "current" },
  });
  const finding = await publishDriftFinding({
    ...artifactOptions,
    payload: findingPayload({
      observationBefore: {
        id: observationBefore.id,
        digest: observationBefore.digest,
      },
      observationCurrent: {
        id: observationCurrent.id,
        digest: observationCurrent.digest,
      },
      currentFingerprints,
    }),
  });
  const refresh = await publishDriftRefresh({
    ...artifactOptions,
    payload: {
      finding: { id: finding.id, digest: finding.digest },
      recommendedOperation: "hub.refresh",
      afterTextRequired: true,
    },
  });
  const state = {
    ...createDriftState({
      workspaceIdentity: WORKSPACE_IDENTITY,
      graphRootIdentity: GRAPH_ROOT_IDENTITY,
      policyRevision: POLICY_REVISION,
      updatedAt: "2026-07-17T12:00:00.000Z",
    }),
    latestObservation: {
      observationId: observationCurrent.id,
      observationDigest: observationCurrent.digest,
    },
    activeFindings: active
      ? [
          {
            findingId: finding.id,
            findingDigest: finding.digest,
            refreshId: refresh.id,
            refreshDigest: refresh.digest,
            note: { path: NOTE_PATH, sha256: NOTE_SHA256 },
            proposalBindingIds: [],
          },
        ]
      : [],
  };
  await writeDriftState({ graphRoot, state });
  return {
    workspacePath,
    graphRoot,
    environment,
    finding,
    cleanup: () => rm(workspacePath, { recursive: true, force: true }),
  };
}

test("drift finding payload parsing is exact, bounded, and policy-bearing", () => {
  const payload = findingPayload();
  const parsed = parseDriftFindingPayload(payload);
  assert.deepEqual(parsed, payload);
  assert.equal(Object.isFrozen(parsed), true);

  assert.throws(
    () => parseDriftFindingPayload({ ...payload, confidence: 0.99 }),
    (error) => error?.code === "PROPOSAL003" && /unknown fields/u.test(error.message),
  );
  assert.throws(
    () => parseDriftFindingPayload({
      ...payload,
      changedSources: [{
        ...payload.changedSources[0],
        change: "added",
      }],
    }),
    (error) => error?.code === "PROPOSAL003" && /semantics disagree/u.test(error.message),
  );
  assert.throws(
    () => parseDriftFindingPayload({
      ...payload,
      matchedBindings: [payload.matchedBindings[0], payload.matchedBindings[0]],
    }),
    (error) => error?.code === "PROPOSAL003" && /must be unique/u.test(error.message),
  );
  const supersededA = {
    id: `finding_${"a".repeat(64)}`,
    digest: `sha256:${"a".repeat(64)}`,
  };
  const supersededB = {
    id: `finding_${"b".repeat(64)}`,
    digest: `sha256:${"b".repeat(64)}`,
  };
  assert.deepEqual(
    parseDriftFindingPayload({ ...payload, supersedes: [supersededA, supersededB] })
      .supersedes,
    [supersededA, supersededB],
  );
  assert.throws(
    () => parseDriftFindingPayload({ ...payload, supersedes: [supersededB, supersededA] }),
    (error) => error?.code === "PROPOSAL003" && /unique and sorted/u.test(error.message),
  );
});

test("drift proposals must bind an exact finding that remains active", async () => {
  const fixture = await driftFixture({ active: false });
  try {
    await assert.rejects(
      validateDriftProposalInput(fixture.environment, proposalInput(fixture)),
      (error) =>
        error?.code === "PROPOSAL003" &&
        /missing, resolved, acknowledged, or digest-mismatched/u.test(error.message),
    );

    const withoutFinding = proposalInput(fixture, { sourceRefs: [
      { type: "file", ref: SOURCE_A.path, expectedSha256: SOURCE_A.current },
      { type: "file", ref: SOURCE_B.path, expectedSha256: SOURCE_B.current },
    ] });
    await assert.rejects(
      validateDriftProposalInput(fixture.environment, withoutFinding),
      (error) => error?.code === "PROPOSAL003" && /must exact-bind/u.test(error.message),
    );
  } finally {
    await fixture.cleanup();
  }
});

test("the finding plus live full-binding fingerprints authorizes a drift repair", async () => {
  const fixture = await driftFixture();
  try {
    const validated = await validateDriftProposalInput(
      fixture.environment,
      proposalInput(fixture),
    );
    assert.equal(validated.length, 1);
    assert.equal(validated[0].findingId, fixture.finding.id);
  } finally {
    await fixture.cleanup();
  }
});

test("drift proposal freshness exact-binds the canonical note snapshot", async () => {
  const fixture = await driftFixture();
  try {
    await assert.rejects(
      validateDriftProposalInput(
        fixture.environment,
        proposalInput(fixture, { expectedPriorSha256: digest("wrong note") }),
      ),
      (error) => error?.code === "PROPOSAL003" && /exact note/u.test(error.message),
    );
    await writeFile(join(fixture.graphRoot, NOTE_PATH), "direct canonical edit");
    await assert.rejects(
      validateDriftProposalInput(fixture.environment, proposalInput(fixture)),
      (error) =>
        error?.code === "PROPOSAL003" &&
        /canonical note changed, moved, or disappeared/u.test(error.message),
    );
    await unlink(join(fixture.graphRoot, NOTE_PATH));
    await assert.rejects(
      validateDriftProposalInput(fixture.environment, proposalInput(fixture)),
      (error) =>
        error?.code === "PROPOSAL003" &&
        /canonical note changed, moved, or disappeared/u.test(error.message),
    );
  } finally {
    await fixture.cleanup();
  }
});

test("full module and glob bindings invalidate after an unlisted file changes", async (t) => {
  await t.test("module gains another file", async () => {
    const fixture = await driftFixture();
    try {
      await writeFile(join(fixture.workspacePath, "config", "other.json"), "{}\n");
      await assert.rejects(
        validateDriftProposalInput(fixture.environment, proposalInput(fixture)),
        (error) =>
          error?.code === "PROPOSAL003" &&
          error?.details?.specifier === "module:config",
      );
    } finally {
      await fixture.cleanup();
    }
  });

  await t.test("glob gains another matching file", async () => {
    const fixture = await driftFixture();
    try {
      await writeFile(join(fixture.workspacePath, "src", "other.mjs"), "export {};\n");
      await assert.rejects(
        validateDriftProposalInput(fixture.environment, proposalInput(fixture)),
        (error) =>
          error?.code === "PROPOSAL003" &&
          error?.details?.specifier === "path_glob:src/**/*.mjs",
      );
    } finally {
      await fixture.cleanup();
    }
  });

  await t.test("bound file is deleted", async () => {
    const fixture = await driftFixture();
    try {
      await unlink(join(fixture.workspacePath, SOURCE_A.path));
      await assert.rejects(
        validateDriftProposalInput(fixture.environment, proposalInput(fixture)),
        (error) =>
          error?.code === "PROPOSAL003" &&
          error?.details?.specifier === `file:${SOURCE_A.path}`,
      );
    } finally {
      await fixture.cleanup();
    }
  });
});

test("drift finding scope fixes both the target note and semantic operation", async () => {
  const fixture = await driftFixture();
  try {
    await assert.rejects(
      validateDriftProposalInput(
        fixture.environment,
        proposalInput(fixture, { operationKind: "note.update" }),
      ),
      (error) =>
        error?.code === "PROPOSAL003" &&
        error?.details?.recommendedOperation === "hub.refresh",
    );
    await assert.rejects(
      validateDriftProposalInput(
        fixture.environment,
        proposalInput(fixture, { changePath: "knowledge/projects/other.md" }),
      ),
      (error) => error?.code === "PROPOSAL003" && error?.details?.notePath === NOTE_PATH,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("only drift-origin proposal inputs may carry drift-finding evidence", async () => {
  const fixture = await driftFixture();
  try {
    const manual = proposalInput(fixture, { origin: "manual" });
    assert.equal(manual.operations[0].sourceRefs[0].type, "drift-finding");
    await assert.rejects(
      validateDriftProposalInput(fixture.environment, manual),
      (error) => error?.code === "PROPOSAL003" && /Only a drift-origin/u.test(error.message),
    );

    const capture = proposalInput(fixture, { origin: "capture", sourceRefs: [
      { type: "user", ref: "current-task:ordinary-capture", expectedSha256: null },
    ] });
    assert.deepEqual(
      await validateDriftProposalInput(fixture.environment, capture),
      [],
    );
  } finally {
    await fixture.cleanup();
  }
});

test("validated drift repairs publish one immutable, idempotent proposal binding", async () => {
  const fixture = await driftFixture();
  try {
    const validated = await validateDriftProposalInput(
      fixture.environment,
      proposalInput(fixture),
    );
    const proposal = {
      proposalId: `proposal_${"a".repeat(64)}`,
      proposalDigest: digest("sealed drift proposal"),
    };
    const first = await publishDriftProposalBindings({
      environment: fixture.environment,
      proposal,
      validatedFindings: validated,
    });
    const retry = await publishDriftProposalBindings({
      environment: fixture.environment,
      proposal,
      validatedFindings: validated,
    });

    assert.equal(first.length, 1);
    assert.equal(first[0].publication.created, true);
    assert.equal(retry[0].id, first[0].id);
    assert.equal(retry[0].publication.created, false);
    assert.equal(retry[0].publication.idempotent, true);
    assert.deepEqual(parseDriftProposalBindingPayload(first[0].payload), {
      specification: DRIFT_PROPOSAL_BINDING_SPECIFICATION,
      finding: { id: fixture.finding.id, digest: fixture.finding.digest },
      proposal: { id: proposal.proposalId, digest: proposal.proposalDigest },
      operation: { id: "refresh-application-project-hub", kind: "hub.refresh" },
      note: { path: NOTE_PATH },
    });

    const stored = await listDriftProposalBindings({
      graphRoot: fixture.graphRoot,
      workspaceIdentity: WORKSPACE_IDENTITY,
      graphRootIdentity: GRAPH_ROOT_IDENTITY,
      policyRevision: POLICY_REVISION,
    });
    assert.equal(stored.length, 1);
    assert.equal(stored[0].id, first[0].id);
    assert.deepEqual(stored[0].bytes, first[0].bytes);

    const state = await readDriftState({
      graphRoot: fixture.graphRoot,
      workspaceIdentity: WORKSPACE_IDENTITY,
      graphRootIdentity: GRAPH_ROOT_IDENTITY,
      policyRevision: POLICY_REVISION,
    });
    assert.deepEqual(state.activeFindings[0].proposalBindingIds, []);
    assert.equal(taggedContentSha256(first[0].bytes), first[0].digest);
  } finally {
    await fixture.cleanup();
  }
});
