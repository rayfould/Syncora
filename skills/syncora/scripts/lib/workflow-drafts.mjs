import { SyncoraError } from "./cli.mjs";

export const WORKFLOW_DRAFT_COMMANDS = Object.freeze([
  "debate",
  "design",
  "verify",
]);

const WORKFLOW_DRAFT_COMMAND_SET = new Set(WORKFLOW_DRAFT_COMMANDS);
const MAXIMUM_TOPIC_CHARACTERS = 2_048;

const DEFINITIONS = Object.freeze({
  debate: {
    title: "Debate",
    description: "Run a relentless one-question-at-a-time challenge session.",
    stages: [
      "State the proposal, desired outcome, constraints, and current confidence.",
      "Interrogate one hidden assumption at a time; do not batch questions.",
      "Steelman the strongest alternative before criticizing it.",
      "Red-team failure modes, second-order effects, and rollback limits.",
      "Force a choice: proceed, revise, test first, defer, or reject.",
      "End with a decision brief of no more than 200 words.",
    ],
    artifact: [
      "## Proposal under debate",
      "## Assumptions challenged",
      "## Strongest counter-position",
      "## Failure modes",
      "## Evidence still needed",
      "## Verdict",
      "## Decision brief",
    ],
  },
  design: {
    title: "Design Document",
    description: "Draft an implementation-ready design with explicit tradeoffs.",
    stages: [
      "Define the problem, user outcome, constraints, goals, and non-goals.",
      "Describe the current system and the smallest viable change.",
      "Compare at least two credible approaches and recommend one.",
      "Specify architecture, data flow, interfaces, and failure behavior.",
      "Define security, migration, observability, testing, rollout, and rollback.",
      "Close with genuine open decisions and a concise decision brief.",
    ],
    artifact: [
      "## Decision brief",
      "## Problem and context",
      "## Goals",
      "## Non-goals",
      "## Constraints",
      "## Options and tradeoffs",
      "## Recommended design",
      "## Architecture and data flow",
      "## Interfaces and contracts",
      "## Failure modes and security",
      "## Testing and observability",
      "## Rollout and rollback",
      "## Open decisions",
    ],
  },
  verify: {
    title: "Verification",
    description: "Prove a claimed implementation outcome with fresh evidence.",
    stages: [
      "Translate the claim into observable acceptance criteria.",
      "Map every criterion to a command, inspection, or reproducible scenario.",
      "Run fresh checks; never reuse an earlier success as current proof.",
      "Inspect negative paths, boundary cases, and user-visible behavior.",
      "Separate proven, disproven, blocked, and untested claims.",
      "Give a verdict and the smallest next action for every gap.",
    ],
    artifact: [
      "## Claim being verified",
      "## Acceptance criteria",
      "## Evidence matrix",
      "| Criterion | Verification | Result | Evidence |",
      "| --- | --- | --- | --- |",
      "## Negative and boundary checks",
      "## Untested or blocked claims",
      "## Regressions found",
      "## Verdict: proven / partially proven / disproven",
      "## Required next actions",
    ],
  },
});

export function isWorkflowDraftCommand(command) {
  return WORKFLOW_DRAFT_COMMAND_SET.has(command);
}

export function listWorkflowDrafts() {
  return {
    reportSchemaVersion: 1,
    ok: true,
    command: "workflows",
    kind: "syncora.workflow-catalog",
    status: "draft-demo",
    workflows: WORKFLOW_DRAFT_COMMANDS.map((command) => ({
      command,
      description: DEFINITIONS[command].description,
      usage: `syncora ${command} --topic <text>`,
    })),
    disclaimer:
      "These commands emit deterministic workflow scaffolds. Agent-led execution and project-aware retrieval remain future integration work.",
  };
}

export function createWorkflowDraft(command, options = {}) {
  if (!isWorkflowDraftCommand(command)) {
    throw new SyncoraError("CLI001", `Unknown workflow draft: ${command}`);
  }
  const topic = normalizeTopic(options.topic);
  const definition = DEFINITIONS[command];
  const markdown = renderWorkflowMarkdown(command, topic, definition);

  return {
    reportSchemaVersion: 1,
    ok: true,
    command,
    kind: "syncora.workflow-draft",
    status: "draft-demo",
    topic,
    description: definition.description,
    stages: definition.stages.map((instruction, index) => ({
      order: index + 1,
      instruction,
    })),
    artifactSections: [...definition.artifact],
    markdown,
    disclaimer:
      "Demo scaffold only: this command does not invoke a model, inspect project files, or mutate Syncora knowledge.",
  };
}

function normalizeTopic(value) {
  const topic = String(value ?? "").normalize("NFC").trim().replace(/\s+/gu, " ");
  if (!topic) {
    throw new SyncoraError("CLI002", "Workflow drafts require --topic <text>.");
  }
  if ([...topic].length > MAXIMUM_TOPIC_CHARACTERS) {
    throw new SyncoraError(
      "CLI004",
      `--topic must be at most ${MAXIMUM_TOPIC_CHARACTERS} Unicode code points.`,
    );
  }
  if (/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u.test(topic)) {
    throw new SyncoraError("CLI004", "--topic contains unsupported control characters.");
  }
  return topic;
}

function renderWorkflowMarkdown(command, topic, definition) {
  const lines = [
    `# Syncora ${definition.title} Draft`,
    "",
    `> Demo scaffold generated by \`syncora ${command}\`. It does not execute the workflow yet.`,
    "",
    `**Topic:** ${topic}`,
    "",
    "## Agent brief",
    "",
    definition.description,
    "",
    "Work from current evidence. Label assumptions, avoid invented certainty, and ask only one blocking question at a time.",
    "",
    "## Workflow",
    "",
    ...definition.stages.map((stage, index) => `${index + 1}. ${stage}`),
    "",
    "## Draft artifact",
    "",
    ...definition.artifact,
    "",
    "## Demo completion signal",
    "",
    "Return the completed artifact, the recommended next action, and any decision that still requires the user.",
  ];
  return `${lines.join("\n")}\n`;
}
