import assert from "node:assert/strict";
import test from "node:test";

import {
  PROPOSAL_OPERATION_KINDS,
  PROPOSAL_POLICY,
  computeProposalIntent,
  parseProposalInput,
  parseProposalInputBytes,
  parseSealedProposal,
  sealProposal,
  summarizeProposal,
  taggedContentSha256,
} from "../../skills/syncora/scripts/lib/proposal-schema.mjs";

const hash = (character) => `sha256:${character.repeat(64)}`;

function sourceRef(overrides = {}) {
  return {
    type: "user",
    ref: "current-task:explicit-request",
    expectedSha256: null,
    ...overrides,
  };
}

function inputWith({ kind = "note.create", changes = undefined, extra = {} } = {}) {
  return {
    schemaVersion: 1,
    kind: "syncora.proposal-input",
    idempotencyKey: "task-2026-07-17-001",
    origin: "capture",
    actor: {
      type: "agent",
      id: "codex",
      runtime: "node-22",
    },
    reason: "Record the durable result requested in the current task.",
    correctsProposalId: null,
    operations: [{
      operationId: "operation-1",
      kind,
      sourceRefs: [sourceRef()],
      changes: changes ?? [{
        path: "knowledge/concepts/proposal-foundation.md",
        expectedPriorSha256: null,
        afterText: "# Proposal foundation\n\nSealed body marker: PRIVATE-BODY.\n",
      }],
    }],
    ...extra,
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

function assessment(paths = ["knowledge/concepts/proposal-foundation.md"]) {
  return {
    authorityImpact: {
      level: "canonical-content",
      reasons: ["Creates or changes canonical Markdown."],
      paths,
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

function clone(value) {
  return structuredClone(value);
}

test("proposal identity is deterministic while the full digest binds createdAt", () => {
  const input = inputWith();
  const first = sealProposal(input, bindings(), {
    assessment: assessment(),
    createdAt: "2026-07-17T10:00:00.000Z",
  });
  const second = sealProposal(input, bindings(), {
    assessment: assessment(),
    createdAt: "2026-07-17T10:00:01.000Z",
  });

  assert.equal(first.proposalId, second.proposalId);
  assert.equal(first.intentDigest, second.intentDigest);
  assert.notEqual(first.proposalDigest, second.proposalDigest);
  assert.deepEqual(parseSealedProposal(first), first);
  assert.equal(
    computeProposalIntent(input, bindings(), assessment()).proposalId,
    first.proposalId,
  );
});

test("proposal summaries retain impact and hashes but never note bodies", () => {
  const proposal = sealProposal(inputWith(), bindings(), {
    assessment: assessment(),
    createdAt: "2026-07-17T10:00:00.000Z",
  });
  const summary = summarizeProposal(proposal);
  const serialized = JSON.stringify(summary);

  assert.equal(summary.assessment.reviewRequired, true);
  assert.equal(summary.operations[0].changes[0].afterSha256, taggedContentSha256(
    proposal.operations[0].changes[0].afterText,
  ));
  assert.equal("afterText" in summary.operations[0].changes[0], false);
  assert.doesNotMatch(serialized, /PRIVATE-BODY/);
});

test("caller-declared authority and every other unknown field fail exact-key validation", () => {
  const withAuthority = inputWith({ extra: { authorityImpact: "none" } });
  assert.throws(
    () => parseProposalInput(withAuthority),
    (error) => error?.code === "PROPOSAL001",
  );

  const nestedUnknown = inputWith();
  nestedUnknown.operations[0].changes[0].authority = "none";
  assert.throws(
    () => parseProposalInput(nestedUnknown),
    (error) => error?.code === "PROPOSAL001",
  );
});

test("the eight semantic operation kinds enforce their exact change shapes", () => {
  const priorA = hash("a");
  const priorB = hash("b");
  const moveText = "# Exact move\n";
  const cases = new Map([
    ["note.create", [{ path: "knowledge/concepts/create.md", expectedPriorSha256: null, afterText: "# Create\n" }]],
    ["note.update", [{ path: "knowledge/concepts/update.md", expectedPriorSha256: priorA, afterText: "# Update\n" }]],
    ["note.move", [
      { path: "knowledge/concepts/move-from.md", expectedPriorSha256: taggedContentSha256(moveText), afterText: null },
      { path: "knowledge/concepts/move-to.md", expectedPriorSha256: null, afterText: moveText },
    ]],
    ["link.add", [{ path: "knowledge/concepts/link.md", expectedPriorSha256: priorA, afterText: "# Link\n\n[[index]]\n" }]],
    ["decision.accept", [{ path: "knowledge/decisions/accept.md", expectedPriorSha256: priorA, afterText: "# Accept\n" }]],
    ["decision.supersede", [
      { path: "knowledge/decisions/old.md", expectedPriorSha256: priorA, afterText: "# Old\n\nSuperseded.\n" },
      { path: "knowledge/decisions/new.md", expectedPriorSha256: priorB, afterText: "# New\n\nAccepted.\n" },
    ]],
    ["hub.refresh", [{ path: "index.md", expectedPriorSha256: priorA, afterText: "# Index\n" }]],
    ["session.record", [{ path: "knowledge/sessions/session.md", expectedPriorSha256: null, afterText: "# Session\n" }]],
  ]);

  assert.deepEqual([...cases.keys()], PROPOSAL_OPERATION_KINDS);
  for (const [kind, changes] of cases) {
    const input = inputWith({ kind, changes });
    const paths = changes.map((change) => change.path);
    assert.doesNotThrow(() => sealProposal(input, bindings(), {
      assessment: assessment(paths),
      createdAt: "2026-07-17T10:00:00.000Z",
    }), kind);
  }
});

test("draft parsing requires exact prior-state bindings before any hydration", () => {
  const input = inputWith({
    kind: "note.update",
    changes: [{
      path: "knowledge/concepts/update.md",
      afterText: "# Updated\n",
    }],
  });
  assert.throws(
    () => parseProposalInput(input),
    (error) => error?.code === "PROPOSAL001" && /missing or unknown fields/u.test(error.message),
  );
});

test("decision.accept supports explicit create and update modes but rejects ambiguous omission", () => {
  const path = "knowledge/decisions/accepted.md";
  const created = inputWith({
    kind: "decision.accept",
    changes: [{
      path,
      expectedPriorSha256: null,
      afterText: "# Accepted decision\n\nstatus: accepted\n",
    }],
  });
  const updated = inputWith({
    kind: "decision.accept",
    changes: [{
      path,
      expectedPriorSha256: hash("a"),
      afterText: "# Accepted decision\n\nstatus: accepted\n",
    }],
  });
  const missing = inputWith({
    kind: "decision.accept",
    changes: [{
      path,
      afterText: "# Accepted decision\n\nstatus: accepted\n",
    }],
  });

  for (const proposalInput of [created, updated]) {
    assert.doesNotThrow(() => sealProposal(proposalInput, bindings(), {
      assessment: assessment([path]),
      createdAt: "2026-07-17T10:00:00.000Z",
    }));
  }
  assert.throws(
    () => parseProposalInput(missing),
    /missing or unknown fields/,
  );
});

test("decision.supersede remains update-only and rejects a missing or null prior hash", () => {
  const validChanges = [
    {
      path: "knowledge/decisions/old.md",
      expectedPriorSha256: hash("a"),
      afterText: "# Old\n\nSuperseded.\n",
    },
    {
      path: "knowledge/decisions/new.md",
      expectedPriorSha256: hash("b"),
      afterText: "# New\n\nAccepted.\n",
    },
  ];
  const valid = inputWith({ kind: "decision.supersede", changes: validChanges });
  assert.doesNotThrow(() => sealProposal(valid, bindings(), {
    assessment: assessment(validChanges.map((change) => change.path)),
  }));

  const missing = structuredClone(valid);
  delete missing.operations[0].changes[0].expectedPriorSha256;
  assert.throws(
    () => parseProposalInput(missing),
    /missing or unknown fields/,
  );

  const createLike = structuredClone(valid);
  createLike.operations[0].changes[0].expectedPriorSha256 = null;
  assert.throws(
    () => sealProposal(createLike, bindings(), {
      assessment: assessment(validChanges.map((change) => change.path)),
    }),
    /exact prior note hash/,
  );
});

test("source refs bind every local source, reject unverifiable digest claims, and detect conflicts", () => {
  for (const type of ["file", "note"]) {
    const missingBinding = inputWith();
    missingBinding.operations[0].sourceRefs = [sourceRef({
      type,
      ref: type === "file" ? "src/context.ts" : "knowledge/concepts/context.md",
      expectedSha256: null,
    })];
    assert.throws(
      () => parseProposalInput(missingBinding),
      /locally resolvable bytes/,
      type,
    );
  }

  for (const type of ["user", "operation", "binding"]) {
    const falseDigest = inputWith();
    falseDigest.operations[0].sourceRefs = [sourceRef({
      type,
      ref: `${type}:source`,
      expectedSha256: hash("a"),
    })];
    assert.throws(
      () => parseProposalInput(falseDigest),
      /cannot claim a digest/,
      type,
    );
  }

  const conflicting = inputWith();
  conflicting.operations[0].sourceRefs = [
    sourceRef({ type: "file", ref: "src/context.ts", expectedSha256: hash("a") }),
    sourceRef({ type: "file", ref: "src/context.ts", expectedSha256: hash("b") }),
  ];
  assert.throws(() => parseProposalInput(conflicting), /conflicting digest bindings/);

  const exactDuplicate = structuredClone(conflicting);
  exactDuplicate.operations[0].sourceRefs[1].expectedSha256 = hash("a");
  assert.doesNotThrow(() => parseProposalInput(exactDuplicate));
});

test("proposal-wide source-reference work is bounded across operations", () => {
  const excessive = inputWith();
  excessive.operations = Array.from({ length: 3 }, (_, operationIndex) => ({
    operationId: `source-operation-${operationIndex}`,
    kind: "note.create",
    sourceRefs: Array.from({ length: 171 }, (_, sourceIndex) => ({
      type: "user",
      ref: `current-task:${operationIndex}:${sourceIndex}`,
      expectedSha256: null,
    })),
    changes: [{
      path: `knowledge/concepts/source-bound-${operationIndex}.md`,
      expectedPriorSha256: null,
      afterText: `# Source bound ${operationIndex}\n`,
    }],
  }));
  assert.equal(excessive.operations.flatMap((item) => item.sourceRefs).length, 513);
  assert.throws(
    () => parseProposalInput(excessive),
    /512-source-reference limit/,
  );
});

test("bounded input rejects too many operations, changes, note bytes, and raw bytes", () => {
  const tooManyOperations = inputWith();
  tooManyOperations.operations = Array.from({ length: 65 }, (_, index) => ({
    ...clone(tooManyOperations.operations[0]),
    operationId: `operation-${index}`,
    changes: [{
      ...clone(tooManyOperations.operations[0].changes[0]),
      path: `knowledge/concepts/note-${index}.md`,
    }],
  }));
  assert.throws(() => parseProposalInput(tooManyOperations), /1 through 64/);

  const tooManyChanges = inputWith();
  tooManyChanges.operations = Array.from({ length: 64 }, (_, operationIndex) => ({
    ...clone(tooManyChanges.operations[0]),
    operationId: `operation-${operationIndex}`,
    changes: Array.from({ length: operationIndex === 0 ? 5 : 4 }, (_, changeIndex) => ({
      path: `knowledge/concepts/note-${operationIndex}-${changeIndex}.md`,
      expectedPriorSha256: null,
      afterText: "# Note\n",
    })),
  }));
  assert.throws(() => parseProposalInput(tooManyChanges), /exactly 1 file change/);

  const oversizedNote = inputWith();
  oversizedNote.operations[0].changes[0].afterText = "x".repeat(
    PROPOSAL_POLICY.maximumNoteBytes + 1,
  );
  assert.throws(() => parseProposalInput(oversizedNote), /note byte limit/);

  const oversizedRaw = Buffer.alloc(PROPOSAL_POLICY.maximumInputBytes + 1, 0x20);
  assert.throws(() => parseProposalInputBytes(oversizedRaw), /16 MiB|byte limit/);
});

test("portable graph paths reject traversal, aliases, excluded roots, and case collisions", () => {
  for (const path of [
    "../escape.md",
    "knowledge\\escape.md",
    "knowledge/CON.md",
    ".syncora/proposal.md",
    "knowledge/concepts/UPPER.MD",
  ]) {
    const input = inputWith();
    input.operations[0].changes[0].path = path;
    assert.throws(() => parseProposalInput(input), (error) => error?.code === "PROPOSAL001", path);
  }

  const duplicate = inputWith({
    kind: "decision.supersede",
    changes: [
      { path: "knowledge/decisions/Same.md", expectedPriorSha256: hash("a"), afterText: "# A\n" },
      { path: "knowledge/decisions/same.md", expectedPriorSha256: hash("b"), afterText: "# B\n" },
    ],
  });
  assert.throws(() => parseProposalInput(duplicate), /only once/);
});

test("move sealing proves destination bytes match the exact source hash", () => {
  const input = inputWith({
    kind: "note.move",
    changes: [
      { path: "knowledge/concepts/from.md", expectedPriorSha256: hash("a"), afterText: null },
      { path: "knowledge/concepts/to.md", expectedPriorSha256: null, afterText: "# Different\n" },
    ],
  });
  assert.throws(
    () => sealProposal(input, bindings(), {
      assessment: assessment(["knowledge/concepts/from.md", "knowledge/concepts/to.md"]),
    }),
    /exactly match/,
  );
});
