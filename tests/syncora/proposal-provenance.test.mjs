import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  verifyProposalSourceReferences,
} from "../../skills/syncora/scripts/lib/proposal-provenance.mjs";
import {
  PROPOSAL_POLICY,
  taggedContentSha256,
} from "../../skills/syncora/scripts/lib/proposal-schema.mjs";

async function fixture() {
  const workspacePath = await mkdtemp(join(tmpdir(), "syncora-provenance-"));
  const graphRoot = join(workspacePath, "local");
  const sourceBytes = Buffer.from("const governed = true;\n", "utf8");
  const noteBytes = Buffer.from("# Bound note\n\nExact local evidence.\n", "utf8");
  await mkdir(join(workspacePath, "src"), { recursive: true });
  await mkdir(join(graphRoot, "knowledge", "concepts"), { recursive: true });
  await writeFile(join(workspacePath, "src", "context.ts"), sourceBytes);
  await writeFile(
    join(graphRoot, "knowledge", "concepts", "context.md"),
    noteBytes,
  );
  return {
    workspacePath,
    graphRoot,
    sourceBytes,
    noteBytes,
    environment: { workspacePath, graphRoot },
  };
}

function proposal(sourceRefs) {
  return {
    operations: [{
      operationId: "verify-provenance",
      sourceRefs,
    }],
  };
}

test("local proposal provenance is verified once per normalized binding", async () => {
  const context = await fixture();
  try {
    const file = {
      type: "file",
      ref: "src/context.ts",
      expectedSha256: taggedContentSha256(context.sourceBytes),
    };
    const note = {
      type: "note",
      ref: "knowledge/concepts/context.md",
      expectedSha256: taggedContentSha256(context.noteBytes),
    };
    const result = await verifyProposalSourceReferences(
      context.environment,
      proposal([
        file,
        { ...file },
        note,
        { type: "user", ref: "current-task:request", expectedSha256: null },
        { type: "operation", ref: "task:42", expectedSha256: null },
      ]),
    );

    assert.deepEqual(result, {
      references: 5,
      uniqueReferences: 4,
      bound: 3,
      verified: 3,
      uniqueVerified: 2,
      verifiedBytes: context.sourceBytes.length + context.noteBytes.length,
      cacheHits: 1,
      unresolved: 0,
    });
  } finally {
    await rm(context.workspacePath, { recursive: true, force: true });
  }
});

test("conflicting, stale, and unverifiable provenance bindings fail closed", async (t) => {
  const context = await fixture();
  try {
    await t.test("conflicting normalized binding", async () => {
      await assert.rejects(
        verifyProposalSourceReferences(context.environment, proposal([
          {
            type: "file",
            ref: "src/context.ts",
            expectedSha256: taggedContentSha256(context.sourceBytes),
          },
          {
            type: "file",
            ref: "src/context.ts",
            expectedSha256: taggedContentSha256("different"),
          },
        ])),
        /conflicting digest bindings/,
      );
    });

    await t.test("stale local bytes", async () => {
      await assert.rejects(
        verifyProposalSourceReferences(context.environment, proposal([{
          type: "note",
          ref: "knowledge/concepts/context.md",
          expectedSha256: taggedContentSha256("stale"),
        }])),
        /provenance changed/,
      );
    });

    await t.test("digest claim for unresolved type", async () => {
      await assert.rejects(
        verifyProposalSourceReferences(context.environment, proposal([{
          type: "user",
          ref: "current-task:request",
          expectedSha256: taggedContentSha256("claim"),
        }])),
        /cannot claim locally verified digests/,
      );
    });
  } finally {
    await rm(context.workspacePath, { recursive: true, force: true });
  }
});

test("oversized provenance files are rejected from metadata before unbounded reads", async () => {
  const context = await fixture();
  try {
    const oversizedPath = join(context.workspacePath, "src", "oversized.bin");
    await mkdir(dirname(oversizedPath), { recursive: true });
    await writeFile(oversizedPath, Buffer.alloc(0));
    await truncate(oversizedPath, PROPOSAL_POLICY.maximumSourceFileBytes + 1);
    await assert.rejects(
      verifyProposalSourceReferences(context.environment, proposal([{
        type: "file",
        ref: "src/oversized.bin",
        expectedSha256: taggedContentSha256("unreachable"),
      }])),
      /exceeds 16777216 bytes/,
    );
  } finally {
    await rm(context.workspacePath, { recursive: true, force: true });
  }
});
