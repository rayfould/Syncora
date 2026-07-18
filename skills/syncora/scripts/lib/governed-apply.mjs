import { SyncoraError } from "./cli.mjs";
import {
  applyFileTransaction,
  assertFileTransactionAvailable,
  commitFileTransaction,
  finalizeFileTransaction,
  prepareFileTransaction,
  readFileTransaction,
  rollbackFileTransaction,
} from "./file-transaction.mjs";
import {
  assertNoActiveMigration,
  readCanonicalNoteBytes,
  withGovernedApplyLock,
  withGovernedGraphLock,
} from "./governed-environment.mjs";
import { validateProjectedGraph } from "./projected-graph.mjs";
import { verifyProposalSourceReferences } from "./proposal-provenance.mjs";
import {
  canonicalProposalJson,
  taggedContentSha256,
} from "./proposal-schema.mjs";
import { assessProposalSemantics } from "./proposal-semantics.mjs";
import {
  listConflictRecords,
  listReceiptRecords,
  listReviewRecords,
  publishConflictRecord,
  publishExactReceiptRecord,
  readStoredProposal,
  sealReceiptRecord,
} from "./proposal-store.mjs";
import { verifyReviewArtifact } from "./review-artifact.mjs";
import { inspectWorkspaceUnlocked as inspectWorkspace } from "./validate.mjs";

const MAXIMUM_RETURNED_CHANGES = 32;

function applyError(code, message, details = undefined) {
  return new SyncoraError(code, message, details);
}

function transactionIdFor(proposalId) {
  return `apply_${proposalId.slice("proposal_".length)}`;
}

function assertProposalEnvironment(proposal, environment) {
  const bindings = proposal.bindings;
  if (
    bindings.workspaceIdentity !== environment.workspaceIdentity ||
    bindings.graphRootIdentity !== environment.graphRootIdentity
  ) {
    throw applyError(
      "PROPOSAL002",
      "Proposal is bound to a different workspace or resolved graph.",
    );
  }
  if (
    bindings.validationSpecification !== environment.validationSpecification ||
    bindings.policyRevision !== environment.policyRevision
  ) {
    throw applyError(
      "REVIEW001",
      "Proposal policy is stale; create and review a corrected proposal.",
    );
  }
}

function requireApproval(proposal, reviews) {
  for (const review of reviews) {
    if (review.proposalDigest !== proposal.proposalDigest) {
      throw applyError(
        "REVIEW001",
        "Stored review does not bind the exact proposal digest.",
      );
    }
  }
  if (reviews.some((review) => review.decision === "reject")) {
    throw applyError("REVIEW001", "Proposal has been rejected and is terminal.");
  }
  if (!reviews.some((review) => review.decision === "approve")) {
    throw applyError(
      "REVIEW001",
      "Proposal requires an explicit digest-bound approval before apply.",
    );
  }
}

function proposalChangeRecords(proposal) {
  return proposal.operations.flatMap((operation) =>
    operation.changes.map((change) => ({
      path: change.path,
      beforeSha256: change.expectedPriorSha256,
      afterSha256: change.afterSha256,
    })),
  );
}

function proposalInputFromStored(proposal) {
  return {
    schemaVersion: proposal.schemaVersion,
    kind: "syncora.proposal-input",
    idempotencyKey: proposal.idempotencyKey,
    origin: proposal.origin,
    actor: proposal.actor,
    reason: proposal.reason,
    correctsProposalId: proposal.correctsProposalId,
    operations: proposal.operations.map((operation) => ({
      operationId: operation.operationId,
      kind: operation.kind,
      sourceRefs: operation.sourceRefs,
      changes: operation.changes.map((change) => ({
        path: change.path,
        expectedPriorSha256: change.expectedPriorSha256,
        afterText: change.afterText,
      })),
    })),
  };
}

function boundedChangeSummaries(proposal) {
  const all = proposal.operations.flatMap((operation) =>
    operation.changes.map((change) => ({
      action:
        change.expectedPriorSha256 === null
          ? "create"
          : change.afterSha256 === null
            ? "delete"
            : "update",
      path: change.path,
      beforeSha256: change.expectedPriorSha256,
      afterSha256: change.afterSha256,
      operationId: operation.operationId,
      operationKind: operation.kind,
    })),
  );
  return {
    changes: all.slice(0, MAXIMUM_RETURNED_CHANGES),
    omittedChanges: Math.max(0, all.length - MAXIMUM_RETURNED_CHANGES),
    total: all.length,
  };
}

async function materializeProposalChanges(environment, proposal) {
  const projected = [];
  const transaction = [];
  const mismatches = [];
  for (const operation of proposal.operations) {
    for (const change of operation.changes) {
      const before = await readCanonicalNoteBytes(environment, change.path);
      const currentSha256 = before === null ? null : taggedContentSha256(before);
      if (currentSha256 !== change.expectedPriorSha256) {
        mismatches.push({
          path: change.path,
          expectedSha256: change.expectedPriorSha256,
          currentSha256,
        });
        continue;
      }
      const after = change.afterText === null
        ? null
        : Buffer.from(change.afterText, "utf8");
      projected.push({ path: change.path, before, after });
      transaction.push({
        kind: before === null ? "create" : after === null ? "delete" : "update",
        path: change.path,
        before,
        after,
      });
    }
  }
  return { projected, transaction, mismatches };
}

function assessmentMatches(proposal, assessment) {
  return canonicalProposalJson(proposal.assessment) === canonicalProposalJson(assessment);
}

async function recordConflict(environment, proposal, summary, mismatches) {
  return publishConflictRecord({
    graphRoot: environment.graphRoot,
    proposalId: proposal.proposalId,
    proposalDigest: proposal.proposalDigest,
    code: "WRITE001",
    summary,
    mismatches,
  });
}

function applyResult(context, options, {
  state,
  idempotent,
  changed,
  already,
  receipt = null,
}) {
  const bounded = boundedChangeSummaries(context.proposal);
  return {
    ok: true,
    command: "apply",
    workspace: context.environment.workspacePath,
    graph: {
      root: context.environment.graphRoot,
      revision:
        state === "applied"
          ? context.proposal.assessment.projectedValidation.projectedGraphRevision
          : context.proposal.bindings.expectedGraphRevision,
    },
    proposalId: context.proposal.proposalId,
    proposalDigest: context.proposal.proposalDigest,
    transactionId: context.transactionId,
    dryRun: options.dryRun,
    state,
    idempotent,
    receiptId: receipt?.receiptId ?? null,
    summary: {
      changed,
      already,
      total: bounded.total,
    },
    changes: bounded.changes,
    omittedChanges: bounded.omittedChanges,
  };
}

function terminalConflict(proposal, conflicts) {
  for (const conflict of conflicts) {
    if (conflict.proposalDigest !== proposal.proposalDigest) {
      throw applyError(
        "REVIEW001",
        "Stored conflict does not bind the exact immutable proposal.",
      );
    }
  }
  if (conflicts.length > 0) {
    throw applyError(
      "REVIEW001",
      "Proposal has a recorded conflict and is terminal; create a correction.",
      { conflictId: conflicts[0].conflictId },
    );
  }
}

function oneReceipt(receipts, outcome) {
  const matching = receipts.filter((receipt) => receipt.outcome === outcome);
  if (matching.length > 1) {
    throw applyError(
      "WRITE006",
      `Proposal has more than one immutable ${outcome} outcome receipt.`,
    );
  }
  return matching[0] ?? null;
}

function validateReceiptBindings(proposal, receipts) {
  for (const receipt of receipts) {
    if (receipt.proposalDigest !== proposal.proposalDigest) {
      throw applyError(
        "WRITE006",
        "Stored receipt does not bind the exact immutable proposal.",
      );
    }
  }
}

async function preflightApplyV2(options) {
  return withGovernedGraphLock(options, async (environment) => {
    await assertNoActiveMigration(environment);
    const proposal = await readStoredProposal({
      graphRoot: environment.graphRoot,
      proposalId: options.proposal,
    });
    if (proposal === null) {
      throw applyError("PROPOSAL005", "Proposal does not exist.", {
        proposalId: options.proposal,
      });
    }
    assertProposalEnvironment(proposal, environment);

    const transactionId = transactionIdFor(proposal.proposalId);
    await assertFileTransactionAvailable({
      graphRoot: environment.graphRoot,
      transactionId,
    });
    const [existingTransaction, reviews, conflicts, receipts] = await Promise.all([
      readFileTransaction({ graphRoot: environment.graphRoot, transactionId }),
      listReviewRecords({
        graphRoot: environment.graphRoot,
        proposalId: proposal.proposalId,
      }),
      listConflictRecords({
        graphRoot: environment.graphRoot,
        proposalId: proposal.proposalId,
      }),
      listReceiptRecords({
        graphRoot: environment.graphRoot,
        proposalId: proposal.proposalId,
      }),
    ]);
    validateReceiptBindings(proposal, receipts);
    const appliedReceipt = oneReceipt(receipts, "applied");
    const rolledBackReceipt = oneReceipt(receipts, "rolled-back");

    if (existingTransaction !== null) {
      if (existingTransaction.transactionDigest !== proposal.proposalDigest) {
        throw applyError(
          "WRITE006",
          "Proposal transaction ID is bound to a different digest.",
        );
      }
      if (new Set(["rolling-back", "rolled-back"]).has(existingTransaction.status)) {
        if (appliedReceipt !== null) {
          throw applyError(
            "WRITE006",
            "A rolled-back transaction cannot have an applied receipt.",
          );
        }
        return {
          environment,
          proposal,
          transactionId,
          existingTransaction,
          receipts,
          rolledBackReceipt,
          rolledBack: true,
        };
      }
      if (existingTransaction.status === "finalized") {
        terminalConflict(proposal, conflicts);
        if (
          appliedReceipt === null ||
          existingTransaction.receiptSha256 !== appliedReceipt.receiptDigest
        ) {
          throw applyError(
            "WRITE006",
            "Finalized transaction is missing its exact immutable receipt.",
          );
        }
        return {
          environment,
          proposal,
          transactionId,
          existingTransaction,
          appliedReceipt,
          alreadyApplied: true,
        };
      }
      if (existingTransaction.status === "finalized-pending-receipt") {
        if (
          appliedReceipt !== null &&
          existingTransaction.receiptSha256 !== appliedReceipt.receiptDigest
        ) {
          throw applyError(
            "WRITE006",
            "Committed transaction and published receipt bindings disagree.",
          );
        }
        return {
          environment,
          proposal,
          transactionId,
          existingTransaction,
          appliedReceipt,
          commitPending: true,
        };
      }
      if (appliedReceipt !== null || rolledBackReceipt !== null) {
        throw applyError(
          "WRITE006",
          "A pre-commit transaction has a terminal outcome receipt.",
        );
      }
    } else if (receipts.length > 0) {
      throw applyError(
        "WRITE006",
        "Proposal receipts exist without their bound file transaction journal.",
      );
    }

    terminalConflict(proposal, conflicts);
    requireApproval(proposal, reviews);
    await verifyReviewArtifact({ graphRoot: environment.graphRoot, proposal });

    if (
      existingTransaction !== null &&
      new Set(["applying", "awaiting-finalization"]).has(existingTransaction.status)
    ) {
      return {
        environment,
        proposal,
        transactionId,
        existingTransaction,
        appliedReceipt: null,
        resume: true,
      };
    }

    const inspection = await inspectWorkspace(options, {
      includeLexicalSource: true,
    });
    if (inspection.report.graph.revision !== proposal.bindings.expectedGraphRevision) {
      const conflict = options.dryRun
        ? null
        : await recordConflict(
            environment,
            proposal,
            "Graph revision changed before proposal apply.",
            [],
          );
      throw applyError(
        "WRITE001",
        "Graph changed after proposal creation; create a corrected proposal.",
        {
          expectedGraphRevision: proposal.bindings.expectedGraphRevision,
          currentGraphRevision: inspection.report.graph.revision,
          ...(conflict ? { conflictId: conflict.conflict.conflictId } : {}),
        },
      );
    }
    const materialized = await materializeProposalChanges(environment, proposal);
    if (materialized.mismatches.length > 0) {
      const conflict = options.dryRun
        ? null
        : await recordConflict(
            environment,
            proposal,
            "One or more canonical note hashes changed before proposal apply.",
            materialized.mismatches,
          );
      throw applyError(
        "WRITE001",
        "Proposal target hashes are stale; create a corrected proposal.",
        {
          mismatches: materialized.mismatches.slice(0, 16),
          omitted: Math.max(0, materialized.mismatches.length - 16),
          ...(conflict ? { conflictId: conflict.conflict.conflictId } : {}),
        },
      );
    }
    try {
      await verifyProposalSourceReferences(environment, proposal);
    } catch (error) {
      const conflict = options.dryRun
        ? null
        : await recordConflict(
            environment,
            proposal,
            "Bound proposal provenance changed before apply.",
            [],
          );
      throw applyError(
        "WRITE001",
        "Bound proposal provenance changed; create a corrected proposal.",
        {
          cause: error instanceof Error ? error.message : String(error),
          ...(conflict ? { conflictId: conflict.conflict.conflictId } : {}),
        },
      );
    }
    const projection = validateProjectedGraph(inspection, materialized.projected);
    if (
      !projection.ok ||
      projection.graphRevision !==
        proposal.assessment.projectedValidation.projectedGraphRevision
    ) {
      throw applyError(
        "PROPOSAL003",
        "Proposal no longer produces its reviewed semantic post-image.",
        {
          valid: projection.ok,
          expectedProjectedRevision:
            proposal.assessment.projectedValidation.projectedGraphRevision,
          currentProjectedRevision: projection.graphRevision,
        },
      );
    }
    const assessment = assessProposalSemantics(
      proposalInputFromStored(proposal),
      inspection,
      materialized.projected,
      projection,
    );
    if (!assessmentMatches(proposal, assessment)) {
      throw applyError(
        "REVIEW001",
        "Kernel authority assessment changed; create and review a new proposal.",
      );
    }
    return {
      environment,
      proposal,
      transactionId,
      existingTransaction,
      appliedReceipt: null,
      alreadyApplied: false,
      resume: existingTransaction !== null,
      transactionChanges: materialized.transaction,
    };
  });
}

async function verifyIrreversibleBoundary(
  options,
  context,
  { committed = false } = {},
) {
  return withGovernedGraphLock(options, async (environment) => {
    assertProposalEnvironment(context.proposal, environment);
    await assertNoActiveMigration(environment);
    const proposal = await readStoredProposal({
      graphRoot: environment.graphRoot,
      proposalId: context.proposal.proposalId,
    });
    if (proposal === null || proposal.proposalDigest !== context.proposal.proposalDigest) {
      throw applyError(
        "WRITE006",
        "Immutable proposal bytes changed before the commit boundary.",
      );
    }
    if (!committed) {
      const [reviews, conflicts] = await Promise.all([
        listReviewRecords({
          graphRoot: environment.graphRoot,
          proposalId: proposal.proposalId,
        }),
        listConflictRecords({
          graphRoot: environment.graphRoot,
          proposalId: proposal.proposalId,
        }),
      ]);
      terminalConflict(proposal, conflicts);
      requireApproval(proposal, reviews);
      await verifyReviewArtifact({ graphRoot: environment.graphRoot, proposal });
      try {
        await verifyProposalSourceReferences(environment, proposal);
      } catch (error) {
        const conflict = await recordConflict(
          environment,
          proposal,
          "Bound proposal provenance changed at the irreversible commit boundary.",
          [],
        );
        throw applyError(
          "WRITE001",
          "Bound proposal provenance changed at the commit boundary.",
          {
            cause: error instanceof Error ? error.message : String(error),
            conflictId: conflict.conflict.conflictId,
          },
        );
      }
    }
    const inspection = await inspectWorkspace(options);
    const expected = proposal.assessment.projectedValidation.projectedGraphRevision;
    if (inspection.report.graph.revision !== expected) {
      const conflict = await recordConflict(
        environment,
        proposal,
        "Complete graph post-image changed at the irreversible commit boundary.",
        [],
      );
      throw applyError(
        "WRITE001",
        "Published proposal does not match its exact reviewed graph post-image.",
        {
          expectedGraphRevision: expected,
          currentGraphRevision: inspection.report.graph.revision,
          conflictId: conflict.conflict.conflictId,
        },
      );
    }
    return { environment, proposal, inspection };
  });
}

function sealOutcomeReceipt(context, journal, outcome, graphRevisionAfter) {
  return sealReceiptRecord({
    proposalId: context.proposal.proposalId,
    proposalDigest: context.proposal.proposalDigest,
    transactionId: context.transactionId,
    outcome,
    graphRevisionBefore: context.proposal.bindings.expectedGraphRevision,
    graphRevisionAfter,
    changes: proposalChangeRecords(context.proposal),
    createdAt: journal.createdAt,
  });
}

function assertExactReceipt(receipt, expected, label) {
  if (receipt !== null && receipt.receiptDigest !== expected.receiptDigest) {
    throw applyError("WRITE006", `${label} does not match the transaction-bound receipt.`);
  }
}

async function publishRecoveryOutcome(options, context, journal, outcome, hooks = {}) {
  return withGovernedGraphLock(options, async (environment) => {
    if (environment.graphRootIdentity !== context.environment.graphRootIdentity) {
      throw applyError("WRITE002", "Graph identity changed before recovery receipt publication.");
    }
    const existing = await listReceiptRecords({
      graphRoot: environment.graphRoot,
      proposalId: context.proposal.proposalId,
    });
    const prior = oneReceipt(existing, outcome);
    if (prior !== null) return { receipt: prior, created: false, idempotent: true };
    const inspection = await inspectWorkspace(options);
    const receipt = sealOutcomeReceipt(
      context,
      journal,
      outcome,
      inspection.report.graph.revision,
    );
    return publishExactReceiptRecord(
      { graphRoot: environment.graphRoot, receipt },
      hooks,
    );
  });
}

async function recoverRolledBack(options, context, hooks = {}) {
  if (options.dryRun) {
    throw applyError(
      "WRITE008",
      "Proposal transaction is rolled back and terminal; create a correction.",
    );
  }
  const rolled = await rollbackFileTransaction(
    {
      graphRoot: context.environment.graphRoot,
      transactionId: context.transactionId,
      transactionDigest: context.proposal.proposalDigest,
    },
    hooks.fileTransaction,
  );
  const publication = await publishRecoveryOutcome(
    options,
    context,
    rolled.journal,
    "rolled-back",
    hooks.receipt,
  );
  throw applyError(
    "WRITE008",
    "Proposal transaction was rolled back and is terminal; create a correction.",
    { receiptId: publication.receipt.receiptId },
  );
}

async function invokeBoundary(hooks, name, details = {}) {
  await hooks?.boundary?.(name, Object.freeze({ ...details }));
}

async function applyGovernedProposalLocked(options, hooks = {}) {
  const context = await preflightApplyV2(options);
  const total = boundedChangeSummaries(context.proposal).total;

  if (context.rolledBack) {
    return recoverRolledBack(options, context, hooks);
  }
  if (context.alreadyApplied) {
    if (!options.dryRun) {
      await finalizeFileTransaction(
        {
          graphRoot: context.environment.graphRoot,
          transactionId: context.transactionId,
          transactionDigest: context.proposal.proposalDigest,
          receiptSha256: context.appliedReceipt.receiptDigest,
          receiptPublished: true,
        },
        hooks.fileTransaction,
      );
    }
    return applyResult(context, options, {
      state: "applied",
      idempotent: true,
      changed: 0,
      already: total,
      receipt: context.appliedReceipt,
    });
  }
  if (options.dryRun) {
    return applyResult(context, options, {
      state: context.commitPending || context.resume
        ? "recovery-required"
        : "validated-dry-run",
      idempotent: false,
      changed: 0,
      already: 0,
    });
  }

  let transactionPrepared = context.existingTransaction !== null;
  let irreversible = context.commitPending === true;
  try {
    if (context.commitPending) {
      await verifyIrreversibleBoundary(options, context, { committed: true });
      const journal = await readFileTransaction({
        graphRoot: context.environment.graphRoot,
        transactionId: context.transactionId,
      });
      if (journal === null || journal.status !== "finalized-pending-receipt") {
        throw applyError("WRITE006", "Committed transaction journal disappeared during recovery.");
      }
      const receipt = sealOutcomeReceipt(
        context,
        journal,
        "applied",
        context.proposal.assessment.projectedValidation.projectedGraphRevision,
      );
      if (journal.receiptSha256 !== receipt.receiptDigest) {
        throw applyError("WRITE006", "Committed transaction binds a different receipt.");
      }
      assertExactReceipt(context.appliedReceipt, receipt, "Published applied receipt");
      const publication = context.appliedReceipt === null
        ? await publishExactReceiptRecord(
            { graphRoot: context.environment.graphRoot, receipt },
            hooks.receipt,
          )
        : { receipt: context.appliedReceipt, created: false, idempotent: true };
      await invokeBoundary(hooks, "apply.after-receipt-publication", {
        transactionId: context.transactionId,
      });
      await finalizeFileTransaction(
        {
          graphRoot: context.environment.graphRoot,
          transactionId: context.transactionId,
          transactionDigest: context.proposal.proposalDigest,
          receiptSha256: publication.receipt.receiptDigest,
          receiptPublished: true,
        },
        hooks.fileTransaction,
      );
      return applyResult(context, options, {
        state: "applied",
        idempotent: true,
        changed: 0,
        already: total,
        receipt: publication.receipt,
      });
    }

    if (!transactionPrepared || context.existingTransaction?.status === "prepared") {
      const prepared = await prepareFileTransaction(
        {
          graphRoot: context.environment.graphRoot,
          transactionId: context.transactionId,
          transactionDigest: context.proposal.proposalDigest,
          changes: context.transactionChanges,
        },
        hooks.fileTransaction,
      );
      transactionPrepared = true;
      await invokeBoundary(hooks, "apply.after-prepare", {
        transactionId: context.transactionId,
        created: prepared.created,
      });
    }
    const applied = await applyFileTransaction(
      {
        graphRoot: context.environment.graphRoot,
        transactionId: context.transactionId,
        transactionDigest: context.proposal.proposalDigest,
      },
      hooks.fileTransaction,
    );
    await invokeBoundary(hooks, "apply.after-canonical-publication", {
      transactionId: context.transactionId,
    });
    await verifyIrreversibleBoundary(options, context);
    const journal = await readFileTransaction({
      graphRoot: context.environment.graphRoot,
      transactionId: context.transactionId,
    });
    if (journal === null || journal.status !== "awaiting-finalization") {
      throw applyError("WRITE006", "Applied transaction did not reach its exact pre-commit state.");
    }
    const receipt = sealOutcomeReceipt(
      context,
      journal,
      "applied",
      context.proposal.assessment.projectedValidation.projectedGraphRevision,
    );
    await commitFileTransaction(
      {
        graphRoot: context.environment.graphRoot,
        transactionId: context.transactionId,
        transactionDigest: context.proposal.proposalDigest,
        receiptSha256: receipt.receiptDigest,
      },
      hooks.fileTransaction,
    );
    irreversible = true;
    await invokeBoundary(hooks, "apply.after-irreversible-commit", {
      transactionId: context.transactionId,
      receiptDigest: receipt.receiptDigest,
    });
    const publication = await publishExactReceiptRecord(
      { graphRoot: context.environment.graphRoot, receipt },
      hooks.receipt,
    );
    await invokeBoundary(hooks, "apply.after-receipt-publication", {
      transactionId: context.transactionId,
    });
    await finalizeFileTransaction(
      {
        graphRoot: context.environment.graphRoot,
        transactionId: context.transactionId,
        transactionDigest: context.proposal.proposalDigest,
        receiptSha256: publication.receipt.receiptDigest,
        receiptPublished: true,
      },
      hooks.fileTransaction,
    );
    return applyResult(context, options, {
      state: "applied",
      idempotent: applied.summary.published === 0,
      changed: applied.summary.published,
      already: applied.summary.already,
      receipt: publication.receipt,
    });
  } catch (error) {
    const journal = await readFileTransaction({
      graphRoot: context.environment.graphRoot,
      transactionId: context.transactionId,
    }).catch(() => null);
    if (
      irreversible ||
      new Set(["finalized-pending-receipt", "finalized"]).has(journal?.status)
    ) {
      throw applyError(
        "WRITE009",
        "Canonical changes are irreversibly committed; rerun apply to publish or release the exact receipt.",
        {
          cause: error instanceof Error ? error.message : String(error),
          transactionId: context.transactionId,
          status: journal?.status ?? "committed",
        },
      );
    }
    if (journal === null && !transactionPrepared) throw error;

    try {
      const rolled = await rollbackFileTransaction(
        {
          graphRoot: context.environment.graphRoot,
          transactionId: context.transactionId,
          transactionDigest: context.proposal.proposalDigest,
        },
        hooks.fileTransaction,
      );
      const publication = await publishRecoveryOutcome(
        options,
        context,
        rolled.journal,
        "rolled-back",
        hooks.receipt,
      );
      throw applyError(
        "WRITE004",
        "Proposal apply failed and exact prior bytes were restored.",
        {
          cause: error instanceof Error ? error.message : String(error),
          receiptId: publication.receipt.receiptId,
        },
      );
    } catch (rollbackError) {
      if (rollbackError instanceof SyncoraError && rollbackError.code === "WRITE004") {
        throw rollbackError;
      }
      const recoveryJournal = await readFileTransaction({
        graphRoot: context.environment.graphRoot,
        transactionId: context.transactionId,
      }).catch(() => journal);
      let recoveryReceipt = null;
      let receiptFailure = null;
      if (recoveryJournal !== null) {
        try {
          recoveryReceipt = await publishRecoveryOutcome(
            options,
            context,
            recoveryJournal,
            "recovery-required",
            hooks.receipt,
          );
        } catch (receiptError) {
          receiptFailure = receiptError;
        }
      }
      throw applyError(
        "WRITE004",
        "Proposal apply failed and automatic recovery could not prove exact ownership.",
        {
          cause: error instanceof Error ? error.message : String(error),
          recoveryCause:
            rollbackError instanceof Error
              ? rollbackError.message
              : String(rollbackError),
          ...(recoveryReceipt ? { receiptId: recoveryReceipt.receipt.receiptId } : {}),
          ...(receiptFailure
            ? { receiptCause: receiptFailure instanceof Error ? receiptFailure.message : String(receiptFailure) }
            : {}),
          transactionId: context.transactionId,
        },
      );
    }
  }
}

export async function applyGovernedProposal(options, hooks = {}) {
  return withGovernedApplyLock(
    options,
    () => applyGovernedProposalLocked(options, hooks),
    hooks.applyLock,
  );
}
