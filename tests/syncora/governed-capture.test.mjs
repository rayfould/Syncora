import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  prepareFileTransaction,
  readActiveFileTransaction,
  readFileTransaction,
} from "../../skills/syncora/scripts/lib/file-transaction.mjs";
import { taggedContentSha256 } from "../../skills/syncora/scripts/lib/proposal-schema.mjs";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const cli = join(
  testDirectory,
  "..",
  "..",
  "skills",
  "syncora",
  "scripts",
  "syncora.mjs",
);
const TARGET_NOTE = "knowledge/projects/workspace.md";

function run(args, expectedStatus = 0) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(
    result.status,
    expectedStatus,
    `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result;
}

function runJson(args, expectedStatus = 0) {
  const result = run([...args, "--format", "json"], expectedStatus);
  const source = expectedStatus === 0 ? result.stdout : result.stderr;
  return { result, output: JSON.parse(source) };
}

async function temporaryWorkspace() {
  return realpath(await mkdtemp(join(tmpdir(), "syncora-governed-capture-")));
}

async function initializedWorkspace() {
  const workspace = await temporaryWorkspace();
  runJson([
    "setup",
    "--workspace",
    workspace,
    "--no-patch-agents",
  ]);
  return workspace;
}

function updatedProjectHub(before, durableText) {
  const bootstrap =
    "- Syncora initialized. Replace this bootstrap statement with verified state.";
  assert.match(before, new RegExp(bootstrap.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u"));
  return before.replace(bootstrap, `- ${durableText}`);
}

function listField(name, values) {
  return values.length === 0
    ? [`${name}: []`]
    : [`${name}:`, ...values.map((value) => `  - ${value}`)];
}

function currentNote({
  id,
  kind,
  state = undefined,
  authority = undefined,
  decisionKey = undefined,
  supersedes = [],
  supersededBy = [],
  body = "",
}) {
  const resolvedAuthority = authority ?? ({
    session: "historical",
    reference: "supporting",
  }[kind] ?? "canonical");
  const resolvedState = state ?? ({
    decision: "proposed",
    session: "complete",
  }[kind] ?? "active");
  return [
    "---",
    `id: ${id}`,
    `kind: ${kind}`,
    "scope: workspace",
    `state: ${resolvedState}`,
    `authority: ${resolvedAuthority}`,
    "schema_version: 1",
    "created: 2026-07-17",
    "updated: 2026-07-17",
    `summary: ${JSON.stringify(`Summary for ${id}`)}`,
    ...(kind === "decision"
      ? [
          `decision_key: ${decisionKey ?? id}`,
          ...listField("supersedes", supersedes),
          ...listField("superseded_by", supersededBy),
        ]
      : []),
    "---",
    "",
    `# ${id}`,
    "",
    body,
    "",
  ].join("\n");
}

function governedOperation(operationId, kind, changes) {
  return {
    operationId,
    kind,
    sourceRefs: [{
      type: "user",
      ref: `current-task:${operationId}`,
      expectedSha256: null,
    }],
    changes,
  };
}

function proposalInput({ idempotencyKey, beforeText, afterText, path = TARGET_NOTE }) {
  return {
    schemaVersion: 1,
    kind: "syncora.proposal-input",
    idempotencyKey,
    origin: "capture",
    actor: {
      type: "agent",
      id: "syncora-integration-test",
      runtime: process.version,
    },
    reason: "Exercise the exact governed capture, review, and apply contract.",
    correctsProposalId: null,
    operations: [{
      operationId: `${idempotencyKey}-update`,
      kind: "note.update",
      sourceRefs: [{
        type: "user",
        ref: "current-task:governed-capture-integration-test",
        expectedSha256: null,
      }],
      changes: [{
        path,
        expectedPriorSha256: taggedContentSha256(beforeText),
        afterText,
      }],
    }],
  };
}

async function writeProposalInput(workspace, name, input) {
  const path = join(workspace, `${name}.json`);
  await writeFile(path, `${JSON.stringify(input, null, 2)}\n`, "utf8");
  return path;
}

function reviewArgs(workspace, proposal, decision) {
  return [
    "review",
    "--workspace",
    workspace,
    "--proposal",
    proposal.id,
    "--proposal-digest",
    proposal.digest,
    "--decision",
    decision,
    "--reviewed-by",
    "workspace-owner",
    "--reason",
    `${decision} after inspecting the exact immutable proposal digest.`,
  ];
}

test("capture, inspect, review, and apply preserve the approval boundary and exact bytes", async () => {
  const workspace = await initializedWorkspace();
  const target = join(workspace, "local", ...TARGET_NOTE.split("/"));
  const secretBody = "GOVERNED-NOTE-BODY-MUST-NOT-LEAK-4f922d";
  try {
    const before = await readFile(target, "utf8");
    const after = updatedProjectHub(before, secretBody);
    const input = await writeProposalInput(
      workspace,
      "primary-proposal",
      proposalInput({
        idempotencyKey: "governed-capture-primary",
        beforeText: before,
        afterText: after,
      }),
    );

    const captured = runJson([
      "capture",
      "--workspace",
      workspace,
      "--input",
      input,
    ]);
    assert.equal(captured.output.ok, true);
    assert.equal(captured.output.proposal.state, "proposed");
    assert.equal(captured.output.summary.changes, 1);
    assert.equal(
      captured.output.approvalSummary.title,
      "Save this knowledge update to Syncora?",
    );
    assert.equal(captured.output.approvalSummary.changes.total, 1);
    assert.equal(captured.output.approvalSummary.representativePaths.length, 1);
    assert.equal(captured.output.approvalSummary.omittedPathCount, 0);
    assert.equal(captured.output.approvalSummary.fullDetails.optional, true);
    assert.equal(captured.output.approvalSummary.canonicalMarkdownChanged, false);
    assert.equal(await readFile(target, "utf8"), before);
    assert.doesNotMatch(captured.result.stdout, new RegExp(secretBody, "u"));
    assert.equal("afterText" in captured.output.changes[0], false);

    const proposal = captured.output.proposal;
    const inspected = runJson([
      "propose",
      "--workspace",
      workspace,
      "--proposal",
      proposal.id,
    ]);
    assert.equal(inspected.output.action, "inspect");
    assert.equal(inspected.output.proposal.digest, proposal.digest);
    assert.equal(inspected.output.proposal.state, "proposed");
    assert.equal(await readFile(target, "utf8"), before);
    assert.doesNotMatch(inspected.result.stdout, new RegExp(secretBody, "u"));

    const withoutReview = runJson([
      "apply",
      "--workspace",
      workspace,
      "--proposal",
      proposal.id,
    ], 1);
    assert.equal(withoutReview.output.error.code, "REVIEW001");
    assert.equal(await readFile(target, "utf8"), before);

    const wrongDigest = runJson([
      "review",
      "--workspace",
      workspace,
      "--proposal",
      proposal.id,
      "--proposal-digest",
      `sha256:${"0".repeat(64)}`,
      "--decision",
      "approve",
      "--reviewed-by",
      "workspace-owner",
      "--reason",
      "This digest must not authorize a different proposal.",
    ], 1);
    assert.equal(wrongDigest.output.error.code, "REVIEW001");
    assert.equal(await readFile(target, "utf8"), before);

    const approved = runJson(reviewArgs(workspace, proposal, "approve"));
    assert.equal(approved.output.decision, "approve");
    assert.equal(approved.output.review.proposalDigest, proposal.digest);
    assert.equal(await readFile(target, "utf8"), before);

    const applied = runJson([
      "apply",
      "--workspace",
      workspace,
      "--proposal",
      proposal.id,
    ]);
    assert.equal(applied.output.state, "applied");
    assert.equal(applied.output.idempotent, false);
    assert.equal(applied.output.summary.changed, 1);
    assert.equal(await readFile(target, "utf8"), after);
    assert.doesNotMatch(applied.result.stdout, new RegExp(secretBody, "u"));

    const replayed = runJson([
      "apply",
      "--workspace",
      workspace,
      "--proposal",
      proposal.id,
    ]);
    assert.equal(replayed.output.state, "applied");
    assert.equal(replayed.output.idempotent, true);
    assert.equal(replayed.output.summary.changed, 0);
    assert.equal(replayed.output.summary.already, 1);
    assert.equal(await readFile(target, "utf8"), after);
    assert.doesNotMatch(replayed.result.stdout, new RegExp(secretBody, "u"));

    const appliedInspection = runJson([
      "propose",
      "--workspace",
      workspace,
      "--proposal",
      proposal.id,
    ]).output;
    assert.equal(appliedInspection.proposal.state, "applied");
    assert.equal(appliedInspection.receipts[0].outcome, "applied");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a rejection is terminal and never mutates canonical Markdown", async () => {
  const workspace = await initializedWorkspace();
  const target = join(workspace, "local", ...TARGET_NOTE.split("/"));
  try {
    const before = await readFile(target, "utf8");
    const after = updatedProjectHub(before, "Rejected content must never publish.");
    const input = await writeProposalInput(
      workspace,
      "rejected-proposal",
      proposalInput({
        idempotencyKey: "governed-capture-rejected",
        beforeText: before,
        afterText: after,
      }),
    );
    const captured = runJson([
      "capture",
      "--workspace",
      workspace,
      "--input",
      input,
    ]).output;
    const proposal = captured.proposal;

    const rejected = runJson(reviewArgs(workspace, proposal, "reject"));
    assert.equal(rejected.output.decision, "reject");
    assert.equal(await readFile(target, "utf8"), before);

    const applyRejected = runJson([
      "apply",
      "--workspace",
      workspace,
      "--proposal",
      proposal.id,
    ], 1);
    assert.equal(applyRejected.output.error.code, "REVIEW001");

    const approveAfterReject = runJson(
      reviewArgs(workspace, proposal, "approve"),
      1,
    );
    assert.equal(approveAfterReject.output.error.code, "REVIEW001");
    const inspected = runJson([
      "propose",
      "--workspace",
      workspace,
      "--proposal",
      proposal.id,
    ]).output;
    assert.equal(inspected.proposal.state, "rejected");
    assert.equal(await readFile(target, "utf8"), before);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("approved proposals fail closed when their target and graph revision become stale", async () => {
  const workspace = await initializedWorkspace();
  const target = join(workspace, "local", ...TARGET_NOTE.split("/"));
  try {
    const before = await readFile(target, "utf8");
    const proposed = updatedProjectHub(before, "Reviewed content that later becomes stale.");
    const input = await writeProposalInput(
      workspace,
      "stale-proposal",
      proposalInput({
        idempotencyKey: "governed-capture-stale",
        beforeText: before,
        afterText: proposed,
      }),
    );
    const proposal = runJson([
      "capture",
      "--workspace",
      workspace,
      "--input",
      input,
    ]).output.proposal;
    runJson(reviewArgs(workspace, proposal, "approve"));

    const externallyChanged = updatedProjectHub(
      before,
      "External canonical edit wins over a stale reviewed proposal.",
    );
    await writeFile(target, externallyChanged, "utf8");
    const staleApply = runJson([
      "apply",
      "--workspace",
      workspace,
      "--proposal",
      proposal.id,
    ], 1);
    assert.equal(staleApply.output.error.code, "WRITE001");
    assert.match(staleApply.output.error.message, /Graph changed/u);
    assert.match(staleApply.output.error.details.conflictId, /^conflict_/u);
    assert.equal(await readFile(target, "utf8"), externallyChanged);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("the governed CLI composes all eight semantic operation kinds into one exact transaction", async () => {
  const workspace = await initializedWorkspace();
  const graph = join(workspace, "local");
  const pathFor = (portable) => join(graph, ...portable.split("/"));
  const paths = {
    created: "knowledge/concepts/governed-created.md",
    update: "knowledge/concepts/governed-update.md",
    moveSource: "knowledge/concepts/governed-move-source.md",
    moveDestination: "knowledge/concepts/governed-move-destination.md",
    linkSource: "knowledge/concepts/governed-link-source.md",
    linkTarget: "knowledge/concepts/governed-link-target.md",
    accept: "knowledge/decisions/governed-accept.md",
    predecessor: "knowledge/decisions/governed-predecessor.md",
    successor: "knowledge/decisions/governed-successor.md",
    hub: TARGET_NOTE,
    session: "knowledge/sessions/2026-07-17-governed-operations.md",
  };
  try {
    const baseline = {
      update: currentNote({
        id: "concept-governed-update",
        kind: "concept",
        body: "Original update content.",
      }),
      move: currentNote({
        id: "concept-governed-move",
        kind: "concept",
        body: "These exact bytes must move.",
      }),
      linkSource: currentNote({
        id: "concept-governed-link-source",
        kind: "concept",
        body: "A stable link source.",
      }),
      linkTarget: currentNote({
        id: "concept-governed-link-target",
        kind: "concept",
        body: "A stable link target.",
      }),
      accept: currentNote({
        id: "decision-governed-accept",
        kind: "decision",
        decisionKey: "governed-accept-choice",
      }),
      predecessor: currentNote({
        id: "decision-governed-predecessor",
        kind: "decision",
        decisionKey: "governed-replacement-choice",
        state: "accepted",
      }),
      successor: currentNote({
        id: "decision-governed-successor",
        kind: "decision",
        decisionKey: "governed-replacement-choice",
        state: "proposed",
      }),
    };
    await Promise.all([
      writeFile(pathFor(paths.update), baseline.update, "utf8"),
      writeFile(pathFor(paths.moveSource), baseline.move, "utf8"),
      writeFile(pathFor(paths.linkSource), baseline.linkSource, "utf8"),
      writeFile(pathFor(paths.linkTarget), baseline.linkTarget, "utf8"),
      writeFile(pathFor(paths.accept), baseline.accept, "utf8"),
      writeFile(pathFor(paths.predecessor), baseline.predecessor, "utf8"),
      writeFile(pathFor(paths.successor), baseline.successor, "utf8"),
    ]);

    const created = currentNote({
      id: "concept-governed-created",
      kind: "concept",
      body: "Created through governed capture.",
    });
    const updated = currentNote({
      id: "concept-governed-update",
      kind: "concept",
      body: "Updated through governed capture.",
    });
    const linked = currentNote({
      id: "concept-governed-link-source",
      kind: "concept",
      body: "A stable link source. [[knowledge/concepts/governed-link-target]]",
    });
    const accepted = currentNote({
      id: "decision-governed-accept",
      kind: "decision",
      decisionKey: "governed-accept-choice",
      state: "accepted",
    });
    const predecessor = currentNote({
      id: "decision-governed-predecessor",
      kind: "decision",
      decisionKey: "governed-replacement-choice",
      state: "superseded",
      supersededBy: ["decision-governed-successor"],
    });
    const successor = currentNote({
      id: "decision-governed-successor",
      kind: "decision",
      decisionKey: "governed-replacement-choice",
      state: "accepted",
      supersedes: ["decision-governed-predecessor"],
    });
    const hubBefore = await readFile(pathFor(paths.hub), "utf8");
    const hubAfter = updatedProjectHub(
      hubBefore,
      "The governed hub refresh completed through an approved proposal.",
    );
    const session = currentNote({
      id: "session-governed-operations",
      kind: "session",
      body: "All governed operation kinds were exercised.",
    });
    const input = await writeProposalInput(workspace, "all-operations", {
      schemaVersion: 1,
      kind: "syncora.proposal-input",
      idempotencyKey: "governed-all-operation-kinds",
      origin: "capture",
      actor: {
        type: "agent",
        id: "syncora-integration-test",
        runtime: process.version,
      },
      reason: "Prove every governed semantic operation composes through the public CLI.",
      correctsProposalId: null,
      operations: [
        governedOperation("create-note", "note.create", [{
          path: paths.created,
          expectedPriorSha256: null,
          afterText: created,
        }]),
        governedOperation("update-note", "note.update", [{
          path: paths.update,
          expectedPriorSha256: taggedContentSha256(baseline.update),
          afterText: updated,
        }]),
        governedOperation("move-note", "note.move", [
          {
            path: paths.moveSource,
            expectedPriorSha256: taggedContentSha256(baseline.move),
            afterText: null,
          },
          {
            path: paths.moveDestination,
            expectedPriorSha256: null,
            afterText: baseline.move,
          },
        ]),
        governedOperation("add-link", "link.add", [{
          path: paths.linkSource,
          expectedPriorSha256: taggedContentSha256(baseline.linkSource),
          afterText: linked,
        }]),
        governedOperation("accept-decision", "decision.accept", [{
          path: paths.accept,
          expectedPriorSha256: taggedContentSha256(baseline.accept),
          afterText: accepted,
        }]),
        governedOperation("supersede-decision", "decision.supersede", [
          {
            path: paths.predecessor,
            expectedPriorSha256: taggedContentSha256(baseline.predecessor),
            afterText: predecessor,
          },
          {
            path: paths.successor,
            expectedPriorSha256: taggedContentSha256(baseline.successor),
            afterText: successor,
          },
        ]),
        governedOperation("refresh-hub", "hub.refresh", [{
          path: paths.hub,
          expectedPriorSha256: taggedContentSha256(hubBefore),
          afterText: hubAfter,
        }]),
        governedOperation("record-session", "session.record", [{
          path: paths.session,
          expectedPriorSha256: null,
          afterText: session,
        }]),
      ],
    });

    const proposal = runJson([
      "capture",
      "--workspace",
      workspace,
      "--input",
      input,
    ]).output.proposal;
    runJson(reviewArgs(workspace, proposal, "approve"));
    const applied = runJson([
      "apply",
      "--workspace",
      workspace,
      "--proposal",
      proposal.id,
    ]).output;
    assert.equal(applied.summary.changed, 10);
    assert.equal(await readFile(pathFor(paths.created), "utf8"), created);
    assert.equal(await readFile(pathFor(paths.update), "utf8"), updated);
    await assert.rejects(access(pathFor(paths.moveSource)));
    assert.equal(await readFile(pathFor(paths.moveDestination), "utf8"), baseline.move);
    assert.equal(await readFile(pathFor(paths.linkSource), "utf8"), linked);
    assert.equal(await readFile(pathFor(paths.accept), "utf8"), accepted);
    assert.equal(await readFile(pathFor(paths.predecessor), "utf8"), predecessor);
    assert.equal(await readFile(pathFor(paths.successor), "utf8"), successor);
    assert.equal(await readFile(pathFor(paths.hub), "utf8"), hubAfter);
    assert.equal(await readFile(pathFor(paths.session), "utf8"), session);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("apply resumes a durable prepared journal when a crash preceded its active marker", async () => {
  const workspace = await initializedWorkspace();
  const graphRoot = join(workspace, "local");
  const target = join(graphRoot, ...TARGET_NOTE.split("/"));
  try {
    const before = await readFile(target, "utf8");
    const after = updatedProjectHub(
      before,
      "Prepared transaction recovery completed without rebuilding intent.",
    );
    const input = await writeProposalInput(
      workspace,
      "prepared-recovery",
      proposalInput({
        idempotencyKey: "governed-prepared-recovery",
        beforeText: before,
        afterText: after,
      }),
    );
    const proposal = runJson([
      "capture",
      "--workspace",
      workspace,
      "--input",
      input,
    ]).output.proposal;
    runJson(reviewArgs(workspace, proposal, "approve"));
    const transactionId = `apply_${proposal.id.slice("proposal_".length)}`;
    await assert.rejects(
      prepareFileTransaction(
        {
          graphRoot,
          transactionId,
          transactionDigest: proposal.digest,
          changes: [{
            kind: "update",
            path: TARGET_NOTE,
            before: Buffer.from(before, "utf8"),
            after: Buffer.from(after, "utf8"),
          }],
        },
        {
          boundary: (name) => {
            if (name === "prepare.before-active") {
              throw new Error("injected crash before active marker");
            }
          },
        },
      ),
      /injected crash before active marker/u,
    );
    assert.equal(
      (await readFileTransaction({ graphRoot, transactionId })).status,
      "prepared",
    );
    assert.equal(await readActiveFileTransaction(graphRoot), null);
    assert.equal(await readFile(target, "utf8"), before);

    const recovered = runJson([
      "apply",
      "--workspace",
      workspace,
      "--proposal",
      proposal.id,
    ]).output;
    assert.equal(recovered.state, "applied");
    assert.equal(recovered.summary.changed, 1);
    assert.equal(await readFile(target, "utf8"), after);
    assert.equal(await readActiveFileTransaction(graphRoot), null);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("hostile proposal paths and aliased input directories fail closed", async (t) => {
  const workspace = await initializedWorkspace();
  const target = join(workspace, "local", ...TARGET_NOTE.split("/"));
  try {
    const before = await readFile(target, "utf8");
    const traversalInput = await writeProposalInput(
      workspace,
      "traversal-proposal",
      proposalInput({
        idempotencyKey: "governed-capture-traversal",
        beforeText: before,
        path: "../escaped.md",
        afterText: "# Hostile path\n",
      }),
    );
    const traversal = runJson([
      "capture",
      "--workspace",
      workspace,
      "--input",
      traversalInput,
    ], 1);
    assert.equal(traversal.output.error.code, "PROPOSAL001");
    await assert.rejects(access(join(workspace, "escaped.md")));
    assert.equal(await readFile(target, "utf8"), before);

    const realInputDirectory = join(workspace, "real-input");
    const aliasInputDirectory = join(workspace, "aliased-input");
    await mkdir(realInputDirectory);
    const validInput = proposalInput({
      idempotencyKey: "governed-capture-aliased-input",
      beforeText: before,
      afterText: updatedProjectHub(before, "Aliased input must not be trusted."),
    });
    await writeFile(
      join(realInputDirectory, "proposal.json"),
      `${JSON.stringify(validInput, null, 2)}\n`,
      "utf8",
    );
    try {
      await symlink(
        realInputDirectory,
        aliasInputDirectory,
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      t.diagnostic(`Directory-link input check unavailable: ${error.message}`);
      return;
    }
    const aliased = runJson([
      "capture",
      "--workspace",
      workspace,
      "--input",
      join(aliasInputDirectory, "proposal.json"),
    ], 1);
    assert.equal(aliased.output.error.code, "PROPOSAL001");
    assert.equal(await readFile(target, "utf8"), before);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
