import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { SyncoraError } from "./cli.mjs";

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

export function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export async function readOptionalBuffer(path) {
  try {
    return await readFile(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export function decodeUtf8File(buffer, pathForError = "file") {
  const hasBom =
    buffer.length >= 3 && buffer.subarray(0, 3).equals(UTF8_BOM);
  const content = hasBom ? buffer.subarray(3) : buffer;

  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    throw new SyncoraError(
      "TEXT001",
      `${pathForError} is not valid UTF-8 and cannot be patched safely.`,
    );
  }

  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  return { hasBom, newline, text };
}

export function encodeUtf8File({ hasBom, text }) {
  const content = Buffer.from(text, "utf8");
  return hasBom ? Buffer.concat([UTF8_BOM, content]) : content;
}

async function modeFor(path) {
  try {
    const metadata = await stat(path);
    return metadata.mode;
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

export async function writeBufferAtomic(
  path,
  content,
  mode = undefined,
  beforePublish = undefined,
) {
  await mkdir(dirname(path), { recursive: true });
  if (beforePublish) await beforePublish();
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.syncora-${process.pid}-${randomUUID()}.tmp`,
  );

  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }

  if (mode !== undefined && process.platform !== "win32") {
    await chmod(temporaryPath, mode);
  }

  try {
    if (beforePublish) await beforePublish();
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function buffersEqual(left, right) {
  if (left === null || right === null) return left === right;
  return left.equals(right);
}

async function readPlanCurrent(plan) {
  return plan.readCurrent
    ? await plan.readCurrent()
    : await readOptionalBuffer(plan.path);
}

async function assertPlanCurrent(plan, expected) {
  const current = await readPlanCurrent(plan);
  if (!buffersEqual(current, expected)) {
    throw new SyncoraError(
      "WRITE001",
      `File changed after preflight: ${plan.path}`,
    );
  }
}

export function describePlan(plan, workspacePath) {
  const action = buffersEqual(plan.before, plan.after)
    ? "unchanged"
    : plan.before === null
      ? "create"
      : plan.after === null
        ? "delete"
        : "update";

  return {
    action,
    path: plan.displayPath ?? plan.path.replace(`${workspacePath}\\`, ""),
  };
}

export async function applyFilePlans(plans) {
  const uniquePaths = new Set();
  for (const plan of plans) {
    const key = process.platform === "win32" ? plan.path.toLowerCase() : plan.path;
    if (uniquePaths.has(key)) {
      throw new SyncoraError(
        "WRITE003",
        `A transaction contains duplicate target path: ${plan.path}`,
      );
    }
    uniquePaths.add(key);

    await assertPlanCurrent(plan, plan.before);
  }

  const changed = plans.filter((plan) => !buffersEqual(plan.before, plan.after));
  const originals = [];

  try {
    for (const plan of changed) {
      const original = {
        path: plan.path,
        content: plan.before,
        published: plan.after,
        mode: await modeFor(plan.path),
        readCurrent: plan.readCurrent,
      };

      if (plan.after === null) {
        await assertPlanCurrent(plan, plan.before);
        await rm(plan.path, { force: true });
      } else {
        await writeBufferAtomic(
          plan.path,
          plan.after,
          original.mode,
          () => assertPlanCurrent(plan, plan.before),
        );
      }

      originals.push(original);
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const original of originals.reverse()) {
      try {
        const rollbackPlan = {
          path: original.path,
          readCurrent: original.readCurrent,
        };
        const assertPublished = async () => {
          const current = await readPlanCurrent(rollbackPlan);
          if (!buffersEqual(current, original.published)) {
            throw new SyncoraError(
              "WRITE005",
              `Rollback skipped because the file no longer contains the bytes Syncora published: ${original.path}`,
            );
          }
        };

        if (original.content === null) {
          await assertPublished();
          await rm(original.path, { force: true });
        } else {
          await writeBufferAtomic(
            original.path,
            original.content,
            original.mode,
            assertPublished,
          );
        }
      } catch (rollbackError) {
        rollbackErrors.push({
          path: original.path,
          message: rollbackError.message,
        });
      }
    }

    if (rollbackErrors.length > 0) {
      throw new SyncoraError(
        "WRITE004",
        "The transaction failed and rollback was incomplete.",
        { cause: error.message, rollbackErrors },
      );
    }
    throw error;
  }

  return changed;
}
