import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { captureKnowledge } from "../../skills/syncora/scripts/lib/autonomous-capture.mjs";
import {
  DRIFT_FINDING_SPECIFICATION,
} from "../../skills/syncora/scripts/lib/drift-governance.mjs";
import { observeBoundSources } from "../../skills/syncora/scripts/lib/drift-source.mjs";
import {
  createDriftState,
  publishDriftFinding,
  publishDriftObservation,
  publishDriftRefresh,
  writeDriftState,
} from "../../skills/syncora/scripts/lib/drift-state.mjs";
import { applyGovernedProposal } from "../../skills/syncora/scripts/lib/governed-apply.mjs";
import { createGovernedProposal } from "../../skills/syncora/scripts/lib/governed-capture.mjs";
import { resolveGovernedEnvironment } from "../../skills/syncora/scripts/lib/governed-environment.mjs";
import { reviewGovernedProposal } from "../../skills/syncora/scripts/lib/governed-review.mjs";
import { initializeWorkspace } from "../../skills/syncora/scripts/lib/init.mjs";
import { taggedContentSha256 } from "../../skills/syncora/scripts/lib/proposal-schema.mjs";

const TARGET_NOTE = "knowledge/projects/workspace.md";
const SOURCE_PATH = "src/update-status.mjs";

async function initializedWorkspace() {
  const workspace = await realpath(
    await mkdtemp(join(tmpdir(), "syncora-governed-drift-capture-")),
  );
  await initializeWorkspace({
    workspace,
    dryRun: false,
    patchAgents: false,
    allowExternalGraphRoot: undefined,
    confirmPredecessorReviewed: false,
  });
  return workspace;
}

function updatedProjectHub(before, statement) {
  const bootstrap =
    "- Syncora initialized. Replace this bootstrap statement with verified state.";
  assert.ok(before.includes(bootstrap));
  return before.replace(bootstrap, `- ${statement}`);
}

async function activeDriftFinding(workspace, before) {
  await mkdir(join(workspace, "src"), { recursive: true });
  const sourceBytes = "export const staleBuildPrompt = true;\n";
  await writeFile(join(workspace, ...SOURCE_PATH.split("/")), sourceBytes, "utf8");
  const environment = await resolveGovernedEnvironment({
    workspace,
    allowExternalGraphRoot: undefined,
  });
  const binding = {
    specifier: "file:src/update-status.mjs",
    kind: "file",
    ref: SOURCE_PATH,
  };
  const observation = await observeBoundSources({
    workspacePath: environment.workspacePath,
    graphPath: environment.graphRoot,
    bindings: [binding],
    hooks: {
      runGit: async () => ({
        code: 1,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
      }),
    },
  });
  const artifactOptions = {
    graphRoot: environment.graphRoot,
    workspaceIdentity: environment.workspaceIdentity,
    graphRootIdentity: environment.graphRootIdentity,
    policyRevision: environment.policyRevision,
  };
  const prior = await publishDriftObservation({
    ...artifactOptions,
    payload: { sequence: "prior" },
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
      graphRevision: taggedContentSha256("governed drift capture graph"),
      observationBefore: { id: prior.id, digest: prior.digest },
      observationCurrent: { id: current.id, digest: current.digest },
      supersedes: [],
      note: {
        path: TARGET_NOTE,
        sha256: taggedContentSha256(before),
        kind: "project",
        scope: "workspace",
        authorityClass: "canonical",
      },
      matchedBindings: [{
        ...binding,
        beforeFingerprint: taggedContentSha256("prior source fingerprint"),
        currentFingerprint: observation.bindings[0].fingerprint,
      }],
      changedSources: [{
        path: SOURCE_PATH,
        change: "modified",
        beforeSha256: taggedContentSha256("prior source bytes"),
        currentSha256: taggedContentSha256(sourceBytes),
        beforeBytes: 19,
        currentBytes: Buffer.byteLength(sourceBytes),
        renamedFrom: null,
      }],
      recommendedOperation: "hub.refresh",
      afterTextRequired: true,
    },
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
      workspaceIdentity: environment.workspaceIdentity,
      graphRootIdentity: environment.graphRootIdentity,
      policyRevision: environment.policyRevision,
      updatedAt: "2026-08-04T12:00:00.000Z",
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
        path: TARGET_NOTE,
        sha256: taggedContentSha256(before),
      },
      proposalBindingIds: [],
    }],
  };
  await writeDriftState({ graphRoot: environment.graphRoot, state });
  return finding;
}

function driftProposalInput({ finding, before, after, key }) {
  return {
    schemaVersion: 1,
    kind: "syncora.proposal-input",
    idempotencyKey: key,
    origin: "drift",
    actor: {
      type: "agent",
      id: "governed-drift-capture-test",
      runtime: process.version,
    },
    reason: "Repair one exact active drift finding through governed capture.",
    correctsProposalId: null,
    operations: [{
      operationId: `${key}-refresh`,
      kind: "hub.refresh",
      sourceRefs: [{
        type: "drift-finding",
        ref: finding.id,
        expectedSha256: finding.digest,
      }],
      changes: [{
        path: TARGET_NOTE,
        expectedPriorSha256: taggedContentSha256(before),
        afterText: after,
      }],
    }],
  };
}

async function writeInput(workspace, name, input) {
  const inputPath = join(workspace, `${name}.json`);
  await writeFile(inputPath, `${JSON.stringify(input, null, 2)}\n`, "utf8");
  return inputPath;
}

test("governed drift capture verifies the reviewed post-image after publication", async () => {
  const workspace = await initializedWorkspace();
  try {
    const target = join(workspace, "local", ...TARGET_NOTE.split("/"));
    const before = await readFile(target, "utf8");
    const after = updatedProjectHub(before, "Stale builds prompt the owner to update.");
    const finding = await activeDriftFinding(workspace, before);
    const input = await writeInput(
      workspace,
      "drift-capture-post-image",
      driftProposalInput({
        finding,
        before,
        after,
        key: "drift-capture-post-image",
      }),
    );

    const result = await captureKnowledge({
      workspace,
      allowExternalGraphRoot: undefined,
      input,
      dryRun: false,
    });

    assert.equal(result.state, "applied");
    assert.equal(await readFile(target, "utf8"), after);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("an unreviewed drift post-image fails closed without overwriting external bytes", async () => {
  const workspace = await initializedWorkspace();
  try {
    const target = join(workspace, "local", ...TARGET_NOTE.split("/"));
    const before = await readFile(target, "utf8");
    const after = updatedProjectHub(before, "Stale builds prompt the owner to update.");
    const finding = await activeDriftFinding(workspace, before);
    const input = await writeInput(
      workspace,
      "drift-capture-tamper",
      driftProposalInput({
        finding,
        before,
        after,
        key: "drift-capture-tamper",
      }),
    );
    const created = await createGovernedProposal({
      workspace,
      allowExternalGraphRoot: undefined,
      command: "capture",
      input,
      dryRun: false,
    });
    await reviewGovernedProposal({
      workspace,
      allowExternalGraphRoot: undefined,
      proposal: created.proposal.id,
      proposalDigest: created.proposal.digest,
      decision: "approve",
      reviewedBy: "governed-drift-capture-reviewer",
      reason: "Approve the exact reviewed drift repair post-image.",
      dryRun: false,
    });

    const externalBytes = "unreviewed canonical bytes\n";
    await assert.rejects(
      applyGovernedProposal({
        workspace,
        allowExternalGraphRoot: undefined,
        proposal: created.proposal.id,
        dryRun: false,
      }, {
        async boundary(name) {
          if (name === "apply.after-canonical-publication") {
            await writeFile(target, externalBytes, "utf8");
          }
        },
      }),
      (error) => error?.code === "WRITE004",
    );
    assert.equal(await readFile(target, "utf8"), externalBytes);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
