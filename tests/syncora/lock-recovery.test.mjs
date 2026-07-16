import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";

import {
  CHECKPOINT_STATE_MAX_BYTES,
  readCheckpointState,
  resolveCheckpointStorage,
  withCheckpointLock,
} from "../../skills/syncora/scripts/lib/checkpoint-state.mjs";
import { withPatchLock } from "../../skills/syncora/scripts/lib/patch-lock.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function temporaryWorkspace(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

async function expectMissing(path) {
  await assert.rejects(access(path));
}

function staleRecord(kind) {
  if (kind === "checkpoint") {
    return {
      schemaVersion: 1,
      token: "00000000-0000-4000-8000-000000000001",
      pid: 2_147_483_647,
      acquiredAt: "2020-01-01T00:00:00.000Z",
    };
  }
  return {
    schemaVersion: 1,
    token: "00000000-0000-4000-8000-000000000001",
    pid: 2_147_483_647,
    createdAt: "2020-01-01T00:00:00.000Z",
  };
}

async function recoveryHarness(kind) {
  const workspace = await temporaryWorkspace(`syncora-${kind}-guard-`);
  const locksRoot = join(workspace, ".syncora", "locks");
  await mkdir(locksRoot, { recursive: true });

  if (kind === "checkpoint") {
    const storage = await resolveCheckpointStorage(workspace);
    return {
      workspace,
      lockPath: storage.lockPath,
      guardPath: storage.recoveryGuardPath,
      run(operation, hooks, timing = {}) {
        return withCheckpointLock(storage, operation, {
          timeoutMs: 2_000,
          pollMs: 2,
          staleMs: 1,
          ...timing,
          hooks,
        });
      },
      expectedCode: "LOCK002",
      unsafeCode: "LOCK001",
    };
  }

  return {
    workspace,
    lockPath: join(locksRoot, "agent-patcher.lock"),
    guardPath: join(locksRoot, "agent-patcher.lock.recovery"),
    run(operation, hooks, timing = {}) {
      return withPatchLock(workspace, operation, {
        timeoutMs: 2_000,
        pollMs: 2,
        staleMs: 1,
        ...timing,
        hooks,
      });
    },
    expectedCode: "PATCH005",
    unsafeCode: "PATCH005",
  };
}

for (const kind of ["checkpoint", "patch"]) {
  test(
    `${kind} recovery guard serializes two stale-lock recoverers around the replacement owner`,
    { timeout: 15_000 },
    async () => {
      const harness = await recoveryHarness(kind);
      try {
        await writeFile(
          harness.lockPath,
          `${JSON.stringify(staleRecord(kind))}\n`,
          "utf8",
        );
        await utimes(harness.lockPath, new Date(0), new Date(0));

        const staleRetireReached = deferred();
        const allowStaleRetire = deferred();
        const secondBlockedByGuard = deferred();
        const secondAcquiredGuard = deferred();
        const firstActionEntered = deferred();
        const allowFirstActionExit = deferred();
        let activeActions = 0;
        let maximumActiveActions = 0;
        let secondActionEntered = false;
        let secondStaleRetireAttempts = 0;
        const order = [];

        const first = harness.run(
          async () => {
            activeActions += 1;
            maximumActiveActions = Math.max(maximumActiveActions, activeActions);
            order.push("first-enter");
            firstActionEntered.resolve();
            try {
              await allowFirstActionExit.promise;
            } finally {
              order.push("first-exit");
              activeActions -= 1;
            }
          },
          {
            beforeStaleRetire() {
              staleRetireReached.resolve();
              return allowStaleRetire.promise;
            },
          },
        );

        await staleRetireReached.promise;
        const second = harness.run(
          async () => {
            secondActionEntered = true;
            activeActions += 1;
            maximumActiveActions = Math.max(maximumActiveActions, activeActions);
            order.push("second-enter");
            order.push("second-exit");
            activeActions -= 1;
          },
          {
            afterRecoveryGuardBlocked() {
              secondBlockedByGuard.resolve();
            },
            afterRecoveryGuardAcquired() {
              secondAcquiredGuard.resolve();
            },
            beforeStaleRetire() {
              secondStaleRetireAttempts += 1;
            },
          },
        );

        await secondBlockedByGuard.promise;
        assert.equal(secondActionEntered, false);
        allowStaleRetire.resolve();
        await firstActionEntered.promise;
        await secondAcquiredGuard.promise;

        const replacement = JSON.parse(
          (await readFile(harness.lockPath)).toString("utf8"),
        );
        assert.equal(replacement.pid, process.pid);
        assert.notEqual(replacement.token, staleRecord(kind).token);
        assert.equal(secondActionEntered, false);
        assert.equal(secondStaleRetireAttempts, 0);
        assert.equal(activeActions, 1);

        allowFirstActionExit.resolve();
        await Promise.all([first, second]);
        assert.equal(maximumActiveActions, 1);
        assert.deepEqual(order, [
          "first-enter",
          "first-exit",
          "second-enter",
          "second-exit",
        ]);
        await expectMissing(harness.lockPath);
        await expectMissing(harness.guardPath);
      } finally {
        await rm(harness.workspace, { recursive: true, force: true });
      }
    },
  );

  test(`${kind} orphaned recovery guard fails closed with an actionable diagnostic`, async () => {
    const harness = await recoveryHarness(kind);
    let actionEntered = false;
    try {
      await writeFile(
        harness.guardPath,
        `${JSON.stringify({
          schemaVersion: 1,
          token: "00000000-0000-4000-8000-000000000002",
          pid: process.pid,
          createdAt: new Date().toISOString(),
        })}\n`,
        "utf8",
      );
      await assert.rejects(
        harness.run(
          async () => {
            actionEntered = true;
          },
          {},
          { timeoutMs: 20, pollMs: 2 },
        ),
        (error) =>
          error?.code === harness.expectedCode &&
          /recovery guard.*never recovered automatically/i.test(error.message),
      );
      assert.equal(actionEntered, false);
      await expectMissing(harness.lockPath);
    } finally {
      await rm(harness.workspace, { recursive: true, force: true });
    }
  });

  test(`${kind} oversized recovery guard fails closed before lock mutation`, async () => {
    const harness = await recoveryHarness(kind);
    let actionEntered = false;
    try {
      await writeFile(harness.guardPath, Buffer.alloc(4_097, 0x61));
      await assert.rejects(
        harness.run(
          async () => {
            actionEntered = true;
          },
          {},
          { timeoutMs: 20, pollMs: 2 },
        ),
        (error) => error?.code === harness.unsafeCode,
      );
      assert.equal(actionEntered, false);
      await expectMissing(harness.lockPath);
    } finally {
      await rm(harness.workspace, { recursive: true, force: true });
    }
  });
}

test("patch lock timeout remains bounded when the wall clock moves backward", async () => {
  const workspace = await temporaryWorkspace("syncora-patch-monotonic-");
  const locksRoot = join(workspace, ".syncora", "locks");
  const lockPath = join(locksRoot, "agent-patcher.lock");
  const guardPath = `${lockPath}.recovery`;
  const originalDateNow = Date.now;
  try {
    await mkdir(locksRoot, { recursive: true });
    await writeFile(
      guardPath,
      `${JSON.stringify({
        schemaVersion: 1,
        token: "00000000-0000-4000-8000-000000000003",
        pid: process.pid,
        createdAt: new Date().toISOString(),
      })}\n`,
      "utf8",
    );

    const baseline = originalDateNow();
    let calls = 0;
    Date.now = () => {
      calls += 1;
      if (calls <= 500) return baseline - calls * 60_000;
      return baseline + 60_000;
    };

    const started = performance.now();
    await assert.rejects(
      withPatchLock(workspace, async () => undefined, {
        timeoutMs: 25,
        pollMs: 2,
        staleMs: 1,
      }),
      (error) =>
        error?.code === "PATCH005" &&
        /recovery guard.*never recovered automatically/i.test(error.message),
    );
    const elapsed = performance.now() - started;

    assert.ok(
      elapsed < 500,
      `monotonic timeout should not follow a reversed wall clock (elapsed ${elapsed}ms)`,
    );
    assert.equal(calls, 0, "wait accounting must not consult the wall clock");
    await access(guardPath);
    await expectMissing(lockPath);
  } finally {
    Date.now = originalDateNow;
    await rm(workspace, { recursive: true, force: true });
  }
});

test("patch lock persisted timestamps remain wall-clock timestamps", async () => {
  const workspace = await temporaryWorkspace("syncora-patch-wall-clock-");
  const lockPath = join(workspace, ".syncora", "locks", "agent-patcher.lock");
  const originalDateNow = Date.now;
  const wallClockMs = Date.parse("2031-02-03T04:05:06.789Z");
  try {
    Date.now = () => wallClockMs;
    await withPatchLock(
      workspace,
      async () => {
        const record = JSON.parse(await readFile(lockPath, "utf8"));
        assert.equal(record.createdAt, new Date(wallClockMs).toISOString());
      },
      { timeoutMs: 250, pollMs: 2, staleMs: 1 },
    );
    await expectMissing(lockPath);
  } finally {
    Date.now = originalDateNow;
    await rm(workspace, { recursive: true, force: true });
  }
});

test("oversized regular checkpoint state is rebuilt without reading its contents", async () => {
  const workspace = await temporaryWorkspace("syncora-checkpoint-state-bounded-");
  try {
    await mkdir(join(workspace, ".syncora", "locks"), { recursive: true });
    const storage = await resolveCheckpointStorage(workspace);
    await writeFile(
      storage.statePath,
      Buffer.alloc(CHECKPOINT_STATE_MAX_BYTES + 1, 0x61),
    );
    assert.deepEqual(await readCheckpointState(storage), {
      condition: "corrupt",
      state: null,
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
