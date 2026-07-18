import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  assessProposalSemantics,
  PROPOSAL_SEMANTICS_POLICY,
} from "../../skills/syncora/scripts/lib/proposal-semantics.mjs";
import { parseNoteBytes } from "../../skills/syncora/scripts/lib/note-parser.mjs";
import {
  parseProposalInput,
  taggedContentSha256,
} from "../../skills/syncora/scripts/lib/proposal-schema.mjs";
import {
  validateProjectedGraph,
} from "../../skills/syncora/scripts/lib/projected-graph.mjs";
import {
  graphRevision,
  inspectWorkspace,
  VALIDATION_POLICY,
} from "../../skills/syncora/scripts/lib/validate.mjs";

function listField(name, values) {
  return values.length === 0
    ? [`${name}: []`]
    : [`${name}:`, ...values.map((value) => `  - ${value}`)];
}

function currentNote({
  id,
  kind,
  scope = "workspace",
  state = undefined,
  authority = undefined,
  title = id,
  summary = `Summary for ${id}`,
  decisionKey = undefined,
  supersedes = [],
  supersededBy = [],
  body = "",
}) {
  const resolvedAuthority = authority ?? ({
    reference: "supporting",
    session: "historical",
    inbox: "transient",
  }[kind] ?? "canonical");
  const resolvedState = state ?? ({
    decision: "proposed",
    session: "complete",
  }[kind] ?? "active");
  const lines = [
    "---",
    `id: ${id}`,
    `kind: ${kind}`,
    `scope: ${scope}`,
    `state: ${resolvedState}`,
    `authority: ${resolvedAuthority}`,
    "schema_version: 1",
    "created: 2026-07-17",
    "updated: 2026-07-17",
    `summary: ${JSON.stringify(summary)}`,
    ...(kind === "decision"
      ? [
          `decision_key: ${decisionKey ?? id}`,
          ...listField("supersedes", supersedes),
          ...listField("superseded_by", supersededBy),
        ]
      : []),
    "---",
    "",
    `# ${title}`,
    "",
    body,
    "",
  ];
  return Buffer.from(lines.join("\n"), "utf8");
}

async function writeGraphNote(workspace, path, bytes) {
  const destination = join(workspace, "local", ...path.split("/"));
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, bytes);
}

function declaredChange(change) {
  return {
    path: change.path,
    expectedPriorSha256: change.before === null
      ? null
      : taggedContentSha256(change.before),
    afterText: change.after === null ? null : change.after.toString("utf8"),
  };
}

function operation(operationId, kind, changes) {
  return {
    declaration: {
      operationId,
      kind,
      sourceRefs: [{
        type: "operation",
        ref: `test:${operationId}`,
        expectedSha256: null,
      }],
      changes: changes.map(declaredChange),
    },
    changes,
  };
}

function proposal(operations) {
  return {
    input: parseProposalInput({
      schemaVersion: 1,
      kind: "syncora.proposal-input",
      idempotencyKey: "proposal-semantics-test",
      origin: "manual",
      actor: { type: "agent", id: "test-agent", runtime: "node-test" },
      reason: "Exercise the governed proposal semantic kernel.",
      correctsProposalId: null,
      operations: operations.map((item) => item.declaration),
    }),
    changes: operations.flatMap((item) => item.changes),
  };
}

async function baseFixture() {
  const workspace = await mkdtemp(join(tmpdir(), "syncora-semantics-"));
  const notes = new Map([
    ["index.md", currentNote({ id: "atlas-root", kind: "atlas", title: "Atlas" })],
    ["knowledge/projects/workspace.md", currentNote({
      id: "project-workspace",
      kind: "project",
      title: "Workspace",
      body: "Current project status.",
    })],
    ["knowledge/concepts/update.md", currentNote({
      id: "concept-update",
      kind: "concept",
      title: "Update target",
      body: "Original content.",
    })],
    ["knowledge/concepts/move.md", currentNote({
      id: "concept-move",
      kind: "concept",
      title: "Move target",
      body: "Byte-identical move content.",
    })],
    ["knowledge/concepts/link-source.md", currentNote({
      id: "concept-link-source",
      kind: "concept",
      title: "Link source",
      body: "Stable source prose.",
    })],
    ["knowledge/concepts/link-target.md", currentNote({
      id: "concept-target",
      kind: "concept",
      title: "Link target",
      body: "Stable target prose.",
    })],
    ["knowledge/decisions/accept.md", currentNote({
      id: "decision-accept",
      kind: "decision",
      title: "Accept decision",
      decisionKey: "accept-choice",
    })],
    ["knowledge/decisions/predecessor.md", currentNote({
      id: "decision-predecessor",
      kind: "decision",
      title: "Predecessor",
      decisionKey: "replacement-choice",
      state: "accepted",
    })],
    ["knowledge/decisions/successor.md", currentNote({
      id: "decision-successor",
      kind: "decision",
      title: "Successor",
      decisionKey: "replacement-choice",
      state: "proposed",
    })],
  ]);
  for (const [path, bytes] of notes) await writeGraphNote(workspace, path, bytes);
  const inspection = await inspectWorkspace({ workspace });
  return { workspace, notes, inspection };
}

function runAssessment(inspection, proposalPackage) {
  const projection = validateProjectedGraph(inspection, proposalPackage.changes);
  return {
    projection,
    assessment: assessProposalSemantics(
      proposalPackage.input,
      inspection,
      proposalPackage.changes,
      projection,
    ),
  };
}

test("semantic bridge enforces and accepts all eight operation meanings", async () => {
  const fixture = await baseFixture();
  try {
    const hubPath = "knowledge/projects/workspace.md";
    const updatePath = "knowledge/concepts/update.md";
    const movePath = "knowledge/concepts/move.md";
    const linkPath = "knowledge/concepts/link-source.md";
    const acceptPath = "knowledge/decisions/accept.md";
    const predecessorPath = "knowledge/decisions/predecessor.md";
    const successorPath = "knowledge/decisions/successor.md";
    const created = currentNote({
      id: "concept-created",
      kind: "concept",
      title: "Created concept",
      body: "New durable content.",
    });
    const updated = currentNote({
      id: "concept-update",
      kind: "concept",
      title: "Update target",
      body: "Complete replacement content.",
    });
    const linked = currentNote({
      id: "concept-link-source",
      kind: "concept",
      title: "Link source",
      body: "Stable source prose.\n\n[[concept-target]]",
    });
    const accepted = currentNote({
      id: "decision-accept",
      kind: "decision",
      title: "Accept decision",
      decisionKey: "accept-choice",
      state: "accepted",
    });
    const predecessor = currentNote({
      id: "decision-predecessor",
      kind: "decision",
      title: "Predecessor",
      decisionKey: "replacement-choice",
      state: "superseded",
      supersededBy: ["decision-successor"],
    });
    const successor = currentNote({
      id: "decision-successor",
      kind: "decision",
      title: "Successor",
      decisionKey: "replacement-choice",
      state: "accepted",
      supersedes: ["decision-predecessor"],
    });
    const refreshedHub = currentNote({
      id: "project-workspace",
      kind: "project",
      title: "Workspace",
      body: "Refreshed project status.",
    });
    const session = currentNote({
      id: "session-2026-07-17-semantics",
      kind: "session",
      title: "Semantic milestone",
      body: "Recorded historical work.",
    });
    const packageValue = proposal([
      operation("create-note", "note.create", [{
        path: "knowledge/concepts/created.md",
        before: null,
        after: created,
      }]),
      operation("update-note", "note.update", [{
        path: updatePath,
        before: fixture.notes.get(updatePath),
        after: updated,
      }]),
      operation("move-note", "note.move", [
        { path: movePath, before: fixture.notes.get(movePath), after: null },
        {
          path: "knowledge/concepts/moved.md",
          before: null,
          after: fixture.notes.get(movePath),
        },
      ]),
      operation("add-link", "link.add", [{
        path: linkPath,
        before: fixture.notes.get(linkPath),
        after: linked,
      }]),
      operation("accept-decision", "decision.accept", [{
        path: acceptPath,
        before: fixture.notes.get(acceptPath),
        after: accepted,
      }]),
      operation("supersede-decision", "decision.supersede", [
        {
          path: predecessorPath,
          before: fixture.notes.get(predecessorPath),
          after: predecessor,
        },
        {
          path: successorPath,
          before: fixture.notes.get(successorPath),
          after: successor,
        },
      ]),
      operation("refresh-hub", "hub.refresh", [{
        path: hubPath,
        before: fixture.notes.get(hubPath),
        after: refreshedHub,
      }]),
      operation("record-session", "session.record", [{
        path: "knowledge/sessions/2026-07-17-semantics.md",
        before: null,
        after: session,
      }]),
    ]);

    const { projection, assessment } = runAssessment(fixture.inspection, packageValue);
    assert.equal(projection.ok, true);
    assert.equal(assessment.reviewRequired, true);
    assert.equal(assessment.authorityImpact.level, "authority-changing");
    assert.equal(assessment.authorityImpact.paths.length, 10);
    assert.deepEqual(
      assessment.authorityImpact.paths,
      [...assessment.authorityImpact.paths].sort(),
    );
    assert.equal(assessment.projectedValidation.valid, true);
    assert.equal(
      assessment.projectedValidation.projectedGraphRevision,
      projection.graphRevision,
    );
    assert.match(assessment.projectedValidation.digest, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(Object.isFrozen(assessment), true);
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

test("semantic disguises are rejected for every operation kind", async (context) => {
  const fixture = await baseFixture();
  try {
    const updatePath = "knowledge/concepts/update.md";
    const movePath = "knowledge/concepts/move.md";
    const linkPath = "knowledge/concepts/link-source.md";
    const acceptPath = "knowledge/decisions/accept.md";
    const predecessorPath = "knowledge/decisions/predecessor.md";
    const successorPath = "knowledge/decisions/successor.md";
    const hubPath = "knowledge/projects/workspace.md";
    const cases = [
      operation("create-disguise", "note.create", [{
        path: updatePath,
        before: fixture.notes.get(updatePath),
        after: currentNote({ id: "concept-update", kind: "concept", body: "Changed." }),
      }]),
      operation("update-disguise", "note.update", [{
        path: "knowledge/concepts/update-disguise.md",
        before: null,
        after: currentNote({ id: "concept-update-disguise", kind: "concept" }),
      }]),
      operation("move-disguise", "note.move", [
        { path: movePath, before: fixture.notes.get(movePath), after: null },
        {
          path: "knowledge/concepts/not-the-same.md",
          before: null,
          after: currentNote({ id: "concept-not-the-same", kind: "concept" }),
        },
      ]),
      operation("link-disguise", "link.add", [{
        path: linkPath,
        before: fixture.notes.get(linkPath),
        after: currentNote({
          id: "concept-link-source",
          kind: "concept",
          title: "Link source",
          summary: "Changed frontmatter summary",
          body: "Stable source prose.\n\n[[concept-target]]",
        }),
      }]),
      operation("accept-disguise", "decision.accept", [{
        path: acceptPath,
        before: fixture.notes.get(acceptPath),
        after: currentNote({
          id: "decision-accept",
          kind: "decision",
          decisionKey: "accept-choice",
          state: "proposed",
        }),
      }]),
      operation("supersede-disguise", "decision.supersede", [
        {
          path: predecessorPath,
          before: fixture.notes.get(predecessorPath),
          after: currentNote({
            id: "decision-predecessor",
            kind: "decision",
            decisionKey: "replacement-choice",
            state: "accepted",
            supersededBy: ["decision-successor"],
          }),
        },
        {
          path: successorPath,
          before: fixture.notes.get(successorPath),
          after: currentNote({
            id: "decision-successor",
            kind: "decision",
            decisionKey: "replacement-choice",
            state: "proposed",
            supersedes: ["decision-predecessor"],
          }),
        },
      ]),
      operation("hub-disguise", "hub.refresh", [{
        path: hubPath,
        before: fixture.notes.get(hubPath),
        after: currentNote({ id: "project-renamed", kind: "project", title: "Workspace" }),
      }]),
      operation("session-disguise", "session.record", [{
        path: "knowledge/sessions/not-a-session.md",
        before: null,
        after: currentNote({ id: "concept-not-session", kind: "concept" }),
      }]),
    ];

    for (const operationCase of cases) {
      await context.test(operationCase.declaration.kind, () => {
        assert.throws(
          () => {
            const packageValue = proposal([operationCase]);
            const projection = validateProjectedGraph(
              fixture.inspection,
              packageValue.changes,
            );
            assert.equal(projection.ok, true);
            assessProposalSemantics(
              packageValue.input,
              fixture.inspection,
              packageValue.changes,
              projection,
            );
          },
          (error) => error?.code === "PROPOSAL001" || error?.code === "PROPOSAL003",
        );
      });
    }
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

test("authority impact comes from before and after authority, not operation labels", async () => {
  const fixture = await baseFixture();
  try {
    const updatePath = "knowledge/concepts/update.md";
    const canonical = runAssessment(fixture.inspection, proposal([
      operation("canonical-content", "note.update", [{
        path: updatePath,
        before: fixture.notes.get(updatePath),
        after: currentNote({
          id: "concept-update",
          kind: "concept",
          title: "Update target",
          body: "Canonical prose changed only.",
        }),
      }]),
    ])).assessment;
    assert.equal(canonical.authorityImpact.level, "canonical-content");

    const supporting = runAssessment(fixture.inspection, proposal([
      operation("supporting-create", "note.create", [{
        path: "knowledge/references/evidence.md",
        before: null,
        after: currentNote({
          id: "reference-evidence",
          kind: "reference",
          title: "External evidence",
          summary: "Supporting evidence with a unique subject.",
        }),
      }]),
    ])).assessment;
    assert.equal(supporting.authorityImpact.level, "supporting");

    const historical = runAssessment(fixture.inspection, proposal([
      operation("historical-create", "session.record", [{
        path: "knowledge/sessions/history.md",
        before: null,
        after: currentNote({
          id: "session-history",
          kind: "session",
          title: "Historical session",
          summary: "A unique historical session record.",
        }),
      }]),
    ])).assessment;
    assert.equal(historical.authorityImpact.level, "none");

    const decisionPath = "knowledge/decisions/accept.md";
    const disguisedAuthority = runAssessment(fixture.inspection, proposal([
      operation("generic-decision-update", "note.update", [{
        path: decisionPath,
        before: fixture.notes.get(decisionPath),
        after: currentNote({
          id: "decision-accept",
          kind: "decision",
          title: "Accept decision",
          decisionKey: "accept-choice",
          state: "accepted",
        }),
      }]),
    ])).assessment;
    assert.equal(disguisedAuthority.authorityImpact.level, "authority-changing");
    assert.ok(disguisedAuthority.authorityImpact.reasons.some(
      (reason) => /authority topology|decision/u.test(reason),
    ));
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

test("decision.accept prior hashes distinguish true creation from existing-note transition", async () => {
  const fixture = await baseFixture();
  try {
    const existingPath = "knowledge/decisions/accept.md";
    const existingAfter = currentNote({
      id: "decision-accept",
      kind: "decision",
      title: "Accept decision",
      decisionKey: "accept-choice",
      state: "accepted",
    });
    const missingExistingBinding = operation("accept-existing-unbound", "decision.accept", [{
      path: existingPath,
      before: fixture.notes.get(existingPath),
      after: existingAfter,
    }]);
    missingExistingBinding.declaration.changes[0].expectedPriorSha256 = null;
    assert.throws(
      () => {
        const packageValue = proposal([missingExistingBinding]);
        const projection = validateProjectedGraph(fixture.inspection, packageValue.changes);
        assessProposalSemantics(
          packageValue.input,
          fixture.inspection,
          packageValue.changes,
          projection,
        );
      },
      /existing-note operation lacks its exact prior hash binding/,
    );

    const createdPath = "knowledge/decisions/new-accept.md";
    const falseExistingBinding = operation("accept-create-prebound", "decision.accept", [{
      path: createdPath,
      before: null,
      after: currentNote({
        id: "decision-new-accept",
        kind: "decision",
        title: "New accepted decision",
        decisionKey: "new-choice",
        state: "accepted",
      }),
    }]);
    falseExistingBinding.declaration.changes[0].expectedPriorSha256 =
      taggedContentSha256("not-present");
    assert.throws(
      () => {
        const packageValue = proposal([falseExistingBinding]);
        const projection = validateProjectedGraph(fixture.inspection, packageValue.changes);
        assessProposalSemantics(
          packageValue.input,
          fixture.inspection,
          packageValue.changes,
          projection,
        );
      },
      /create operation is not bound to an absent current path/,
    );
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

test("created-note duplicate candidates are deterministic, unique, and bounded to twenty", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "syncora-semantics-duplicates-"));
  try {
    await writeGraphNote(
      workspace,
      "index.md",
      currentNote({ id: "atlas-root", kind: "atlas", title: "Atlas" }),
    );
    for (let index = 0; index < 25; index += 1) {
      const suffix = String(index).padStart(2, "0");
      await writeGraphNote(
        workspace,
        `knowledge/concepts/cache-${suffix}.md`,
        currentNote({
          id: `concept-cache-${suffix}`,
          kind: "concept",
          title: "Shared Cache Strategy",
          summary: `Existing cache candidate ${suffix}.`,
        }),
      );
    }
    const inspection = await inspectWorkspace({ workspace });
    const packageValue = proposal([
      operation("create-cache-strategy", "note.create", [{
        path: "knowledge/concepts/cache-new.md",
        before: null,
        after: currentNote({
          id: "concept-cache-new",
          kind: "concept",
          title: "Shared Cache Strategy",
          summary: "New cache strategy proposal.",
        }),
      }]),
    ]);
    const projection = validateProjectedGraph(inspection, packageValue.changes);
    const first = assessProposalSemantics(
      packageValue.input,
      inspection,
      packageValue.changes,
      projection,
    );
    const second = assessProposalSemantics(
      packageValue.input,
      inspection,
      packageValue.changes,
      projection,
    );

    assert.deepEqual(first.duplicateCandidates, second.duplicateCandidates);
    assert.equal(first.duplicateCandidates.length, 20);
    assert.equal(new Set(first.duplicateCandidates.map((item) => item.path)).size, 20);
    assert.deepEqual(
      first.duplicateCandidates.map((item) => item.path),
      Array.from({ length: 20 }, (_, index) =>
        `knowledge/concepts/cache-${String(index).padStart(2, "0")}.md`),
    );
    assert.ok(first.duplicateCandidates.every((item) => item.similarity === 0.95));
    assert.ok(first.duplicateCandidates.every((item) =>
      item.reason.includes("knowledge/concepts/cache-new.md")));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("duplicate detection fails closed at its deterministic comparison-work bound", async () => {
  const fixture = await baseFixture();
  try {
    const existingCount = Math.floor(
      PROPOSAL_SEMANTICS_POLICY.maximumDuplicateComparisons / 64,
    ) + 1;
    const synthetic = Array.from({ length: existingCount }, (_, index) => {
      const suffix = String(index).padStart(4, "0");
      const path = `knowledge/concepts/shared-${suffix}.md`;
      return parseNoteBytes(
        { path, nonPortablePath: false },
        currentNote({
          id: `concept-shared-${suffix}`,
          kind: "concept",
          title: "Hostile Shared Duplicate Title",
          summary: `Existing bounded-work candidate ${suffix}.`,
        }),
        VALIDATION_POLICY,
        { includeLexicalSource: true },
      );
    });
    const notes = [...fixture.inspection.notes, ...synthetic];
    const inspection = {
      ...fixture.inspection,
      notes,
      report: {
        ...fixture.inspection.report,
        graph: {
          ...fixture.inspection.report.graph,
          revision: graphRevision(notes),
        },
      },
    };
    const packageValue = proposal(Array.from({ length: 64 }, (_, index) =>
      operation(`create-shared-${index}`, "note.create", [{
        path: `knowledge/concepts/new-shared-${index}.md`,
        before: null,
        after: currentNote({
          id: `concept-new-shared-${index}`,
          kind: "concept",
          title: "Hostile Shared Duplicate Title",
          summary: `New bounded-work candidate ${index}.`,
        }),
      }])));
    const projection = validateProjectedGraph(inspection, packageValue.changes);
    assert.equal(projection.ok, true);
    assert.throws(
      () => assessProposalSemantics(
        packageValue.input,
        inspection,
        packageValue.changes,
        projection,
      ),
      (error) =>
        error?.code === "PROPOSAL003" && /comparison work limit/u.test(error.message),
    );
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

test("invalid post-images and projection substitution fail closed with PROPOSAL003", async () => {
  const fixture = await baseFixture();
  try {
    const invalidPackage = proposal([
      operation("unresolved-link", "note.create", [{
        path: "knowledge/concepts/unresolved.md",
        before: null,
        after: currentNote({
          id: "concept-unresolved",
          kind: "concept",
          body: "[[does-not-exist]]",
        }),
      }]),
    ]);
    const invalidProjection = validateProjectedGraph(
      fixture.inspection,
      invalidPackage.changes,
    );
    assert.equal(invalidProjection.ok, false);
    assert.throws(
      () => assessProposalSemantics(
        invalidPackage.input,
        fixture.inspection,
        invalidPackage.changes,
        invalidProjection,
      ),
      (error) => error?.code === "PROPOSAL003" && /post-image/u.test(error.message),
    );

    const validPackage = proposal([
      operation("valid-create", "note.create", [{
        path: "knowledge/concepts/valid.md",
        before: null,
        after: currentNote({ id: "concept-valid", kind: "concept" }),
      }]),
    ]);
    const validProjection = validateProjectedGraph(fixture.inspection, validPackage.changes);
    const substituted = [{
      ...validPackage.changes[0],
      after: currentNote({ id: "concept-substituted", kind: "concept" }),
    }];
    assert.throws(
      () => assessProposalSemantics(
        validPackage.input,
        fixture.inspection,
        substituted,
        validProjection,
      ),
      (error) => error?.code === "PROPOSAL003",
    );
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});
