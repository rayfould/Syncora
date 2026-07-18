import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { authorityPolicyRevision } from "../../skills/syncora/scripts/lib/authority-inventory.mjs";
import {
  FILE_TRANSACTION_DURABILITY,
  FILE_TRANSACTION_POLICY,
} from "../../skills/syncora/scripts/lib/file-transaction.mjs";
import {
  GOVERNED_WRITE_POLICY,
  governedPolicyRevision,
} from "../../skills/syncora/scripts/lib/governed-environment.mjs";
import { PROJECTED_GRAPH_POLICY } from "../../skills/syncora/scripts/lib/projected-graph.mjs";
import {
  PROPOSAL_OPERATION_KINDS,
  PROPOSAL_POLICY,
  PROPOSAL_SCHEMA_VERSION,
  canonicalProposalJson,
} from "../../skills/syncora/scripts/lib/proposal-schema.mjs";
import { PROPOSAL_SEMANTICS_POLICY } from "../../skills/syncora/scripts/lib/proposal-semantics.mjs";

test("governed policy revision binds every executable proposal and transaction policy", () => {
  assert.equal(GOVERNED_WRITE_POLICY.proposalSchemaVersion, PROPOSAL_SCHEMA_VERSION);
  assert.equal(GOVERNED_WRITE_POLICY.proposalOperationKinds, PROPOSAL_OPERATION_KINDS);
  assert.equal(GOVERNED_WRITE_POLICY.proposal, PROPOSAL_POLICY);
  assert.equal(GOVERNED_WRITE_POLICY.semantics, PROPOSAL_SEMANTICS_POLICY);
  assert.equal(GOVERNED_WRITE_POLICY.projectedGraph, PROJECTED_GRAPH_POLICY);
  assert.equal(GOVERNED_WRITE_POLICY.fileTransaction, FILE_TRANSACTION_POLICY);
  assert.equal(
    GOVERNED_WRITE_POLICY.fileTransactionDurability,
    FILE_TRANSACTION_DURABILITY,
  );
  assert.equal(
    GOVERNED_WRITE_POLICY.authorityPolicyRevision,
    authorityPolicyRevision(),
  );

  const expected = `sha256:${createHash("sha256")
    .update(`${GOVERNED_WRITE_POLICY.specification}\n`, "utf8")
    .update(canonicalProposalJson(GOVERNED_WRITE_POLICY), "utf8")
    .digest("hex")}`;
  assert.equal(governedPolicyRevision(), expected);
  assert.match(expected, /^sha256:[0-9a-f]{64}$/u);
  assert.notEqual(expected, authorityPolicyRevision());
});
