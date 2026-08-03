import assert from "node:assert/strict";
import test from "node:test";

import {
  helpText,
  parseArgv,
  renderResult,
  SyncoraError,
} from "../../skills/syncora/scripts/lib/cli.mjs";
import {
  createWorkflowDraft,
  listWorkflowDrafts,
} from "../../skills/syncora/scripts/lib/workflow-drafts.mjs";

test("workflow demo commands are discoverable and do not require a workspace", () => {
  assert.deepEqual(parseArgv(["workflows"]), {
    command: "workflows",
    options: {
      workspace: undefined,
      format: "text",
      dryRun: false,
      patchAgents: true,
      allowExternalGraphRoot: undefined,
      note: undefined,
      query: undefined,
      limit: undefined,
      phase: undefined,
      cursor: undefined,
      profile: undefined,
      checkpointId: undefined,
      migrationId: undefined,
      manifest: undefined,
      stagedContent: undefined,
      fixtures: undefined,
      bundle: undefined,
      expectedBundleDigest: undefined,
      output: undefined,
      confirmPredecessorReviewed: false,
      force: false,
      noCache: false,
      includeHistory: false,
      intent: undefined,
      input: undefined,
      scope: undefined,
      mode: undefined,
      budget: undefined,
      maxCharacters: undefined,
      continuation: undefined,
      targets: [],
      proposal: undefined,
      proposalDigest: undefined,
      decision: undefined,
      reviewedBy: undefined,
      reason: undefined,
      ownerKind: undefined,
      ownerKey: undefined,
      changed: false,
      rebaseline: false,
      acknowledgeCurrent: undefined,
      findingDigest: undefined,
      topic: undefined,
    },
  });
  assert.match(helpText(), /\n  debate\s+Pressure-test an idea/u);
  assert.match(helpText(), /\n  design\s+Draft an implementation-ready design/u);
  assert.match(helpText("verify"), /syncora verify --topic <text>/u);
});

test("workflow demo parsing requires a bounded topic and rejects runtime options", () => {
  const parsed = parseArgv([
    "debate",
    "--topic",
    "Should capture be automatic?",
    "--format",
    "json",
  ]);
  assert.equal(parsed.command, "debate");
  assert.equal(parsed.options.topic, "Should capture be automatic?");
  assert.equal(parsed.options.format, "json");

  assert.throws(
    () => parseArgv(["design"]),
    (error) => error instanceof SyncoraError && error.code === "CLI002",
  );
  assert.throws(
    () => parseArgv(["verify", "--topic", "Ship it", "--dry-run"]),
    (error) => error instanceof SyncoraError && error.code === "CLI005",
  );
  assert.throws(
    () => parseArgv(["verify", "--topic", "The implementation", "--workspace", "C:/repo"]),
    (error) => error instanceof SyncoraError && error.code === "CLI005",
  );
});

test("workflow drafts produce useful deterministic Markdown and JSON packets", () => {
  const draft = createWorkflowDraft("design", {
    topic: "Add durable decision briefs",
  });
  assert.equal(draft.status, "draft-demo");
  assert.equal(draft.stages.length, 6);
  assert.match(draft.markdown, /# Syncora Design Document Draft/u);
  assert.match(draft.markdown, /## Options and tradeoffs/u);
  assert.match(draft.markdown, /## Rollout and rollback/u);
  assert.doesNotMatch(draft.markdown, /sha256:/u);

  const text = renderResult(draft, "text");
  assert.equal(text, draft.markdown);
  const json = JSON.parse(renderResult(draft, "json"));
  assert.equal(json.topic, "Add durable decision briefs");
  assert.equal(json.kind, "syncora.workflow-draft");

  const catalog = listWorkflowDrafts();
  assert.equal(catalog.workflows.length, 3);
  assert.match(renderResult(catalog, "text"), /syncora debate --topic <text>/u);
});
