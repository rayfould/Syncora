import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import {
  ERROR_OUTPUT_POLICY,
  GOVERNED_OUTPUT_POLICY,
  helpText,
  parseArgv,
  renderError,
  renderResult,
  SyncoraError,
} from "../../skills/syncora/scripts/lib/cli.mjs";

test("governed output compacts maximum-shape results without reporting post-write failure", () => {
  const longPath = `${"segment/".repeat(500)}note.md`;
  const result = {
    ok: true,
    command: "apply",
    workspace: "C:/workspace",
    graph: { root: "C:/workspace/local", revision: `sha256:${"a".repeat(64)}` },
    proposalId: `proposal_${"b".repeat(64)}`,
    proposalDigest: `sha256:${"c".repeat(64)}`,
    transactionId: `transaction_${"d".repeat(64)}`,
    receiptId: `receipt_${"e".repeat(64)}`,
    state: "applied",
    dryRun: false,
    idempotent: false,
    summary: { changed: 32, already: 0, total: 32 },
    changes: Array.from({ length: 32 }, (_, index) => ({
      action: "update",
      path: `${index}/${longPath}`,
    })),
    omittedChanges: 0,
  };

  const json = renderResult(result, "json");
  const parsed = JSON.parse(json);
  assert.ok([...json].length <= GOVERNED_OUTPUT_POLICY.maximumCharacters);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.state, "applied");
  assert.equal(parsed.receiptId, result.receiptId);
  assert.equal(parsed.output.truncated, true);
  assert.equal(parsed.omittedChanges, 32);

  const text = renderResult(result, "text");
  assert.ok([...text].length <= GOVERNED_OUTPUT_POLICY.maximumCharacters);
  assert.match(text, /Output: compacted/u);
  assert.match(text, /State: applied/u);
});

test("adopt accepts one content-addressed reviewed bundle", () => {
  const workspace = resolve("workspace");
  const bundle = resolve("review", "adoption-bundle-v1.json");
  const parsed = parseArgv([
    "adopt",
    "--workspace",
    workspace,
    "--bundle",
    bundle,
  ]);
  assert.equal(parsed.command, "adopt");
  assert.equal(parsed.options.bundle, bundle);
  assert.equal(parsed.options.migrationId, undefined);
  assert.equal(parsed.options.dryRun, false);
});

test("adopt rejects low-level artifacts and dry-run orchestration", () => {
  const workspace = resolve("workspace");
  const bundle = resolve("review", "adoption-bundle-v1.json");
  assert.throws(
    () => parseArgv([
      "adopt",
      "--workspace",
      workspace,
      "--bundle",
      bundle,
      "--manifest",
      resolve("manifest.json"),
    ]),
    (error) => error instanceof SyncoraError && error.code === "CLI005",
  );
  assert.throws(
    () => parseArgv([
      "adopt",
      "--workspace",
      workspace,
      "--bundle",
      bundle,
      "--dry-run",
    ]),
    (error) => error instanceof SyncoraError && error.code === "CLI005",
  );
});

test("bundle accepts the complete reviewed-pack input in one command", () => {
  const workspace = resolve("workspace");
  const review = resolve("review");
  const parsed = parseArgv([
    "bundle",
    "--workspace",
    workspace,
    "--migration-id",
    "legacy-adoption",
    "--manifest",
    resolve(review, "manifest.json"),
    "--staged-content",
    resolve(review, "staged-content"),
    "--fixtures",
    resolve(review, "fixtures.json"),
    "--output",
    resolve(review, "adoption-bundle-v1.json"),
    "--dry-run",
  ]);
  assert.equal(parsed.command, "bundle");
  assert.equal(parsed.options.migrationId, "legacy-adoption");
  assert.equal(parsed.options.dryRun, true);
  assert.equal(parsed.options.output, resolve(review, "adoption-bundle-v1.json"));
});

test("bundle requires every reviewed-pack input and owns --output", () => {
  const workspace = resolve("workspace");
  assert.throws(
    () => parseArgv(["bundle", "--workspace", workspace]),
    (error) =>
      error instanceof SyncoraError &&
      error.code === "CLI002" &&
      /--migration-id.*--output/u.test(error.message),
  );
  assert.throws(
    () => parseArgv([
      "setup",
      "--workspace",
      workspace,
      "--output",
      resolve("bundle.json"),
    ]),
    (error) => error instanceof SyncoraError && error.code === "CLI005",
  );
});

test("setup accepts reviewed predecessor confirmation while init remains a compatibility alias", () => {
  const workspace = resolve("workspace");
  const parsed = parseArgv([
    "setup",
    "--workspace",
    workspace,
    "--confirm-predecessor-reviewed",
  ]);
  assert.equal(parsed.options.confirmPredecessorReviewed, true);
  assert.throws(
    () => parseArgv([
      "init",
      "--workspace",
      workspace,
      "--confirm-predecessor-reviewed",
    ]),
    (error) => error instanceof SyncoraError && error.code === "CLI005",
  );
  assert.match(helpText(), /\n  init\s+Compatibility alias for setup/u);
  assert.match(helpText("setup"), /--confirm-predecessor-reviewed/u);
  const patch = parseArgv([
    "patch-agents",
    "--workspace",
    workspace,
    "--confirm-predecessor-reviewed",
  ]);
  assert.equal(patch.options.confirmPredecessorReviewed, true);
  assert.match(helpText("patch-agents"), /--confirm-predecessor-reviewed/u);
});

test("setup, bundle, and adopt are first-class help surfaces", () => {
  assert.match(helpText(), /\n  setup\s+Initialize a greenfield workspace/u);
  assert.match(helpText(), /\n  bundle\s+Build one reviewed legacy-adoption bundle/u);
  assert.match(helpText(), /\n  adopt\s+Apply one reviewed legacy-adoption bundle/u);
  assert.match(helpText("bundle"), /content-addressed descriptor consumed by syncora adopt/u);
  assert.match(helpText("adopt"), /stage, shadow, cutover, verify, and retire/u);
});

test("context exposes bounded repeatable task inputs without mutation flags", () => {
  const workspace = resolve("workspace");
  const parsed = parseArgv([
    "context",
    "--workspace",
    workspace,
    "--intent",
    "Implement authentication",
    "--scope",
    "auth",
    "--target",
    "file:src/auth.ts",
    "--target",
    "module:src",
    "--mode",
    "implement",
    "--budget",
    "lean",
    "--no-cache",
  ]);
  assert.equal(parsed.command, "context");
  assert.equal(parsed.options.intent, "Implement authentication");
  assert.equal(parsed.options.scope, "auth");
  assert.deepEqual(parsed.options.targets, ["file:src/auth.ts", "module:src"]);
  assert.equal(parsed.options.mode, "implement");
  assert.equal(parsed.options.budget, "lean");
  assert.equal(parsed.options.noCache, true);
  assert.match(helpText(), /\n  context\s+Compile bounded task-specific project context/u);
  assert.match(helpText("context"), /--max-characters <1000-64000>/u);

  assert.throws(
    () => parseArgv(["context", "--workspace", workspace]),
    (error) => error instanceof SyncoraError && error.code === "CLI002",
  );
  assert.throws(
    () => parseArgv([
      "context",
      "--workspace",
      workspace,
      "--intent",
      "Orient",
      "--budget",
      "lean",
      "--max-characters",
      "4000",
    ]),
    (error) => error instanceof SyncoraError && error.code === "CLI005",
  );
  assert.throws(
    () => parseArgv([
      "context",
      "--workspace",
      workspace,
      "--intent",
      "Orient",
      "--dry-run",
    ]),
    (error) => error instanceof SyncoraError && error.code === "CLI005",
  );
});

test("governed capture exposes a proposal, digest-bound review, and reviewed apply", () => {
  const workspace = resolve("workspace");
  const input = resolve("review", "capture-draft.json");
  const proposal = "prp_" + "a".repeat(64);
  const digest = "sha256:" + "b".repeat(64);

  const captured = parseArgv([
    "capture",
    "--workspace",
    workspace,
    "--input",
    input,
    "--dry-run",
  ]);
  assert.equal(captured.options.input, input);
  assert.equal(captured.options.dryRun, true);

  const inspected = parseArgv([
    "propose",
    "--workspace",
    workspace,
    "--proposal",
    proposal,
  ]);
  assert.equal(inspected.options.proposal, proposal);

  const reviewed = parseArgv([
    "review",
    "--workspace",
    workspace,
    "--proposal",
    proposal,
    "--proposal-digest",
    digest,
    "--decision",
    "approve",
    "--reviewed-by",
    "workspace-owner",
    "--reason",
    "Approved after inspecting the exact proposal summary.",
  ]);
  assert.equal(reviewed.options.proposalDigest, digest);
  assert.equal(reviewed.options.decision, "approve");

  const applied = parseArgv([
    "apply",
    "--workspace",
    workspace,
    "--proposal",
    proposal,
  ]);
  assert.equal(applied.options.proposal, proposal);

  assert.match(helpText(), /\n  capture\s+Prepare an immutable governed knowledge proposal/u);
  assert.match(helpText(), /\n  review\s+Approve or reject an exact proposal digest/u);
  assert.match(helpText("capture"), /Canonical Markdown remains byte-identical/u);
  assert.match(helpText("apply"), /process-interruption recovery/u);
});

test("governed CLI rejects ambiguous creation and unbound review", () => {
  const workspace = resolve("workspace");
  const input = resolve("draft.json");
  const proposal = "prp_" + "a".repeat(64);

  assert.throws(
    () => parseArgv([
      "propose",
      "--workspace",
      workspace,
      "--input",
      input,
      "--proposal",
      proposal,
    ]),
    (error) => error instanceof SyncoraError && error.code === "CLI002",
  );
  assert.throws(
    () => parseArgv([
      "review",
      "--workspace",
      workspace,
      "--proposal",
      proposal,
      "--proposal-digest",
      "sha256:not-a-digest",
      "--decision",
      "approve",
      "--reviewed-by",
      "owner",
      "--reason",
      "reviewed",
    ]),
    (error) => error instanceof SyncoraError && error.code === "CLI004",
  );
  assert.throws(
    () => parseArgv([
      "apply",
      "--workspace",
      workspace,
      "--proposal",
      proposal,
      "--reason",
      "bypass",
    ]),
    (error) => error instanceof SyncoraError && error.code === "CLI005",
  );
});

test("error rendering bounds hostile messages and nested details", () => {
  const hostile = "x".repeat(100_000);
  const hostileCode = `C\u001b\u202e${"C".repeat(100_000)}`;
  const error = new SyncoraError(
    hostileCode,
    `Unsupported target kind: ${hostile}`,
    {
      targetRef: hostile,
      scopes: Array.from({ length: 1_000 }, (_, index) => `${hostile}-${index}`),
    },
  );
  const rendered = renderError(error, "json");
  const parsed = JSON.parse(rendered);

  assert.ok([...rendered].length <= ERROR_OUTPUT_POLICY.maximumSerializedCharacters);
  assert.equal(parsed.error.codeTruncated, true);
  assert.ok([...parsed.error.code].length <= 128);
  assert.equal(parsed.error.messageTruncated, true);
  assert.equal(parsed.error.detailsTruncated, true);
  assert.equal(rendered.includes(hostile), false);
  const textRendered = renderError(error, "text");
  assert.equal(textRendered.includes("\u001b"), false);
  assert.equal(textRendered.includes("\u202e"), false);
  assert.match(textRendered, /\\u001b\\u202e/u);
  assert.ok([...textRendered].length < 3_000);
});

test("text context rendering enforces the compiled total-output ceiling", () => {
  assert.throws(
    () => renderResult({
      command: "context",
      workspace: "C:/workspace",
      graph: { root: "C:/workspace/local", revision: "sha256:revision" },
      contextPackId: "sha256:pack",
      request: { scope: "workspace", mode: "implement" },
      budget: { usedCharacters: 100, maximumCharacters: 100 },
      lanes: { mandatory: [], working: [], evidence: [] },
      renderedContext: "\u202e".repeat(100),
      warnings: [],
      outputBudget: { maximumCharacters: 200 },
    }, "text"),
    (error) =>
      error instanceof SyncoraError &&
      error.code === "CONTEXT_OUTPUT_EXCEEDED" &&
      error.details?.format === "text",
  );
});
