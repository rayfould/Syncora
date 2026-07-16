export const AUTHORITY_SEMANTICS = Object.freeze({
  specification: "syncora-authority-semantics-v1.1",
  identityNormalization: "nfc-case-folded",
  supersessionResolution: "scope-local-id-or-decision-key",
  reciprocalSupersession: true,
});

function normalizedIdentity(value) {
  return value.normalize("NFC").toLowerCase();
}

function normalizedScope(note) {
  return normalizedIdentity(note.frontmatter.scope);
}

function addFinding(note, code, message, details = undefined) {
  const fingerprint = `${code}\0${message}\0${JSON.stringify(details ?? null)}`;
  const duplicate = note.diagnostics.some(
    (item) =>
      `${item.code}\0${item.message}\0${JSON.stringify(item.details ?? null)}` ===
      fingerprint,
  );
  if (!duplicate) {
    note.diagnostics.push({
      code,
      severity: "error",
      message,
      path: note.path,
      quarantined: true,
      ...(details === undefined ? {} : { details }),
    });
  }
  note.authorityClass = "quarantined";
}

function addFindingPair(left, right, code, message, details) {
  addFinding(left, code, message, details);
  addFinding(right, code, message, details);
}

function expectedAuthorityClass(note) {
  const kind = note.frontmatter.kind;
  const authority = note.frontmatter.authority;
  if (kind === "atlas" && authority === "canonical") return "routing";
  if (["project", "decision", "concept"].includes(kind) && authority === "canonical") {
    return "canonical";
  }
  if (kind === "reference" && authority === "supporting") return "supporting";
  if (kind === "session" && authority === "historical") return "historical";
  if (kind === "inbox" && authority === "transient") return "transient";
  return null;
}

function applyDuplicateIdentityChecks(notes) {
  const byId = new Map();
  for (const note of notes.filter((item) => item.currentSchema)) {
    const key = normalizedIdentity(note.frontmatter.id);
    const matches = byId.get(key) ?? [];
    matches.push(note);
    byId.set(key, matches);
  }
  for (const matches of byId.values()) {
    if (matches.length < 2) continue;
    const paths = matches.map((item) => item.path).sort();
    for (const note of matches) {
      addFinding(note, "ID001", "Current-schema note ID is not unique.", { paths });
    }
  }
}

function applyHubChecks(notes, policy) {
  const hubsByScope = new Map();
  for (const note of notes.filter(
    (item) =>
      item.currentSchema &&
      item.authorityClass === "canonical" &&
      item.frontmatter.kind === "project" &&
      item.frontmatter.state === "active",
  )) {
    const scope = normalizedScope(note);
    const matches = hubsByScope.get(scope) ?? [];
    matches.push(note);
    hubsByScope.set(scope, matches);
    if (note.characterLength > policy.maxHubCharacters || note.links.length > policy.maxHubLinks) {
      addFinding(note, "HUB002", "Canonical hub exceeds its size or link ceiling.", {
        characters: note.characterLength,
        links: note.links.length,
        maxCharacters: policy.maxHubCharacters,
        maxLinks: policy.maxHubLinks,
      });
    }
  }
  for (const [scope, matches] of hubsByScope) {
    if (matches.length < 2) continue;
    const paths = matches.map((item) => item.path).sort();
    for (const note of matches) {
      addFinding(note, "HUB001", "More than one active canonical hub exists for a scope.", {
        scope,
        paths,
      });
    }
  }
}

function aliasesFor(decision) {
  return new Set(
    [decision.frontmatter.id, decision.frontmatter.decision_key].map(
      normalizedIdentity,
    ),
  );
}

function scopedAlias(scope, alias) {
  return `${scope}\0${normalizedIdentity(alias)}`;
}

function buildDecisionIdentity(decisions) {
  const identity = new Map();
  for (const decision of decisions) {
    const scope = normalizedScope(decision);
    for (const alias of aliasesFor(decision)) {
      const key = `${scope}\0${alias}`;
      const matches = identity.get(key) ?? new Set();
      matches.add(decision);
      identity.set(key, matches);
    }
  }
  return identity;
}

function resolveDecisionReference(note, reference, identity, relation) {
  const matches = [
    ...(identity.get(scopedAlias(normalizedScope(note), reference)) ?? []),
  ].sort((left, right) => left.path.localeCompare(right.path));
  if (matches.length === 0) {
    addFinding(
      note,
      "AUTH003",
      `${relation} references an unknown decision in the same scope.`,
      { target: reference },
    );
    return null;
  }
  if (matches.length > 1) {
    addFinding(
      note,
      "AUTH003",
      `${relation} is ambiguous within the decision scope.`,
      { target: reference, paths: matches.map((item) => item.path) },
    );
    return null;
  }
  if (matches[0] === note) {
    addFinding(note, "AUTH003", "A decision cannot supersede itself.");
    return null;
  }
  return matches[0];
}

function relationReferencesDecision(references, target) {
  const targetAliases = aliasesFor(target);
  return (references ?? []).some((reference) =>
    targetAliases.has(normalizedIdentity(reference)),
  );
}

function applyDecisionChecks(notes) {
  const acceptedByKey = new Map();
  const decisions = notes.filter(
    (item) =>
      item.currentSchema &&
      item.authorityClass === "canonical" &&
      item.frontmatter.kind === "decision",
  );
  for (const note of decisions.filter((item) => item.frontmatter.state === "accepted")) {
    const key = `${normalizedScope(note)}\0${normalizedIdentity(note.frontmatter.decision_key)}`;
    const matches = acceptedByKey.get(key) ?? [];
    matches.push(note);
    acceptedByKey.set(key, matches);
  }
  for (const matches of acceptedByKey.values()) {
    if (matches.length < 2) continue;
    const paths = matches.map((item) => item.path).sort();
    for (const note of matches) {
      addFinding(note, "AUTH002", "Multiple accepted decisions share one scope and decision key.", {
        scope: note.frontmatter.scope,
        decisionKey: note.frontmatter.decision_key,
        paths,
      });
    }
  }

  const identity = buildDecisionIdentity(decisions);
  const edges = new Map();
  for (const note of decisions) {
    const targets = [];
    for (const reference of note.frontmatter.supersedes ?? []) {
      const target = resolveDecisionReference(
        note,
        reference,
        identity,
        "Supersedes",
      );
      if (!target) continue;
      targets.push(target);
      if (!relationReferencesDecision(target.frontmatter.superseded_by, note)) {
        addFindingPair(
          note,
          target,
          "AUTH003",
          "Decision supersession must be declared reciprocally.",
          { superseding: note.path, superseded: target.path },
        );
      }
    }
    edges.set(note, [...new Set(targets)]);

    for (const reference of note.frontmatter.superseded_by ?? []) {
      const successor = resolveDecisionReference(
        note,
        reference,
        identity,
        "Superseded-by",
      );
      if (!successor) continue;
      if (!relationReferencesDecision(successor.frontmatter.supersedes, note)) {
        addFindingPair(
          note,
          successor,
          "AUTH003",
          "Decision supersession must be declared reciprocally.",
          { superseding: successor.path, superseded: note.path },
        );
      }
    }
  }

  const visiting = new Set();
  const visited = new Set();
  const stack = [];
  function visit(note) {
    if (visiting.has(note)) {
      const start = stack.indexOf(note);
      const cycle = stack.slice(start).concat(note);
      const paths = cycle.map((item) => item.path);
      for (const item of new Set(cycle)) {
        addFinding(item, "AUTH003", "Decision supersession contains a cycle.", { paths });
      }
      return;
    }
    if (visited.has(note)) return;
    visiting.add(note);
    stack.push(note);
    for (const target of edges.get(note) ?? []) visit(target);
    stack.pop();
    visiting.delete(note);
    visited.add(note);
  }
  for (const note of decisions) visit(note);
}

export function applyAuthorityValidation(notes, policy) {
  for (const note of notes) {
    if (!note.currentSchema) continue;
    const classification = expectedAuthorityClass(note);
    if (classification === null) {
      addFinding(
        note,
        "AUTH001",
        "Note kind and declared authority violate the schema authority ceiling.",
      );
    } else if (note.authorityClass !== "quarantined") {
      note.authorityClass = classification;
    }
  }
  applyDuplicateIdentityChecks(notes);
  applyHubChecks(notes, policy);
  applyDecisionChecks(notes);
  return notes;
}
