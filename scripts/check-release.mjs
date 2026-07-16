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
  "docs/skill/implementation-plan.md",
  "package.json",
  "package-lock.json",
  "scripts/smoke-legacy-adoption.mjs",
  "skills/syncora/SKILL.md",
  "skills/syncora/agents/openai.yaml",
  "skills/syncora/assets/schemas/adoption-bundle-v1.schema.json",
  "skills/syncora/assets/schemas/authority-promotion-manifest-v2.schema.json",
  "skills/syncora/references/legacy-adoption.md",
  "skills/syncora/scripts/lib/adoption-bundle.mjs",
  "skills/syncora/scripts/lib/adopt.mjs",
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
}

const openAiMetadata = await readFile(path.join(skillRoot, "agents", "openai.yaml"), "utf8");
if (!openAiMetadata.includes("$syncora")) {
  errors.push("skills/syncora/agents/openai.yaml: default_prompt must invoke $syncora explicitly");
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
  "0.1.0-preview.1",
  "development preview",
  "npx skills add",
  "$syncora",
  "context compilation",
  "governed capture",
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
