import { constants as fsConstants } from "node:fs";
import { spawn } from "node:child_process";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { SyncoraError } from "./cli.mjs";
import {
  BOUNDED_READ_MAX_STDERR_BYTES,
  boundedReadIdentityFromStat,
  boundedReadStdoutLimit,
  decodeBoundedReadEnvelope,
  sameBoundedReadIdentity,
} from "./bounded-reader-protocol.mjs";
import { normalizeSyncoraRuntimeConfig } from "./checkpoint-config.mjs";

const CONFIG_MAX_BYTES = 1_048_576;
export const LOCAL_CONFIG_SCHEMA_VERSION = 1;
export const LOCAL_CONFIG_MAX_BYTES = 65_536;
// The isolated-reader deadline includes a cold Node process start as well as
// the bounded file operation. Windows process startup can exceed two seconds
// under antivirus or CI load, so keep enough scheduling headroom while still
// failing closed on a hung or hostile file.
const WINDOWS_SAFE_READ_TIMEOUT_MS = 5_000;
const WINDOWS_SAFE_READER_PATH = fileURLToPath(
  new URL("./bounded-reader-worker.mjs", import.meta.url),
);

async function pathType(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function pathTypeBigInt(path) {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function normalized(path) {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

export function samePath(left, right) {
  return normalized(left) === normalized(right);
}

export function isWithin(parent, child) {
  const result = relative(parent, child);
  return (
    result === "" ||
    (!result.startsWith(`..${sep}`) && result !== ".." && !isAbsolute(result))
  );
}

function isDirectChild(parent, child) {
  const result = relative(parent, child);
  return (
    result !== "" &&
    result !== ".." &&
    !result.startsWith(`..${sep}`) &&
    !isAbsolute(result) &&
    !result.includes(sep)
  );
}

async function readAtMost(handle, maximumBytes, expectedBytes = maximumBytes) {
  if (
    !Number.isSafeInteger(expectedBytes) ||
    expectedBytes < 0 ||
    expectedBytes > maximumBytes
  ) {
    throw new TypeError("Bounded-reader expected size is invalid.");
  }
  const target = Buffer.alloc(expectedBytes + 1);
  let offset = 0;
  while (offset < target.length) {
    const { bytesRead } = await handle.read(
      target,
      offset,
      target.length - offset,
      offset,
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return target.subarray(0, offset);
}

function sameFileSnapshot(left, right) {
  try {
    const leftIdentity = left?.kind
      ? left
      : boundedReadIdentityFromStat(left);
    const rightIdentity = right?.kind
      ? right
      : boundedReadIdentityFromStat(right);
    return sameBoundedReadIdentity(leftIdentity, rightIdentity);
  } catch {
    return false;
  }
}

function sameDirectoryIdentity(left, right) {
  if (
    !left?.isDirectory() ||
    !right?.isDirectory() ||
    left.isSymbolicLink() ||
    right.isSymbolicLink()
  ) {
    return false;
  }
  if (
    String(left.dev) !== "0" ||
    String(left.ino) !== "0" ||
    String(right.dev) !== "0" ||
    String(right.ino) !== "0"
  ) {
    return left.dev === right.dev && left.ino === right.ino;
  }
  return (
    left.mode === right.mode &&
    (left.birthtimeNs ?? left.birthtimeMs) ===
      (right.birthtimeNs ?? right.birthtimeMs)
  );
}

function changedWhileReading(code, label, path) {
  return new SyncoraError(
    code,
    `${label} changed while it was being read: ${path}`,
    { reason: "changed" },
  );
}

async function readWindowsFileIsolated(
  path,
  maximumBytes,
  {
    code,
    label,
    timeoutMs = WINDOWS_SAFE_READ_TIMEOUT_MS,
    program = undefined,
  },
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new SyncoraError(code, `${label} read timeout policy is invalid.`);
  }
  const maximumStdoutBytes = boundedReadStdoutLimit(maximumBytes);
  const arguments_ = program
    ? ["-e", program, path, String(maximumBytes)]
    : [WINDOWS_SAFE_READER_PATH, path, String(maximumBytes)];
  const childEnvironment = { ...process.env };
  delete childEnvironment.NODE_OPTIONS;
  delete childEnvironment.NODE_PATH;

  const outcome = await new Promise((resolve) => {
    const child = spawn(process.execPath, arguments_, {
      env: childEnvironment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timer;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    const terminate = (kind) => {
      child.kill("SIGKILL");
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish({ kind });
    };

    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maximumStdoutBytes) {
        terminate("stdout-limit");
        return;
      }
      stdout.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > BOUNDED_READ_MAX_STDERR_BYTES) {
        terminate("stderr-limit");
        return;
      }
      stderr.push(Buffer.from(chunk));
    });
    child.once("error", (error) => finish({ kind: "spawn-error", error }));
    child.once("close", (status, signal) =>
      finish({
        kind: "exit",
        status,
        signal,
        stdout: Buffer.concat(stdout, stdoutBytes),
        stderr: Buffer.concat(stderr, stderrBytes),
      }),
    );
    timer = setTimeout(() => terminate("timeout"), timeoutMs);
    if (settled) clearTimeout(timer);
  });

  if (outcome.kind === "timeout") {
    throw new SyncoraError(
      code,
      `${label} read exceeded the ${timeoutMs}ms safety deadline: ${path}`,
      { reason: "timeout" },
    );
  }
  if (outcome.kind === "stdout-limit" || outcome.kind === "stderr-limit") {
    throw new SyncoraError(
      code,
      `${label} isolated reader exceeded its output limit: ${path}`,
      { reason: "protocol" },
    );
  }
  if (outcome.kind === "spawn-error") {
    throw new SyncoraError(
      code,
      `${label} isolated reader could not be started: ${path}`,
      {
        reason: "spawn",
        cause:
          outcome.error instanceof Error
            ? outcome.error.message
            : String(outcome.error),
      },
    );
  }
  if (outcome.kind !== "exit") {
    throw new SyncoraError(code, `${label} isolated reader failed safely: ${path}`);
  }

  const stderrText = outcome.stderr.toString("ascii");
  if (outcome.status !== 0 || outcome.signal !== null) {
    if (outcome.stdout.length !== 0) {
      throw new SyncoraError(
        code,
        `${label} isolated reader returned an invalid error envelope: ${path}`,
        { reason: "protocol" },
      );
    }
    if (stderrText === "SYNCORA_SAFE_READ:NOT_REGULAR") {
      throw new SyncoraError(code, `${label} is not a safe regular file: ${path}`);
    }
    if (stderrText === "SYNCORA_SAFE_READ:TOO_LARGE") {
      throw new SyncoraError(
        code,
        `${label} exceeds ${maximumBytes} bytes: ${path}`,
      );
    }
    const fsCode = /^SYNCORA_SAFE_READ:FS:([A-Z0-9_]{1,48})$/.exec(
      stderrText,
    )?.[1];
    if (fsCode) {
      const error = new Error(`${label} isolated read failed with ${fsCode}.`);
      error.code = fsCode;
      throw error;
    }
    throw new SyncoraError(
      code,
      `${label} isolated reader failed safely: ${path}`,
      { reason: "protocol" },
    );
  }
  if (outcome.stderr.length !== 0) {
    throw new SyncoraError(
      code,
      `${label} isolated reader returned unexpected diagnostics: ${path}`,
      { reason: "protocol" },
    );
  }

  try {
    return decodeBoundedReadEnvelope(outcome.stdout, maximumBytes);
  } catch (error) {
    throw new SyncoraError(
      code,
      `${label} isolated reader returned an invalid envelope: ${path}`,
      {
        reason: "protocol",
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

export async function readBoundedRegularFileIfPresent(
  path,
  {
    containmentRoot,
    maximumBytes,
    code,
    label,
    allowTransientMissing = false,
    beforeOpen = undefined,
    afterRead = undefined,
    isolatedReaderProgram = undefined,
    readTimeoutMs = WINDOWS_SAFE_READ_TIMEOUT_MS,
    beforeHandleOpen = undefined,
    isolateOnWindows = true,
  },
) {
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 0 ||
    maximumBytes > 16_777_216
  ) {
    throw new SyncoraError(code, `${label} maximum read size is invalid.`);
  }
  if (!isDirectChild(containmentRoot, path)) {
    throw new SyncoraError(
      code,
      `${label} path is not a direct child of its trusted directory: ${path}`,
    );
  }
  let directoryBefore;
  let before;
  try {
    directoryBefore = await pathTypeBigInt(containmentRoot);
    if (
      !directoryBefore?.isDirectory() ||
      directoryBefore.isSymbolicLink()
    ) {
      throw new SyncoraError(
        code,
        `${label} trusted directory is unsafe: ${containmentRoot}`,
      );
    }
    before = await pathTypeBigInt(path);
  } catch (error) {
    if (error instanceof SyncoraError) throw error;
    throw new SyncoraError(code, `${label} could not be inspected safely: ${path}`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (!before) return null;
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new SyncoraError(code, `${label} is not a safe regular file: ${path}`);
  }
  if (before.size > BigInt(maximumBytes)) {
    throw new SyncoraError(
      code,
      `${label} exceeds ${maximumBytes} bytes: ${path}`,
    );
  }

  let handle;
  try {
    const useIsolatedWindowsReader =
      process.platform === "win32" && isolateOnWindows;
    let resolvedDirectoryBefore = containmentRoot;
    if (!useIsolatedWindowsReader) {
      resolvedDirectoryBefore = await realpath(containmentRoot);
      if (!samePath(resolvedDirectoryBefore, containmentRoot)) {
        throw new SyncoraError(
          code,
          `${label} trusted directory resolves through an unsafe alias: ${containmentRoot}`,
        );
      }
      const resolvedPath = await realpath(path);
      if (!isWithin(resolvedDirectoryBefore, resolvedPath)) {
        throw new SyncoraError(
          code,
          `${label} escapes its trusted directory: ${resolvedPath}`,
        );
      }
    }

    const noFollow = fsConstants.O_NOFOLLOW ?? 0;
    const nonBlock = fsConstants.O_NONBLOCK ?? 0;
    if (beforeOpen) await beforeOpen();
    const directoryBeforeOpen = await pathTypeBigInt(containmentRoot);
    const fileBeforeOpen = await pathTypeBigInt(path);
    if (
      !sameDirectoryIdentity(directoryBefore, directoryBeforeOpen) ||
      !sameFileSnapshot(before, fileBeforeOpen)
    ) {
      throw changedWhileReading(code, label, path);
    }
    if (!useIsolatedWindowsReader) {
      const resolvedDirectoryBeforeOpen = await realpath(containmentRoot);
      const resolvedPathBeforeOpen = await realpath(path);
      if (
        !samePath(resolvedDirectoryBefore, resolvedDirectoryBeforeOpen) ||
        !isWithin(resolvedDirectoryBeforeOpen, resolvedPathBeforeOpen)
      ) {
        throw changedWhileReading(code, label, path);
      }
    }
    let openedBefore = before;
    let openedAfter = before;
    let buffer;
    if (beforeHandleOpen) await beforeHandleOpen();
    if (useIsolatedWindowsReader) {
      const isolated = await readWindowsFileIsolated(path, maximumBytes, {
        code,
        label,
        timeoutMs: readTimeoutMs,
        program: isolatedReaderProgram,
      });
      openedBefore = isolated.before;
      openedAfter = isolated.after;
      buffer = isolated.bytes;
    } else {
      handle = await open(path, fsConstants.O_RDONLY | noFollow | nonBlock);
      openedBefore = await handle.stat({ bigint: true });
      const directoryAtOpen = await pathTypeBigInt(containmentRoot);
      const resolvedDirectoryAtOpen = await realpath(containmentRoot);
      if (
        !sameFileSnapshot(before, openedBefore) ||
        !sameDirectoryIdentity(directoryBefore, directoryAtOpen) ||
        !samePath(resolvedDirectoryBefore, resolvedDirectoryAtOpen)
      ) {
        throw changedWhileReading(code, label, path);
      }
      buffer = await readAtMost(
        handle,
        maximumBytes,
        Number(openedBefore.size),
      );
      openedAfter = await handle.stat({ bigint: true });
    }
    if (afterRead) await afterRead();
    const after = await pathTypeBigInt(path);
    const directoryAfter = await pathTypeBigInt(containmentRoot);

    if (buffer.length > maximumBytes) {
      throw new SyncoraError(
        code,
        `${label} exceeds ${maximumBytes} bytes: ${path}`,
      );
    }
    if (allowTransientMissing && (!after || !directoryAfter)) return null;
    if (
      !sameFileSnapshot(before, openedBefore) ||
      !sameFileSnapshot(openedBefore, openedAfter) ||
      !sameFileSnapshot(openedAfter, after) ||
      !sameDirectoryIdentity(directoryBefore, directoryAfter) ||
      buffer.length !== Number(BigInt(openedAfter.size))
    ) {
      throw changedWhileReading(code, label, path);
    }
    if (!useIsolatedWindowsReader) {
      const resolvedDirectoryAfter = await realpath(containmentRoot);
      if (!samePath(resolvedDirectoryBefore, resolvedDirectoryAfter)) {
        throw changedWhileReading(code, label, path);
      }
    }
    return buffer;
  } catch (error) {
    if (allowTransientMissing && error?.code === "ENOENT") return null;
    if (error instanceof SyncoraError) throw error;
    throw new SyncoraError(code, `${label} could not be read safely: ${path}`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}

async function runtimeRootIfPresent(workspacePath) {
  const runtimePath = join(workspacePath, ".syncora");
  const metadata = await pathType(runtimePath);
  if (!metadata) return null;
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new SyncoraError(
      "CONFIG001",
      `Syncora runtime root is not a safe directory: ${runtimePath}`,
    );
  }
  const resolved = await realpath(runtimePath);
  if (!isWithin(workspacePath, resolved)) {
    throw new SyncoraError(
      "CONFIG001",
      `Syncora runtime root escapes the workspace: ${resolved}`,
    );
  }
  return resolved;
}

export async function readSyncoraConfigIfPresent(workspacePath, hooks = {}) {
  const runtimeRoot = await runtimeRootIfPresent(workspacePath);
  if (!runtimeRoot) return null;

  const path = join(runtimeRoot, "config.json");
  const buffer = await readBoundedRegularFileIfPresent(path, {
    containmentRoot: runtimeRoot,
    maximumBytes: CONFIG_MAX_BYTES,
    code: "CONFIG001",
    label: "Syncora configuration",
    beforeOpen: hooks.beforeOpen,
    afterRead: hooks.afterRead,
    isolatedReaderProgram: hooks.isolatedReaderProgram,
    readTimeoutMs: hooks.readTimeoutMs,
    beforeHandleOpen: hooks.beforeHandleOpen,
  });
  if (!buffer) return null;

  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new SyncoraError("CONFIG001", `Invalid UTF-8: ${path}`);
  }
  if (text.startsWith("\ufeff")) text = text.slice(1);

  let config;
  try {
    config = JSON.parse(text);
  } catch {
    throw new SyncoraError("CONFIG001", `Invalid JSON: ${path}`);
  }
  const normalized = normalizeSyncoraRuntimeConfig(config);
  return {
    path,
    buffer,
    config,
    maintenance: normalized.maintenance,
  };
}

function normalizeLocalConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new SyncoraError(
      "CONFIG002",
      "Syncora local configuration must be a JSON object.",
    );
  }
  if (!Number.isInteger(config.schemaVersion) || config.schemaVersion < 1) {
    throw new SyncoraError(
      "CONFIG002",
      "Syncora local config schemaVersion must be a positive integer.",
    );
  }
  if (config.schemaVersion > LOCAL_CONFIG_SCHEMA_VERSION) {
    throw new SyncoraError(
      "SCHEMA001",
      `Local config schema ${config.schemaVersion} is newer than supported schema ${LOCAL_CONFIG_SCHEMA_VERSION}.`,
    );
  }

  const expectedKeys = ["externalGraphRoots", "schemaVersion"];
  const actualKeys = Object.keys(config).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    !actualKeys.every((key, index) => key === expectedKeys[index])
  ) {
    throw new SyncoraError(
      "CONFIG002",
      "Syncora local configuration contains missing or unknown fields.",
    );
  }
  if (
    !Array.isArray(config.externalGraphRoots) ||
    config.externalGraphRoots.length > 64
  ) {
    throw new SyncoraError(
      "CONFIG002",
      "externalGraphRoots must be an array with no more than 64 entries.",
    );
  }

  const roots = [];
  for (const root of config.externalGraphRoots) {
    if (
      typeof root !== "string" ||
      root.length === 0 ||
      root.length > 32_768 ||
      /[\0\r\n]/.test(root) ||
      !isAbsolute(root)
    ) {
      throw new SyncoraError(
        "CONFIG002",
        "Each externalGraphRoots entry must be a bounded absolute path.",
      );
    }
    if (roots.some((candidate) => samePath(candidate, root))) {
      throw new SyncoraError(
        "CONFIG002",
        "externalGraphRoots must not contain duplicate paths.",
      );
    }
    roots.push(root);
  }

  return {
    schemaVersion: LOCAL_CONFIG_SCHEMA_VERSION,
    externalGraphRoots: roots,
  };
}

export async function readSyncoraLocalConfigIfPresent(
  workspacePath,
  hooks = {},
) {
  const runtimeRoot = await runtimeRootIfPresent(workspacePath);
  if (!runtimeRoot) return null;
  const path = join(runtimeRoot, "local.json");
  const buffer = await readBoundedRegularFileIfPresent(path, {
    containmentRoot: runtimeRoot,
    maximumBytes: LOCAL_CONFIG_MAX_BYTES,
    code: "CONFIG002",
    label: "Syncora local configuration",
    beforeOpen: hooks.beforeOpen,
    afterRead: hooks.afterRead,
    isolatedReaderProgram: hooks.isolatedReaderProgram,
    readTimeoutMs: hooks.readTimeoutMs,
    beforeHandleOpen: hooks.beforeHandleOpen,
  });
  if (!buffer) return null;

  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new SyncoraError("CONFIG002", `Invalid UTF-8: ${path}`);
  }
  if (text.startsWith("\ufeff")) text = text.slice(1);

  let config;
  try {
    config = JSON.parse(text);
  } catch {
    throw new SyncoraError("CONFIG002", `Invalid JSON: ${path}`);
  }
  return {
    path,
    buffer,
    config: normalizeLocalConfig(config),
  };
}

export async function requireInitializedWorkspace(workspacePath) {
  const loaded = await readSyncoraConfigIfPresent(workspacePath);
  if (!loaded) {
    throw new SyncoraError(
      "CONFIG001",
      "Workspace is not initialized. Run syncora init first.",
    );
  }
  return loaded.config;
}

export async function resolveWorkspace(workspacePath) {
  if (!isAbsolute(workspacePath)) {
    throw new SyncoraError(
      "WORKSPACE002",
      `Workspace path must be absolute: ${workspacePath}`,
    );
  }

  const metadata = await pathType(workspacePath);
  if (!metadata) {
    throw new SyncoraError(
      "WORKSPACE003",
      `Workspace does not exist: ${workspacePath}`,
    );
  }
  if (!metadata.isDirectory()) {
    throw new SyncoraError(
      "WORKSPACE004",
      `Workspace is not a directory: ${workspacePath}`,
    );
  }

  return {
    requestedPath: workspacePath,
    realPath: await realpath(workspacePath),
  };
}

async function resolveAllowlistedPath(path) {
  if (!path) return undefined;
  if (!isAbsolute(path)) {
    throw new SyncoraError(
      "WRITE002",
      `External graph allowlist path must be absolute: ${path}`,
    );
  }
  return realpath(path).catch(() => {
    throw new SyncoraError(
      "WRITE002",
      `External graph allowlist path does not exist: ${path}`,
    );
  });
}

export async function resolveGraphContext(
  workspace,
  { allowExternalGraphRoot = undefined, permitUnallowed = false } = {},
) {
  const graphPath = join(workspace.realPath, "local");
  const graphMetadata = await pathType(graphPath);

  if (graphMetadata && !graphMetadata.isDirectory() && !graphMetadata.isSymbolicLink()) {
    throw new SyncoraError(
      "GRAPH001",
      `Graph root is not a directory: ${graphPath}`,
    );
  }

  const resolvedGraphPath = graphMetadata
    ? await realpath(graphPath)
    : graphPath;
  const external = !isWithin(workspace.realPath, resolvedGraphPath);
  const localConfigInfo = await readSyncoraLocalConfigIfPresent(
    workspace.realPath,
  );
  const localConfigPath =
    localConfigInfo?.path ?? join(workspace.realPath, ".syncora", "local.json");
  const localConfig = localConfigInfo?.config ?? null;
  const storedAllowedRoots = Array.isArray(localConfig?.externalGraphRoots)
    ? localConfig.externalGraphRoots
    : [];
  const requestedAllowedRoot = await resolveAllowlistedPath(
    allowExternalGraphRoot,
  );
  const allowed =
    !external ||
    storedAllowedRoots.some((item) => samePath(item, resolvedGraphPath)) ||
    (requestedAllowedRoot && samePath(requestedAllowedRoot, resolvedGraphPath));

  if (external && !allowed && !permitUnallowed) {
    throw new SyncoraError(
      "WRITE002",
      `Graph root resolves outside the workspace: ${resolvedGraphPath}`,
      {
        graphPath,
        resolvedGraphPath,
        fix: "Pass --allow-external-graph-root with this exact resolved path.",
      },
    );
  }

  const nextLocalConfig =
    external && requestedAllowedRoot && allowed
      ? {
          schemaVersion: 1,
          externalGraphRoots: [resolvedGraphPath],
        }
      : null;

  return {
    graphPath,
    resolvedGraphPath,
    external,
    allowed,
    localConfig,
    localConfigPath,
    nextLocalConfig,
  };
}
