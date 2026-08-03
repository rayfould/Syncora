# Design workflow

Use this Syncora-owned workflow to turn an accepted direction into one stable,
file-based execution contract for humans and agents. The result is a WorkPack,
not an optional design document and not an implementation. Do not write product
code, assign agents, or execute tasks while Design is active.

## Fixed output boundary

Create the WorkPack under `workpacks/<workpack-id>/`. Never put it under
`local/`, which owns canonical Syncora knowledge, or `.syncora/`, which owns
operational state.

```text
workpacks/<workpack-id>/
|-- README.md
|-- design.md
|-- tasks/
|   |-- PREFIX-001-<task-slug>.md
|   `-- PREFIX-999-final-verification.md
`-- evidence/
```

Use the bundled `assets/templates/workpack-*.md` files as the structural
starting point. The three Markdown authorities have non-overlapping jobs:

- `README.md` alone owns coordination state: task status, owner, dependencies,
  concurrency, dirty-work baseline, and the pack completion gate.
- `design.md` alone owns approved outcome, current evidence, scope, stable
  design contracts, required and forbidden behavior, failure and security
  invariants, migration, rollout, rollback, and completion meaning.
- Each task file owns one execution contract, its exclusive or declared shared
  file surface, predeclared proof, acceptance criteria, evidence destination,
  and eventual handoff. It must not repeat mutable README coordination fields.

## Execution

1. **Ground reality.** Inspect current behavior, relevant Syncora context,
   ownership, entrypoints, dependencies, dirty changes, and operational or
   deployment boundaries. Record evidence rather than designing from guesses.
2. **Create design truth.** Define the desired outcome, scope, non-goals, and
   stable `D-###` contracts. Specify responsibility, data ownership, required
   and forbidden behavior, failure behavior, security, compatibility, rollout,
   rollback, and what complete means. Keep every template section; write
   `Not applicable - <reason>` when a section genuinely does not apply.
3. **Build the task graph.** Split work by cohesive ownership boundary, not
   arbitrary frontend/backend labels. Give each task one stable ID and file,
   map it to design contracts, declare exact file ownership, add real
   dependencies, and prewrite observable, falsifiable acceptance evidence.
   Parallel tasks must not overlap exclusive files. Serialize unavoidable
   overlap or declare the shared surface explicitly. Include one final
   integration-verification task.
4. **Validate readiness.** Run the bundled validator before presenting the
   pack:

   ```text
   node "<syncora-skill-root>/scripts/validate-workpack.mjs" --workspace <absolute-workspace> --workpack workpacks/<workpack-id> --format json
   ```

   Repair missing files or sections, unstable IDs, placeholders, dependency
   errors or cycles, ownership collisions, unmapped design contracts,
   subjective acceptance criteria, missing evidence destinations, and a
   missing final verification task. A draft is not ready merely because its
   files exist.

Do not force a second alternatives exercise after Debate chose the direction.
Compare alternatives only when current evidence reveals a genuine unresolved
design choice that could materially change behavior, ownership, cost, or risk.
If implementation later exposes such a conflict, report and reopen the design;
never silently rewrite architecture inside a task.

## Output

Lead with a decision brief of no more than 200 words containing the
recommendation, outcome, material tradeoffs, risks and rollback, and genuine
open decisions only. Then report:

- the WorkPack path;
- readiness: `ready`, `blocked`, or `needs decision`;
- validator findings that prevent readiness;
- the smallest next action.

The WorkPack is the full design artifact. Do not produce a competing optional
PRD, architecture document, or implementation plan.
