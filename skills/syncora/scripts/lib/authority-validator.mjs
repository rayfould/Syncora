function addFinding(note, code, message, details = undefined) {
  note.diagnostics.push({
    code,
    severity: "error",
    message,
    path: note.path,
    quarantined: true,
    ...(details === undefined ? {} : { details }),
  });
  note.authorityClass = "quarantined";
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
    const matches = byId.get(note.frontmatter.id) ?? [];
    matches.push(note);
    byId.set(note.frontmatter.id, matches);
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
    const matches = hubsByScope.get(note.frontmatter.scope) ?? [];
    matches.push(note);
    hubsByScope.set(note.frontmatter.scope, matches);
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

function applyDecisionChecks(notes) {
  const acceptedByKey = new Map();
  const decisions = notes.filter(
    (item) =>
      item.currentSchema &&
      item.authorityClass === "canonical" &&
      item.frontmatter.kind === "decision",
  );
  for (const note of decisions.filter((item) => item.frontmatter.state === "accepted")) {
    const key = `${note.frontmatter.scope}\u0000${note.frontmatter.decision_key}`;
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

  const identity = new Map();
  for (const note of decisions) {
    identity.set(note.frontmatter.id, note);
    identity.set(note.frontmatter.decision_key, note);
  }
  const edges = new Map();
  for (const note of decisions) {
    const targets = [];
    for (const reference of note.frontmatter.supersedes ?? []) {
      const target = identity.get(reference);
      if (!target) {
        addFinding(note, "AUTH003", "Supersedes references an unknown current-schema decision.", {
          target: reference,
        });
        continue;
      }
      if (target === note) {
        addFinding(note, "AUTH003", "A decision cannot supersede itself.");
        continue;
      }
      targets.push(target);
    }
    edges.set(note, targets);
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
