import assert from "node:assert/strict";
import {
  access,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  LOCAL_CONFIG_MAX_BYTES,
  readBoundedRegularFileIfPresent,
  readSyncoraLocalConfigIfPresent,
} from "../../skills/syncora/scripts/lib/workspace.mjs";

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

async function temporaryWorkspace() {
  return realpath(await mkdtemp(join(tmpdir(), "syncora-skill-")));
}

test("dry-run plans initialization without touching the workspace", async () => {
  const workspace = await temporaryWorkspace();
  try {
    const result = run([
      "init",
      "--workspace",
      workspace,
      "--dry-run",
      "--format",
      "json",
    ]);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.dryRun, true);
    await assert.rejects(access(join(workspace, ".syncora")));
    await assert.rejects(access(join(workspace, "local")));
    await assert.rejects(access(join(workspace, "AGENTS.md")));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("setup is the one-command greenfield initialization surface", async () => {
  const workspace = await temporaryWorkspace();
  try {
    const first = JSON.parse(run([
      "setup",
      "--workspace",
      workspace,
      "--format",
      "json",
    ]).stdout);
    assert.equal(first.command, "setup");
    assert.equal(first.ok, true);
    await access(join(workspace, ".syncora", "config.json"));
    await access(join(workspace, "local", "index.md"));
    assert.equal(
      await readFile(join(workspace, "local", ".syncora", ".gitignore"), "utf8"),
      "*\n!.gitignore\n",
    );
    await access(join(workspace, "AGENTS.md"));

    const second = JSON.parse(run([
      "setup",
      "--workspace",
      workspace,
      "--format",
      "json",
    ]).stdout);
    assert.equal(second.command, "setup");
    assert.equal(
      second.changes.every((change) => change.action === "unchanged"),
      true,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("setup atomically replaces an exact predecessor workflow without losing unrelated AGENTS content", async () => {
  const workspace = await temporaryWorkspace();
  const predecessorAgents = [
    "# Custom preface",
    "",
    "Preserve this project-specific instruction.",
    "",
    "<!-- BEGIN KNOWLEDGE GRAPH WORKFLOW -->",
    "Load the predecessor graph on every request.",
    "<!-- END KNOWLEDGE GRAPH WORKFLOW -->",
    "",
    "# Custom suffix",
    "",
    "Keep this instruction too.",
    "",
  ].join("\n");
  try {
    await writeFile(join(workspace, "AGENTS.md"), predecessorAgents, "utf8");

    const output = JSON.parse(run([
      "setup",
      "--workspace",
      workspace,
      "--format",
      "json",
    ]).stdout);

    assert.equal(output.ok, true);
    assert.equal(output.command, "setup");
    await access(join(workspace, ".syncora", "config.json"));
    await access(join(workspace, "local", "index.md"));
    const patchedAgents = await readFile(join(workspace, "AGENTS.md"), "utf8");
    assert.match(patchedAgents, /# Custom preface/);
    assert.match(patchedAgents, /Preserve this project-specific instruction\./);
    assert.match(patchedAgents, /# Custom suffix/);
    assert.match(patchedAgents, /Keep this instruction too\./);
    assert.doesNotMatch(patchedAgents, /BEGIN KNOWLEDGE GRAPH WORKFLOW/);
    assert.doesNotMatch(patchedAgents, /END KNOWLEDGE GRAPH WORKFLOW/);
    assert.match(patchedAgents, /syncora-agent-hook:begin v7/);
    assert.equal(
      (patchedAgents.match(/syncora-agent-hook:begin v7/g) ?? []).length,
      1,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("setup refuses residual custom activation outside an exact predecessor block", async () => {
  const workspace = await temporaryWorkspace();
  const agentsPath = join(workspace, "AGENTS.md");
  const residualActivation = "Always load local/index.md before every task.\n";
  const predecessorAgents = [
    "# Project instructions",
    "",
    "<!-- BEGIN KNOWLEDGE GRAPH WORKFLOW -->",
    "Load the predecessor graph on every request.",
    "<!-- END KNOWLEDGE GRAPH WORKFLOW -->",
    "",
    residualActivation.trimEnd(),
    "",
  ].join("\n");
  try {
    await writeFile(agentsPath, predecessorAgents, "utf8");

    const refused = run([
      "setup",
      "--workspace",
      workspace,
      "--confirm-predecessor-reviewed",
      "--format",
      "json",
    ], 1);
    const failure = JSON.parse(refused.stderr);
    assert.equal(failure.error.code, "MIGRATE015");
    assert.deepEqual(
      failure.error.details.customPredecessorAgentFiles,
      ["AGENTS.md"],
    );
    assert.equal(failure.error.details.predecessorReviewConfirmed, true);
    assert.equal(await readFile(agentsPath, "utf8"), predecessorAgents);
    await assert.rejects(access(join(workspace, ".syncora")));
    await assert.rejects(access(join(workspace, "local")));

    await writeFile(
      agentsPath,
      predecessorAgents.replace(residualActivation, ""),
      "utf8",
    );
    const output = JSON.parse(run([
      "setup",
      "--workspace",
      workspace,
      "--confirm-predecessor-reviewed",
      "--format",
      "json",
    ]).stdout);
    assert.equal(output.ok, true);
    const patched = await readFile(agentsPath, "utf8");
    assert.doesNotMatch(patched, /BEGIN KNOWLEDGE GRAPH WORKFLOW/);
    assert.doesNotMatch(patched, /Always load local\/index\.md/);
    assert.match(patched, /syncora-agent-hook:begin v7/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("setup without agent patching refuses an exact predecessor workflow without partial initialization", async () => {
  const workspace = await temporaryWorkspace();
  const predecessorAgents = Buffer.from([
    "# Preserve exactly",
    "",
    "<!-- BEGIN KNOWLEDGE GRAPH WORKFLOW -->",
    "Load the predecessor graph on every request.",
    "<!-- END KNOWLEDGE GRAPH WORKFLOW -->",
    "",
    "Keep this suffix.",
    "",
  ].join("\n"), "utf8");
  try {
    await writeFile(join(workspace, "AGENTS.md"), predecessorAgents);

    const result = run([
      "setup",
      "--workspace",
      workspace,
      "--no-patch-agents",
      "--format",
      "json",
    ], 1);

    const failure = JSON.parse(result.stderr);
    assert.equal(failure.error.code, "MIGRATE015");
    assert.match(failure.error.message, /patching is enabled/);
    assert.deepEqual(
      await readFile(join(workspace, "AGENTS.md")),
      predecessorAgents,
    );
    await assert.rejects(access(join(workspace, ".syncora")));
    await assert.rejects(access(join(workspace, "local")));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("setup requires review before replacing a possible custom predecessor-only workflow", async () => {
  const workspace = await temporaryWorkspace();
  const agentsPath = join(workspace, "AGENTS.md");
  const predecessor = "# Project instructions\n\nAlways load local/index.md before every task.\n";
  const reviewed = "# Project instructions\n\nKeep the project formatting conventions.\n";
  try {
    await writeFile(agentsPath, predecessor, "utf8");
    const refused = run([
      "setup",
      "--workspace",
      workspace,
      "--format",
      "json",
    ], 1);
    const failure = JSON.parse(refused.stderr);
    assert.equal(failure.error.code, "MIGRATE015");
    assert.match(failure.error.message, /custom predecessor activation/);
    assert.deepEqual(failure.error.details.customPredecessorAgentFiles, ["AGENTS.md"]);
    assert.equal(await readFile(agentsPath, "utf8"), predecessor);
    await assert.rejects(access(join(workspace, ".syncora")));
    await assert.rejects(access(join(workspace, "local")));

    await writeFile(agentsPath, reviewed, "utf8");
    const output = JSON.parse(run([
      "setup",
      "--workspace",
      workspace,
      "--confirm-predecessor-reviewed",
      "--format",
      "json",
    ]).stdout);
    assert.equal(output.ok, true);
    const patched = await readFile(agentsPath, "utf8");
    assert.match(patched, /Keep the project formatting conventions\./);
    assert.match(patched, /syncora-agent-hook:begin v7/);
    assert.doesNotMatch(patched, /Always load local\/index\.md/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("patch-agents cannot bypass predecessor review after setup opts out", async () => {
  const workspace = await temporaryWorkspace();
  const agentsPath = join(workspace, "AGENTS.md");
  const predecessor = "# Project instructions\n\nAlways load local/index.md before every task.\n";
  const reviewed = "# Project instructions\n\nKeep the project formatting conventions.\n";
  try {
    await writeFile(agentsPath, predecessor, "utf8");
    const setup = JSON.parse(run([
      "setup",
      "--workspace",
      workspace,
      "--no-patch-agents",
      "--format",
      "json",
    ]).stdout);
    assert.equal(setup.ok, true);
    assert.doesNotMatch(await readFile(agentsPath, "utf8"), /syncora-agent-hook/);

    const unreviewed = run([
      "patch-agents",
      "--workspace",
      workspace,
      "--format",
      "json",
    ], 1);
    assert.equal(JSON.parse(unreviewed.stderr).error.code, "PATCH005");

    const refused = run([
      "patch-agents",
      "--workspace",
      workspace,
      "--confirm-predecessor-reviewed",
      "--format",
      "json",
    ], 1);
    const failure = JSON.parse(refused.stderr);
    assert.equal(failure.error.code, "PATCH005");
    assert.match(failure.error.message, /predecessor activation remains/);
    assert.equal(await readFile(agentsPath, "utf8"), predecessor);

    await writeFile(agentsPath, reviewed, "utf8");
    const patched = JSON.parse(run([
      "patch-agents",
      "--workspace",
      workspace,
      "--confirm-predecessor-reviewed",
      "--format",
      "json",
    ]).stdout);
    assert.equal(patched.ok, true);
    const agents = await readFile(agentsPath, "utf8");
    assert.match(agents, /Keep the project formatting conventions\./);
    assert.match(agents, /syncora-agent-hook:begin v7/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("normal init refuses a legacy graph and predecessor workflow without changing bytes", async () => {
  const workspace = await temporaryWorkspace();
  const legacyIndex = Buffer.from("# Legacy graph\n\nPreserve this authority.\n", "utf8");
  const legacyAgents = Buffer.from([
    "# Custom instructions",
    "",
    "<!-- BEGIN KNOWLEDGE GRAPH WORKFLOW -->",
    "Load the predecessor graph on every request.",
    "<!-- END KNOWLEDGE GRAPH WORKFLOW -->",
    "",
  ].join("\n"), "utf8");
  try {
    await mkdir(join(workspace, "local"));
    await writeFile(join(workspace, "local", "index.md"), legacyIndex);
    await writeFile(join(workspace, "AGENTS.md"), legacyAgents);

    for (const dryRun of [true, false]) {
      const result = run([
        "init",
        "--workspace",
        workspace,
        ...(dryRun ? ["--dry-run"] : []),
        "--format",
        "json",
      ], 1);
      const failure = JSON.parse(result.stderr);
      assert.equal(failure.error.code, "MIGRATE015");
      assert.match(failure.error.message, /reversible adoption workflow/);
      assert.deepEqual(await readFile(join(workspace, "local", "index.md")), legacyIndex);
      assert.deepEqual(await readFile(join(workspace, "AGENTS.md")), legacyAgents);
      await assert.rejects(access(join(workspace, ".syncora")));
      await assert.rejects(access(join(workspace, "local", "knowledge")));
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a precreated runtime config cannot disguise a legacy graph as initialized", async () => {
  const workspace = await temporaryWorkspace();
  const legacyIndex = Buffer.from("# Legacy graph behind stale config\n", "utf8");
  try {
    await mkdir(join(workspace, "local"));
    await writeFile(join(workspace, "local", "index.md"), legacyIndex);
    await mkdir(join(workspace, ".syncora"));
    await writeFile(
      join(workspace, ".syncora", "config.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        graphRoot: "local",
        agentPatching: { enabled: false },
        maintenance: {
          mode: "hybrid",
          fullValidationEveryActivations: 50,
          fullValidationMaxAgeHours: 168,
        },
        context: {
          defaultBudget: "standard",
          characterBudgets: {
            lean: 4800,
            standard: 12000,
            deep: 32000,
          },
        },
      }, null, 2)}\n`,
    );
    const beforeConfig = await readFile(join(workspace, ".syncora", "config.json"));

    const result = run([
      "init",
      "--workspace",
      workspace,
      "--format",
      "json",
    ], 1);
    assert.equal(JSON.parse(result.stderr).error.code, "MIGRATE015");
    assert.deepEqual(await readFile(join(workspace, "local", "index.md")), legacyIndex);
    assert.deepEqual(await readFile(join(workspace, ".syncora", "config.json")), beforeConfig);
    await assert.rejects(access(join(workspace, "local", "knowledge")));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("default initialization is hub-first, patched, and byte-idempotent", async () => {
  const workspace = await temporaryWorkspace();
  const watched = [
    ".syncora/config.json",
    ".syncora/.gitignore",
    ".syncora/state.json",
    "local/index.md",
    "local/knowledge/projects/workspace.md",
    "AGENTS.md",
    ".claude/CLAUDE.md",
  ];

  try {
    run(["init", "--workspace", workspace, "--format", "json"]);
    const initializedConfig = JSON.parse(
      await readFile(join(workspace, ".syncora", "config.json"), "utf8"),
    );
    assert.deepEqual(initializedConfig.maintenance, {
      mode: "hybrid",
      fullValidationEveryActivations: 50,
      fullValidationMaxAgeHours: 168,
    });
    assert.equal("markerVersion" in initializedConfig.agentPatching, false);
    const before = new Map();
    for (const path of watched) {
      before.set(path, await readFile(join(workspace, ...path.split("/"))));
    }

    const second = JSON.parse(
      run(["init", "--workspace", workspace, "--format", "json"]).stdout,
    );
    assert.ok(second.changes.every((change) => change.action === "unchanged"));
    for (const path of watched) {
      assert.deepEqual(
        await readFile(join(workspace, ...path.split("/"))),
        before.get(path),
      );
    }

    const doctor = JSON.parse(
      run(["doctor", "--workspace", workspace, "--format", "json"]).stdout,
    );
    assert.equal(doctor.ok, true);
    assert.ok(
      doctor.checks.some(
        (check) => check.code === "PATCH004" && check.status === "ok",
      ),
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("initialization can opt out of agent patching", async () => {
  const workspace = await temporaryWorkspace();
  try {
    run([
      "init",
      "--workspace",
      workspace,
      "--no-patch-agents",
      "--format",
      "json",
    ]);
    const config = JSON.parse(
      await readFile(join(workspace, ".syncora", "config.json"), "utf8"),
    );
    assert.equal(config.agentPatching.enabled, false);
    await assert.rejects(access(join(workspace, "AGENTS.md")));
    await assert.rejects(access(join(workspace, ".claude", "CLAUDE.md")));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("external graph roots fail closed and require an exact allowlist", async () => {
  const workspace = await temporaryWorkspace();
  const external = await temporaryWorkspace();
  const link = join(workspace, "local");
  try {
    await symlink(
      external,
      link,
      process.platform === "win32" ? "junction" : "dir",
    );

    const rejected = run(
      ["init", "--workspace", workspace, "--format", "json"],
      1,
    );
    assert.match(rejected.stderr, /WRITE002/);

    const accepted = JSON.parse(
      run([
        "init",
        "--workspace",
        workspace,
        "--allow-external-graph-root",
        external,
        "--no-patch-agents",
        "--format",
        "json",
      ]).stdout,
    );
    assert.equal(accepted.externalGraphRoot, true);
    await access(join(external, "index.md"));
    const localConfig = JSON.parse(
      await readFile(join(workspace, ".syncora", "local.json"), "utf8"),
    );
    assert.deepEqual(localConfig.externalGraphRoots, [external]);
  } finally {
    await rm(link, { recursive: true, force: true }).catch(() => undefined);
    await rm(workspace, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

test("mutating commands reject relative workspace paths", () => {
  const result = run(
    ["init", "--workspace", ".", "--format", "json"],
    1,
  );
  assert.match(result.stderr, /WORKSPACE002/);
});

test("future config schemas remain read-only", async () => {
  const workspace = await temporaryWorkspace();
  try {
    run([
      "init",
      "--workspace",
      workspace,
      "--no-patch-agents",
      "--format",
      "json",
    ]);
    const configPath = join(workspace, ".syncora", "config.json");
    await writeFile(configPath, '{"schemaVersion":2}\n', "utf8");

    const initResult = run(
      ["init", "--workspace", workspace, "--format", "json"],
      1,
    );
    assert.match(initResult.stderr, /SCHEMA001/);

    const patchResult = run(
      ["patch-agents", "--workspace", workspace, "--format", "json"],
      1,
    );
    assert.match(patchResult.stderr, /SCHEMA001/);

    const doctor = JSON.parse(
      run(
        ["doctor", "--workspace", workspace, "--format", "json"],
        1,
      ).stdout,
    );
    assert.equal(doctor.ok, false);
    assert.ok(doctor.checks.some((check) => check.code === "SCHEMA001"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("malformed maintenance settings fail consistently across init, doctor, and initialized commands", async () => {
  const workspace = await temporaryWorkspace();
  try {
    run([
      "init",
      "--workspace",
      workspace,
      "--no-patch-agents",
      "--format",
      "json",
    ]);
    const configPath = join(workspace, ".syncora", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.maintenance.fullValidationEveryActivation = 5;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

    assert.match(
      run(["init", "--workspace", workspace, "--format", "json"], 1).stderr,
      /CONFIG001/,
    );
    const doctor = JSON.parse(
      run(["doctor", "--workspace", workspace, "--format", "json"], 1).stdout,
    );
    assert.equal(doctor.ok, false);
    assert.ok(
      doctor.checks.some(
        (item) => item.code === "CONFIG001" && item.status === "error",
      ),
    );
    assert.match(
      run(["search", "--workspace", workspace, "--query", "workspace"], 1)
        .stderr,
      /CONFIG001/,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("doctor observes a missing lock directory without creating it", async () => {
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
    await assert.rejects(access(locksPath));
    const doctor = JSON.parse(
      run(["doctor", "--workspace", workspace, "--format", "json"]).stdout,
    );
    assert.equal(doctor.ok, true);
    assert.ok(
      doctor.checks.some(
        (item) => item.code === "LOCK001" && item.status === "ok",
      ),
    );
    assert.ok(
      doctor.checks.some(
        (item) => item.code === "PATCH005" && item.status === "ok",
      ),
    );
    await assert.rejects(access(locksPath));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("doctor distinguishes active and malformed recovery guards without mutation", async () => {
  const workspace = await temporaryWorkspace();
  const locksPath = join(workspace, ".syncora", "locks");
  const checkpointGuard = join(locksPath, "checkpoint.lock.recovery");
  const patchGuard = join(locksPath, "agent-patcher.lock.recovery");
  try {
    run([
      "init",
      "--workspace",
      workspace,
      "--no-patch-agents",
      "--format",
      "json",
    ]);
    await mkdir(locksPath, { recursive: true });
    const validRecord = `${JSON.stringify({
      schemaVersion: 1,
      token: "00000000-0000-4000-8000-000000000031",
      pid: process.pid,
      createdAt: new Date().toISOString(),
    })}\n`;
    await writeFile(checkpointGuard, validRecord, "utf8");
    const active = JSON.parse(
      run(["doctor", "--workspace", workspace, "--format", "json"]).stdout,
    );
    assert.ok(
      active.checks.some(
        (item) =>
          item.code === "LOCK001" &&
          item.status === "warn" &&
          /recovery guard is held/.test(item.message),
      ),
    );
    assert.equal(await readFile(checkpointGuard, "utf8"), validRecord);

    await rm(checkpointGuard);
    await writeFile(patchGuard, "{malformed", "utf8");
    const malformed = JSON.parse(
      run(["doctor", "--workspace", workspace, "--format", "json"], 1).stdout,
    );
    assert.ok(
      malformed.checks.some(
        (item) =>
          item.code === "PATCH005" &&
          item.status === "error" &&
          /manually removing an orphaned guard/.test(item.message),
      ),
    );
    assert.equal(await readFile(patchGuard, "utf8"), "{malformed");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("doctor and both runtimes reject a non-directory lock root without mutation", async () => {
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
    await writeFile(locksPath, "preserve-me\n", "utf8");

    const doctor = JSON.parse(
      run(["doctor", "--workspace", workspace, "--format", "json"], 1)
        .stdout,
    );
    assert.equal(doctor.ok, false);
    assert.ok(
      doctor.checks.some(
        (item) => item.code === "LOCK001" && item.status === "error",
      ),
    );
    assert.ok(
      doctor.checks.some(
        (item) => item.code === "PATCH005" && item.status === "error",
      ),
    );
    assert.match(
      run([
        "checkpoint",
        "--phase",
        "pre",
        "--profile",
        "checkpoint",
        "--workspace",
        workspace,
      ], 1).stderr,
      /LOCK001/,
    );
    assert.match(
      run([
        "patch-agents",
        "--workspace",
        workspace,
        "--confirm-predecessor-reviewed",
      ], 1).stderr,
      /PATCH005/,
    );
    assert.equal(await readFile(locksPath, "utf8"), "preserve-me\n");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("doctor reports unsafe locks even when runtime config is missing", async () => {
  const workspace = await temporaryWorkspace();
  const runtimeRoot = join(workspace, ".syncora");
  const locksPath = join(runtimeRoot, "locks");
  try {
    await mkdir(runtimeRoot);
    await writeFile(locksPath, "preserve-me\n", "utf8");

    const doctor = JSON.parse(
      run(["doctor", "--workspace", workspace, "--format", "json"], 1)
        .stdout,
    );
    assert.equal(doctor.ok, false);
    assert.ok(
      doctor.checks.some(
        (item) => item.code === "CONFIG001" && item.status === "warn",
      ),
    );
    assert.ok(
      doctor.checks.some(
        (item) => item.code === "LOCK001" && item.status === "error",
      ),
    );
    assert.ok(
      doctor.checks.some(
        (item) => item.code === "PATCH005" && item.status === "error",
      ),
    );
    assert.equal(await readFile(locksPath, "utf8"), "preserve-me\n");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("doctor and both runtimes reject a junction lock root without following it", async (t) => {
  const workspace = await temporaryWorkspace();
  const target = await temporaryWorkspace();
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
    try {
      await symlink(
        target,
        locksPath,
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      t.skip(`Directory links unavailable: ${error.message}`);
      return;
    }

    const doctor = JSON.parse(
      run(["doctor", "--workspace", workspace, "--format", "json"], 1)
        .stdout,
    );
    assert.equal(doctor.ok, false);
    assert.ok(
      doctor.checks.some(
        (item) => item.code === "LOCK001" && item.status === "error",
      ),
    );
    assert.ok(
      doctor.checks.some(
        (item) => item.code === "PATCH005" && item.status === "error",
      ),
    );
    assert.match(
      run([
        "checkpoint",
        "--phase",
        "pre",
        "--profile",
        "checkpoint",
        "--workspace",
        workspace,
      ], 1).stderr,
      /LOCK001/,
    );
    assert.match(
      run([
        "patch-agents",
        "--workspace",
        workspace,
        "--confirm-predecessor-reviewed",
      ], 1).stderr,
      /PATCH005/,
    );
    await assert.rejects(access(join(target, "checkpoint.lock")));
    await assert.rejects(access(join(target, "agent-patcher.lock")));
  } finally {
    await rm(locksPath, { force: true }).catch(() => undefined);
    await rm(workspace, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});

test("local allowlist rejects non-regular, oversized, and invalid UTF-8 files", async () => {
  const workspace = await temporaryWorkspace();
  const localConfigPath = join(workspace, ".syncora", "local.json");
  try {
    run([
      "init",
      "--workspace",
      workspace,
      "--no-patch-agents",
      "--format",
      "json",
    ]);

    await mkdir(localConfigPath);
    assert.match(
      run(["init", "--workspace", workspace], 1).stderr,
      /CONFIG002/,
    );
    await rm(localConfigPath, { recursive: true });

    await writeFile(localConfigPath, Buffer.alloc(LOCAL_CONFIG_MAX_BYTES + 1));
    assert.match(
      run(["init", "--workspace", workspace], 1).stderr,
      /CONFIG002/,
    );

    await writeFile(localConfigPath, Buffer.from([0xff]));
    assert.match(
      run(["init", "--workspace", workspace], 1).stderr,
      /CONFIG002/,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a local allowlist symlink fails closed without reading or changing its target", async (t) => {
  const workspace = await temporaryWorkspace();
  const targetRoot = await temporaryWorkspace();
  const target = join(targetRoot, "target.json");
  const localConfigPath = join(workspace, ".syncora", "local.json");
  try {
    run([
      "init",
      "--workspace",
      workspace,
      "--no-patch-agents",
      "--format",
      "json",
    ]);
    await writeFile(target, "preserve-me\n", "utf8");
    try {
      await symlink(target, localConfigPath, "file");
    } catch (error) {
      t.skip(`File symbolic links unavailable: ${error.message}`);
      return;
    }

    assert.match(
      run(["init", "--workspace", workspace], 1).stderr,
      /CONFIG002/,
    );
    assert.equal(await readFile(target, "utf8"), "preserve-me\n");
  } finally {
    await rm(localConfigPath, { force: true }).catch(() => undefined);
    await rm(workspace, { recursive: true, force: true });
    await rm(targetRoot, { recursive: true, force: true });
  }
});

test("local allowlist stable reads reject an in-place concurrent change", async () => {
  const workspace = await temporaryWorkspace();
  const localConfigPath = join(workspace, ".syncora", "local.json");
  try {
    run([
      "init",
      "--workspace",
      workspace,
      "--no-patch-agents",
      "--format",
      "json",
    ]);
    const before = `${JSON.stringify({
      schemaVersion: 1,
      externalGraphRoots: [join(workspace, "a")],
    })}\n`;
    const after = `${JSON.stringify({
      schemaVersion: 1,
      externalGraphRoots: [join(workspace, "b")],
    })}\n`;
    assert.equal(Buffer.byteLength(before), Buffer.byteLength(after));
    await writeFile(localConfigPath, before, "utf8");

    await assert.rejects(
      readSyncoraLocalConfigIfPresent(workspace, {
        afterRead: () => writeFile(localConfigPath, after, "utf8"),
      }),
      (error) => error?.code === "CONFIG002" && /changed/.test(error.message),
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("local allowlist validates a replacement handle before reading it", async () => {
  const workspace = await temporaryWorkspace();
  const targetRoot = await temporaryWorkspace();
  const localConfigPath = join(workspace, ".syncora", "local.json");
  const target = join(targetRoot, "replacement.json");
  try {
    run([
      "init",
      "--workspace",
      workspace,
      "--no-patch-agents",
      "--format",
      "json",
    ]);
    await writeFile(
      localConfigPath,
      '{"schemaVersion":1,"externalGraphRoots":[]}\n',
      "utf8",
    );
    await writeFile(target, Buffer.alloc(LOCAL_CONFIG_MAX_BYTES + 1, 0x61));

    await assert.rejects(
      readSyncoraLocalConfigIfPresent(workspace, {
        beforeOpen: async () => {
          await rm(localConfigPath);
          await link(target, localConfigPath);
        },
      }),
      (error) => error?.code === "CONFIG002" && /changed/.test(error.message),
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(targetRoot, { recursive: true, force: true });
  }
});

test("local allowlist validates its parent binding before reading", async (t) => {
  const workspace = await temporaryWorkspace();
  const external = await temporaryWorkspace();
  const runtimeRoot = join(workspace, ".syncora");
  const retainedRuntimeRoot = join(workspace, ".syncora-retained");
  const localConfigPath = join(runtimeRoot, "local.json");
  const probe = join(workspace, ".link-probe");
  try {
    try {
      await symlink(
        external,
        probe,
        process.platform === "win32" ? "junction" : "dir",
      );
      await rm(probe, { force: true });
    } catch (error) {
      t.skip(`Directory links unavailable: ${error.message}`);
      return;
    }
    run([
      "init",
      "--workspace",
      workspace,
      "--no-patch-agents",
      "--format",
      "json",
    ]);
    await writeFile(
      localConfigPath,
      '{"schemaVersion":1,"externalGraphRoots":[]}\n',
      "utf8",
    );
    await link(localConfigPath, join(external, "local.json"));

    await assert.rejects(
      readSyncoraLocalConfigIfPresent(workspace, {
        beforeOpen: async () => {
          await rename(runtimeRoot, retainedRuntimeRoot);
          await symlink(
            external,
            runtimeRoot,
            process.platform === "win32" ? "junction" : "dir",
          );
        },
      }),
      (error) => error?.code === "CONFIG002" && /changed/.test(error.message),
    );
  } finally {
    await rm(probe, { force: true }).catch(() => undefined);
    await rm(runtimeRoot, { force: true }).catch(() => undefined);
    await rm(workspace, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

test("a lock released during diagnosis is treated as transient absence", async () => {
  const workspace = await temporaryWorkspace();
  const locksRoot = join(workspace, ".syncora", "locks");
  const lockPath = join(locksRoot, "checkpoint.lock");
  try {
    run([
      "init",
      "--workspace",
      workspace,
      "--no-patch-agents",
      "--format",
      "json",
    ]);
    await rm(locksRoot, { recursive: true, force: true });
    await mkdir(locksRoot, { recursive: true });
    await writeFile(lockPath, '{"pid":123}\n', "utf8");

    const observation = await readBoundedRegularFileIfPresent(lockPath, {
      containmentRoot: locksRoot,
      maximumBytes: 4_096,
      code: "LOCK001",
      label: "checkpoint lock",
      allowTransientMissing: true,
      afterRead: () => rm(lockPath),
    });
    assert.equal(observation, null);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("future local allowlist schemas remain untouched and read-only", async () => {
  const workspace = await temporaryWorkspace();
  const localConfigPath = join(workspace, ".syncora", "local.json");
  const future = '{"schemaVersion":2,"externalGraphRoots":[]}\n';
  try {
    run([
      "init",
      "--workspace",
      workspace,
      "--no-patch-agents",
      "--format",
      "json",
    ]);
    await writeFile(localConfigPath, future, "utf8");

    assert.match(
      run(["init", "--workspace", workspace], 1).stderr,
      /SCHEMA001/,
    );
    const doctor = JSON.parse(
      run(["doctor", "--workspace", workspace, "--format", "json"], 1)
        .stdout,
    );
    assert.equal(doctor.ok, false);
    assert.ok(doctor.checks.some((item) => item.code === "SCHEMA001"));
    assert.equal(await readFile(localConfigPath, "utf8"), future);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
