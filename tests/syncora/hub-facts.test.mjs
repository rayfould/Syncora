import assert from "node:assert/strict";
import test from "node:test";

import {
  HubFactError,
  taggedHubFactSha256,
  upsertHubFact,
} from "../../skills/syncora/scripts/lib/hub-facts.mjs";

const HUB = [
  "---",
  "id: project-workspace",
  "kind: project",
  "scope: workspace",
  "state: active",
  "authority: canonical",
  "schema_version: 1",
  "created: 2026-08-04",
  "updated: 2026-08-04",
  "summary: Workspace fixture.",
  "---",
  "",
  "# Workspace",
  "",
  "Existing human-authored hub content.",
  "",
].join("\n");

test("an absent fact appends one isolated Syncora facts container", () => {
  const updated = upsertHubFact(HUB, {
    key: "promotion:branch-a",
    expectedSha256: null,
    afterText: "Branch A promoted the runtime fix.\n",
  });

  assert.ok(updated.startsWith(HUB));
  assert.match(updated, /## Syncora facts/u);
  assert.match(updated, /key="promotion:branch-a"/u);
});

test("different keyed facts merge without replacing prior hub content", () => {
  const first = upsertHubFact(HUB, {
    key: "promotion:branch-a",
    expectedSha256: null,
    afterText: "Branch A promoted the runtime fix.\n",
  });
  const second = upsertHubFact(first, {
    key: "promotion:branch-b",
    expectedSha256: null,
    afterText: "Branch B promoted the test coverage.\n",
  });

  assert.match(second, /Existing human-authored hub content\./u);
  assert.match(second, /promotion:branch-a/u);
  assert.match(second, /promotion:branch-b/u);
});

test("a targeted fact requires its exact prior fact hash", () => {
  const firstText = "Branch A promoted the runtime fix.\n";
  const first = upsertHubFact(HUB, {
    key: "promotion:branch-a",
    expectedSha256: null,
    afterText: firstText,
  });
  const updated = upsertHubFact(first, {
    key: "promotion:branch-a",
    expectedSha256: taggedHubFactSha256(firstText),
    afterText: "Branch A promoted the final runtime fix.\n",
  });
  assert.match(updated, /final runtime fix/u);

  assert.throws(
    () => upsertHubFact(updated, {
      key: "promotion:branch-a",
      expectedSha256: taggedHubFactSha256(firstText),
      afterText: "Stale replacement.\n",
    }),
    HubFactError,
  );
});

test("unkeyed content inside a facts container fails closed", () => {
  const malformed = `${HUB}\n${"<!-- syncora:facts -->"}\nUnkeyed\n<!-- /syncora:facts -->\n`;
  assert.throws(
    () => upsertHubFact(malformed, {
      key: "promotion:branch-a",
      expectedSha256: null,
      afterText: "A fact.\n",
    }),
    HubFactError,
  );
});
