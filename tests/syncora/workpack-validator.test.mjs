import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { validateWorkpack } from "../../skills/syncora/scripts/lib/workpack-validator.mjs";

async function createWorkpack() {
  const workspace = await mkdtemp(path.join(tmpdir(), "syncora-workpack-"));
  const root = path.join(workspace, "workpacks", "session-warning");
  await mkdir(path.join(root, "tasks"), { recursive: true });
  await mkdir(path.join(root, "evidence"), { recursive: true });

  await writeFile(path.join(root, "README.md"), `# WorkPack: Session warning

**ID:** \`session-warning\`
**Status:** Proposed

## Goal

Warn authenticated users before their session expires.

## Required Reading

1. Workspace \`AGENTS.md\`
2. This \`README.md\`
3. \`design.md\`
4. The assigned task
5. Every dependency task

## Scope Boundary

In scope: warning behavior. Out of scope: changing authentication.

## Task Graph

| ID | Task | Status | Depends on | Owner |
| --- | --- | --- | --- | --- |
| SESS-001 | Build warning | Ready | None | Unassigned |
| SESS-999 | Final integration verification | Pending | SESS-001 | Unassigned |

## Concurrency Rules

The verification task runs after implementation.

## Dirty Work Baseline

The relevant files are clean; unrelated changes remain untouched.

## Completion Gate

Both tasks have fresh evidence and truthful handoffs.
`, "utf8");

  await writeFile(path.join(root, "design.md"), `# Design: Session warning

## Desired Outcome

Users receive one warning before expiry.

## Current Reality and Evidence

The current client expires without warning.

## Scope and Non-Goals

Only warning behavior changes; authentication does not.

## Design Contracts

- \`D-001\`: Display one warning before expiry.
- \`D-002\`: Preserve existing expiry behavior.

## Responsibility and Data Ownership

The session client owns expiry state.

## Required Behavior

The warning is deterministic.

## Forbidden Behavior

Never extend the session automatically.

## Failure and Security Invariants

Missing warning state must not bypass expiry.

## Compatibility and Migration

Not applicable - no stored format changes.

## Rollout and Rollback

Remove the warning component to roll back.

## Definition of Complete

Fresh tests prove warning and expiry behavior.
`, "utf8");

  await writeFile(path.join(root, "tasks", "SESS-001-build-warning.md"), taskSource({
    id: "SESS-001",
    title: "Build warning",
    contracts: ["D-001", "D-002"],
    ownedFile: "src/session-warning.mjs",
  }), "utf8");
  await writeFile(path.join(root, "tasks", "SESS-999-final-verification.md"), taskSource({
    id: "SESS-999",
    title: "Final verification",
    contracts: ["D-001", "D-002"],
    ownedFile: "tests/session-warning.test.mjs",
  }), "utf8");
  return { workspace, root };
}

function taskSource({ id, title, contracts, ownedFile }) {
  return `# ${id}: ${title}

## Outcome

Produce one independently verified ${title.toLowerCase()} result.

## Design Contracts

${contracts.map((contract) => `- \`${contract}\``).join("\n")}

## Preconditions

None - the README dependency graph is authoritative.

## File Ownership

- \`${ownedFile}\`

## Shared Files

None - this task has an exclusive file surface.

## Contract

Preserve every referenced design contract and scope boundary.

## Proof-First Checklist

- [ ] Run the exact focused test before and after implementation.

## Acceptance Criteria

- [ ] The focused test passes and the negative path remains covered.

## Evidence Destination

\`workpacks/session-warning/evidence/run-001/\`

## Handoff

Not started. Record actual commands, evidence, limitations, and remaining gaps.
`;
}

test("a complete fixed WorkPack validates as ready", async (t) => {
  const fixture = await createWorkpack();
  t.after(() => rm(fixture.workspace, { recursive: true, force: true }));

  const report = await validateWorkpack({
    workspace: fixture.workspace,
    workpack: "workpacks/session-warning",
  });

  assert.equal(report.ok, true);
  assert.equal(report.status, "ready");
  assert.equal(report.summary.tasks, 2);
  assert.equal(report.summary.designContracts, 2);
  assert.deepEqual(report.errors, []);
});

test("the validator rejects duplicated coordination state and ownership overlap", async (t) => {
  const fixture = await createWorkpack();
  t.after(() => rm(fixture.workspace, { recursive: true, force: true }));
  const secondTask = path.join(fixture.root, "tasks", "SESS-999-final-verification.md");
  const source = await readFile(secondTask, "utf8");
  await writeFile(
    secondTask,
    source
      .replace("# SESS-999: Final verification", "# SESS-999: Final verification\n\n**Status:** Complete")
      .replace("tests/session-warning.test.mjs", "src/session-warning.mjs"),
    "utf8",
  );

  const report = await validateWorkpack({
    workspace: fixture.workspace,
    workpack: "workpacks/session-warning",
  });

  assert.equal(report.ok, false);
  assert.ok(report.errors.some((error) => error.code === "COORDINATION_DUPLICATED"));
  assert.ok(report.errors.some((error) => error.code === "FILE_OWNERSHIP_OVERLAP"));
});

test("the validator rejects non-workpacks roots", async () => {
  await assert.rejects(
    validateWorkpack({ workspace: process.cwd(), workpack: "local/workpacks/example" }),
    (error) => error.code === "WORKPACK_INPUT_INVALID",
  );
});
