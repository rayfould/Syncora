import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveGovernedEnvironment } from "../../skills/syncora/scripts/lib/governed-environment.mjs";
import { reviewGovernedProposal } from "../../skills/syncora/scripts/lib/governed-review.mjs";
import { initializeWorkspace } from "../../skills/syncora/scripts/lib/init.mjs";
import { sealProposal } from "../../skills/syncora/scripts/lib/proposal-schema.mjs";
import {
  publishConflictRecord,
  publishSealedProposal,
} from "../../skills/syncora/scripts/lib/proposal-store.mjs";
import { publishReviewArtifact } from "../../skills/syncora/scripts/lib/review-artifact.mjs";
import { inspectWorkspace } from "../../skills/syncora/scripts/lib/validate.mjs";

const hash = (character) => `sha256:${character.repeat(64)}`;

async function initializedWorkspace() {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "syncora-governed-review-")));
  await initializeWorkspace({
    workspace,
    dryRun: false,
    patchAgents: false,
    allowExternalGraphRoot: undefined,
    confirmPredecessorReviewed: false,
  });
  return workspace;
}

async function createProposal(workspace, name, { artifact = true } = {}) {
  const options = { workspace, allowExternalGraphRoot: undefined };
  const environment = await resolveGovernedEnvironment(options);
  const inspection = await inspectWorkspace(options);
  const path = `knowledge/concepts/review-${name}.md`;
  const proposal = sealProposal({
    schemaVersion: 1,
    kind: "syncora.proposal-input",
    idempotencyKey: `governed-review-${name}`,
    origin: "capture",
    actor: { type: "agent", id: "review-test", runtime: process.version },
    reason: `Exercise governed review ${name}.`,
    correctsProposalId: null,
    operations: [{
      operationId: `review-${name}-create`,
      kind: "note.create",
      sourceRefs: [{
        type: "user",
        ref: `current-task:review-${name}`,
        expectedSha256: null,
      }],
      changes: [{
        path,
        expectedPriorSha256: null,
        afterText: `---\nid: review-${name}\nkind: concept\nscope: workspace\nstate: active\nauthority: canonical\nschema_version: 1\ncreated: 2026-07-17\nupdated: 2026-07-17\nsummary: Review test note.\n---\n\n# Review ${name}\n`,
      }],
    }],
  }, {
    workspaceIdentity: environment.workspaceIdentity,
    graphRootIdentity: environment.graphRootIdentity,
    expectedGraphRevision: inspection.report.graph.revision,
    validationSpecification: environment.validationSpecification,
    policyRevision: environment.policyRevision,
  }, {
    assessment: {
      authorityImpact: {
        level: "canonical-content",
        reasons: ["Creates canonical Markdown."],
        paths: [path],
      },
      reviewRequired: true,
      projectedValidation: {
        valid: true,
        findingCount: 0,
        digest: hash("5"),
        projectedGraphRevision: hash("6"),
      },
      duplicateCandidates: [],
    },
    createdAt: "2026-07-17T14:00:00.000Z",
  });
  const reviewArtifact = artifact
    ? await publishReviewArtifact({ environment, proposal })
    : null;
  await publishSealedProposal({ graphRoot: environment.graphRoot, proposal });
  return { environment, proposal, reviewArtifact };
}

function reviewOptions(workspace, proposal, overrides = {}) {
  return {
    workspace,
    allowExternalGraphRoot: undefined,
    proposal: proposal.proposalId,
    proposalDigest: proposal.proposalDigest,
    decision: "approve",
    reviewedBy: "first-reviewer",
    reason: "First reviewer inspected the exact local artifact.",
    dryRun: false,
    ...overrides,
  };
}

test("approval requires exact evidence and idempotent replay reports stored attribution", async () => {
  const workspace = await initializedWorkspace();
  try {
    const created = await createProposal(workspace, "attribution");
    const first = await reviewGovernedProposal(reviewOptions(workspace, created.proposal));
    assert.equal(first.reviewedBy, "first-reviewer");
    assert.equal(first.artifact.digest, created.reviewArtifact.artifact.digest);

    const replay = await reviewGovernedProposal(reviewOptions(workspace, created.proposal, {
      reviewedBy: "second-reviewer",
      reason: "This retry must not rewrite attribution.",
    }));
    assert.equal(replay.idempotent, true);
    assert.equal(replay.reviewedBy, "first-reviewer");
    assert.equal(replay.reason, "First reviewer inspected the exact local artifact.");
    assert.equal(replay.review.reviewDigest, first.review.reviewDigest);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("missing or tampered evidence blocks approval", async () => {
  const workspace = await initializedWorkspace();
  try {
    const missing = await createProposal(workspace, "missing", { artifact: false });
    await assert.rejects(
      reviewGovernedProposal(reviewOptions(workspace, missing.proposal)),
      (error) => error?.code === "REVIEW001" && /artifact is missing/u.test(error.message),
    );

    const tampered = await createProposal(workspace, "tampered");
    await writeFile(tampered.reviewArtifact.artifact.path, "# tampered\n", "utf8");
    await assert.rejects(
      reviewGovernedProposal(reviewOptions(workspace, tampered.proposal)),
      (error) => error?.code === "REVIEW001" && /missing or does not match/u.test(error.message),
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a recorded proposal conflict is terminal for approval and rejection", async () => {
  const workspace = await initializedWorkspace();
  try {
    const created = await createProposal(workspace, "conflicted");
    await publishConflictRecord({
      graphRoot: created.environment.graphRoot,
      proposalId: created.proposal.proposalId,
      proposalDigest: created.proposal.proposalDigest,
      code: "WRITE001",
      summary: "Canonical state changed after proposal sealing.",
      mismatches: [],
    });
    for (const decision of ["approve", "reject"]) {
      await assert.rejects(
        reviewGovernedProposal(reviewOptions(workspace, created.proposal, { decision })),
        (error) => error?.code === "REVIEW001" && /recorded conflict/u.test(error.message),
      );
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
