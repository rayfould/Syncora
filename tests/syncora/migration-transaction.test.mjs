import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  migrationPaths,
  taggedSha256,
} from "../../skills/syncora/scripts/lib/migration-state.mjs";
import {
  applyRecovery,
  prepareRecovery,
  rollbackRecovery,
} from "../../skills/syncora/scripts/lib/migration-transaction.mjs";

const RECOVERY_BINDINGS = Object.freeze({
  workspaceIdentity: taggedSha256("workspace"),
  rootIdentity: taggedSha256("root"),
  manifestSha256: taggedSha256("manifest"),
});

async function fixture() {
  const workspacePath = await realpath(
    await mkdtemp(join(tmpdir(), "syncora-transaction-")),
  );
  const graphRoot = join(workspacePath, "local");
  const paths = migrationPaths(graphRoot, "legacy-adoption");
  await mkdir(paths.root, { recursive: true });
  await mkdir(join(graphRoot, "knowledge"), { recursive: true });
  await writeFile(join(graphRoot, "index.md"), "legacy atlas\n");
  await writeFile(join(graphRoot, "knowledge", "legacy.md"), "legacy note\n");
  await writeFile(join(workspacePath, "AGENTS.md"), "legacy workflow\n");
  return { workspacePath, graphRoot, paths };
}

function records() {
  return [
    {
      root: "graph",
      path: ".syncora/migrations/legacy-adoption/archive/index.md",
      category: "archive",
      before: null,
      after: Buffer.from("legacy atlas\n"),
    },
    {
      root: "graph",
      path: "index.md",
      category: "graph",
      before: Buffer.from("legacy atlas\n"),
      after: Buffer.from("new atlas\n"),
    },
    {
      root: "graph",
      path: "knowledge/legacy.md",
      category: "graph",
      before: Buffer.from("legacy note\n"),
      after: null,
    },
    {
      root: "workspace",
      path: "AGENTS.md",
      category: "agent",
      before: Buffer.from("legacy workflow\n"),
      after: Buffer.from("syncora hook\n"),
    },
  ];
}

test("journaled migration transaction applies, resumes idempotently, and rolls back exact bytes", async () => {
  const environment = await fixture();
  const roots = {
    workspacePath: environment.workspacePath,
    graphRoot: environment.graphRoot,
  };
  try {
    const prepared = await prepareRecovery({
      paths: environment.paths,
      migrationId: "legacy-adoption",
      ...RECOVERY_BINDINGS,
      records: records(),
    });
    const applied = await applyRecovery({
      paths: environment.paths,
      roots,
      recovery: prepared.recovery,
    });
    assert.equal(applied.recovery.status, "applied");
    assert.equal(await readFile(join(environment.graphRoot, "index.md"), "utf8"), "new atlas\n");
    await assert.rejects(readFile(join(environment.graphRoot, "knowledge", "legacy.md")));
    assert.equal(await readFile(join(environment.workspacePath, "AGENTS.md"), "utf8"), "syncora hook\n");

    const resumed = await applyRecovery({
      paths: environment.paths,
      roots,
      recovery: applied.recovery,
    });
    assert.equal(resumed.summary.already, 4);

    const rolledBack = await rollbackRecovery({
      paths: environment.paths,
      roots,
      recovery: resumed.recovery,
    });
    assert.equal(rolledBack.recovery.status, "rolled-back");
    assert.equal(await readFile(join(environment.graphRoot, "index.md"), "utf8"), "legacy atlas\n");
    assert.equal(await readFile(join(environment.graphRoot, "knowledge", "legacy.md"), "utf8"), "legacy note\n");
    assert.equal(await readFile(join(environment.workspacePath, "AGENTS.md"), "utf8"), "legacy workflow\n");
  } finally {
    await rm(environment.workspacePath, { recursive: true, force: true });
  }
});

test("transaction preflight rejects concurrent bytes before publishing any record", async () => {
  const environment = await fixture();
  const roots = {
    workspacePath: environment.workspacePath,
    graphRoot: environment.graphRoot,
  };
  try {
    const prepared = await prepareRecovery({
      paths: environment.paths,
      migrationId: "legacy-adoption",
      ...RECOVERY_BINDINGS,
      records: records(),
    });
    await writeFile(join(environment.workspacePath, "AGENTS.md"), "user edit\n");
    await assert.rejects(
      applyRecovery({ paths: environment.paths, roots, recovery: prepared.recovery }),
      (error) => error?.code === "MIGRATE009",
    );
    assert.equal(await readFile(join(environment.graphRoot, "index.md"), "utf8"), "legacy atlas\n");
    assert.equal(await readFile(join(environment.workspacePath, "AGENTS.md"), "utf8"), "user edit\n");
  } finally {
    await rm(environment.workspacePath, { recursive: true, force: true });
  }
});

test("transaction resumes when a crash left an already-published prefix", async () => {
  const environment = await fixture();
  const roots = {
    workspacePath: environment.workspacePath,
    graphRoot: environment.graphRoot,
  };
  try {
    const prepared = await prepareRecovery({
      paths: environment.paths,
      migrationId: "legacy-adoption",
      ...RECOVERY_BINDINGS,
      records: records(),
    });
    await mkdir(join(environment.graphRoot, ".syncora", "migrations", "legacy-adoption", "archive"), { recursive: true });
    await writeFile(
      join(environment.graphRoot, ".syncora", "migrations", "legacy-adoption", "archive", "index.md"),
      "legacy atlas\n",
    );
    const result = await applyRecovery({
      paths: environment.paths,
      roots,
      recovery: prepared.recovery,
    });
    assert.equal(result.recovery.status, "applied");
    assert.ok(result.summary.already >= 1);
  } finally {
    await rm(environment.workspacePath, { recursive: true, force: true });
  }
});

test("recovery directory creation rejects a junction before external mutation", async (t) => {
  const workspacePath = await realpath(
    await mkdtemp(join(tmpdir(), "syncora-transaction-junction-")),
  );
  const graphRoot = join(workspacePath, "local");
  const outside = join(workspacePath, "outside");
  const paths = migrationPaths(graphRoot, "legacy-adoption");
  try {
    await mkdir(join(graphRoot, ".syncora"), { recursive: true });
    await mkdir(outside, { recursive: true });
    try {
      await symlink(outside, paths.migrationsRoot, "junction");
    } catch (error) {
      if (new Set(["EPERM", "EACCES", "ENOTSUP"]).has(error?.code)) {
        t.skip(`junction creation unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    await assert.rejects(
      prepareRecovery({
        paths,
        migrationId: "legacy-adoption",
        ...RECOVERY_BINDINGS,
        records: [],
      }),
      (error) => new Set(["MIGRATE004", "MIGRATE008"]).has(error?.code),
    );
    await assert.rejects(
      lstat(join(outside, "legacy-adoption")),
      (error) => error?.code === "ENOENT",
    );
  } finally {
    await rm(workspacePath, { recursive: true, force: true });
  }
});
