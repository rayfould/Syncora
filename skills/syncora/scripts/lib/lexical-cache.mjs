import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

import { SyncoraError } from "./cli.mjs";
import {
  estimateLexicalCacheBytes,
  LEXICAL_POLICY,
  lexicalIndexSpecId,
} from "./lexical-index.mjs";
import { isWithin, samePath } from "./workspace.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedRoot(root) {
  return process.platform === "win32"
    ? root.replaceAll("\\", "/").toLowerCase()
    : root;
}

export function lexicalRootIdentity(graphRoot) {
  return `sha256:${sha256(`syncora-graph-root-v1\n${normalizedRoot(graphRoot)}`)}`;
}

function payloadFromEnvelope(envelope) {
  return {
    schemaVersion: envelope.schemaVersion,
    indexSpecId: envelope.indexSpecId,
    rootIdentity: envelope.rootIdentity,
    graphRevision: envelope.graphRevision,
    indexRevision: envelope.indexRevision,
    documents: envelope.documents,
  };
}

function payloadChecksum(payload) {
  return sha256(JSON.stringify(payload));
}

function warning(message, details = undefined) {
  return {
    code: "CACHE001",
    message,
    ...(details === undefined ? {} : { details }),
  };
}

async function metadataOrNull(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function ensureContainedDirectory(path, workspaceRoot, create) {
  let metadata = await metadataOrNull(path);
  if (!metadata && create) {
    try {
      await mkdir(path);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    metadata = await lstat(path);
  }
  if (!metadata || !metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new SyncoraError("CACHE001", `Cache directory is missing or unsafe: ${path}`);
  }
  const resolved = await realpath(path);
  if (!isWithin(workspaceRoot, resolved)) {
    throw new SyncoraError("CACHE001", `Cache directory escapes the workspace: ${path}`);
  }
  return resolved;
}

export async function resolveLexicalCache(workspaceRoot, graphRoot, profile) {
  const syncoraRoot = join(workspaceRoot, ".syncora");
  const cacheRoot = join(syncoraRoot, "cache");
  const lexicalRoot = join(cacheRoot, "lexical-v1");
  await ensureContainedDirectory(syncoraRoot, workspaceRoot, false);
  await ensureContainedDirectory(cacheRoot, workspaceRoot, true);
  const cacheDirectory = await ensureContainedDirectory(lexicalRoot, workspaceRoot, true);

  const rootIdentity = lexicalRootIdentity(graphRoot);
  const indexSpecId = lexicalIndexSpecId(profile);
  const cacheFile = join(
    lexicalRoot,
    `${rootIdentity.slice("sha256:".length)}-${profile}.json`,
  );
  const context = {
    cacheFile,
    cacheDirectory,
    indexSpecId,
    profile,
    rootIdentity,
    workspaceRoot,
  };
  await cleanupStaleTemporaryFiles(context);
  return context;
}

async function cleanupStaleTemporaryFiles(context) {
  await assertCacheDirectory(context);
  const directory = await opendir(context.cacheDirectory);
  let entries = 0;
  for await (const entry of directory) {
    entries += 1;
    if (entries > LEXICAL_POLICY.maxCacheDirectoryEntries) {
      throw new SyncoraError("CACHE001", "Lexical cache directory entry limit exceeded.", {
        limit: LEXICAL_POLICY.maxCacheDirectoryEntries,
      });
    }
    if (
      !entry.isFile() ||
      !/^\.syncora-lexical-\d+-[0-9a-f-]{36}\.tmp$/i.test(entry.name)
    ) {
      continue;
    }
    const path = join(context.cacheDirectory, entry.name);
    const metadata = await metadataOrNull(path);
    if (
      !metadata?.isFile() ||
      metadata.isSymbolicLink() ||
      Date.now() - metadata.mtimeMs < LEXICAL_POLICY.staleTemporaryAgeMs
    ) {
      continue;
    }
    await assertContainedCacheFile(path, context);
    await rm(path, { force: true });
  }
}

function validSha(value) {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function validSourceSha(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function validCachePath(value) {
  return (
    typeof value === "string" &&
    value !== "" &&
    !isAbsolute(value) &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.split("/").some((segment) => segment === "..") &&
    !/[\u0000-\u001f\u007f-\u009f]/.test(value)
  );
}

function validatePayload(payload, expectedRootIdentity, expectedIndexSpecId) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Cache payload must be an object.");
  }
  if (
    payload.schemaVersion !== LEXICAL_POLICY.cacheSchemaVersion ||
    payload.indexSpecId !== expectedIndexSpecId ||
    payload.rootIdentity !== expectedRootIdentity ||
    !validSha(payload.rootIdentity) ||
    !validSha(payload.graphRevision) ||
    !validSha(payload.indexRevision) ||
    !Array.isArray(payload.documents) ||
    payload.documents.length > LEXICAL_POLICY.maxDocuments
  ) {
    throw new Error("Cache header is invalid or incompatible.");
  }

  let previousPath = null;
  let postings = 0;
  for (const document of payload.documents) {
    if (
      !document ||
      typeof document !== "object" ||
      !validCachePath(document.path) ||
      !validSourceSha(document.sourceSha256) ||
      !Array.isArray(document.terms) ||
      document.terms.length > LEXICAL_POLICY.maxUniqueTermsPerNote ||
      (previousPath !== null && document.path <= previousPath)
    ) {
      throw new Error("Cache document metadata is invalid or unsorted.");
    }
    previousPath = document.path;
    let previousTerm = null;
    for (const pair of document.terms) {
      if (
        !Array.isArray(pair) ||
        pair.length !== 2 ||
        typeof pair[0] !== "string" ||
        pair[0] === "" ||
        [...pair[0]].length > LEXICAL_POLICY.maxTokenCharacters ||
        !/^[\p{L}\p{N}]+$/u.test(pair[0]) ||
        pair[0] !== pair[0].normalize("NFKC").toLowerCase() ||
        !Number.isSafeInteger(pair[1]) ||
        pair[1] <= 0 ||
        pair[1] > LEXICAL_POLICY.maxTermWeight ||
        (previousTerm !== null && pair[0] <= previousTerm)
      ) {
        throw new Error("Cache term vector is invalid or unsorted.");
      }
      previousTerm = pair[0];
      postings += 1;
      if (postings > LEXICAL_POLICY.maxTotalPostings) {
        throw new Error("Cache posting limit exceeded.");
      }
    }
  }
  return payload;
}

async function assertCacheDirectory(context) {
  const directoryPath = dirname(context.cacheFile);
  const metadata = await metadataOrNull(directoryPath);
  if (!metadata?.isDirectory() || metadata.isSymbolicLink()) {
    throw new SyncoraError("CACHE001", "Lexical cache directory identity changed.");
  }
  const resolved = await realpath(directoryPath);
  if (
    !samePath(resolved, context.cacheDirectory) ||
    !isWithin(context.workspaceRoot, resolved)
  ) {
    throw new SyncoraError("CACHE001", "Lexical cache directory escaped its validated root.");
  }
  return resolved;
}

function sameFileIdentity(left, right) {
  if (left.dev !== 0 || left.ino !== 0 || right.dev !== 0 || right.ino !== 0) {
    return left.dev === right.dev && left.ino === right.ino;
  }
  return left.size === right.size && left.mtimeMs === right.mtimeMs;
}

async function assertContainedCacheFile(path, context) {
  const resolved = await realpath(path);
  if (!samePath(dirname(resolved), context.cacheDirectory)) {
    throw new SyncoraError("CACHE001", "Lexical cache file escaped its validated directory.");
  }
  return resolved;
}

async function removeOwnedTemporary(path, context) {
  try {
    await assertCacheDirectory(context);
    const metadata = await metadataOrNull(path);
    if (!metadata?.isFile() || metadata.isSymbolicLink()) return;
    await assertContainedCacheFile(path, context);
    await rm(path, { force: true });
  } catch {
    // A changed directory identity is safer to leave for later cleanup.
  }
}

export async function readLexicalCache(context) {
  let handle;
  try {
    await assertCacheDirectory(context);
    const metadata = await metadataOrNull(context.cacheFile);
    if (!metadata) return { payload: null, state: "miss", warning: null };
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      return {
        payload: null,
        state: "rebuild",
        warning: warning("Lexical cache path is not a regular file."),
      };
    }
    await assertContainedCacheFile(context.cacheFile, context);
    handle = await open(context.cacheFile, "r");
    const openedMetadata = await handle.stat();
    if (!openedMetadata.isFile() || !sameFileIdentity(metadata, openedMetadata)) {
      throw new Error("Cache file identity changed while it was opened.");
    }
    if (openedMetadata.size > LEXICAL_POLICY.maxCacheBytes) {
      await handle.close();
      handle = null;
      return {
        payload: null,
        state: "rebuild",
        warning: warning("Lexical cache exceeds its byte limit.", {
          bytes: openedMetadata.size,
          limit: LEXICAL_POLICY.maxCacheBytes,
        }),
      };
    }

    const buffer = await handle.readFile();
    const finalOpenedMetadata = await handle.stat();
    await handle.close();
    handle = null;
    if (
      buffer.length !== openedMetadata.size ||
      openedMetadata.size !== finalOpenedMetadata.size ||
      openedMetadata.mtimeMs !== finalOpenedMetadata.mtimeMs
    ) {
      throw new Error("Cache file changed while it was being read.");
    }
    await assertCacheDirectory(context);
    const finalPathMetadata = await metadataOrNull(context.cacheFile);
    if (!finalPathMetadata || !sameFileIdentity(openedMetadata, finalPathMetadata)) {
      throw new Error("Cache file path identity changed while it was being read.");
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    const envelope = JSON.parse(text);
    const payload = validatePayload(
      payloadFromEnvelope(envelope),
      context.rootIdentity,
      context.indexSpecId,
    );
    if (envelope.payloadSha256 !== payloadChecksum(payload)) {
      throw new Error("Cache payload checksum does not match.");
    }
    return { payload, state: "loaded", warning: null };
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    return {
      payload: null,
      state: "rebuild",
      warning: warning("Lexical cache was ignored and will be rebuilt.", {
        cause: error instanceof Error ? error.message : String(error),
      }),
    };
  }
}

export async function writeLexicalCache(context, payload) {
  await assertCacheDirectory(context);
  const targetMetadata = await metadataOrNull(context.cacheFile);
  if (targetMetadata?.isSymbolicLink() || (targetMetadata && !targetMetadata.isFile())) {
    throw new SyncoraError("CACHE001", "Refusing to replace an unsafe lexical cache path.");
  }

  const validated = validatePayload(
    payload,
    context.rootIdentity,
    context.indexSpecId,
  );
  const estimatedBytes = estimateLexicalCacheBytes(validated);
  if (estimatedBytes > LEXICAL_POLICY.maxCacheBytes) {
    throw new SyncoraError("CACHE001", "Lexical cache output exceeds its byte limit.", {
      bytes: estimatedBytes,
      limit: LEXICAL_POLICY.maxCacheBytes,
    });
  }
  const envelope = {
    ...validated,
    payloadSha256: payloadChecksum(validated),
  };
  const bytes = Buffer.from(`${JSON.stringify(envelope)}\n`, "utf8");
  if (bytes.length !== estimatedBytes) {
    throw new SyncoraError("CACHE001", "Lexical cache byte accounting diverged.", {
      estimatedBytes,
      actualBytes: bytes.length,
    });
  }

  const temporary = join(
    context.cacheDirectory,
    `.syncora-lexical-${process.pid}-${randomUUID()}.tmp`,
  );
  let handle;
  try {
    await assertCacheDirectory(context);
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await assertCacheDirectory(context);
    await assertContainedCacheFile(temporary, context);
    const finalTargetMetadata = await metadataOrNull(context.cacheFile);
    if (
      finalTargetMetadata?.isSymbolicLink() ||
      (finalTargetMetadata && !finalTargetMetadata.isFile())
    ) {
      throw new SyncoraError("CACHE001", "Refusing to replace an unsafe lexical cache path.");
    }
    await rename(temporary, context.cacheFile);
    await assertCacheDirectory(context);
    await assertContainedCacheFile(context.cacheFile, context);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await removeOwnedTemporary(temporary, context);
    throw new SyncoraError("CACHE001", "Unable to publish the lexical cache atomically.", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}
