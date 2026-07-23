import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  AGENT_FILE_MAX_BYTES,
  CURRENT_AGENT_HOOK_VERSION,
  planAgentMigrationCutover,
  planAgentPatch,
  verifyAgentPatchPlans,
} from "../../skills/syncora/scripts/lib/agent-patcher.mjs";
import { applyFilePlans } from "../../skills/syncora/scripts/lib/atomic-file.mjs";
import { withPatchLock } from "../../skills/syncora/scripts/lib/patch-lock.mjs";

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
const sharedHookPath = join(
  testDirectory,
  "..",
  "..",
  "skills",
  "syncora",
  "assets",
  "agent-hooks",
  "shared.md",
);
const bom = Buffer.from([0xef, 0xbb, 0xbf]);
const legacyHook = `<!-- syncora-agent-hook:begin v1 -->
## Syncora

When .syncora exists, use Syncora for project work.
<!-- syncora-agent-hook:end v1 -->`;
const predecessorWorkflow = `<!-- BEGIN KNOWLEDGE GRAPH WORKFLOW -->
## Knowledge Graph Workflow

Always load every graph note before work.
<!-- END KNOWLEDGE GRAPH WORKFLOW -->`;

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function replaceOwnedHook(text, replacement) {
  return text.replace(
    /<!-- syncora-agent-hook:begin v\d+ -->[\s\S]*?<!-- syncora-agent-hook:end v\d+ -->/,
    replacement,
  );
}

async function simulateTrackedV1Hook(workspace, targetPath) {
  const v2Text = await readFile(targetPath, "utf8");
  const newline = v2Text.includes("\r\n") ? "\r\n" : "\n";
  const v1Text = replaceOwnedHook(
    v2Text,
    legacyHook.replace(/\n/g, newline),
  );
  await writeFile(targetPath, v1Text, "utf8");

  const statePath = join(workspace, ".syncora", "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  const target = state.agentPatches.targets.find(
    (item) => item.path === "AGENTS.md",
  );
  assert.ok(target, "AGENTS.md patch state must exist");
  state.agentPatches.markerVersion = 1;
  target.markerVersion = 1;
  target.resultingHash = sha256(Buffer.from(v1Text, "utf8"));
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return v1Text;
}

function run(args, expectedStatus = 0) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
  });
  assert.equal(
    result.status,
    expectedStatus,
    `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result;
}

function runAsync(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });
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

async function temporaryWorkspace() {
  return realpath(await mkdtemp(join(tmpdir(), "syncora-patcher-")));
}

test("patch and unpatch exactly restore untouched BOM and CRLF files", async () => {
  const workspace = await temporaryWorkspace();
  const agentsPath = join(workspace, "AGENTS.md");
  const claudePath = join(workspace, "CLAUDE.md");
  const agentsOriginal = Buffer.concat([
    bom,
    Buffer.from("# Existing\r\n\r\nKeep this exact.\r\n", "utf8"),
  ]);
  const claudeOriginal = Buffer.from("# Claude\r\n\r\nKeep this too.\r\n", "utf8");

  try {
    await writeFile(agentsPath, agentsOriginal);
    await writeFile(claudePath, claudeOriginal);
    run(["init", "--workspace", workspace, "--format", "json"]);

    const patched = await readFile(agentsPath);
    assert.equal(patched.subarray(0, 3).equals(bom), true);
    const patchedText = patched.subarray(3).toString("utf8");
    assert.match(patchedText, /syncora-agent-hook:begin v8/);
    assert.equal(/(^|[^\r])\n/.test(patchedText), false);

    run(["unpatch-agents", "--workspace", workspace, "--format", "json"]);
    assert.deepEqual(await readFile(agentsPath), agentsOriginal);
    assert.deepEqual(await readFile(claudePath), claudeOriginal);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("malformed markers stop before any target is written", async () => {
  const workspace = await temporaryWorkspace();
  const agentsPath = join(workspace, "AGENTS.md");
  const malformed = "before\n<!-- syncora-agent-hook:begin v1 -->\nafter\n";
  try {
    run([
      "init",
      "--workspace",
      workspace,
      "--no-patch-agents",
      "--format",
      "json",
    ]);
    await writeFile(agentsPath, malformed, "utf8");
    const result = run(
      ["patch-agents", "--workspace", workspace, "--format", "json"],
      1,
    );
    assert.match(result.stderr, /PATCH001/);
    assert.equal(await readFile(agentsPath, "utf8"), malformed);
    await assert.rejects(access(join(workspace, ".claude", "CLAUDE.md")));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Codex override is patched and Claude AGENTS import avoids duplication", async () => {
  const workspace = await temporaryWorkspace();
  try {
    await writeFile(join(workspace, "AGENTS.override.md"), "# Override\n", "utf8");
    await mkdir(join(workspace, ".claude"), { recursive: true });
    await writeFile(
      join(workspace, ".claude", "CLAUDE.md"),
      "@../AGENTS.md\n",
      "utf8",
    );

    run(["init", "--workspace", workspace, "--format", "json"]);
    assert.match(
      await readFile(join(workspace, "AGENTS.md"), "utf8"),
      /syncora-agent-hook:begin v8/,
    );
    assert.match(
      await readFile(join(workspace, "AGENTS.override.md"), "utf8"),
      /syncora-agent-hook:begin v8/,
    );
    assert.equal(
      await readFile(join(workspace, ".claude", "CLAUDE.md"), "utf8"),
      "@../AGENTS.md\n",
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a malformed later target prevents every planned target write", async () => {
  const workspace = await temporaryWorkspace();
  const agentsPath = join(workspace, "AGENTS.md");
  const claudePath = join(workspace, "CLAUDE.md");
  const agentsOriginal = "# Existing agents\n";
  const claudeMalformed =
    "# Claude\n<!-- syncora-agent-hook:begin v1 -->\nmissing end\n";
  try {
    run([
      "init",
      "--workspace",
      workspace,
      "--no-patch-agents",
      "--format",
      "json",
    ]);
    await writeFile(agentsPath, agentsOriginal, "utf8");
    await writeFile(claudePath, claudeMalformed, "utf8");

    const result = run(
      ["patch-agents", "--workspace", workspace, "--format", "json"],
      1,
    );
    assert.match(result.stderr, /PATCH001/);
    assert.equal(await readFile(agentsPath, "utf8"), agentsOriginal);
    assert.equal(await readFile(claudePath, "utf8"), claudeMalformed);
    await assert.rejects(access(join(workspace, ".syncora", "state.json")));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("unpatch preserves post-patch user edits when a target diverged", async () => {
  const workspace = await temporaryWorkspace();
  const agentsPath = join(workspace, "AGENTS.md");
  try {
    run(["init", "--workspace", workspace, "--format", "json"]);
    const patched = await readFile(agentsPath, "utf8");
    await writeFile(agentsPath, `${patched}\nUser-owned addition.\n`, "utf8");

    const result = JSON.parse(
      run([
        "unpatch-agents",
        "--workspace",
        workspace,
        "--format",
        "json",
      ]).stdout,
    );
    const after = await readFile(agentsPath, "utf8");
    assert.doesNotMatch(after, /syncora-agent-hook:/);
    assert.match(after, /User-owned addition\./);
    assert.ok(
      result.warnings.some((warning) => warning.code === "PATCH_DIVERGED"),
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("migration cutover replaces the predecessor block byte-exactly and unpatch never restores it", async () => {
  const workspace = await temporaryWorkspace();
  const agentsPath = join(workspace, "AGENTS.md");
  const claudePath = join(workspace, "CLAUDE.md");
  const predecessorCrLf = predecessorWorkflow.replace(/\n/g, "\r\n");
  const agentsText = `# Custom agents\r\n\r\n${predecessorCrLf}\r\n\r\nKeep Ω exactly.\r\n`;
  const claudeText = `# Claude\r\n\r\n@AGENTS.md\r\n\r\n${predecessorCrLf}\r\n\r\nKeep Claude exact.\r\n`;
  const agentsOriginal = Buffer.concat([bom, Buffer.from(agentsText, "utf8")]);
  const claudeOriginal = Buffer.from(claudeText, "utf8");

  try {
    run([
      "init",
      "--workspace",
      workspace,
      "--no-patch-agents",
      "--format",
      "json",
    ]);
    await writeFile(agentsPath, agentsOriginal);
    await writeFile(claudePath, claudeOriginal);

    const hook = (await readFile(sharedHookPath, "utf8"))
      .replace(/\r\n/g, "\n")
      .trimEnd()
      .replace(/\n/g, "\r\n");
    const expectedPatchedAgents = Buffer.concat([
      bom,
      Buffer.from(agentsText.replace(predecessorCrLf, hook), "utf8"),
    ]);
    const expectedAgentsBaseline = Buffer.concat([
      bom,
      Buffer.from(agentsText.replace(predecessorCrLf, ""), "utf8"),
    ]);
    const expectedClaudeBaseline = Buffer.from(
      claudeText.replace(predecessorCrLf, ""),
      "utf8",
    );

    const planned = await planAgentMigrationCutover(workspace);
    await verifyAgentPatchPlans(workspace, planned.plans);
    assert.equal(
      planned.plans.filter((item) => item.displayPath === "AGENTS.md").length,
      1,
    );
    assert.equal(
      planned.plans.filter((item) => item.displayPath === "CLAUDE.md").length,
      1,
    );
    await applyFilePlans(planned.plans);

    assert.deepEqual(await readFile(agentsPath), expectedPatchedAgents);
    assert.deepEqual(await readFile(claudePath), expectedClaudeBaseline);
    assert.doesNotMatch(
      await readFile(claudePath, "utf8"),
      /syncora-agent-hook:/,
    );
    assert.ok(
      planned.warnings.filter(
        (warning) => warning.code === "LEGACY_AGENT_WORKFLOW_CUTOVER",
      ).length >= 2,
    );

    const state = JSON.parse(
      await readFile(join(workspace, ".syncora", "state.json"), "utf8"),
    );
    const agentsRecord = state.agentPatches.targets.find(
      (item) => item.path === "AGENTS.md",
    );
    assert.ok(agentsRecord);
    const snapshot = join(
      workspace,
      ...agentsRecord.originalSnapshot.split("/"),
    );
    assert.deepEqual(await readFile(snapshot), expectedAgentsBaseline);

    run(["unpatch-agents", "--workspace", workspace, "--format", "json"]);
    assert.deepEqual(await readFile(agentsPath), expectedAgentsBaseline);
    assert.deepEqual(await readFile(claudePath), expectedClaudeBaseline);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("migration cutover refreshes an exact tracked dual-workflow baseline without a false divergence warning", async () => {
  const workspace = await temporaryWorkspace();
  const agentsPath = join(workspace, "AGENTS.md");
  const original = `# Existing agents\n\n${predecessorWorkflow}\n\nUser content.\n`;
  const expectedBaseline = original.replace(predecessorWorkflow, "");
  try {
    run([
      "init",
      "--workspace",
      workspace,
      "--no-patch-agents",
      "--format",
      "json",
    ]);
    await writeFile(agentsPath, original, "utf8");
    await mkdir(join(workspace, ".claude"), { recursive: true });
    await writeFile(
      join(workspace, ".claude", "CLAUDE.md"),
      "@../AGENTS.md\n",
      "utf8",
    );
    const initialPatch = await planAgentPatch(workspace, {
      allowPredecessorActivation: true,
    });
    await verifyAgentPatchPlans(workspace, initialPatch.plans);
    await applyFilePlans(initialPatch.plans);
    const dual = await readFile(agentsPath, "utf8");
    assert.match(dual, /BEGIN KNOWLEDGE GRAPH WORKFLOW/);
    assert.match(dual, /syncora-agent-hook:begin v8/);

    const planned = await planAgentMigrationCutover(workspace);
    await verifyAgentPatchPlans(workspace, planned.plans);
    await applyFilePlans(planned.plans);

    const cutover = await readFile(agentsPath, "utf8");
    assert.doesNotMatch(cutover, /BEGIN KNOWLEDGE GRAPH WORKFLOW/);
    assert.equal(
      (cutover.match(/syncora-agent-hook:begin v8/g) ?? []).length,
      1,
    );
    assert.equal(
      planned.warnings.some((warning) => warning.code === "PATCH_DIVERGED"),
      false,
    );

    run(["unpatch-agents", "--workspace", workspace, "--format", "json"]);
    assert.equal(await readFile(agentsPath, "utf8"), expectedBaseline);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("migration cutover rejects malformed or duplicate predecessor markers before any write", async () => {
  const malformedCases = [
    `${predecessorWorkflow.split("<!-- END")[0]}`,
    `<!-- BEGIN KNOWLEDGE GRAPH WORKFLOW -->\nfirst\n<!-- BEGIN KNOWLEDGE GRAPH WORKFLOW -->\nsecond\n<!-- END KNOWLEDGE GRAPH WORKFLOW -->`,
  ];

  for (const malformed of malformedCases) {
    const workspace = await temporaryWorkspace();
    const agentsPath = join(workspace, "AGENTS.md");
    const claudePath = join(workspace, "CLAUDE.md");
    const agentsOriginal = `# Agents\n\n${predecessorWorkflow}\n`;
    const claudeOriginal = `# Claude\n\n${malformed}\n`;
    try {
      run([
        "init",
        "--workspace",
        workspace,
        "--no-patch-agents",
        "--format",
        "json",
      ]);
      await writeFile(agentsPath, agentsOriginal, "utf8");
      await writeFile(claudePath, claudeOriginal, "utf8");

      await assert.rejects(
        planAgentMigrationCutover(workspace),
        (error) =>
          error?.code === "PATCH001" && /predecessor/i.test(error.message),
      );
      assert.equal(await readFile(agentsPath, "utf8"), agentsOriginal);
      assert.equal(await readFile(claudePath, "utf8"), claudeOriginal);
      await assert.rejects(
        access(join(workspace, ".syncora", "state.json")),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }
});

test("an untouched tracked v1 hook upgrades to v8 and still restores the true original", async () => {
  const workspace = await temporaryWorkspace();
  const agentsPath = join(workspace, "AGENTS.md");
  const original = Buffer.concat([
    bom,
    Buffer.from("# Existing agents\r\n\r\nKeep this exact.\r\n", "utf8"),
  ]);
  try {
    await writeFile(agentsPath, original);
    await mkdir(join(workspace, ".claude"), { recursive: true });
    await writeFile(
      join(workspace, ".claude", "CLAUDE.md"),
      "@../AGENTS.md\n",
      "utf8",
    );
    run(["init", "--workspace", workspace, "--format", "json"]);
    await simulateTrackedV1Hook(workspace, agentsPath);

    run(["patch-agents", "--workspace", workspace, "--format", "json"]);
    const upgraded = await readFile(agentsPath, "utf8");
    assert.match(upgraded, /syncora-agent-hook:begin v8/);
    assert.doesNotMatch(upgraded, /syncora-agent-hook:begin v1/);

    run(["unpatch-agents", "--workspace", workspace, "--format", "json"]);
    assert.deepEqual(await readFile(agentsPath), original);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("an untouched tracked v7 hook upgrades to the v8 capture-disposition contract", async () => {
  const workspace = await temporaryWorkspace();
  const agentsPath = join(workspace, "AGENTS.md");
  try {
    await writeFile(agentsPath, "# Existing agents\n", "utf8");
    await mkdir(join(workspace, ".claude"), { recursive: true });
    await writeFile(
      join(workspace, ".claude", "CLAUDE.md"),
      "@../AGENTS.md\n",
      "utf8",
    );
    run(["init", "--workspace", workspace, "--format", "json"]);

    const v8Text = await readFile(agentsPath, "utf8");
    const v7Text = v8Text
      .replace("syncora-agent-hook:begin v8", "syncora-agent-hook:begin v7")
      .replace("syncora-agent-hook:end v8", "syncora-agent-hook:end v7")
      .replace(/Before every final response[\s\S]*?predicted capture at the start of the request\.\n/u, "");
    await writeFile(agentsPath, v7Text, "utf8");

    const statePath = join(workspace, ".syncora", "state.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    const target = state.agentPatches.targets.find(
      (item) => item.path === "AGENTS.md",
    );
    assert.ok(target, "AGENTS.md patch state must exist");
    state.agentPatches.markerVersion = 7;
    target.markerVersion = 7;
    target.resultingHash = sha256(Buffer.from(v7Text, "utf8"));
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

    run(["patch-agents", "--workspace", workspace, "--format", "json"]);
    const upgraded = await readFile(agentsPath, "utf8");
    assert.match(upgraded, /syncora-agent-hook:begin v8/);
    assert.match(upgraded, /mandatory even when\s+the agent did not predict capture/);
    assert.match(upgraded, /`open_question`/);
    assert.match(upgraded, /`user_decision_required`/);
    assert.doesNotMatch(upgraded, /syncora-agent-hook:begin v7/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("an untracked v1 marker is never snapshotted as original content", async () => {
  const workspace = await temporaryWorkspace();
  const agentsPath = join(workspace, "AGENTS.md");
  const withV1 = `# Existing agents\n\n${legacyHook}\n\nUser content.\n`;
  const expectedAfterUnpatch = replaceOwnedHook(withV1, "");
  try {
    run([
      "init",
      "--workspace",
      workspace,
      "--no-patch-agents",
      "--format",
      "json",
    ]);
    await writeFile(agentsPath, withV1, "utf8");

    const patched = JSON.parse(
      run(["patch-agents", "--workspace", workspace, "--format", "json"])
        .stdout,
    );
    assert.match(await readFile(agentsPath, "utf8"), /begin v8/);
    assert.ok(
      patched.warnings.some((warning) => warning.code === "PATCH_UNTRACKED"),
    );

    run(["unpatch-agents", "--workspace", workspace, "--format", "json"]);
    assert.equal(await readFile(agentsPath, "utf8"), expectedAfterUnpatch);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a new root Claude target retires a previously Syncora-created nested target", async () => {
  const workspace = await temporaryWorkspace();
  const rootClaude = join(workspace, "CLAUDE.md");
  const nestedClaude = join(workspace, ".claude", "CLAUDE.md");
  try {
    run(["init", "--workspace", workspace, "--format", "json"]);
    assert.match(await readFile(nestedClaude, "utf8"), /begin v8/);
    await writeFile(rootClaude, "# Root Claude\n", "utf8");

    run(["patch-agents", "--workspace", workspace, "--format", "json"]);
    assert.match(await readFile(rootClaude, "utf8"), /begin v8/);
    await assert.rejects(access(nestedClaude));

    run(["unpatch-agents", "--workspace", workspace, "--format", "json"]);
    assert.equal(await readFile(rootClaude, "utf8"), "# Root Claude\n");
    await assert.rejects(access(nestedClaude));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a Claude file that starts importing AGENTS retires its duplicate hook", async () => {
  const workspace = await temporaryWorkspace();
  const claudePath = join(workspace, "CLAUDE.md");
  try {
    await writeFile(claudePath, "# Claude\n", "utf8");
    run(["init", "--workspace", workspace, "--format", "json"]);
    const patched = await readFile(claudePath, "utf8");
    await writeFile(claudePath, `${patched}\n@AGENTS.md\n`, "utf8");

    run(["patch-agents", "--workspace", workspace, "--format", "json"]);
    const deduplicated = await readFile(claudePath, "utf8");
    assert.doesNotMatch(deduplicated, /syncora-agent-hook:/);
    assert.match(deduplicated, /@AGENTS\.md/);

    run(["unpatch-agents", "--workspace", workspace, "--format", "json"]);
    const after = await readFile(claudePath, "utf8");
    assert.doesNotMatch(after, /syncora-agent-hook:/);
    assert.match(after, /@AGENTS\.md/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("future hook versions and unsafe snapshot state fail before target writes", async () => {
  const workspace = await temporaryWorkspace();
  const agentsPath = join(workspace, "AGENTS.md");
  try {
    run(["init", "--workspace", workspace, "--format", "json"]);
    const statePath = join(workspace, ".syncora", "state.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.agentPatches.targets[0].originalSnapshot = "../outside.bin";
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    const before = await readFile(agentsPath);

    const badState = run(
      ["patch-agents", "--workspace", workspace, "--format", "json"],
      1,
    );
    assert.match(badState.stderr, /STATE001/);
    assert.deepEqual(await readFile(agentsPath), before);

    await writeFile(
      statePath,
      `${JSON.stringify({ schemaVersion: 1 }, null, 2)}\n`,
      "utf8",
    );
    const futureVersion = CURRENT_AGENT_HOOK_VERSION + 1;
    const future = replaceOwnedHook(
      await readFile(agentsPath, "utf8"),
      `<!-- syncora-agent-hook:begin v${futureVersion} -->\nfuture\n<!-- syncora-agent-hook:end v${futureVersion} -->`,
    );
    await writeFile(agentsPath, future, "utf8");
    const futureResult = run(
      ["patch-agents", "--workspace", workspace, "--format", "json"],
      1,
    );
    assert.match(futureResult.stderr, /PATCH002/);
    assert.equal(await readFile(agentsPath, "utf8"), future);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("patch state rejects unknown retained data and oversized control bytes without rewriting", async () => {
  const workspace = await temporaryWorkspace();
  const agentsPath = join(workspace, "AGENTS.md");
  try {
    run(["init", "--workspace", workspace, "--format", "json"]);
    const statePath = join(workspace, ".syncora", "state.json");
    const agentsBefore = await readFile(agentsPath);
    const compactUnknown = Buffer.from(
      JSON.stringify({ schemaVersion: 1, retained: "x".repeat(200_000) }),
      "utf8",
    );
    assert.ok(compactUnknown.length < 262_144);
    await writeFile(statePath, compactUnknown);

    const unknown = run(
      ["patch-agents", "--workspace", workspace, "--format", "json"],
      1,
    );
    assert.match(unknown.stderr, /STATE001/);
    assert.match(unknown.stderr, /unknown fields/);
    assert.deepEqual(await readFile(statePath), compactUnknown);
    assert.deepEqual(await readFile(agentsPath), agentsBefore);

    const oversized = Buffer.alloc(262_145, 0x20);
    await writeFile(statePath, oversized);
    const tooLarge = run(
      ["unpatch-agents", "--workspace", workspace, "--format", "json"],
      1,
    );
    assert.match(tooLarge.stderr, /STATE001/);
    assert.match(tooLarge.stderr, /exceeds 262144 bytes/);
    assert.deepEqual(await readFile(statePath), oversized);
    assert.deepEqual(await readFile(agentsPath), agentsBefore);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("oversized agent targets and restoration snapshots fail closed before writes", async () => {
  const oversizedWorkspace = await temporaryWorkspace();
  const restoreWorkspace = await temporaryWorkspace();
  try {
    run([
      "init",
      "--workspace",
      oversizedWorkspace,
      "--no-patch-agents",
      "--format",
      "json",
    ]);
    const oversizedTarget = Buffer.alloc(AGENT_FILE_MAX_BYTES + 1, 0x61);
    const oversizedTargetPath = join(oversizedWorkspace, "AGENTS.md");
    await writeFile(oversizedTargetPath, oversizedTarget);
    const targetResult = run(
      ["patch-agents", "--workspace", oversizedWorkspace, "--format", "json"],
      1,
    );
    assert.match(targetResult.stderr, /PATCH004/);
    assert.match(targetResult.stderr, /exceeds 1048576 bytes/);
    assert.deepEqual(await readFile(oversizedTargetPath), oversizedTarget);
    await assert.rejects(
      access(join(oversizedWorkspace, ".syncora", "state.json")),
    );

    const original = Buffer.from("# Snapshot original\n", "utf8");
    const restoreTargetPath = join(restoreWorkspace, "AGENTS.md");
    await writeFile(restoreTargetPath, original);
    run(["init", "--workspace", restoreWorkspace, "--format", "json"]);
    const patched = await readFile(restoreTargetPath);
    const statePath = join(restoreWorkspace, ".syncora", "state.json");
    const stateBefore = await readFile(statePath);
    const state = JSON.parse(stateBefore.toString("utf8"));
    const record = state.agentPatches.targets.find(
      (item) => item.path === "AGENTS.md",
    );
    const snapshot = join(
      restoreWorkspace,
      ...record.originalSnapshot.split("/"),
    );
    const oversizedSnapshot = Buffer.alloc(AGENT_FILE_MAX_BYTES + 1, 0x62);
    await writeFile(snapshot, oversizedSnapshot);
    const snapshotResult = run(
      ["unpatch-agents", "--workspace", restoreWorkspace, "--format", "json"],
      1,
    );
    assert.match(snapshotResult.stderr, /PATCH003/);
    assert.match(snapshotResult.stderr, /exceeds 1048576 bytes/);
    assert.deepEqual(await readFile(restoreTargetPath), patched);
    assert.deepEqual(await readFile(statePath), stateBefore);
    assert.deepEqual(await readFile(snapshot), oversizedSnapshot);
  } finally {
    await rm(oversizedWorkspace, { recursive: true, force: true });
    await rm(restoreWorkspace, { recursive: true, force: true });
  }
});

test("a same-byte agent parent retarget is rejected again at publication", async (t) => {
  const workspace = await temporaryWorkspace();
  const external = await temporaryWorkspace();
  const claudeDirectory = join(workspace, ".claude");
  const originalDirectory = join(workspace, ".claude-original");
  const linkProbe = join(workspace, ".retarget-link-probe");
  const linkType = process.platform === "win32" ? "junction" : "dir";
  const content = "# Claude instructions\n";
  try {
    run([
      "init",
      "--workspace",
      workspace,
      "--no-patch-agents",
      "--format",
      "json",
    ]);
    try {
      await symlink(external, linkProbe, linkType);
      await rm(linkProbe, { recursive: true, force: true });
    } catch (error) {
      if (error?.code === "EPERM") {
        t.skip("Directory links require privileges on this host.");
        return;
      }
      throw error;
    }
    await mkdir(claudeDirectory);
    await writeFile(join(claudeDirectory, "CLAUDE.md"), content, "utf8");
    await writeFile(join(external, "CLAUDE.md"), content, "utf8");
    const planned = await planAgentPatch(workspace);
    await verifyAgentPatchPlans(workspace, planned.plans);
    const claudePlan = planned.plans.find(
      (item) => item.displayPath === ".claude/CLAUDE.md",
    );
    assert.ok(claudePlan, "nested Claude patch plan must exist");
    const readBoundCurrent = claudePlan.readCurrent;
    let readCount = 0;
    claudePlan.readCurrent = async () => {
      readCount += 1;
      if (readCount === 2) {
        await rename(claudeDirectory, originalDirectory);
        await symlink(external, claudeDirectory, linkType);
      }
      return readBoundCurrent();
    };

    await assert.rejects(
      applyFilePlans(planned.plans),
      (error) => error?.code === "PATCH004",
    );
    assert.equal(readCount, 2, "retarget must occur at the pre-temp publish guard");
    await assert.rejects(access(join(workspace, "AGENTS.md")));
    assert.equal(await readFile(join(external, "CLAUDE.md"), "utf8"), content);
    await assert.rejects(access(join(workspace, ".syncora", "state.json")));
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

test("agent target symlinks fail closed without changing the linked file", async (t) => {
  const workspace = await temporaryWorkspace();
  const agentsPath = join(workspace, "AGENTS.md");
  const linkedPath = join(workspace, "linked-agents.md");
  const original = "# Linked user file\n";
  try {
    run([
      "init",
      "--workspace",
      workspace,
      "--no-patch-agents",
      "--format",
      "json",
    ]);
    await writeFile(linkedPath, original, "utf8");
    try {
      await symlink(linkedPath, agentsPath, "file");
    } catch (error) {
      if (error?.code === "EPERM") {
        t.skip("File symlinks require privileges on this Windows host.");
        return;
      }
      throw error;
    }

    const result = run(
      ["patch-agents", "--workspace", workspace, "--format", "json"],
      1,
    );
    assert.match(result.stderr, /PATCH004/);
    assert.equal(await readFile(linkedPath, "utf8"), original);
    await assert.rejects(access(join(workspace, ".syncora", "state.json")));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a linked .syncora state directory cannot move patch state outside the workspace", async () => {
  const workspace = await temporaryWorkspace();
  const externalState = await temporaryWorkspace();
  const agentsPath = join(workspace, "AGENTS.md");
  try {
    run([
      "init",
      "--workspace",
      workspace,
      "--no-patch-agents",
      "--format",
      "json",
    ]);
    const config = await readFile(
      join(workspace, ".syncora", "config.json"),
    );
    await rm(join(workspace, ".syncora"), { recursive: true, force: true });
    await writeFile(join(externalState, "config.json"), config);
    await symlink(
      externalState,
      join(workspace, ".syncora"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await writeFile(agentsPath, "# User agents\n", "utf8");

    const result = run(
      ["patch-agents", "--workspace", workspace, "--format", "json"],
      1,
    );
    assert.match(result.stderr, /CONFIG001|PATCH005/);
    assert.equal(await readFile(agentsPath, "utf8"), "# User agents\n");
    await assert.rejects(access(join(externalState, "state.json")));
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(externalState, { recursive: true, force: true });
  }
});

test("a diverged v1 hook upgrade refreshes its baseline and preserves user edits", async () => {
  const workspace = await temporaryWorkspace();
  const agentsPath = join(workspace, "AGENTS.md");
  try {
    await writeFile(agentsPath, "# Existing agents\n", "utf8");
    await mkdir(join(workspace, ".claude"), { recursive: true });
    await writeFile(
      join(workspace, ".claude", "CLAUDE.md"),
      "@../AGENTS.md\n",
      "utf8",
    );
    run(["init", "--workspace", workspace, "--format", "json"]);
    const trackedV1 = await simulateTrackedV1Hook(workspace, agentsPath);
    const divergedV1 = `${trackedV1}\nUser-owned addition.\n`;
    const expectedAfterUnpatch = replaceOwnedHook(divergedV1, "");
    await writeFile(agentsPath, divergedV1, "utf8");

    run(["patch-agents", "--workspace", workspace, "--format", "json"]);
    const upgraded = await readFile(agentsPath, "utf8");
    assert.match(upgraded, /syncora-agent-hook:begin v8/);
    assert.match(upgraded, /User-owned addition\./);

    run(["unpatch-agents", "--workspace", workspace, "--format", "json"]);
    assert.equal(await readFile(agentsPath, "utf8"), expectedAfterUnpatch);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("patch refuses to upgrade exact tracked bytes when the retained snapshot is missing or corrupt", async () => {
  const workspace = await temporaryWorkspace();
  const agentsPath = join(workspace, "AGENTS.md");
  const statePath = join(workspace, ".syncora", "state.json");
  try {
    await writeFile(agentsPath, "# Exact original\n", "utf8");
    await mkdir(join(workspace, ".claude"), { recursive: true });
    await writeFile(
      join(workspace, ".claude", "CLAUDE.md"),
      "@../AGENTS.md\n",
      "utf8",
    );
    run(["init", "--workspace", workspace, "--format", "json"]);
    const trackedV1 = await simulateTrackedV1Hook(workspace, agentsPath);
    const stateBefore = await readFile(statePath);
    const state = JSON.parse(stateBefore.toString("utf8"));
    const record = state.agentPatches.targets.find(
      (item) => item.path === "AGENTS.md",
    );
    const snapshotPath = join(
      workspace,
      ...record.originalSnapshot.split("/"),
    );

    await rm(snapshotPath);
    const missing = run(
      ["patch-agents", "--workspace", workspace, "--format", "json"],
      1,
    );
    assert.match(missing.stderr, /PATCH003/);
    assert.equal(await readFile(agentsPath, "utf8"), trackedV1);
    assert.deepEqual(await readFile(statePath), stateBefore);

    await writeFile(snapshotPath, "corrupt snapshot", "utf8");
    const corrupt = run(
      ["patch-agents", "--workspace", workspace, "--format", "json"],
      1,
    );
    assert.match(corrupt.stderr, /PATCH003/);
    assert.equal(await readFile(agentsPath, "utf8"), trackedV1);
    assert.deepEqual(await readFile(statePath), stateBefore);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a topology change after planning aborts before any patch target is written", async () => {
  const workspace = await temporaryWorkspace();
  const rootClaude = join(workspace, "CLAUDE.md");
  try {
    run([
      "init",
      "--workspace",
      workspace,
      "--no-patch-agents",
      "--format",
      "json",
    ]);
    const planned = await planAgentPatch(workspace);
    await verifyAgentPatchPlans(workspace, planned.plans);
    await writeFile(rootClaude, "# Appeared after planning\n", "utf8");

    await assert.rejects(
      applyFilePlans(planned.plans),
      (error) => error?.code === "WRITE001" && /CLAUDE\.md/.test(error.message),
    );
    await assert.rejects(access(join(workspace, "AGENTS.md")));
    await assert.rejects(access(join(workspace, ".claude", "CLAUDE.md")));
    assert.equal(
      await readFile(rootClaude, "utf8"),
      "# Appeared after planning\n",
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("workspace patch lock serializes CLI patching and concurrent patch/unpatch remain reversible", async () => {
  const workspace = await temporaryWorkspace();
  const agentsPath = join(workspace, "AGENTS.md");
  const original = Buffer.from("# Concurrent original\n", "utf8");
  try {
    await writeFile(agentsPath, original);
    run(["init", "--workspace", workspace, "--format", "json"]);

    let childSettled = false;
    let waitingPatch;
    await withPatchLock(workspace, async () => {
      waitingPatch = runAsync([
        "patch-agents",
        "--workspace",
        workspace,
        "--format",
        "json",
      ]).then((result) => {
        childSettled = true;
        return result;
      });
      await delay(250);
      assert.equal(childSettled, false, "child must wait for the held patch lock");
    });
    const waited = await waitingPatch;
    assert.equal(waited.status, 0, waited.stderr);

    const [patchResult, unpatchResult] = await Promise.all([
      runAsync([
        "patch-agents",
        "--workspace",
        workspace,
        "--format",
        "json",
      ]),
      runAsync([
        "unpatch-agents",
        "--workspace",
        workspace,
        "--format",
        "json",
      ]),
    ]);
    assert.equal(patchResult.status, 0, patchResult.stderr);
    assert.equal(unpatchResult.status, 0, unpatchResult.stderr);

    run(["patch-agents", "--workspace", workspace, "--format", "json"]);
    run(["unpatch-agents", "--workspace", workspace, "--format", "json"]);
    assert.deepEqual(await readFile(agentsPath), original);
    await assert.rejects(
      access(join(workspace, ".syncora", "locks", "agent-patcher.lock")),
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a dead stale patch-lock owner is recovered without leaving lock residue", async () => {
  const workspace = await temporaryWorkspace();
  const lockDirectory = join(workspace, ".syncora", "locks");
  const lockPath = join(lockDirectory, "agent-patcher.lock");
  try {
    run([
      "init",
      "--workspace",
      workspace,
      "--no-patch-agents",
      "--format",
      "json",
    ]);
    const deadOwner = spawn(process.execPath, ["-e", ""]);
    const deadPid = deadOwner.pid;
    await new Promise((resolve, reject) => {
      deadOwner.once("error", reject);
      deadOwner.once("close", resolve);
    });

    await mkdir(lockDirectory, { recursive: true });
    await writeFile(
      lockPath,
      `${JSON.stringify({
        schemaVersion: 1,
        token: "stale-owner-token-0001",
        pid: deadPid,
        createdAt: "2000-01-01T00:00:00.000Z",
      })}\n`,
      "utf8",
    );

    run(["patch-agents", "--workspace", workspace, "--format", "json"]);
    await assert.rejects(access(lockPath));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("patch recovery guard serializes two stale recoverers around the new owner", async () => {
  const workspace = await temporaryWorkspace();
  const lockDirectory = join(workspace, ".syncora", "locks");
  const lockPath = join(lockDirectory, "agent-patcher.lock");
  try {
    run([
      "init",
      "--workspace",
      workspace,
      "--no-patch-agents",
      "--format",
      "json",
    ]);
    await mkdir(lockDirectory, { recursive: true });
    await writeFile(
      lockPath,
      `${JSON.stringify({
        schemaVersion: 1,
        token: "stale-owner-token-0002",
        pid: 2_147_483_647,
        createdAt: "2000-01-01T00:00:00.000Z",
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
    const first = withPatchLock(
      workspace,
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
    const second = withPatchLock(
      workspace,
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

test("an orphaned patch recovery guard fails closed with bounded wait", async () => {
  const workspace = await temporaryWorkspace();
  const lockDirectory = join(workspace, ".syncora", "locks");
  const guardPath = join(lockDirectory, "agent-patcher.lock.recovery");
  try {
    run([
      "init",
      "--workspace",
      workspace,
      "--no-patch-agents",
      "--format",
      "json",
    ]);
    await mkdir(lockDirectory, { recursive: true });
    await writeFile(
      guardPath,
      `${JSON.stringify({
        schemaVersion: 1,
        token: "00000000-0000-4000-8000-000000000021",
        pid: process.pid,
        createdAt: new Date().toISOString(),
      })}\n`,
      "utf8",
    );

    await assert.rejects(
      withPatchLock(workspace, async () => undefined, {
        timeoutMs: 50,
        pollMs: 5,
        staleMs: 1,
      }),
      (error) =>
        error?.code === "PATCH005" &&
        /never recovered automatically/i.test(error.message),
    );
    await access(guardPath);
    await assert.rejects(access(join(lockDirectory, "agent-patcher.lock")));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("patch lock rejects a stable lock-directory retarget before writing", async (t) => {
  const workspace = await temporaryWorkspace();
  const external = await temporaryWorkspace();
  const lockDirectory = join(workspace, ".syncora", "locks");
  const originalDirectory = join(workspace, ".syncora", "locks-original");
  let replaced = false;
  try {
    run([
      "init",
      "--workspace",
      workspace,
      "--no-patch-agents",
      "--format",
      "json",
    ]);
    await mkdir(lockDirectory, { recursive: true });
    const probe = join(workspace, "lock-link-probe");
    try {
      await symlink(external, probe, process.platform === "win32" ? "junction" : "dir");
      await rm(probe, { recursive: true, force: true });
    } catch (error) {
      t.skip(`Symbolic links unavailable: ${error.message}`);
      return;
    }

    await assert.rejects(
      withPatchLock(workspace, async () => undefined, {
        timeoutMs: 250,
        pollMs: 5,
        staleMs: 1,
        hooks: {
          beforeMissingLockCreate: async () => {
            if (replaced) return;
            await rename(lockDirectory, originalDirectory);
            await symlink(
              external,
              lockDirectory,
              process.platform === "win32" ? "junction" : "dir",
            );
            replaced = true;
          },
        },
      }),
      (error) => error?.code === "PATCH005",
    );
    await assert.rejects(access(join(external, "agent-patcher.lock")));
    await assert.rejects(access(join(external, "agent-patcher.lock.recovery")));
  } finally {
    if (replaced) {
      await rm(lockDirectory, { recursive: true, force: true }).catch(() => undefined);
      await rename(originalDirectory, lockDirectory).catch(() => undefined);
    }
    await rm(workspace, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

test("patch dry-run does not create lock state", async () => {
  const workspace = await temporaryWorkspace();
  const locksPath = join(workspace, ".syncora", "locks");
  try {
    run([
      "init",
      "--workspace",
      workspace,
      "--no-patch-agents",
      "--format",
      "json",
    ]);
    await rm(locksPath, { recursive: true, force: true });
    run([
      "patch-agents",
      "--workspace",
      workspace,
      "--dry-run",
      "--format",
      "json",
    ]);
    await assert.rejects(access(locksPath));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("repeated init surfaces diverged hook migration warnings", async () => {
  const workspace = await temporaryWorkspace();
  const agentsPath = join(workspace, "AGENTS.md");
  try {
    await writeFile(agentsPath, "# Existing agents\n", "utf8");
    run(["init", "--workspace", workspace, "--format", "json"]);
    const trackedV1 = await simulateTrackedV1Hook(workspace, agentsPath);
    await writeFile(
      agentsPath,
      `${trackedV1}\nUser-owned addition.\n`,
      "utf8",
    );

    const repeated = JSON.parse(
      run(["init", "--workspace", workspace, "--format", "json"]).stdout,
    );
    assert.ok(
      repeated.warnings.some((warning) => warning.code === "PATCH_DIVERGED"),
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
