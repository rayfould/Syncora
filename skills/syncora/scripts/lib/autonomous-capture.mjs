import { applyGovernedProposal } from "./governed-apply.mjs";
import { createGovernedProposal } from "./governed-capture.mjs";
import { reviewGovernedProposal } from "./governed-review.mjs";

const AUTO_REVIEWER = "syncora:auto-capture";
const AUTO_REASON =
  "Authorized automatically by Syncora's autonomous project-memory policy.";

function changeSummary(summary, canonicalMarkdownChanged) {
  if (!summary) return undefined;
  const { approvalResponse: _approvalResponse, ...bounded } = summary;
  return {
    ...bounded,
    kind: "syncora.change-summary",
    title: canonicalMarkdownChanged
      ? "Syncora knowledge saved"
      : "Syncora knowledge update preview",
    canonicalMarkdownChanged,
  };
}

export async function captureKnowledge(options) {
  const created = await createGovernedProposal({
    ...options,
    command: "capture",
  });
  if (options.dryRun) {
    const { approvalSummary, ...preview } = created;
    return {
      ...preview,
      autonomous: true,
      changeSummary: changeSummary(approvalSummary, false),
      next: "Rerun capture without --dry-run to save this valid update automatically.",
    };
  }

  const reviewed = await reviewGovernedProposal({
    ...options,
    input: undefined,
    proposal: created.proposal.id,
    proposalDigest: created.proposal.digest,
    decision: "approve",
    reviewedBy: AUTO_REVIEWER,
    reason: AUTO_REASON,
    dryRun: false,
  });
  const applied = await applyGovernedProposal({
    ...options,
    input: undefined,
    proposal: created.proposal.id,
    dryRun: false,
  });

  return {
    ...applied,
    command: "capture",
    autonomous: true,
    proposal: {
      id: created.proposal.id,
      digest: created.proposal.digest,
      state: applied.state,
      authorityImpact: created.proposal.authorityImpact,
      authorizationMode: "automatic",
      reviewArtifact: created.reviewArtifact,
    },
    review: {
      reviewId: reviewed.review?.reviewId ?? null,
      decision: reviewed.decision,
      reviewedBy: reviewed.reviewedBy,
      state: reviewed.review?.state ?? "recorded",
    },
    reviewArtifact: created.reviewArtifact,
    changeSummary: changeSummary(created.approvalSummary, true),
    summary: {
      operations: created.summary.operations,
      changes: created.summary.changes,
      changed: applied.summary.changed,
      already: applied.summary.already,
    },
    next: "Knowledge saved automatically. Do not ask the user for a separate save confirmation.",
  };
}
