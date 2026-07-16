import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  AUTHORITY_INVENTORY_POLICY,
  inventoryAuthority,
} from "../../skills/syncora/scripts/lib/authority-inventory.mjs";
import { isNonPortableGraphPath } from "../../skills/syncora/scripts/lib/graph-scanner.mjs";
import { VALIDATION_POLICY } from "../../skills/syncora/scripts/lib/validate.mjs";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(testDirectory, "..", "..");
const cli = join(repositoryRoot, "skills", "syncora", "scripts", "syncora.mjs");

function run(args, expectedStatus = 0) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
  assert.equal(
    result.status,
    expectedStatus,
    `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result;
}

async function temporaryWorkspace() {
  return mkdtemp(join(tmpdir(), "syncora-migrate-"));
}

async function writeNote(workspace, path, content) {
  const destination = join(workspace, "local", ...path.split("/"));
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, content);
  return destination;
}

function currentNote({ id, schemaVersion = 1 }) {
  return `---
id: ${id}
kind: project
scope: workspace
state: active
authority: canonical
schema_version: ${schemaVersion}
created: 2026-07-15
updated: 2026-07-15
summary: ${JSON.stringify(`Summary for ${id}`)}
---

# ${id}
`;
}

async function markdownManifest(workspace) {
  const root = join(workspace, "local");
  const result = [];
  async function walk(path) {
    const entries = await readdir(path, { withFileTypes: true });
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        const bytes = await readFile(full);
        result.push({
          path: relative(root, full).replaceAll("\\", "/"),
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
      }
    }
  }
  await walk(root);
  return result;
}

function migrate(workspace, extra = []) {
  return JSON.parse(
    run([
      "migrate",
      "--phase",
      "authority",
      "--dry-run",
      "--workspace",
      workspace,
      "--format",
      "json",
      ...extra,
    ]).stdout,
  );
}

test("authority migration emits deterministic metadata-only inventory without mutation", async () => {
  const workspace = await temporaryWorkspace();
  try {
    await writeNote(
      workspace,
      "knowledge/projects/workspace.md",
      currentNote({ id: "project-workspace" }),
    );
    await writeNote(
      workspace,
      "knowledge/decisions/legacy.md",
      [
        "---",
        "id: legacy-sentinel-id",
        "type: decision",
        "status: accepted-sentinel-status",
        "decision_key: sentinel.key",
        "---",
        "",
        "# canonical-title-sentinel",
        "",
        "PROMPT-INJECTION-BODY-SENTINEL",
      ].join("\n"),
    );
    await writeNote(
      workspace,
      "knowledge/references/nul.md",
      Buffer.from("# Unsafe\u0000note", "utf8"),
    );
    await writeNote(
      workspace,
      "knowledge/projects/future.md",
      currentNote({ id: "future-project", schemaVersion: 999 }),
    );
    await writeNote(
      workspace,
      "knowledge/references/bidi-\u202ename.md",
      "# Legacy path\n",
    );
    await writeNote(
      workspace,
      ".GIT/hidden.md",
      "# Must stay outside graph inventory\n",
    );
    const before = await markdownManifest(workspace);

    const firstRaw = run([
      "migrate",
      "--phase",
      "authority",
      "--dry-run",
      "--workspace",
      workspace,
      "--format",
      "json",
    ]).stdout;
    const secondRaw = run([
      "migrate",
      "--phase",
      "authority",
      "--dry-run",
      "--workspace",
      workspace,
      "--format",
      "json",
    ]).stdout;
    assert.equal(firstRaw, secondRaw);
    assert.ok(Buffer.byteLength(firstRaw, "utf8") <= AUTHORITY_INVENTORY_POLICY.maxReportBytes);

    const report = JSON.parse(firstRaw);
    assert.equal(report.ok, true);
    assert.equal(report.mode, "read-only-inventory");
    assert.equal(report.planner.selectionAuthority, "none");
    assert.equal(report.planner.validationSpecification, "syncora-validation-v1");
    assert.equal(report.planner.sourceMutation, "none");
    assert.equal(report.planner.approvedManifest, false);
    assert.equal(report.planner.manifestAcceptance, "unimplemented");
    assert.equal(report.planner.promotionOperations, 0);
    assert.deepEqual(
      {
        discovered: report.summary.discovered,
        currentSchema: report.summary.currentSchema,
        reviewRequired: report.summary.reviewRequired,
        blocked: report.summary.blocked,
      },
      { discovered: 5, currentSchema: 1, reviewRequired: 1, blocked: 3 },
    );
    assert.equal(report.summary.promotionReady, false);
    assert.equal(report.page.complete, true);
    assert.equal(report.page.endReached, true);
    assert.deepEqual(
      report.queue.map((entry) => entry.classification).sort(),
      ["blocked", "blocked", "blocked", "current-schema", "review-required"],
    );
    assert.ok(report.queue.every((entry) => /^sha256:[a-f0-9]{64}$/.test(entry.source.sha256)));
    assert.ok(report.queue.every(
      (entry) => entry.reasonCodeCount === entry.reasonCodes.length + entry.omittedReasonCodes,
    ));
    assert.equal(firstRaw.includes("accepted-sentinel-status"), false);
    assert.equal(firstRaw.includes("canonical-title-sentinel"), false);
    assert.equal(firstRaw.includes("PROMPT-INJECTION-BODY-SENTINEL"), false);
    assert.equal(firstRaw.includes('"frontmatter"'), false);
    assert.equal(firstRaw.includes('"target"'), false);
    assert.equal(firstRaw.includes(".GIT/hidden.md"), false);
    assert.equal(firstRaw.includes("\u202e"), false);
    const bidi = report.queue.find((entry) => entry.source.path.includes("\u202e"));
    assert.equal(bidi.classification, "blocked");
    assert.ok(bidi.reasonCodes.includes("PATH003"));
    assert.deepEqual(await markdownManifest(workspace), before);
    await assert.rejects(access(join(workspace, ".syncora")));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("authority inventory pagination has no gaps and rejects tampered or stale cursors", async () => {
  const workspace = await temporaryWorkspace();
  try {
    for (let index = 204; index >= 0; index -= 1) {
      await writeNote(
        workspace,
        `knowledge/references/note-${String(index).padStart(3, "0")}.md`,
        `# Legacy ${index}\n`,
      );
    }

    const first = migrate(workspace, ["--limit", "100"]);
    const second = migrate(workspace, [
      "--limit",
      "100",
      "--cursor",
      first.page.nextCursor,
    ]);
    const third = migrate(workspace, [
      "--limit",
      "100",
      "--cursor",
      second.page.nextCursor,
    ]);
    assert.deepEqual(
      [first.page.returned, second.page.returned, third.page.returned],
      [100, 100, 5],
    );
    assert.deepEqual(
      [first.page.omittedBefore, second.page.omittedBefore, third.page.omittedBefore],
      [0, 100, 200],
    );
    assert.equal(third.page.nextCursor, null);
    assert.deepEqual(
      [first.page.complete, second.page.complete, third.page.complete],
      [false, false, false],
    );
    assert.deepEqual(
      [first.page.endReached, second.page.endReached, third.page.endReached],
      [false, false, true],
    );
    const paths = [...first.queue, ...second.queue, ...third.queue]
      .map((entry) => entry.source.path);
    assert.equal(paths.length, 205);
    assert.equal(new Set(paths).size, 205);
    assert.deepEqual(paths, [...paths].sort());

    const payload = JSON.parse(
      Buffer.from(first.page.nextCursor, "base64url").toString("utf8"),
    );
    payload.after = "knowledge/references/note-150.md";
    const tampered = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const rejectedTamper = run([
      "migrate", "--phase", "authority", "--dry-run", "--workspace", workspace,
      "--cursor", tampered, "--format", "json",
    ], 1);
    assert.equal(JSON.parse(rejectedTamper.stderr).error.code, "MIGRATE002");

    await writeNote(workspace, "knowledge/references/note-000.md", "# Changed\n");
    const rejectedStale = run([
      "migrate", "--phase", "authority", "--dry-run", "--workspace", workspace,
      "--cursor", first.page.nextCursor, "--format", "json",
    ], 1);
    assert.equal(JSON.parse(rejectedStale.stderr).error.code, "MIGRATE002");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("migrate exposes only the explicit authority dry-run phase", async () => {
  const workspace = await temporaryWorkspace();
  try {
    await writeNote(workspace, "index.md", "# Legacy\n");
    for (const args of [
      ["migrate", "--workspace", workspace, "--format", "json"],
      ["migrate", "--phase", "authority", "--workspace", workspace, "--format", "json"],
      ["migrate", "--phase", "context", "--dry-run", "--workspace", workspace, "--format", "json"],
    ]) {
      const rejected = run(args, 1);
      assert.equal(JSON.parse(rejected.stderr).error.code, "MIGRATE001");
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("authority inventory keeps external-root allowlisting exact and ephemeral", async () => {
  const workspace = await temporaryWorkspace();
  const external = await mkdtemp(join(tmpdir(), "syncora-migrate-external-"));
  const graphLink = join(workspace, "local");
  try {
    await writeFile(join(external, "index.md"), "# Legacy atlas\n", "utf8");
    await symlink(external, graphLink, process.platform === "win32" ? "junction" : "dir");
    const before = await readFile(join(external, "index.md"));

    const rejected = run([
      "migrate", "--phase", "authority", "--dry-run", "--workspace", workspace,
      "--format", "json",
    ], 1);
    assert.equal(JSON.parse(rejected.stderr).error.code, "WRITE002");

    const accepted = migrate(workspace, [
      "--allow-external-graph-root",
      external,
    ]);
    assert.equal(accepted.graph.external, true);
    assert.equal(accepted.summary.discovered, 1);
    assert.deepEqual(await readFile(join(external, "index.md")), before);
    await assert.rejects(access(join(workspace, ".syncora")));
  } finally {
    await rm(graphLink, { force: true }).catch(() => undefined);
    await rm(workspace, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

test("authority inventory fails closed when the graph changes before final publication", async () => {
  const workspace = await temporaryWorkspace();
  try {
    const note = await writeNote(workspace, "legacy.md", "# alpha\n");
    await assert.rejects(
      inventoryAuthority(
        {
          workspace,
          phase: "authority",
          dryRun: true,
          limit: 20,
          cursor: undefined,
          allowExternalGraphRoot: undefined,
        },
        {
          beforeFinalInspection: async () => {
            await writeFile(note, "# bravo\n");
          },
        },
      ),
      (error) => error?.code === "READ001",
    );
    await assert.rejects(access(join(workspace, ".syncora")));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("authority inventory byte truncation resumes without gaps", async () => {
  const workspace = await temporaryWorkspace();
  try {
    const directory = "d".repeat(180);
    for (let index = 0; index < 100; index += 1) {
      const filename = `${String(index).padStart(3, "0")}-${"x".repeat(210)}.md`;
      await writeNote(workspace, `${directory}/${filename}`, "# Legacy\n");
    }

    const paths = [];
    let cursor;
    let pages = 0;
    let sawByteTruncation = false;
    do {
      const args = [
        "migrate", "--phase", "authority", "--dry-run", "--workspace", workspace,
        "--limit", "100", "--format", "json",
      ];
      if (cursor) args.push("--cursor", cursor);
      const raw = run(args).stdout;
      assert.ok(Buffer.byteLength(raw, "utf8") <= AUTHORITY_INVENTORY_POLICY.maxReportBytes);
      const page = JSON.parse(raw);
      pages += 1;
      sawByteTruncation ||= page.page.truncatedByBytes;
      paths.push(...page.queue.map((entry) => entry.source.path));
      cursor = page.page.nextCursor;
    } while (cursor);

    assert.ok(pages > 1);
    assert.equal(sawByteTruncation, true);
    assert.equal(paths.length, 100);
    assert.equal(new Set(paths).size, 100);
    assert.deepEqual(paths, [...paths].sort());
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("ten-thousand-note authority inventory keeps the default response bounded", async () => {
  const workspace = await temporaryWorkspace();
  try {
    const directory = join(workspace, "local", "knowledge", "references");
    await mkdir(directory, { recursive: true });
    const total = 10_002;
    for (let offset = 0; offset < total; offset += 200) {
      const batch = [];
      for (let index = offset; index < Math.min(total, offset + 200); index += 1) {
        batch.push(
          writeFile(
            join(directory, `note-${String(index).padStart(5, "0")}.md`),
            `# Legacy ${index}\n`,
            "utf8",
          ),
        );
      }
      await Promise.all(batch);
    }

    const report = await inventoryAuthority({
      workspace,
      phase: "authority",
      dryRun: true,
      limit: 20,
      cursor: undefined,
      allowExternalGraphRoot: undefined,
    });
    assert.equal(report.summary.discovered, total);
    assert.equal(report.summary.reviewRequired, total);
    assert.equal(report.page.returned, 20);
    assert.equal(report.page.omittedAfter, total - 20);
    assert.ok(
      Buffer.byteLength(`${JSON.stringify(report, null, 2)}\n`, "utf8") <=
        AUTHORITY_INVENTORY_POLICY.maxReportBytes,
    );
    await assert.rejects(access(join(workspace, ".syncora")));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("reviewed manifest schema fixes snapshot bindings and many-to-one operation shape", async () => {
  const schemaPath = join(
    repositoryRoot,
    "skills",
    "syncora",
    "assets",
    "schemas",
    "authority-promotion-manifest-v1.schema.json",
  );
  const schema = JSON.parse(await readFile(schemaPath, "utf8"));
  assert.equal(schema.properties.status.const, "reviewed");
  assert.equal(
    schema.$defs.inventoryBinding.properties.inventorySpecification.const,
    "syncora-authority-inventory-v1",
  );
  assert.equal(
    schema.$defs.inventoryBinding.properties.validationSpecification.const,
    "syncora-validation-v1",
  );
  assert.equal(schema.$defs.operation.properties.sources.minItems, 1);
  assert.equal(schema.$defs.operation.properties.sources.maxItems, 256);
  assert.equal(schema.$defs.operation.properties.target.$ref, "#/$defs/target");
  assert.equal("body" in schema.$defs.target.properties, false);
  assert.equal("sourceRefs" in schema.$defs.target.properties, false);
  const pathBase = new RegExp(schema.$defs.portablePathBase.pattern);
  const sourceSuffix = new RegExp(
    schema.$defs.portableSourceMarkdownPath.allOf[1].pattern,
  );
  const targetSuffix = new RegExp(
    schema.$defs.portableTargetMarkdownPath.allOf[1].pattern,
  );
  const sourcePath = (path) => pathBase.test(path) && sourceSuffix.test(path);
  const targetPath = (path) => pathBase.test(path) && targetSuffix.test(path);
  assert.equal(sourcePath("knowledge/decisions/example.MD"), true);
  assert.equal(targetPath("knowledge/decisions/example.MD"), false);
  assert.equal(targetPath("knowledge/decisions/example.md"), true);
  for (const unsafe of [
    "/absolute.md",
    "C:/drive.md",
    "../escape.md",
    "knowledge/./dot.md",
    "knowledge//double.md",
    "knowledge/CON.md",
    "knowledge/trailing /note.md",
    "knowledge/back\\slash.md",
    "knowledge/bidi-\u202ename.md",
    "knowledge/line-\u2029name.md",
    ".git/config.md",
    ".syncora/cache.md",
    ".obsidian/config.md",
    "node_modules/pkg.md",
    ".claude/worktrees/a.md",
  ]) {
    assert.equal(sourcePath(unsafe), false, unsafe);
    assert.equal(targetPath(unsafe), false, unsafe);
  }

  function assertUniqueRequired(value, path = "schema") {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value.required)) {
      assert.equal(
        new Set(value.required).size,
        value.required.length,
        `${path}.required`,
      );
    }
    for (const [key, child] of Object.entries(value)) {
      assertUniqueRequired(child, `${path}.${key}`);
    }
  }
  assertUniqueRequired(schema);

  assert.equal(
    isNonPortableGraphPath("knowledge/decisions/example.md", VALIDATION_POLICY),
    false,
  );
  assert.equal(
    isNonPortableGraphPath(`${"a/".repeat(2050)}note.md`, VALIDATION_POLICY),
    true,
  );
  assert.equal(
    isNonPortableGraphPath(`${"x".repeat(241)}.md`, VALIDATION_POLICY),
    true,
  );
  assert.equal(
    isNonPortableGraphPath(`${"é".repeat(121)}.md`, VALIDATION_POLICY),
    true,
  );
});
