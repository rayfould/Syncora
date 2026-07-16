import { lstat, mkdir } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import { SyncoraError } from "./cli.mjs";
import {
  assertStableDirectoryBinding,
  captureStableDirectoryBinding,
} from "./lock-recovery-guard.mjs";

async function metadataIfPresent(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function containedSegments(root, target, code, label) {
  const result = relative(root, target);
  if (
    result === ".." ||
    result.startsWith(`..${sep}`) ||
    isAbsolute(result)
  ) {
    throw new SyncoraError(code, `${label} escapes its trusted root: ${target}`);
  }
  return result === "" ? [] : result.split(sep).filter(Boolean);
}

/**
 * Creates a contained directory one segment at a time and then pins every
 * directory identity. The returned guard must be reasserted immediately before
 * temporary-file creation and atomic rename.
 */
export function createStableDirectoryGuard(
  root,
  target,
  { code = "MIGRATE008", label = "Migration directory" } = {},
) {
  const segments = containedSegments(root, target, code, label);
  let bindings = null;

  async function assert() {
    if (bindings === null) {
      throw new SyncoraError(code, `${label} guard was not prepared: ${target}`);
    }
    for (const entry of bindings) {
      await assertStableDirectoryBinding(entry.binding, {
        code,
        label: entry.label,
      });
    }
  }

  async function prepare() {
    if (bindings !== null) {
      await assert();
      return;
    }

    const captured = [];
    let parent = root;
    let parentBinding = await captureStableDirectoryBinding(root, {
      code,
      label: `${label} trusted root`,
      containmentRoot: root,
    });
    captured.push({
      binding: parentBinding,
      label: `${label} trusted root`,
    });

    for (const segment of segments) {
      await assertStableDirectoryBinding(parentBinding, {
        code,
        label: `${label} parent`,
      });
      const current = join(parent, segment);
      let metadata = await metadataIfPresent(current);
      if (metadata === null) {
        try {
          // Never use recursive creation here: each parent has already been
          // captured and is rechecked around this single-segment mutation.
          await mkdir(current);
        } catch (error) {
          if (error?.code !== "EEXIST") throw error;
        }
        metadata = await metadataIfPresent(current);
      }
      if (
        metadata === null ||
        !metadata.isDirectory() ||
        metadata.isSymbolicLink()
      ) {
        throw new SyncoraError(
          code,
          `${label} contains an unsafe directory component: ${current}`,
        );
      }
      const binding = await captureStableDirectoryBinding(current, {
        code,
        label: `${label} component`,
        containmentRoot: parent,
      });
      await assertStableDirectoryBinding(parentBinding, {
        code,
        label: `${label} parent`,
      });
      captured.push({ binding, label: `${label} component` });
      parent = current;
      parentBinding = binding;
    }

    bindings = captured;
    await assert();
  }

  return Object.freeze({ root, target, prepare, assert });
}
