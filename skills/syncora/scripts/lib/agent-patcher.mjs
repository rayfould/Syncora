import { lstat, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  decodeUtf8File,
  encodeUtf8File,
  sha256,
} from "./atomic-file.mjs";
import { SyncoraError } from "./cli.mjs";
import {
  assertStableDirectoryBinding,
  captureStableDirectoryBinding,
} from "./lock-recovery-guard.mjs";
import { readBoundedRegularFileIfPresent } from "./workspace.mjs";

const BEGIN_PREFIX = "<!-- syncora-agent-hook:begin v";
const END_PREFIX = "<!-- syncora-agent-hook:end v";
const PREDECESSOR_WORKFLOW_BEGIN =
  "<!-- BEGIN KNOWLEDGE GRAPH WORKFLOW -->";
const PREDECESSOR_WORKFLOW_END =
  "<!-- END KNOWLEDGE GRAPH WORKFLOW -->";
export const CURRENT_AGENT_HOOK_VERSION = 7;
const CURRENT_VERSION = CURRENT_AGENT_HOOK_VERSION;
const STATE_SCHEMA_VERSION = 1;
const STATE_MAX_BYTES = 262_144;
export const AGENT_FILE_MAX_BYTES = 1_048_576;
const AGENT_SNAPSHOT_MAX_BYTES = AGENT_FILE_MAX_BYTES;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const POSSIBLE_CUSTOM_PREDECESSOR_PATTERN =
  /(?:knowledge[ -]graph|local[\\/]index\.md|local[\\/]scripts[\\/]kg\.py|\bkg workflow\b|always\s+(?:load|read)[\s\S]{0,120}(?:graph|local[\\/]))/iu;
const MODULE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const HOOK_PATH = join(
  MODULE_DIRECTORY,
  "..",
  "..",
  "assets",
  "agent-hooks",
  "shared.md",
);

function allMarkerMatches(text, prefix) {
  const expression = new RegExp(
    `${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\d+) -->`,
    "g",
  );
  return [...text.matchAll(expression)].map((match) => ({
    index: match.index,
    length: match[0].length,
    version: Number.parseInt(match[1], 10),
  }));
}

export function inspectMarker(text, pathForError = "agent instruction file") {
  const begins = allMarkerMatches(text, BEGIN_PREFIX);
  const ends = allMarkerMatches(text, END_PREFIX);

  if (begins.length === 0 && ends.length === 0) {
    return { status: "absent" };
  }

  if (begins.length !== 1 || ends.length !== 1) {
    throw new SyncoraError(
      "PATCH001",
      `${pathForError} contains duplicate or unbalanced Syncora markers.`,
    );
  }

  const begin = begins[0];
  const end = ends[0];
  if (begin.index >= end.index || begin.version !== end.version) {
    throw new SyncoraError(
      "PATCH001",
      `${pathForError} contains reversed or mismatched Syncora markers.`,
    );
  }
  if (begin.version > CURRENT_VERSION) {
    throw new SyncoraError(
      "PATCH002",
      `${pathForError} uses newer Syncora hook version ${begin.version}.`,
    );
  }

  return {
    status: "present",
    version: begin.version,
    start: begin.index,
    end: end.index + end.length,
  };
}

function allExactMatches(text, marker) {
  const matches = [];
  let offset = 0;
  while (offset <= text.length - marker.length) {
    const index = text.indexOf(marker, offset);
    if (index === -1) break;
    matches.push({ index, length: marker.length });
    offset = index + marker.length;
  }
  return matches;
}

function inspectPredecessorWorkflow(
  text,
  pathForError = "agent instruction file",
) {
  const begins = allExactMatches(text, PREDECESSOR_WORKFLOW_BEGIN);
  const ends = allExactMatches(text, PREDECESSOR_WORKFLOW_END);

  if (begins.length === 0 && ends.length === 0) {
    return { status: "absent" };
  }
  if (begins.length !== 1 || ends.length !== 1) {
    throw new SyncoraError(
      "PATCH001",
      `${pathForError} contains duplicate or unbalanced predecessor knowledge-graph workflow markers.`,
    );
  }

  const begin = begins[0];
  const end = ends[0];
  if (begin.index >= end.index) {
    throw new SyncoraError(
      "PATCH001",
      `${pathForError} contains reversed predecessor knowledge-graph workflow markers.`,
    );
  }

  return {
    status: "present",
    start: begin.index,
    end: end.index + end.length,
  };
}

function rangesOverlap(left, right) {
  return left.start < right.end && right.start < left.end;
}

function removeTextRanges(text, ranges) {
  const sorted = [...ranges].sort((left, right) => left.start - right.start);
  const parts = [];
  let cursor = 0;
  for (const range of sorted) {
    if (range.start < cursor || range.start > range.end) {
      throw new SyncoraError(
        "PATCH001",
        "Agent instruction marker ranges overlap or are malformed.",
      );
    }
    parts.push(text.slice(cursor, range.start));
    cursor = range.end;
  }
  parts.push(text.slice(cursor));
  return parts.join("");
}

function inspectInstructionActivation(text, pathForError) {
  const marker = inspectMarker(text, pathForError);
  const predecessor = inspectPredecessorWorkflow(text, pathForError);
  const ownedRanges = [marker, predecessor]
    .filter((item) => item.status === "present")
    .map((item) => ({ start: item.start, end: item.end }));
  const userOwnedText = removeTextRanges(text, ownedRanges);
  return {
    marker,
    predecessor,
    possibleCustomPredecessorActivation:
      POSSIBLE_CUSTOM_PREDECESSOR_PATTERN.test(userOwnedText),
  };
}

async function cutoverPredecessorWorkflow(
  buffer,
  pathForError,
  { installHook },
) {
  if (buffer === null) return null;
  const decoded = decodeUtf8File(buffer, pathForError);
  const predecessor = inspectPredecessorWorkflow(decoded.text, pathForError);
  if (predecessor.status === "absent") return null;

  const marker = inspectMarker(decoded.text, pathForError);
  const ownedRanges = [predecessor];
  if (marker.status === "present") {
    if (rangesOverlap(predecessor, marker)) {
      throw new SyncoraError(
        "PATCH001",
        `${pathForError} contains overlapping Syncora and predecessor workflow markers.`,
      );
    }
    ownedRanges.push(marker);
  }

  const removedBeforePredecessor = ownedRanges
    .filter((range) => range.end <= predecessor.start)
    .reduce((total, range) => total + (range.end - range.start), 0);
  const insertionIndex = predecessor.start - removedBeforePredecessor;
  const baselineText = removeTextRanges(decoded.text, ownedRanges);
  const baseline = encodeUtf8File({ ...decoded, text: baselineText });
  let after = baseline;

  if (installHook) {
    const hook = await loadHook(decoded.newline);
    const text = `${baselineText.slice(0, insertionIndex)}${hook}${baselineText.slice(insertionIndex)}`;
    after = encodeUtf8File({ ...decoded, text });
    if (after.length > AGENT_FILE_MAX_BYTES) {
      throw new SyncoraError(
        "PATCH004",
        `Patched agent instruction file exceeds ${AGENT_FILE_MAX_BYTES} bytes: ${pathForError}`,
      );
    }
  }

  return { after, baseline };
}

async function loadHook(newline) {
  const raw = await readFile(HOOK_PATH, "utf8");
  const normalized = raw.replace(/\r\n/g, "\n").trimEnd();
  inspectMarker(normalized, HOOK_PATH);
  return normalized.replace(/\n/g, newline);
}

async function patchTextFile(buffer, pathForError) {
  const decoded = decodeUtf8File(buffer ?? Buffer.alloc(0), pathForError);
  const marker = inspectMarker(decoded.text, pathForError);
  const hook = await loadHook(decoded.newline);
  let text;
  if (marker.status === "present") {
    text = `${decoded.text.slice(0, marker.start)}${hook}${decoded.text.slice(marker.end)}`;
  } else if (decoded.text.length === 0) {
    text = `${hook}${decoded.newline}`;
  } else {
    const separator = decoded.text.endsWith(decoded.newline)
      ? decoded.newline
      : `${decoded.newline}${decoded.newline}`;
    text = `${decoded.text}${separator}${hook}${decoded.newline}`;
  }
  const encoded = encodeUtf8File({ ...decoded, text });
  if (encoded.length > AGENT_FILE_MAX_BYTES) {
    throw new SyncoraError(
      "PATCH004",
      `Patched agent instruction file exceeds ${AGENT_FILE_MAX_BYTES} bytes: ${pathForError}`,
    );
  }
  return encoded;
}

function removeMarker(buffer, pathForError) {
  const decoded = decodeUtf8File(buffer, pathForError);
  const marker = inspectMarker(decoded.text, pathForError);
  if (marker.status === "absent") return buffer;
  const text = `${decoded.text.slice(0, marker.start)}${decoded.text.slice(marker.end)}`;
  return encodeUtf8File({ ...decoded, text });
}

function relativePortable(workspacePath, targetPath) {
  return relative(workspacePath, targetPath).split(sep).join("/");
}

function pathEscapesWorkspace(workspacePath, targetPath) {
  const portable = relative(workspacePath, targetPath);
  return (
    portable === ".." ||
    portable.startsWith(`..${sep}`) ||
    isAbsolute(portable)
  );
}

async function metadataIfPresent(path) {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function patchPathError(code, label, message, details = undefined) {
  return new SyncoraError(code, `${label} ${message}`, details);
}

async function captureParentBinding(
  workspacePath,
  targetPath,
  { code, label },
) {
  if (pathEscapesWorkspace(workspacePath, targetPath)) {
    throw patchPathError(code, label, `escapes the workspace: ${targetPath}`);
  }

  const workspaceBinding = await captureStableDirectoryBinding(workspacePath, {
    code,
    label: `${label} workspace root`,
    containmentRoot: workspacePath,
  });
  const parentPath = dirname(targetPath);
  const parentRelative = relative(workspacePath, parentPath);
  const segments = parentRelative === "" ? [] : parentRelative.split(sep);
  const entries = [];
  let containmentRoot = workspacePath;
  let ancestorMissing = false;

  for (const segment of segments) {
    const path = join(containmentRoot, segment);
    const metadata = ancestorMissing ? null : await metadataIfPresent(path);
    if (metadata === null) {
      ancestorMissing = true;
      entries.push({ path, containmentRoot, binding: null });
      containmentRoot = path;
      continue;
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw patchPathError(
        code,
        label,
        `parent contains a symlink, junction, or unexpected file type: ${path}`,
      );
    }
    const binding = await captureStableDirectoryBinding(path, {
      code,
      label: `${label} parent directory`,
      containmentRoot,
    });
    entries.push({ path, containmentRoot, binding });
    containmentRoot = path;
  }

  return {
    workspacePath,
    targetPath,
    parentPath,
    code,
    label,
    workspaceBinding,
    entries,
  };
}

async function assertParentBinding(binding) {
  await assertStableDirectoryBinding(binding.workspaceBinding, {
    code: binding.code,
    label: `${binding.label} workspace root`,
  });

  let parentAvailable = true;
  for (const entry of binding.entries) {
    if (entry.binding !== null) {
      await assertStableDirectoryBinding(entry.binding, {
        code: binding.code,
        label: `${binding.label} parent directory`,
      });
      continue;
    }

    const metadata = await metadataIfPresent(entry.path);
    if (metadata === null) {
      parentAvailable = false;
      continue;
    }
    if (!parentAvailable) {
      throw patchPathError(
        binding.code,
        binding.label,
        `parent topology changed unexpectedly: ${entry.path}`,
      );
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw patchPathError(
        binding.code,
        binding.label,
        `parent contains a symlink, junction, or unexpected file type: ${entry.path}`,
      );
    }

    // A transaction may create an ordinary missing parent between its first
    // preflight and its final rename. Adopt only that safe in-workspace
    // directory identity; later replacements must match it exactly.
    entry.binding = await captureStableDirectoryBinding(entry.path, {
      code: binding.code,
      label: `${binding.label} parent directory`,
      containmentRoot: entry.containmentRoot,
    });
  }

  await assertStableDirectoryBinding(binding.workspaceBinding, {
    code: binding.code,
    label: `${binding.label} workspace root`,
  });
  return parentAvailable;
}

async function readBoundedBoundFile(observation) {
  const parentAvailable = await assertParentBinding(observation.parentBinding);
  if (!parentAvailable) return null;
  const buffer = await readBoundedRegularFileIfPresent(observation.path, {
    containmentRoot: observation.parentBinding.parentPath,
    maximumBytes: observation.maximumBytes,
    code: observation.code,
    label: observation.label,
  });
  await assertParentBinding(observation.parentBinding);
  return buffer;
}

async function observeBoundedProjectFile(
  workspacePath,
  path,
  { maximumBytes, code, label },
) {
  const observation = {
    path,
    maximumBytes,
    code,
    label,
    parentBinding: await captureParentBinding(workspacePath, path, {
      code,
      label,
    }),
  };
  observation.buffer = await readBoundedBoundFile(observation);
  return observation;
}

function targetObservation(workspacePath, targetPath) {
  return observeBoundedProjectFile(workspacePath, targetPath, {
    maximumBytes: AGENT_FILE_MAX_BYTES,
    code: "PATCH004",
    label: "Agent instruction file",
  });
}

function snapshotObservation(workspacePath, snapshot) {
  return observeBoundedProjectFile(workspacePath, snapshot, {
    maximumBytes: AGENT_SNAPSHOT_MAX_BYTES,
    code: "PATCH003",
    label: "Agent restoration snapshot",
  });
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function assertState(condition, message) {
  if (!condition) throw new SyncoraError("STATE001", message);
}

function validatePatchState(state, workspacePath, statePath) {
  assertState(isPlainObject(state), `State must be a JSON object: ${statePath}`);
  const stateKeys = Object.keys(state).sort();
  const expectedStateKeys = state.agentPatches === undefined
    ? ["schemaVersion"]
    : ["agentPatches", "schemaVersion"];
  assertState(
    stateKeys.join("\0") === expectedStateKeys.join("\0"),
    `State has missing or unknown fields: ${statePath}`,
  );
  assertState(
    Number.isInteger(state.schemaVersion) && state.schemaVersion >= 1,
    `State schemaVersion must be a positive integer: ${statePath}`,
  );
  if (state.schemaVersion > STATE_SCHEMA_VERSION) {
    throw new SyncoraError(
      "SCHEMA001",
      `State schema ${state.schemaVersion} is newer than supported schema ${STATE_SCHEMA_VERSION}.`,
    );
  }

  if (state.agentPatches === undefined) return;
  assertState(
    isPlainObject(state.agentPatches),
    `State agentPatches must be an object: ${statePath}`,
  );
  const patchState = state.agentPatches;
  assertState(
    Object.keys(patchState).sort().join("\0") === "markerVersion\0targets",
    `State agentPatches has missing or unknown fields: ${statePath}`,
  );
  assertState(
    Number.isInteger(patchState.markerVersion) &&
      patchState.markerVersion >= 1 &&
      patchState.markerVersion <= CURRENT_VERSION,
    `State agentPatches.markerVersion is unsupported: ${statePath}`,
  );
  assertState(
    Array.isArray(patchState.targets) &&
      patchState.targets.length <= allKnownTargets(workspacePath).length,
    `State agentPatches.targets is invalid or excessive: ${statePath}`,
  );

  const allowedPaths = new Set(
    allKnownTargets(workspacePath).map((targetPath) =>
      relativePortable(workspacePath, targetPath),
    ),
  );
  const seenPaths = new Set();
  const targetKeys = [
    "createdBySyncora",
    "markerVersion",
    "originalExists",
    "originalHash",
    "originalSnapshot",
    "path",
    "resultingHash",
  ];

  for (const target of patchState.targets) {
    assertState(isPlainObject(target), `Patch target state must be an object.`);
    assertState(
      Object.keys(target).sort().join("\0") === targetKeys.join("\0"),
      `Patch target state has missing or unknown fields: ${statePath}`,
    );
    assertState(
      typeof target.path === "string" && allowedPaths.has(target.path),
      `Patch target path is not a supported normalized path: ${statePath}`,
    );
    assertState(
      !seenPaths.has(target.path),
      `Patch target path is duplicated: ${target.path}`,
    );
    seenPaths.add(target.path);
    assertState(
      typeof target.originalExists === "boolean" &&
        typeof target.createdBySyncora === "boolean" &&
        target.createdBySyncora === !target.originalExists,
      `Patch target ownership flags are inconsistent: ${target.path}`,
    );
    assertState(
      Number.isInteger(target.markerVersion) &&
        target.markerVersion >= 1 &&
        target.markerVersion <= CURRENT_VERSION,
      `Patch target marker version is unsupported: ${target.path}`,
    );
    assertState(
      typeof target.resultingHash === "string" &&
        HASH_PATTERN.test(target.resultingHash),
      `Patch target resulting hash is invalid: ${target.path}`,
    );

    if (!target.originalExists) {
      assertState(
        target.originalHash === null && target.originalSnapshot === null,
        `Syncora-created target must not declare an original snapshot: ${target.path}`,
      );
      continue;
    }

    assertState(
      typeof target.originalHash === "string" &&
        HASH_PATTERN.test(target.originalHash),
      `Patch target original hash is invalid: ${target.path}`,
    );
    const expectedSnapshot = relativePortable(
      workspacePath,
      snapshotPath(workspacePath, target.path, target.originalHash),
    );
    assertState(
      target.originalSnapshot === expectedSnapshot,
      `Patch target snapshot path is invalid: ${target.path}`,
    );
  }
}

function patchTargets(workspacePath, observedTargets) {
  const targets = [join(workspacePath, "AGENTS.md")];
  const overridePath = join(workspacePath, "AGENTS.override.md");
  if (observedTargets.get(overridePath).buffer !== null) targets.push(overridePath);

  const rootClaude = join(workspacePath, "CLAUDE.md");
  const nestedClaude = join(workspacePath, ".claude", "CLAUDE.md");
  targets.push(
    observedTargets.get(rootClaude).buffer !== null ? rootClaude : nestedClaude,
  );
  return targets;
}

function allKnownTargets(workspacePath) {
  return [
    join(workspacePath, "AGENTS.md"),
    join(workspacePath, "AGENTS.override.md"),
    join(workspacePath, "CLAUDE.md"),
    join(workspacePath, ".claude", "CLAUDE.md"),
  ];
}

async function observeAgentTargets(workspacePath) {
  const observations = new Map();
  for (const targetPath of allKnownTargets(workspacePath)) {
    observations.set(
      targetPath,
      await targetObservation(workspacePath, targetPath),
    );
  }
  return observations;
}

function importsAgents(text, targetPath) {
  const portable = targetPath.split(sep).join("/");
  if (portable.endsWith("/.claude/CLAUDE.md")) {
    return /(^|\s)@\.\.\/AGENTS\.md(?:\s|$)/m.test(text);
  }
  return /(^|\s)@(?:\.\/)?AGENTS\.md(?:\s|$)/m.test(text);
}

async function readState(workspacePath) {
  const statePath = join(workspacePath, ".syncora", "state.json");
  const stateObservation = await observeBoundedProjectFile(
    workspacePath,
    statePath,
    {
      maximumBytes: STATE_MAX_BYTES,
      code: "STATE001",
      label: "Syncora patch state",
    },
  );
  const stateBuffer = stateObservation.buffer;
  if (stateBuffer === null) {
    return {
      state: { schemaVersion: STATE_SCHEMA_VERSION },
      statePath,
      stateBuffer,
      stateObservation,
    };
  }
  assertState(
    stateBuffer.length <= STATE_MAX_BYTES,
    `State exceeds ${STATE_MAX_BYTES} bytes: ${statePath}`,
  );

  let state;
  try {
    state = JSON.parse(decodeUtf8File(stateBuffer, statePath).text);
  } catch (error) {
    if (error instanceof SyncoraError) throw error;
    throw new SyncoraError("STATE001", `Invalid JSON: ${statePath}`);
  }
  validatePatchState(state, workspacePath, statePath);
  return { state, statePath, stateBuffer, stateObservation };
}

function serializeState(state) {
  const serialized = Buffer.from(`${JSON.stringify(state, null, 2)}\n`, "utf8");
  assertState(
    serialized.length <= STATE_MAX_BYTES,
    `Serialized state exceeds ${STATE_MAX_BYTES} bytes.`,
  );
  return serialized;
}

function snapshotPath(workspacePath, relativePath, originalHash) {
  const identity = sha256(Buffer.from(`${relativePath}\0${originalHash}`, "utf8"));
  return join(
    workspacePath,
    ".syncora",
    "snapshots",
    "agent-files",
    `${identity}.bin`,
  );
}

function plan(path, before, after, displayPath, observation) {
  return {
    path,
    before,
    after,
    displayPath,
    readCurrent: () => readBoundedBoundFile(observation),
    verifyStorage: () => assertParentBinding(observation.parentBinding),
  };
}

async function recordBaseline(
  workspacePath,
  relativePath,
  baseline,
  plans,
) {
  const originalHash = baseline === null ? null : sha256(baseline);
  const originalSnapshot =
    baseline === null
      ? null
      : snapshotPath(workspacePath, relativePath, originalHash);

  if (baseline !== null) {
    const observation = await snapshotObservation(
      workspacePath,
      originalSnapshot,
    );
    plans.push(
      plan(
        originalSnapshot,
        observation.buffer,
        baseline,
        relativePortable(workspacePath, originalSnapshot),
        observation,
      ),
    );
  }

  return {
    path: relativePath,
    originalExists: baseline !== null,
    originalHash,
    originalSnapshot:
      originalSnapshot === null
        ? null
        : relativePortable(workspacePath, originalSnapshot),
    createdBySyncora: baseline === null,
  };
}

async function restoreTarget(
  workspacePath,
  targetPath,
  relativePath,
  before,
  record,
  warnings,
) {
  if (before === null) return { markerPresent: false, after: null };

  const decoded = decodeUtf8File(before, targetPath);
  const marker = inspectMarker(decoded.text, targetPath);
  if (marker.status === "absent") {
    return { markerPresent: false, after: before };
  }

  if (record && record.resultingHash === sha256(before)) {
    if (!record.originalExists) {
      return { markerPresent: true, after: null };
    }
    if (!record.originalSnapshot) {
      throw new SyncoraError(
        "PATCH003",
        `Original agent-file snapshot is not recorded for ${relativePath}.`,
      );
    }
    const snapshot = join(
      workspacePath,
      ...record.originalSnapshot.split("/"),
    );
    const after = (await snapshotObservation(workspacePath, snapshot)).buffer;
    if (after === null || sha256(after) !== record.originalHash) {
      throw new SyncoraError(
        "PATCH003",
        `Original agent-file snapshot is missing or corrupted: ${snapshot}`,
      );
    }
    return { markerPresent: true, after };
  }

  warnings.push({
    code: record ? "PATCH_DIVERGED" : "PATCH_UNTRACKED",
    message: record
      ? `${relativePath} changed after patching; removed only the marker-owned block.`
      : `${relativePath} contained an untracked Syncora marker; removed only the marker-owned block.`,
  });
  return {
    markerPresent: true,
    after: removeMarker(before, targetPath),
  };
}

async function verifyRecordedSnapshot(workspacePath, relativePath, record) {
  if (!record.originalExists) return null;
  if (!record.originalSnapshot) {
    throw new SyncoraError(
      "PATCH003",
      `Original agent-file snapshot is not recorded for ${relativePath}.`,
    );
  }
  const snapshot = join(
    workspacePath,
    ...record.originalSnapshot.split("/"),
  );
  const content = (await snapshotObservation(workspacePath, snapshot)).buffer;
  if (content === null || sha256(content) !== record.originalHash) {
    throw new SyncoraError(
      "PATCH003",
      `Original agent-file snapshot is missing or corrupted: ${snapshot}`,
    );
  }
  return content;
}

async function removeRecordedSnapshot(workspacePath, record, plans) {
  if (!record?.originalSnapshot) return;
  const snapshot = join(
    workspacePath,
    ...record.originalSnapshot.split("/"),
  );
  const observation = await snapshotObservation(workspacePath, snapshot);
  plans.push(
    plan(
      snapshot,
      observation.buffer,
      null,
      relativePortable(workspacePath, snapshot),
      observation,
    ),
  );
}

async function planAgentPatchInternal(
  workspacePath,
  {
    migrationCutover = false,
    allowPredecessorActivation = false,
  } = {},
) {
  const { state, statePath, stateBuffer, stateObservation } =
    await readState(workspacePath);
  const previousTargets = new Map(
    (state.agentPatches?.targets ?? []).map((item) => [item.path, item]),
  );
  const plans = [];
  const nextTargets = [];
  const warnings = [];
  const activeTargets = new Set();
  const retiredTargets = new Set();
  const plannedTargets = new Set();
  const observedTargets = await observeAgentTargets(workspacePath);

  function addTargetPlan(targetPath, before, after, relativePath) {
    const key = process.platform === "win32" ? targetPath.toLowerCase() : targetPath;
    if (plannedTargets.has(key)) {
      throw new SyncoraError(
        "WRITE003",
        `Agent patch planning produced a duplicate target: ${targetPath}`,
      );
    }
    plannedTargets.add(key);
    plans.push(
      plan(
        targetPath,
        before,
        after,
        relativePath,
        observedTargets.get(targetPath),
      ),
    );
  }

  for (const targetPath of patchTargets(workspacePath, observedTargets)) {
    const relativePath = relativePortable(workspacePath, targetPath);
    const before = observedTargets.get(targetPath).buffer;
    let existingMarker = { status: "absent" };
    let predecessor = { status: "absent" };
    let possibleCustomPredecessorActivation = false;
    let claudeImportsAgents = false;

    if (before !== null && relativePath.toLowerCase().endsWith("claude.md")) {
      const decoded = decodeUtf8File(before, targetPath);
      const activation = inspectInstructionActivation(decoded.text, targetPath);
      existingMarker = activation.marker;
      predecessor = activation.predecessor;
      possibleCustomPredecessorActivation =
        activation.possibleCustomPredecessorActivation;
      claudeImportsAgents = importsAgents(decoded.text, targetPath);
    } else if (before !== null) {
      const decoded = decodeUtf8File(before, targetPath);
      const activation = inspectInstructionActivation(decoded.text, targetPath);
      existingMarker = activation.marker;
      predecessor = activation.predecessor;
      possibleCustomPredecessorActivation =
        activation.possibleCustomPredecessorActivation;
    }

    if (
      possibleCustomPredecessorActivation ||
      (
        predecessor.status === "present" &&
        !migrationCutover &&
        !allowPredecessorActivation
      )
    ) {
      throw new SyncoraError(
        "PATCH005",
        `Refusing to patch ${relativePath} while possible predecessor activation remains outside Syncora-owned instructions. Remove or retire the predecessor activation first.`,
      );
    }

    const cutover = migrationCutover
      ? await cutoverPredecessorWorkflow(before, targetPath, {
          installHook: !claudeImportsAgents,
        })
      : null;

    if (claudeImportsAgents) {
      if (cutover !== null) {
        const record = previousTargets.get(relativePath);
        addTargetPlan(
          targetPath,
          before,
          cutover.baseline,
          relativePath,
        );
        await removeRecordedSnapshot(workspacePath, record, plans);
        retiredTargets.add(relativePath);
        warnings.push({
          code: "LEGACY_AGENT_WORKFLOW_CUTOVER",
          message: `${relativePath} predecessor workflow was removed; its AGENTS.md import remains the only activation path.`,
        });
        continue;
      }

      {
        const record = previousTargets.get(relativePath);
        const restored = await restoreTarget(
          workspacePath,
          targetPath,
          relativePath,
          before,
          record,
          warnings,
        );
        if (restored.markerPresent) {
          addTargetPlan(targetPath, before, restored.after, relativePath);
        } else {
          addTargetPlan(targetPath, before, before, relativePath);
        }
        await removeRecordedSnapshot(workspacePath, record, plans);
        retiredTargets.add(relativePath);
        continue;
      }
    }

    const after = cutover?.after ?? await patchTextFile(before, targetPath);
    let record = previousTargets.get(relativePath);
    const trackedBytesAreExact =
      record !== undefined &&
      before !== null &&
      record.resultingHash === sha256(before);
    let trackedSnapshot = null;

    if (trackedBytesAreExact) {
      if (
        existingMarker.status !== "present" ||
        existingMarker.version !== record.markerVersion
      ) {
        throw new SyncoraError(
          "STATE001",
          `Tracked marker metadata does not match ${relativePath}.`,
        );
      }
      trackedSnapshot = await verifyRecordedSnapshot(
        workspacePath,
        relativePath,
        record,
      );
    }

    if (!trackedBytesAreExact || cutover !== null) {
      if (!trackedBytesAreExact) {
        if (existingMarker.status === "present" && record === undefined) {
          warnings.push({
            code: "PATCH_UNTRACKED",
            message: `${relativePath} contained an untracked Syncora marker; refreshed the reversible baseline without that marker.`,
          });
        } else if (record !== undefined) {
          warnings.push({
            code: "PATCH_DIVERGED",
            message: `${relativePath} changed after patching; refreshed the reversible baseline from current user-owned bytes.`,
          });
        }
      }
      const previousSnapshot = record?.originalSnapshot ?? null;
      const snapshotCutover = cutover !== null && trackedSnapshot !== null
        ? await cutoverPredecessorWorkflow(
            trackedSnapshot,
            `${targetPath} restoration snapshot`,
            { installHook: false },
          )
        : null;
      const baseline = snapshotCutover?.baseline ?? cutover?.baseline ?? (
        before !== null && existingMarker.status === "present"
          ? removeMarker(before, targetPath)
          : before
      );
      record = await recordBaseline(
        workspacePath,
        relativePath,
        baseline,
        plans,
      );

      if (
        previousSnapshot !== null &&
        previousSnapshot !== record.originalSnapshot
      ) {
        const obsoleteSnapshot = join(
          workspacePath,
          ...previousSnapshot.split("/"),
        );
        const observation = await snapshotObservation(
          workspacePath,
          obsoleteSnapshot,
        );
        plans.push(
          plan(
            obsoleteSnapshot,
            observation.buffer,
            null,
            relativePortable(workspacePath, obsoleteSnapshot),
            observation,
          ),
        );
      }
    }

    if (cutover !== null) {
      warnings.push({
        code: "LEGACY_AGENT_WORKFLOW_CUTOVER",
        message: `${relativePath} predecessor workflow was atomically replaced by Syncora hook v${CURRENT_VERSION}.`,
      });
    }

    addTargetPlan(targetPath, before, after, relativePath);
    activeTargets.add(relativePath);
    nextTargets.push({
      ...record,
      markerVersion: CURRENT_VERSION,
      resultingHash: sha256(after),
    });
  }

  for (const targetPath of allKnownTargets(workspacePath)) {
    const relativePath = relativePortable(workspacePath, targetPath);
    if (activeTargets.has(relativePath) || retiredTargets.has(relativePath)) {
      continue;
    }

    const before = observedTargets.get(targetPath).buffer;
    const record = previousTargets.get(relativePath);
    const cutover = migrationCutover
      ? await cutoverPredecessorWorkflow(before, targetPath, {
          installHook: false,
        })
      : null;
    if (cutover !== null) {
      addTargetPlan(
        targetPath,
        before,
        cutover.baseline,
        relativePath,
      );
      await removeRecordedSnapshot(workspacePath, record, plans);
      warnings.push({
        code: "LEGACY_AGENT_WORKFLOW_CUTOVER",
        message: `${relativePath} predecessor workflow was removed from an inactive agent instruction target.`,
      });
      continue;
    }
    const restored = await restoreTarget(
      workspacePath,
      targetPath,
      relativePath,
      before,
      record,
      warnings,
    );
    if (restored.markerPresent) {
      addTargetPlan(targetPath, before, restored.after, relativePath);
    } else {
      addTargetPlan(targetPath, before, before, relativePath);
    }
    await removeRecordedSnapshot(workspacePath, record, plans);
  }

  nextTargets.sort((left, right) => left.path.localeCompare(right.path));
  const nextState = {
    ...state,
    schemaVersion: STATE_SCHEMA_VERSION,
    agentPatches: {
      markerVersion: CURRENT_VERSION,
      targets: nextTargets,
    },
  };
  plans.push(
    plan(
      statePath,
      stateBuffer,
      serializeState(nextState),
      relativePortable(workspacePath, statePath),
      stateObservation,
    ),
  );

  return { plans, warnings };
}

export async function planAgentPatch(workspacePath, options = {}) {
  return planAgentPatchInternal(workspacePath, options);
}

export async function planAgentMigrationCutover(workspacePath) {
  return planAgentPatchInternal(workspacePath, { migrationCutover: true });
}

export async function verifyAgentPatchPlans(workspacePath, plans) {
  const allowedTargets = new Set(
    allKnownTargets(workspacePath).map((targetPath) =>
      process.platform === "win32" ? targetPath.toLowerCase() : targetPath,
    ),
  );
  const statePath = join(workspacePath, ".syncora", "state.json");
  const stateKey = process.platform === "win32" ? statePath.toLowerCase() : statePath;
  const snapshotPattern = /^\.syncora\/snapshots\/agent-files\/[0-9a-f]{64}\.bin$/;

  for (const item of plans) {
    const key = process.platform === "win32" ? item.path.toLowerCase() : item.path;
    const portable = relativePortable(workspacePath, item.path);
    if (
      !allowedTargets.has(key) &&
      key !== stateKey &&
      !snapshotPattern.test(portable)
    ) {
      throw new SyncoraError(
        "PATCH004",
        `Agent patch transaction contains an unsupported path: ${item.path}`,
      );
    }
    if (
      typeof item.readCurrent !== "function" ||
      typeof item.verifyStorage !== "function"
    ) {
      throw new SyncoraError(
        "PATCH004",
        `Agent patch transaction lacks a bounded storage binding: ${item.path}`,
      );
    }
    await item.verifyStorage();
  }
}

export async function planAgentUnpatch(workspacePath) {
  const { state, statePath, stateBuffer, stateObservation } =
    await readState(workspacePath);
  const records = new Map(
    (state.agentPatches?.targets ?? []).map((item) => [item.path, item]),
  );
  const plans = [];
  const warnings = [];
  const observedTargets = await observeAgentTargets(workspacePath);

  for (const targetPath of allKnownTargets(workspacePath)) {
    const before = observedTargets.get(targetPath).buffer;
    const relativePath = relativePortable(workspacePath, targetPath);
    const record = records.get(relativePath);
    const restored = await restoreTarget(
      workspacePath,
      targetPath,
      relativePath,
      before,
      record,
      warnings,
    );
    plans.push(
      plan(
        targetPath,
        before,
        restored.markerPresent ? restored.after : before,
        relativePath,
        observedTargets.get(targetPath),
      ),
    );
  }

  for (const record of records.values()) {
    if (!record.originalSnapshot) continue;
    const snapshot = join(workspacePath, ...record.originalSnapshot.split("/"));
    const observation = await snapshotObservation(workspacePath, snapshot);
    plans.push(
      plan(
        snapshot,
        observation.buffer,
        null,
        relativePortable(workspacePath, snapshot),
        observation,
      ),
    );
  }

  const nextState = {
    ...state,
    schemaVersion: STATE_SCHEMA_VERSION,
    agentPatches: {
      markerVersion: CURRENT_VERSION,
      targets: [],
    },
  };
  plans.push(
    plan(
      statePath,
      stateBuffer,
      serializeState(nextState),
      relativePortable(workspacePath, statePath),
      stateObservation,
    ),
  );

  return { plans, warnings };
}

export async function inspectAgentHooks(workspacePath) {
  const results = [];
  for (const targetPath of allKnownTargets(workspacePath)) {
    const buffer = (await targetObservation(workspacePath, targetPath)).buffer;
    if (buffer === null) continue;
    const decoded = decodeUtf8File(buffer, targetPath);
    const activation = inspectInstructionActivation(decoded.text, targetPath);
    results.push({
      path: relativePortable(workspacePath, targetPath),
      marker: activation.marker.status,
      version: activation.marker.version,
      legacyKnowledgeGraphWorkflow:
        activation.predecessor.status === "present",
      possibleCustomPredecessorActivation:
        activation.possibleCustomPredecessorActivation,
    });
  }
  return results;
}
