import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  cutoverMigration,
  migrationStatus,
  retireMigration,
  rollbackMigration,
  verifyMigration,
} from "../../skills/syncora/scripts/lib/migration-adoption.mjs";
import { shadowMigration } from "../../skills/syncora/scripts/lib/migration-shadow.mjs";
import { stageMigration } from "../../skills/syncora/scripts/lib/migration-stage.mjs";
import {
  applyFileTransaction,
  commitFileTransaction,
  finalizeFileTransaction,
  prepareFileTransaction,
  readActiveFileTransaction,
  readFileTransaction,
} from "../../skills/syncora/scripts/lib/file-transaction.mjs";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const cli = join(testDirectory, "..", "..", "skills", "syncora", "scripts", "syncora.mjs");

function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function run(args, expectedStatus = 0) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
  assert.equal(
    result.status,
    expectedStatus,
    `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result;
}

function assertCliError(args, code) {
  const result = run([...args, "--format", "json"], 1);
  const report = JSON.parse(result.stderr);
  assert.equal(report.error.code, code, result.stderr);
  return report.error;
}

async function fixture(prefix = "syncora-writer-interlock-") {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  run(["setup", "--workspace", workspace, "--no-patch-agents"]);
  const graphRoot = join(workspace, "local");
  const notePath = join(graphRoot, "knowledge", "projects", "workspace.md");
  const before = await readFile(notePath);
  return { workspace, graphRoot, notePath, before };
}

async function prepareActive(fixtureState, transactionId = "writer-interlock") {
  const after = Buffer.concat([
    fixtureState.before,
    Buffer.from("\nWriter interlock token.\n", "utf8"),
  ]);
  const transactionDigest = digest(Buffer.from(`transaction:${transactionId}`, "utf8"));
  await prepareFileTransaction({
    graphRoot: fixtureState.graphRoot,
    transactionId,
    transactionDigest,
    changes: [{
      kind: "update",
      path: "knowledge/projects/workspace.md",
      before: fixtureState.before,
      after,
    }],
  });
  return { transactionId, transactionDigest, after };
}

test("all canonical readers, setup reruns, and migration phases fail closed during a generic transaction", async () => {
  const state = await fixture();
  try {
    const proposalInputPath = join(state.workspace, "interlock-proposal.json");
    await writeFile(proposalInputPath, `${JSON.stringify({
      schemaVersion: 1,
      kind: "syncora.proposal-input",
      idempotencyKey: "writer-interlock-proposal",
      origin: "capture",
      actor: { type: "agent", id: "writer-interlock-test", runtime: process.version },
      reason: "Prove proposal preparation and approval cannot observe a mixed graph.",
      correctsProposalId: null,
      operations: [{
        operationId: "update-workspace-hub",
        kind: "hub.refresh",
        sourceRefs: [{
          type: "user",
          ref: "current-task:writer-interlock",
          expectedSha256: null,
        }],
        changes: [{
          path: "knowledge/projects/workspace.md",
          expectedPriorSha256: digest(state.before),
          afterText: `${state.before.toString("utf8")}\nProposed interlock token.\n`,
        }],
      }],
    }, null, 2)}\n`, "utf8");
    const proposal = JSON.parse(run([
      "propose",
      "--workspace",
      state.workspace,
      "--input",
      proposalInputPath,
      "--format",
      "json",
    ]).stdout).proposal;
    await prepareActive(state);

    assertCliError([
      "capture",
      "--workspace",
      state.workspace,
      "--input",
      proposalInputPath,
    ], "WRITE007");
    assertCliError([
      "review",
      "--workspace",
      state.workspace,
      "--proposal",
      proposal.id,
      "--proposal-digest",
      proposal.digest,
      "--decision",
      "approve",
      "--reviewed-by",
      "workspace-owner",
      "--reason",
      "Approval must wait for the active transaction to finish.",
    ], "WRITE007");

    for (const args of [
      ["validate", "--workspace", state.workspace],
      ["migrate", "--phase", "authority", "--dry-run", "--workspace", state.workspace],
      ["search", "--workspace", state.workspace, "--query", "workspace"],
      ["backlinks", "--workspace", state.workspace, "--note", "knowledge/projects/workspace.md"],
      ["context", "--workspace", state.workspace, "--intent", "Review the workspace project"],
      ["checkpoint", "--workspace", state.workspace, "--phase", "pre", "--profile", "context"],
      ["setup", "--workspace", state.workspace, "--no-patch-agents", "--dry-run"],
      ["setup", "--workspace", state.workspace, "--no-patch-agents"],
    ]) {
      const error = assertCliError(args, "WRITE007");
      assert.equal(error.details.transactionId, "writer-interlock");
      assert.equal(error.details.status, "prepared");
    }

    const migrationOptions = {
      workspace: state.workspace,
      migrationId: "blocked-migration",
      manifest: join(state.workspace, "missing-manifest.json"),
      stagedContent: join(state.workspace, "missing-staged-content"),
      allowExternalGraphRoot: undefined,
      dryRun: false,
    };
    for (const operation of [
      () => stageMigration(migrationOptions),
      () => stageMigration({ ...migrationOptions, dryRun: true }),
      () => shadowMigration({
        ...migrationOptions,
        fixtures: join(state.workspace, "missing-fixtures.json"),
      }),
      () => shadowMigration({
        ...migrationOptions,
        fixtures: join(state.workspace, "missing-fixtures.json"),
        dryRun: true,
      }),
      () => cutoverMigration(migrationOptions),
      () => cutoverMigration({ ...migrationOptions, dryRun: true }),
      () => verifyMigration(migrationOptions),
      () => verifyMigration({ ...migrationOptions, dryRun: true }),
      () => rollbackMigration(migrationOptions),
      () => rollbackMigration({ ...migrationOptions, dryRun: true }),
      () => retireMigration(migrationOptions),
      () => retireMigration({ ...migrationOptions, dryRun: true }),
      () => migrationStatus(migrationOptions),
    ]) {
      await assert.rejects(
        operation(),
        (error) => error?.code === "WRITE007" && error.details?.status === "prepared",
      );
    }

    const diagnosis = JSON.parse(run([
      "doctor",
      "--workspace",
      state.workspace,
      "--format",
      "json",
    ]).stdout);
    const transactionCheck = diagnosis.checks.find((item) => item.code === "WRITE007");
    assert.equal(transactionCheck.status, "warn");
    assert.match(transactionCheck.message, /is prepared/u);

    assert.deepEqual(await readFile(state.notePath), state.before);
  } finally {
    await rm(state.workspace, { recursive: true, force: true });
  }
});

test("finalized-pending-receipt blocks readers until receipt-confirmed finalization", async () => {
  const state = await fixture("syncora-writer-terminal-");
  try {
    const transaction = await prepareActive(state, "terminal-marker");
    await applyFileTransaction({
      graphRoot: state.graphRoot,
      transactionId: transaction.transactionId,
      transactionDigest: transaction.transactionDigest,
    });
    const receiptSha256 = digest(Buffer.from("published receipt", "utf8"));
    await commitFileTransaction({
      graphRoot: state.graphRoot,
      transactionId: transaction.transactionId,
      transactionDigest: transaction.transactionDigest,
      receiptSha256,
    });

    const pending = assertCliError([
      "validate",
      "--workspace",
      state.workspace,
    ], "WRITE007");
    assert.equal(pending.details.transactionId, transaction.transactionId);
    assert.equal(pending.details.status, "finalized-pending-receipt");

    await assert.rejects(
      finalizeFileTransaction({
        graphRoot: state.graphRoot,
        transactionId: transaction.transactionId,
        transactionDigest: transaction.transactionDigest,
        receiptSha256,
        receiptPublished: true,
      }, {
        boundary(name) {
          if (name === "finalize.before-active-release") {
            throw new Error("simulated process exit after terminal journal publication");
          }
        },
      }),
      /simulated process exit/u,
    );

    const [active, journal] = await Promise.all([
      readActiveFileTransaction(state.graphRoot),
      readFileTransaction({
        graphRoot: state.graphRoot,
        transactionId: transaction.transactionId,
      }),
    ]);
    assert.equal(active.transactionId, transaction.transactionId);
    assert.equal(journal.status, "finalized");

    const search = JSON.parse(run([
      "search",
      "--workspace",
      state.workspace,
      "--query",
      "interlock token",
      "--format",
      "json",
    ]).stdout);
    assert.equal(search.ok, true);
    assert.equal(search.summary.matches > 0, true);
    const diagnosis = JSON.parse(run([
      "doctor",
      "--workspace",
      state.workspace,
      "--format",
      "json",
    ]).stdout);
    const transactionCheck = diagnosis.checks.find((item) => item.code === "WRITE007");
    assert.equal(transactionCheck.status, "warn");
    assert.match(transactionCheck.message, /stale marker/u);
    assert.deepEqual(await readFile(state.notePath), transaction.after);
  } finally {
    await rm(state.workspace, { recursive: true, force: true });
  }
});
