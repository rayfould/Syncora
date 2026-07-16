import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  applyFilePlans,
  readOptionalBuffer,
} from "../../skills/syncora/scripts/lib/atomic-file.mjs";

const ORIGINAL = Buffer.from("original\n", "utf8");
const PUBLISHED = Buffer.from("published\n", "utf8");
const CONCURRENT = Buffer.from("concurrent user edit\n", "utf8");

const ACTIONS = [
  {
    name: "create",
    before: null,
    after: PUBLISHED,
  },
  {
    name: "update",
    before: ORIGINAL,
    after: PUBLISHED,
  },
  {
    name: "delete",
    before: ORIGINAL,
    after: null,
  },
];

async function temporaryWorkspace() {
  return mkdtemp(join(tmpdir(), "syncora-atomic-file-"));
}

async function initialize(path, content) {
  if (content !== null) await writeFile(path, content);
}

async function assertContent(path, expected) {
  assert.deepEqual(await readOptionalBuffer(path), expected);
}

async function assertNoTemporaryFiles(workspace) {
  const entries = await readdir(workspace);
  assert.equal(
    entries.some((entry) => entry.includes(".syncora-") && entry.endsWith(".tmp")),
    false,
  );
}

for (const action of ACTIONS) {
  test(`${action.name} rechecks the target before its write`, async () => {
    const workspace = await temporaryWorkspace();
    const targetPath = join(workspace, "target.md");
    let reads = 0;
    try {
      await initialize(targetPath, action.before);
      const plan = {
        path: targetPath,
        before: action.before,
        after: action.after,
        async readCurrent() {
          reads += 1;
          if (reads === 2) await writeFile(targetPath, CONCURRENT);
          return readOptionalBuffer(targetPath);
        },
      };

      await assert.rejects(
        applyFilePlans([plan]),
        (error) => error?.code === "WRITE001",
      );

      assert.equal(reads, 2);
      await assertContent(targetPath, CONCURRENT);
      await assertNoTemporaryFiles(workspace);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
}

for (const action of ACTIONS.filter((item) => item.after !== null)) {
  test(`${action.name} rechecks again at the final atomic publish boundary`, async () => {
    const workspace = await temporaryWorkspace();
    const targetPath = join(workspace, "target.md");
    let reads = 0;
    try {
      await initialize(targetPath, action.before);
      const plan = {
        path: targetPath,
        before: action.before,
        after: action.after,
        async readCurrent() {
          reads += 1;
          if (reads === 3) await writeFile(targetPath, CONCURRENT);
          return readOptionalBuffer(targetPath);
        },
      };

      await assert.rejects(
        applyFilePlans([plan]),
        (error) => error?.code === "WRITE001",
      );

      assert.equal(reads, 3);
      await assertContent(targetPath, CONCURRENT);
      await assertNoTemporaryFiles(workspace);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
}

for (const action of ACTIONS) {
  test(`rollback restores a ${action.name} only while Syncora's published bytes remain current`, async () => {
    const workspace = await temporaryWorkspace();
    const targetPath = join(workspace, "target.md");
    const failurePath = join(workspace, "failure.md");
    const failure = new Error("forced transaction failure");
    const rollbackGuardRead =
      action.name === "create" ? 4 : action.name === "update" ? 5 : 4;
    let targetReads = 0;
    let failureReads = 0;
    try {
      await initialize(targetPath, action.before);
      await writeFile(failurePath, ORIGINAL);

      await assert.rejects(
        applyFilePlans([
          {
            path: targetPath,
            before: action.before,
            after: action.after,
            async readCurrent() {
              targetReads += 1;
              if (targetReads === rollbackGuardRead) {
                await writeFile(targetPath, CONCURRENT);
              }
              return readOptionalBuffer(targetPath);
            },
          },
          {
            path: failurePath,
            before: ORIGINAL,
            after: PUBLISHED,
            async readCurrent() {
              failureReads += 1;
              if (failureReads === 2) throw failure;
              return readFile(failurePath);
            },
          },
        ]),
        (error) => {
          assert.equal(error?.code, "WRITE004");
          assert.equal(error.details?.cause, failure.message);
          assert.equal(error.details?.rollbackErrors?.length, 1);
          assert.equal(error.details.rollbackErrors[0].path, targetPath);
          assert.match(
            error.details.rollbackErrors[0].message,
            /no longer contains the bytes Syncora published/,
          );
          return true;
        },
      );

      assert.equal(targetReads, rollbackGuardRead);
      await assertContent(targetPath, CONCURRENT);
      await assertContent(failurePath, ORIGINAL);
      await assertNoTemporaryFiles(workspace);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
}

for (const action of ACTIONS) {
  test(`rollback reverses a ${action.name} when the published bytes are unchanged`, async () => {
    const workspace = await temporaryWorkspace();
    const targetPath = join(workspace, "target.md");
    const failurePath = join(workspace, "failure.md");
    const failure = new Error("forced transaction failure");
    let failureReads = 0;
    try {
      await initialize(targetPath, action.before);
      await writeFile(failurePath, ORIGINAL);

      await assert.rejects(
        applyFilePlans([
          {
            path: targetPath,
            before: action.before,
            after: action.after,
          },
          {
            path: failurePath,
            before: ORIGINAL,
            after: PUBLISHED,
            async readCurrent() {
              failureReads += 1;
              if (failureReads === 2) throw failure;
              return readFile(failurePath);
            },
          },
        ]),
        (error) => error === failure,
      );

      await assertContent(targetPath, action.before);
      await assertContent(failurePath, ORIGINAL);
      await assertNoTemporaryFiles(workspace);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
}
