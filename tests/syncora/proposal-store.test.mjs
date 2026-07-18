import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { publishImmutableFile } from "../../skills/syncora/scripts/lib/immutable-file.mjs";
import {
  PROPOSAL_STORE_POLICY,
  listConflictRecords,
  listReceiptRecords,
  listReviewRecords,
  prepareProposalStore,
  publishConflictRecord,
  publishProposal,
  publishProposalBlob,
  publishExactReceiptRecord,
  publishReceiptRecord,
  publishReviewRecord,
  readProposalBlob,
  readProposalSummary,
  readStoredProposal,
  sealReceiptRecord,
} from "../../skills/syncora/scripts/lib/proposal-store.mjs";

const hash = (character) => `sha256:${character.repeat(64)}`;

function input(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: "syncora.proposal-input",
    idempotencyKey: "current-task-capture-001",
    origin: "capture",
    actor: { type: "agent", id: "codex", runtime: "node-22" },
    reason: "Capture the explicitly requested durable result.",
    correctsProposalId: null,
    operations: [{
      operationId: "operation-1",
      kind: "note.create",
      sourceRefs: [{
        type: "user",
        ref: "current-task:explicit-request",
        expectedSha256: null,
      }],
      changes: [{
        path: "knowledge/concepts/immutable-proposal.md",
        expectedPriorSha256: null,
        afterText: "# Immutable proposal\n\nSTORE-PRIVATE-BODY\n",
      }],
    }],
    ...overrides,
  };
}

function bindings() {
  return {
    workspaceIdentity: hash("1"),
    graphRootIdentity: hash("2"),
    expectedGraphRevision: hash("3"),
    validationSpecification: "markdown-graph-v1",
    policyRevision: hash("4"),
  };
}

function assessment(path = "knowledge/concepts/immutable-proposal.md") {
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
  return realpath(await mkdtemp(join(tmpdir(), "syncora-proposal-store-")));
}

test("proposal publication creates only graph-scoped governance state and omits bodies from summaries", async () => {
  const graphRoot = await temporaryGraph();
  try {
    await writeFile(join(graphRoot, "index.md"), "# Existing graph\n", "utf8");
    const before = await readFile(join(graphRoot, "index.md"));
    const result = await publishProposal({
      graphRoot,
      input: input(),
      bindings: bindings(),
      assessment: assessment(),
      createdAt: "2026-07-17T10:00:00.000Z",
    });

    assert.equal(result.created, true);
    assert.equal(result.idempotent, false);
    assert.equal(JSON.stringify(result).includes("STORE-PRIVATE-BODY"), false);
    assert.deepEqual(await readFile(join(graphRoot, "index.md")), before);

    const paths = await prepareProposalStore(graphRoot);
    for (const path of [
      paths.proposals,
      paths.reviews,
      paths.operations,
      paths.transactions,
      paths.blobs,
      paths.reviewArtifactBlobs,
      paths.reviewArtifactBindings,
    ]) {
      await access(path);
    }
    const rootEntries = (await readdir(graphRoot)).sort();
    assert.deepEqual(rootEntries, [".syncora", "index.md"]);

    const stored = await readStoredProposal({
      graphRoot,
      proposalId: result.proposal.proposalId,
    });
    assert.match(stored.operations[0].changes[0].afterText, /STORE-PRIVATE-BODY/);
    const summary = await readProposalSummary({
      graphRoot,
      proposalId: result.proposal.proposalId,
    });
    assert.equal(JSON.stringify(summary).includes("STORE-PRIVATE-BODY"), false);

    const retry = await publishProposal({
      graphRoot,
      input: input(),
      bindings: bindings(),
      assessment: assessment(),
      createdAt: "2026-07-17T10:00:01.000Z",
    });
    assert.equal(retry.created, false);
    assert.equal(retry.idempotent, true);
    assert.equal(retry.proposal.proposalDigest, result.proposal.proposalDigest);
    assert.equal(retry.proposal.createdAt, "2026-07-17T10:00:00.000Z");
  } finally {
    await rm(graphRoot, { recursive: true, force: true });
  }
});

test("one idempotency key cannot bind two different proposal intents", async () => {
  const graphRoot = await temporaryGraph();
  try {
    await publishProposal({
      graphRoot,
      input: input(),
      bindings: bindings(),
      assessment: assessment(),
    });
    const changed = input();
    changed.operations[0].changes[0].afterText = "# Different intent\n";
    const changedAssessment = assessment();
    changedAssessment.projectedValidation.projectedGraphRevision = hash("7");
    await assert.rejects(
      publishProposal({
        graphRoot,
        input: changed,
        bindings: bindings(),
        assessment: changedAssessment,
      }),
      (error) => error?.code === "PROPOSAL002" && /idempotency key/i.test(error.message),
    );
  } finally {
    await rm(graphRoot, { recursive: true, force: true });
  }
});

test("concurrent identical publication has one winner and one semantic retry", async () => {
  const graphRoot = await temporaryGraph();
  try {
    const [first, second] = await Promise.all([
      publishProposal({
        graphRoot,
        input: input(),
        bindings: bindings(),
        assessment: assessment(),
        createdAt: "2026-07-17T10:00:00.000Z",
      }),
      publishProposal({
        graphRoot,
        input: input(),
        bindings: bindings(),
        assessment: assessment(),
        createdAt: "2026-07-17T10:00:01.000Z",
      }),
    ]);
    assert.deepEqual(
      [first.created, second.created].sort(),
      [false, true],
    );
    assert.equal(first.proposal.proposalId, second.proposal.proposalId);
    assert.equal(first.proposal.proposalDigest, second.proposal.proposalDigest);
  } finally {
    await rm(graphRoot, { recursive: true, force: true });
  }
});

test("different bytes cannot replace an immutable artifact", async () => {
  const graphRoot = await temporaryGraph();
  try {
    const paths = await prepareProposalStore(graphRoot);
    const path = join(paths.blobs, "fixed.blob");
    const first = await publishImmutableFile({
      root: graphRoot,
      path,
      bytes: Buffer.from("first"),
    });
    const retry = await publishImmutableFile({
      root: graphRoot,
      path,
      bytes: Buffer.from("first"),
    });
    assert.equal(first.created, true);
    assert.equal(retry.idempotent, true);
    await assert.rejects(
      publishImmutableFile({
        root: graphRoot,
        path,
        bytes: Buffer.from("second"),
      }),
      (error) => error?.code === "IMMUTABLE002",
    );
    assert.equal(await readFile(path, "utf8"), "first");
  } finally {
    await rm(graphRoot, { recursive: true, force: true });
  }
});

test("reviews, conflicts, and receipts are digest-bound immutable records with bounded lookup", async () => {
  const graphRoot = await temporaryGraph();
  try {
    const published = await publishProposal({
      graphRoot,
      input: input(),
      bindings: bindings(),
      assessment: assessment(),
    });
    const proposalId = published.proposal.proposalId;
    const proposalDigest = published.proposal.proposalDigest;

    await assert.rejects(
      publishReviewRecord({
        graphRoot,
        proposalId,
        proposalDigest: hash("0"),
        decision: "approve",
        reviewedBy: "Rudy",
        reason: "This digest must not be accepted.",
      }),
      (error) => error?.code === "PROPOSAL003",
    );

    const review = await publishReviewRecord({
      graphRoot,
      proposalId,
      proposalDigest,
      decision: "approve",
      reviewedBy: "Rudy",
      reason: "Approved exact proposal digest.",
      createdAt: "2026-07-17T10:01:00.000Z",
    });
    const reviewRetry = await publishReviewRecord({
      graphRoot,
      proposalId,
      proposalDigest,
      decision: "approve",
      reviewedBy: "Rudy",
      reason: "Approved exact proposal digest.",
      createdAt: "2026-07-17T10:02:00.000Z",
    });
    assert.equal(review.created, true);
    assert.equal(reviewRetry.idempotent, true);
    assert.equal(reviewRetry.review.reviewDigest, review.review.reviewDigest);
    assert.deepEqual(await listReviewRecords({ graphRoot, proposalId }), [review.review]);
    assert.deepEqual(
      await readdir(join((await prepareProposalStore(graphRoot)).reviews, proposalId)),
      [`${review.review.reviewId}.json`],
    );

    const conflict = await publishConflictRecord({
      graphRoot,
      proposalId,
      proposalDigest,
      code: "STALE_BASELINE",
      summary: "A target changed after proposal sealing.",
      mismatches: [{
        path: "knowledge/concepts/immutable-proposal.md",
        expectedSha256: null,
        currentSha256: hash("a"),
      }],
      createdAt: "2026-07-17T10:03:00.000Z",
    });
    assert.deepEqual(await listConflictRecords({ graphRoot, proposalId }), [conflict.conflict]);

    const receipt = await publishReceiptRecord({
      graphRoot,
      proposalId,
      proposalDigest,
      transactionId: "transaction-001",
      outcome: "applied",
      graphRevisionBefore: hash("3"),
      graphRevisionAfter: hash("6"),
      changes: [{
        path: "knowledge/concepts/immutable-proposal.md",
        beforeSha256: null,
        afterSha256: published.proposal.operations[0].changes[0].afterSha256,
      }],
      createdAt: "2026-07-17T10:04:00.000Z",
    });
    assert.deepEqual(await listReceiptRecords({ graphRoot, proposalId }), [receipt.receipt]);
    assert.deepEqual(
      (await readdir(join((await prepareProposalStore(graphRoot)).operations, proposalId))).sort(),
      [`${conflict.conflict.conflictId}.json`, `${receipt.receipt.receiptId}.json`].sort(),
    );
    assert.equal(JSON.stringify({ review, conflict, receipt }).includes("STORE-PRIVATE-BODY"), false);
  } finally {
    await rm(graphRoot, { recursive: true, force: true });
  }
});

test("derived-record lookup scales by proposal shard instead of one lifetime-global directory", async () => {
  const graphRoot = await temporaryGraph();
  try {
    const published = await publishProposal({
      graphRoot,
      input: input(),
      bindings: bindings(),
      assessment: assessment(),
    });
    const paths = await prepareProposalStore(graphRoot);
    const unrelated = PROPOSAL_STORE_POLICY.maximumListedReviews + 1;
    for (let offset = 0; offset < unrelated; offset += 256) {
      await Promise.all(
        Array.from(
          { length: Math.min(256, unrelated - offset) },
          (_, index) => mkdir(
            join(paths.reviews, `proposal_${(offset + index).toString(16).padStart(64, "0")}`),
          ),
        ),
      );
    }
    const review = await publishReviewRecord({
      graphRoot,
      proposalId: published.proposal.proposalId,
      proposalDigest: published.proposal.proposalDigest,
      decision: "reject",
      reviewedBy: "workspace-owner",
      reason: "Shard-local review remains available after project lifetime growth.",
    });
    assert.deepEqual(
      await listReviewRecords({ graphRoot, proposalId: published.proposal.proposalId }),
      [review.review],
    );
  } finally {
    await rm(graphRoot, { recursive: true, force: true });
  }
});

test("receipt sealing is pure and exact publication preserves the precomputed digest", async () => {
  const graphRoot = await temporaryGraph();
  try {
    const published = await publishProposal({
      graphRoot,
      input: input(),
      bindings: bindings(),
      assessment: assessment(),
    });
    const receiptInput = {
      proposalId: published.proposal.proposalId,
      proposalDigest: published.proposal.proposalDigest,
      transactionId: "transaction-precomputed-001",
      outcome: "applied",
      graphRevisionBefore: hash("3"),
      graphRevisionAfter: hash("6"),
      changes: [{
        path: "knowledge/concepts/immutable-proposal.md",
        beforeSha256: null,
        afterSha256: published.proposal.operations[0].changes[0].afterSha256,
      }],
      createdAt: "2026-07-17T12:00:00.000Z",
    };
    const first = sealReceiptRecord(receiptInput);
    const second = sealReceiptRecord(receiptInput);
    assert.deepEqual(second, first);
    await assert.rejects(
      async () => sealReceiptRecord({ ...receiptInput, createdAt: undefined }),
      (error) => error?.code === "PROPOSAL001" && /stable createdAt/u.test(error.message),
    );
    const stored = await publishExactReceiptRecord({ graphRoot, receipt: first });
    const retry = await publishExactReceiptRecord({ graphRoot, receipt: second });
    assert.equal(stored.receipt.receiptDigest, first.receiptDigest);
    assert.equal(retry.idempotent, true);
    assert.equal(retry.receipt.createdAt, receiptInput.createdAt);
  } finally {
    await rm(graphRoot, { recursive: true, force: true });
  }
});

test("correction lineage requires an existing same-graph rejected or conflicted proposal", async () => {
  const graphRoot = await temporaryGraph();
  try {
    const original = await publishProposal({
      graphRoot,
      input: input(),
      bindings: bindings(),
      assessment: assessment(),
    });
    const correction = input({
      idempotencyKey: "current-task-correction-001",
      correctsProposalId: original.proposal.proposalId,
    });
    await assert.rejects(
      publishProposal({
        graphRoot,
        input: correction,
        bindings: bindings(),
        assessment: assessment(),
      }),
      (error) => error?.code === "PROPOSAL003" && /rejected or conflicted/u.test(error.message),
    );
    await publishReviewRecord({
      graphRoot,
      proposalId: original.proposal.proposalId,
      proposalDigest: original.proposal.proposalDigest,
      decision: "reject",
      reviewedBy: "workspace-owner",
      reason: "Create a corrected proposal instead.",
    });
    const accepted = await publishProposal({
      graphRoot,
      input: correction,
      bindings: bindings(),
      assessment: assessment(),
    });
    assert.equal(accepted.created, true);
    assert.equal(
      (await readStoredProposal({ graphRoot, proposalId: accepted.proposal.proposalId }))
        .correctsProposalId,
      original.proposal.proposalId,
    );
  } finally {
    await rm(graphRoot, { recursive: true, force: true });
  }
});

test("content-addressed blobs are idempotent and distinct content gets a distinct ID", async () => {
  const graphRoot = await temporaryGraph();
  try {
    const first = await publishProposalBlob({ graphRoot, bytes: Buffer.from("alpha") });
    const retry = await publishProposalBlob({ graphRoot, bytes: Buffer.from("alpha") });
    const second = await publishProposalBlob({ graphRoot, bytes: Buffer.from("beta") });
    assert.equal(first.created, true);
    assert.equal(retry.idempotent, true);
    assert.equal(first.blobId, retry.blobId);
    assert.notEqual(first.blobId, second.blobId);
    assert.equal((await readProposalBlob({ graphRoot, blobId: first.blobId })).bytes.toString(), "alpha");
  } finally {
    await rm(graphRoot, { recursive: true, force: true });
  }
});

test("tampered proposal bytes fail closed", async () => {
  const graphRoot = await temporaryGraph();
  try {
    const result = await publishProposal({
      graphRoot,
      input: input(),
      bindings: bindings(),
      assessment: assessment(),
    });
    const paths = await prepareProposalStore(graphRoot);
    await writeFile(
      join(paths.proposals, `${result.proposal.proposalId}.json`),
      "{\"schemaVersion\":1}\n",
      "utf8",
    );
    await assert.rejects(
      readStoredProposal({ graphRoot, proposalId: result.proposal.proposalId }),
      (error) => error?.code === "PROPOSAL001",
    );
  } finally {
    await rm(graphRoot, { recursive: true, force: true });
  }
});

test("a hostile governance-directory link is rejected without touching its target", async (t) => {
  const graphRoot = await temporaryGraph();
  const target = await temporaryGraph();
  const reviews = join(graphRoot, ".syncora", "reviews");
  try {
    await prepareProposalStore(graphRoot);
    await rm(reviews, { recursive: true, force: true });
    await writeFile(join(target, "sentinel.txt"), "preserve\n", "utf8");
    try {
      await symlink(target, reviews, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      t.skip(`Directory links unavailable: ${error.message}`);
      return;
    }
    await assert.rejects(
      prepareProposalStore(graphRoot),
      (error) => error?.code === "PROPOSAL004",
    );
    assert.equal(await readFile(join(target, "sentinel.txt"), "utf8"), "preserve\n");
  } finally {
    await rm(reviews, { force: true }).catch(() => undefined);
    await rm(graphRoot, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});
