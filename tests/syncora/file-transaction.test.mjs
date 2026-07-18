import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FILE_TRANSACTION_POLICY,
  FILE_TRANSACTION_DURABILITY,
  applyFileTransaction,
  assertFileTransactionAvailable,
  commitFileTransaction,
  fileTransactionPaths,
  finalizeFileTransaction,
  prepareFileTransaction,
  readActiveFileTransaction,
  readFileTransaction,
  rollbackFileTransaction,
} from "../../skills/syncora/scripts/lib/file-transaction.mjs";

function sha(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function fixture(prefix = "syncora-file-transaction-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const graphRoot = join(root, "local");
  await mkdir(join(graphRoot, "knowledge"), { recursive: true });
  return { root, graphRoot };
}

async function missing(path) {
  await assert.rejects(readFile(path), (error) => error?.code === "ENOENT");
}

test("generic transaction holds its graph marker through finalization and replays finalized bytes exactly", async () => {
  const environment = await fixture();
  const transactionId = "complete-flow";
  const transactionDigest = sha("complete-flow-proposal");
  const receiptSha256 = sha("immutable-apply-receipt");
  const paths = fileTransactionPaths(environment.graphRoot, transactionId);
  const a = join(environment.graphRoot, "knowledge", "a.md");
  const deleted = join(environment.graphRoot, "knowledge", "delete.md");
  const movedFrom = join(environment.graphRoot, "knowledge", "move.md");
  const movedTo = join(environment.graphRoot, "knowledge", "moved.md");
  const created = join(environment.graphRoot, "knowledge", "created.md");
  try {
    await writeFile(a, "before a\n");
    await writeFile(deleted, "delete me\n");
    await writeFile(movedFrom, "move me\n");

    const prepared = await prepareFileTransaction({
      graphRoot: environment.graphRoot,
      transactionId,
      transactionDigest,
      changes: [
        { kind: "update", path: "knowledge/a.md", before: Buffer.from("before a\n"), after: Buffer.from("after a\n") },
        { kind: "create", path: "knowledge/created.md", after: Buffer.from("created\n") },
        { kind: "delete", path: "knowledge/delete.md", before: Buffer.from("delete me\n") },
        { kind: "move", fromPath: "knowledge/move.md", toPath: "knowledge/moved.md", before: Buffer.from("move me\n") },
      ],
    });
    assert.equal(prepared.created, true);
    assert.equal(prepared.journal.status, "prepared");
    assert.equal((await readActiveFileTransaction(environment.graphRoot)).transactionId, transactionId);
    assert.match(paths.transactionRoot, /[\\/]\.syncora[\\/]transactions[\\/]files[\\/]complete-flow$/u);

    await assert.rejects(
      prepareFileTransaction({
        graphRoot: environment.graphRoot,
        transactionId: "competing-writer",
        transactionDigest: sha("competing"),
        changes: [{ kind: "create", path: "knowledge/other.md", after: Buffer.from("other\n") }],
      }),
      (error) => error?.code === "WRITE007",
    );
    await assert.rejects(
      assertFileTransactionAvailable({ graphRoot: environment.graphRoot, transactionId: "other" }),
      (error) => error?.code === "WRITE007",
    );

    const applied = await applyFileTransaction({ graphRoot: environment.graphRoot, transactionId, transactionDigest });
    assert.equal(applied.journal.status, "awaiting-finalization");
    assert.equal((await readActiveFileTransaction(environment.graphRoot)).transactionId, transactionId);
    assert.equal(await readFile(a, "utf8"), "after a\n");
    assert.equal(await readFile(created, "utf8"), "created\n");
    assert.equal(await readFile(movedTo, "utf8"), "move me\n");
    await missing(deleted);
    await missing(movedFrom);

    const committed = await commitFileTransaction({
      graphRoot: environment.graphRoot,
      transactionId,
      transactionDigest,
      receiptSha256,
    });
    assert.equal(committed.journal.status, "finalized-pending-receipt");
    assert.equal(committed.journal.receiptSha256, receiptSha256);
    assert.equal((await readActiveFileTransaction(environment.graphRoot)).transactionId, transactionId);
    await assert.rejects(
      rollbackFileTransaction({ graphRoot: environment.graphRoot, transactionId, transactionDigest }),
      (error) => error?.code === "WRITE008",
    );
    await assert.rejects(
      finalizeFileTransaction({ graphRoot: environment.graphRoot, transactionId, transactionDigest, receiptSha256 }),
      (error) => error?.code === "WRITE008",
    );

    const finalized = await finalizeFileTransaction({
      graphRoot: environment.graphRoot,
      transactionId,
      transactionDigest,
      receiptSha256,
      receiptPublished: true,
    });
    assert.equal(finalized.journal.status, "finalized");
    assert.equal(finalized.journal.receiptSha256, receiptSha256);
    assert.equal(await readActiveFileTransaction(environment.graphRoot), null);

    const journalBefore = await readFile(paths.journal);
    const journalStatBefore = await lstat(paths.journal, { bigint: true });
    const targetBefore = await readFile(a);
    const targetStatBefore = await lstat(a, { bigint: true });
    const replayed = await applyFileTransaction({ graphRoot: environment.graphRoot, transactionId, transactionDigest });
    assert.equal(replayed.changed, false);
    assert.deepEqual(await readFile(paths.journal), journalBefore);
    assert.equal((await lstat(paths.journal, { bigint: true })).mtimeNs, journalStatBefore.mtimeNs);
    assert.deepEqual(await readFile(a), targetBefore);
    assert.equal((await lstat(a, { bigint: true })).mtimeNs, targetStatBefore.mtimeNs);

    const finalizedAgain = await finalizeFileTransaction({
      graphRoot: environment.graphRoot,
      transactionId,
      transactionDigest,
      receiptSha256,
      receiptPublished: true,
    });
    assert.equal(finalizedAgain.changed, false);
    assert.deepEqual(await readFile(paths.journal), journalBefore);

    const committedAgain = await commitFileTransaction({
      graphRoot: environment.graphRoot,
      transactionId,
      transactionDigest,
      receiptSha256,
    });
    assert.equal(committedAgain.changed, false);
    await assert.rejects(
      commitFileTransaction({
        graphRoot: environment.graphRoot,
        transactionId,
        transactionDigest,
        receiptSha256: sha("different-receipt"),
      }),
      (error) => error?.code === "WRITE008",
    );

    await assert.rejects(
      rollbackFileTransaction({ graphRoot: environment.graphRoot, transactionId, transactionDigest }),
      (error) => error?.code === "WRITE008",
    );
    assert.equal(await readFile(a, "utf8"), "after a\n");
    await missing(deleted);
    await missing(movedFrom);
  } finally {
    await rm(environment.root, { recursive: true, force: true });
  }
});

test("journal is durable before publication and an injected crash resumes the exact forward plan", async () => {
  const environment = await fixture();
  const transactionId = "crash-resume";
  const transactionDigest = sha("crash-resume-proposal");
  const first = join(environment.graphRoot, "knowledge", "first.md");
  const second = join(environment.graphRoot, "knowledge", "second.md");
  const paths = fileTransactionPaths(environment.graphRoot, transactionId);
  try {
    await writeFile(first, "first before\n");
    await writeFile(second, "second before\n");
    await prepareFileTransaction({
      graphRoot: environment.graphRoot,
      transactionId,
      transactionDigest,
      changes: [
        { kind: "update", path: "knowledge/first.md", before: Buffer.from("first before\n"), after: Buffer.from("first after\n") },
        { kind: "update", path: "knowledge/second.md", before: Buffer.from("second before\n"), after: Buffer.from("second after\n") },
      ],
    });

    let crashed = false;
    await assert.rejects(
      applyFileTransaction(
        { graphRoot: environment.graphRoot, transactionId, transactionDigest },
        {
          boundary: async (name) => {
            if (name === "forward.record.after" && !crashed) {
              crashed = true;
              const durable = JSON.parse(await readFile(paths.journal, "utf8"));
              assert.equal(durable.status, "applying");
              throw new Error("injected process crash");
            }
          },
        },
      ),
      /injected process crash/u,
    );
    assert.equal(crashed, true);
    assert.equal((await readFileTransaction({ graphRoot: environment.graphRoot, transactionId })).status, "applying");
    assert.equal((await readActiveFileTransaction(environment.graphRoot)).transactionId, transactionId);

    const resumed = await applyFileTransaction({ graphRoot: environment.graphRoot, transactionId, transactionDigest });
    assert.equal(resumed.journal.status, "awaiting-finalization");
    assert.ok(resumed.summary.already >= 1);
    assert.equal(await readFile(first, "utf8"), "first after\n");
    assert.equal(await readFile(second, "utf8"), "second after\n");
  } finally {
    await rm(environment.root, { recursive: true, force: true });
  }
});

test("prepare and finalize resume across the durable-journal marker boundaries", async () => {
  const environment = await fixture();
  const transactionId = "boundary-resume";
  const transactionDigest = sha("boundary-resume-proposal");
  const receiptSha256 = sha("boundary-resume-receipt");
  const target = join(environment.graphRoot, "knowledge", "target.md");
  const paths = fileTransactionPaths(environment.graphRoot, transactionId);
  const changes = [{
    kind: "update",
    path: "knowledge/target.md",
    before: Buffer.from("before\n"),
    after: Buffer.from("after\n"),
  }];
  try {
    await writeFile(target, "before\n");
    await assert.rejects(
      prepareFileTransaction(
        { graphRoot: environment.graphRoot, transactionId, transactionDigest, changes },
        { boundary: (name) => {
          if (name === "prepare.before-active") throw new Error("crash before active marker");
        } },
      ),
      /crash before active marker/u,
    );
    assert.equal((await readFileTransaction({ graphRoot: environment.graphRoot, transactionId })).status, "prepared");
    assert.equal(await readActiveFileTransaction(environment.graphRoot), null);

    const resumedPrepare = await prepareFileTransaction({
      graphRoot: environment.graphRoot,
      transactionId,
      transactionDigest,
      changes,
    });
    assert.equal(resumedPrepare.created, false);
    assert.equal((await readActiveFileTransaction(environment.graphRoot)).transactionId, transactionId);
    await applyFileTransaction({ graphRoot: environment.graphRoot, transactionId, transactionDigest });

    await assert.rejects(
      commitFileTransaction(
        { graphRoot: environment.graphRoot, transactionId, transactionDigest, receiptSha256 },
        { boundary: (name) => {
          if (name === "commit.after-journal") throw new Error("crash after irreversible commit");
        } },
      ),
      /crash after irreversible commit/u,
    );
    const committedBytes = await readFile(paths.journal);
    const committedStat = await lstat(paths.journal, { bigint: true });
    assert.equal((await readFileTransaction({ graphRoot: environment.graphRoot, transactionId })).status, "finalized-pending-receipt");
    assert.equal((await readActiveFileTransaction(environment.graphRoot)).transactionId, transactionId);
    await assert.rejects(
      rollbackFileTransaction({ graphRoot: environment.graphRoot, transactionId, transactionDigest }),
      (error) => error?.code === "WRITE008",
    );

    const resumedCommit = await commitFileTransaction({
      graphRoot: environment.graphRoot,
      transactionId,
      transactionDigest,
      receiptSha256,
    });
    assert.equal(resumedCommit.changed, false);
    assert.deepEqual(await readFile(paths.journal), committedBytes);
    assert.equal((await lstat(paths.journal, { bigint: true })).mtimeNs, committedStat.mtimeNs);

    await assert.rejects(
      finalizeFileTransaction(
        { graphRoot: environment.graphRoot, transactionId, transactionDigest, receiptSha256, receiptPublished: true },
        { boundary: (name) => {
          if (name === "finalize.after-journal") throw new Error("crash before marker release");
        } },
      ),
      /crash before marker release/u,
    );
    const finalizedBytes = await readFile(paths.journal);
    const finalizedStat = await lstat(paths.journal, { bigint: true });
    assert.equal((await readFileTransaction({ graphRoot: environment.graphRoot, transactionId })).status, "finalized");
    assert.equal((await readActiveFileTransaction(environment.graphRoot)).transactionId, transactionId);
    assert.equal(await assertFileTransactionAvailable({ graphRoot: environment.graphRoot, transactionId: "next-transaction" }), null);

    const resumedFinalize = await finalizeFileTransaction({
      graphRoot: environment.graphRoot,
      transactionId,
      transactionDigest,
      receiptSha256,
      receiptPublished: true,
    });
    assert.equal(resumedFinalize.changed, false);
    assert.equal(await readActiveFileTransaction(environment.graphRoot), null);
    assert.deepEqual(await readFile(paths.journal), finalizedBytes);
    assert.equal((await lstat(paths.journal, { bigint: true })).mtimeNs, finalizedStat.mtimeNs);
  } finally {
    await rm(environment.root, { recursive: true, force: true });
  }
});

test("active marker publication is no-replace atomic and cleans its deterministic crash residue", async () => {
  const environment = await fixture();
  const transactionId = "active-publication-crash";
  const transactionDigest = sha("active-publication-crash-proposal");
  const target = join(environment.graphRoot, "knowledge", "target.md");
  const paths = fileTransactionPaths(environment.graphRoot, transactionId);
  const changes = [{
    kind: "update",
    path: "knowledge/target.md",
    before: Buffer.from("before\n"),
    after: Buffer.from("after\n"),
  }];
  try {
    await writeFile(target, "before\n");
    await assert.rejects(
      prepareFileTransaction(
        { graphRoot: environment.graphRoot, transactionId, transactionDigest, changes },
        { boundary: (name) => {
          if (name === "prepare.active-after-temporary") throw new Error("crash after active temporary sync");
        } },
      ),
      /crash after active temporary sync/u,
    );

    assert.equal((await readFileTransaction({ graphRoot: environment.graphRoot, transactionId })).status, "prepared");
    assert.equal(await readActiveFileTransaction(environment.graphRoot), null);
    const residue = (await readdir(paths.transactionsRoot)).filter((name) =>
      /^\.syncora-active-[0-9a-f]{64}\.pending$/u.test(name));
    assert.equal(residue.length, 1);
    assert.equal(JSON.parse(await readFile(join(paths.transactionsRoot, residue[0]), "utf8")).transactionId, transactionId);
    await writeFile(join(paths.transactionsRoot, residue[0]), "partial");

    const resumed = await prepareFileTransaction({
      graphRoot: environment.graphRoot,
      transactionId,
      transactionDigest,
      changes,
    });
    assert.equal(resumed.created, false);
    assert.equal((await readdir(paths.transactionsRoot)).includes(residue[0]), false);
    assert.equal(JSON.parse(await readFile(paths.active, "utf8")).transactionId, transactionId);
  } finally {
    await rm(environment.root, { recursive: true, force: true });
  }
});

test("a synced deterministic staging residue resumes exactly and leaves unrelated siblings untouched", async () => {
  const environment = await fixture();
  const transactionId = "stage-residue-resume";
  const transactionDigest = sha("stage-residue-resume-proposal");
  const target = join(environment.graphRoot, "knowledge", "target.md");
  const unrelated = join(environment.graphRoot, "knowledge", ".syncora-txn-unowned-0-forward.stage");
  try {
    await writeFile(target, "before\n");
    await writeFile(unrelated, "leave me alone\n");
    await prepareFileTransaction({
      graphRoot: environment.graphRoot,
      transactionId,
      transactionDigest,
      changes: [{ kind: "update", path: "knowledge/target.md", before: Buffer.from("before\n"), after: Buffer.from("after\n") }],
    });
    await assert.rejects(
      applyFileTransaction(
        { graphRoot: environment.graphRoot, transactionId, transactionDigest },
        { boundary: (name) => {
          if (name === "forward.record.after-temporary") throw new Error("crash after staging sync");
        } },
      ),
      /crash after staging sync/u,
    );
    const names = await readdir(join(environment.graphRoot, "knowledge"));
    const owned = names.filter((name) =>
      /^\.syncora-txn-[0-9a-f]{64}-0-forward\.stage$/u.test(name));
    assert.equal(owned.length, 1);
    assert.equal(await readFile(join(environment.graphRoot, "knowledge", owned[0]), "utf8"), "after\n");
    assert.equal(await readFile(target, "utf8"), "before\n");

    const resumed = await applyFileTransaction({ graphRoot: environment.graphRoot, transactionId, transactionDigest });
    assert.equal(resumed.journal.status, "awaiting-finalization");
    assert.equal(await readFile(target, "utf8"), "after\n");
    assert.equal((await readdir(join(environment.graphRoot, "knowledge"))).includes(owned[0]), false);
    assert.equal(await readFile(unrelated, "utf8"), "leave me alone\n");
  } finally {
    await rm(environment.root, { recursive: true, force: true });
  }
});

test("a partial deterministic staging file is recovered because its exact journal-derived name is transaction-owned", async () => {
  const environment = await fixture();
  const transactionId = "foreign-stage-residue";
  const transactionDigest = sha("foreign-stage-residue-proposal");
  const target = join(environment.graphRoot, "knowledge", "target.md");
  try {
    await writeFile(target, "before\n");
    await prepareFileTransaction({
      graphRoot: environment.graphRoot,
      transactionId,
      transactionDigest,
      changes: [{ kind: "update", path: "knowledge/target.md", before: Buffer.from("before\n"), after: Buffer.from("after\n") }],
    });
    await assert.rejects(
      applyFileTransaction(
        { graphRoot: environment.graphRoot, transactionId, transactionDigest },
        { boundary: (name) => {
          if (name === "forward.record.after-temporary") throw new Error("crash after staging sync");
        } },
      ),
      /crash after staging sync/u,
    );
    const owned = (await readdir(join(environment.graphRoot, "knowledge"))).find((name) =>
      /^\.syncora-txn-[0-9a-f]{64}-0-forward\.stage$/u.test(name));
    assert.ok(owned);
    const ownedPath = join(environment.graphRoot, "knowledge", owned);
    await writeFile(ownedPath, "partial");

    const resumed = await applyFileTransaction({ graphRoot: environment.graphRoot, transactionId, transactionDigest });
    assert.equal(resumed.journal.status, "awaiting-finalization");
    assert.equal(await readFile(target, "utf8"), "after\n");
    await missing(ownedPath);
  } finally {
    await rm(environment.root, { recursive: true, force: true });
  }
});

test("delete and final-release crashes clean only deterministic transaction residue", async () => {
  const environment = await fixture();
  const transactionId = "retired-residue-resume";
  const transactionDigest = sha("retired-residue-resume-proposal");
  const receiptSha256 = sha("retired-residue-receipt");
  const target = join(environment.graphRoot, "knowledge", "target.md");
  const unrelated = join(environment.graphRoot, "knowledge", ".syncora-txn-unowned.retired");
  const paths = fileTransactionPaths(environment.graphRoot, transactionId);
  try {
    await writeFile(target, "delete me\n");
    await writeFile(unrelated, "leave me alone\n");
    await prepareFileTransaction({
      graphRoot: environment.graphRoot,
      transactionId,
      transactionDigest,
      changes: [{ kind: "delete", path: "knowledge/target.md", before: Buffer.from("delete me\n") }],
    });
    await assert.rejects(
      applyFileTransaction(
        { graphRoot: environment.graphRoot, transactionId, transactionDigest },
        { boundary: (name) => {
          if (name === "forward.record.after-rename") throw new Error("crash after delete retirement");
        } },
      ),
      /crash after delete retirement/u,
    );
    await missing(target);
    const retired = (await readdir(join(environment.graphRoot, "knowledge"))).find((name) =>
      /^\.syncora-txn-[0-9a-f]{64}-0-forward\.retired$/u.test(name));
    assert.ok(retired);
    assert.equal(await readFile(join(environment.graphRoot, "knowledge", retired), "utf8"), "delete me\n");

    await applyFileTransaction({ graphRoot: environment.graphRoot, transactionId, transactionDigest });
    assert.equal((await readdir(join(environment.graphRoot, "knowledge"))).includes(retired), false);
    assert.equal(await readFile(unrelated, "utf8"), "leave me alone\n");
    await commitFileTransaction({ graphRoot: environment.graphRoot, transactionId, transactionDigest, receiptSha256 });

    await assert.rejects(
      finalizeFileTransaction(
        { graphRoot: environment.graphRoot, transactionId, transactionDigest, receiptSha256, receiptPublished: true },
        { boundary: (name) => {
          if (name === "finalize.after-active-retire") throw new Error("crash after active retirement");
        } },
      ),
      /crash after active retirement/u,
    );
    assert.equal((await readFileTransaction({ graphRoot: environment.graphRoot, transactionId })).status, "finalized");
    assert.equal(await readActiveFileTransaction(environment.graphRoot), null);
    const activeResidue = (await readdir(paths.transactionsRoot)).find((name) =>
      /^\.syncora-active-[0-9a-f]{64}\.retired$/u.test(name));
    assert.ok(activeResidue);

    const resumed = await finalizeFileTransaction({
      graphRoot: environment.graphRoot,
      transactionId,
      transactionDigest,
      receiptSha256,
      receiptPublished: true,
    });
    assert.equal(resumed.changed, false);
    assert.equal((await readdir(paths.transactionsRoot)).includes(activeResidue), false);
    await assert.rejects(
      rollbackFileTransaction({ graphRoot: environment.graphRoot, transactionId, transactionDigest }),
      (error) => error?.code === "WRITE008",
    );
  } finally {
    await rm(environment.root, { recursive: true, force: true });
  }
});

test("durability contract exposes the process-crash and Windows power-loss boundary", () => {
  assert.equal(FILE_TRANSACTION_DURABILITY.fileContentSync, true);
  assert.equal(FILE_TRANSACTION_DURABILITY.processCrashRecovery, true);
  assert.equal(FILE_TRANSACTION_DURABILITY.parentDirectorySync, process.platform !== "win32");
  assert.equal(FILE_TRANSACTION_DURABILITY.windowsPowerLossGuarantee, false);
});

test("rollback preflights ownership and preserves a concurrent edit without partial restoration", async () => {
  const environment = await fixture();
  const transactionId = "rollback-ownership";
  const transactionDigest = sha("rollback-ownership-proposal");
  const first = join(environment.graphRoot, "knowledge", "first.md");
  const second = join(environment.graphRoot, "knowledge", "second.md");
  try {
    await writeFile(first, "first before\n");
    await writeFile(second, "second before\n");
    await prepareFileTransaction({
      graphRoot: environment.graphRoot,
      transactionId,
      transactionDigest,
      changes: [
        { kind: "update", path: "knowledge/first.md", before: Buffer.from("first before\n"), after: Buffer.from("first after\n") },
        { kind: "update", path: "knowledge/second.md", before: Buffer.from("second before\n"), after: Buffer.from("second after\n") },
      ],
    });
    await applyFileTransaction({ graphRoot: environment.graphRoot, transactionId, transactionDigest });
    await writeFile(second, "concurrent user edit\n");

    await assert.rejects(
      rollbackFileTransaction({ graphRoot: environment.graphRoot, transactionId, transactionDigest }),
      (error) => error?.code === "WRITE005" && error.details?.conflictsTotal === 1,
    );
    assert.equal(await readFile(first, "utf8"), "first after\n");
    assert.equal(await readFile(second, "utf8"), "concurrent user edit\n");
    assert.equal((await readFileTransaction({ graphRoot: environment.graphRoot, transactionId })).status, "awaiting-finalization");

    await writeFile(second, "second after\n");
    const rolledBack = await rollbackFileTransaction({ graphRoot: environment.graphRoot, transactionId, transactionDigest });
    assert.equal(rolledBack.journal.status, "rolled-back");
    assert.equal(await readFile(first, "utf8"), "first before\n");
    assert.equal(await readFile(second, "utf8"), "second before\n");
    assert.equal(await readActiveFileTransaction(environment.graphRoot), null);
  } finally {
    await rm(environment.root, { recursive: true, force: true });
  }
});

test("corrupt and future transaction state fail closed", async () => {
  const environment = await fixture();
  const transactionId = "corrupt-state";
  const transactionDigest = sha("corrupt-state-proposal");
  const target = join(environment.graphRoot, "knowledge", "target.md");
  const paths = fileTransactionPaths(environment.graphRoot, transactionId);
  try {
    await writeFile(target, "before\n");
    await prepareFileTransaction({
      graphRoot: environment.graphRoot,
      transactionId,
      transactionDigest,
      changes: [{ kind: "update", path: "knowledge/target.md", before: Buffer.from("before\n"), after: Buffer.from("after\n") }],
    });
    const futureActive = JSON.parse(await readFile(paths.active, "utf8"));
    futureActive.schemaVersion = 999;
    await writeFile(paths.active, JSON.stringify(futureActive));
    await assert.rejects(
      applyFileTransaction({ graphRoot: environment.graphRoot, transactionId, transactionDigest }),
      (error) => error?.code === "SCHEMA001",
    );
    assert.equal(await readFile(target, "utf8"), "before\n");

    await writeFile(paths.active, "{not-json");
    await assert.rejects(
      prepareFileTransaction({
        graphRoot: environment.graphRoot,
        transactionId: "blocked-by-corrupt-marker",
        transactionDigest: sha("blocked"),
        changes: [{ kind: "create", path: "knowledge/other.md", after: Buffer.from("other\n") }],
      }),
      (error) => error?.code === "WRITE006",
    );
    await missing(join(environment.graphRoot, "knowledge", "other.md"));
  } finally {
    await rm(environment.root, { recursive: true, force: true });
  }
});

test("input bounds and reserved paths fail before canonical mutation", async () => {
  const environment = await fixture();
  try {
    await assert.rejects(
      prepareFileTransaction({
        graphRoot: environment.graphRoot,
        transactionId: "oversized",
        transactionDigest: sha("oversized"),
        changes: [{
          kind: "create",
          path: "knowledge/huge.md",
          after: Buffer.alloc(FILE_TRANSACTION_POLICY.maximumFileBytes + 1),
        }],
      }),
      (error) => error?.code === "WRITE006",
    );
    for (const [index, path] of [
      ".git/config",
      ".obsidian/escape.md",
      ".syncora/escape.md",
      "node_modules/escape.md",
      ".claude/worktrees/escape.md",
      "archive/migrations/escape.md",
    ].entries()) {
      await assert.rejects(
        prepareFileTransaction({
          graphRoot: environment.graphRoot,
          transactionId: `reserved-${index}`,
          transactionDigest: sha(`reserved-${index}`),
          changes: [{ kind: "create", path, after: Buffer.from("bad\n") }],
        }),
        (error) => error?.code === "WRITE002",
      );
    }
    await assert.rejects(
      prepareFileTransaction({
        graphRoot: environment.graphRoot,
        transactionId: "portable-collision",
        transactionDigest: sha("collision"),
        changes: [
          { kind: "create", path: "knowledge/Foo.md", after: Buffer.from("one\n") },
          { kind: "create", path: "knowledge/foo.md", after: Buffer.from("two\n") },
        ],
      }),
      (error) => error?.code === "WRITE006",
    );
    await missing(join(environment.graphRoot, "knowledge", "huge.md"));
  } finally {
    await rm(environment.root, { recursive: true, force: true });
  }
});

test("a nested symlink or junction cannot redirect a transaction outside the graph", async (t) => {
  const environment = await fixture("syncora-file-transaction-link-");
  const outside = join(environment.root, "outside");
  const linked = join(environment.graphRoot, "knowledge", "linked");
  try {
    await mkdir(outside);
    try {
      await symlink(outside, linked, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (new Set(["EPERM", "EACCES", "ENOTSUP"]).has(error?.code)) {
        t.skip(`link creation unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    await assert.rejects(
      prepareFileTransaction({
        graphRoot: environment.graphRoot,
        transactionId: "link-escape",
        transactionDigest: sha("link-escape"),
        changes: [{ kind: "create", path: "knowledge/linked/pwn.md", after: Buffer.from("bad\n") }],
      }),
      (error) => error?.code === "WRITE002" || error?.code === "WRITE006",
    );
    await missing(join(outside, "pwn.md"));
  } finally {
    await rm(environment.root, { recursive: true, force: true });
  }
});
