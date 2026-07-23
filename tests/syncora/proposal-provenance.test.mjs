import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  truncate,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  createDriftState,
  publishDriftFinding,
  publishDriftObservation,
  publishDriftRefresh,
  writeDriftState,
} from "../../skills/syncora/scripts/lib/drift-state.mjs";
import {
  DRIFT_FINDING_SPECIFICATION,
} from "../../skills/syncora/scripts/lib/drift-governance.mjs";
import {
  observeBoundSources,
} from "../../skills/syncora/scripts/lib/drift-source.mjs";
import {
  verifyProposalSourceReferences,
} from "../../skills/syncora/scripts/lib/proposal-provenance.mjs";
import {
  PROPOSAL_POLICY,
  taggedContentSha256,
} from "../../skills/syncora/scripts/lib/proposal-schema.mjs";

async function fixture() {
  const workspacePath = await realpath(
    await mkdtemp(join(tmpdir(), "syncora-provenance-")),
  );
  const graphRoot = join(workspacePath, "local");
  const sourceBytes = Buffer.from("const governed = true;\n", "utf8");
  const noteBytes = Buffer.from("# Bound note\n\nExact local evidence.\n", "utf8");
  await mkdir(join(workspacePath, "src"), { recursive: true });
  await mkdir(join(graphRoot, "knowledge", "concepts"), { recursive: true });
  await writeFile(join(workspacePath, "src", "context.ts"), sourceBytes);
  await writeFile(
    join(graphRoot, "knowledge", "concepts", "context.md"),
    noteBytes,
  );
  const workspaceIdentity = `sha256:${"1".repeat(64)}`;
  const graphRootIdentity = `sha256:${"2".repeat(64)}`;
  const policyRevision = `sha256:${"3".repeat(64)}`;
  return {
    workspacePath,
    graphRoot,
    sourceBytes,
    noteBytes,
    environment: {
      workspacePath,
      graphRoot,
      workspaceIdentity,
      graphRootIdentity,
      policyRevision,
    },
  };
}

function proposal(sourceRefs) {
  return {
    operations: [{
      operationId: "verify-provenance",
      sourceRefs,
    }],
  };
}

async function activateDriftFinding(context, {
  bindingKind = "module",
  bindingRef = "src",
} = {}) {
  const specifier = `${bindingKind}:${bindingRef}`;
  const observed = await observeBoundSources({
    workspacePath: context.workspacePath,
    graphPath: context.graphRoot,
    bindings: [{ specifier, kind: bindingKind, ref: bindingRef }],
    hooks: {
      runGit: async () => ({ code: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }),
    },
  });
  const artifactOptions = {
    graphRoot: context.graphRoot,
    workspaceIdentity: context.environment.workspaceIdentity,
    graphRootIdentity: context.environment.graphRootIdentity,
    policyRevision: context.environment.policyRevision,
  };
  const before = await publishDriftObservation({
    ...artifactOptions,
    payload: { sequence: "before" },
  });
  const current = await publishDriftObservation({
    ...artifactOptions,
    payload: { sequence: "current" },
  });
  const finding = await publishDriftFinding({
    ...artifactOptions,
    payload: {
      specification: DRIFT_FINDING_SPECIFICATION,
      status: "potentially-stale",
      authority: "zero",
      graphRevision: taggedContentSha256("provenance graph revision"),
      observationBefore: { id: before.id, digest: before.digest },
      observationCurrent: { id: current.id, digest: current.digest },
      supersedes: [],
      note: {
        path: "knowledge/concepts/context.md",
        sha256: taggedContentSha256(context.noteBytes),
        kind: "concept",
        scope: "context",
        authorityClass: "canonical",
      },
      matchedBindings: [{
        specifier,
        kind: bindingKind,
        ref: bindingRef,
        beforeFingerprint: taggedContentSha256("prior source fingerprint"),
        currentFingerprint: observed.bindings[0].fingerprint,
      }],
      changedSources: [{
        path: "src/context.ts",
        change: "modified",
        beforeSha256: taggedContentSha256("prior context bytes"),
        currentSha256: taggedContentSha256(context.sourceBytes),
        beforeBytes: 19,
        currentBytes: context.sourceBytes.length,
        renamedFrom: null,
      }],
      recommendedOperation: "note.update",
      afterTextRequired: true,
    },
  });
  const refresh = await publishDriftRefresh({
    ...artifactOptions,
    payload: {
      finding: { id: finding.id, digest: finding.digest },
      recommendedOperation: "note.update",
      afterTextRequired: true,
    },
  });
  const state = {
    ...createDriftState({
      workspaceIdentity: context.environment.workspaceIdentity,
      graphRootIdentity: context.environment.graphRootIdentity,
      policyRevision: context.environment.policyRevision,
      updatedAt: "2026-07-18T12:00:00.000Z",
    }),
    latestObservation: {
      observationId: current.id,
      observationDigest: current.digest,
    },
    activeFindings: [{
      findingId: finding.id,
      findingDigest: finding.digest,
      refreshId: refresh.id,
      refreshDigest: refresh.digest,
      note: {
        path: "knowledge/concepts/context.md",
        sha256: taggedContentSha256(context.noteBytes),
      },
      proposalBindingIds: [],
    }],
  };
  await writeDriftState({ graphRoot: context.graphRoot, state });
  return { finding, state };
}

test("local proposal provenance is verified once per normalized binding", async () => {
  const context = await fixture();
  try {
    const file = {
      type: "file",
      ref: "src/context.ts",
      expectedSha256: taggedContentSha256(context.sourceBytes),
    };
    const note = {
      type: "note",
      ref: "knowledge/concepts/context.md",
      expectedSha256: taggedContentSha256(context.noteBytes),
    };
    const result = await verifyProposalSourceReferences(
      context.environment,
      proposal([
        file,
        { ...file },
        note,
        { type: "user", ref: "current-task:request", expectedSha256: null },
        { type: "operation", ref: "task:42", expectedSha256: null },
      ]),
    );

    assert.deepEqual(result, {
      references: 5,
      uniqueReferences: 4,
      bound: 3,
      verified: 3,
      uniqueVerified: 2,
      verifiedBytes: context.sourceBytes.length + context.noteBytes.length,
      cacheHits: 1,
      unresolved: 0,
    });
  } finally {
    await rm(context.workspacePath, { recursive: true, force: true });
  }
});

test("a drift proposal can exact-bind an immutable local finding artifact", async () => {
  const context = await fixture();
  try {
    const { finding } = await activateDriftFinding(context);
    const result = await verifyProposalSourceReferences(
      context.environment,
      proposal([{
        type: "drift-finding",
        ref: finding.id,
        expectedSha256: finding.digest,
      }]),
    );

    assert.equal(result.bound, 1);
    assert.equal(result.uniqueVerified, 1);
    assert.equal(result.verifiedBytes, finding.bytes.length);
  } finally {
    await rm(context.workspacePath, { recursive: true, force: true });
  }
});

test("drift provenance rechecks full bindings and active state at apply time", async (t) => {
  await t.test("module gains another file", async () => {
    const context = await fixture();
    try {
      const { finding } = await activateDriftFinding(context);
      await writeFile(join(context.workspacePath, "src", "later.ts"), "export {};\n");
      await assert.rejects(
        verifyProposalSourceReferences(context.environment, proposal([{
          type: "drift-finding",
          ref: finding.id,
          expectedSha256: finding.digest,
        }])),
        (error) => error?.code === "WRITE001" && /no longer active and source-fresh/u.test(error.message),
      );
    } finally {
      await rm(context.workspacePath, { recursive: true, force: true });
    }
  });

  await t.test("glob-bound file is deleted", async () => {
    const context = await fixture();
    try {
      const { finding } = await activateDriftFinding(context, {
        bindingKind: "path_glob",
        bindingRef: "src/**/*.ts",
      });
      await unlink(join(context.workspacePath, "src", "context.ts"));
      await assert.rejects(
        verifyProposalSourceReferences(context.environment, proposal([{
          type: "drift-finding",
          ref: finding.id,
          expectedSha256: finding.digest,
        }])),
        (error) => error?.code === "WRITE001" && /no longer active and source-fresh/u.test(error.message),
      );
    } finally {
      await rm(context.workspacePath, { recursive: true, force: true });
    }
  });

  await t.test("finding is acknowledged between review and apply", async () => {
    const context = await fixture();
    try {
      const { finding, state } = await activateDriftFinding(context);
      await writeDriftState({
        graphRoot: context.graphRoot,
        state: { ...state, activeFindings: [] },
      });
      await assert.rejects(
        verifyProposalSourceReferences(context.environment, proposal([{
          type: "drift-finding",
          ref: finding.id,
          expectedSha256: finding.digest,
        }])),
        (error) => error?.code === "WRITE001" && /no longer active and source-fresh/u.test(error.message),
      );
    } finally {
      await rm(context.workspacePath, { recursive: true, force: true });
    }
  });
});

test("conflicting, stale, and unverifiable provenance bindings fail closed", async (t) => {
  const context = await fixture();
  try {
    await t.test("conflicting normalized binding", async () => {
      await assert.rejects(
        verifyProposalSourceReferences(context.environment, proposal([
          {
            type: "file",
            ref: "src/context.ts",
            expectedSha256: taggedContentSha256(context.sourceBytes),
          },
          {
            type: "file",
            ref: "src/context.ts",
            expectedSha256: taggedContentSha256("different"),
          },
        ])),
        /conflicting digest bindings/,
      );
    });

    await t.test("stale local bytes", async () => {
      await assert.rejects(
        verifyProposalSourceReferences(context.environment, proposal([{
          type: "note",
          ref: "knowledge/concepts/context.md",
          expectedSha256: taggedContentSha256("stale"),
        }])),
        /provenance changed/,
      );
    });

    await t.test("digest claim for unresolved type", async () => {
      await assert.rejects(
        verifyProposalSourceReferences(context.environment, proposal([{
          type: "user",
          ref: "current-task:request",
          expectedSha256: taggedContentSha256("claim"),
        }])),
        /cannot claim locally verified digests/,
      );
    });
  } finally {
    await rm(context.workspacePath, { recursive: true, force: true });
  }
});

test("oversized provenance files are rejected from metadata before unbounded reads", async () => {
  const context = await fixture();
  try {
    const oversizedPath = join(context.workspacePath, "src", "oversized.bin");
    await mkdir(dirname(oversizedPath), { recursive: true });
    await writeFile(oversizedPath, Buffer.alloc(0));
    await truncate(oversizedPath, PROPOSAL_POLICY.maximumSourceFileBytes + 1);
    await assert.rejects(
      verifyProposalSourceReferences(context.environment, proposal([{
        type: "file",
        ref: "src/oversized.bin",
        expectedSha256: taggedContentSha256("unreachable"),
      }])),
      /exceeds 16777216 bytes/,
    );
  } finally {
    await rm(context.workspacePath, { recursive: true, force: true });
  }
});
