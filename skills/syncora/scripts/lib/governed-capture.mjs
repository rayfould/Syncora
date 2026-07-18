import { SyncoraError } from "./cli.mjs";
import {
  publishDriftProposalBindings,
  validateDriftProposalInput,
} from "./drift-governance.mjs";
import {
  assertFileTransactionAvailable,
  readFileTransaction,
} from "./file-transaction.mjs";
import {
  assertNoActiveMigration,
  readCanonicalNoteBytes,
  readProposalInputFile,
  withGovernedGraphLock,
} from "./governed-environment.mjs";
import { validateProjectedGraph } from "./projected-graph.mjs";
import { verifyProposalSourceReferences } from "./proposal-provenance.mjs";
import {
  parseProposalInputBytes,
  sealProposal,
  summarizeProposal,
  taggedContentSha256,
} from "./proposal-schema.mjs";
import { assessProposalSemantics } from "./proposal-semantics.mjs";
import {
  assertCorrectionLineage,
  listConflictRecords,
  listReceiptRecords,
  listReviewRecords,
  publishSealedProposal,
  readStoredProposal,
} from "./proposal-store.mjs";
import {
  buildReviewArtifact,
  publishReviewArtifact,
  verifyReviewArtifact,
} from "./review-artifact.mjs";
import { inspectWorkspaceUnlocked as inspectWorkspace } from "./validate.mjs";

const MAXIMUM_RETURNED_CHANGES = 32;

function proposalError(code, message, details = undefined) {
  return new SyncoraError(code, message, details);
}

function transactionIdFor(proposalId) {
  return `apply_${proposalId.slice("proposal_".length)}`;
}

function changeRequiresAbsentPrior(operation, change, before) {
  if (operation.kind === "note.create" || operation.kind === "session.record") {
    return true;
  }
  if (operation.kind === "decision.accept") {
    return before === null;
  }
  return operation.kind === "note.move" && change.afterText !== null;
}

async function hydrateProposalInput(environment, parsed) {
  const flattened = [];
  const operations = [];
  for (const operation of parsed.operations) {
    const changes = [];
    for (const change of operation.changes) {
      const before = await readCanonicalNoteBytes(environment, change.path);
      const requiresAbsent = changeRequiresAbsentPrior(operation, change, before);
      if (requiresAbsent && before !== null) {
        throw proposalError(
          "WRITE001",
          `Proposal create target already exists: ${change.path}`,
        );
      }
      if (!requiresAbsent && before === null) {
        throw proposalError(
          "WRITE001",
          `Proposal update target does not exist: ${change.path}`,
        );
      }
      const currentSha256 = before === null ? null : taggedContentSha256(before);
      if (change.expectedPriorSha256 !== currentSha256) {
        throw proposalError(
          "WRITE001",
          `Proposal input was composed against stale note bytes: ${change.path}`,
          {
            expectedPriorSha256: change.expectedPriorSha256,
            currentSha256,
          },
        );
      }
      if (requiresAbsent && change.expectedPriorSha256 !== null) {
        throw proposalError(
          "PROPOSAL003",
          `Proposal create must require path absence: ${change.path}`,
        );
      }
      const after = change.afterText === null
        ? null
        : Buffer.from(change.afterText, "utf8");
      flattened.push(Object.freeze({ path: change.path, before, after }));
      changes.push({
        path: change.path,
        expectedPriorSha256: change.expectedPriorSha256,
        afterText: change.afterText,
      });
    }
    operations.push({
      operationId: operation.operationId,
      kind: operation.kind,
      sourceRefs: operation.sourceRefs.map((source) => ({ ...source })),
      changes,
    });
  }
  return {
    input: {
      schemaVersion: parsed.schemaVersion,
      kind: parsed.kind,
      idempotencyKey: parsed.idempotencyKey,
      origin: parsed.origin,
      actor: { ...parsed.actor },
      reason: parsed.reason,
      correctsProposalId: parsed.correctsProposalId,
      operations,
    },
    changes: flattened,
  };
}

function proposalBindings(environment, inspection) {
  return {
    workspaceIdentity: environment.workspaceIdentity,
    graphRootIdentity: environment.graphRootIdentity,
    expectedGraphRevision: inspection.report.graph.revision,
    validationSpecification: environment.validationSpecification,
    policyRevision: environment.policyRevision,
  };
}

function changeSummaries(summary) {
  const all = summary.operations.flatMap((operation) =>
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
  };
}

function creationResult(environment, summary, options, publication = {}) {
  const bounded = changeSummaries(summary);
  return {
    ok: true,
    command: options.command ?? "capture",
    workspace: environment.workspacePath,
    graph: {
      root: environment.graphRoot,
      revision: summary.bindings.expectedGraphRevision,
      projectedRevision:
        summary.assessment.projectedValidation.projectedGraphRevision,
    },
    dryRun: options.dryRun,
    created: publication.created ?? false,
    idempotent: publication.idempotent ?? false,
    proposal: {
      id: summary.proposalId,
      digest: summary.proposalDigest,
      intentDigest: summary.intentDigest,
      state: options.dryRun ? "validated-dry-run" : "proposed",
      authorityImpact: summary.assessment.authorityImpact,
      reviewRequired: summary.assessment.reviewRequired,
      reviewArtifact: publication.artifact ?? null,
    },
    summary: {
      operations: summary.operationCount,
      changes: summary.changeCount,
      duplicateCandidates: summary.assessment.duplicateCandidates.length,
      projectedFindings: summary.assessment.projectedValidation.findingCount,
    },
    duplicateCandidates: summary.assessment.duplicateCandidates,
    reviewArtifact: publication.artifact ?? null,
    ...(summary.origin === "drift"
      ? {
          drift: {
            findingBindings: publication.driftBindings ?? 0,
            resolution: "only-an-applied-matching-proposal-resolves-findings",
          },
        }
      : {}),
    ...bounded,
    next: options.dryRun
      ? "Rerun capture without --dry-run to store the immutable proposal."
      : "Open the local review artifact, inspect the exact before/after content, then approve this exact proposal digest before apply.",
  };
}

export async function createGovernedProposal(options) {
  return withGovernedGraphLock(options, async (environment) => {
    await assertNoActiveMigration(environment);
    await assertFileTransactionAvailable({ graphRoot: environment.graphRoot });
    const inputBytes = await readProposalInputFile(options.input);
    const parsed = parseProposalInputBytes(inputBytes);
    if (options.command === "capture" && parsed.origin !== "capture") {
      throw proposalError(
        "PROPOSAL001",
        "capture requires proposal input origin capture.",
      );
    }
    const inspection = await inspectWorkspace(options, {
      includeLexicalSource: true,
    });
    const hydrated = await hydrateProposalInput(environment, parsed);
    const validatedDriftFindings = await validateDriftProposalInput(
      environment,
      hydrated.input,
    );
    await verifyProposalSourceReferences(environment, hydrated.input);
    const projection = validateProjectedGraph(inspection, hydrated.changes);
    if (!projection.ok) {
      throw proposalError(
        "PROPOSAL003",
        "Proposal post-image does not pass semantic graph validation.",
        {
          introducedErrors: projection.report.summary.introducedErrors,
          affectedAuthorityConflicts:
            projection.report.summary.affectedAuthorityConflicts,
          findings: projection.report.findings.examples,
          omittedFindings: projection.report.findings.omitted,
        },
      );
    }
    const assessment = assessProposalSemantics(
      hydrated.input,
      inspection,
      hydrated.changes,
      projection,
    );
    const bindings = proposalBindings(environment, inspection);

    // Detect an external graph edit after target reads and virtual validation.
    const finalInspection = await inspectWorkspace(options);
    if (finalInspection.report.graph.revision !== bindings.expectedGraphRevision) {
      throw proposalError(
        "WRITE001",
        "Graph changed while the proposal baseline was being sealed.",
        {
          expectedGraphRevision: bindings.expectedGraphRevision,
          currentGraphRevision: finalInspection.report.graph.revision,
        },
      );
    }

    const sealed = sealProposal(hydrated.input, bindings, { assessment });
    await assertCorrectionLineage({
      graphRoot: environment.graphRoot,
      proposal: sealed,
    });
    if (options.dryRun) {
      const builtArtifact = await buildReviewArtifact({
        environment,
        proposal: sealed,
      });
      await verifyProposalSourceReferences(environment, sealed);
      return creationResult(
        environment,
        summarizeProposal(sealed),
        options,
        { artifact: builtArtifact.artifact },
      );
    }
    const artifactPublication = await publishReviewArtifact({
      environment,
      proposal: sealed,
    });
    await verifyProposalSourceReferences(environment, sealed);
    const driftBindings = await publishDriftProposalBindings({
      environment,
      proposal: sealed,
      validatedFindings: validatedDriftFindings,
    });
    const publication = await publishSealedProposal({
      graphRoot: environment.graphRoot,
      proposal: sealed,
    });
    return creationResult(
      environment,
      publication.proposal,
      options,
      {
        ...publication,
        artifact: artifactPublication.artifact,
        driftBindings: driftBindings.length,
      },
    );
  });
}

export async function inspectGovernedProposal(options) {
  return withGovernedGraphLock(options, async (environment) => {
    const proposal = await readStoredProposal({
      graphRoot: environment.graphRoot,
      proposalId: options.proposal,
    });
    if (proposal === null) {
      throw proposalError("PROPOSAL005", "Proposal does not exist.", {
        proposalId: options.proposal,
      });
    }
    if (
      proposal.bindings.workspaceIdentity !== environment.workspaceIdentity ||
      proposal.bindings.graphRootIdentity !== environment.graphRootIdentity
    ) {
      throw proposalError(
        "PROPOSAL002",
        "Proposal is bound to a different workspace or resolved graph.",
      );
    }
    const summary = summarizeProposal(proposal);
    const reviews = await listReviewRecords({
      graphRoot: environment.graphRoot,
      proposalId: proposal.proposalId,
    });
    const conflicts = await listConflictRecords({
      graphRoot: environment.graphRoot,
      proposalId: proposal.proposalId,
    });
    const receipts = await listReceiptRecords({
      graphRoot: environment.graphRoot,
      proposalId: proposal.proposalId,
    });
    const transaction = await readFileTransaction({
      graphRoot: environment.graphRoot,
      transactionId: transactionIdFor(proposal.proposalId),
    });
    const reviewArtifact = await verifyReviewArtifact({
      graphRoot: environment.graphRoot,
      proposal,
    });
    const decisions = [...new Set(reviews.map((review) => review.decision))];
    const outcomes = new Set(receipts.map((receipt) => receipt.outcome));
    const state = transaction?.status === "finalized"
      ? "applied"
      : transaction?.status === "finalized-pending-receipt"
        ? outcomes.has("applied")
          ? "receipt-pending-finalization"
          : "receipt-publication-required"
        : new Set(["prepared", "applying", "awaiting-finalization", "rolling-back"])
            .has(transaction?.status)
          ? "recovery-required"
          : transaction?.status === "rolled-back" || outcomes.has("rolled-back")
            ? "rolled-back"
            : outcomes.has("recovery-required")
              ? "recovery-required"
              : outcomes.has("failed")
                ? "failed"
                : outcomes.has("applied")
                  ? "applied"
                  : decisions.includes("reject")
                    ? "rejected"
                    : conflicts.length > 0
                      ? "conflicted"
                      : decisions.includes("approve")
                        ? "approved"
                        : "proposed";
    const bounded = changeSummaries(summary);
    return {
      ok: true,
      command: "propose",
      action: "inspect",
      workspace: environment.workspacePath,
      graph: {
        root: environment.graphRoot,
        revision: summary.bindings.expectedGraphRevision,
        projectedRevision:
          summary.assessment.projectedValidation.projectedGraphRevision,
      },
      dryRun: false,
      proposal: {
        id: summary.proposalId,
        digest: summary.proposalDigest,
        intentDigest: summary.intentDigest,
        state,
        authorityImpact: summary.assessment.authorityImpact,
        reviewRequired: summary.assessment.reviewRequired,
        reviewArtifact,
      },
      reviewArtifact,
      transaction: transaction
        ? {
            transactionId: transaction.transactionId,
            status: transaction.status,
            receiptSha256: transaction.receiptSha256,
            updatedAt: transaction.updatedAt,
          }
        : null,
      reviews: reviews.slice(0, 16).map((review) => ({
        reviewId: review.reviewId,
        decision: review.decision,
        reviewedBy: review.reviewedBy,
        createdAt: review.createdAt,
      })),
      omittedReviews: Math.max(0, reviews.length - 16),
      conflicts: conflicts.slice(0, 16).map((conflict) => ({
        conflictId: conflict.conflictId,
        code: conflict.code,
        summary: conflict.summary,
        createdAt: conflict.createdAt,
      })),
      omittedConflicts: Math.max(0, conflicts.length - 16),
      receipts: receipts.slice(0, 16).map((receipt) => ({
        receiptId: receipt.receiptId,
        outcome: receipt.outcome,
        transactionId: receipt.transactionId,
        graphRevisionAfter: receipt.graphRevisionAfter,
        createdAt: receipt.createdAt,
      })),
      omittedReceipts: Math.max(0, receipts.length - 16),
      summary: {
        operations: summary.operationCount,
        changes: summary.changeCount,
        duplicateCandidates: summary.assessment.duplicateCandidates.length,
        projectedFindings: summary.assessment.projectedValidation.findingCount,
      },
      duplicateCandidates: summary.assessment.duplicateCandidates,
      ...bounded,
    };
  });
}
