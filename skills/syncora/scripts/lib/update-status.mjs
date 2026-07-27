import { dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { VERSION } from "./version.mjs";

export const UPDATE_SOURCE_URL =
  "https://raw.githubusercontent.com/rayfould/Syncora/main/package.json";
const MAXIMUM_RESPONSE_BYTES = 32_768;
const DEFAULT_TIMEOUT_MS = 4_000;
const VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u;

function parseVersion(value) {
  if (typeof value !== "string") return null;
  const match = VERSION_PATTERN.exec(value);
  if (!match) return null;
  return {
    value,
    core: match.slice(1, 4).map(BigInt),
    prerelease: match[4] === undefined ? [] : match[4].split("."),
  };
}

function compareIdentifier(left, right) {
  const leftNumeric = /^\d+$/u.test(left);
  const rightNumeric = /^\d+$/u.test(right);
  if (leftNumeric && rightNumeric) {
    if (left.length !== right.length) return Math.sign(left.length - right.length);
    return left === right ? 0 : left < right ? -1 : 1;
  }
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

export function compareVersions(leftValue, rightValue) {
  const left = parseVersion(leftValue);
  const right = parseVersion(rightValue);
  if (!left || !right) return null;

  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) {
      return left.core[index] < right.core[index] ? -1 : 1;
    }
  }

  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;

  const maximum = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < maximum; index += 1) {
    if (left.prerelease[index] === undefined) return -1;
    if (right.prerelease[index] === undefined) return 1;
    const comparison = compareIdentifier(
      left.prerelease[index],
      right.prerelease[index],
    );
    if (comparison !== 0) return Math.sign(comparison);
  }
  return 0;
}

function isWithin(candidate, root) {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`));
}

export function inferUpdateCommand({
  skillRoot,
  currentDirectory = process.cwd(),
}) {
  const normalized = skillRoot.split(sep).join("/").toLowerCase();
  const projectRoot = dirname(dirname(dirname(skillRoot)));
  const isProjectInstall =
    normalized.endsWith("/.agents/skills/syncora") &&
    isWithin(currentDirectory, projectRoot);
  return {
    installationScope: isProjectInstall ? "project" : "global-or-shared",
    command: isProjectInstall
      ? "npx skills update syncora"
      : "npx skills update syncora --global",
  };
}

function unknownResult({ reason, update }) {
  return {
    ok: true,
    command: "update-status",
    state: "unknown",
    currentVersion: VERSION,
    latestVersion: null,
    automaticUpdate: false,
    notificationRequired: true,
    update,
    warning: {
      code: "UPDATE_STATUS_UNKNOWN",
      message: `Could not verify the latest Syncora version: ${reason}`,
    },
  };
}

async function readBoundedBody(response) {
  if (typeof response.body?.getReader !== "function") {
    const fallback = new Uint8Array(await response.arrayBuffer());
    return fallback.byteLength <= MAXIMUM_RESPONSE_BYTES ? fallback : null;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAXIMUM_RESPONSE_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function checkForSyncoraUpdate({
  fetchImpl = globalThis.fetch,
  sourceUrl = UPDATE_SOURCE_URL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  skillRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url)))),
  currentDirectory = process.cwd(),
} = {}) {
  const update = inferUpdateCommand({ skillRoot, currentDirectory });
  if (typeof fetchImpl !== "function") {
    return unknownResult({ reason: "network fetch is unavailable", update });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(sourceUrl, {
      headers: {
        accept: "application/json",
        "user-agent": `syncora/${VERSION}`,
      },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response?.ok) {
      return unknownResult({
        reason: `release endpoint returned HTTP ${response?.status ?? "unknown"}`,
        update,
      });
    }

    const declaredLength = Number(response.headers?.get?.("content-length"));
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > MAXIMUM_RESPONSE_BYTES
    ) {
      return unknownResult({ reason: "release metadata was oversized", update });
    }

    const bytes = await readBoundedBody(response);
    if (bytes === null) {
      return unknownResult({ reason: "release metadata was oversized", update });
    }

    let packageJson;
    try {
      packageJson = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      return unknownResult({ reason: "release metadata was invalid", update });
    }
    const latestVersion = packageJson?.version;
    const comparison = compareVersions(VERSION, latestVersion);
    if (comparison === null) {
      return unknownResult({
        reason: "release metadata did not contain a valid semantic version",
        update,
      });
    }

    const state = comparison < 0
      ? "outdated"
      : comparison > 0
        ? "ahead"
        : "current";
    return {
      ok: true,
      command: "update-status",
      state,
      currentVersion: VERSION,
      latestVersion,
      automaticUpdate: false,
      notificationRequired: state === "outdated",
      update,
      warning: state === "outdated"
        ? {
            code: "SYNCORA_UPDATE_AVAILABLE",
            message: `Syncora ${latestVersion} is available; installed version is ${VERSION}.`,
          }
        : null,
    };
  } catch (error) {
    const reason = error?.name === "AbortError"
      ? "release check timed out"
      : "release endpoint was unreachable";
    return unknownResult({ reason, update });
  } finally {
    clearTimeout(timeout);
  }
}
