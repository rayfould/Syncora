import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import {
  DRIFT_OUTPUT_POLICY,
  ERROR_OUTPUT_POLICY,
  GOVERNED_OUTPUT_POLICY,
  helpText,
  parseArgv,
  renderError,
  renderResult,
  SyncoraError,
} from "../../skills/syncora/scripts/lib/cli.mjs";

function driftResult(overrides = {}) {
  return {
    ok: true,
    command: "check",
    mode: "changed",
    state: "findings-created",
    workspace: "C:/workspace",
    graph: {
      root: "C:/workspace/local",
      revision: `sha256:${"a".repeat(64)}`,
    },
    provider: {
      kind: "fingerprint",
      baseline: "exact-bytes",
      baselineInitialized: true,
    },
    summary: {
      changedPaths: 1,
      renames: 0,
      activeFindings: 1,
      newFindings: 1,
      resolvedFindings: 0,
    },
    findings: [],
    warnings: [],
    omittedFindings: 0,
    omittedWarnings: 0,
    ...overrides,
  };
}

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

test("adopt previews and executes one complete reviewed pack", () => {
  const workspace = resolve("workspace");
  const review = resolve("review");
  const artifacts = [
    "--migration-id",
    "legacy-adoption",
    "--manifest",
    resolve(review, "manifest.json"),
    "--staged-content",
    resolve(review, "staged-content"),
    "--fixtures",
    resolve(review, "fixtures.json"),
  ];
  const preview = parseArgv([
    "adopt",
    "--workspace",
    workspace,
    ...artifacts,
    "--dry-run",
  ]);
  assert.equal(preview.options.dryRun, true);
  assert.equal(preview.options.bundle, undefined);

  assert.throws(
    () => parseArgv([
      "adopt",
      "--workspace",
      workspace,
      ...artifacts,
    ]),
    (error) => error instanceof SyncoraError && error.code === "CLI002",
  );

  const final = parseArgv([
    "adopt",
    "--workspace",
    workspace,
    ...artifacts,
    "--expected-bundle-digest",
    `sha256:${"a".repeat(64)}`,
  ]);
  assert.equal(final.options.dryRun, false);
  assert.equal(final.options.expectedBundleDigest, `sha256:${"a".repeat(64)}`);
});

test("adopt rejects mixed sealed-bundle and reviewed-pack inputs", () => {
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

test("setup and adopt are primary help surfaces while bundle remains compatible", () => {
  assert.match(helpText(), /\n  setup\s+Initialize a greenfield workspace/u);
  assert.match(helpText(), /\n  adopt\s+Preview or apply one reviewed legacy graph/u);
  assert.match(helpText(), /\n  bundle\s+Advanced compatibility tool/u);
  assert.match(helpText("bundle"), /content-addressed descriptor consumed by syncora adopt/u);
  assert.match(helpText("adopt"), /Dry-run seals the reviewed pack in memory/u);
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

test("check requires explicit changed mode and owns drift-only options", () => {
  const workspace = resolve("workspace");

  assert.throws(
    () => parseArgv(["check", "--workspace", workspace]),
    (error) =>
      error instanceof SyncoraError &&
      error.code === "CLI002" &&
      /requires --changed/u.test(error.message),
  );

  const parsed = parseArgv([
    "check",
    "--changed",
    "--workspace",
    workspace,
    "--dry-run",
    "--format",
    "json",
  ]);
  assert.equal(parsed.command, "check");
  assert.equal(parsed.options.changed, true);
  assert.equal(parsed.options.dryRun, true);
  assert.equal(parsed.options.format, "json");

  assert.throws(
    () => parseArgv(["validate", "--workspace", workspace, "--changed"]),
    (error) => error instanceof SyncoraError && error.code === "CLI005",
  );
  assert.throws(
    () => parseArgv([
      "check",
      "--changed",
      "--workspace",
      workspace,
      "--proposal",
      `proposal_${"b".repeat(64)}`,
    ]),
    (error) => error instanceof SyncoraError && error.code === "CLI005",
  );
});

test("check acknowledgement is exact, digest-bound, and complete", () => {
  const workspace = resolve("workspace");
  const finding = `finding_${"c".repeat(64)}`;
  const digest = `sha256:${"d".repeat(64)}`;
  const reason = "The exact finding was reviewed and the bound note remains current.";

  const parsed = parseArgv([
    "check",
    "--changed",
    "--workspace",
    workspace,
    "--acknowledge-current",
    finding,
    "--finding-digest",
    digest,
    "--reason",
    reason,
  ]);
  assert.equal(parsed.options.acknowledgeCurrent, finding);
  assert.equal(parsed.options.findingDigest, digest);
  assert.equal(parsed.options.reason, reason);

  assert.throws(
    () => parseArgv([
      "check",
      "--changed",
      "--workspace",
      workspace,
      "--acknowledge-current",
      finding,
    ]),
    (error) => error instanceof SyncoraError && error.code === "CLI002",
  );
  assert.throws(
    () => parseArgv([
      "check",
      "--changed",
      "--workspace",
      workspace,
      "--acknowledge-current",
      finding,
      "--finding-digest",
      `sha256:${"D".repeat(64)}`,
      "--reason",
      reason,
    ]),
    (error) => error instanceof SyncoraError && error.code === "CLI004",
  );
  assert.throws(
    () => parseArgv([
      "check",
      "--changed",
      "--workspace",
      workspace,
      "--finding-digest",
      digest,
      "--reason",
      reason,
    ]),
    (error) => error instanceof SyncoraError && error.code === "CLI005",
  );
});

test("check rebaseline is explicit, reasoned, and mutually exclusive with acknowledgement", () => {
  const workspace = resolve("workspace");
  const parsed = parseArgv([
    "check",
    "--changed",
    "--rebaseline",
    "--reason",
    "Upgrade the foreground drift policy.",
    "--workspace",
    workspace,
  ]);
  assert.equal(parsed.options.rebaseline, true);
  assert.equal(parsed.options.reason, "Upgrade the foreground drift policy.");
  assert.throws(
    () => parseArgv([
      "check",
      "--changed",
      "--rebaseline",
      "--workspace",
      workspace,
    ]),
    (error) => error instanceof SyncoraError && error.code === "CLI002",
  );
  assert.throws(
    () => parseArgv([
      "check",
      "--changed",
      "--rebaseline",
      "--acknowledge-current",
      `finding_${"1".repeat(64)}`,
      "--finding-digest",
      `sha256:${"2".repeat(64)}`,
      "--reason",
      "Conflicting modes.",
      "--workspace",
      workspace,
    ]),
    (error) => error instanceof SyncoraError && error.code === "CLI005",
  );
});

test("check is a first-class help surface with an explicit foreground safety boundary", () => {
  assert.deepEqual(parseArgv(["check", "--help"]), {
    command: "help",
    options: { topic: "check" },
  });
  assert.match(helpText(), /\n  check\s+Detect changed sources bound to project knowledge/u);
  assert.match(helpText("check"), /syncora check --changed/u);
  assert.match(helpText("check"), /--acknowledge-current <finding-id>/u);
  assert.match(helpText("check"), /--rebaseline/u);
  assert.match(helpText("check"), /after DRIFT_POLICY_MISMATCH/u);
  assert.match(helpText("check"), /exact immutable finding artifact digest/u);
  assert.match(helpText("check"), /Canonical Markdown is never changed/u);
});

test("check rendering is bounded and never emits note bodies or diff hunks", () => {
  const secret = `SYNCORA_PRIVATE_BODY_${"x".repeat(8_192)}`;
  const finding = {
    id: `finding_${"e".repeat(64)}`,
    digest: `sha256:${"f".repeat(64)}`,
    artifactPath: "local/.syncora/drift/findings/finding.json",
    refreshArtifactPath: "local/.syncora/drift/refresh/refresh.json",
    note: {
      path: "knowledge/projects/runtime.md",
      sha256: `sha256:${"1".repeat(64)}`,
      kind: "project",
      scope: "workspace",
      body: secret,
    },
    changedSources: {
      returned: 1,
      total: 1,
      diff: secret,
    },
    recommendedOperation: "hub.refresh",
    afterTextRequired: true,
    nextCommand: "syncora propose --input <absolute-json-path>",
    beforeText: secret,
    afterText: secret,
    diffHunk: secret,
  };

  const small = driftResult({
    findings: [{
      ...finding,
      note: { ...finding.note, body: "PRIVATE_NOTE_BODY" },
      changedSources: { ...finding.changedSources, diff: "PRIVATE_DIFF_HUNK" },
      beforeText: "PRIVATE_BEFORE_TEXT",
      afterText: "PRIVATE_AFTER_TEXT",
      diffHunk: "PRIVATE_DIFF_HUNK",
    }],
  });
  const smallJson = renderResult(small, "json");
  assert.doesNotMatch(
    smallJson,
    /PRIVATE_(?:NOTE_BODY|DIFF_HUNK|BEFORE_TEXT|AFTER_TEXT)/u,
  );

  const large = driftResult({
    findings: Array.from({ length: 40 }, (_, index) => ({
      ...finding,
      id: `finding_${index.toString(16).padStart(64, "0")}`,
      artifactPath: `${"very-long-segment/".repeat(500)}finding-${index}.json`,
    })),
    warnings: Array.from({ length: 40 }, (_, index) => ({
      code: `DRIFT_WARN_${index}`,
      message: `${"warning ".repeat(1_000)}${index}`,
      body: secret,
    })),
  });

  const json = renderResult(large, "json");
  const parsed = JSON.parse(json);
  assert.ok([...json].length <= DRIFT_OUTPUT_POLICY.maximumCharacters);
  assert.equal(parsed.output.truncated, true);
  assert.equal(parsed.findings.length, DRIFT_OUTPUT_POLICY.maximumReturnedFindings);
  assert.equal(parsed.omittedFindings, 24);
  assert.equal(json.includes(secret), false);
  assert.equal("body" in parsed.findings[0].note, false);
  assert.deepEqual(Object.keys(parsed.findings[0].changedSources).sort(), ["previewLimit", "total"]);

  const text = renderResult(large, "text");
  assert.ok([...text].length <= DRIFT_OUTPUT_POLICY.maximumCharacters);
  assert.match(text, /Output: compacted/u);
  assert.equal(text.includes(secret), false);
  assert.doesNotMatch(text, /PRIVATE_(?:NOTE_BODY|DIFF_HUNK|BEFORE_TEXT|AFTER_TEXT)/u);
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
