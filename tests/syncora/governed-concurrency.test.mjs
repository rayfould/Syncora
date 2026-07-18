import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  copyFile,
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
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { taggedContentSha256 } from "../../skills/syncora/scripts/lib/proposal-schema.mjs";

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
const TARGET_NOTE = "knowledge/projects/workspace.md";

function syncResult(args, expectedStatus = 0) {
  const result = spawnSync(process.execPath, [cli, ...args, "--format", "json"], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(
    result.status,
    expectedStatus,
    `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return {
    status: result.status,
    output: JSON.parse(expectedStatus === 0 ? result.stdout : result.stderr),
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function asyncResult(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args, "--format", "json"], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 4 * 1024 * 1024) child.kill();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > 4 * 1024 * 1024) child.kill();
    });
    child.once("error", reject);
    child.once("close", (status, signal) => {
      try {
        assert.equal(signal, null, `CLI child terminated by ${signal}`);
        const source = status === 0 ? stdout : stderr;
        resolve({ status, output: JSON.parse(source), stdout, stderr });
      } catch (error) {
        reject(new Error(
          `Unable to parse concurrent CLI result (${status}).\nstdout:\n${stdout}\nstderr:\n${stderr}`,
          { cause: error },
        ));
      }
    });
  });
}

async function temporaryDirectory(prefix) {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

async function linkGraph(workspace, graph) {
  await symlink(
    graph,
    join(workspace, "local"),
    process.platform === "win32" ? "junction" : "dir",
  );
}

function externalOptions(workspace, graph) {
  return [
    "--workspace",
    workspace,
    "--allow-external-graph-root",
    graph,
  ];
}

async function externalFixture({ secondWorkspace = false } = {}) {
  const graph = await temporaryDirectory("syncora-governed-shared-graph-");
  const workspaceA = await temporaryDirectory("syncora-governed-workspace-a-");
  await linkGraph(workspaceA, graph);
  syncResult([
    "setup",
    ...externalOptions(workspaceA, graph),
    "--no-patch-agents",
  ]);

  let workspaceB = null;
  if (secondWorkspace) {
    workspaceB = await temporaryDirectory("syncora-governed-workspace-b-");
    await linkGraph(workspaceB, graph);
    await mkdir(join(workspaceB, ".syncora"));
    await copyFile(
      join(workspaceA, ".syncora", "config.json"),
      join(workspaceB, ".syncora", "config.json"),
    );
    await writeFile(
      join(workspaceB, ".syncora", "local.json"),
      `${JSON.stringify({ schemaVersion: 1, externalGraphRoots: [graph] }, null, 2)}\n`,
      "utf8",
    );
    syncResult([
      "setup",
      ...externalOptions(workspaceB, graph),
      "--no-patch-agents",
    ]);
  }

  return { graph, workspaceA, workspaceB };
}

async function cleanupFixture(fixture) {
  for (const workspace of [fixture.workspaceA, fixture.workspaceB]) {
    if (!workspace) continue;
    await rm(join(workspace, "local"), { recursive: true, force: true })
      .catch(() => undefined);
    await rm(workspace, { recursive: true, force: true });
  }
  await rm(fixture.graph, { recursive: true, force: true });
}

function conceptNote(id, body) {
  return [
    "---",
    `id: ${id}`,
    "kind: concept",
    "scope: workspace",
    "state: active",
    "authority: canonical",
    "schema_version: 1",
    "created: 2026-07-17",
    "updated: 2026-07-17",
    `summary: ${JSON.stringify(`Concurrency fixture for ${id}.`)}`,
    "---",
    "",
    `# ${id}`,
    "",
    body,
    "",
  ].join("\n");
}

function createInput({ key, suffix, body = `Durable content for ${suffix}.` }) {
  const path = `knowledge/concepts/${suffix}.md`;
  return {
    path,
    afterText: conceptNote(`concept-${suffix}`, body),
    input: {
      schemaVersion: 1,
      kind: "syncora.proposal-input",
      idempotencyKey: key,
      origin: "capture",
      actor: {
        type: "agent",
        id: "governed-concurrency-test",
        runtime: process.version,
      },
      reason: `Exercise governed concurrency for ${suffix}.`,
      correctsProposalId: null,
      operations: [{
        operationId: `create-${suffix}`,
        kind: "note.create",
        sourceRefs: [{
          type: "user",
          ref: `current-task:${suffix}`,
          expectedSha256: null,
        }],
        changes: [{
          path,
          expectedPriorSha256: null,
          afterText: conceptNote(`concept-${suffix}`, body),
        }],
      }],
    },
  };
}

function updateInput({ key, before, after, suffix }) {
  return {
    path: TARGET_NOTE,
    afterText: after,
    input: {
      schemaVersion: 1,
      kind: "syncora.proposal-input",
      idempotencyKey: key,
      origin: "capture",
      actor: {
        type: "agent",
        id: "governed-concurrency-test",
        runtime: process.version,
      },
      reason: `Exercise external governed update ${suffix}.`,
      correctsProposalId: null,
      operations: [{
        operationId: `update-${suffix}`,
        kind: "hub.refresh",
        sourceRefs: [{
          type: "user",
          ref: `current-task:${suffix}`,
          expectedSha256: null,
        }],
        changes: [{
          path: TARGET_NOTE,
          expectedPriorSha256: taggedContentSha256(before),
          afterText: after,
        }],
      }],
    },
  };
}

async function writeInput(workspace, name, input) {
  const path = join(workspace, `${name}.json`);
  await writeFile(path, `${JSON.stringify(input, null, 2)}\n`, "utf8");
  return path;
}

function captureArgs(workspace, graph, inputPath) {
  return ["capture", ...externalOptions(workspace, graph), "--input", inputPath];
}

function reviewArgs(workspace, graph, proposal, decision, suffix = decision) {
  return [
    "review",
    ...externalOptions(workspace, graph),
    "--proposal",
    proposal.id,
    "--proposal-digest",
    proposal.digest,
    "--decision",
    decision,
    "--reviewed-by",
    `workspace-owner-${suffix}`,
    "--reason",
    `${decision} after inspecting the exact immutable review artifact for ${suffix}.`,
  ];
}

function applyArgs(workspace, graph, proposal) {
  return [
    "apply",
    ...externalOptions(workspace, graph),
    "--proposal",
    proposal.id,
  ];
}

function inspectProposal(workspace, graph, proposal) {
  return syncResult([
    "propose",
    ...externalOptions(workspace, graph),
    "--proposal",
    proposal.id,
  ]).output;
}

async function capture(workspace, graph, inputPath) {
  return syncResult(captureArgs(workspace, graph, inputPath)).output.proposal;
}

async function approve(workspace, graph, proposal) {
  return syncResult(reviewArgs(workspace, graph, proposal, "approve")).output;
}

async function filesystemSnapshot(root) {
  const entries = [];
  async function visit(path) {
    const metadata = await lstat(path);
    const portable = relative(root, path).replaceAll("\\", "/") || ".";
    if (metadata.isDirectory()) {
      entries.push({ path: portable, type: "directory" });
      const children = await readdir(path);
      for (const child of children.sort()) await visit(join(path, child));
      return;
    }
    assert.equal(metadata.isFile(), true, `Unexpected graph entry type: ${portable}`);
    const bytes = await readFile(path);
    entries.push({
      path: portable,
      type: "file",
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  await visit(root);
  return entries;
}

async function proposalFiles(graph) {
  const root = join(graph, ".syncora", "proposals");
  const files = await readdir(root).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  return files.filter((name) => /^proposal_[a-f0-9]{64}\.json$/u.test(name)).sort();
}

function isBoundedLockContention(result) {
  return (
    result.status !== 0 &&
    result.output.error.code === "PATCH005" &&
    /timed out (?:after \d+ms )?waiting for (?:the )?(?:workspace )?patch(?:-lock)?(?: recovery guard)?/iu
      .test(result.output.error.message)
  );
}

async function settleConcurrentCaptureAttempts(argsList, initialResults) {
  const settled = [];
  for (let index = 0; index < initialResults.length; index += 1) {
    const result = initialResults[index];
    settled.push(
      isBoundedLockContention(result)
        ? await asyncResult(argsList[index])
        : result,
    );
  }
  return settled;
}

async function settleConcurrentApply({ workspace, graph, proposal, result }) {
  if (result.status === 0) return result;
  assert.ok(
    new Set(["WRITE007", "WRITE009"]).has(result.output.error.code) ||
      isBoundedLockContention(result),
    result.stderr,
  );
  return asyncResult(applyArgs(workspace, graph, proposal));
}

test("the full governed lifecycle works through an exact external graph allowlist", async () => {
  const fixture = await externalFixture();
  const target = join(fixture.graph, ...TARGET_NOTE.split("/"));
  try {
    const before = await readFile(target, "utf8");
    const after = before.replace(
      "- Syncora initialized. Replace this bootstrap statement with verified state.",
      "- The exact external graph allowlist governed this durable update.",
    );
    assert.notEqual(after, before);
    const drafted = updateInput({
      key: "external-full-lifecycle",
      before,
      after,
      suffix: "external-full-lifecycle",
    });
    const inputPath = await writeInput(fixture.workspaceA, "external-full", drafted.input);
    const proposal = await capture(fixture.workspaceA, fixture.graph, inputPath);
    await approve(fixture.workspaceA, fixture.graph, proposal);
    const applied = syncResult(
      applyArgs(fixture.workspaceA, fixture.graph, proposal),
    ).output;

    assert.equal(applied.state, "applied");
    assert.equal(applied.summary.changed, 1);
    assert.equal(await readFile(target, "utf8"), after);
    const inspected = inspectProposal(fixture.workspaceA, fixture.graph, proposal);
    assert.equal(inspected.proposal.state, "applied");
    assert.equal(inspected.receipts.length, 1);
    assert.equal(inspected.receipts[0].outcome, "applied");
  } finally {
    await cleanupFixture(fixture);
  }
});

test("missing or wrong external allowlists fail before any graph mutation", async () => {
  const fixture = await externalFixture();
  const wrongRoot = await temporaryDirectory("syncora-governed-wrong-root-");
  try {
    const drafted = createInput({
      key: "external-allowlist-rejected",
      suffix: "external-allowlist-rejected",
    });
    const inputPath = await writeInput(fixture.workspaceA, "allowlist-rejected", drafted.input);
    await rm(join(fixture.workspaceA, ".syncora", "local.json"));
    const before = await filesystemSnapshot(fixture.graph);

    for (const extra of [[], ["--allow-external-graph-root", wrongRoot]]) {
      const rejected = syncResult([
        "capture",
        "--workspace",
        fixture.workspaceA,
        ...extra,
        "--input",
        inputPath,
      ], 1);
      assert.equal(rejected.output.error.code, "WRITE002");
      assert.deepEqual(await filesystemSnapshot(fixture.graph), before);
    }
  } finally {
    await rm(wrongRoot, { recursive: true, force: true });
    await cleanupFixture(fixture);
  }
});

test("a proposal bound to workspace A cannot be reviewed or applied through workspace B", async () => {
  const fixture = await externalFixture({ secondWorkspace: true });
  try {
    const drafted = createInput({
      key: "cross-workspace-isolation",
      suffix: "cross-workspace-isolation",
    });
    const inputPath = await writeInput(fixture.workspaceA, "cross-workspace", drafted.input);
    const proposal = await capture(fixture.workspaceA, fixture.graph, inputPath);

    const review = syncResult(
      reviewArgs(fixture.workspaceB, fixture.graph, proposal, "approve", "workspace-b"),
      1,
    );
    assert.equal(review.output.error.code, "REVIEW001");
    const apply = syncResult(
      applyArgs(fixture.workspaceB, fixture.graph, proposal),
      1,
    );
    assert.equal(apply.output.error.code, "PROPOSAL002");

    const inspected = inspectProposal(fixture.workspaceA, fixture.graph, proposal);
    assert.equal(inspected.proposal.state, "proposed");
    assert.equal(inspected.reviews.length, 0);
    await assert.rejects(readFile(join(fixture.graph, ...drafted.path.split("/"))));
  } finally {
    await cleanupFixture(fixture);
  }
});

test("two workspaces sharing one external graph serialize canonical applies", async () => {
  const fixture = await externalFixture({ secondWorkspace: true });
  try {
    const draftedA = createInput({
      key: "shared-graph-workspace-a",
      suffix: "shared-graph-workspace-a",
    });
    const draftedB = createInput({
      key: "shared-graph-workspace-b",
      suffix: "shared-graph-workspace-b",
    });
    const [inputA, inputB] = await Promise.all([
      writeInput(fixture.workspaceA, "shared-a", draftedA.input),
      writeInput(fixture.workspaceB, "shared-b", draftedB.input),
    ]);
    const proposalA = await capture(fixture.workspaceA, fixture.graph, inputA);
    const proposalB = await capture(fixture.workspaceB, fixture.graph, inputB);
    await approve(fixture.workspaceA, fixture.graph, proposalA);
    await approve(fixture.workspaceB, fixture.graph, proposalB);

    const firstRound = await Promise.all([
      asyncResult(applyArgs(fixture.workspaceA, fixture.graph, proposalA)),
      asyncResult(applyArgs(fixture.workspaceB, fixture.graph, proposalB)),
    ]);
    assert.equal(firstRound.filter((result) => result.status === 0).length, 1);
    const loserIndex = firstRound.findIndex((result) => result.status !== 0);
    const loser = loserIndex === 0
      ? { workspace: fixture.workspaceA, proposal: proposalA, drafted: draftedA }
      : { workspace: fixture.workspaceB, proposal: proposalB, drafted: draftedB };
    let loserResult = firstRound[loserIndex];
    if (loserResult.output.error.code === "WRITE007") {
      loserResult = await asyncResult(applyArgs(loser.workspace, fixture.graph, loser.proposal));
    }
    assert.equal(loserResult.status, 1);
    assert.equal(loserResult.output.error.code, "WRITE001");

    const existing = await Promise.all([
      readFile(join(fixture.graph, ...draftedA.path.split("/")), "utf8").catch(() => null),
      readFile(join(fixture.graph, ...draftedB.path.split("/")), "utf8").catch(() => null),
    ]);
    assert.equal(existing.filter((value) => value !== null).length, 1);
    assert.equal(
      inspectProposal(loser.workspace, fixture.graph, loser.proposal).proposal.state,
      "conflicted",
    );
  } finally {
    await cleanupFixture(fixture);
  }
});

test("concurrent identical captures converge on one immutable proposal", async () => {
  const fixture = await externalFixture();
  try {
    const drafted = createInput({
      key: "concurrent-identical-capture",
      suffix: "concurrent-identical-capture",
    });
    const inputPath = await writeInput(fixture.workspaceA, "identical", drafted.input);
    const argsList = Array.from({ length: 8 }, () =>
      captureArgs(fixture.workspaceA, fixture.graph, inputPath));
    const initialResults = await Promise.all(
      argsList.map((args) => asyncResult(args)),
    );
    const results = await settleConcurrentCaptureAttempts(
      argsList,
      initialResults,
    );
    assert.equal(
      results.every((result) => result.status === 0),
      true,
      JSON.stringify(results.filter((result) => result.status !== 0), null, 2),
    );
    assert.equal(new Set(results.map((result) => result.output.proposal.id)).size, 1);
    assert.equal(new Set(results.map((result) => result.output.proposal.digest)).size, 1);
    assert.equal(results.filter((result) => result.output.idempotent === false).length, 1);
    assert.equal((await proposalFiles(fixture.graph)).length, 1);
  } finally {
    await cleanupFixture(fixture);
  }
});

test("one intent wins when concurrent captures reuse an idempotency key", async () => {
  const fixture = await externalFixture();
  try {
    const first = createInput({
      key: "concurrent-idempotency-collision",
      suffix: "idempotency-intent-first",
    });
    const second = createInput({
      key: "concurrent-idempotency-collision",
      suffix: "idempotency-intent-second",
    });
    const [firstInput, secondInput] = await Promise.all([
      writeInput(fixture.workspaceA, "idempotency-first", first.input),
      writeInput(fixture.workspaceA, "idempotency-second", second.input),
    ]);
    const argsList = Array.from({ length: 8 }, (_, index) =>
      captureArgs(
          fixture.workspaceA,
          fixture.graph,
          index % 2 === 0 ? firstInput : secondInput,
        ));
    const initialResults = await Promise.all(
      argsList.map((args) => asyncResult(args)),
    );
    const results = await settleConcurrentCaptureAttempts(
      argsList,
      initialResults,
    );
    const successes = results.filter((result) => result.status === 0);
    const failures = results.filter((result) => result.status !== 0);
    assert.ok(successes.length > 0);
    assert.ok(failures.length > 0);
    assert.equal(new Set(successes.map((result) => result.output.proposal.id)).size, 1);
    assert.equal(
      failures.every((result) => result.output.error.code === "PROPOSAL002"),
      true,
    );
    assert.equal((await proposalFiles(fixture.graph)).length, 1);
  } finally {
    await cleanupFixture(fixture);
  }
});

test("concurrent approve and reject attempts persist exactly one terminal disposition", async () => {
  const fixture = await externalFixture();
  try {
    const drafted = createInput({
      key: "concurrent-review-disposition",
      suffix: "concurrent-review-disposition",
    });
    const inputPath = await writeInput(fixture.workspaceA, "review-race", drafted.input);
    const proposal = await capture(fixture.workspaceA, fixture.graph, inputPath);
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) => {
        const decision = index % 2 === 0 ? "approve" : "reject";
        return asyncResult(reviewArgs(
          fixture.workspaceA,
          fixture.graph,
          proposal,
          decision,
          `race-${decision}`,
        ));
      }),
    );
    const successes = results.filter((result) => result.status === 0);
    const failures = results.filter((result) => result.status !== 0);
    assert.ok(successes.length > 0);
    assert.equal(new Set(successes.map((result) => result.output.decision)).size, 1);
    assert.equal(
      failures.every((result) => result.output.error.code === "REVIEW001"),
      true,
    );
    const inspected = inspectProposal(fixture.workspaceA, fixture.graph, proposal);
    assert.equal(inspected.reviews.length, 1);
    assert.equal(inspected.reviews[0].decision, successes[0].output.decision);
  } finally {
    await cleanupFixture(fixture);
  }
});

test("many concurrent applies converge on one mutation and one applied receipt", async () => {
  const fixture = await externalFixture();
  try {
    const drafted = createInput({
      key: "concurrent-many-apply",
      suffix: "concurrent-many-apply",
    });
    const inputPath = await writeInput(fixture.workspaceA, "many-apply", drafted.input);
    const proposal = await capture(fixture.workspaceA, fixture.graph, inputPath);
    await approve(fixture.workspaceA, fixture.graph, proposal);

    const firstRound = await Promise.all(
      Array.from({ length: 10 }, () =>
        asyncResult(applyArgs(fixture.workspaceA, fixture.graph, proposal))),
    );
    const settled = [];
    for (const result of firstRound) {
      settled.push(await settleConcurrentApply({
        workspace: fixture.workspaceA,
        graph: fixture.graph,
        proposal,
        result,
      }));
    }
    assert.equal(settled.every((result) => result.status === 0), true);
    assert.equal(
      settled.reduce((total, result) => total + result.output.summary.changed, 0),
      1,
    );
    assert.equal(
      await readFile(join(fixture.graph, ...drafted.path.split("/")), "utf8"),
      drafted.afterText,
    );
    const inspected = inspectProposal(fixture.workspaceA, fixture.graph, proposal);
    assert.equal(inspected.proposal.state, "applied");
    assert.equal(inspected.receipts.length, 1);
    assert.equal(inspected.receipts[0].outcome, "applied");
  } finally {
    await cleanupFixture(fixture);
  }
});

test("disjoint proposals from one baseline yield one apply and one durable conflict", async () => {
  const fixture = await externalFixture();
  try {
    const first = createInput({
      key: "disjoint-baseline-first",
      suffix: "disjoint-baseline-first",
    });
    const second = createInput({
      key: "disjoint-baseline-second",
      suffix: "disjoint-baseline-second",
    });
    const [firstInput, secondInput] = await Promise.all([
      writeInput(fixture.workspaceA, "disjoint-first", first.input),
      writeInput(fixture.workspaceA, "disjoint-second", second.input),
    ]);
    const firstProposal = await capture(fixture.workspaceA, fixture.graph, firstInput);
    const secondProposal = await capture(fixture.workspaceA, fixture.graph, secondInput);
    await approve(fixture.workspaceA, fixture.graph, firstProposal);
    await approve(fixture.workspaceA, fixture.graph, secondProposal);

    const proposals = [firstProposal, secondProposal];
    const drafted = [first, second];
    const firstRound = await Promise.all(
      proposals.map((proposal) =>
        asyncResult(applyArgs(fixture.workspaceA, fixture.graph, proposal))),
    );
    assert.equal(firstRound.filter((result) => result.status === 0).length, 1);
    const loserIndex = firstRound.findIndex((result) => result.status !== 0);
    let loserResult = firstRound[loserIndex];
    if (loserResult.output.error.code === "WRITE007") {
      loserResult = await asyncResult(
        applyArgs(fixture.workspaceA, fixture.graph, proposals[loserIndex]),
      );
    }
    assert.equal(loserResult.status, 1);
    assert.equal(loserResult.output.error.code, "WRITE001");

    const existing = await Promise.all(
      drafted.map((item) =>
        readFile(join(fixture.graph, ...item.path.split("/")), "utf8").catch(() => null)),
    );
    assert.equal(existing.filter((value) => value !== null).length, 1);
    const inspectedLoser = inspectProposal(
      fixture.workspaceA,
      fixture.graph,
      proposals[loserIndex],
    );
    assert.equal(inspectedLoser.proposal.state, "conflicted");
    assert.equal(inspectedLoser.conflicts.length, 1);
  } finally {
    await cleanupFixture(fixture);
  }
});
