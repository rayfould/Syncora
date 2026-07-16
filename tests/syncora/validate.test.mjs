import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { VALIDATION_POLICY } from "../../skills/syncora/scripts/lib/validate.mjs";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const cli = join(
  testDirectory,
  "..",
  "..",
  "skills",
  "syncora",
  "scripts",
  "syncora.mjs",
);

function run(args, expectedStatus = 0) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
  assert.equal(
    result.status,
    expectedStatus,
    `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result;
}

async function temporaryWorkspace(prefix = "syncora-validate-") {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

function currentNote({
  id,
  kind,
  scope = "workspace",
  state = "active",
  authority = "canonical",
  title = id,
  decisionKey = undefined,
  supersedes = [],
  body = "",
  schemaVersion = 1,
}) {
  const decisionFields = decisionKey
    ? `decision_key: ${decisionKey}\nsupersedes:${supersedes.length === 0 ? " []" : `\n${supersedes.map((item) => `  - ${item}`).join("\n")}`}`
    : "";
  return `---
id: ${id}
kind: ${kind}
scope: ${scope}
state: ${state}
authority: ${authority}
schema_version: ${schemaVersion}
created: 2026-07-15
updated: 2026-07-15
summary: ${JSON.stringify(`Summary for ${id}`)}
${decisionFields}
---

# ${title}

${body}
`;
}

async function writeGraphNote(workspace, path, content) {
  const destination = join(workspace, "local", ...path.split("/"));
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, content);
  return destination;
}

async function fileManifest(root) {
  const result = [];
  async function walk(path) {
    const entries = await readdir(path, { withFileTypes: true });
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      const full = join(path, entry.name);
      const reportPath = relative(root, full).replaceAll("\\", "/");
      const metadata = await lstat(full);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        result.push({ path: reportPath, type: "directory", mode: metadata.mode, mtimeMs: metadata.mtimeMs });
        await walk(full);
      } else if (entry.isFile()) {
        const content = await readFile(full);
        result.push({
          path: reportPath,
          type: "file",
          mode: metadata.mode,
          mtimeMs: metadata.mtimeMs,
          size: content.length,
          sha256: createHash("sha256").update(content).digest("hex"),
        });
      } else {
        result.push({ path: reportPath, type: "link", mode: metadata.mode, mtimeMs: metadata.mtimeMs });
      }
    }
  }
  await walk(root);
  return result;
}

function hasCode(report, code) {
  return report.diagnostics.some((item) => item.code === code);
}

test("validate is deterministic, read-only, and accepts a native v1 atlas and hub", async () => {
  const workspace = await temporaryWorkspace();
  try {
    await writeGraphNote(
      workspace,
      "index.md",
      currentNote({ id: "atlas-root", kind: "atlas", title: "Atlas" }),
    );
    await writeGraphNote(
      workspace,
      "knowledge/projects/workspace.md",
      currentNote({ id: "project-workspace", kind: "project", title: "Workspace" }),
    );
    const before = await fileManifest(workspace);

    const first = run(["validate", "--workspace", workspace, "--format", "json"]);
    const second = run(["validate", "--workspace", workspace, "--format", "json"]);
    assert.equal(first.stdout, second.stdout);
    const report = JSON.parse(first.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.mode, "read-only");
    assert.equal(report.summary.schema.current, 2);
    assert.equal(report.summary.authority.routing, 1);
    assert.equal(report.summary.authority.canonical, 1);
    assert.equal(
      report.summary.files.discovered,
      report.summary.files.parsed + report.summary.files.quarantined,
    );
    assert.equal("notes" in report, false);
    assert.deepEqual(await fileManifest(workspace), before);
    await assert.rejects(access(join(workspace, ".syncora")));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("legacy accepted prose remains unpromoted and only warns", async () => {
  const workspace = await temporaryWorkspace();
  try {
    await writeGraphNote(
      workspace,
      "knowledge/decisions/legacy.md",
      "---\nid: legacy\ntype: decision\nstatus: accepted\ndecision_key: legacy.key\n---\n\n# Legacy\n",
    );
    const report = JSON.parse(
      run(["validate", "--workspace", workspace, "--format", "json"]).stdout,
    );
    assert.equal(report.ok, true);
    assert.equal(report.summary.schema.legacy, 1);
    assert.equal(report.summary.authority.unpromoted, 1);
    assert.equal(report.summary.authority.canonical, 0);
    assert.ok(hasCode(report, "SCHEMA002"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("invalid bytes, NULs, and malformed frontmatter quarantine per note while scanning continues", async () => {
  const workspace = await temporaryWorkspace();
  try {
    await writeGraphNote(workspace, "knowledge/concepts/invalid.md", Buffer.from([0xc0, 0xaf]));
    await writeGraphNote(
      workspace,
      "knowledge/concepts/nul.md",
      Buffer.from("---\nid: nul\n---\n\n# Nul\u0000tail", "utf8"),
    );
    await writeGraphNote(
      workspace,
      "knowledge/concepts/frontmatter.md",
      "---\nid: one\nid: two\n# missing close\n",
    );
    await writeGraphNote(workspace, "knowledge/concepts/legacy.md", "# Still scanned\n");

    const report = JSON.parse(
      run(["validate", "--workspace", workspace, "--format", "json"], 1).stdout,
    );
    assert.equal(report.summary.files.discovered, 4);
    assert.equal(report.summary.files.parsed, 1);
    assert.equal(report.summary.files.quarantined, 3);
    assert.equal(report.summary.authority.unpromoted, 1);
    assert.ok(hasCode(report, "ENC001"));
    assert.ok(hasCode(report, "ENC002"));
    assert.ok(hasCode(report, "FM001"));
    const nul = report.diagnostics.find((item) => item.code === "ENC002");
    assert.equal(typeof nul.location.byteOffset, "number");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("note byte and wiki-link fanout limits are exact and explicit", async () => {
  const workspace = await temporaryWorkspace();
  try {
    await writeGraphNote(
      workspace,
      "knowledge/references/at-limit.md",
      Buffer.alloc(VALIDATION_POLICY.maxNoteBytes, 0x61),
    );
    const oversizedWithNul = Buffer.alloc(VALIDATION_POLICY.maxNoteBytes + 1, 0x62);
    oversizedWithNul[oversizedWithNul.length - 1] = 0;
    await writeGraphNote(
      workspace,
      "knowledge/references/over-limit.md",
      oversizedWithNul,
    );
    const exactLinks = Array.from(
      { length: VALIDATION_POLICY.maxLinksPerNote },
      (_, index) => `[[knowledge/concepts/exact-${index}]]`,
    ).join("\n");
    const excessLinks = `${exactLinks}\n[[knowledge/concepts/excess]]`;
    await writeGraphNote(workspace, "knowledge/references/links-exact.md", exactLinks);
    await writeGraphNote(workspace, "knowledge/references/links-excess.md", excessLinks);

    const report = JSON.parse(
      run(["validate", "--workspace", workspace, "--format", "json"], 1).stdout,
    );
    const noteLimit = report.diagnostics.find((item) => item.code === "NOTE001");
    const linkLimit = report.diagnostics.find((item) => item.code === "LINK001");
    assert.equal(noteLimit.occurrences, 1);
    assert.equal(noteLimit.path, "knowledge/references/over-limit.md");
    assert.equal(linkLimit.occurrences, 1);
    assert.equal(linkLimit.path, "knowledge/references/links-excess.md");
    assert.ok(hasCode(report, "ENC002"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("external graph validation requires an exact ephemeral allowlist", async () => {
  const workspace = await temporaryWorkspace();
  const external = await temporaryWorkspace("syncora-external-graph-");
  const link = join(workspace, "local");
  try {
    await writeFile(join(external, "index.md"), "# Legacy atlas\n", "utf8");
    await symlink(external, link, process.platform === "win32" ? "junction" : "dir");
    const rejected = run(["validate", "--workspace", workspace, "--format", "json"], 1);
    assert.equal(rejected.stdout, "");
    assert.match(rejected.stderr, /WRITE002/);

    const accepted = JSON.parse(
      run([
        "validate",
        "--workspace",
        workspace,
        "--allow-external-graph-root",
        external,
        "--format",
        "json",
      ]).stdout,
    );
    assert.equal(accepted.graph.external, true);
    await assert.rejects(access(join(workspace, ".syncora")));
  } finally {
    await rm(link, { force: true }).catch(() => undefined);
    await rm(workspace, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

test("strict frontmatter rejects unsupported syntax while links in code and comments do not count", async () => {
  const workspace = await temporaryWorkspace();
  try {
    await writeGraphNote(
      workspace,
      "knowledge/concepts/nested.md",
      "---\nid: nested\nmetadata:\n  child: value\n---\n\n# Nested\n",
    );
    await writeGraphNote(
      workspace,
      "knowledge/concepts/duplicate-case.md",
      "---\nid: duplicate\nauthority: canonical\nAuthority: historical\n---\n\n# Duplicate\n",
    );
    const ignoredLinks = `\`\`\`md\n${"[[ignored]]\n".repeat(300)}\`\`\`\n<!-- ${"[[also-ignored]] ".repeat(300)} -->`;
    await writeGraphNote(
      workspace,
      "knowledge/projects/workspace.md",
      currentNote({ id: "project-workspace", kind: "project", body: ignoredLinks }),
    );
    const report = JSON.parse(
      run(["validate", "--workspace", workspace, "--format", "json"], 1).stdout,
    );
    assert.ok(hasCode(report, "FM002"));
    assert.ok(hasCode(report, "FM001"));
    assert.equal(hasCode(report, "LINK001"), false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("nested graph links are never followed and unsafe wiki targets quarantine their source", async () => {
  const workspace = await temporaryWorkspace();
  const outside = await temporaryWorkspace("syncora-outside-");
  const nestedLink = join(workspace, "local", "linked");
  try {
    await mkdir(join(workspace, "local"), { recursive: true });
    await writeFile(join(outside, "secret.md"), "# Must not be read\n", "utf8");
    await symlink(outside, nestedLink, process.platform === "win32" ? "junction" : "dir");
    await writeGraphNote(
      workspace,
      "knowledge/concepts/unsafe.md",
      "# Unsafe\n\n[[../../outside]]\n",
    );
    const report = JSON.parse(
      run(["validate", "--workspace", workspace, "--format", "json"], 1).stdout,
    );
    assert.equal(report.summary.files.discovered, 1);
    assert.ok(hasCode(report, "PATH002"));
    assert.ok(hasCode(report, "LINK002"));
  } finally {
    await rm(nestedLink, { recursive: true, force: true }).catch(() => undefined);
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test(
  "case and Unicode-normalization path collisions are explicit on portable filesystems",
  async (context) => {
    const workspace = await temporaryWorkspace();
    try {
      await writeGraphNote(workspace, "knowledge/concepts/Alpha.md", "# Alpha\n");
      await writeGraphNote(workspace, "knowledge/concepts/alpha.md", "# alpha\n");
      const entries = await readdir(join(workspace, "local", "knowledge", "concepts"));
      if (!entries.includes("Alpha.md") || !entries.includes("alpha.md")) {
        context.skip("filesystem does not preserve case-distinct file names");
        return;
      }
      const report = JSON.parse(
        run(["validate", "--workspace", workspace, "--format", "json"], 1).stdout,
      );
      const collision = report.diagnostics.find((item) => item.code === "PATH001");
      assert.equal(collision.occurrences, 2);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  },
);

test("native authority checks detect duplicate hubs, decisions, and supersession cycles", async () => {
  const workspace = await temporaryWorkspace();
  try {
    await writeGraphNote(
      workspace,
      "knowledge/projects/one.md",
      currentNote({ id: "project-one", kind: "project" }),
    );
    await writeGraphNote(
      workspace,
      "knowledge/projects/two.md",
      currentNote({ id: "project-two", kind: "project" }),
    );
    await writeGraphNote(
      workspace,
      "knowledge/decisions/one.md",
      currentNote({
        id: "decision-one",
        kind: "decision",
        state: "accepted",
        decisionKey: "shared.key",
        supersedes: ["decision-two"],
      }),
    );
    await writeGraphNote(
      workspace,
      "knowledge/decisions/two.md",
      currentNote({
        id: "decision-two",
        kind: "decision",
        state: "accepted",
        decisionKey: "shared.key",
        supersedes: ["decision-one"],
      }),
    );
    const report = JSON.parse(
      run(["validate", "--workspace", workspace, "--format", "json"], 1).stdout,
    );
    assert.ok(hasCode(report, "HUB001"));
    assert.ok(hasCode(report, "AUTH002"));
    assert.ok(hasCode(report, "AUTH003"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("future schemas remain read-only and excluded from authority", async () => {
  const workspace = await temporaryWorkspace();
  try {
    await writeGraphNote(
      workspace,
      "knowledge/projects/future.md",
      currentNote({ id: "future", kind: "project", schemaVersion: 999 }),
    );
    const report = JSON.parse(
      run(["validate", "--workspace", workspace, "--format", "json"], 1).stdout,
    );
    assert.equal(report.summary.schema.future, 1);
    assert.equal(report.summary.authority.canonical, 0);
    assert.equal(report.summary.authority.quarantined, 1);
    assert.ok(hasCode(report, "SCHEMA001"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
