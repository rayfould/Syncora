import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  truncate,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildLexicalIndex,
  estimateLexicalCacheBytes,
  LEXICAL_POLICY,
  searchLexicalIndex,
} from "../../skills/syncora/scripts/lib/lexical-index.mjs";
import { lexicalRootIdentity } from "../../skills/syncora/scripts/lib/lexical-cache.mjs";
import { searchWorkspace } from "../../skills/syncora/scripts/lib/search.mjs";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const cli = join(testDirectory, "..", "..", "skills", "syncora", "scripts", "syncora.mjs");

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
  return mkdtemp(join(tmpdir(), "syncora-search-"));
}

function currentNote({
  id,
  kind = "concept",
  authority = "canonical",
  state = "active",
  body = "",
  summary = `Summary for ${id}`,
  schemaVersion = 1,
}) {
  return `---
id: ${id}
kind: ${kind}
scope: workspace
state: ${state}
authority: ${authority}
schema_version: ${schemaVersion}
created: 2026-07-15
updated: 2026-07-15
summary: ${JSON.stringify(summary)}
---

# ${id}

${body}
`;
}

async function writeNote(workspace, path, content) {
  const destination = join(workspace, "local", ...path.split("/"));
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, content, "utf8");
  return destination;
}

async function markdownManifest(root) {
  const manifest = [];
  async function walk(path) {
    const entries = await readdir(path, { withFileTypes: true });
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        const bytes = await readFile(full);
        manifest.push({
          path: relative(root, full).replaceAll("\\", "/"),
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
      }
    }
  }
  await walk(root);
  return manifest;
}

function search(workspace, query, extra = []) {
  return JSON.parse(
    run([
      "search",
      "--workspace",
      workspace,
      "--query",
      query,
      "--format",
      "json",
      ...extra,
    ]).stdout,
  );
}

function searchOptions(workspace, query, overrides = {}) {
  return {
    workspace,
    query,
    limit: 10,
    includeHistory: false,
    noCache: false,
    allowExternalGraphRoot: undefined,
    ...overrides,
  };
}

test("search incrementally rebuilds a zero-authority cache without mutating Markdown", async () => {
  const workspace = await temporaryWorkspace();
  try {
    run(["init", "--workspace", workspace, "--no-patch-agents"]);
    const conceptPath = await writeNote(
      workspace,
      "knowledge/concepts/quasar.md",
      currentNote({ id: "concept-quasar", body: "A quasar guides the current runtime." }),
    );
    await writeNote(
      workspace,
      "knowledge/sessions/history.md",
      currentNote({
        id: "session-history",
        kind: "session",
        authority: "historical",
        state: "complete",
        body: "quasar ".repeat(100),
      }),
    );
    const legacyPath = await writeNote(
      workspace,
      "knowledge/references/legacy.md",
      `# Legacy\n\n${"quasar ".repeat(200)}`,
    );
    await writeNote(
      workspace,
      "knowledge/references/future.md",
      currentNote({
        id: "future-reference",
        kind: "reference",
        authority: "supporting",
        body: "quasar future",
        schemaVersion: 999,
      }),
    );

    const before = await markdownManifest(join(workspace, "local"));
    const first = search(workspace, "quasar");
    assert.equal(first.cache.state, "rebuilt");
    assert.equal(first.cache.published, true);
    assert.equal(first.index.selectionAuthority, "none");
    assert.deepEqual(first.results.map((item) => item.path), ["knowledge/concepts/quasar.md"]);
    assert.ok(first.results.every((item) => item.selectionAuthority === "none"));
    assert.deepEqual(await markdownManifest(join(workspace, "local")), before);

    const staleTemporary = join(
      dirname(first.cache.path),
      ".syncora-lexical-999-00000000-0000-4000-8000-000000000000.tmp",
    );
    await writeFile(staleTemporary, "stale", "utf8");
    const staleDate = new Date(Date.now() - LEXICAL_POLICY.staleTemporaryAgeMs - 1_000);
    await utimes(staleTemporary, staleDate, staleDate);
    const second = search(workspace, "quasar");
    assert.equal(second.cache.state, "hit");
    assert.equal(second.cache.rebuilt, 0);
    assert.equal(second.cache.reused, first.summary.indexed);
    assert.equal(second.index.revision, first.index.revision);
    assert.deepEqual(second.results, first.results);
    await assert.rejects(access(staleTemporary));

    const memory = search(workspace, "quasar", ["--no-cache"]);
    assert.equal(memory.cache.state, "memory");
    assert.equal(memory.index.revision, first.index.revision);
    assert.deepEqual(memory.results, first.results);

    const history = search(workspace, "quasar", ["--include-history"]);
    assert.ok(history.results.some((item) => item.path === "knowledge/sessions/history.md"));
    assert.ok(history.results.some((item) => item.path === "knowledge/references/legacy.md"));
    assert.ok(history.results.every((item) => item.authorityClass !== "quarantined"));

    const cacheEnvelope = JSON.parse(await readFile(first.cache.path, "utf8"));
    assert.ok(cacheEnvelope.documents.length >= 1);
    assert.equal("authorityClass" in cacheEnvelope.documents[0], false);
    assert.equal("body" in cacheEnvelope.documents[0], false);
    assert.equal("summary" in cacheEnvelope.documents[0], false);

    cacheEnvelope.documents[0].terms.push([
      "fabricated",
      LEXICAL_POLICY.maxTermWeight + 1,
    ]);
    cacheEnvelope.documents[0].terms.sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0
    );
    const { payloadSha256: ignoredChecksum, ...tamperedPayload } = cacheEnvelope;
    assert.equal(typeof ignoredChecksum, "string");
    cacheEnvelope.payloadSha256 = createHash("sha256")
      .update(JSON.stringify(tamperedPayload))
      .digest("hex");
    await writeFile(first.cache.path, `${JSON.stringify(cacheEnvelope)}\n`, "utf8");
    const boundedTamperRecovery = search(workspace, "quasar");
    assert.ok(boundedTamperRecovery.warnings.some((item) => item.code === "CACHE001"));
    assert.deepEqual(boundedTamperRecovery.results, first.results);

    const originalMetadata = await stat(conceptPath);
    const original = await readFile(conceptPath, "utf8");
    assert.equal(original.includes("quasar"), true);
    const changed = original.replace("A quasar", "A pulsar");
    assert.equal(Buffer.byteLength(changed), Buffer.byteLength(original));
    await writeFile(conceptPath, changed, "utf8");
    await utimes(conceptPath, originalMetadata.atime, originalMetadata.mtime);

    const changedSearch = search(workspace, "pulsar");
    assert.equal(changedSearch.cache.state, "incremental");
    assert.equal(changedSearch.cache.rebuilt, 1);
    assert.ok(changedSearch.cache.reused >= 1);
    assert.deepEqual(
      changedSearch.results.map((item) => item.path),
      ["knowledge/concepts/quasar.md"],
    );

    const touchedMetadata = await stat(conceptPath);
    await utimes(conceptPath, touchedMetadata.atime, new Date(touchedMetadata.mtimeMs + 5_000));
    const touched = search(workspace, "pulsar");
    assert.equal(touched.cache.state, "hit");
    assert.equal(touched.cache.rebuilt, 0);

    await unlink(legacyPath);
    const afterDelete = search(workspace, "pulsar", ["--include-history"]);
    assert.equal(afterDelete.cache.removed, 1);
    const afterDeleteMemory = search(
      workspace,
      "pulsar",
      ["--include-history", "--no-cache"],
    );
    assert.equal(afterDelete.index.revision, afterDeleteMemory.index.revision);
    assert.deepEqual(afterDelete.results, afterDeleteMemory.results);

    await truncate(afterDelete.cache.path, LEXICAL_POLICY.maxCacheBytes + 1);
    const oversizedRecovery = search(workspace, "pulsar", ["--include-history"]);
    assert.equal(oversizedRecovery.cache.state, "rebuilt");
    assert.ok(oversizedRecovery.warnings.some((item) => item.code === "CACHE001"));
    assert.deepEqual(oversizedRecovery.results, afterDeleteMemory.results);

    await writeFile(oversizedRecovery.cache.path, "{broken", "utf8");
    const rebuilt = search(workspace, "pulsar", ["--include-history"]);
    assert.equal(rebuilt.cache.state, "rebuilt");
    assert.ok(rebuilt.warnings.some((item) => item.code === "CACHE001"));
    assert.deepEqual(rebuilt.results, afterDeleteMemory.results);

    await rm(rebuilt.cache.path, { force: true });
    const afterCacheDelete = search(workspace, "pulsar", ["--include-history"]);
    assert.equal(afterCacheDelete.cache.state, "rebuilt");
    assert.equal(afterCacheDelete.index.revision, afterDeleteMemory.index.revision);
    assert.deepEqual(afterCacheDelete.results, afterDeleteMemory.results);

    const cacheFiles = await readdir(dirname(afterCacheDelete.cache.path));
    assert.ok(cacheFiles.includes(afterCacheDelete.cache.path.split(/[\\/]/).at(-1)));
    assert.ok(cacheFiles.every((path) => !path.endsWith(".tmp")));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("search refuses uninitialized workspaces without creating derived state", async () => {
  const workspace = await temporaryWorkspace();
  try {
    await writeNote(workspace, "index.md", "# Legacy\n");
    const result = run([
      "search",
      "--workspace",
      workspace,
      "--query",
      "legacy",
      "--format",
      "json",
    ], 1);
    assert.match(result.stderr, /CONFIG001/);
    await assert.rejects(access(join(workspace, ".syncora")));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("search query and result bounds fail explicitly", async () => {
  const workspace = await temporaryWorkspace();
  try {
    run(["init", "--workspace", workspace, "--no-patch-agents"]);
    const tooManyTerms = Array.from({ length: 33 }, (_, index) => `term${index}`).join(" ");
    const queryFailure = run([
      "search",
      "--workspace",
      workspace,
      "--query",
      tooManyTerms,
      "--format",
      "json",
    ], 1);
    assert.match(queryFailure.stderr, /SEARCH001/);

    const limitFailure = run([
      "search",
      "--workspace",
      workspace,
      "--query",
      "workspace",
      "--limit",
      "51",
      "--format",
      "json",
    ], 1);
    assert.match(limitFailure.stderr, /CLI004/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("default search cannot be exhausted by historical or transient bodies", async () => {
  const workspace = await temporaryWorkspace();
  try {
    run(["init", "--workspace", workspace, "--no-patch-agents"]);
    await writeNote(
      workspace,
      "knowledge/concepts/needle.md",
      currentNote({ id: "concept-needle", body: "needle remains current" }),
    );
    const historicalPath = await writeNote(
      workspace,
      "knowledge/sessions/oversized-history.md",
      currentNote({
        id: "session-oversized-history",
        kind: "session",
        authority: "historical",
        state: "complete",
        body: "x ".repeat(LEXICAL_POLICY.maxTokenOccurrencesPerNote + 1),
      }),
    );
    await writeNote(
      workspace,
      "knowledge/inbox/oversized-transient.md",
      currentNote({
        id: "inbox-oversized-transient",
        kind: "inbox",
        authority: "transient",
        body: "y ".repeat(LEXICAL_POLICY.maxTokenOccurrencesPerNote + 1),
      }),
    );

    const normal = search(workspace, "needle");
    assert.deepEqual(normal.results.map((item) => item.path), [
      "knowledge/concepts/needle.md",
    ]);
    const normalCache = JSON.parse(await readFile(normal.cache.path, "utf8"));
    assert.ok(normalCache.documents.every((document) =>
      !document.path.includes("oversized-history") &&
      !document.path.includes("oversized-transient")
    ));

    const explicitHistory = run([
      "search",
      "--workspace",
      workspace,
      "--query",
      "needle",
      "--include-history",
      "--format",
      "json",
    ], 1);
    assert.match(explicitHistory.stderr, /INDEX001/);

    await unlink(historicalPath);
    const withoutHistory = search(workspace, "needle", ["--include-history"]);
    assert.deepEqual(withoutHistory.results.map((item) => item.path), [
      "knowledge/concepts/needle.md",
    ]);
    const historyCache = JSON.parse(await readFile(withoutHistory.cache.path, "utf8"));
    assert.ok(historyCache.documents.every((document) =>
      !document.path.includes("oversized-transient")
    ));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("search rejects an equal-size restored-mtime edit before cache publication", async () => {
  const workspace = await temporaryWorkspace();
  try {
    run(["init", "--workspace", workspace, "--no-patch-agents"]);
    const notePath = await writeNote(
      workspace,
      "knowledge/concepts/snapshot.md",
      currentNote({ id: "concept-snapshot", body: "needle stable" }),
    );
    const original = await readFile(notePath, "utf8");
    const metadata = await stat(notePath);

    await assert.rejects(
      searchWorkspace(searchOptions(workspace, "needle"), {
        beforeFinalVerify: async () => {
          const changed = original.replace("stable", "mutate");
          assert.equal(Buffer.byteLength(changed), Buffer.byteLength(original));
          await writeFile(notePath, changed, "utf8");
          await utimes(notePath, metadata.atime, metadata.mtime);
        },
      }),
      (error) => error?.code === "READ001",
    );

    const cacheDirectory = join(workspace, ".syncora", "cache", "lexical-v1");
    const cacheFiles = await readdir(cacheDirectory);
    assert.ok(cacheFiles.every((path) => !path.endsWith(".json")));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("cache publication refuses a replaced cache directory", async (context) => {
  const workspace = await temporaryWorkspace();
  const outside = await mkdtemp(join(tmpdir(), "syncora-cache-outside-"));
  let cacheDirectory;
  let backupDirectory;
  let swapped = false;
  try {
    run(["init", "--workspace", workspace, "--no-patch-agents"]);
    const notePath = await writeNote(
      workspace,
      "knowledge/concepts/containment.md",
      currentNote({ id: "concept-containment", body: "needle alpha" }),
    );
    search(workspace, "needle");
    const original = await readFile(notePath, "utf8");
    await writeFile(notePath, original.replace("alpha", "omega"), "utf8");

    let swapSupported = true;
    const result = await searchWorkspace(searchOptions(workspace, "needle"), {
      beforeCachePublish: async (cacheContext) => {
        cacheDirectory = dirname(cacheContext.cacheFile);
        backupDirectory = `${cacheDirectory}-validated-backup`;
        await rename(cacheDirectory, backupDirectory);
        try {
          await symlink(
            outside,
            cacheDirectory,
            process.platform === "win32" ? "junction" : "dir",
          );
          swapped = true;
        } catch {
          swapSupported = false;
          await rename(backupDirectory, cacheDirectory);
          backupDirectory = undefined;
        }
      },
    });

    if (!swapSupported) {
      context.skip("Directory symlink or junction creation is unavailable.");
      return;
    }
    assert.equal(result.cache.published, false);
    assert.equal(result.cache.state, "memory");
    assert.ok(result.warnings.some((item) => item.code === "CACHE001"));
    assert.deepEqual(await readdir(outside), []);
  } finally {
    if (swapped && cacheDirectory) {
      await unlink(cacheDirectory).catch(() => undefined);
    }
    if (backupDirectory && cacheDirectory) {
      await rename(backupDirectory, cacheDirectory).catch(() => undefined);
    }
    await rm(outside, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("cache byte estimation is exact before whole-envelope serialization", async () => {
  const note = {
    path: "knowledge/concepts/unicode.md",
    rawSha256: "c".repeat(64),
    authorityClass: "canonical",
    title: "Unicode",
    frontmatter: { id: "concept-unicode", summary: "Résumé 東京" },
    lexicalSource: {
      path: "knowledge/concepts/unicode.md",
      id: "concept-unicode",
      title: "Unicode",
      summary: "Résumé 東京",
      body: "naïve café 東京",
    },
  };
  const built = await buildLexicalIndex({
    notes: [note],
    cachedPayload: null,
    graphRevision: `sha256:${"d".repeat(64)}`,
    rootIdentity: `sha256:${"e".repeat(64)}`,
  });
  const checksum = createHash("sha256")
    .update(JSON.stringify(built.payload))
    .digest("hex");
  const actual = Buffer.byteLength(`${JSON.stringify({
    ...built.payload,
    payloadSha256: checksum,
  })}\n`);
  assert.equal(estimateLexicalCacheBytes(built.payload), actual);
  assert.equal(built.stats.projectedBytes, actual);
});

test("graph-root cache identities follow platform case semantics", () => {
  const upper = join(tmpdir(), "SyncoraGraph");
  const lower = join(tmpdir(), "syncoragraph");
  if (process.platform === "win32") {
    assert.equal(lexicalRootIdentity(upper), lexicalRootIdentity(lower));
  } else {
    assert.notEqual(lexicalRootIdentity(upper), lexicalRootIdentity(lower));
  }
});

test("ten thousand excluded historical notes do not hydrate or tax default indexing", async () => {
  const canonical = {
    path: "knowledge/concepts/current.md",
    rawSha256: "f".repeat(64),
    authorityClass: "canonical",
    title: "Current",
    frontmatter: { id: "concept-current", summary: "Current" },
  };
  const historical = Array.from({ length: 10_000 }, (_, index) => ({
    path: `knowledge/sessions/history-${index.toString().padStart(5, "0")}.md`,
    rawSha256: index.toString(16).padStart(64, "0"),
    authorityClass: "historical",
    title: `History ${index}`,
    frontmatter: { id: `session-history-${index}`, summary: "History" },
  }));
  let loads = 0;
  const built = await buildLexicalIndex({
    notes: [canonical, ...historical],
    cachedPayload: null,
    graphRevision: `sha256:${"1".repeat(64)}`,
    rootIdentity: `sha256:${"2".repeat(64)}`,
    loadLexicalSource: async (note) => {
      loads += 1;
      assert.equal(note.path, canonical.path);
      return {
        ...note,
        lexicalSource: {
          path: note.path,
          id: note.frontmatter.id,
          title: note.title,
          summary: note.frontmatter.summary,
          body: "needle",
        },
      };
    },
  });
  assert.equal(loads, 1);
  assert.equal(built.payload.documents.length, 1);
  assert.equal(built.stats.postings < 100, true);
});

test("the lexical kernel cold-builds and fully reuses a ten-thousand-note corpus", async () => {
  const notes = Array.from({ length: 10_000 }, (_, index) => {
    const id = `concept-item-${index.toString().padStart(5, "0")}`;
    const path = `knowledge/concepts/${id}.md`;
    return {
      path,
      rawSha256: index.toString(16).padStart(64, "0"),
      authorityClass: "canonical",
      title: id,
      frontmatter: { id, summary: `Context record ${index}` },
    };
  });
  const graphRevision = `sha256:${"a".repeat(64)}`;
  const rootIdentity = `sha256:${"b".repeat(64)}`;
  const started = Date.now();
  let coldLoads = 0;
  const cold = await buildLexicalIndex({
    notes,
    cachedPayload: null,
    graphRevision,
    rootIdentity,
    loadLexicalSource: async (note) => {
      coldLoads += 1;
      return {
        ...note,
        lexicalSource: {
          path: note.path,
          id: note.frontmatter.id,
          title: note.title,
          summary: note.frontmatter.summary,
          body: `Stable context evidence item${Number(note.frontmatter.id.slice(-5))}`,
        },
      };
    },
  });
  assert.equal(cold.payload.documents.length, 10_000);
  assert.equal(cold.stats.rebuilt, 10_000);
  assert.equal(coldLoads, 10_000);
  assert.ok(cold.stats.projectedBytes < LEXICAL_POLICY.maxCacheBytes);
  assert.ok(Date.now() - started < 30_000);

  let warmLoads = 0;
  const warm = await buildLexicalIndex({
    notes,
    cachedPayload: cold.payload,
    graphRevision,
    rootIdentity,
    loadLexicalSource: async () => {
      warmLoads += 1;
      throw new Error("A warm cache hit must not hydrate source text.");
    },
  });
  assert.equal(warm.stats.reused, 10_000);
  assert.equal(warm.stats.rebuilt, 0);
  assert.equal(warmLoads, 0);
  assert.deepEqual(warm.payload, cold.payload);

  const result = searchLexicalIndex({
    payload: warm.payload,
    notes,
    query: "item9999",
    limit: 10,
    includeHistory: false,
  });
  assert.equal(result.matches, 1);
  assert.equal(result.results[0].path, "knowledge/concepts/concept-item-09999.md");

  const commonStarted = Date.now();
  const common = searchLexicalIndex({
    payload: warm.payload,
    notes,
    query: "context",
    limit: 10,
    includeHistory: false,
  });
  assert.equal(common.matches, 10_000);
  assert.equal(common.results.length, 10);
  assert.ok(Date.now() - commonStarted < 5_000);
});
