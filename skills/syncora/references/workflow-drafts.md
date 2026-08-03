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

- `debate` runs a relentless, one-question-at-a-time Syncora decision interview
  that challenges weak answers and closes every material gap through a
  decision, assumption, evidence request, or test.
- `design` turns an accepted direction into one fixed, validated WorkPack under
  `workpacks/<id>/`; that pack is the implementation-ready design and task
  graph rather than an optional document.
- `verify` treats a WorkPack's predeclared acceptance criteria as the primary
  contract and requires fresh evidence before allowing a success verdict.

The demo commands establish the public vocabulary and output contracts. Later
iterations may add bounded Syncora context retrieval, artifact persistence,
direct CLI model execution, and governed capture of accepted outcomes. When
Syncora is invoked inside an agent session, the agent executes the bundled
`workflow-debate.md`, `workflow-design.md`, or `workflow-verify.md` contract;
the Node commands remain portable launch packets.
