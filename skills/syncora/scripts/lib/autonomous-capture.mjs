import { createHash } from "node:crypto";

import { applyGovernedProposal } from "./governed-apply.mjs";
import { createGovernedProposal } from "./governed-capture.mjs";
import {
  readCanonicalNoteBytes,
  readProposalInputFile,
  withGovernedGraphLock,
} from "./governed-environment.mjs";
import { reviewGovernedProposal } from "./governed-review.mjs";
import { HubFactError, upsertHubFact } from "./hub-facts.mjs";
import {
  parseProposalInputBytes,
  taggedContentSha256,
} from "./proposal-schema.mjs";
import { verifyProposalSourceReferences } from "./proposal-provenance.mjs";

const AUTO_REVIEWER = "syncora:auto-capture";
const AUTO_REASON =
  "Authorized automatically by Syncora's autonomous project-memory policy.";
const MAXIMUM_AUTOMATIC_REBASES = 1;

function cloneInput(input) {
  return JSON.parse(JSON.stringify(input));
}

function correctionKey(input, proposalId, attempt) {
  const digest = createHash("sha256")
    .update(input.idempotencyKey, "utf8")
    .update("\n", "utf8")
    .update(proposalId ?? "unsealed", "utf8")
    .update("\n", "utf8")
    .update(String(attempt), "utf8")
    .digest("hex");
  return `capture-rebase/${digest}`;
}

function failureCode(error) {
  return typeof error?.code === "string" ? error.code : null;
}

async function rebaseCaptureInput(options, originalInput) {
  return withGovernedGraphLock(options, async (environment) => {
    const rebased = cloneInput(originalInput);
    let keyedHubFacts = 0;
    for (const operation of rebased.operations) {
      for (const change of operation.changes) {
        const current = await readCanonicalNoteBytes(environment, change.path);
        const currentSha256 = current === null ? null : taggedContentSha256(current);
        if (operation.kind !== "hub.fact.upsert") {
          if (currentSha256 !== change.expectedPriorSha256) return null;
          continue;
        }
        if (current === null) return null;
        try {
          change.afterText = upsertHubFact(current.toString("utf8"), operation.fact);
        } catch (error) {
          if (error instanceof HubFactError) return null;
          throw error;
        }
        change.expectedPriorSha256 = currentSha256;
        keyedHubFacts += 1;
      }
    }
    await verifyProposalSourceReferences(environment, rebased);
    return { input: rebased, keyedHubFacts };
  });
}

async function captureOnce(options, inputValue) {
  let created = null;
  try {
    created = await createGovernedProposal({
      ...options,
      command: "capture",
      inputValue,
    });
    if (options.dryRun) return { created, reviewed: null, applied: null };

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
    return { created, reviewed, applied };
  } catch (error) {
    if (created?.proposal?.id) error.captureProposalId = created.proposal.id;
    throw error;
  }
}

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
  const originalInput = parseProposalInputBytes(
    await readProposalInputFile(options.input),
  );
  let inputValue = originalInput;
  let rebase = null;
  let attempt = 0;
  let outcome;
  while (true) {
    try {
      outcome = await captureOnce(options, inputValue);
      break;
    } catch (error) {
      if (
        options.dryRun ||
        failureCode(error) !== "WRITE001" ||
        attempt >= MAXIMUM_AUTOMATIC_REBASES
      ) {
        throw error;
      }
      const rebased = await rebaseCaptureInput(options, originalInput);
      if (rebased === null) throw error;
      attempt += 1;
      const correctedProposalId = error.captureProposalId ?? inputValue.correctsProposalId;
      inputValue = {
        ...rebased.input,
        idempotencyKey: correctionKey(originalInput, correctedProposalId, attempt),
        correctsProposalId: correctedProposalId,
      };
      rebase = {
        automatic: true,
        attempts: attempt,
        keyedHubFacts: rebased.keyedHubFacts,
        ...(correctedProposalId ? { correctedProposalId } : {}),
      };
    }
  }
  const { created, reviewed, applied } = outcome;
  if (options.dryRun) {
    const { approvalSummary, ...preview } = created;
    return {
      ...preview,
      autonomous: true,
      changeSummary: changeSummary(approvalSummary, false),
      next: "Rerun capture without --dry-run to save this valid update automatically.",
    };
  }

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
    ...(rebase ? { rebase } : {}),
    next: "Knowledge saved automatically. Do not ask the user for a separate save confirmation.",
  };
}
