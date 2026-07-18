import { SyncoraError } from "./cli.mjs";
import { assertFileTransactionAvailable } from "./file-transaction.mjs";
import {
  assertNoActiveMigration,
  withGovernedGraphLock,
} from "./governed-environment.mjs";
import {
  listConflictRecords,
  listReviewRecords,
  publishConflictRecord,
  publishReviewRecord,
  readStoredProposal,
} from "./proposal-store.mjs";
import { verifyReviewArtifact } from "./review-artifact.mjs";
import { inspectWorkspaceUnlocked as inspectWorkspace } from "./validate.mjs";

function reviewError(code, message, details = undefined) {
  return new SyncoraError(code, message, details);
}

function assertProposalEnvironment(proposal, environment) {
  const bindings = proposal.bindings;
  if (
    bindings.workspaceIdentity !== environment.workspaceIdentity ||
    bindings.graphRootIdentity !== environment.graphRootIdentity
  ) {
    throw reviewError(
      "REVIEW001",
      "Proposal is bound to a different workspace or resolved graph.",
    );
  }
  if (
    bindings.validationSpecification !== environment.validationSpecification ||
    bindings.policyRevision !== environment.policyRevision
  ) {
    throw reviewError(
      "REVIEW001",
      "Proposal validation policy is stale and requires a new proposal.",
    );
  }
}

function reviewResult(environment, proposal, review, options, extras = {}) {
  return {
    ok: true,
    command: "review",
    workspace: environment.workspacePath,
    graph: {
      root: environment.graphRoot,
      revision: proposal.bindings.expectedGraphRevision,
    },
    proposalId: proposal.proposalId,
    proposalDigest: proposal.proposalDigest,
    decision: review.decision ?? options.decision,
    reviewedBy: review.reviewedBy ?? options.reviewedBy,
    reason: review.reason ?? options.reason,
    dryRun: options.dryRun,
    review,
    reviewArtifact: extras.artifact ?? extras.reviewArtifact ?? null,
    ...extras,
  };
}

export async function reviewGovernedProposal(options) {
  return withGovernedGraphLock(options, async (environment) => {
    const proposal = await readStoredProposal({
      graphRoot: environment.graphRoot,
      proposalId: options.proposal,
    });
    if (proposal === null) {
      throw reviewError("PROPOSAL005", "Proposal does not exist.", {
        proposalId: options.proposal,
      });
    }
    if (proposal.proposalDigest !== options.proposalDigest) {
      throw reviewError(
        "REVIEW001",
        "Review digest does not match the exact immutable proposal.",
        {
          proposalId: proposal.proposalId,
          expected: proposal.proposalDigest,
          received: options.proposalDigest,
        },
      );
    }
    assertProposalEnvironment(proposal, environment);

    const [existing, conflicts] = await Promise.all([
      listReviewRecords({
        graphRoot: environment.graphRoot,
        proposalId: proposal.proposalId,
      }),
      listConflictRecords({
        graphRoot: environment.graphRoot,
        proposalId: proposal.proposalId,
      }),
    ]);
    for (const conflict of conflicts) {
      if (conflict.proposalDigest !== proposal.proposalDigest) {
        throw reviewError(
          "REVIEW001",
          "Stored conflict is bound to stale or inconsistent proposal bytes.",
        );
      }
    }
    if (conflicts.length > 0) {
      throw reviewError(
        "REVIEW001",
        "Proposal has a recorded conflict and is terminal; create a correction.",
        { conflictId: conflicts[0].conflictId },
      );
    }
    for (const review of existing) {
      if (review.proposalDigest !== proposal.proposalDigest) {
        throw reviewError(
          "REVIEW001",
          "Stored review is bound to stale or inconsistent proposal bytes.",
        );
      }
      if (review.decision !== options.decision) {
        throw reviewError(
          "REVIEW001",
          "Proposal already has an incompatible terminal review disposition.",
          { existingDecision: review.decision },
        );
      }
    }
    const artifact = options.decision === "approve"
      ? await verifyReviewArtifact({
          graphRoot: environment.graphRoot,
          proposal,
        })
      : null;
    if (existing.length > 0) {
      return reviewResult(environment, proposal, existing[0], options, {
        idempotent: true,
        created: false,
        ...(artifact ? { artifact } : {}),
      });
    }

    if (options.decision === "approve") {
      await assertNoActiveMigration(environment);
      await assertFileTransactionAvailable({ graphRoot: environment.graphRoot });
      const inspection = await inspectWorkspace(options);
      if (inspection.report.graph.revision !== proposal.bindings.expectedGraphRevision) {
        const conflict = options.dryRun
          ? null
          : await publishConflictRecord({
              graphRoot: environment.graphRoot,
              proposalId: proposal.proposalId,
              proposalDigest: proposal.proposalDigest,
              code: "WRITE001",
              summary: "Graph revision changed before proposal approval.",
              mismatches: [],
            });
        throw reviewError(
          "WRITE001",
          "Graph changed after proposal creation; review a corrected proposal instead.",
          {
            expectedGraphRevision: proposal.bindings.expectedGraphRevision,
            currentGraphRevision: inspection.report.graph.revision,
            ...(conflict ? { conflictId: conflict.conflict.conflictId } : {}),
          },
        );
      }
    }

    if (options.dryRun) {
      return reviewResult(
        environment,
        proposal,
        {
          proposalId: proposal.proposalId,
          proposalDigest: proposal.proposalDigest,
          decision: options.decision,
          reviewedBy: options.reviewedBy,
          state: "validated-dry-run",
        },
        options,
        {
          created: false,
          idempotent: false,
          ...(artifact ? { artifact } : {}),
        },
      );
    }

    const published = await publishReviewRecord({
      graphRoot: environment.graphRoot,
      proposalId: proposal.proposalId,
      proposalDigest: proposal.proposalDigest,
      decision: options.decision,
      reviewedBy: options.reviewedBy,
      reason: options.reason,
    });
    return reviewResult(environment, proposal, published.review, options, {
      created: published.created,
      idempotent: published.idempotent,
      ...(artifact ? { artifact } : {}),
    });
  });
}
