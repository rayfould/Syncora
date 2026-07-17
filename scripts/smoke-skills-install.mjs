import { access, mkdtemp, mkdir, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installSource = process.env.SYNCORA_INSTALL_SOURCE || repositoryRoot;
const skillsCliVersion = process.env.SKILLS_CLI_VERSION || "1.5.18";
const npmCli = process.env.npm_execpath;
const temporaryRoot = await realpath(os.tmpdir());
const sandbox = await mkdtemp(path.join(temporaryRoot, "syncora-skills-smoke-"));
const isolatedHome = path.join(sandbox, "home");
const installWorkingDirectory = path.join(sandbox, "install-cwd");
const codexHome = path.join(isolatedHome, ".codex");
const claudeHome = path.join(isolatedHome, ".claude");
const installEnvironment = {
  ...process.env,
  HOME: isolatedHome,
  USERPROFILE: isolatedHome,
  CODEX_HOME: codexHome,
  CLAUDE_CONFIG_DIR: claudeHome,
  XDG_CONFIG_HOME: path.join(isolatedHome, ".config"),
  NPM_CONFIG_USERCONFIG: path.join(sandbox, "isolated.npmrc"),
  NPM_CONFIG_CACHE: path.join(sandbox, "npm-cache"),
  CI: "1",
  DISABLE_TELEMETRY: "1",
  DO_NOT_TRACK: "1",
};

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? sandbox,
    encoding: "utf8",
    env: options.env ?? process.env,
    maxBuffer: 8 * 1024 * 1024,
  });

  if (result.status !== 0) {
    const output = [result.error?.message, result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();
    throw new Error(`${command} ${args.join(" ")} failed with status ${result.status}${output ? `\n${output}` : ""}`);
  }

  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

async function assertMissing(target, label) {
  try {
    await access(target);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`${label} unexpectedly exists: ${target}`);
}

async function inspectInstalledSkill(root, label) {
  let skill;
  try {
    skill = await readFile(path.join(root, "SKILL.md"), "utf8");
  } catch (error) {
    throw new Error(`${label} is not readable at ${root}: ${error.message}`);
  }
  if (!/^name:\s*syncora\s*$/mu.test(skill)) {
    throw new Error(`${label} SKILL.md does not identify the syncora skill`);
  }
  const runtime = path.join(root, "scripts", "syncora.mjs");
  await access(runtime);
  return {
    root,
    resolvedRoot: await realpath(root),
    skill,
    runtime,
  };
}

function sameResolvedPath(left, right) {
  const normalize = (value) =>
    process.platform === "win32"
      ? path.normalize(value).toLowerCase()
      : path.normalize(value);
  return normalize(left) === normalize(right);
}

try {
  if (!npmCli) {
    throw new Error("Run this smoke test through `npm run smoke:install` so npm_execpath is available.");
  }

  await mkdir(isolatedHome, { recursive: true });
  await mkdir(installWorkingDirectory, { recursive: true });

  console.log(`Installing Syncora globally with skills@${skillsCliVersion} from ${installSource}`);
  run(process.execPath, [
    npmCli,
    "exec",
    "--yes",
    `--package=skills@${skillsCliVersion}`,
    "--",
    "skills",
    "add",
    installSource,
    "--skill",
    "syncora",
    "--agent",
    "codex",
    "--agent",
    "cursor",
    "--agent",
    "claude-code",
    "--global",
    "--yes",
  ], {
    cwd: installWorkingDirectory,
    env: installEnvironment,
  });

  const canonicalRoot = path.join(isolatedHome, ".agents", "skills", "syncora");
  // Codex and Cursor consume the cross-agent user root directly. Claude Code
  // requires its personal skill root, which the installer links to canonical.
  const expectedDestinations = [
    ["Codex (shared canonical)", canonicalRoot],
    ["Cursor (shared canonical)", canonicalRoot],
    ["Claude Code", path.join(claudeHome, "skills", "syncora")],
  ];
  const canonical = await inspectInstalledSkill(
    canonicalRoot,
    "Canonical global installation",
  );
  if (installSource === repositoryRoot) {
    const sourceSkill = await readFile(
      path.join(repositoryRoot, "skills", "syncora", "SKILL.md"),
      "utf8",
    );
    if (canonical.skill !== sourceSkill) {
      throw new Error("Canonical global SKILL.md does not match the packaged source");
    }
  }

  for (const [agent, destination] of expectedDestinations) {
    const installed = await inspectInstalledSkill(destination, `${agent} global installation`);
    if (installed.skill !== canonical.skill) {
      throw new Error(`${agent} global SKILL.md differs from the canonical installation`);
    }
    if (!sameResolvedPath(installed.resolvedRoot, canonical.resolvedRoot)) {
      throw new Error(
        `${agent} does not resolve to the shared canonical installation: ${installed.resolvedRoot}`,
      );
    }
    run(process.execPath, [installed.runtime, "--help"], {
      cwd: installWorkingDirectory,
      env: installEnvironment,
    });
    console.log(
      `${agent}: ${destination} -> ${installed.resolvedRoot}`,
    );
  }
  run(process.execPath, [canonical.runtime, "bundle", "--help"], {
    cwd: installWorkingDirectory,
    env: installEnvironment,
  });
  run(process.execPath, [canonical.runtime, "adopt", "--help"], {
    cwd: installWorkingDirectory,
    env: installEnvironment,
  });

  await assertMissing(
    path.join(installWorkingDirectory, ".agents", "skills", "syncora"),
    "Project-local canonical installation",
  );
  await assertMissing(
    path.join(installWorkingDirectory, ".claude", "skills", "syncora"),
    "Project-local Claude Code installation",
  );
  await assertMissing(
    path.join(installWorkingDirectory, ".syncora"),
    "Workspace initialization during inert installation",
  );

  const workspace = path.join(sandbox, "workspace");
  await mkdir(workspace);
  run(process.execPath, [canonical.runtime, "setup", "--workspace", workspace], {
    env: installEnvironment,
  });
  run(process.execPath, [canonical.runtime, "validate", "--workspace", workspace], {
    env: installEnvironment,
  });
  const preflight = JSON.parse(run(process.execPath, [
    canonical.runtime,
    "checkpoint",
    "--phase",
    "pre",
    "--profile",
    "context",
    "--workspace",
    workspace,
    "--format",
    "json",
  ], { env: installEnvironment }));
  if (preflight.checkpoint.profile !== "context") {
    throw new Error("Installed-copy context preflight did not preserve its profile");
  }
  const compiled = JSON.parse(run(process.execPath, [
    canonical.runtime,
    "context",
    "--workspace",
    workspace,
    "--intent",
    "Orient to the installed workspace",
    "--mode",
    "orient",
    "--format",
    "json",
  ], { env: installEnvironment }));
  if (
    compiled.command !== "context" ||
    compiled.ok !== true ||
    compiled.request.scope !== "workspace" ||
    compiled.budget.usedCharacters > compiled.budget.maximumCharacters ||
    typeof compiled.renderedContext !== "string"
  ) {
    throw new Error("Installed-copy context compilation did not return a bounded workspace pack");
  }

  const config = JSON.parse(await readFile(path.join(workspace, ".syncora", "config.json"), "utf8"));
  if (config.schemaVersion !== 1) {
    throw new Error(`Unexpected initialized config schema: ${config.schemaVersion}`);
  }

  run(process.execPath, [canonical.runtime, "unpatch-agents", "--workspace", workspace], {
    env: installEnvironment,
  });
  console.log(
    `Skills CLI global smoke test passed for ${expectedDestinations.length} agent target(s) across the canonical store and Claude Code destination.`,
  );
} finally {
  const resolvedSandbox = await realpath(sandbox).catch(() => sandbox);
  const relativeSandbox = path.relative(temporaryRoot, resolvedSandbox);
  if (relativeSandbox && relativeSandbox !== ".." && !relativeSandbox.startsWith(`..${path.sep}`)) {
    await rm(resolvedSandbox, { recursive: true, force: true });
  } else {
    console.error(`Refusing to remove unexpected smoke-test path: ${resolvedSandbox}`);
  }
}
