import { SyncoraError } from "./cli.mjs";
import {
  readCanonicalNoteBytes,
  readWorkspaceSourceBytes,
} from "./governed-environment.mjs";
import {
  PROPOSAL_POLICY,
  assertPortableGraphPath,
  assertPortableWorkspacePath,
  assertTaggedSha256,
  taggedContentSha256,
} from "./proposal-schema.mjs";

function provenanceError(message, details = undefined) {
  return new SyncoraError("WRITE001", message, details);
}

export async function verifyProposalSourceReferences(environment, proposalInput) {
  if (!Array.isArray(proposalInput?.operations)) {
    throw provenanceError("Proposal provenance requires bounded operations.");
  }
  const bindings = new Map();
  const allReferences = new Set();
  let references = 0;
  let bound = 0;
  for (const operation of proposalInput.operations) {
    if (!Array.isArray(operation?.sourceRefs)) {
      throw provenanceError("Proposal operation provenance is malformed.");
    }
    for (const source of operation.sourceRefs) {
      references += 1;
      if (references > PROPOSAL_POLICY.maximumSourceReferencesTotal) {
        throw provenanceError("Proposal provenance exceeds its reference work limit.", {
          references,
          limit: PROPOSAL_POLICY.maximumSourceReferencesTotal,
        });
      }
      if (source === null || typeof source !== "object" || Array.isArray(source)) {
        throw provenanceError("Proposal source reference is malformed.");
      }
      allReferences.add(`${String(source.type)}\u0000${String(source.ref).normalize("NFC")}`);
      let normalizedRef;
      if (source.type === "note") {
        normalizedRef = assertPortableGraphPath(source.ref, "Proposal source note");
      } else if (source.type === "file") {
        normalizedRef = assertPortableWorkspacePath(source.ref, "Proposal source file");
      } else {
        if (source.expectedSha256 !== null) {
          throw provenanceError(
            "Unresolvable proposal source types cannot claim locally verified digests.",
            { operationId: operation.operationId, type: source.type, ref: source.ref },
          );
        }
        continue;
      }
      const expectedSha256 = assertTaggedSha256(
        source.expectedSha256,
        "Proposal source expectedSha256",
      );
      bound += 1;
      const identity = `${source.type}\u0000${process.platform === "win32"
        ? normalizedRef.toLowerCase()
        : normalizedRef}`;
      const currentBinding = bindings.get(identity);
      if (
        currentBinding !== undefined &&
        currentBinding.expectedSha256 !== expectedSha256
      ) {
        throw provenanceError("Normalized proposal source has conflicting digest bindings.", {
          type: source.type,
          ref: normalizedRef,
          expectedSha256: currentBinding.expectedSha256,
          conflictingSha256: expectedSha256,
        });
      }
      if (currentBinding === undefined) {
        bindings.set(identity, {
          operationId: operation.operationId,
          type: source.type,
          ref: normalizedRef,
          expectedSha256,
          occurrences: 1,
        });
      } else {
        currentBinding.occurrences += 1;
      }
    }
  }

  let verifiedBytes = 0;
  for (const binding of bindings.values()) {
    const remaining = PROPOSAL_POLICY.maximumVerifiedSourceBytes - verifiedBytes;
    if (remaining < 1) {
      throw provenanceError("Proposal provenance exceeds its total verified-byte budget.", {
        verifiedBytes,
        limit: PROPOSAL_POLICY.maximumVerifiedSourceBytes,
      });
    }
    const perSourceLimit = binding.type === "note"
      ? PROPOSAL_POLICY.maximumNoteBytes
      : PROPOSAL_POLICY.maximumSourceFileBytes;
    const maximumBytes = Math.min(remaining, perSourceLimit);
    let bytes;
    try {
      if (binding.type === "note") {
        bytes = await readCanonicalNoteBytes(environment, binding.ref, {
          maximumBytes,
          code: "WRITE001",
          label: "Bound proposal source note",
        });
        if (bytes === null) {
          throw provenanceError("Bound proposal source note is missing.", {
            operationId: binding.operationId,
            ref: binding.ref,
          });
        }
      } else {
        bytes = await readWorkspaceSourceBytes(environment, binding.ref, {
          maximumBytes,
          code: "WRITE001",
          label: "Bound proposal source file",
        });
      }
    } catch (error) {
      if (maximumBytes === remaining && remaining < perSourceLimit) {
        throw provenanceError("Proposal provenance exceeds its total verified-byte budget.", {
          verifiedBytes,
          remaining,
          limit: PROPOSAL_POLICY.maximumVerifiedSourceBytes,
          type: binding.type,
          ref: binding.ref,
          cause: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }
    verifiedBytes += bytes.length;
    if (verifiedBytes > PROPOSAL_POLICY.maximumVerifiedSourceBytes) {
      throw provenanceError("Proposal provenance exceeds its total verified-byte budget.");
    }
    const current = taggedContentSha256(bytes);
    if (current !== binding.expectedSha256) {
      throw provenanceError("Bound proposal provenance changed.", {
        operationId: binding.operationId,
        type: binding.type,
        ref: binding.ref,
        expectedSha256: binding.expectedSha256,
        currentSha256: current,
      });
    }
  }
  return Object.freeze({
    references,
    uniqueReferences: allReferences.size,
    bound,
    verified: bound,
    uniqueVerified: bindings.size,
    verifiedBytes,
    cacheHits: bound - bindings.size,
    unresolved: 0,
  });
}
