import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(
  fileURLToPath(new URL("..", import.meta.url)),
);
const testRoot = join(repositoryRoot, "tests", "syncora");
const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);

const testFiles = (await readdir(testRoot))
  .filter((name) => name.endsWith(".test.mjs"))
  .sort((left, right) => left.localeCompare(right))
  .map((name) => relative(repositoryRoot, join(testRoot, name)));

const arguments_ = [
  "--test",
  "--test-concurrency=1",
  ...(nodeMajor >= 24 ? ["--test-isolation=none"] : []),
  ...testFiles,
];
const result = spawnSync(process.execPath, arguments_, {
  cwd: repositoryRoot,
  stdio: "inherit",
  windowsHide: true,
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
