import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { renderError, renderResult } from "../../skills/syncora/scripts/lib/cli.mjs";
import { applyGovernedProposal } from "../../skills/syncora/scripts/lib/governed-apply.mjs";
import { createGovernedProposal } from "../../skills/syncora/scripts/lib/governed-capture.mjs";
import { reviewGovernedProposal } from "../../skills/syncora/scripts/lib/governed-review.mjs";
import {
  readActiveFileTransaction,
  readFileTransaction,
} from "../../skills/syncora/scripts/lib/file-transaction.mjs";
import { initializeWorkspace } from "../../skills/syncora/scripts/lib/init.mjs";
import { taggedContentSha256 } from "../../skills/syncora/scripts/lib/proposal-schema.mjs";
import {
  listConflictRecords,
  listReceiptRecords,
} from "../../skills/syncora/scripts/lib/proposal-store.mjs";

const TARGET_NOTE = "knowledge/projects/workspace.md";

async function initializedWorkspace() {
  const workspace = await realpath(
    await mkdtemp(join(tmpdir(), "syncora-governed-recovery-")),
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

function updatedProjectHub(before, durableText) {
  const bootstrap =
    "- Syncora initialized. Replace this bootstrap statement with verified state.";
  assert.ok(before.includes(bootstrap));
  return before.replace(bootstrap, `- ${durableText}`);
}

function proposalInput({
  idempotencyKey,
  beforeText,
  afterText,
  sourceRef = {
    type: "user",
    ref: `current-task:${idempotencyKey}`,
    expectedSha256: null,
  },
}) {
  return {
    schemaVersion: 1,
    kind: "syncora.proposal-input",
    idempotencyKey,
    origin: "capture",
    actor: {
      type: "agent",
      id: "governed-recovery-test",
      runtime: process.version,
    },
    reason: "Exercise the governed apply recovery contract at an injected boundary.",
    correctsProposalId: null,
    operations: [{
      operationId: `${idempotencyKey}-update`,
      kind: "note.update",
      sourceRefs: [sourceRef],
      changes: [{
        path: TARGET_NOTE,
        expectedPriorSha256: taggedContentSha256(beforeText),
        afterText,
      }],
    }],
  };
}

async function approvedProposal(workspace, {
  idempotencyKey,
  secret,
  sourceRef = undefined,
}) {
  const target = join(workspace, "local", ...TARGET_NOTE.split("/"));
  const before = await readFile(target, "utf8");
  const after = updatedProjectHub(before, secret);
  const inputPath = join(workspace, `${idempotencyKey}.json`);
  await writeFile(
    inputPath,
    `${JSON.stringify(proposalInput({
      idempotencyKey,
      beforeText: before,
      afterText: after,
      ...(sourceRef ? { sourceRef } : {}),
    }), null, 2)}\n`,
    "utf8",
  );
  const captured = await createGovernedProposal({
    workspace,
    allowExternalGraphRoot: undefined,
    command: "capture",
    input: inputPath,
    dryRun: false,
  });
  await reviewGovernedProposal({
    workspace,
    allowExternalGraphRoot: undefined,
    proposal: captured.proposal.id,
    proposalDigest: captured.proposal.digest,
    decision: "approve",
    reviewedBy: "governed-recovery-reviewer",
    reason: "Inspected the exact digest-bound review artifact before approval.",
    dryRun: false,
  });
  return {
    target,
    graphRoot: join(workspace, "local"),
    before,
    after,
    secret,
    proposal: captured.proposal,
    transactionId: `apply_${captured.proposal.id.slice("proposal_".length)}`,
    applyOptions: {
      workspace,
      allowExternalGraphRoot: undefined,
      proposal: captured.proposal.id,
      dryRun: false,
    },
  };
}

async function rejection(promise, code) {
  try {
    await promise;
  } catch (error) {
    assert.equal(error?.code, code, error?.stack ?? String(error));
    return error;
  }
  assert.fail(`Expected ${code}.`);
}

function assertResultDoesNotLeak(result, secret) {
  for (const format of ["json", "text"]) {
    assert.equal(renderResult(result, format).includes(secret), false);
  }
  assert.equal(JSON.stringify(result).includes(secret), false);
}

function assertErrorDoesNotLeak(error, secret) {
  for (const format of ["json", "text"]) {
    assert.equal(renderError(error, format).includes(secret), false);
  }
  assert.equal(JSON.stringify(error?.details ?? null).includes(secret), false);
}

test("a pre-commit crash restores exact bytes and a retry backfills the rolled-back receipt", async () => {
  const workspace = await initializedWorkspace();
  try {
    const fixture = await approvedProposal(workspace, {
      idempotencyKey: "recovery-before-commit",
      secret: "SECRET-PRECOMMIT-NOTE-BODY-61a7a5",
    });
    const error = await rejection(
      applyGovernedProposal(fixture.applyOptions, {
        boundary(name) {
          if (name === "apply.after-canonical-publication") {
            throw new Error("injected process exit before commit");
          }
        },
        receipt: {
          beforePublish() {
            throw new Error("injected process exit before rollback receipt publication");
          },
        },
      }),
      "WRITE004",
    );
    assertErrorDoesNotLeak(error, fixture.secret);
    assert.equal(await readFile(fixture.target, "utf8"), fixture.before);
    assert.equal(
      (await readFileTransaction({
        graphRoot: fixture.graphRoot,
        transactionId: fixture.transactionId,
      })).status,
      "rolled-back",
    );
    assert.equal(await readActiveFileTransaction(fixture.graphRoot), null);
    assert.deepEqual(
      await listReceiptRecords({
        graphRoot: fixture.graphRoot,
        proposalId: fixture.proposal.id,
      }),
      [],
    );

    const retryError = await rejection(
      applyGovernedProposal(fixture.applyOptions),
      "WRITE008",
    );
    assertErrorDoesNotLeak(retryError, fixture.secret);
    const receipts = await listReceiptRecords({
      graphRoot: fixture.graphRoot,
      proposalId: fixture.proposal.id,
    });
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].outcome, "rolled-back");
    assert.equal(receipts[0].graphRevisionAfter, receipts[0].graphRevisionBefore);
    assert.equal(await readFile(fixture.target, "utf8"), fixture.before);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a crash after irreversible commit cannot roll back and retry publishes the exact bound receipt", async () => {
  const workspace = await initializedWorkspace();
  try {
    const sourcePath = join(workspace, "committed-evidence.txt");
    const sourceBefore = "evidence valid at commit\n";
    await writeFile(sourcePath, sourceBefore, "utf8");
    const fixture = await approvedProposal(workspace, {
      idempotencyKey: "recovery-after-commit",
      secret: "SECRET-COMMITTED-NOTE-BODY-33e175",
      sourceRef: {
        type: "file",
        ref: "committed-evidence.txt",
        expectedSha256: taggedContentSha256(sourceBefore),
      },
    });
    const error = await rejection(
      applyGovernedProposal(fixture.applyOptions, {
        boundary(name) {
          if (name === "apply.after-irreversible-commit") {
            throw new Error("injected process exit after irreversible commit");
          }
        },
      }),
      "WRITE009",
    );
    assertErrorDoesNotLeak(error, fixture.secret);
    const committed = await readFileTransaction({
      graphRoot: fixture.graphRoot,
      transactionId: fixture.transactionId,
    });
    assert.equal(committed.status, "finalized-pending-receipt");
    assert.match(committed.receiptSha256, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(await readFile(fixture.target, "utf8"), fixture.after);
    assert.equal(
      (await listReceiptRecords({
        graphRoot: fixture.graphRoot,
        proposalId: fixture.proposal.id,
      })).length,
      0,
    );

    // Provenance is a pre-commit condition. Once the journal crosses the
    // irreversible boundary, later source churn cannot strand receipt recovery.
    await writeFile(sourcePath, "evidence changed after commit\n", "utf8");
    const recovered = await applyGovernedProposal(fixture.applyOptions);
    assertResultDoesNotLeak(recovered, fixture.secret);
    const receipts = await listReceiptRecords({
      graphRoot: fixture.graphRoot,
      proposalId: fixture.proposal.id,
    });
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].outcome, "applied");
    assert.equal(receipts[0].receiptDigest, committed.receiptSha256);
    assert.equal(
      (await readFileTransaction({
        graphRoot: fixture.graphRoot,
        transactionId: fixture.transactionId,
      })).status,
      "finalized",
    );
    assert.equal(await readActiveFileTransaction(fixture.graphRoot), null);
    assert.equal(await readFile(fixture.target, "utf8"), fixture.after);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a crash after receipt publication retries by finalizing the existing exact receipt", async () => {
  const workspace = await initializedWorkspace();
  try {
    const fixture = await approvedProposal(workspace, {
      idempotencyKey: "recovery-after-receipt",
      secret: "SECRET-RECEIPT-NOTE-BODY-d11dc0",
    });
    await rejection(
      applyGovernedProposal(fixture.applyOptions, {
        boundary(name) {
          if (name === "apply.after-receipt-publication") {
            throw new Error("injected process exit after receipt publication");
          }
        },
      }),
      "WRITE009",
    );
    const pending = await readFileTransaction({
      graphRoot: fixture.graphRoot,
      transactionId: fixture.transactionId,
    });
    const beforeRetry = await listReceiptRecords({
      graphRoot: fixture.graphRoot,
      proposalId: fixture.proposal.id,
    });
    assert.equal(pending.status, "finalized-pending-receipt");
    assert.equal(beforeRetry.length, 1);
    assert.equal(beforeRetry[0].receiptDigest, pending.receiptSha256);

    const recovered = await applyGovernedProposal(fixture.applyOptions);
    assertResultDoesNotLeak(recovered, fixture.secret);
    const afterRetry = await listReceiptRecords({
      graphRoot: fixture.graphRoot,
      proposalId: fixture.proposal.id,
    });
    assert.equal(afterRetry.length, 1);
    assert.equal(afterRetry[0].receiptDigest, beforeRetry[0].receiptDigest);
    assert.equal(
      (await readFileTransaction({
        graphRoot: fixture.graphRoot,
        transactionId: fixture.transactionId,
      })).status,
      "finalized",
    );
    assert.equal(await readActiveFileTransaction(fixture.graphRoot), null);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a finalize crash after the final journal update is cleaned up idempotently", async () => {
  const workspace = await initializedWorkspace();
  try {
    const fixture = await approvedProposal(workspace, {
      idempotencyKey: "recovery-finalize-cleanup",
      secret: "SECRET-FINALIZE-NOTE-BODY-c9f2a1",
    });
    await rejection(
      applyGovernedProposal(fixture.applyOptions, {
        fileTransaction: {
          boundary(name) {
            if (name === "finalize.before-active-release") {
              throw new Error("injected process exit before active marker release");
            }
          },
        },
      }),
      "WRITE009",
    );
    assert.equal(
      (await readFileTransaction({
        graphRoot: fixture.graphRoot,
        transactionId: fixture.transactionId,
      })).status,
      "finalized",
    );
    assert.equal(
      (await readActiveFileTransaction(fixture.graphRoot)).transactionId,
      fixture.transactionId,
    );

    const recovered = await applyGovernedProposal(fixture.applyOptions);
    assert.equal(recovered.idempotent, true);
    assertResultDoesNotLeak(recovered, fixture.secret);
    assert.equal(await readActiveFileTransaction(fixture.graphRoot), null);
    assert.equal(await readFile(fixture.target, "utf8"), fixture.after);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("source changes at the commit boundary roll back and every recorded conflict stays terminal", async () => {
  const workspace = await initializedWorkspace();
  try {
    const sourcePath = join(workspace, "governed-evidence.txt");
    const sourceBefore = "durable evidence v1\n";
    const sourceChanged = "durable evidence v2\n";
    await writeFile(sourcePath, sourceBefore, "utf8");
    const fixture = await approvedProposal(workspace, {
      idempotencyKey: "recovery-source-toctou",
      secret: "SECRET-SOURCE-TOCTOU-NOTE-BODY-21d643",
      sourceRef: {
        type: "file",
        ref: "governed-evidence.txt",
        expectedSha256: taggedContentSha256(sourceBefore),
      },
    });
    const error = await rejection(
      applyGovernedProposal(fixture.applyOptions, {
        async boundary(name) {
          if (name === "apply.after-canonical-publication") {
            await writeFile(sourcePath, sourceChanged, "utf8");
          }
        },
      }),
      "WRITE004",
    );
    assertErrorDoesNotLeak(error, fixture.secret);
    assert.equal(await readFile(fixture.target, "utf8"), fixture.before);
    const conflicts = await listConflictRecords({
      graphRoot: fixture.graphRoot,
      proposalId: fixture.proposal.id,
    });
    assert.equal(conflicts.length, 1);
    assert.match(conflicts[0].summary, /provenance changed/u);
    assert.equal(
      (await listReceiptRecords({
        graphRoot: fixture.graphRoot,
        proposalId: fixture.proposal.id,
      })).some((receipt) => receipt.outcome === "applied"),
      false,
    );

    await writeFile(sourcePath, sourceBefore, "utf8");
    const retryError = await rejection(
      applyGovernedProposal(fixture.applyOptions),
      "WRITE008",
    );
    assertErrorDoesNotLeak(retryError, fixture.secret);
    await assert.rejects(
      reviewGovernedProposal({
        workspace,
        allowExternalGraphRoot: undefined,
        proposal: fixture.proposal.id,
        proposalDigest: fixture.proposal.digest,
        decision: "approve",
        reviewedBy: "governed-recovery-reviewer",
        reason: "A reverted source must not erase the terminal conflict.",
        dryRun: false,
      }),
      (reviewError) =>
        reviewError?.code === "REVIEW001" && /recorded conflict/u.test(reviewError.message),
    );
    assert.equal(await readFile(fixture.target, "utf8"), fixture.before);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
