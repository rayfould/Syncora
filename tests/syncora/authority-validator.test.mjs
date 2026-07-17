import assert from "node:assert/strict";
import test from "node:test";

import { applyAuthorityValidation } from "../../skills/syncora/scripts/lib/authority-validator.mjs";

const POLICY = Object.freeze({
  maxHubCharacters: 12_000,
  maxHubLinks: 64,
});

function authorityNote({
  path,
  id,
  kind = "concept",
  scope = "workspace",
  state = "active",
  decisionKey = undefined,
  supersedes = [],
  supersededBy = [],
}) {
  return {
    path,
    currentSchema: true,
    authorityClass: "pending",
    characterLength: 0,
    links: [],
    diagnostics: [],
    frontmatter: {
      id,
      kind,
      scope,
      state,
      authority: "canonical",
      ...(decisionKey === undefined ? {} : { decision_key: decisionKey }),
      supersedes,
      superseded_by: supersededBy,
    },
  };
}

function diagnostic(note, code, message = undefined) {
  return note.diagnostics.find(
    (item) => item.code === code && (message === undefined || item.message === message),
  );
}

test("small authority path diagnostics retain their existing paths shape", () => {
  const notes = [
    authorityNote({ path: "knowledge/concepts/a.md", id: "duplicate" }),
    authorityNote({ path: "knowledge/concepts/b.md", id: "duplicate" }),
  ];

  applyAuthorityValidation(notes, POLICY);

  assert.deepEqual(diagnostic(notes[0], "ID001").details, {
    paths: ["knowledge/concepts/a.md", "knowledge/concepts/b.md"],
  });
  assert.strictEqual(
    diagnostic(notes[0], "ID001").details,
    diagnostic(notes[1], "ID001").details,
  );
});

test("large duplicate authority diagnostics use shared deterministic bounded path evidence", () => {
  function fixture(order) {
    return order.map((index) => authorityNote({
      path: `knowledge/concepts/${String(index).padStart(3, "0")}-${"x".repeat(300)}.md`,
      id: "large-duplicate",
    }));
  }
  const indexes = Array.from({ length: 256 }, (_, index) => index);
  const forward = fixture(indexes);
  const reverse = fixture([...indexes].reverse());

  applyAuthorityValidation(forward, POLICY);
  applyAuthorityValidation(reverse, POLICY);

  const details = diagnostic(forward[0], "ID001").details;
  assert.equal(details.paths.length, 16);
  assert.equal(details.pathsTotal, 256);
  assert.equal(details.pathsTruncated, true);
  assert.equal(details.pathsOmitted, 240);
  assert.equal(details.pathValuesTruncated, 256);
  assert.equal(details.pathsLimit, 16);
  assert.equal(details.pathCharactersLimit, 256);
  assert.ok(details.paths.every((path) => Array.from(path).length <= 256));
  assert.deepEqual(details, diagnostic(reverse[0], "ID001").details);
  assert.ok(JSON.stringify(details).length < 5_000);
  for (const note of forward) {
    assert.strictEqual(diagnostic(note, "ID001").details, details);
  }
});

test("hub, decision-key, ambiguous-reference, and cycle path evidence is bounded", () => {
  const hubs = Array.from({ length: 20 }, (_, index) => authorityNote({
    path: `knowledge/projects/${String(index).padStart(2, "0")}.md`,
    id: `hub-${index}`,
    kind: "project",
  }));
  const accepted = Array.from({ length: 20 }, (_, index) => authorityNote({
    path: `knowledge/decisions/accepted-${String(index).padStart(2, "0")}.md`,
    id: `accepted-${index}`,
    kind: "decision",
    state: "accepted",
    decisionKey: "shared-key",
  }));
  const ambiguous = Array.from({ length: 20 }, (_, index) => authorityNote({
    path: `knowledge/decisions/ambiguous-${String(index).padStart(2, "0")}.md`,
    id: `ambiguous-${index}`,
    kind: "decision",
    state: "proposed",
    decisionKey: "ambiguous-key",
  }));
  const source = authorityNote({
    path: "knowledge/decisions/source.md",
    id: "source",
    kind: "decision",
    state: "proposed",
    decisionKey: "source-key",
    supersedes: ["ambiguous-key"],
  });
  const cycle = Array.from({ length: 20 }, (_, index) => {
    const next = (index + 1) % 20;
    const previous = (index + 19) % 20;
    return authorityNote({
      path: `knowledge/decisions/cycle-${String(index).padStart(2, "0")}.md`,
      id: `cycle-${index}`,
      kind: "decision",
      state: "proposed",
      decisionKey: `cycle-key-${index}`,
      supersedes: [`cycle-${next}`],
      supersededBy: [`cycle-${previous}`],
    });
  });

  applyAuthorityValidation([...hubs, ...accepted, ...ambiguous, source, ...cycle], POLICY);

  const hub = diagnostic(hubs[0], "HUB001").details;
  const decision = diagnostic(accepted[0], "AUTH002").details;
  const ambiguousReference = diagnostic(
    source,
    "AUTH003",
    "Supersedes is ambiguous within the decision scope.",
  ).details;
  const cycleDetails = diagnostic(
    cycle[0],
    "AUTH003",
    "Decision supersession contains a cycle.",
  ).details;
  for (const details of [hub, decision, ambiguousReference, cycleDetails]) {
    assert.equal(details.paths.length, 16);
    assert.equal(details.pathsTruncated, true);
    assert.ok(details.pathsTotal >= 20);
  }
  assert.equal(cycleDetails.pathsTotal, 21);
});

test("deep acyclic supersession chains validate without recursive stack growth", () => {
  const count = 5_000;
  const decisions = Array.from({ length: count }, (_, index) => authorityNote({
    path: `knowledge/decisions/deep-${String(index).padStart(4, "0")}.md`,
    id: `deep-${index}`,
    kind: "decision",
    state: "proposed",
    decisionKey: `deep-key-${index}`,
    supersedes: index + 1 < count ? [`deep-${index + 1}`] : [],
    supersededBy: index > 0 ? [`deep-${index - 1}`] : [],
  }));

  applyAuthorityValidation(decisions, POLICY);

  assert.ok(decisions.every((note) => note.authorityClass === "canonical"));
  assert.ok(decisions.every((note) => diagnostic(note, "AUTH003") === undefined));
});
