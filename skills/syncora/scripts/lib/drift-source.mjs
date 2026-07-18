import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import { SyncoraError } from "./cli.mjs";
import {
  createNormalizedFileBindingMatcher,
  parseTargetSpecifier,
} from "./target-bindings.mjs";
import {
  isWithin,
  readBoundedRegularFileIfPresent,
  samePath,
} from "./workspace.mjs";

const SKIPPED_DIRECTORY_NAMES = Object.freeze([".git", ".syncora", "node_modules"]);
const SKIPPED_DIRECTORY_NAME_SET = new Set(SKIPPED_DIRECTORY_NAMES);

export const DRIFT_SOURCE_POLICY = Object.freeze({
  specification: "syncora-drift-source-v1",
  // Drift inventories graph-wide bindings, not one request's context targets.
  // The separate match-evaluation ceiling below still bounds total work.
  maximumBindings: 10_000,
  maximumFiles: 50_000,
  maximumDirectories: 10_000,
  maximumDepth: 64,
  maximumFileBytes: 16 * 1_024 * 1_024,
  maximumTotalBytes: 512 * 1_024 * 1_024,
  maximumMatchEvaluations: 1_000_000,
  maximumPortablePathCharacters: 4_096,
  maximumPortablePathBytes: 8_192,
  maximumPortableSegmentCharacters: 240,
  maximumPortableSegmentBytes: 255,
  maximumReportedSkippedDirectories: 256,
  maximumReportedMissingRoots: 256,
  maximumGitOutputBytes: 4 * 1_024 * 1_024,
  maximumGitStderrBytes: 16_384,
  maximumGitHints: 10_000,
  maximumGitMatchEvaluations: 1_000_000,
  gitTimeoutMs: 10_000,
  skippedDirectoryNames: SKIPPED_DIRECTORY_NAMES,
});

const FILE_BINDING_KINDS = new Set(["file", "module", "path_glob"]);
const UNSAFE_PATH_SCALARS =
  /[<>:"|?*\\\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u;
const UNSAFE_REPORT_SCALARS =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu;
const FATAL_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

function safeReportText(value) {
  return String(value).replace(UNSAFE_REPORT_SCALARS, " ").replace(/\s+/gu, " ").trim();
}

function sourceError(code, message, details = undefined) {
  const safeMessage = safeReportText(message);
  const boundedMessage = safeMessage.length > 1_024
    ? `${safeMessage.slice(0, 1_021)}...`
    : safeMessage;
  return new SyncoraError(code, boundedMessage, details);
}

function portableCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function pathKey(path) {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function boundedReason(error) {
  const source = safeReportText(error instanceof Error ? error.message : error);
  return source.length > 512 ? `${source.slice(0, 509)}...` : source;
}

function metadataIfPresent(path) {
  return lstat(path, { bigint: true }).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
}

function sameFileIdentity(left, right) {
  return Boolean(
    left && right &&
    left.dev === right.dev && left.ino === right.ino &&
    left.mode === right.mode && left.nlink === right.nlink &&
    left.size === right.size && left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs && left.birthtimeNs === right.birthtimeNs
  );
}

function sameDirectoryIdentity(left, right) {
  return Boolean(
    left && right &&
    left.dev === right.dev && left.ino === right.ino &&
    left.mode === right.mode && left.nlink === right.nlink &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
  );
}

function isReservedWindowsDeviceName(segment) {
  const basename = segment.split(".", 1)[0].toUpperCase();
  return (
    ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"].includes(basename) ||
    /^COM(?:[1-9]|[\u00b9\u00b2\u00b3])$/u.test(basename) ||
    /^LPT(?:[1-9]|[\u00b9\u00b2\u00b3])$/u.test(basename)
  );
}

function isNonPortablePath(path) {
  if (
    path.length === 0 || path !== path.normalize("NFC") ||
    [...path].length > DRIFT_SOURCE_POLICY.maximumPortablePathCharacters ||
    Buffer.byteLength(path, "utf8") > DRIFT_SOURCE_POLICY.maximumPortablePathBytes
  ) return true;
  return path.split("/").some((segment) =>
    segment.length === 0 || segment === "." || segment === ".." ||
    segment !== segment.normalize("NFC") ||
    [...segment].length > DRIFT_SOURCE_POLICY.maximumPortableSegmentCharacters ||
    Buffer.byteLength(segment, "utf8") > DRIFT_SOURCE_POLICY.maximumPortableSegmentBytes ||
    segment.endsWith(".") || segment.endsWith(" ") ||
    isReservedWindowsDeviceName(segment) || UNSAFE_PATH_SCALARS.test(segment)
  );
}

function portablePath(workspacePath, absolutePath) {
  return relative(workspacePath, absolutePath).split(sep).join("/");
}

function portableDirectoryEntry(entry) {
  if (typeof entry.name === "string") return { entry, name: entry.name };
  try {
    const name = FATAL_UTF8_DECODER.decode(entry.name);
    if (!Buffer.from(name, "utf8").equals(entry.name)) throw new Error("non-canonical UTF-8");
    return { entry, name };
  } catch {
    throw sourceError(
      "DRIFT_SOURCE_UNSAFE",
      "Covered source directory contains a filename that is not portable UTF-8.",
    );
  }
}

function pathDepth(path) {
  return path === "" ? 0 : path.split("/").length;
}

function isSkippedDirectoryPath(path) {
  const segments = path.toLowerCase().split("/");
  if (segments.some((segment) => SKIPPED_DIRECTORY_NAME_SET.has(segment))) return true;
  for (let index = 0; index + 1 < segments.length; index += 1) {
    if (segments[index] === ".claude" && segments[index + 1] === "worktrees") return true;
  }
  return false;
}

function normalizedBindings(bindings) {
  if (!Array.isArray(bindings) || bindings.length > DRIFT_SOURCE_POLICY.maximumBindings) {
    throw sourceError(
      "DRIFT_SOURCE_INVALID",
      `Drift observation accepts at most ${DRIFT_SOURCE_POLICY.maximumBindings} bindings.`,
    );
  }
  const output = [];
  const identities = new Set();
  for (const binding of bindings) {
    if (
      binding === null || typeof binding !== "object" ||
      typeof binding.specifier !== "string" ||
      typeof binding.kind !== "string" || typeof binding.ref !== "string" ||
      !FILE_BINDING_KINDS.has(binding.kind)
    ) {
      throw sourceError(
        "DRIFT_SOURCE_INVALID",
        "Drift bindings must be normalized file, module, or path_glob objects.",
      );
    }
    let parsed;
    try {
      parsed = parseTargetSpecifier(binding.specifier, "drift binding");
    } catch (error) {
      throw sourceError("DRIFT_SOURCE_INVALID", "Drift binding specifier is invalid.", {
        cause: boundedReason(error),
      });
    }
    if (
      parsed.kind !== binding.kind || parsed.ref !== binding.ref ||
      binding.specifier !== `${binding.kind}:${binding.ref}`
    ) {
      throw sourceError(
        "DRIFT_SOURCE_INVALID",
        "Drift bindings must contain matching normalized specifier, kind, and ref values.",
      );
    }
    const identity = `${binding.kind}\0${binding.ref}`;
    if (identities.has(identity)) {
      throw sourceError("DRIFT_SOURCE_INVALID", "Drift bindings must be unique.");
    }
    identities.add(identity);
    output.push({
      specifier: binding.specifier,
      kind: binding.kind,
      ref: binding.ref,
      matcher: createNormalizedFileBindingMatcher(binding),
    });
  }
  return output.sort((left, right) => portableCompare(left.specifier, right.specifier));
}

function rootForBinding(binding) {
  if (binding.kind !== "path_glob") return binding.ref;
  const segments = binding.ref.split("/");
  const firstPattern = segments.findIndex(
    (segment) => segment === "**" || segment.includes("*") || segment.includes("?"),
  );
  if (firstPattern < 0) return binding.ref;
  return segments.slice(0, firstPattern).join("/");
}

function rootContains(parent, child) {
  return parent === "" || child === parent || child.startsWith(`${parent}/`);
}

function buildBoundRoots(bindings) {
  const combined = new Map();
  for (const binding of bindings) {
    const ref = rootForBinding(binding);
    const current = combined.get(ref) ?? { ref, expansive: false };
    if (binding.kind !== "file") current.expansive = true;
    combined.set(ref, current);
  }
  const selected = [];
  for (const candidate of [...combined.values()].sort(
    (left, right) => pathDepth(left.ref) - pathDepth(right.ref) || portableCompare(left.ref, right.ref),
  )) {
    if (selected.some((root) => root.expansive && rootContains(root.ref, candidate.ref))) continue;
    selected.push(candidate);
  }
  return selected.sort((left, right) => portableCompare(left.ref, right.ref));
}

function buildBindingCandidateIndex(bindings) {
  const exactFiles = new Map();
  const modules = new Map();
  const globsByRoot = new Map();
  for (const binding of bindings) {
    if (binding.kind === "file") {
      exactFiles.set(binding.ref, binding);
    } else if (binding.kind === "module") {
      modules.set(binding.ref, binding);
    } else {
      const root = rootForBinding(binding);
      const candidates = globsByRoot.get(root) ?? [];
      candidates.push(binding);
      globsByRoot.set(root, candidates);
    }
  }
  return { exactFiles, modules, globsByRoot };
}

function bindingCandidatesForPath(path, index) {
  const candidates = new Map();
  const exact = index.exactFiles.get(path);
  if (exact) candidates.set(exact.specifier, exact);
  const segments = path.split("/");
  const roots = [""];
  for (let length = 1; length <= segments.length; length += 1) {
    roots.push(segments.slice(0, length).join("/"));
  }
  for (const root of roots) {
    const module = index.modules.get(root);
    if (module) candidates.set(module.specifier, module);
    for (const glob of index.globsByRoot.get(root) ?? []) {
      candidates.set(glob.specifier, glob);
    }
  }
  return [...candidates.values()];
}

function addBoundedPath(record, path, maximum) {
  if (record.seen.has(path)) return;
  record.seen.add(path);
  record.count += 1;
  if (record.values.length < maximum) record.values.push(path);
}

function aggregateFileMap(files) {
  const hash = createHash("sha256");
  hash.update("syncora-drift-file-map-v1\0", "utf8");
  for (const file of files) {
    const pathBytes = Buffer.from(file.path, "utf8");
    const pathLength = Buffer.alloc(4);
    pathLength.writeUInt32BE(pathBytes.length);
    const size = Buffer.alloc(8);
    size.writeBigUInt64BE(BigInt(file.bytes));
    hash.update(pathLength);
    hash.update(pathBytes);
    hash.update(size);
    hash.update(Buffer.from(file.sha256.slice("sha256:".length), "hex"));
  }
  return `sha256:${hash.digest("hex")}`;
}

function runGitProcess(invocation) {
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, invocation.options);
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timer;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      callback();
    };
    const exceed = (label) => {
      child.kill();
      finish(() => reject(new Error(`Git advisory ${label} exceeded its bound.`)));
    };
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > invocation.limits.stdoutBytes) return exceed("stdout");
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > invocation.limits.stderrBytes) return exceed("stderr");
      stderr.push(chunk);
    });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code, signal) => finish(() => resolve({
      code,
      signal,
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr),
    })));
    timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error("Git advisory query timed out.")));
    }, invocation.limits.timeoutMs);
    timer.unref?.();
  });
}

function bufferFromGitResult(value, label, maximum) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value ?? "", "utf8");
  if (buffer.length > maximum) {
    throw new Error(`Git ${label} exceeded its bounded output limit.`);
  }
  return buffer;
}

function validGitBaseline(value) {
  return (
    typeof value === "string" && value.length > 0 && value.length <= 256 &&
    !value.startsWith("-") &&
    /^[A-Za-z0-9][A-Za-z0-9._/@{}~^:+-]*$/u.test(value)
  );
}

function safeGitPath(value, graphAliases) {
  if (typeof value !== "string" || value !== value.normalize("NFC")) return null;
  if (
    value.startsWith("/") || /^[A-Za-z]:\//u.test(value) ||
    isNonPortablePath(value) || isSkippedDirectoryPath(value)
  ) return null;
  if (graphAliases.some((alias) => value === alias || value.startsWith(`${alias}/`))) return null;
  return value;
}

function decodeGitFields(buffer) {
  if (buffer.length === 0) return [];
  if (buffer.at(-1) !== 0) throw new Error("Git advisory output was not NUL terminated.");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const fields = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0) continue;
    fields.push(decoder.decode(buffer.subarray(start, index)));
    start = index + 1;
  }
  return fields;
}

function statusName(code) {
  return {
    A: "added",
    C: "copied",
    D: "deleted",
    M: "modified",
    R: "renamed",
    T: "type_changed",
    U: "unmerged",
    X: "unknown",
    B: "broken_pairing",
  }[code];
}

function pathMatchesAnyBinding(path, bindings, state) {
  for (const binding of bindings) {
    state.evaluations += 1;
    if (state.evaluations > DRIFT_SOURCE_POLICY.maximumGitMatchEvaluations) {
      throw new Error("Git advisory matching exceeded its evaluation limit.");
    }
    if (binding.matcher(path)) return true;
  }
  return false;
}

function parseGitHints(stdout, bindings, graphAliases) {
  const fields = decodeGitFields(stdout);
  const hints = [];
  const matchState = { evaluations: 0 };
  let discardedUnsafePaths = 0;
  let truncated = false;
  let index = 0;
  while (index < fields.length) {
    const rawStatus = fields[index];
    index += 1;
    const match = /^([ACDMRTUXB])(\d{1,3})?$/u.exec(rawStatus);
    if (!match) throw new Error("Git advisory output contained an unsupported status field.");
    const code = match[1];
    const pathCount = code === "R" || code === "C" ? 2 : 1;
    if (index + pathCount > fields.length) {
      throw new Error("Git advisory output ended inside a path record.");
    }
    const rawPaths = fields.slice(index, index + pathCount);
    index += pathCount;
    const paths = rawPaths.map((path) => safeGitPath(path, graphAliases));
    if (paths.some((path) => path === null)) {
      discardedUnsafePaths += 1;
      continue;
    }
    const relevant = paths.some((path) => pathMatchesAnyBinding(path, bindings, matchState));
    if (!relevant) continue;
    if (hints.length >= DRIFT_SOURCE_POLICY.maximumGitHints) {
      truncated = true;
      continue;
    }
    if (pathCount === 2) {
      hints.push({
        status: statusName(code),
        oldPath: paths[0],
        newPath: paths[1],
        similarity: match[2] ? Number(match[2]) : null,
      });
    } else {
      hints.push({ status: statusName(code), path: paths[0] });
    }
  }
  hints.sort((left, right) =>
    portableCompare(left.path ?? left.newPath, right.path ?? right.newPath) ||
    portableCompare(left.oldPath ?? "", right.oldPath ?? "") ||
    portableCompare(left.status, right.status),
  );
  return { hints, truncated, discardedUnsafePaths, evaluations: matchState.evaluations };
}

function gitInvocation(workspacePath, operationArgs) {
  return {
    command: "git",
    args: [
      "--no-pager",
      "-c", "core.pager=cat",
      "-c", "color.ui=false",
      "-c", "core.fsmonitor=false",
      ...operationArgs,
    ],
    options: {
      cwd: workspacePath,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
        GIT_EXTERNAL_DIFF: "",
        GIT_PAGER: "cat",
        PAGER: "cat",
      },
    },
    limits: {
      stdoutBytes: DRIFT_SOURCE_POLICY.maximumGitOutputBytes,
      stderrBytes: DRIFT_SOURCE_POLICY.maximumGitStderrBytes,
      timeoutMs: DRIFT_SOURCE_POLICY.gitTimeoutMs,
    },
  };
}

async function executeGit(invocation, hooks) {
  const result = hooks?.runGit
    ? await hooks.runGit(invocation)
    : await runGitProcess(invocation);
  const stdout = bufferFromGitResult(
    result?.stdout,
    "stdout",
    DRIFT_SOURCE_POLICY.maximumGitOutputBytes,
  );
  const stderr = bufferFromGitResult(
    result?.stderr,
    "stderr",
    DRIFT_SOURCE_POLICY.maximumGitStderrBytes,
  );
  const exitCode = result?.code ?? result?.exitCode;
  if (exitCode !== 0) {
    const detail = stderr.toString("utf8").trim();
    throw new Error(detail || `Git exited with status ${String(exitCode)}.`);
  }
  return stdout;
}

function parseGitHead(stdout) {
  const value = stdout.toString("ascii").trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value)) {
    throw new Error("Git HEAD did not resolve to a bounded object identifier.");
  }
  return value;
}

async function gitAdvisory({ workspacePath, baseline, bindings, graphAliases, hooks }) {
  const comparedFrom = baseline === undefined || baseline === null ? null : baseline;
  if (comparedFrom !== null && !validGitBaseline(comparedFrom)) {
    return {
      advisory: true,
      available: false,
      hintsAvailable: false,
      baseline: null,
      comparedFrom: null,
      hints: [],
      warning: "Git baseline is not a safe bounded revision expression.",
    };
  }
  let currentHead;
  try {
    const headOutput = await executeGit(
      gitInvocation(workspacePath, ["rev-parse", "--verify", "HEAD^{commit}"]),
      hooks,
    );
    currentHead = parseGitHead(headOutput);
  } catch (error) {
    return {
      advisory: true,
      available: false,
      hintsAvailable: false,
      baseline: null,
      comparedFrom,
      hints: [],
      warning: boundedReason(error),
    };
  }

  if (comparedFrom === null) {
    return {
      advisory: true,
      available: true,
      hintsAvailable: false,
      baseline: currentHead,
      comparedFrom: null,
      baselineEstablished: true,
      hints: [],
    };
  }

  const diffArgs = [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--ignore-submodules=all",
    "--find-renames=50%",
    "--name-status",
    "-z",
    `${comparedFrom}^{commit}`,
    "--",
    ".",
  ];
  try {
    const stdout = await executeGit(gitInvocation(workspacePath, diffArgs), hooks);
    const parsed = parseGitHints(stdout, bindings, graphAliases);
    return {
      advisory: true,
      available: true,
      hintsAvailable: true,
      baseline: currentHead,
      comparedFrom,
      baselineEstablished: false,
      hints: parsed.hints,
      hintsTruncated: parsed.truncated,
      discardedUnsafePaths: parsed.discardedUnsafePaths,
      matchEvaluations: parsed.evaluations,
    };
  } catch (error) {
    return {
      advisory: true,
      available: false,
      hintsAvailable: false,
      baseline: currentHead,
      comparedFrom,
      baselineEstablished: false,
      hints: [],
      warning: boundedReason(error),
    };
  }
}

/**
 * Observe only source regions named by normalized file/module/path_glob
 * bindings. Raw bytes and their SHA-256 digests are authoritative; Git output
 * is an optional, bounded advisory channel and never changes a fingerprint.
 */
export async function observeBoundSources({
  workspacePath,
  graphPath,
  bindings,
  gitBaseline = undefined,
  hooks = undefined,
}) {
  if (typeof workspacePath !== "string" || !isAbsolute(workspacePath)) {
    throw sourceError("DRIFT_SOURCE_INVALID", "Workspace path must be absolute.");
  }
  if (
    graphPath !== undefined && graphPath !== null &&
    (typeof graphPath !== "string" || !isAbsolute(graphPath))
  ) {
    throw sourceError("DRIFT_SOURCE_INVALID", "Graph path must be absolute when provided.");
  }
  const preparedBindings = normalizedBindings(bindings);

  let workspaceRealPath;
  let graphRealPath = null;
  try {
    workspaceRealPath = await realpath(workspacePath);
    const workspaceMetadata = await lstat(workspaceRealPath, { bigint: true });
    if (!workspaceMetadata.isDirectory() || workspaceMetadata.isSymbolicLink()) {
      throw new Error("workspace is not a regular directory");
    }
    if (graphPath) graphRealPath = await realpath(graphPath);
  } catch (error) {
    throw sourceError("DRIFT_SOURCE_UNSAFE", "Source roots could not be resolved safely.", {
      cause: boundedReason(error),
    });
  }

  const graphAliases = [];
  if (graphPath && isWithin(workspaceRealPath, graphPath)) {
    const alias = portablePath(workspaceRealPath, graphPath);
    if (alias) graphAliases.push(alias);
  }
  if (graphRealPath) {
    const conventionalGraph = join(workspaceRealPath, "local");
    try {
      if (samePath(await realpath(conventionalGraph), graphRealPath)) graphAliases.push("local");
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw sourceError("DRIFT_SOURCE_UNSAFE", "Conventional graph path is unsafe.", {
          cause: boundedReason(error),
        });
      }
    }
  }
  graphAliases.sort(portableCompare);
  const uniqueGraphAliases = [...new Set(graphAliases)];

  // Run the optional advisory channel before observing authoritative source
  // bytes. A Git invocation is not trusted to leave the workspace unchanged;
  // any mutation it causes must be included in the subsequent raw-byte
  // snapshot rather than occurring after the final stability pass.
  const git = await gitAdvisory({
    workspacePath: workspaceRealPath,
    baseline: gitBaseline,
    bindings: preparedBindings,
    graphAliases: uniqueGraphAliases,
    hooks,
  });

  const roots = buildBoundRoots(preparedBindings);
  const discoveredFiles = new Map();
  const visitedDirectories = new Set();
  const directorySnapshots = new Map();
  const coveredCase = new Map();
  const skipped = { count: 0, values: [], seen: new Set() };
  const missing = { count: 0, values: [], seen: new Set() };
  let totalInspectedBytes = 0;

  const recordCoveredPath = (path) => {
    if (!path) return;
    if (isNonPortablePath(path)) {
      throw sourceError("DRIFT_SOURCE_UNSAFE", `Covered source path is not portable: ${path}`);
    }
    const key = path.normalize("NFC").toLowerCase();
    const prior = coveredCase.get(key);
    if (prior !== undefined && prior !== path) {
      throw sourceError(
        "DRIFT_SOURCE_UNSAFE",
        `Covered source paths collide by portable case: ${prior}, ${path}`,
      );
    }
    coveredCase.set(key, path);
  };
  const recordSkip = (path) => addBoundedPath(
    skipped,
    path || ".",
    DRIFT_SOURCE_POLICY.maximumReportedSkippedDirectories,
  );
  const isGraphLocation = async (path) => {
    if (!graphRealPath) return false;
    try {
      const resolved = await realpath(path);
      return samePath(resolved, graphRealPath) || isWithin(graphRealPath, resolved);
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  };
  const addFile = (path, absolutePath, metadata) => {
    if (discoveredFiles.has(path)) return;
    const size = Number(metadata.size);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw sourceError("DRIFT_SOURCE_LIMIT", `Source file size is not safely representable: ${path}`);
    }
    if (size > DRIFT_SOURCE_POLICY.maximumFileBytes) {
      throw sourceError(
        "DRIFT_SOURCE_LIMIT",
        `Source file exceeds ${DRIFT_SOURCE_POLICY.maximumFileBytes} bytes: ${path}`,
      );
    }
    if (discoveredFiles.size + 1 > DRIFT_SOURCE_POLICY.maximumFiles) {
      throw sourceError("DRIFT_SOURCE_LIMIT", "Source file count limit exceeded.");
    }
    totalInspectedBytes += size;
    if (totalInspectedBytes > DRIFT_SOURCE_POLICY.maximumTotalBytes) {
      throw sourceError("DRIFT_SOURCE_LIMIT", "Source total byte limit exceeded.");
    }
    discoveredFiles.set(path, { path, absolutePath, size, metadata });
  };

  const inspectResolvedEntry = async (absolutePath, path) => {
    const before = await metadataIfPresent(absolutePath);
    if (before === null) return { type: "missing" };
    recordCoveredPath(path);
    if (before.isSymbolicLink()) {
      if (await isGraphLocation(absolutePath)) return { type: "skipped_graph" };
      throw sourceError(
        "DRIFT_SOURCE_UNSAFE",
        `Covered source path is a symbolic link or junction: ${path}`,
      );
    }
    const resolved = await realpath(absolutePath);
    if (graphRealPath && (samePath(resolved, graphRealPath) || isWithin(graphRealPath, resolved))) {
      return { type: "skipped_graph" };
    }
    if (!isWithin(workspaceRealPath, resolved)) {
      throw sourceError("DRIFT_SOURCE_UNSAFE", `Covered source path escapes the workspace: ${path}`);
    }
    const resolvedPortablePath = portablePath(workspaceRealPath, resolved);
    if (path && resolvedPortablePath !== path) {
      throw sourceError(
        "DRIFT_SOURCE_UNSAFE",
        `Covered source path does not preserve its portable case identity: ${path}`,
      );
    }
    const after = await lstat(absolutePath, { bigint: true });
    if (
      (before.isDirectory() && !sameDirectoryIdentity(before, after)) ||
      (!before.isDirectory() && !sameFileIdentity(before, after))
    ) {
      throw sourceError("DRIFT_SOURCE_UNSTABLE", `Source path changed during inspection: ${path}`);
    }
    if (after.isDirectory()) return { type: "directory", metadata: after };
    if (after.isFile()) return { type: "file", metadata: after };
    throw sourceError(
      "DRIFT_SOURCE_UNSAFE",
      `Covered source path is not a regular file or directory: ${path}`,
    );
  };

  const scanDirectory = async (absoluteRoot, rootPath) => {
    const stack = [{ absolutePath: absoluteRoot, path: rootPath }];
    while (stack.length > 0) {
      const current = stack.pop();
      const directoryKey = pathKey(current.absolutePath);
      if (visitedDirectories.has(directoryKey)) continue;
      if (pathDepth(current.path) > DRIFT_SOURCE_POLICY.maximumDepth) {
        throw sourceError("DRIFT_SOURCE_LIMIT", "Source directory depth limit exceeded.");
      }
      if (visitedDirectories.size + 1 > DRIFT_SOURCE_POLICY.maximumDirectories) {
        throw sourceError("DRIFT_SOURCE_LIMIT", "Source directory count limit exceeded.");
      }
      visitedDirectories.add(directoryKey);

      let before;
      let entries;
      try {
        before = await lstat(current.absolutePath, { bigint: true });
        if (!before.isDirectory() || before.isSymbolicLink()) {
          throw new Error("directory is not a safe regular directory");
        }
        const resolved = await realpath(current.absolutePath);
        if (!isWithin(workspaceRealPath, resolved)) throw new Error("directory escapes workspace");
        if (hooks?.beforeEnumerateDirectory) {
          await hooks.beforeEnumerateDirectory({
            path: current.path || ".",
            absolutePath: current.absolutePath,
          });
        }
        entries = await readdir(current.absolutePath, {
          withFileTypes: true,
          encoding: "buffer",
        });
        if (hooks?.afterEnumerateDirectory) {
          await hooks.afterEnumerateDirectory({
            path: current.path || ".",
            absolutePath: current.absolutePath,
          });
        }
        const afterRead = await lstat(current.absolutePath, { bigint: true });
        if (!sameDirectoryIdentity(before, afterRead)) {
          throw new Error("directory entries changed during enumeration");
        }
      } catch (error) {
        if (error instanceof SyncoraError) throw error;
        throw sourceError(
          "DRIFT_SOURCE_UNSTABLE",
          `Source directory could not be enumerated stably: ${current.path || "."}`,
          { cause: boundedReason(error) },
        );
      }

      entries = entries.map(portableDirectoryEntry);
      entries.sort((left, right) => portableCompare(left.name, right.name));
      const childDirectories = [];
      for (const entry of entries) {
        const absolutePath = join(current.absolutePath, entry.name);
        const path = current.path ? `${current.path}/${entry.name}` : entry.name;
        recordCoveredPath(path);

        if (isSkippedDirectoryPath(path)) {
          recordSkip(path);
          continue;
        }

        let inspected;
        try {
          inspected = await inspectResolvedEntry(absolutePath, path);
        } catch (error) {
          if (error instanceof SyncoraError) throw error;
          throw sourceError("DRIFT_SOURCE_UNSAFE", `Source entry could not be inspected: ${path}`, {
            cause: boundedReason(error),
          });
        }
        if (inspected.type === "skipped_graph") {
          recordSkip(path);
          continue;
        }
        if (inspected.type === "missing") {
          throw sourceError(
            "DRIFT_SOURCE_UNSTABLE",
            `Source entry disappeared during enumeration: ${path}`,
          );
        }
        if (inspected.type === "directory") {
          childDirectories.push({ absolutePath, path });
        } else {
          addFile(path, absolutePath, inspected.metadata);
        }
      }

      const afterEntries = await metadataIfPresent(current.absolutePath);
      if (!sameDirectoryIdentity(before, afterEntries)) {
        throw sourceError(
          "DRIFT_SOURCE_UNSTABLE",
          `Source directory changed during enumeration: ${current.path || "."}`,
        );
      }
      directorySnapshots.set(directoryKey, {
        absolutePath: current.absolutePath,
        path: current.path,
        metadata: afterEntries,
      });
      for (let index = childDirectories.length - 1; index >= 0; index -= 1) {
        stack.push(childDirectories[index]);
      }
    }
  };

  for (const root of roots) {
    const segments = root.ref === "" ? [] : root.ref.split("/");
    let absolutePath = workspaceRealPath;
    let stopped = false;
    for (let index = 0; index < segments.length; index += 1) {
      absolutePath = join(absolutePath, segments[index]);
      const path = segments.slice(0, index + 1).join("/");
      if (isSkippedDirectoryPath(path)) {
        recordSkip(path);
        stopped = true;
        break;
      }
      const inspected = await inspectResolvedEntry(absolutePath, path);
      if (inspected.type === "missing") {
        addBoundedPath(missing, root.ref, DRIFT_SOURCE_POLICY.maximumReportedMissingRoots);
        stopped = true;
        break;
      }
      if (inspected.type === "skipped_graph") {
        recordSkip(path);
        stopped = true;
        break;
      }
      if (index < segments.length - 1 && inspected.type !== "directory") {
        throw sourceError(
          "DRIFT_SOURCE_UNSAFE",
          `Covered source parent is not a directory: ${path}`,
        );
      }
    }
    if (stopped) continue;

    const path = root.ref;
    const inspected = await inspectResolvedEntry(absolutePath, path);
    if (inspected.type === "skipped_graph") {
      recordSkip(path);
    } else if (inspected.type === "missing") {
      addBoundedPath(missing, root.ref, DRIFT_SOURCE_POLICY.maximumReportedMissingRoots);
    } else if (inspected.type === "file") {
      addFile(path, absolutePath, inspected.metadata);
    } else if (root.expansive) {
      await scanDirectory(absolutePath, path);
    }
  }

  const filesByBinding = new Map(
    preparedBindings.map((binding) => [binding.specifier, []]),
  );
  const bindingCandidateIndex = buildBindingCandidateIndex(preparedBindings);
  const matchedFiles = new Set();
  let matchEvaluations = 0;
  let totalBytesHashed = 0;
  const sortedFiles = [...discoveredFiles.values()].sort(
    (left, right) => portableCompare(left.path, right.path),
  );
  for (const file of sortedFiles) {
    const matchingBindings = [];
    for (const binding of bindingCandidatesForPath(file.path, bindingCandidateIndex)) {
      matchEvaluations += 1;
      if (matchEvaluations > DRIFT_SOURCE_POLICY.maximumMatchEvaluations) {
        throw sourceError("DRIFT_SOURCE_LIMIT", "Source binding match evaluation limit exceeded.");
      }
      if (binding.matcher(file.path)) matchingBindings.push(binding);
    }
    if (matchingBindings.length === 0) continue;

    const bytes = await readBoundedRegularFileIfPresent(file.absolutePath, {
      containmentRoot: dirname(file.absolutePath),
      maximumBytes: DRIFT_SOURCE_POLICY.maximumFileBytes,
      code: "DRIFT_SOURCE_UNSTABLE",
      label: "Bound source file",
      isolateOnWindows: false,
      beforeOpen: hooks?.beforeFileOpen
        ? () => hooks.beforeFileOpen({ path: file.path, absolutePath: file.absolutePath })
        : undefined,
      afterRead: hooks?.afterFileRead
        ? () => hooks.afterFileRead({ path: file.path, absolutePath: file.absolutePath })
        : undefined,
    });
    if (bytes === null || bytes.length !== file.size) {
      throw sourceError("DRIFT_SOURCE_UNSTABLE", `Source file changed before hashing: ${file.path}`);
    }
    const sha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const observation = { path: file.path, bytes: bytes.length, sha256 };
    for (const binding of matchingBindings) {
      filesByBinding.get(binding.specifier).push(observation);
    }
    matchedFiles.add(file.path);
    totalBytesHashed += bytes.length;
  }

  for (const snapshot of directorySnapshots.values()) {
    const after = await metadataIfPresent(snapshot.absolutePath);
    if (!sameDirectoryIdentity(snapshot.metadata, after)) {
      throw sourceError(
        "DRIFT_SOURCE_UNSTABLE",
        `Source directory changed before observation completed: ${snapshot.path || "."}`,
      );
    }
  }
  for (const file of sortedFiles) {
    if (!matchedFiles.has(file.path)) continue;
    const after = await metadataIfPresent(file.absolutePath);
    if (!sameFileIdentity(file.metadata, after)) {
      throw sourceError(
        "DRIFT_SOURCE_UNSTABLE",
        `Bound source file changed before observation completed: ${file.path}`,
      );
    }
  }

  const bindingObservations = preparedBindings.map((binding) => {
    const files = filesByBinding.get(binding.specifier);
    const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
    return {
      specifier: binding.specifier,
      kind: binding.kind,
      ref: binding.ref,
      fingerprint: aggregateFileMap(files),
      fileCount: files.length,
      totalBytes,
      files,
    };
  });

  skipped.values.sort(portableCompare);
  missing.values.sort(portableCompare);

  return {
    specification: DRIFT_SOURCE_POLICY.specification,
    authority: "raw_bytes_sha256",
    workspace: { path: workspaceRealPath },
    bindings: bindingObservations,
    coverage: {
      boundRoots: roots.map((root) => root.ref || "."),
      directoriesVisited: visitedDirectories.size,
      filesInspected: discoveredFiles.size,
      uniqueFilesMatched: matchedFiles.size,
      totalBytesInspected: totalInspectedBytes,
      totalBytesHashed,
      matchEvaluations,
      skippedDirectoryCount: skipped.count,
      skippedDirectories: skipped.values,
      skippedDirectoriesTruncated: skipped.count > skipped.values.length,
      missingRootCount: missing.count,
      missingRoots: missing.values,
      missingRootsTruncated: missing.count > missing.values.length,
    },
    git,
  };
}
