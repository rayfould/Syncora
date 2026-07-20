import { randomUUID } from "node:crypto";
import { link, lstat, open, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { loadAndValidateAuthorityManifest } from "./authority-manifest.mjs";
import { verifyAuthoritySnapshot } from "./authority-inventory.mjs";
import { SyncoraError } from "./cli.mjs";
import {
  CONTEXT_COMPILER_POLICY,
  validateContextCase,
} from "./context-compiler.mjs";
import {
  assertStableDirectoryBinding,
  captureStableDirectoryBinding,
} from "./lock-recovery-guard.mjs";
import {
  normalizeMigrationId,
  parseStrictJson,
  serializeMigrationJson,
  taggedSha256,
} from "./migration-state.mjs";
import {
  isWithin,
  readBoundedRegularFileIfPresent,
  resolveWorkspace,
  samePath,
} from "./workspace.mjs";

export const ADOPTION_BUNDLE_POLICY = Object.freeze({
  schemaVersion: 1,
  kind: "syncora-adoption-bundle-v1",
  maximumDescriptorBytes: 8_388_608,
  maximumManifestBytes: 16_777_216,
  maximumFixtureBytes: 1_048_576,
  maximumTargets: 10_000,
  maximumTargetBytes: 262_144,
  maximumTotalTargetBytes: 67_108_864,
  maximumPathCharacters: 4_096,
  maximumPathBytes: 16_384,
  maximumPathSegments: 64,
  maximumSegmentCharacters: 240,
  maximumSegmentBytes: 255,
  maximumDirectories: 20_000,
  maximumFixtureCases: 100,
});

const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const UNSAFE_PATH_CHARACTER =
  /[\\<>:"|?*\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/;

function bundleError(message, details = undefined) {
  return new SyncoraError("MIGRATE016", message, details);
}

function plainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected, label) {
  if (!plainObject(value)) {
    throw bundleError(`${label} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    !actual.every((key, index) => key === wanted[index])
  ) {
    throw bundleError(`${label} has missing or unknown fields.`, {
      expected: wanted,
      actual,
    });
  }
}

function portableIdentity(value) {
  return value.normalize("NFC").toLowerCase();
}

function comparePortable(left, right) {
  const leftIdentity = portableIdentity(left);
  const rightIdentity = portableIdentity(right);
  if (leftIdentity < rightIdentity) return -1;
  if (leftIdentity > rightIdentity) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateRelativePath(value, label, { markdown = false } = {}) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    [...value].length > ADOPTION_BUNDLE_POLICY.maximumPathCharacters ||
    Buffer.byteLength(value, "utf8") > ADOPTION_BUNDLE_POLICY.maximumPathBytes ||
    value !== value.normalize("NFC") ||
    value.includes("\\") ||
    isAbsolute(value)
  ) {
    throw bundleError(`${label} must be a bounded NFC relative descendant path.`);
  }
  const segments = value.split("/");
  if (
    segments.length > ADOPTION_BUNDLE_POLICY.maximumPathSegments ||
    segments.some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".." ||
        [...segment].length > ADOPTION_BUNDLE_POLICY.maximumSegmentCharacters ||
        Buffer.byteLength(segment, "utf8") > ADOPTION_BUNDLE_POLICY.maximumSegmentBytes ||
        segment.endsWith(".") ||
        segment.endsWith(" ") ||
        WINDOWS_DEVICE_NAME.test(segment) ||
        UNSAFE_PATH_CHARACTER.test(segment),
    )
  ) {
    throw bundleError(`${label} is not a safe portable descendant path.`);
  }
  if (markdown && !value.endsWith(".md")) {
    throw bundleError(`${label} must identify a lowercase .md target.`);
  }
  return value;
}

function validateHash(value, label) {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    throw bundleError(`${label} must be a tagged lowercase SHA-256 digest.`);
  }
  return value;
}

function parseBundleJson(bytes, label) {
  try {
    return parseStrictJson(bytes, label);
  } catch (error) {
    if (error instanceof SyncoraError) {
      throw bundleError(`${label} is not valid strict JSON.`, {
        sourceCode: error.code,
      });
    }
    throw error;
  }
}

function sameFileSnapshot(left, right) {
  if (!left || !right) return false;
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.birthtimeNs === right.birthtimeNs
  );
}

async function assertBindings(bindings, label) {
  for (const binding of bindings) {
    await assertStableDirectoryBinding(binding, {
      code: "MIGRATE016",
      label,
    });
  }
}

async function captureDirectoryChain(context, relativeDirectory) {
  const segments = relativeDirectory === "" ? [] : relativeDirectory.split("/");
  const bindings = [context.rootBinding];
  let currentPath = context.root;
  let currentRelative = "";
  let parentBinding = context.rootBinding;

  for (const segment of segments) {
    currentRelative = currentRelative === "" ? segment : `${currentRelative}/${segment}`;
    currentPath = join(currentPath, segment);
    const key = portableIdentity(currentRelative);
    const cached = context.directoryBindings.get(key);
    if (cached) {
      if (cached.relativePath !== currentRelative) {
        throw bundleError(
          `Adoption bundle directory paths collide portably: ${cached.relativePath} and ${currentRelative}.`,
        );
      }
      parentBinding = cached.binding;
      bindings.push(parentBinding);
      continue;
    }
    if (context.directoryBindings.size >= ADOPTION_BUNDLE_POLICY.maximumDirectories) {
      throw bundleError("Adoption bundle exceeds its directory limit.");
    }
    await assertStableDirectoryBinding(parentBinding, {
      code: "MIGRATE016",
      label: "Adoption bundle parent directory",
    });
    const binding = await captureStableDirectoryBinding(currentPath, {
      code: "MIGRATE016",
      label: "Adoption bundle directory",
      containmentRoot: context.root,
    });
    await assertStableDirectoryBinding(parentBinding, {
      code: "MIGRATE016",
      label: "Adoption bundle parent directory",
    });
    context.directoryBindings.set(key, {
      relativePath: currentRelative,
      binding,
    });
    parentBinding = binding;
    bindings.push(binding);
  }
  return bindings;
}

async function readRelativeFile(
  context,
  relativePath,
  { maximumBytes, label, kind, isolateOnWindows = true },
) {
  const segments = relativePath.split("/");
  const fileName = segments.at(-1);
  const directorySegments = segments.slice(0, -1);
  const relativeDirectory = directorySegments.join("/");
  const parent = join(context.root, ...directorySegments);
  const path = join(parent, fileName);
  if (!isWithin(context.root, path)) {
    throw bundleError(`${label} escapes the adoption bundle root: ${relativePath}`);
  }
  const bindings = await captureDirectoryChain(context, relativeDirectory);
  await assertBindings(bindings, `${label} directory`);
  const bytes = await readBoundedRegularFileIfPresent(path, {
    containmentRoot: parent,
    maximumBytes,
    code: "MIGRATE016",
    label,
    isolateOnWindows,
    beforeOpen: context.hooks.beforeRead
      ? () => context.hooks.beforeRead({ kind, path })
      : undefined,
    afterRead: context.hooks.afterRead
      ? () => context.hooks.afterRead({ kind, path })
      : undefined,
  });
  if (bytes === null) {
    throw bundleError(`${label} is missing: ${relativePath}`);
  }
  const [metadata, resolved] = await Promise.all([
    lstat(path, { bigint: true }),
    realpath(path),
  ]);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    bytes.length !== Number(metadata.size) ||
    !samePath(resolved, path) ||
    !isWithin(context.root, resolved)
  ) {
    throw bundleError(`${label} is not a stable contained regular file: ${relativePath}`);
  }
  await assertBindings(bindings, `${label} directory`);
  const snapshot = Object.freeze({ path, resolved, metadata });
  context.fileSnapshots.push(snapshot);
  return Object.freeze({ path, bytes, snapshot });
}

function validateDescriptor(value) {
  exactKeys(
    value,
    ["schemaVersion", "kind", "migrationId", "manifest", "stagedContent", "fixtures"],
    "Adoption bundle descriptor",
  );
  if (
    value.schemaVersion !== ADOPTION_BUNDLE_POLICY.schemaVersion ||
    value.kind !== ADOPTION_BUNDLE_POLICY.kind
  ) {
    throw bundleError("Adoption bundle schema version or kind is unsupported.");
  }
  let migrationId;
  try {
    migrationId = normalizeMigrationId(value.migrationId);
  } catch (error) {
    if (error instanceof SyncoraError) {
      throw bundleError("Adoption bundle migrationId is invalid.", {
        sourceCode: error.code,
      });
    }
    throw error;
  }
  exactKeys(value.manifest, ["path", "sha256"], "Adoption bundle manifest binding");
  exactKeys(value.fixtures, ["path", "sha256"], "Adoption bundle fixture binding");
  exactKeys(
    value.stagedContent,
    ["root", "targetCount", "totalBytes", "targets"],
    "Adoption bundle staged-content binding",
  );
  const manifest = {
    path: validateRelativePath(value.manifest.path, "Manifest path"),
    sha256: validateHash(value.manifest.sha256, "Manifest hash"),
  };
  const fixtures = {
    path: validateRelativePath(value.fixtures.path, "Fixture path"),
    sha256: validateHash(value.fixtures.sha256, "Fixture hash"),
  };
  if (portableIdentity(manifest.path) === portableIdentity(fixtures.path)) {
    throw bundleError("Manifest and fixture paths must be distinct.");
  }
  const root = validateRelativePath(value.stagedContent.root, "Staged-content root");
  if (
    !Number.isSafeInteger(value.stagedContent.targetCount) ||
    value.stagedContent.targetCount < 1 ||
    value.stagedContent.targetCount > ADOPTION_BUNDLE_POLICY.maximumTargets ||
    !Number.isSafeInteger(value.stagedContent.totalBytes) ||
    value.stagedContent.totalBytes < 1 ||
    value.stagedContent.totalBytes > ADOPTION_BUNDLE_POLICY.maximumTotalTargetBytes ||
    !Array.isArray(value.stagedContent.targets) ||
    value.stagedContent.targets.length !== value.stagedContent.targetCount
  ) {
    throw bundleError("Staged-content counts or byte bounds are invalid.");
  }
  const identities = new Set();
  const targets = value.stagedContent.targets.map((entry, index) => {
    exactKeys(entry, ["path", "sha256", "byteLength"], `Staged target ${index}`);
    const path = validateRelativePath(entry.path, `Staged target ${index} path`, {
      markdown: true,
    });
    const identity = portableIdentity(path);
    if (identities.has(identity)) {
      throw bundleError(`Staged target path is duplicated portably: ${path}`);
    }
    identities.add(identity);
    if (
      !Number.isSafeInteger(entry.byteLength) ||
      entry.byteLength < 1 ||
      entry.byteLength > ADOPTION_BUNDLE_POLICY.maximumTargetBytes
    ) {
      throw bundleError(`Staged target byte length is invalid: ${path}`);
    }
    return {
      path,
      sha256: validateHash(entry.sha256, `Staged target ${index} hash`),
      byteLength: entry.byteLength,
    };
  });
  const sortedTargets = [...targets].sort((left, right) => comparePortable(left.path, right.path));
  if (!targets.every((target, index) => target.path === sortedTargets[index].path)) {
    throw bundleError("Staged target bindings must be sorted by portable path.");
  }
  const totalBytes = targets.reduce((sum, target) => sum + target.byteLength, 0);
  if (totalBytes !== value.stagedContent.totalBytes) {
    throw bundleError("Staged-content totalBytes does not equal its target inventory.");
  }
  return {
    schemaVersion: value.schemaVersion,
    kind: value.kind,
    migrationId,
    manifest,
    fixtures,
    stagedContent: {
      root,
      targetCount: targets.length,
      totalBytes,
      targets,
    },
  };
}

function validateReviewedManifest(value, descriptorTargets) {
  if (
    !plainObject(value) ||
    value.manifestSchemaVersion !== 2 ||
    value.kind !== "syncora.authority-promotion" ||
    value.status !== "reviewed" ||
    !Array.isArray(value.operations) ||
    value.operations.length < 1 ||
    value.operations.length > ADOPTION_BUNDLE_POLICY.maximumTargets
  ) {
    throw bundleError("Bound manifest is not an actionable reviewed v2 manifest.");
  }
  const manifestTargets = new Map();
  for (let index = 0; index < value.operations.length; index += 1) {
    const target = value.operations[index]?.target;
    if (!plainObject(target)) {
      throw bundleError(`Manifest operation ${index} lacks a target binding.`);
    }
    const path = validateRelativePath(target.path, `Manifest target ${index} path`, {
      markdown: true,
    });
    const identity = portableIdentity(path);
    if (manifestTargets.has(identity)) {
      throw bundleError(`Manifest target path is duplicated portably: ${path}`);
    }
    manifestTargets.set(identity, {
      path,
      sha256: validateHash(target.contentSha256, `Manifest target ${index} hash`),
    });
  }
  if (manifestTargets.size !== descriptorTargets.length) {
    throw bundleError("Descriptor target inventory does not match the reviewed manifest.");
  }
  for (const target of descriptorTargets) {
    const manifestTarget = manifestTargets.get(portableIdentity(target.path));
    if (
      !manifestTarget ||
      manifestTarget.path !== target.path ||
      manifestTarget.sha256 !== target.sha256
    ) {
      throw bundleError(`Descriptor target binding diverges from the manifest: ${target.path}`);
    }
  }
  return value;
}

function validateFixtures(value) {
  if (
    !plainObject(value) ||
    value.schemaVersion !== 1 ||
    value.kind !== "syncora-shadow-fixtures-v1" ||
    !Array.isArray(value.cases) ||
    value.cases.length < 1 ||
    value.cases.length > ADOPTION_BUNDLE_POLICY.maximumFixtureCases
  ) {
    throw bundleError("Bound shadow fixtures do not satisfy the v1 fixture envelope.");
  }
  return value;
}

function validateBuilderFixtures(value) {
  exactKeys(value, ["schemaVersion", "kind", "cases"], "Shadow fixtures");
  if (
    value.schemaVersion !== 1 ||
    value.kind !== "syncora-shadow-fixtures-v1" ||
    !Array.isArray(value.cases) ||
    value.cases.length < 1 ||
    value.cases.length > CONTEXT_COMPILER_POLICY.maximumCases
  ) {
    throw bundleError("Shadow fixtures do not satisfy the bounded v1 fixture contract.");
  }
  const caseIds = new Set();
  for (const fixture of value.cases) {
    let validated;
    try {
      validated = validateContextCase(fixture);
    } catch (error) {
      if (error instanceof SyncoraError) {
        throw bundleError("Shadow fixtures contain an invalid context case.", {
          sourceCode: error.code,
          cause: error.message,
        });
      }
      throw error;
    }
    if (caseIds.has(validated.caseId)) {
      throw bundleError(`Shadow fixture case is duplicated: ${validated.caseId}`);
    }
    caseIds.add(validated.caseId);
  }
  return value;
}

function containedSource(root, value, label, options = {}) {
  if (typeof value !== "string" || !isAbsolute(value)) {
    throw bundleError(`${label} path must be absolute.`);
  }
  const absolutePath = resolve(value);
  const relativePath = relative(root, absolutePath).split(sep).join("/");
  if (relativePath === "" || !isWithin(root, absolutePath)) {
    throw bundleError(`${label} must be contained beneath the output descriptor directory.`);
  }
  validateRelativePath(relativePath, `${label} path`, options);
  return Object.freeze({ absolutePath, relativePath });
}

async function readExistingDescriptor(root, outputPath) {
  return readBoundedRegularFileIfPresent(outputPath, {
    containmentRoot: root,
    maximumBytes: ADOPTION_BUNDLE_POLICY.maximumDescriptorBytes,
    code: "MIGRATE016",
    label: "Adoption bundle output",
  });
}

async function publishDescriptorWithoutClobber({
  context,
  outputPath,
  bytes,
  hooks,
  assertInputsCurrent,
}) {
  await hooks.beforePublish?.();
  await assertInputsCurrent();
  const temporaryPath = join(
    context.root,
    `.${basename(outputPath)}.syncora-${process.pid}-${randomUUID()}.tmp`,
  );
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await assertInputsCurrent();
    await link(temporaryPath, outputPath);
    return true;
  } catch (error) {
    if (error?.code !== "EEXIST") {
      if (error instanceof SyncoraError) throw error;
      throw bundleError(
        "Adoption bundle output could not be published atomically without clobbering.",
        { cause: error instanceof Error ? error.message : String(error) },
      );
    }
    const current = await readExistingDescriptor(context.root, outputPath);
    if (current?.equals(bytes)) return false;
    throw bundleError(
      "Adoption bundle output already exists with different bytes; refusing to overwrite it.",
      { output: outputPath },
    );
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function assertSnapshotCurrent(context) {
  await assertStableDirectoryBinding(context.rootBinding, {
    code: "MIGRATE016",
    label: "Adoption bundle root",
  });
  for (const { binding } of context.directoryBindings.values()) {
    await assertStableDirectoryBinding(binding, {
      code: "MIGRATE016",
      label: "Adoption bundle directory",
    });
  }
  await context.hooks.beforeFinalSnapshot?.();
  for (const snapshot of context.fileSnapshots) {
    const [metadata, resolved] = await Promise.all([
      lstat(snapshot.path, { bigint: true }),
      realpath(snapshot.path),
    ]);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      !sameFileSnapshot(snapshot.metadata, metadata) ||
      !samePath(snapshot.resolved, resolved) ||
      !isWithin(context.root, resolved)
    ) {
      throw bundleError(`Adoption bundle changed during validation: ${snapshot.path}`);
    }
  }
}

/**
 * Loads one immutable-by-contract legacy adoption descriptor. The descriptor
 * binds every external input consumed by the foreground migration lifecycle.
 * Full graph semantics remain the responsibility of stage and shadow; this
 * boundary guarantees those phases receive the exact reviewed byte set.
 */
export async function loadAndValidateAdoptionBundle(descriptorPath, hooks = {}) {
  if (typeof descriptorPath !== "string" || !isAbsolute(descriptorPath)) {
    throw bundleError("Adoption bundle descriptor path must be absolute.");
  }
  const root = dirname(descriptorPath);
  const descriptorRelative = relative(root, descriptorPath).split(sep).join("/");
  validateRelativePath(descriptorRelative, "Adoption bundle descriptor path");
  const rootBinding = await captureStableDirectoryBinding(root, {
    code: "MIGRATE016",
    label: "Adoption bundle root",
    containmentRoot: root,
  });
  const context = {
    root,
    rootBinding,
    directoryBindings: new Map(),
    fileSnapshots: [],
    hooks,
  };

  const descriptorFile = await readRelativeFile(context, descriptorRelative, {
    maximumBytes: ADOPTION_BUNDLE_POLICY.maximumDescriptorBytes,
    label: "Adoption bundle descriptor",
    kind: "descriptor",
  });
  const descriptor = validateDescriptor(
    parseBundleJson(descriptorFile.bytes, "Adoption bundle descriptor"),
  );
  const manifestFile = await readRelativeFile(context, descriptor.manifest.path, {
    maximumBytes: ADOPTION_BUNDLE_POLICY.maximumManifestBytes,
    label: "Reviewed manifest",
    kind: "manifest",
  });
  const manifestSha256 = taggedSha256(manifestFile.bytes);
  if (manifestSha256 !== descriptor.manifest.sha256) {
    throw bundleError("Reviewed manifest hash does not match the adoption descriptor.");
  }
  const manifest = validateReviewedManifest(
    parseBundleJson(manifestFile.bytes, "Reviewed manifest"),
    descriptor.stagedContent.targets,
  );

  const fixturesFile = await readRelativeFile(context, descriptor.fixtures.path, {
    maximumBytes: ADOPTION_BUNDLE_POLICY.maximumFixtureBytes,
    label: "Shadow fixtures",
    kind: "fixtures",
  });
  const fixtureSha256 = taggedSha256(fixturesFile.bytes);
  if (fixtureSha256 !== descriptor.fixtures.sha256) {
    throw bundleError("Shadow fixture hash does not match the adoption descriptor.");
  }
  const fixtures = validateFixtures(
    parseBundleJson(fixturesFile.bytes, "Shadow fixtures"),
  );

  const stagedRootSegments = descriptor.stagedContent.root.split("/");
  const stagedRoot = join(root, ...stagedRootSegments);
  const stagedRootBindings = await captureDirectoryChain(
    context,
    descriptor.stagedContent.root,
  );
  await assertBindings(stagedRootBindings, "Staged-content root");
  const loadedTargets = [];
  for (const target of descriptor.stagedContent.targets) {
    const path = `${descriptor.stagedContent.root}/${target.path}`;
    const file = await readRelativeFile(context, path, {
      maximumBytes: ADOPTION_BUNDLE_POLICY.maximumTargetBytes,
      label: "Staged target",
      kind: "target",
      isolateOnWindows: false,
    });
    if (
      file.bytes.length !== target.byteLength ||
      taggedSha256(file.bytes) !== target.sha256
    ) {
      throw bundleError(`Staged target bytes do not match the descriptor: ${target.path}`);
    }
    loadedTargets.push({
      path: target.path,
      absolutePath: file.path,
      sha256: target.sha256,
      byteLength: target.byteLength,
    });
  }

  await assertSnapshotCurrent(context);
  return Object.freeze({
    schemaVersion: descriptor.schemaVersion,
    kind: descriptor.kind,
    migrationId: descriptor.migrationId,
    bundleRoot: root,
    descriptor: Object.freeze({
      path: descriptorPath,
      sha256: taggedSha256(descriptorFile.bytes),
      bytes: descriptorFile.bytes,
    }),
    manifest: Object.freeze({
      path: manifestFile.path,
      sha256: manifestSha256,
      bytes: manifestFile.bytes,
      value: manifest,
    }),
    stagedContent: Object.freeze({
      path: stagedRoot,
      targetCount: loadedTargets.length,
      totalBytes: descriptor.stagedContent.totalBytes,
      targets: Object.freeze(loadedTargets.map((target) => Object.freeze(target))),
    }),
    fixtures: Object.freeze({
      path: fixturesFile.path,
      sha256: fixtureSha256,
      bytes: fixturesFile.bytes,
      value: fixtures,
    }),
  });
}

/**
 * Builds the single content-addressed descriptor consumed by `syncora adopt`.
 * The reviewed source artifacts remain user-owned files; this command only
 * validates and binds their exact bytes into a no-clobber descriptor.
 */
export async function buildAdoptionBundle(options, hooks = {}) {
  if (!plainObject(options)) {
    throw bundleError("Adoption bundle options must be an object.");
  }
  if (options.dryRun !== undefined && typeof options.dryRun !== "boolean") {
    throw bundleError("Adoption bundle dryRun must be a boolean.");
  }
  if (
    options.expectedDescriptorSha256 !== undefined &&
    !HASH_PATTERN.test(options.expectedDescriptorSha256)
  ) {
    throw bundleError("Expected adoption bundle digest must be a lowercase tagged SHA-256 value.");
  }
  if (typeof options.output !== "string" || !isAbsolute(options.output)) {
    throw bundleError("Adoption bundle output path must be absolute.");
  }
  const outputPath = resolve(options.output);
  const root = dirname(outputPath);
  const descriptorName = basename(outputPath);
  validateRelativePath(descriptorName, "Adoption bundle output path");
  const migrationId = (() => {
    try {
      return normalizeMigrationId(options.migrationId);
    } catch (error) {
      if (error instanceof SyncoraError) {
        throw bundleError("Adoption bundle migration ID is invalid.", {
          sourceCode: error.code,
        });
      }
      throw error;
    }
  })();
  const workspace = await resolveWorkspace(options.workspace);
  const manifestSource = containedSource(root, options.manifest, "Reviewed manifest");
  const fixturesSource = containedSource(root, options.fixtures, "Shadow fixtures");
  const stagedSource = containedSource(root, options.stagedContent, "Staged-content root");
  if (
    portableIdentity(manifestSource.relativePath) === portableIdentity(descriptorName) ||
    portableIdentity(fixturesSource.relativePath) === portableIdentity(descriptorName)
  ) {
    throw bundleError("Adoption bundle output must be distinct from its source artifacts.");
  }

  const rootBinding = await captureStableDirectoryBinding(root, {
    code: "MIGRATE016",
    label: "Adoption bundle output directory",
    containmentRoot: root,
  });
  const context = {
    root,
    rootBinding,
    directoryBindings: new Map(),
    fileSnapshots: [],
    hooks,
  };
  const manifestFile = await readRelativeFile(context, manifestSource.relativePath, {
    maximumBytes: ADOPTION_BUNDLE_POLICY.maximumManifestBytes,
    label: "Reviewed manifest",
    kind: "manifest",
  });
  const validatedManifest = await loadAndValidateAuthorityManifest(
    {
      workspace: workspace.realPath,
      allowExternalGraphRoot: options.allowExternalGraphRoot,
      manifestPath: manifestFile.path,
    },
    hooks.manifest ?? {},
  );
  if (!validatedManifest.actionable || validatedManifest.manifest.manifestSchemaVersion !== 2) {
    throw bundleError("Only an actionable reviewed v2 manifest can be bundled.");
  }
  if (!validatedManifest.manifestBytes.equals(manifestFile.bytes)) {
    throw bundleError("Reviewed manifest changed while the bundle was being built.");
  }

  const fixturesFile = await readRelativeFile(context, fixturesSource.relativePath, {
    maximumBytes: ADOPTION_BUNDLE_POLICY.maximumFixtureBytes,
    label: "Shadow fixtures",
    kind: "fixtures",
  });
  const fixtures = validateBuilderFixtures(
    parseBundleJson(fixturesFile.bytes, "Shadow fixtures"),
  );

  await captureDirectoryChain(context, stagedSource.relativePath);
  const targetIdentities = new Set();
  const targets = [];
  for (const target of validatedManifest.targets) {
    const path = validateRelativePath(target.path, "Manifest target path", {
      markdown: true,
    });
    const identity = portableIdentity(path);
    if (targetIdentities.has(identity)) {
      throw bundleError(`Manifest target path is duplicated portably: ${path}`);
    }
    targetIdentities.add(identity);
    const contentSha256 = validateHash(target.contentSha256, `Manifest target hash for ${path}`);
    const file = await readRelativeFile(
      context,
      `${stagedSource.relativePath}/${path}`,
      {
        maximumBytes: ADOPTION_BUNDLE_POLICY.maximumTargetBytes,
        label: "Staged target",
        kind: "target",
        isolateOnWindows: false,
      },
    );
    if (taggedSha256(file.bytes) !== contentSha256) {
      throw bundleError(`Staged target bytes do not match the reviewed manifest: ${path}`);
    }
    targets.push({
      path,
      sha256: contentSha256,
      byteLength: file.bytes.length,
    });
  }
  targets.sort((left, right) => comparePortable(left.path, right.path));
  const totalBytes = targets.reduce((sum, target) => sum + target.byteLength, 0);
  if (
    targets.length < 1 ||
    targets.length > ADOPTION_BUNDLE_POLICY.maximumTargets ||
    totalBytes < 1 ||
    totalBytes > ADOPTION_BUNDLE_POLICY.maximumTotalTargetBytes
  ) {
    throw bundleError("Reviewed staged targets exceed the adoption bundle bounds.");
  }

  const descriptor = validateDescriptor({
    schemaVersion: ADOPTION_BUNDLE_POLICY.schemaVersion,
    kind: ADOPTION_BUNDLE_POLICY.kind,
    migrationId,
    manifest: {
      path: manifestSource.relativePath,
      sha256: taggedSha256(manifestFile.bytes),
    },
    stagedContent: {
      root: stagedSource.relativePath,
      targetCount: targets.length,
      totalBytes,
      targets,
    },
    fixtures: {
      path: fixturesSource.relativePath,
      sha256: taggedSha256(fixturesFile.bytes),
    },
  });
  validateReviewedManifest(validatedManifest.manifest, descriptor.stagedContent.targets);
  const descriptorBytes = serializeMigrationJson(descriptor);
  if (descriptorBytes.length > ADOPTION_BUNDLE_POLICY.maximumDescriptorBytes) {
    throw bundleError("Generated adoption bundle descriptor exceeds its byte limit.");
  }
  const descriptorSha256 = taggedSha256(descriptorBytes);
  if (
    options.expectedDescriptorSha256 !== undefined &&
    options.expectedDescriptorSha256 !== descriptorSha256
  ) {
    throw bundleError(
      "The reviewed adoption bundle digest does not match the current manifest, targets, and fixtures.",
      {
        expected: options.expectedDescriptorSha256,
        actual: descriptorSha256,
      },
    );
  }
  const assertInputsCurrent = async () => {
    try {
      await verifyAuthoritySnapshot(
        {
          workspace: workspace.realPath,
          allowExternalGraphRoot: options.allowExternalGraphRoot,
        },
        validatedManifest.inspection,
      );
    } catch (error) {
      throw bundleError("Authority graph changed while the adoption bundle was being built.", {
        sourceCode: error?.code ?? "READ001",
      });
    }
    await assertSnapshotCurrent(context);
  };
  await assertInputsCurrent();

  const existing = await readExistingDescriptor(root, outputPath);
  if (existing !== null && !existing.equals(descriptorBytes)) {
    throw bundleError(
      "Adoption bundle output already exists with different bytes; refusing to overwrite it.",
      { output: outputPath },
    );
  }
  let changed = existing === null;
  if (!options.dryRun && existing === null) {
    changed = await publishDescriptorWithoutClobber({
      context,
      outputPath,
      bytes: descriptorBytes,
      hooks,
      assertInputsCurrent,
    });
  }
  if (!options.dryRun) {
    await loadAndValidateAdoptionBundle(outputPath);
  }

  return Object.freeze({
    ok: true,
    command: "bundle",
    workspace: workspace.realPath,
    dryRun: options.dryRun === true,
    changed,
    output: outputPath,
    migrationId,
    descriptor: Object.freeze({
      sha256: descriptorSha256,
      byteLength: descriptorBytes.length,
    }),
    manifest: Object.freeze({
      path: manifestFile.path,
      sha256: descriptor.manifest.sha256,
    }),
    stagedContent: Object.freeze({
      root: join(root, ...descriptor.stagedContent.root.split("/")),
      targetCount: descriptor.stagedContent.targetCount,
      totalBytes: descriptor.stagedContent.totalBytes,
    }),
    fixtures: Object.freeze({
      path: fixturesFile.path,
      sha256: descriptor.fixtures.sha256,
      caseCount: fixtures.cases.length,
    }),
    next: Object.freeze({
      command: "adopt",
      arguments: Object.freeze([
        "--workspace",
        workspace.realPath,
        "--bundle",
        outputPath,
      ]),
    }),
    changes: Object.freeze([
      Object.freeze({
        action: changed ? "create" : "unchanged",
        path: outputPath,
      }),
    ]),
  });
}
