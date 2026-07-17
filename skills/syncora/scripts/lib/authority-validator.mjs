export const AUTHORITY_SEMANTICS = Object.freeze({
  specification: "syncora-authority-semantics-v1.1",
  identityNormalization: "nfc-case-folded",
  supersessionResolution: "scope-local-id-or-decision-key",
  reciprocalSupersession: true,
});

const AUTHORITY_DIAGNOSTIC_POLICY = Object.freeze({
  maximumPathExamples: 16,
  maximumPathCharacters: 256,
});

const detailFingerprints = new WeakMap();

function normalizedIdentity(value) {
  return value.normalize("NFC").toLowerCase();
}

function normalizedScope(note) {
  return normalizedIdentity(note.frontmatter.scope);
}

function serializedDetails(details) {
  if (details === undefined) return "null";
  if (details !== null && typeof details === "object") {
    const cached = detailFingerprints.get(details);
    if (cached !== undefined) return cached;
    const serialized = JSON.stringify(details);
    detailFingerprints.set(details, serialized);
    return serialized;
  }
  return JSON.stringify(details);
}

function findingFingerprint(code, message, details) {
  return `${code}\0${message}\0${serializedDetails(details)}`;
}

function portableCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function boundedPath(path) {
  const characters = Array.from(path);
  if (characters.length <= AUTHORITY_DIAGNOSTIC_POLICY.maximumPathCharacters) {
    return { value: path, truncated: false };
  }
  const marker = "…";
  const remaining = AUTHORITY_DIAGNOSTIC_POLICY.maximumPathCharacters - 1;
  const prefixLength = Math.ceil(remaining / 2);
  const suffixLength = Math.floor(remaining / 2);
  return {
    value: `${characters.slice(0, prefixLength).join("")}${marker}${characters.slice(-suffixLength).join("")}`,
    truncated: true,
  };
}

function boundedPathDetails(items, extras = {}) {
  const examples = [];
  let total = 0;
  let truncatedValues = 0;
  for (const item of items) {
    const path = typeof item === "string" ? item : item.path;
    total += 1;
    const bounded = boundedPath(path);
    truncatedValues += Number(bounded.truncated);
    const entry = { sortKey: path, value: bounded.value };
    let insertion = examples.findIndex(
      (example) => portableCompare(entry.sortKey, example.sortKey) < 0,
    );
    if (insertion === -1) insertion = examples.length;
    if (insertion < AUTHORITY_DIAGNOSTIC_POLICY.maximumPathExamples) {
      examples.splice(insertion, 0, entry);
      if (examples.length > AUTHORITY_DIAGNOSTIC_POLICY.maximumPathExamples) {
        examples.pop();
      }
    }
  }
  const paths = examples.map((item) => item.value);
  if (total === paths.length && truncatedValues === 0) {
    return Object.freeze({ ...extras, paths: Object.freeze(paths) });
  }
  return Object.freeze({
    ...extras,
    paths: Object.freeze(paths),
    pathsTotal: total,
    pathsTruncated: true,
    pathsOmitted: Math.max(0, total - paths.length),
    pathValuesTruncated: truncatedValues,
    pathsLimit: AUTHORITY_DIAGNOSTIC_POLICY.maximumPathExamples,
    pathCharactersLimit: AUTHORITY_DIAGNOSTIC_POLICY.maximumPathCharacters,
  });
}

function addFinding(note, code, message, details = undefined) {
  const fingerprint = findingFingerprint(code, message, details);
  const duplicate = note.diagnostics.some(
    (item) => findingFingerprint(item.code, item.message, item.details) === fingerprint,
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
    const details = boundedPathDetails(matches);
    for (const note of matches) {
      addFinding(note, "ID001", "Current-schema note ID is not unique.", details);
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
    const details = boundedPathDetails(matches, { scope });
    for (const note of matches) {
      addFinding(note, "HUB001", "More than one active canonical hub exists for a scope.", details);
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
  const matches = identity.get(scopedAlias(normalizedScope(note), reference)) ?? new Set();
  if (matches.size === 0) {
    addFinding(
      note,
      "AUTH003",
      `${relation} references an unknown decision in the same scope.`,
      { target: reference },
    );
    return null;
  }
  if (matches.size > 1) {
    const details = boundedPathDetails(matches, { target: reference });
    addFinding(
      note,
      "AUTH003",
      `${relation} is ambiguous within the decision scope.`,
      details,
    );
    return null;
  }
  const target = matches.values().next().value;
  if (target === note) {
    addFinding(note, "AUTH003", "A decision cannot supersede itself.");
    return null;
  }
  return target;
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
    const first = matches[0];
    const details = boundedPathDetails(matches, {
      scope: first.frontmatter.scope,
      decisionKey: first.frontmatter.decision_key,
    });
    for (const note of matches) {
      addFinding(note, "AUTH002", "Multiple accepted decisions share one scope and decision key.", details);
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

  const state = new Map();
  const active = [];
  const activeIndex = new Map();
  for (const root of decisions) {
    if ((state.get(root) ?? 0) !== 0) continue;
    state.set(root, 1);
    activeIndex.set(root, active.length);
    active.push(root);
    const frames = [{ note: root, targets: edges.get(root) ?? [], cursor: 0 }];
    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      if (frame.cursor >= frame.targets.length) {
        frames.pop();
        state.set(frame.note, 2);
        activeIndex.delete(frame.note);
        active.pop();
        continue;
      }
      const target = frame.targets[frame.cursor];
      frame.cursor += 1;
      const targetState = state.get(target) ?? 0;
      if (targetState === 0) {
        state.set(target, 1);
        activeIndex.set(target, active.length);
        active.push(target);
        frames.push({ note: target, targets: edges.get(target) ?? [], cursor: 0 });
        continue;
      }
      if (targetState === 1) {
        const start = activeIndex.get(target);
        const cycle = active.slice(start).concat(target);
        const details = boundedPathDetails(cycle);
        for (const item of new Set(cycle)) {
          addFinding(item, "AUTH003", "Decision supersession contains a cycle.", details);
        }
      }
    }
  }
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
