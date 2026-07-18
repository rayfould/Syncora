import assert from "node:assert/strict";
import { access, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { sealProposal } from "../../skills/syncora/scripts/lib/proposal-schema.mjs";
import {
  prepareProposalStore,
  publishSealedProposal,
} from "../../skills/syncora/scripts/lib/proposal-store.mjs";
import {
  buildReviewArtifact,
  publishReviewArtifact,
  verifyReviewArtifact,
} from "../../skills/syncora/scripts/lib/review-artifact.mjs";

const hash = (character) => `sha256:${character.repeat(64)}`;

function proposalInput(idempotencyKey, body) {
  return {
    schemaVersion: 1,
    kind: "syncora.proposal-input",
    idempotencyKey,
    origin: "capture",
    actor: { type: "agent", id: "artifact-test", runtime: process.version },
    reason: "Review exact hostile Markdown without executing its structure.",
    correctsProposalId: null,
    operations: [{
      operationId: `${idempotencyKey}-create`,
      kind: "note.create",
      sourceRefs: [{
        type: "user",
        ref: "current-task:review-artifact-test",
        expectedSha256: null,
      }],
      changes: [{
        path: `knowledge/concepts/${idempotencyKey}.md`,
        expectedPriorSha256: null,
        afterText: body,
      }],
    }],
  };
}

function proposalBindings() {
  return {
    workspaceIdentity: hash("1"),
    graphRootIdentity: hash("2"),
    expectedGraphRevision: hash("3"),
    validationSpecification: "markdown-graph-v1",
    policyRevision: hash("4"),
  };
}

function proposalAssessment(path) {
  return {
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
  };
}

async function temporaryGraph() {
  return realpath(await mkdtemp(join(tmpdir(), "syncora-review-artifact-")));
}

function sealed(idempotencyKey, body) {
  const path = `knowledge/concepts/${idempotencyKey}.md`;
  return sealProposal(
    proposalInput(idempotencyKey, body),
    proposalBindings(),
    {
      assessment: proposalAssessment(path),
      createdAt: "2026-07-17T13:00:00.000Z",
    },
  );
}

test("review artifact is deterministic, exact, safely prefixed, and publishable before its proposal", async () => {
  const graphRoot = await temporaryGraph();
  try {
    const proposal = sealed(
      "artifact-hostile",
      "# Heading\r\n```markdown\n[click](file:///hostile)\n<!-- marker -->\n",
    );
    const environment = {
      graphRoot,
      graphRootIdentity: hash("2"),
      workspaceIdentity: hash("1"),
    };
    const first = await buildReviewArtifact({ environment, proposal });
    const second = await buildReviewArtifact({ environment, proposal });
    assert.deepEqual(second.bytes, first.bytes);
    assert.equal(second.artifact.digest, first.artifact.digest);

    const published = await publishReviewArtifact({ environment, proposal });
    const paths = await prepareProposalStore(graphRoot);
    await access(published.artifact.path);
    await assert.rejects(access(join(paths.proposals, `${proposal.proposalId}.json`)));
    const artifact = await readFile(published.artifact.path, "utf8");
    assert.match(artifact, /^A 000001 "# Heading\\r\\n"$/mu);
    assert.match(artifact, /^A 000002 "```markdown\\n"$/mu);
    assert.doesNotMatch(artifact, /^```markdown$/mu);

    await publishSealedProposal({ graphRoot, proposal });
    const verified = await verifyReviewArtifact({ graphRoot, proposal });
    assert.equal(verified.digest, published.artifact.digest);
    assert.equal(verified.byteLength, Buffer.byteLength(artifact, "utf8"));
  } finally {
    await rm(graphRoot, { recursive: true, force: true });
  }
});

test("missing or tampered review evidence fails closed before approval can trust it", async () => {
  const graphRoot = await temporaryGraph();
  try {
    const missing = sealed("artifact-missing", "# Missing artifact\n");
    await publishSealedProposal({ graphRoot, proposal: missing });
    await assert.rejects(
      verifyReviewArtifact({ graphRoot, proposal: missing }),
      (error) => error?.code === "REVIEW001" && /missing/u.test(error.message),
    );

    const tampered = sealed("artifact-tampered", "# Original exact bytes\n");
    const environment = {
      graphRoot,
      graphRootIdentity: hash("2"),
      workspaceIdentity: hash("1"),
    };
    const published = await publishReviewArtifact({ environment, proposal: tampered });
    await publishSealedProposal({ graphRoot, proposal: tampered });
    await writeFile(published.artifact.path, "# replaced after publication\n", "utf8");
    await assert.rejects(
      verifyReviewArtifact({ graphRoot, proposal: tampered }),
      (error) => error?.code === "REVIEW001" && /missing or does not match/u.test(error.message),
    );
  } finally {
    await rm(graphRoot, { recursive: true, force: true });
  }
});
