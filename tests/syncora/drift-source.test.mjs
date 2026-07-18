import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DRIFT_SOURCE_POLICY,
  observeBoundSources,
} from "../../skills/syncora/scripts/lib/drift-source.mjs";
import { parseTargetSpecifier } from "../../skills/syncora/scripts/lib/target-bindings.mjs";

function binding(specifier) {
  const { kind, ref } = parseTargetSpecifier(specifier);
  return { specifier: `${kind}:${ref}`, kind, ref };
}

async function temporaryWorkspace(t) {
  const path = await mkdtemp(join(tmpdir(), "syncora-drift-source-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

function bySpecifier(observation, specifier) {
  return observation.bindings.find((item) => item.specifier === specifier);
}

test("raw-byte fingerprints are deterministic and excluded regions are never observed", async (t) => {
  assert.equal(Object.isFrozen(DRIFT_SOURCE_POLICY), true);
  const workspacePath = await temporaryWorkspace(t);
  const graphPath = join(workspacePath, "local");
  await Promise.all([
    mkdir(join(workspacePath, "src", "lib"), { recursive: true }),
    mkdir(graphPath, { recursive: true }),
    mkdir(join(workspacePath, ".git"), { recursive: true }),
    mkdir(join(workspacePath, ".syncora"), { recursive: true }),
    mkdir(join(workspacePath, "node_modules"), { recursive: true }),
    mkdir(join(workspacePath, ".claude", "worktrees"), { recursive: true }),
  ]);
  const raw = Buffer.from([0, 255, 1, 13, 10, 0, 128]);
  await Promise.all([
    writeFile(join(workspacePath, "src", "raw.bin"), raw),
    writeFile(join(workspacePath, "src", "app.ts"), "export const app = 1;\n"),
    writeFile(join(workspacePath, "src", "lib", "z.ts"), "export const z = 2;\n"),
    writeFile(join(graphPath, "note.ts"), "must stay out\n"),
    writeFile(join(workspacePath, "node_modules", "dep.ts"), "must stay out\n"),
    writeFile(join(workspacePath, ".syncora", "state.ts"), "must stay out\n"),
    writeFile(join(workspacePath, ".claude", "worktrees", "copy.ts"), "must stay out\n"),
  ]);

  const inputs = {
    workspacePath,
    graphPath,
    bindings: [
      binding("path_glob:**/*.ts"),
      binding("file:src/raw.bin"),
      binding("module:src/lib"),
    ],
  };
  const first = await observeBoundSources(inputs);
  const second = await observeBoundSources(inputs);

  assert.deepEqual(first.bindings, second.bindings);
  assert.deepEqual(first.coverage, second.coverage);
  assert.equal(first.authority, "raw_bytes_sha256");
  assert.equal(first.git.available, false);
  assert.deepEqual(first.bindings.map((item) => item.specifier), [
    "file:src/raw.bin",
    "module:src/lib",
    "path_glob:**/*.ts",
  ]);
  const rawObservation = bySpecifier(first, "file:src/raw.bin");
  assert.deepEqual(rawObservation.files, [{
    path: "src/raw.bin",
    bytes: raw.length,
    sha256: `sha256:${createHash("sha256").update(raw).digest("hex")}`,
  }]);
  assert.deepEqual(
    bySpecifier(first, "path_glob:**/*.ts").files.map((item) => item.path),
    ["src/app.ts", "src/lib/z.ts"],
  );
  assert.deepEqual(
    bySpecifier(first, "module:src/lib").files.map((item) => item.path),
    ["src/lib/z.ts"],
  );
  assert.ok(first.coverage.skippedDirectories.includes("local"));
  assert.ok(first.coverage.skippedDirectories.includes("node_modules"));
  assert.equal(first.coverage.totalBytesHashed > 0, true);

  await writeFile(join(workspacePath, "src", "raw.bin"), Buffer.from([0, 255, 2]));
  const changed = await observeBoundSources(inputs);
  assert.notEqual(
    bySpecifier(changed, "file:src/raw.bin").fingerprint,
    rawObservation.fingerprint,
  );
});

test("matching uses the task-context module and bounded glob dialect", async (t) => {
  const workspacePath = await temporaryWorkspace(t);
  await mkdir(join(workspacePath, "src", "auth", "deep"), { recursive: true });
  await Promise.all([
    writeFile(join(workspacePath, "src", "auth", "a.ts"), "a"),
    writeFile(join(workspacePath, "src", "auth", "a.js"), "a"),
    writeFile(join(workspacePath, "src", "auth", "deep", "b.ts"), "b"),
  ]);

  const result = await observeBoundSources({
    workspacePath,
    bindings: [binding("path_glob:src/?uth/*.ts"), binding("module:src/auth")],
  });
  assert.deepEqual(
    bySpecifier(result, "path_glob:src/?uth/*.ts").files.map((item) => item.path),
    ["src/auth/a.ts"],
  );
  assert.deepEqual(
    bySpecifier(result, "module:src/auth").files.map((item) => item.path),
    ["src/auth/a.js", "src/auth/a.ts", "src/auth/deep/b.ts"],
  );
});

test("unbound unsafe links are not traversed while covered links fail closed", async (t) => {
  const workspacePath = await temporaryWorkspace(t);
  const outsidePath = await temporaryWorkspace(t);
  await mkdir(join(workspacePath, "src"), { recursive: true });
  await mkdir(join(workspacePath, "unbound"), { recursive: true });
  await writeFile(join(workspacePath, "src", "safe.ts"), "safe\n");
  await writeFile(join(outsidePath, "secret.ts"), "secret\n");
  try {
    await symlink(
      outsidePath,
      join(workspacePath, "unbound", "outside"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await symlink(
      outsidePath,
      join(workspacePath, "src", "outside"),
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    if (["EPERM", "EACCES", "ENOSYS"].includes(error?.code)) {
      t.skip(`symbolic links unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  const exact = await observeBoundSources({
    workspacePath,
    bindings: [binding("file:src/safe.ts")],
  });
  assert.equal(exact.bindings[0].fileCount, 1);
  await assert.rejects(
    observeBoundSources({ workspacePath, bindings: [binding("module:src")] }),
    (error) => error?.code === "DRIFT_SOURCE_UNSAFE" && /symbolic link|junction/u.test(error.message),
  );
});

test("a resolved external graph junction is excluded rather than followed", async (t) => {
  const workspacePath = await temporaryWorkspace(t);
  const graphPath = await temporaryWorkspace(t);
  await writeFile(join(workspacePath, "source.ts"), "source\n");
  await writeFile(join(graphPath, "knowledge.ts"), "graph\n");
  try {
    await symlink(
      graphPath,
      join(workspacePath, "local"),
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    if (["EPERM", "EACCES", "ENOSYS"].includes(error?.code)) {
      t.skip(`symbolic links unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  const result = await observeBoundSources({
    workspacePath,
    graphPath,
    bindings: [binding("path_glob:**/*.ts")],
  });
  assert.deepEqual(result.bindings[0].files.map((item) => item.path), ["source.ts"]);
  assert.ok(result.coverage.skippedDirectories.includes("local"));
});

test("stable reads reject source mutation during hashing", async (t) => {
  const workspacePath = await temporaryWorkspace(t);
  await mkdir(join(workspacePath, "src"));
  const sourcePath = join(workspacePath, "src", "race.ts");
  await writeFile(sourcePath, "before\n");
  let changed = false;

  await assert.rejects(
    observeBoundSources({
      workspacePath,
      bindings: [binding("file:src/race.ts")],
      hooks: {
        afterFileRead: async () => {
          if (changed) return;
          changed = true;
          await writeFile(sourcePath, "after!\n");
        },
      },
    }),
    (error) => error?.code === "DRIFT_SOURCE_UNSTABLE",
  );
});

test("final stability pass rejects mutation of an already-hashed source", async (t) => {
  const workspacePath = await temporaryWorkspace(t);
  await mkdir(join(workspacePath, "src"));
  const firstPath = join(workspacePath, "src", "a.ts");
  await Promise.all([
    writeFile(firstPath, "first\n"),
    writeFile(join(workspacePath, "src", "b.ts"), "second\n"),
  ]);

  await assert.rejects(
    observeBoundSources({
      workspacePath,
      bindings: [binding("module:src")],
      hooks: {
        afterFileRead: async ({ path }) => {
          if (path === "src/b.ts") await writeFile(firstPath, "changed later\n");
        },
      },
    }),
    (error) => error?.code === "DRIFT_SOURCE_UNSTABLE",
  );
});

test("Git advisory mutation is included in the later authoritative raw-byte observation", async (t) => {
  const workspacePath = await temporaryWorkspace(t);
  await mkdir(join(workspacePath, "src"));
  const sourcePath = join(workspacePath, "src", "race.ts");
  const before = Buffer.from("before\n");
  const after = Buffer.from("after\n");
  await writeFile(sourcePath, before);

  const result = await observeBoundSources({
    workspacePath,
    bindings: [binding("file:src/race.ts")],
    hooks: {
      runGit: async () => {
        await writeFile(sourcePath, after);
        return { code: 0, stdout: `${"a".repeat(40)}\n`, stderr: "" };
      },
    },
  });

  assert.equal(result.git.available, true);
  assert.deepEqual(result.bindings[0].files, [{
    path: "src/race.ts",
    bytes: after.length,
    sha256: `sha256:${createHash("sha256").update(after).digest("hex")}`,
  }]);
  assert.notEqual(
    result.bindings[0].files[0].sha256,
    `sha256:${createHash("sha256").update(before).digest("hex")}`,
  );
});

test("Git contributes bounded safe hints without changing authoritative observations", async (t) => {
  const workspacePath = await temporaryWorkspace(t);
  await mkdir(join(workspacePath, "src"));
  await writeFile(join(workspacePath, "src", "current.ts"), "current\n");
  const head = "a".repeat(40);
  let invocation;
  const result = await observeBoundSources({
    workspacePath,
    gitBaseline: "HEAD~1",
    bindings: [binding("module:src")],
    hooks: {
      runGit: async (received) => {
        invocation = received;
        if (received.args.includes("rev-parse")) {
          return { code: 0, stdout: `${head}\n`, stderr: "" };
        }
        return {
          code: 0,
          stdout: Buffer.from(
            "R100\0src/old.ts\0src/new.ts\0M\0src/current.ts\0M\0node_modules/x.ts\0M\0other/x.ts\0",
          ),
          stderr: Buffer.alloc(0),
        };
      },
    },
  });

  assert.equal(invocation.command, "git");
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.env.GIT_TERMINAL_PROMPT, "0");
  assert.ok(invocation.args.includes("--no-ext-diff"));
  assert.ok(invocation.args.includes("--no-textconv"));
  assert.equal(result.git.available, true);
  assert.equal(result.git.hintsAvailable, true);
  assert.equal(result.git.baseline, head);
  assert.equal(result.git.comparedFrom, "HEAD~1");
  assert.deepEqual(result.git.hints, [
    { status: "modified", path: "src/current.ts" },
    { status: "renamed", oldPath: "src/old.ts", newPath: "src/new.ts", similarity: 100 },
  ]);
  assert.equal(result.git.discardedUnsafePaths, 1);

  const withoutGit = await observeBoundSources({
    workspacePath,
    bindings: [binding("module:src")],
  });
  const failedGit = await observeBoundSources({
    workspacePath,
    gitBaseline: "HEAD~1",
    bindings: [binding("module:src")],
    hooks: { runGit: async () => { throw new Error("git unavailable"); } },
  });
  assert.deepEqual(result.bindings, withoutGit.bindings);
  assert.deepEqual(failedGit.bindings, withoutGit.bindings);
  assert.equal(failedGit.git.available, false);
  assert.match(failedGit.git.warning, /git unavailable/u);

  const failedDiff = await observeBoundSources({
    workspacePath,
    gitBaseline: "HEAD~1",
    bindings: [binding("module:src")],
    hooks: {
      runGit: async (received) => {
        if (received.args.includes("rev-parse")) {
          return { code: 0, stdout: `${head}\n`, stderr: "" };
        }
        throw new Error("diff unavailable");
      },
    },
  });
  assert.equal(failedDiff.git.available, false);
  assert.equal(failedDiff.git.baseline, head);
  assert.equal(failedDiff.git.hintsAvailable, false);
  assert.deepEqual(failedDiff.bindings, withoutGit.bindings);
});

test("the first safe Git observation establishes current HEAD without historical hints", async (t) => {
  const workspacePath = await temporaryWorkspace(t);
  await writeFile(join(workspacePath, "source.ts"), "source\n");
  const head = "b".repeat(40);
  const invocations = [];
  const result = await observeBoundSources({
    workspacePath,
    bindings: [binding("file:source.ts")],
    hooks: {
      runGit: async (invocation) => {
        invocations.push(invocation);
        return { code: 0, stdout: `${head}\n`, stderr: "" };
      },
    },
  });
  assert.equal(invocations.length, 1);
  assert.ok(invocations[0].args.includes("rev-parse"));
  assert.equal(invocations[0].options.shell, false);
  assert.deepEqual(result.git, {
    advisory: true,
    available: true,
    hintsAvailable: false,
    baseline: head,
    comparedFrom: null,
    baselineEstablished: true,
    hints: [],
  });
});

test("unsafe Git baselines never reach process execution", async (t) => {
  const workspacePath = await temporaryWorkspace(t);
  await writeFile(join(workspacePath, "source.ts"), "source\n");
  let invoked = false;
  const result = await observeBoundSources({
    workspacePath,
    gitBaseline: "--upload-pack=bad",
    bindings: [binding("file:source.ts")],
    hooks: { runGit: async () => { invoked = true; } },
  });
  assert.equal(invoked, false);
  assert.equal(result.git.available, false);
  assert.equal(result.bindings[0].fileCount, 1);
});

test("covered files enforce size bounds before hashing", async (t) => {
  const workspacePath = await temporaryWorkspace(t);
  await mkdir(join(workspacePath, "src"));
  await writeFile(
    join(workspacePath, "src", "large.bin"),
    Buffer.alloc(DRIFT_SOURCE_POLICY.maximumFileBytes + 1),
  );
  await assert.rejects(
    observeBoundSources({ workspacePath, bindings: [binding("module:src")] }),
    (error) => error?.code === "DRIFT_SOURCE_LIMIT" && /exceeds/u.test(error.message),
  );
});

test("binding inputs must be normalized, supported, and unique", async (t) => {
  const workspacePath = await temporaryWorkspace(t);
  await assert.rejects(
    observeBoundSources({
      workspacePath,
      bindings: [binding("file:a.ts"), binding("file:a.ts")],
    }),
    (error) => error?.code === "DRIFT_SOURCE_INVALID",
  );
  await assert.rejects(
    observeBoundSources({
      workspacePath,
      bindings: [{ specifier: "file:a.ts", kind: "file", ref: "a\\.ts" }],
    }),
    (error) => error?.code === "DRIFT_SOURCE_INVALID",
  );
});

test("drift observation accepts more than the context target limit with indexed exact files", async (t) => {
  const workspacePath = await temporaryWorkspace(t);
  await mkdir(join(workspacePath, "src"));
  const paths = Array.from(
    { length: 128 },
    (_, index) => `src/present-${String(index).padStart(3, "0")}.ts`,
  );
  await Promise.all(paths.map((path, index) =>
    writeFile(join(workspacePath, ...path.split("/")), `${index}\n`)));
  const bindings = paths.map((path) => binding(`file:${path}`));

  const result = await observeBoundSources({
    workspacePath,
    bindings,
    hooks: { runGit: async () => { throw new Error("git unavailable"); } },
  });

  assert.equal(DRIFT_SOURCE_POLICY.maximumBindings, 10_000);
  assert.equal(result.bindings.length, 128);
  assert.equal(result.coverage.uniqueFilesMatched, 128);
  assert.equal(result.coverage.matchEvaluations, 128);
  assert.equal(bySpecifier(result, "file:src/present-000.ts").fileCount, 1);
});

test("drift binding count and global match evaluation bounds fail closed", async (t) => {
  const workspacePath = await temporaryWorkspace(t);
  const excessiveBindings = Array.from(
    { length: DRIFT_SOURCE_POLICY.maximumBindings + 1 },
    (_, index) => binding(`file:missing-${String(index).padStart(5, "0")}.ts`),
  );
  await assert.rejects(
    observeBoundSources({ workspacePath, bindings: excessiveBindings }),
    (error) =>
      error?.code === "DRIFT_SOURCE_INVALID" &&
      error.message.includes(String(DRIFT_SOURCE_POLICY.maximumBindings)),
  );

  await mkdir(join(workspacePath, "src"));
  await Promise.all(Array.from(
    { length: 101 },
    (_, index) => writeFile(
      join(workspacePath, "src", `observed-${String(index).padStart(3, "0")}.ts`),
      `${index}\n`,
    ),
  ));
  const maximumBindings = Array.from(
    { length: DRIFT_SOURCE_POLICY.maximumBindings },
    (_, index) => binding(`path_glob:src/**/bound-${String(index).padStart(5, "0")}.ts`),
  );
  await assert.rejects(
    observeBoundSources({ workspacePath, bindings: maximumBindings }),
    (error) =>
      error?.code === "DRIFT_SOURCE_LIMIT" &&
      /match evaluation limit exceeded/u.test(error.message),
  );
});

test("portable case collisions in a covered region fail closed when the host exposes both", async (t) => {
  const workspacePath = await temporaryWorkspace(t);
  await mkdir(join(workspacePath, "Src"));
  await mkdir(join(workspacePath, "src"), { recursive: true });
  await writeFile(join(workspacePath, "Src", "a.ts"), "a");
  await writeFile(join(workspacePath, "src", "b.ts"), "b");
  const names = await readdir(workspacePath);
  if (!(names.includes("Src") && names.includes("src"))) {
    t.skip("host filesystem is case-insensitive");
    return;
  }
  await assert.rejects(
    observeBoundSources({ workspacePath, bindings: [binding("path_glob:**/*.ts")] }),
    (error) => error?.code === "DRIFT_SOURCE_UNSAFE" && /collide/u.test(error.message),
  );
});
