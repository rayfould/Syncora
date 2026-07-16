import { lstat, readdir, realpath } from "node:fs/promises";
import { extname, join, relative } from "node:path";

import { SyncoraError } from "./cli.mjs";
import { isWithin } from "./workspace.mjs";

const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".obsidian",
  ".syncora",
  "node_modules",
]);

function portablePath(root, path) {
  return relative(root, path).replaceAll("\\", "/");
}

function portableCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameStatIdentity(left, right, { directory = false } = {}) {
  const common =
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.ctimeNs === right.ctimeNs;
  if (!common) return false;
  if (directory) return left.mtimeNs === right.mtimeNs;
  return (
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.birthtimeNs === right.birthtimeNs
  );
}

function checkpointStatIdentity(metadata) {
  return {
    size: metadata.size.toString(),
    mtimeNs: metadata.mtimeNs.toString(),
    ctimeNs: metadata.ctimeNs.toString(),
    birthtimeNs: metadata.birthtimeNs.toString(),
    dev: metadata.dev.toString(),
    ino: metadata.ino.toString(),
    mode: metadata.mode.toString(),
  };
}

function skipDirectory(relativePath, name) {
  if (SKIPPED_DIRECTORIES.has(name.toLowerCase())) return true;
  const normalized = relativePath.toLowerCase();
  return normalized === ".claude/worktrees" || normalized.startsWith(".claude/worktrees/");
}

export function isNonPortableGraphPath(path, policy) {
  const reserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
  if (
    [...path].length > policy.maxPortablePathCharacters ||
    Buffer.byteLength(path, "utf8") > policy.maxPortablePathBytes
  ) {
    return true;
  }
  return path.split("/").some(
    (segment) =>
      [...segment].length > policy.maxPortableSegmentCharacters ||
      Buffer.byteLength(segment, "utf8") > policy.maxPortableSegmentBytes ||
      segment.endsWith(".") ||
      segment.endsWith(" ") ||
      reserved.test(segment) ||
      /[<>:"|?*\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/.test(segment),
  );
}

export async function discoverMarkdownFiles(graphRoot, policy) {
  const directories = [{ path: graphRoot, depth: 0 }];
  const files = [];
  const findings = [];
  let directoryCount = 0;
  let totalBytes = 0;

  while (directories.length > 0) {
    const current = directories.pop();
    const directory = current.path;
    directoryCount += 1;
    if (directoryCount > policy.maxDirectories) {
      throw new SyncoraError("GRAPH003", "Graph directory limit exceeded.");
    }

    let entries;
    let directoryBefore;
    try {
      directoryBefore = await lstat(directory, { bigint: true });
      const resolvedDirectory = await realpath(directory);
      if (
        !directoryBefore.isDirectory() ||
        directoryBefore.isSymbolicLink() ||
        !isWithin(graphRoot, resolvedDirectory)
      ) {
        throw new Error("directory identity is not a contained regular directory");
      }
      entries = await readdir(directory, { withFileTypes: true });
      const directoryAfter = await lstat(directory, { bigint: true });
      if (!sameStatIdentity(directoryBefore, directoryAfter, { directory: true })) {
        throw new Error("directory entries changed during enumeration");
      }
    } catch (error) {
      throw new SyncoraError("READ001", `Unable to enumerate graph directory: ${directory}`, {
        cause: error.message,
      });
    }

    entries.sort((left, right) => portableCompare(left.name, right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const reportPath = portablePath(graphRoot, path);

      if (entry.isSymbolicLink()) {
        findings.push({
          code: "PATH002",
          severity: "error",
          message: "Nested symbolic links and junctions are not followed during validation.",
          path: reportPath,
          quarantined: false,
        });
        continue;
      }

      if (entry.isDirectory()) {
        if (!skipDirectory(reportPath, entry.name)) {
          if (current.depth + 1 > policy.maxDepth) {
            throw new SyncoraError("GRAPH003", "Graph directory depth limit exceeded.");
          }
          directories.push({ path, depth: current.depth + 1 });
        }
        continue;
      }
      if (!entry.isFile() || extname(entry.name).toLowerCase() !== ".md") continue;

      let metadata;
      let resolved;
      try {
        const before = await lstat(path, { bigint: true });
        resolved = await realpath(path);
        const after = await lstat(path, { bigint: true });
        if (!sameStatIdentity(before, after)) {
          throw new Error("file identity changed during inspection");
        }
        metadata = after;
      } catch (error) {
        throw new SyncoraError("READ001", `Unable to inspect graph file: ${path}`, {
          cause: error.message,
        });
      }
      if (!metadata.isFile() || !isWithin(graphRoot, resolved)) {
        findings.push({
          code: "PATH002",
          severity: "error",
          message: "A discovered Markdown path is not a contained regular file.",
          path: reportPath,
          quarantined: true,
        });
        continue;
      }

      const size = Number(metadata.size);
      if (!Number.isSafeInteger(size) || size < 0) {
        throw new SyncoraError("GRAPH003", `Graph file size is outside the safe integer range: ${reportPath}`);
      }
      totalBytes += size;
      files.push({
        path: reportPath,
        absolutePath: path,
        realPath: resolved,
        size,
        mtimeMs: Number(metadata.mtimeNs) / 1_000_000,
        checkpointStat: checkpointStatIdentity(metadata),
      });
      if (isNonPortableGraphPath(reportPath, policy)) {
        files.at(-1).nonPortablePath = true;
      }
      if (files.length > policy.maxMarkdownFiles) {
        throw new SyncoraError("GRAPH003", "Graph Markdown file limit exceeded.");
      }
      if (totalBytes > policy.maxTotalBytes) {
        throw new SyncoraError("GRAPH003", "Graph total byte limit exceeded.");
      }
    }
  }

  files.sort((left, right) => portableCompare(left.path, right.path));
  const byPortableCase = new Map();
  for (const file of files) {
    const key = file.path.normalize("NFC").toLowerCase();
    const matches = byPortableCase.get(key) ?? [];
    matches.push(file);
    byPortableCase.set(key, matches);
  }
  for (const matches of byPortableCase.values()) {
    if (matches.length < 2) continue;
    const paths = matches.map((item) => item.path);
    for (const file of matches) {
      file.caseCollision = true;
      file.caseCollisionPaths = paths;
    }
  }

  return { files, findings, directoryCount, totalBytes };
}
