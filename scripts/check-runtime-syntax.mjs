import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const roots = [
  path.join(repositoryRoot, "scripts"),
  path.join(repositoryRoot, "skills", "syncora", "scripts"),
];

async function collectModules(directory) {
  const modules = [];
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      modules.push(...(await collectModules(absolutePath)));
    } else if (entry.isFile() && entry.name.endsWith(".mjs")) {
      modules.push(absolutePath);
    }
  }

  return modules;
}

const modules = (await Promise.all(roots.map(collectModules))).flat();
const failures = [];

for (const modulePath of modules) {
  const result = spawnSync(process.execPath, ["--check", modulePath], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });

  if (result.status !== 0) {
    failures.push({
      path: path.relative(repositoryRoot, modulePath),
      output: [result.error?.message, result.stdout, result.stderr]
        .filter(Boolean)
        .join("\n")
        .trim(),
    });
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`Syntax check failed: ${failure.path}`);
    if (failure.output) console.error(failure.output);
  }
  process.exitCode = 1;
} else {
  console.log(`Syntax check passed for ${modules.length} modules.`);
}
