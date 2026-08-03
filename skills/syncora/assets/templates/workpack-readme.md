# WorkPack: <workpack-title>

**ID:** `<workpack-id>`
**Status:** Proposed

## Goal

<One observable outcome for the complete WorkPack.>

## Required Reading

1. Workspace `AGENTS.md`
2. This `README.md`
3. `design.md`
4. The assigned task file
5. Every dependency task listed below

## Scope Boundary

### In scope

- <Included outcome or surface.>

### Out of scope

- <Explicit negative scope.>

## Task Graph

| ID | Task | Status | Depends on | Owner |
| --- | --- | --- | --- | --- |
| PREFIX-001 | <First cohesive outcome> | Ready | None | Unassigned |
| PREFIX-999 | Final integration verification | Pending | PREFIX-001 | Unassigned |

Valid task statuses are `Pending`, `Ready`, `In Progress`, `Blocked`,
`Complete`, and `Reopened`. This table alone owns status, assignment,
dependencies, and execution order.

## Concurrency Rules

- <State which tasks may run concurrently and why their owned files do not overlap.>
- <State which shared surfaces require serialization or coordinator ownership.>

## Dirty Work Baseline

- <Record relevant existing diffs, retained implementation, and unrelated changes that must be preserved.>

## Completion Gate

- Every design contract is implemented or explicitly blocked.
- Every task acceptance criterion has fresh evidence.
- The final verification task checks integration, regressions, security boundaries, rollout readiness, and remaining external blockers.
- README status and task handoffs describe actual current state; file existence alone is not completion.
