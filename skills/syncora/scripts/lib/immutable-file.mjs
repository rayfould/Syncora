import { createHash, randomUUID } from "node:crypto";
import { link, open, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

import { SyncoraError } from "./cli.mjs";
import { syncDirectoryEntry } from "./atomic-file.mjs";
import { createStableDirectoryGuard } from "./stable-directory.mjs";
import { readBoundedRegularFileIfPresent } from "./workspace.mjs";

export const IMMUTABLE_FILE_POLICY = Object.freeze({
  maximumBytes: 16_777_216,
});

export function immutableSha256(bytes) {
  const content = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function immutableError(code, message, details = undefined) {
  return new SyncoraError(code, message, details);
}

function assertOptions({ root, path, bytes, maximumBytes, code, label }) {
  if (!isAbsolute(root) || !isAbsolute(path)) {
    throw immutableError(code, `${label} root and path must be absolute.`);
  }
  const location = relative(root, path);
  if (
    location === "" ||
    location === ".." ||
    location.startsWith(`..${sep}`) ||
    isAbsolute(location)
  ) {
    throw immutableError(code, `${label} escapes its trusted root.`);
  }
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 0 ||
    maximumBytes > IMMUTABLE_FILE_POLICY.maximumBytes
  ) {
    throw immutableError(code, `${label} byte limit is invalid.`);
  }
  if (!Buffer.isBuffer(bytes)) {
    throw immutableError(code, `${label} content must be a Buffer.`);
  }
  if (bytes.length > maximumBytes) {
    throw immutableError(code, `${label} exceeds its byte limit.`, {
      bytes: bytes.length,
      limit: maximumBytes,
    });
  }
}

async function readExisting({ root, path, maximumBytes, code, label, guard }) {
  await guard.assert();
  return readBoundedRegularFileIfPresent(path, {
    containmentRoot: dirname(path),
    maximumBytes,
    code,
    label,
    beforeOpen: () => guard.assert(),
    beforeHandleOpen: () => guard.assert(),
    afterRead: () => guard.assert(),
  });
}

export async function readImmutableFile({
  root,
  path,
  maximumBytes = IMMUTABLE_FILE_POLICY.maximumBytes,
  code = "IMMUTABLE001",
  label = "Immutable file",
}) {
  assertOptions({ root, path, bytes: Buffer.alloc(0), maximumBytes, code, label });
  const guard = createStableDirectoryGuard(root, dirname(path), { code, label });
  await guard.prepare();
  const bytes = await readExisting({ root, path, maximumBytes, code, label, guard });
  if (bytes === null) return null;
  return Object.freeze({
    bytes,
    byteLength: bytes.length,
    sha256: immutableSha256(bytes),
  });
}

/**
 * Publish bytes exactly once without a replace-capable rename. A fully synced
 * same-directory temporary file is hard-linked into place, so an existing
 * target wins atomically. Exact retries are idempotent; different bytes fail.
 */
export async function publishImmutableFile({
  root,
  path,
  bytes,
  temporaryPath: configuredTemporaryPath = undefined,
  maximumBytes = IMMUTABLE_FILE_POLICY.maximumBytes,
  code = "IMMUTABLE001",
  collisionCode = "IMMUTABLE002",
  label = "Immutable file",
}, hooks = {}) {
  const content = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  assertOptions({ root, path, bytes: content, maximumBytes, code, label });

  const parent = dirname(path);
  const guard = createStableDirectoryGuard(root, parent, { code, label });
  await guard.prepare();
  const existing = await readExisting({ root, path, maximumBytes, code, label, guard });
  if (existing !== null) {
    if (!existing.equals(content)) {
      throw immutableError(collisionCode, `${label} already exists with different bytes.`, {
        path: basename(path),
        expectedSha256: immutableSha256(content),
        currentSha256: immutableSha256(existing),
      });
    }
    return Object.freeze({
      created: false,
      idempotent: true,
      path,
      byteLength: content.length,
      sha256: immutableSha256(content),
    });
  }

  await hooks.beforeTemporaryCreate?.({ path, bytes: content });
  await guard.assert();
  const temporaryPath = configuredTemporaryPath ?? join(
    parent,
    `.${basename(path)}.syncora-${process.pid}-${randomUUID()}.tmp`,
  );
  const temporaryLocation = relative(parent, temporaryPath);
  if (
    !isAbsolute(temporaryPath) ||
    temporaryLocation === "" ||
    temporaryLocation === ".." ||
    temporaryLocation.startsWith(`..${sep}`) ||
    isAbsolute(temporaryLocation) ||
    dirname(temporaryPath) !== parent
  ) {
    throw immutableError(code, `${label} temporary path must be a distinct sibling.`);
  }
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }

  await hooks.afterTemporarySync?.({ path, temporaryPath, bytes: content });

  try {
    await hooks.beforePublish?.({ path, temporaryPath, bytes: content });
    await guard.assert();
    await link(temporaryPath, path);
    await syncDirectoryEntry(parent);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    await syncDirectoryEntry(parent);
    if (error?.code === "EEXIST") {
      const raced = await readExisting({ root, path, maximumBytes, code, label, guard });
      if (raced !== null && raced.equals(content)) {
        return Object.freeze({
          created: false,
          idempotent: true,
          path,
          byteLength: content.length,
          sha256: immutableSha256(content),
        });
      }
      throw immutableError(collisionCode, `${label} publication collided with different bytes.`, {
        path: basename(path),
        expectedSha256: immutableSha256(content),
        ...(raced === null ? {} : { currentSha256: immutableSha256(raced) }),
      });
    }
    throw immutableError(code, `${label} could not be published immutably.`, {
      path: basename(path),
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  // A test-only/process-boundary hook lives after the no-replace publication.
  // If it interrupts here, the deterministic temporary link remains as
  // recoverable residue while the canonical target is already complete.
  await hooks.afterPublish?.({ path, temporaryPath, bytes: content });

  // Publication has already succeeded. A leaked private temporary hard link is
  // recoverable residue; it must not turn a successful immutable publish into
  // a reported failure that encourages a caller to retry a completed action.
  await rm(temporaryPath, { force: true }).catch(() => undefined);
  await syncDirectoryEntry(parent);
  const published = await readExisting({ root, path, maximumBytes, code, label, guard });
  if (published === null || !published.equals(content)) {
    throw immutableError(code, `${label} did not publish exact bytes.`, {
      path: basename(path),
    });
  }
  return Object.freeze({
    created: true,
    idempotent: false,
    path,
    byteLength: content.length,
    sha256: immutableSha256(content),
  });
}
