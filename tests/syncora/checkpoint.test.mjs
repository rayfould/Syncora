import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  checkpointWorkspace,
  resolveCheckpointEnvironment,
} from "../../skills/syncora/scripts/lib/checkpoint.mjs";
import {
  CHECKPOINT_STATE_MAX_BYTES,
  CHECKPOINT_STATE_SCHEMA_VERSION,
  createCheckpointState,
  withCheckpointLock,
  writeCheckpointState,
} from "../../skills/syncora/scripts/lib/checkpoint-state.mjs";

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

function run(args, expectedStatus = 0) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
  assert.equal(
    result.status,
    expectedStatus,
    `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result;
}

async function temporaryWorkspace(prefix = "syncora-checkpoint-") {
  return mkdtemp(join(tmpdir(), prefix));
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function initialize(workspace, extra = []) {
  return JSON.parse(
    run([
      "init",
      "--workspace",
      workspace,
      "--no-patch-agents",
      ...extra,
      "--format",
      "json",
    ]).stdout,
  );
}

function preOptions(workspace, profile = "context", extra = {}) {
  return {
    workspace,
    phase: "pre",
    profile,
    force: false,
    allowExternalGraphRoot: undefined,
    ...extra,
  };
}

function postOptions(workspace, checkpointId, extra = {}) {
  return {
    workspace,
    phase: "post",
    checkpointId,
    force: false,
    allowExternalGraphRoot: undefined,
    ...extra,
  };
}

async function readState(workspace) {
  return JSON.parse(
    await readFile(join(workspace, ".syncora", "checkpoint-state.json"), "utf8"),
  );
}

async function updateConfig(workspace, mutate) {
  const path = join(workspace, ".syncora", "config.json");
  const config = JSON.parse(await readFile(path, "utf8"));
  mutate(config);
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

async function markdownManifest(root) {
  const entries = [];
  async function walk(path) {
    const children = await readdir(path, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const child of children) {
      const full = join(path, child.name);
      if (child.isDirectory() && !child.isSymbolicLink()) {
        await walk(full);
      } else if (child.isFile() && child.name.toLowerCase().endsWith(".md")) {
        const bytes = await readFile(full);
        entries.push({
          path: relative(root, full).replaceAll("\\", "/"),
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
      }
    }
  }
  await walk(root);
  return entries;
}

test("checkpoint CLI enforces phase-specific profiles, IDs, and force", async () => {
  const workspace = await temporaryWorkspace();
  try {
    initialize(workspace);
    assert.match(
      run([
        "checkpoint",
        "--phase",
        "pre",
        "--profile",
        "none",
        "--workspace",
        workspace,
      ], 1).stderr,
      /CLI004/,
    );
    assert.match(
      run(["checkpoint", "--phase", "pre", "--workspace", workspace], 1).stderr,
      /CLI004/,
    );
    assert.match(
      run(["checkpoint", "--phase", "post", "--workspace", workspace], 1).stderr,
      /CLI002/,
    );
    assert.match(
      run([
        "checkpoint",
        "--phase",
        "post",
        "--profile",
        "capture",
        "--checkpoint-id",
        "not-an-id",
        "--workspace",
        workspace,
      ], 1).stderr,
      /CLI005/,
    );
    assert.match(
      run([
        "checkpoint",
        "--phase",
        "post",
        "--checkpoint-id",
        "not-an-id",
        "--force",
        "--workspace",
        workspace,
      ], 1).stderr,
      /CLI005/,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("uninitialized checkpointing fails without creating partial runtime state", async () => {
  const emptyWorkspace = await temporaryWorkspace();
  const partialWorkspace = await temporaryWorkspace();
  try {
    await assert.rejects(
      checkpointWorkspace(preOptions(emptyWorkspace, "checkpoint")),
      (error) => error?.code === "CONFIG001",
    );
    await assert.rejects(access(join(emptyWorkspace, ".syncora")));

    await mkdir(join(partialWorkspace, ".syncora"));
    await assert.rejects(
      checkpointWorkspace(preOptions(partialWorkspace, "checkpoint")),
      (error) => error?.code === "CONFIG001",
    );
    await assert.rejects(access(join(partialWorkspace, ".syncora", "locks")));
    await assert.rejects(
      access(join(partialWorkspace, ".syncora", "checkpoint-state.json")),
    );
  } finally {
    await rm(emptyWorkspace, { recursive: true, force: true });
    await rm(partialWorkspace, { recursive: true, force: true });
  }
});

test("preflight creates separate bounded state, reuses a stable stamp, and never mutates Markdown", async () => {
  const workspace = await temporaryWorkspace();
  try {
    initialize(workspace);
    const graph = join(workspace, "local");
    const before = await markdownManifest(graph);
    const first = await checkpointWorkspace(preOptions(workspace));
    const second = await checkpointWorkspace(preOptions(workspace, "checkpoint"));

    assert.equal(first.checkpoint.sequence, 1);
    assert.equal(first.validation.mode, "full");
    assert.deepEqual(first.validation.reasons, ["first_run"]);
    assert.equal(second.checkpoint.sequence, 2);
    assert.equal(second.validation.mode, "reused");
    assert.deepEqual(second.validation.reasons, []);
    assert.notEqual(first.checkpoint.id, second.checkpoint.id);
    assert.deepEqual(await markdownManifest(graph), before);

    const statePath = join(workspace, ".syncora", "checkpoint-state.json");
    const stateBytes = await readFile(statePath);
    assert.ok(stateBytes.length <= CHECKPOINT_STATE_MAX_BYTES);
    const state = JSON.parse(stateBytes.toString("utf8"));
    assert.equal(state.activationSequence, 2);
    assert.equal(state.pending.length, 2);
    assert.ok(state.validationStamp);
    assert.match(
      await readFile(join(workspace, ".syncora", ".gitignore"), "utf8"),
      /^checkpoint-state\.json$/m,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("exact graph fingerprints detect same-size edits even when mtime is restored", async () => {
  const workspace = await temporaryWorkspace();
  try {
    initialize(workspace);
    await checkpointWorkspace(preOptions(workspace));
    const notePath = join(workspace, "local", "knowledge", "projects", "workspace.md");
    const original = await readFile(notePath, "utf8");
    const metadata = await lstat(notePath);
    const marker = original.indexOf("summary:");
    assert.ok(marker >= 0);
    const changed = `${original.slice(0, marker)}X${original.slice(marker + 1)}`;
    assert.equal(Buffer.byteLength(changed), Buffer.byteLength(original));
    await writeFile(notePath, changed, "utf8");
    await utimes(notePath, metadata.atime, metadata.mtime);

    const result = await checkpointWorkspace(preOptions(workspace));
    assert.equal(result.validation.mode, "full");
    assert.ok(result.validation.reasons.includes("graph_changed"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("metadata change detection covers add, rename, delete, touch, and inode replacement", async () => {
  const workspace = await temporaryWorkspace();
  try {
    initialize(workspace);
    const graph = join(workspace, "local");
    const source = join(graph, "knowledge", "concepts", "metadata-source.md");
    const renamed = join(graph, "knowledge", "concepts", "metadata-renamed.md");
    await checkpointWorkspace(preOptions(workspace));

    await writeFile(source, "# Metadata source\n", "utf8");
    const added = await checkpointWorkspace(preOptions(workspace));
    assert.equal(added.validation.mode, "full");
    assert.ok(added.validation.reasons.includes("graph_changed"));

    await rename(source, renamed);
    const moved = await checkpointWorkspace(preOptions(workspace));
    assert.equal(moved.validation.mode, "full");
    assert.ok(moved.validation.reasons.includes("graph_changed"));

    const beforeTouch = await lstat(renamed);
    await utimes(renamed, beforeTouch.atime, new Date(beforeTouch.mtimeMs + 2_000));
    const touched = await checkpointWorkspace(preOptions(workspace));
    assert.equal(touched.validation.mode, "full");
    assert.ok(touched.validation.reasons.includes("graph_changed"));

    const replacement = `${renamed}.replacement`;
    const original = `${renamed}.original`;
    const bytes = await readFile(renamed);
    const beforeReplace = await lstat(renamed);
    await writeFile(replacement, bytes);
    await utimes(replacement, beforeReplace.atime, beforeReplace.mtime);
    await rename(renamed, original);
    await rename(replacement, renamed);
    await rm(original, { force: true });
    const replaced = await checkpointWorkspace(preOptions(workspace));
    assert.equal(replaced.validation.mode, "full");
    assert.ok(replaced.validation.reasons.includes("graph_changed"));

    await rm(renamed, { force: true });
    const removed = await checkpointWorkspace(preOptions(workspace));
    assert.equal(removed.validation.mode, "full");
    assert.ok(removed.validation.reasons.includes("graph_changed"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("publication metadata CAS retries a late graph change before advancing sequence", async () => {
  const workspace = await temporaryWorkspace();
  try {
    initialize(workspace);
    const note = join(workspace, "local", "knowledge", "concepts", "late-cas.md");
    let changed = false;
    let fullValidations = 0;
    const result = await checkpointWorkspace(preOptions(workspace), {
      beforeFullValidation: () => {
        fullValidations += 1;
      },
      beforePublicationCas: async ({ phase }) => {
        if (phase === "pre" && !changed) {
          changed = true;
          await writeFile(note, "# Late publication change\n", "utf8");
        }
      },
    });

    assert.equal(changed, true);
    assert.equal(result.checkpoint.sequence, 1);
    assert.equal(result.validation.mode, "full");
    assert.equal(fullValidations, 2);
    const state = await readState(workspace);
    assert.equal(state.activationSequence, 1);
    assert.equal(state.pending.length, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("publication CAS retries a config change after metadata capture", async () => {
  const workspace = await temporaryWorkspace();
  try {
    initialize(workspace);
    let changed = false;
    let fullValidations = 0;
    const result = await checkpointWorkspace(preOptions(workspace), {
      beforeFullValidation: () => {
        fullValidations += 1;
      },
      afterPublicationMetadataCapture: async ({ phase }) => {
        if (phase === "pre" && !changed) {
          changed = true;
          await updateConfig(workspace, (config) => {
            config.maintenance.fullValidationEveryActivations = 51;
          });
        }
      },
    });

    assert.equal(changed, true);
    assert.equal(result.checkpoint.sequence, 1);
    assert.equal(result.validation.mode, "full");
    assert.equal(fullValidations, 2);
    const state = await readState(workspace);
    assert.equal(state.activationSequence, 1);
    assert.equal(state.pending.length, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("publication CAS retries a graph change after its first metadata capture", async () => {
  const workspace = await temporaryWorkspace();
  try {
    initialize(workspace);
    const note = join(workspace, "local", "knowledge", "concepts", "cas-window.md");
    let changed = false;
    let fullValidations = 0;
    const result = await checkpointWorkspace(preOptions(workspace), {
      beforeFullValidation: () => {
        fullValidations += 1;
      },
      afterPublicationMetadataCapture: async ({ phase }) => {
        if (phase === "pre" && !changed) {
          changed = true;
          await writeFile(note, "# Changed inside publication CAS\n", "utf8");
        }
      },
    });

    assert.equal(changed, true);
    assert.equal(result.checkpoint.sequence, 1);
    assert.equal(result.validation.mode, "full");
    assert.equal(fullValidations, 2);
    const state = await readState(workspace);
    assert.equal(state.activationSequence, 1);
    assert.equal(state.pending.length, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("perpetual publication races fail without advancing activation cadence", async () => {
  const workspace = await temporaryWorkspace();
  try {
    initialize(workspace);
    const note = join(workspace, "local", "knowledge", "concepts", "unstable-cas.md");
    let revision = 0;
    await assert.rejects(
      checkpointWorkspace(preOptions(workspace), {
        beforePublicationCas: async ({ phase }) => {
          if (phase === "pre") {
            revision += 1;
            await writeFile(note, `# Unstable ${revision}\n`, "utf8");
          }
        },
      }),
      (error) => error?.code === "CHECKPOINT009",
    );
    const state = await readState(workspace);
    assert.equal(state.activationSequence, 0);
    assert.equal(state.pending.length, 0);
    assert.equal(state.inFlight.length, 0);
    assert.equal(state.lastIncomplete.code, "CHECKPOINT009");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("ten-thousand-note reuse remains metadata-only and bounded", async () => {
  const workspace = await temporaryWorkspace("syncora-checkpoint-corpus-");
  try {
    initialize(workspace);
    const corpus = join(workspace, "local", "knowledge", "sessions", "checkpoint-corpus");
    await mkdir(corpus, { recursive: true });
    const count = 10_000;
    for (let offset = 0; offset < count; offset += 200) {
      await Promise.all(
        Array.from({ length: Math.min(200, count - offset) }, (_, index) => {
          const number = offset + index;
          return writeFile(
            join(corpus, `note-${String(number).padStart(5, "0")}.md`),
            `# Corpus note ${number}\n`,
            "utf8",
          );
        }),
      );
    }

    let fullValidations = 0;
    const hooks = {
      beforeFullValidation: () => {
        fullValidations += 1;
      },
    };
    const firstStarted = performance.now();
    const first = await checkpointWorkspace(preOptions(workspace), hooks);
    const firstDuration = performance.now() - firstStarted;
    const reuseStarted = performance.now();
    const reused = await checkpointWorkspace(preOptions(workspace), hooks);
    const reuseDuration = performance.now() - reuseStarted;

    assert.equal(first.validation.mode, "full");
    assert.equal(reused.validation.mode, "reused");
    assert.equal(fullValidations, 1);
    assert.ok(reuseDuration < 15_000, `metadata reuse took ${reuseDuration}ms`);
    assert.ok(
      reuseDuration < firstDuration,
      `metadata reuse ${reuseDuration}ms was not faster than full validation ${firstDuration}ms`,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("hybrid cadence validates at the exact successful-activation threshold and on force", async () => {
  const workspace = await temporaryWorkspace();
  try {
    initialize(workspace);
    await updateConfig(workspace, (config) => {
      config.maintenance.fullValidationEveryActivations = 2;
    });
    const first = await checkpointWorkspace(preOptions(workspace));
    const second = await checkpointWorkspace(preOptions(workspace));
    const third = await checkpointWorkspace(preOptions(workspace));
    const fourth = await checkpointWorkspace(preOptions(workspace, "maintenance"));
    const forced = await checkpointWorkspace(preOptions(workspace, "checkpoint", { force: true }));

    assert.equal(first.validation.mode, "full");
    assert.equal(second.validation.mode, "reused");
    assert.equal(third.validation.mode, "full");
    assert.ok(third.validation.reasons.includes("activation_cadence"));
    assert.equal(fourth.validation.mode, "reused");
    assert.equal(forced.validation.mode, "full");
    assert.ok(forced.validation.reasons.includes("force"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("maximum age and clock reversal are deterministic validation triggers", async () => {
  const workspace = await temporaryWorkspace();
  try {
    initialize(workspace);
    const start = "2026-01-01T00:00:00.000Z";
    const first = await checkpointWorkspace(preOptions(workspace), { now: start });
    const beforeAge = await checkpointWorkspace(preOptions(workspace), {
      now: "2026-01-07T23:59:59.000Z",
    });
    const atAge = await checkpointWorkspace(preOptions(workspace), {
      now: "2026-01-08T00:00:00.000Z",
    });
    const reversed = await checkpointWorkspace(preOptions(workspace), {
      now: "2025-12-31T23:59:59.000Z",
    });

    assert.equal(first.validation.mode, "full");
    assert.equal(beforeAge.validation.mode, "reused");
    assert.equal(atAge.validation.mode, "full");
    assert.ok(atAge.validation.reasons.includes("max_age"));
    assert.equal(reversed.validation.mode, "full");
    assert.ok(reversed.validation.reasons.includes("clock_reversal"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a live reservation with a future timestamp survives concurrent pruning", async () => {
  const workspace = await temporaryWorkspace();
  try {
    initialize(workspace);
    await checkpointWorkspace(preOptions(workspace), {
      now: "2026-01-01T00:00:00.000Z",
    });
    const statePath = join(workspace, ".syncora", "checkpoint-state.json");
    const state = await readState(workspace);
    const futureOperationId = "00000000-0000-4000-8000-000000000001";
    state.inFlight.push({
      operationId: futureOperationId,
      phase: "pre",
      checkpointId: null,
      recovery: null,
      startedAt: "2026-01-02T00:00:00.000Z",
      pid: process.pid,
    });
    await writeFile(statePath, `${JSON.stringify(state)}\n`, "utf8");

    const result = await checkpointWorkspace(preOptions(workspace), {
      now: "2026-01-01T01:00:00.000Z",
    });
    assert.equal(result.checkpoint.sequence, 2);
    const after = await readState(workspace);
    assert.ok(
      after.inFlight.some((item) => item.operationId === futureOperationId),
      "clock reversal must not prune a reservation owned by a live process",
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("ordinary corrupt derived state rebuilds, while a future state schema fails closed", async () => {
  const workspace = await temporaryWorkspace();
  try {
    initialize(workspace);
    await checkpointWorkspace(preOptions(workspace));
    const statePath = join(workspace, ".syncora", "checkpoint-state.json");
    await writeFile(statePath, "{broken", "utf8");
    const recovered = await checkpointWorkspace(preOptions(workspace));
    assert.equal(recovered.state.condition, "corrupt");
    assert.equal(recovered.checkpoint.sequence, 1);
    assert.ok(recovered.validation.reasons.includes("state_corrupt"));

    await writeFile(
      statePath,
      `${JSON.stringify({ schemaVersion: CHECKPOINT_STATE_SCHEMA_VERSION - 1 })}\n`,
      "utf8",
    );
    const upgraded = await checkpointWorkspace(preOptions(workspace));
    assert.equal(upgraded.state.condition, "legacy");
    assert.ok(upgraded.validation.reasons.includes("state_legacy"));

    const futureState = `${JSON.stringify({
      schemaVersion: CHECKPOINT_STATE_SCHEMA_VERSION + 1,
    })}\n`;
    await writeFile(statePath, futureState, "utf8");
    await assert.rejects(
      checkpointWorkspace(preOptions(workspace)),
      (error) => error?.code === "SCHEMA001",
    );
    assert.equal(await readFile(statePath, "utf8"), futureState);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("an oversized regular checkpoint state rebuilds without reading its body", async () => {
  const workspace = await temporaryWorkspace();
  try {
    initialize(workspace);
    await checkpointWorkspace(preOptions(workspace));
    const statePath = join(workspace, ".syncora", "checkpoint-state.json");
    await writeFile(statePath, Buffer.alloc(CHECKPOINT_STATE_MAX_BYTES + 1, 0x78));

    const recovered = await checkpointWorkspace(preOptions(workspace));
    assert.equal(recovered.state.condition, "corrupt");
    assert.equal(recovered.checkpoint.sequence, 1);
    assert.ok(recovered.validation.reasons.includes("state_corrupt"));
    assert.ok((await readFile(statePath)).length <= CHECKPOINT_STATE_MAX_BYTES);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("checkpoint recovery guard serializes two stale recoverers around the new owner", async () => {
  const workspace = await temporaryWorkspace();
  try {
    initialize(workspace);
    const environment = await resolveCheckpointEnvironment(preOptions(workspace));
    const lockPath = environment.storage.lockPath;
    await writeFile(
      lockPath,
      `${JSON.stringify({
        schemaVersion: 1,
        token: "00000000-0000-4000-8000-000000000011",
        pid: 2_147_483_647,
        acquiredAt: "2000-01-01T00:00:00.000Z",
      })}\n`,
      "utf8",
    );
    const old = new Date("2000-01-01T00:00:00.000Z");
    await utimes(lockPath, old, old);

    const guardHeld = deferred();
    const releaseGuard = deferred();
    const firstEntered = deferred();
    const releaseFirst = deferred();
    const secondBlocked = deferred();
    let pauseFirstGuard = true;
    let secondEntered = false;
    const policy = { timeoutMs: 5_000, pollMs: 5, staleMs: 1 };

    const first = withCheckpointLock(
      environment.storage,
      async () => {
        firstEntered.resolve();
        await releaseFirst.promise;
      },
      {
        ...policy,
        hooks: {
          afterRecoveryGuardAcquired: async () => {
            if (!pauseFirstGuard) return;
            pauseFirstGuard = false;
            guardHeld.resolve();
            await releaseGuard.promise;
          },
        },
      },
    );
    await guardHeld.promise;
    const second = withCheckpointLock(
      environment.storage,
      async () => {
        secondEntered = true;
      },
      {
        ...policy,
        hooks: {
          afterRecoveryGuardBlocked: () => secondBlocked.resolve(),
        },
      },
    );
    await secondBlocked.promise;
    assert.equal(secondEntered, false);
    releaseGuard.resolve();
    await firstEntered.promise;
    await delay(75);
    assert.equal(secondEntered, false, "the second recoverer must not retire the live owner");
    releaseFirst.resolve();
    await Promise.all([first, second]);
    assert.equal(secondEntered, true);
    await assert.rejects(access(lockPath));
    await assert.rejects(access(`${lockPath}.recovery`));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("an orphaned checkpoint recovery guard fails closed with bounded wait", async () => {
  const workspace = await temporaryWorkspace();
  try {
    initialize(workspace);
    const environment = await resolveCheckpointEnvironment(preOptions(workspace));
    const guardPath = `${environment.storage.lockPath}.recovery`;
    await writeFile(
      guardPath,
      `${JSON.stringify({
        schemaVersion: 1,
        token: "00000000-0000-4000-8000-000000000012",
        pid: process.pid,
        createdAt: new Date().toISOString(),
      })}\n`,
      "utf8",
    );

    await assert.rejects(
      withCheckpointLock(environment.storage, async () => undefined, {
        timeoutMs: 50,
        pollMs: 5,
        staleMs: 1,
      }),
      (error) =>
        error?.code === "LOCK002" &&
        /never recovered automatically/i.test(error.message),
    );
    await access(guardPath);
    await assert.rejects(access(environment.storage.lockPath));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("checkpoint storage rejects a stable runtime-root retarget before writing", async (t) => {
  const workspace = await temporaryWorkspace();
  const external = await temporaryWorkspace("syncora-checkpoint-retarget-");
  const runtimePath = join(workspace, ".syncora");
  const originalPath = join(workspace, ".syncora-original");
  let replaced = false;
  try {
    initialize(workspace);
    const environment = await resolveCheckpointEnvironment(preOptions(workspace));
    await rename(runtimePath, originalPath);
    try {
      await symlink(external, runtimePath, process.platform === "win32" ? "junction" : "dir");
      replaced = true;
    } catch (error) {
      await rename(originalPath, runtimePath);
      t.skip(`Symbolic links unavailable: ${error.message}`);
      return;
    }

    await assert.rejects(
      writeCheckpointState(environment.storage, createCheckpointState(environment)),
      (error) => error?.code === "STATE001",
    );
    await assert.rejects(
      withCheckpointLock(environment.storage, async () => undefined, {
        timeoutMs: 50,
        pollMs: 5,
      }),
      (error) => ["STATE001", "LOCK001"].includes(error?.code),
    );
    await assert.rejects(access(join(external, "checkpoint-state.json")));
    await assert.rejects(access(join(external, "locks", "checkpoint.lock")));
    await assert.rejects(access(join(external, "locks", "checkpoint.lock.recovery")));
  } finally {
    if (replaced) {
      await rm(runtimePath, { recursive: true, force: true }).catch(() => undefined);
      await rename(originalPath, runtimePath).catch(() => undefined);
    }
    await rm(workspace, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

test("checkpoint lock rejects a stable lock-directory retarget before writing", async (t) => {
  const workspace = await temporaryWorkspace();
  const external = await temporaryWorkspace("syncora-lock-retarget-");
  let replaced = false;
  try {
    initialize(workspace);
    const environment = await resolveCheckpointEnvironment(preOptions(workspace));
    const locksPath = environment.storage.locksRoot;
    const originalPath = `${locksPath}-original`;
    await rename(locksPath, originalPath);
    try {
      await symlink(external, locksPath, process.platform === "win32" ? "junction" : "dir");
      replaced = true;
    } catch (error) {
      await rename(originalPath, locksPath);
      t.skip(`Symbolic links unavailable: ${error.message}`);
      return;
    }

    await assert.rejects(
      withCheckpointLock(environment.storage, async () => undefined, {
        timeoutMs: 50,
        pollMs: 5,
      }),
      (error) => error?.code === "LOCK001",
    );
    await assert.rejects(access(join(external, "checkpoint.lock")));
    await assert.rejects(access(join(external, "checkpoint.lock.recovery")));

    await rm(locksPath, { recursive: true, force: true });
    await rename(originalPath, locksPath);
    replaced = false;
  } finally {
    if (replaced) {
      const locksPath = join(workspace, ".syncora", "locks");
      await rm(locksPath, { recursive: true, force: true }).catch(() => undefined);
      await rename(`${locksPath}-original`, locksPath).catch(() => undefined);
    }
    await rm(workspace, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

test("doctor reports compatible, rebuildable, and future checkpoint state without mutating it", async () => {
  const workspace = await temporaryWorkspace();
  try {
    initialize(workspace);
    await checkpointWorkspace(preOptions(workspace));
    const statePath = join(workspace, ".syncora", "checkpoint-state.json");
    const before = await readFile(statePath);
    const healthy = JSON.parse(
      run(["doctor", "--workspace", workspace, "--format", "json"]).stdout,
    );
    assert.ok(
      healthy.checks.some(
        (item) => item.code === "CHECKPOINT001" && item.status === "ok",
      ),
    );
    assert.deepEqual(await readFile(statePath), before);

    await writeFile(statePath, "{broken", "utf8");
    const corrupt = JSON.parse(
      run(["doctor", "--workspace", workspace, "--format", "json"]).stdout,
    );
    assert.equal(corrupt.ok, true);
    assert.ok(
      corrupt.checks.some(
        (item) => item.code === "CHECKPOINT001" && item.status === "warn",
      ),
    );
    assert.equal(await readFile(statePath, "utf8"), "{broken");

    await writeFile(
      statePath,
      `${JSON.stringify({ schemaVersion: CHECKPOINT_STATE_SCHEMA_VERSION - 1 })}\n`,
      "utf8",
    );
    const legacy = JSON.parse(
      run(["doctor", "--workspace", workspace, "--format", "json"]).stdout,
    );
    assert.equal(legacy.ok, true);
    assert.ok(
      legacy.checks.some(
        (item) => item.code === "CHECKPOINT001" && item.status === "warn",
      ),
    );

    const futureState = `${JSON.stringify({
      schemaVersion: CHECKPOINT_STATE_SCHEMA_VERSION + 1,
    })}\n`;
    await writeFile(statePath, futureState, "utf8");
    const future = JSON.parse(
      run(["doctor", "--workspace", workspace, "--format", "json"], 1).stdout,
    );
    assert.equal(future.ok, false);
    assert.ok(future.checks.some((item) => item.code === "SCHEMA001"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("completed degraded validation is stamped and reused without repeated full scans", async () => {
  const workspace = await temporaryWorkspace();
  try {
    initialize(workspace);
    await writeFile(join(workspace, "local", "broken.md"), Buffer.from([0]));
    const first = await checkpointWorkspace(preOptions(workspace));
    const second = await checkpointWorkspace(preOptions(workspace));
    assert.equal(first.ok, true);
    assert.equal(first.validation.status, "degraded");
    assert.equal(first.validation.mode, "full");
    assert.equal(second.ok, true);
    assert.equal(second.validation.status, "degraded");
    assert.equal(second.validation.mode, "reused");
    const state = await readState(workspace);
    assert.equal(state.validationStamp.graphValid, false);
    assert.equal(state.lastIncomplete, null);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("degraded checkpoint completion is a successful CLI command with an explicit invalid graph", async () => {
  const workspace = await temporaryWorkspace();
  try {
    initialize(workspace);
    await writeFile(join(workspace, "local", "broken.md"), Buffer.from([0]));
    const result = JSON.parse(
      run([
        "checkpoint",
        "--phase",
        "pre",
        "--profile",
        "context",
        "--workspace",
        workspace,
        "--format",
        "json",
      ]).stdout,
    );
    assert.equal(result.ok, true);
    assert.equal(result.validation.status, "degraded");
    assert.equal(result.validation.graphValid, false);
    assert.ok(result.validation.errors > 0);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("config, runtime, and validator-policy identity changes invalidate the reusable stamp", async () => {
  const workspace = await temporaryWorkspace();
  try {
    initialize(workspace);
    await checkpointWorkspace(preOptions(workspace));
    await updateConfig(workspace, (config) => {
      config.context.defaultBudget = "lean";
    });
    const configChanged = await checkpointWorkspace(preOptions(workspace));
    assert.ok(configChanged.validation.reasons.includes("config_changed"));

    const statePath = join(workspace, ".syncora", "checkpoint-state.json");
    const runtimeState = await readState(workspace);
    runtimeState.validationStamp.runtimeIdentity = `sha256:${"0".repeat(64)}`;
    await writeFile(statePath, `${JSON.stringify(runtimeState)}\n`, "utf8");
    const runtimeChanged = await checkpointWorkspace(preOptions(workspace));
    assert.ok(runtimeChanged.validation.reasons.includes("runtime_changed"));

    const policyState = await readState(workspace);
    policyState.validationStamp.validatorPolicyIdentity = `sha256:${"1".repeat(64)}`;
    await writeFile(statePath, `${JSON.stringify(policyState)}\n`, "utf8");
    const policyChanged = await checkpointWorkspace(preOptions(workspace));
    assert.ok(policyChanged.validation.reasons.includes("validator_policy_changed"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("postflight is ID-bound, validates durable changes, and is idempotent without incrementing", async () => {
  const workspace = await temporaryWorkspace();
  try {
    initialize(workspace);
    const pre = await checkpointWorkspace(preOptions(workspace, "context"));
    const notePath = join(workspace, "local", "knowledge", "projects", "workspace.md");
    await writeFile(notePath, `${await readFile(notePath, "utf8")}\nDurable update.\n`, "utf8");

    const post = await checkpointWorkspace(postOptions(workspace, pre.checkpoint.id));
    const retry = await checkpointWorkspace(postOptions(workspace, pre.checkpoint.id));
    const state = await readState(workspace);
    assert.equal(post.checkpoint.profile, "context");
    assert.equal(post.checkpoint.disposition, "durable-change");
    assert.equal(post.validation.mode, "full");
    assert.deepEqual(post.validation.reasons, ["post_durable_change"]);
    assert.equal(retry.checkpoint.profile, "context");
    assert.equal(retry.checkpoint.idempotent, true);
    assert.equal(retry.validation.mode, "reused");
    assert.equal(state.activationSequence, 1);
    assert.equal(state.pending.some((item) => item.id === pre.checkpoint.id), false);
    assert.equal(state.completed.some((item) => item.id === pre.checkpoint.id), true);

    const unknownId = `${pre.checkpoint.id.slice(0, -1)}${pre.checkpoint.id.endsWith("0") ? "1" : "0"}`;
    await assert.rejects(
      checkpointWorkspace(postOptions(workspace, unknownId)),
      (error) => ["CHECKPOINT006", "CHECKPOINT007"].includes(error?.code),
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("postflight proves an exact no-op without claiming a durable change", async () => {
  const workspace = await temporaryWorkspace();
  try {
    initialize(workspace);
    const pre = await checkpointWorkspace(preOptions(workspace, "capture"));
    const before = await readState(workspace);
    const pending = before.pending.find((item) => item.id === pre.checkpoint.id);
    assert.equal(
      pending.baselineSourceFingerprint,
      before.validationStamp.sourceFingerprint,
    );

    const post = await checkpointWorkspace(postOptions(workspace, pre.checkpoint.id));
    const retry = await checkpointWorkspace(postOptions(workspace, pre.checkpoint.id));
    const state = await readState(workspace);
    const completed = state.completed.find((item) => item.id === pre.checkpoint.id);

    assert.equal(post.checkpoint.disposition, "no-change");
    assert.equal(post.checkpoint.idempotent, false);
    assert.equal(post.validation.mode, "full");
    assert.deepEqual(post.validation.reasons, ["post_no_change"]);
    assert.equal(retry.checkpoint.disposition, "no-change");
    assert.equal(retry.checkpoint.idempotent, true);
    assert.deepEqual(retry.validation.reasons, ["idempotent_retry"]);
    assert.equal(completed.disposition, "no-change");
    assert.equal(completed.profile, "capture");
    assert.equal(completed.sourceFingerprint, pending.baselineSourceFingerprint);
    assert.equal(state.activationSequence, 1);
    assert.match(
      run([
        "checkpoint",
        "--phase",
        "post",
        "--checkpoint-id",
        pre.checkpoint.id,
        "--workspace",
        workspace,
      ]).stdout,
      /disposition=no-change.*idempotent=true/,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("postflight fails closed when exact drift cannot be attributed to this request", async () => {
  const workspace = await temporaryWorkspace();
  try {
    initialize(workspace);
    await checkpointWorkspace(preOptions(workspace, "checkpoint"));

    const statePath = join(workspace, ".syncora", "checkpoint-state.json");
    const stale = await readState(workspace);
    stale.validationStamp.sourceFingerprint = `sha256:${"0".repeat(64)}`;
    await writeFile(statePath, `${JSON.stringify(stale)}\n`, "utf8");

    const pre = await checkpointWorkspace(preOptions(workspace, "context"));
    assert.equal(pre.validation.mode, "reused");
    const post = await checkpointWorkspace(postOptions(workspace, pre.checkpoint.id));
    const retry = await checkpointWorkspace(postOptions(workspace, pre.checkpoint.id));
    const completed = (await readState(workspace)).completed.find(
      (item) => item.id === pre.checkpoint.id,
    );

    assert.equal(post.checkpoint.profile, "context");
    assert.equal(post.checkpoint.disposition, "unattributed-change");
    assert.deepEqual(post.validation.reasons, ["post_unattributed_change"]);
    assert.equal(retry.checkpoint.disposition, "unattributed-change");
    assert.equal(retry.checkpoint.idempotent, true);
    assert.equal(completed.profile, "context");
    assert.equal(completed.disposition, "unattributed-change");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("checkpoint IDs fail closed across workspaces and graph-root epochs", async () => {
  const firstWorkspace = await temporaryWorkspace();
  const secondWorkspace = await temporaryWorkspace();
  try {
    initialize(firstWorkspace);
    initialize(secondWorkspace);
    const first = await checkpointWorkspace(preOptions(firstWorkspace));
    await assert.rejects(
      checkpointWorkspace(postOptions(secondWorkspace, first.checkpoint.id)),
      (error) => error?.code === "CHECKPOINT005",
    );

    const statePath = join(firstWorkspace, ".syncora", "checkpoint-state.json");
    await writeFile(statePath, "{broken", "utf8");
    await checkpointWorkspace(preOptions(firstWorkspace));
    await assert.rejects(
      checkpointWorkspace(postOptions(firstWorkspace, first.checkpoint.id)),
      (error) => error?.code === "CHECKPOINT006",
    );
  } finally {
    await rm(firstWorkspace, { recursive: true, force: true });
    await rm(secondWorkspace, { recursive: true, force: true });
  }
});

test("parallel preflights publish unique monotonic sequences and concurrent post does not advance them", async () => {
  const workspace = await temporaryWorkspace();
  try {
    initialize(workspace);
    const [left, right] = await Promise.all([
      checkpointWorkspace(preOptions(workspace, "context")),
      checkpointWorkspace(preOptions(workspace, "checkpoint")),
    ]);
    assert.deepEqual(
      [left.checkpoint.sequence, right.checkpoint.sequence].sort((a, b) => a - b),
      [1, 2],
    );
    assert.notEqual(left.checkpoint.id, right.checkpoint.id);

    const [next, post] = await Promise.all([
      checkpointWorkspace(preOptions(workspace, "maintenance")),
      checkpointWorkspace(postOptions(workspace, left.checkpoint.id)),
    ]);
    assert.equal(next.checkpoint.sequence, 3);
    assert.equal(post.checkpoint.sequence, left.checkpoint.sequence);
    assert.equal((await readState(workspace)).activationSequence, 3);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("transient graph changes reject stable publication and leave sequence unadvanced", async () => {
  const workspace = await temporaryWorkspace();
  try {
    initialize(workspace);
    const notePath = join(workspace, "local", "knowledge", "projects", "workspace.md");
    let changed = false;
    await assert.rejects(
      checkpointWorkspace(preOptions(workspace), {
        afterFirstInspection: async () => {
          if (changed) return;
          changed = true;
          await writeFile(notePath, `${await readFile(notePath, "utf8")}\nChanged.\n`, "utf8");
        },
      }),
      (error) => error?.code === "READ001",
    );
    const failedState = await readState(workspace);
    assert.equal(failedState.activationSequence, 0);
    assert.equal(failedState.lastIncomplete.code, "READ001");
    const recovered = await checkpointWorkspace(preOptions(workspace));
    assert.equal(recovered.checkpoint.sequence, 1);
    assert.ok(recovered.validation.reasons.includes("previous_incomplete"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("lock contention is bounded and a dead stale owner is recovered", async () => {
  const workspace = await temporaryWorkspace();
  try {
    initialize(workspace);
    const environment = await resolveCheckpointEnvironment(preOptions(workspace));
    const lockPath = environment.storage.lockPath;
    await writeFile(
      lockPath,
      `${JSON.stringify({
        schemaVersion: 1,
        token: "live",
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
      })}\n`,
      "utf8",
    );
    await assert.rejects(
      checkpointWorkspace(preOptions(workspace), {
        lockPolicy: { timeoutMs: 20, pollMs: 2, staleMs: 60_000 },
      }),
      (error) => error?.code === "LOCK002",
    );
    await rm(lockPath, { force: true });

    await writeFile(
      lockPath,
      `${JSON.stringify({
        schemaVersion: 1,
        token: "dead",
        pid: 2_147_483_647,
        acquiredAt: "2020-01-01T00:00:00.000Z",
      })}\n`,
      "utf8",
    );
    await utimes(lockPath, new Date(0), new Date(0));
    const recovered = await checkpointWorkspace(preOptions(workspace), {
      lockPolicy: { timeoutMs: 100, pollMs: 2, staleMs: 1 },
    });
    assert.equal(recovered.checkpoint.sequence, 1);
    await assert.rejects(access(lockPath));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a hostile checkpoint-state symlink fails closed without touching its target", async (t) => {
  const workspace = await temporaryWorkspace();
  const targetRoot = await temporaryWorkspace("syncora-checkpoint-state-target-");
  const target = join(targetRoot, "target.json");
  const statePath = join(workspace, ".syncora", "checkpoint-state.json");
  try {
    initialize(workspace);
    await writeFile(target, "preserve-me\n", "utf8");
    try {
      await symlink(target, statePath, "file");
    } catch (error) {
      t.skip(`File symbolic links unavailable: ${error.message}`);
      return;
    }
    await assert.rejects(
      checkpointWorkspace(preOptions(workspace)),
      (error) => error?.code === "STATE001",
    );
    assert.equal(await readFile(target, "utf8"), "preserve-me\n");
  } finally {
    await rm(statePath, { force: true }).catch(() => undefined);
    await rm(workspace, { recursive: true, force: true });
    await rm(targetRoot, { recursive: true, force: true });
  }
});

test("malformed maintenance config fails visibly while missing maintenance uses defaults", async () => {
  const workspace = await temporaryWorkspace();
  try {
    initialize(workspace);
    await updateConfig(workspace, (config) => {
      delete config.maintenance;
    });
    const compatible = await checkpointWorkspace(preOptions(workspace));
    assert.equal(compatible.validation.mode, "full");

    await updateConfig(workspace, (config) => {
      config.maintenance = { fullValidationEveryActivation: 2 };
    });
    await assert.rejects(
      checkpointWorkspace(preOptions(workspace)),
      (error) => error?.code === "CONFIG001",
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("pending checkpoint retention and state bytes remain bounded", async () => {
  const workspace = await temporaryWorkspace();
  try {
    initialize(workspace);
    await updateConfig(workspace, (config) => {
      config.maintenance.fullValidationEveryActivations = 10_000;
    });
    let firstId;
    for (let index = 0; index < 70; index += 1) {
      const result = await checkpointWorkspace(preOptions(workspace));
      firstId ??= result.checkpoint.id;
    }
    const bytes = await readFile(join(workspace, ".syncora", "checkpoint-state.json"));
    const state = JSON.parse(bytes.toString("utf8"));
    assert.equal(state.activationSequence, 70);
    assert.equal(state.pending.length, 64);
    assert.ok(bytes.length <= CHECKPOINT_STATE_MAX_BYTES);
    await assert.rejects(
      checkpointWorkspace(postOptions(workspace, firstId)),
      (error) => error?.code === "CHECKPOINT007",
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("completed retention reserves worst-case pending capacity under concurrent preflight", async () => {
  const workspace = await temporaryWorkspace();
  try {
    initialize(workspace);
    await updateConfig(workspace, (config) => {
      config.maintenance.fullValidationEveryActivations = 10_000;
    });

    let latestCompletedId;
    for (let index = 0; index < 70; index += 1) {
      const pre = await checkpointWorkspace(preOptions(workspace, "capture"));
      await checkpointWorkspace(postOptions(workspace, pre.checkpoint.id));
      latestCompletedId = pre.checkpoint.id;
    }
    const completedOnly = await readState(workspace);
    assert.ok(completedOnly.completed.length > 0);
    assert.ok(completedOnly.completed.length < 64);
    assert.ok(completedOnly.completed.some((item) => item.id === latestCompletedId));

    for (let index = 0; index < 61; index += 1) {
      await checkpointWorkspace(preOptions(workspace));
    }
    const concurrent = await Promise.all(
      Array.from({ length: 4 }, () => checkpointWorkspace(preOptions(workspace))),
    );
    assert.deepEqual(
      concurrent.map((item) => item.checkpoint.sequence).sort((left, right) => left - right),
      [132, 133, 134, 135],
    );

    const mixedBytes = await readFile(join(workspace, ".syncora", "checkpoint-state.json"));
    const mixed = JSON.parse(mixedBytes.toString("utf8"));
    assert.equal(mixed.pending.length, 64);
    assert.ok(mixed.completed.length > 0);
    assert.ok(mixed.completed.some((item) => item.id === latestCompletedId));
    assert.ok(mixedBytes.length <= CHECKPOINT_STATE_MAX_BYTES);

    const retry = await checkpointWorkspace(postOptions(workspace, latestCompletedId));
    assert.equal(retry.checkpoint.idempotent, true);
    assert.equal(retry.checkpoint.disposition, "no-change");

    const next = await checkpointWorkspace(preOptions(workspace));
    const finalBytes = await readFile(join(workspace, ".syncora", "checkpoint-state.json"));
    const finalState = JSON.parse(finalBytes.toString("utf8"));
    assert.equal(next.checkpoint.sequence, 136);
    assert.equal(finalState.pending.length, 64);
    assert.ok(finalBytes.length <= CHECKPOINT_STATE_MAX_BYTES);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("external graph roots retain exact root binding and structural findings trigger validation", async (t) => {
  const workspace = await temporaryWorkspace();
  const external = await temporaryWorkspace("syncora-checkpoint-external-");
  const structuralTarget = await temporaryWorkspace("syncora-checkpoint-structural-");
  const graphLink = join(workspace, "local");
  let nestedLink = null;
  try {
    try {
      await symlink(external, graphLink, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      t.skip(`Symbolic links unavailable: ${error.message}`);
      return;
    }
    initialize(workspace, ["--allow-external-graph-root", external]);
    const first = await checkpointWorkspace(
      preOptions(workspace, "context", { allowExternalGraphRoot: external }),
    );
    assert.equal(first.graph.external, true);

    nestedLink = join(external, "nested-link");
    await symlink(
      structuralTarget,
      nestedLink,
      process.platform === "win32" ? "junction" : "dir",
    );
    const structural = await checkpointWorkspace(
      preOptions(workspace, "context", { allowExternalGraphRoot: external }),
    );
    assert.equal(structural.validation.mode, "full");
    assert.ok(structural.validation.reasons.includes("graph_changed"));
    assert.equal(structural.validation.status, "degraded");
  } finally {
    if (nestedLink) await rm(nestedLink, { force: true }).catch(() => undefined);
    await rm(graphLink, { force: true }).catch(() => undefined);
    await rm(workspace, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
    await rm(structuralTarget, { recursive: true, force: true });
  }
});

test("retargeting an external graph root forces validation and rejects the old root's checkpoint ID", async (t) => {
  const workspace = await temporaryWorkspace();
  const firstRoot = await temporaryWorkspace("syncora-checkpoint-root-a-");
  const secondRoot = await temporaryWorkspace("syncora-checkpoint-root-b-");
  const graphLink = join(workspace, "local");
  try {
    try {
      await symlink(firstRoot, graphLink, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      t.skip(`Symbolic links unavailable: ${error.message}`);
      return;
    }
    initialize(workspace, ["--allow-external-graph-root", firstRoot]);
    const first = await checkpointWorkspace(
      preOptions(workspace, "context", { allowExternalGraphRoot: firstRoot }),
    );

    await mkdir(join(secondRoot, "knowledge", "projects"), { recursive: true });
    await writeFile(
      join(secondRoot, "index.md"),
      await readFile(join(firstRoot, "index.md")),
    );
    await writeFile(
      join(secondRoot, "knowledge", "projects", "workspace.md"),
      await readFile(join(firstRoot, "knowledge", "projects", "workspace.md")),
    );
    await rm(graphLink, { force: true });
    await symlink(secondRoot, graphLink, process.platform === "win32" ? "junction" : "dir");

    const retargeted = await checkpointWorkspace(
      preOptions(workspace, "context", { allowExternalGraphRoot: secondRoot }),
    );
    assert.equal(retargeted.validation.mode, "full");
    assert.ok(retargeted.validation.reasons.includes("graph_root_changed"));
    await assert.rejects(
      checkpointWorkspace(
        postOptions(workspace, first.checkpoint.id, { allowExternalGraphRoot: secondRoot }),
      ),
      (error) => error?.code === "CHECKPOINT005",
    );
  } finally {
    await rm(graphLink, { force: true }).catch(() => undefined);
    await rm(workspace, { recursive: true, force: true });
    await rm(firstRoot, { recursive: true, force: true });
    await rm(secondRoot, { recursive: true, force: true });
  }
});
