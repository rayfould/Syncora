import { mkdtemp, mkdir, readFile, readdir, realpath, rm } from "node:fs/promises";
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

async function collectSkillFiles(directory) {
  const results = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await collectSkillFiles(absolutePath)));
    } else if (entry.isFile() && entry.name === "SKILL.md" && absolutePath.endsWith(`${path.sep}skills${path.sep}syncora${path.sep}SKILL.md`)) {
      results.push(absolutePath);
    }
  }
  return results;
}

try {
  if (!npmCli) {
    throw new Error("Run this smoke test through `npm run smoke:install` so npm_execpath is available.");
  }

  console.log(`Installing Syncora with skills@${skillsCliVersion} from ${installSource}`);
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
    "--yes",
    "--copy",
  ]);

  const installedSkillFiles = await collectSkillFiles(sandbox);
  if (installedSkillFiles.length === 0) {
    throw new Error("Skills CLI completed without installing skills/syncora/SKILL.md");
  }

  const installedSkillRoot = path.dirname(installedSkillFiles[0]);
  const installedSkill = await readFile(path.join(installedSkillRoot, "SKILL.md"), "utf8");
  if (!/^name:\s*syncora\s*$/mu.test(installedSkill)) {
    throw new Error("Installed SKILL.md does not identify the syncora skill");
  }

  const runtime = path.join(installedSkillRoot, "scripts", "syncora.mjs");
  run(process.execPath, [runtime, "--help"]);

  const workspace = path.join(sandbox, "workspace");
  await mkdir(workspace);
  run(process.execPath, [runtime, "init", "--workspace", workspace]);
  run(process.execPath, [runtime, "validate", "--workspace", workspace]);

  const config = JSON.parse(await readFile(path.join(workspace, ".syncora", "config.json"), "utf8"));
  if (config.schemaVersion !== 1) {
    throw new Error(`Unexpected initialized config schema: ${config.schemaVersion}`);
  }

  run(process.execPath, [runtime, "unpatch-agents", "--workspace", workspace]);
  console.log(`Skills CLI smoke test passed with ${installedSkillFiles.length} installed skill path(s).`);
} finally {
  const resolvedSandbox = await realpath(sandbox).catch(() => sandbox);
  const relativeSandbox = path.relative(temporaryRoot, resolvedSandbox);
  if (relativeSandbox && relativeSandbox !== ".." && !relativeSandbox.startsWith(`..${path.sep}`)) {
    await rm(resolvedSandbox, { recursive: true, force: true });
  } else {
    console.error(`Refusing to remove unexpected smoke-test path: ${resolvedSandbox}`);
  }
}
