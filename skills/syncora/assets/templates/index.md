---
id: atlas-root
kind: atlas
scope: workspace
state: active
authority: canonical
schema_version: 1
created: {{date}}
updated: {{date}}
summary: Entry point for durable workspace context.
---

# Local Knowledge Atlas

## Project hubs

- [[knowledge/projects/workspace]]

## Inbox

- Put unclassified temporary material under `local/inbox/`.

## Rules

- Route through a project hub instead of recursively loading the graph.
- Keep one accepted project hub per scope.
- Keep sessions historical and decisions atomic.
