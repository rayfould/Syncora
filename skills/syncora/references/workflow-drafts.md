# Workflow drafts

Syncora's preview includes deterministic demo scaffolds for higher-level agent
workflows. They are intentionally read-only and do not invoke a model, inspect
project files, or write canonical knowledge.

## Commands

```text
syncora workflows
syncora debate --topic "Should capture run automatically?"
syncora design --topic "Add durable decision briefs"
syncora verify --topic "The decision-brief implementation is release-ready"
```

Add `--format json` to consume the workflow packet programmatically. Text mode
returns a Markdown scaffold that can be handed to an agent or redirected to a
draft file.

## Intended future integration

- `debate` adapts the one-question-at-a-time pressure-testing pattern into a
  Syncora-owned workflow.
- `design` creates an implementation-ready design-document outline with a
  concise decision brief.
- `verify` turns a completion claim into acceptance criteria and a fresh
  evidence matrix before allowing a success verdict.

The demo commands establish the public vocabulary and output contracts. Later
iterations may add bounded Syncora context retrieval, artifact persistence,
direct CLI model execution, and governed capture of accepted outcomes. When
Syncora is invoked inside an agent session, the agent executes the bundled
`workflow-debate.md`, `workflow-design.md`, or `workflow-verify.md` contract;
the Node commands remain portable launch packets.
