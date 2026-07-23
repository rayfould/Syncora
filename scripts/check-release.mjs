import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillRoot = path.join(repositoryRoot, "skills", "syncora");
const maxFileBytes = 1024 * 1024;

const requiredPaths = [
  ".github/workflows/syncora-skill.yml",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "README.md",
  "RELEASING.md",
  "SECURITY.md",
  "docs/getting-started.md",
  "docs/legacy-kg-adoption.md",
  "docs/release-checklist.md",
  "docs/release-status.md",
  "docs/upgrade-and-uninstall.md",
  "docs/skill/architecture.md",
  "docs/skill/governed-capture-contract.md",
  "docs/skill/implementation-plan.md",
  "package.json",
  "package-lock.json",
  "scripts/smoke-legacy-adoption.mjs",
  "skills/syncora/SKILL.md",
  "skills/syncora/agents/openai.yaml",
  "skills/syncora/assets/agent-hooks/shared.md",
  "skills/syncora/assets/schemas/adoption-bundle-v1.schema.json",
  "skills/syncora/assets/schemas/authority-promotion-manifest-v2.schema.json",
  "skills/syncora/references/context.md",
  "skills/syncora/references/capture.md",
  "skills/syncora/references/drift.md",
  "skills/syncora/references/agent-patching.md",
  "skills/syncora/references/initialize.md",
  "skills/syncora/references/legacy-adoption.md",
  "skills/syncora/scripts/lib/adoption-bundle.mjs",
  "skills/syncora/scripts/lib/adopt.mjs",
  "skills/syncora/scripts/lib/autonomous-capture.mjs",
  "skills/syncora/scripts/lib/file-transaction.mjs",
  "skills/syncora/scripts/lib/drift-check.mjs",
  "skills/syncora/scripts/lib/drift-governance.mjs",
  "skills/syncora/scripts/lib/drift-source.mjs",
  "skills/syncora/scripts/lib/drift-state.mjs",
  "skills/syncora/scripts/lib/governed-apply.mjs",
  "skills/syncora/scripts/lib/governed-capture.mjs",
  "skills/syncora/scripts/lib/governed-environment.mjs",
  "skills/syncora/scripts/lib/governed-review.mjs",
  "skills/syncora/scripts/lib/immutable-file.mjs",
  "skills/syncora/scripts/lib/projected-graph.mjs",
  "skills/syncora/scripts/lib/proposal-provenance.mjs",
  "skills/syncora/scripts/lib/proposal-schema.mjs",
  "skills/syncora/scripts/lib/proposal-semantics.mjs",
  "skills/syncora/scripts/lib/proposal-store.mjs",
  "skills/syncora/scripts/lib/review-artifact-policy.mjs",
  "skills/syncora/scripts/lib/review-artifact.mjs",
  "skills/syncora/scripts/lib/target-bindings.mjs",
  "skills/syncora/scripts/lib/task-context.mjs",
  "skills/syncora/scripts/lib/writer-interlock.mjs",
  "skills/syncora/scripts/syncora.mjs",
];

const allowedRootEntries = new Set([
  ".git",
  ".gitattributes",
  ".github",
  ".gitignore",
  "AGENTS.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "README.md",
  "RELEASING.md",
  "SECURITY.md",
  "docs",
  "node_modules",
  "package-lock.json",
  "package.json",
  "scripts",
  "skills",
  "tests",
]);

const allowedSkillEntries = new Set([
  "SKILL.md",
  "agents",
  "assets",
  "references",
  "scripts",
]);

const forbiddenRootEntries = new Set([
  ".syncora",
  "api",
  "db",
  "dist",
  "drizzle",
  "extensions",
  "local",
  "site",
  "src",
]);

const privatePathPatterns = [
  /[A-Za-z]:\\Users\\[^\\\s]+/u,
  /\/(?:Users|home)\/[^/\s]+/u,
];

const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/u,
];

const errors = [];

function relative(absolutePath) {
  return path.relative(repositoryRoot, absolutePath).split(path.sep).join("/");
}

function inside(candidate, root) {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== "..");
}

async function exists(relativePath) {
  try {
    await lstat(path.join(repositoryRoot, relativePath));
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function walk(directory) {
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (directory === repositoryRoot && [".git", "node_modules"].includes(entry.name)) continue;

    const absolutePath = path.join(directory, entry.name);
    const stats = await lstat(absolutePath);
    const displayPath = relative(absolutePath);

    if (stats.isSymbolicLink()) {
      errors.push(`${displayPath}: symbolic links are not allowed in a release checkout`);
      continue;
    }

    if (stats.isDirectory()) {
      files.push(...(await walk(absolutePath)));
      continue;
    }

    if (!stats.isFile()) {
      errors.push(`${displayPath}: unsupported filesystem entry`);
      continue;
    }

    if (stats.size > maxFileBytes) {
      errors.push(`${displayPath}: exceeds the 1 MiB release file limit`);
    }
    files.push(absolutePath);
  }

  return files;
}

for (const requiredPath of requiredPaths) {
  if (!(await exists(requiredPath))) errors.push(`${requiredPath}: required release file is missing`);
}

const rootEntries = await readdir(repositoryRoot);
for (const entry of rootEntries) {
  if (!allowedRootEntries.has(entry)) errors.push(`${entry}: unexpected release-root entry`);
  if (forbiddenRootEntries.has(entry)) errors.push(`${entry}: private application or generated root is forbidden`);
}

const skillEntries = await readdir(skillRoot);
for (const entry of skillEntries) {
  if (!allowedSkillEntries.has(entry)) errors.push(`skills/syncora/${entry}: unexpected installed-skill entry`);
}

const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
if (packageJson.private !== true) errors.push("package.json: must remain private because Syncora is installed from GitHub, not npm");
if (packageJson.dependencies || packageJson.optionalDependencies || packageJson.peerDependencies) {
  errors.push("package.json: the portable runtime must not declare production dependencies");
}

const cliSource = await readFile(path.join(skillRoot, "scripts", "lib", "cli.mjs"), "utf8");
const runtimeVersion = cliSource.match(/export const VERSION = ["']([^"']+)["']/u)?.[1];
if (!runtimeVersion) errors.push("skills/syncora/scripts/lib/cli.mjs: VERSION export is missing");
if (runtimeVersion && runtimeVersion !== packageJson.version) {
  errors.push(`version mismatch: package.json=${packageJson.version}, runtime=${runtimeVersion}`);
}

const skillSource = await readFile(path.join(skillRoot, "SKILL.md"), "utf8");
const frontmatter = skillSource.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/u)?.[1];
if (!frontmatter) {
  errors.push("skills/syncora/SKILL.md: valid YAML frontmatter is missing");
} else {
  const keys = frontmatter
    .split(/\r?\n/u)
    .filter((line) => /^[A-Za-z0-9_-]+\s*:/u.test(line))
    .map((line) => line.slice(0, line.indexOf(":")).trim())
    .sort();
  if (JSON.stringify(keys) !== JSON.stringify(["description", "name"])) {
    errors.push(`skills/syncora/SKILL.md: frontmatter keys must be exactly name and description (found ${keys.join(", ")})`);
  }
  if (!/^name:\s*syncora\s*$/mu.test(frontmatter)) {
    errors.push("skills/syncora/SKILL.md: name must be syncora");
  }
  if (!/development preview/iu.test(frontmatter)) {
    errors.push("skills/syncora/SKILL.md: public description must label the development preview");
  }
  const description = frontmatter.match(/^description:\s*(.+)$/mu)?.[1];
  if (!description || description.length > 600) {
    errors.push(
      "skills/syncora/SKILL.md: public description must be present and no longer than 600 characters",
    );
  }
}

for (const requiredPublicText of ["## Quick start", "## Agent instructions"]) {
  if (!skillSource.includes(requiredPublicText)) {
    errors.push(`skills/syncora/SKILL.md: approachable public guidance is missing (${requiredPublicText})`);
  }
}
const quickStartIndex = skillSource.indexOf("## Quick start");
const agentInstructionsIndex = skillSource.indexOf("## Agent instructions");
if (quickStartIndex > agentInstructionsIndex) {
  errors.push(
    "skills/syncora/SKILL.md: public quick start must appear before internal agent instructions",
  );
}
const quickStart = skillSource.slice(quickStartIndex, agentInstructionsIndex);
for (const publicIntent of [
  "Set up Syncora in this project.",
  "Update Syncora.",
  "Repair Syncora in this project.",
  "Remove Syncora from this project.",
]) {
  if (!quickStart.includes(publicIntent)) {
    errors.push(`skills/syncora/SKILL.md: quick start is missing the public intent (${publicIntent})`);
  }
}
if (!/Adopt this existing knowledge graph into Syncora\./u.test(quickStart)) {
  errors.push("skills/syncora/SKILL.md: quick start must keep advanced existing-graph adoption discoverable");
}

const openAiMetadata = await readFile(path.join(skillRoot, "agents", "openai.yaml"), "utf8");
if (!openAiMetadata.includes("$syncora")) {
  errors.push("skills/syncora/agents/openai.yaml: default_prompt must invoke $syncora explicitly");
}
const shortDescription = openAiMetadata.match(/short_description:\s*"([^"]+)"/u)?.[1];
if (!shortDescription || shortDescription.length < 25 || shortDescription.length > 64) {
  errors.push(
    "skills/syncora/agents/openai.yaml: short_description must be 25-64 characters",
  );
}
if (
  shortDescription
  && (!/project|workspace/iu.test(shortDescription)
    || !/memory|context|knowledge/iu.test(shortDescription))
) {
  errors.push(
    "skills/syncora/agents/openai.yaml: short_description must state the project scope and memory benefit",
  );
}

const sharedHook = await readFile(
  path.join(skillRoot, "assets", "agent-hooks", "shared.md"),
  "utf8",
);
const adoptionSmoke = await readFile(
  path.join(repositoryRoot, "scripts", "smoke-legacy-adoption.mjs"),
  "utf8",
);
for (const requiredHookText of [
  "syncora-agent-hook:begin v8",
  "internally authorizes",
  "applies the exact transaction automatically",
  "Never ask whether to save Syncora",
  "autonomous `capture`",
  "check --changed",
  "do not run drift checks",
  "Internal Syncora proposal is integrity evidence",
  "Diff length, file count, durability, or memory importance alone never require",
  "Before every final response on an initialized project-relevant route",
  "durable_change",
  "no_durable_change",
  "open_question",
  "user_decision_required",
  "stable-keyed entry",
  "may provide provenance but never owns",
  "resolve-owner",
  "Never guess between",
  "ask the user to choose a note",
]) {
  if (!sharedHook.toLowerCase().includes(requiredHookText.toLowerCase())) {
    errors.push(
      `skills/syncora/assets/agent-hooks/shared.md: v8 capture-disposition and autonomy guidance is missing (${requiredHookText})`,
    );
  }
}
if (!adoptionSmoke.includes("syncora-agent-hook:begin v8")) {
  errors.push(
    "scripts/smoke-legacy-adoption.mjs: installed-copy assertion must require the current v8 hook",
  );
}

const agentPatchingReference = await readFile(
  path.join(skillRoot, "references", "agent-patching.md"),
  "utf8",
);
const decisionBoundaryReference = await readFile(
  path.join(skillRoot, "references", "decision-boundaries.md"),
  "utf8",
);
for (const [description, pattern] of [
  ["internal proposals are not permission prompts", /internal Syncora proposal is an integrity artifact, not a request for user\s+permission/u],
  ["plan-only boundary", /plan, proposal, design, review, or audit, so\s+implementation was not authorized/u],
  ["broad destructive data boundary", /destructive or difficult to reverse, affects an unusually\s+large share of user or business data/u],
  ["size-alone rejection", /Size alone is not enough/u],
  ["single focused question", /Ask one focused question only/u],
  ["automatic post-decision capture", /capture resulting\s+durable knowledge automatically/u],
]) {
  if (!pattern.test(decisionBoundaryReference)) {
    errors.push(
      `skills/syncora/references/decision-boundaries.md: decision-boundary contract is missing (${description})`,
    );
  }
}
for (const [description, pattern] of [
  ["current hook v8 declaration", /Hook v8 is current\./u],
  ["mandatory pre-final disposition", /mandatory internal pre-final capture-disposition sweep/u],
  ["autonomous capture declaration", /autonomous capture/u],
  ["foreground drift routing", /foreground `check --changed` operation/u],
  [
    "exact tracked v1-v7 snapshot preservation",
    /exact tracked v1, v2, v3, v4, v5, v6, or v7 hook retains its original\s+pre-Syncora restoration snapshot/u,
  ],
  [
    "diverged or untracked v1-v7 baseline refresh",
    /diverged or untracked v1, v2, v3, v4, v5, v6, or v7 hook instead refreshes the\s+restoration baseline from current user-owned bytes with only the old marker\s+removed/u,
  ],
  ["future hook fail-closed behavior", /hook newer than\s+v8 fails closed before target writes/u],
]) {
  if (!pattern.test(agentPatchingReference)) {
    errors.push(
      `skills/syncora/references/agent-patching.md: current hook contract is missing (${description})`,
    );
  }
}

const driftReference = await readFile(
  path.join(skillRoot, "references", "drift.md"),
  "utf8",
);
for (const [description, pattern] of [
  ["policy-mismatch eligibility", /DRIFT_POLICY_MISMATCH/u],
  ["absent-state refusal", /refuses when no retained drift state\s+exists/u],
  ["compatible-state refusal", /state already uses the current policy/u],
  ["ordinary-check recovery", /run\s+ordinary `check --changed`/u],
]) {
  if (!pattern.test(driftReference)) {
    errors.push(
      `skills/syncora/references/drift.md: rebaseline safety contract is missing (${description})`,
    );
  }
}

const implementationPlan = await readFile(
  path.join(repositoryRoot, "docs", "skill", "implementation-plan.md"),
  "utf8",
);
if (!/v6 makes\s+routine capture autonomous/u.test(implementationPlan)) {
  errors.push(
    "docs/skill/implementation-plan.md: hook history must identify v6 as the autonomous-capture upgrade",
  );
}
if (!/v7 reserves user interruption for genuine project decision boundaries/u.test(implementationPlan)) {
  errors.push(
    "docs/skill/implementation-plan.md: hook history must identify the v7 decision-boundary upgrade",
  );
}
if (!/Hook v8 adds the mandatory internal pre-final capture-disposition sweep/u.test(implementationPlan)) {
  errors.push(
    "docs/skill/implementation-plan.md: hook history must identify the v8 capture-disposition upgrade",
  );
}

const initializationReference = await readFile(
  path.join(skillRoot, "references", "initialize.md"),
  "utf8",
);
const legacyAdoptionGuide = await readFile(
  path.join(repositoryRoot, "docs", "legacy-kg-adoption.md"),
  "utf8",
);
for (const [displayPath, source] of [
  ["skills/syncora/references/agent-patching.md", agentPatchingReference],
  ["skills/syncora/references/initialize.md", initializationReference],
  ["docs/legacy-kg-adoption.md", legacyAdoptionGuide],
]) {
  if (!/hook v8/iu.test(source)) {
    errors.push(`${displayPath}: current operational guidance must name hook v8`);
  }
  for (const stalePattern of [
    /Hook v4 is current/iu,
    /Hook v3 keeps/iu,
    /installed hook is relevance-gated v3/iu,
    /relevance-gated v3\s+hook/iu,
    /with hook v3/iu,
    /automatic drift detection remains unavailable/iu,
  ]) {
    if (stalePattern.test(source)) {
      errors.push(`${displayPath}: contains stale pre-v7 operational hook guidance`);
    }
  }
}

for (const match of skillSource.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)) {
  const target = match[1].split("#", 1)[0];
  if (!target || /^[a-z]+:/iu.test(target)) continue;
  const resolved = path.resolve(skillRoot, target);
  if (!inside(resolved, skillRoot)) {
    errors.push(`skills/syncora/SKILL.md: link escapes the installed skill (${match[1]})`);
  } else if (!(await exists(relative(resolved)))) {
    errors.push(`skills/syncora/SKILL.md: linked file is missing (${match[1]})`);
  }
}

const readme = await readFile(path.join(repositoryRoot, "README.md"), "utf8");
const releaseStatus = await readFile(path.join(repositoryRoot, "docs", "release-status.md"), "utf8");
for (const requiredText of [
  packageJson.version,
  "development preview",
  "npx skills add",
  "Set up Syncora in this project.",
  "context compilation",
  "autonomous transactional capture",
  "drift detection",
]) {
  if (!readme.toLowerCase().includes(requiredText.toLowerCase())) {
    errors.push(`README.md: required release-boundary text is missing (${requiredText})`);
  }
}
if (!releaseStatus.includes(packageJson.version)) {
  errors.push("docs/release-status.md: current package version is missing");
}

const files = await walk(repositoryRoot);
for (const file of files) {
  const displayPath = relative(file);
  const extension = path.extname(file).toLowerCase();
  const textExtensions = new Set(["", ".json", ".md", ".mjs", ".txt", ".yaml", ".yml"]);
  if (!textExtensions.has(extension)) continue;

  const source = await readFile(file, "utf8");
  for (const pattern of privatePathPatterns) {
    if (pattern.test(source)) errors.push(`${displayPath}: contains a machine-specific private path`);
  }
  for (const pattern of secretPatterns) {
    if (pattern.test(source)) errors.push(`${displayPath}: contains text matching a secret pattern`);
  }

  if (displayPath.startsWith("skills/syncora/") && extension === ".mjs") {
    for (const match of source.matchAll(/(?:from\s+|import\s*\()\s*["']([^"']+)["']/gu)) {
      const specifier = match[1];
      if (specifier.startsWith("node:")) continue;
      if (!specifier.startsWith(".")) {
        errors.push(`${displayPath}: runtime import is not dependency-free (${specifier})`);
        continue;
      }
      const resolved = path.resolve(path.dirname(file), specifier);
      if (!inside(resolved, skillRoot)) {
        errors.push(`${displayPath}: runtime import escapes the installed skill (${specifier})`);
      }
    }
  }
}

if (errors.length > 0) {
  console.error(`Release check failed with ${errors.length} issue(s):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(`Release check passed for ${files.length} files.`);
}
