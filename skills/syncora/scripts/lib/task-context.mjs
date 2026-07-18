import { createHash } from "node:crypto";

import { stringifyJson, SyncoraError } from "./cli.mjs";
import { LEXICAL_POLICY } from "./lexical-index.mjs";
import { parseNote } from "./note-parser.mjs";
import { searchWorkspace } from "./search.mjs";
import {
  classifyNoteTargetBindings,
  normalizeTargetSpecifiers,
  prepareTargetSpecifiers,
  resolveNoteTargetBindings,
  TARGET_BINDING_POLICY,
} from "./target-bindings.mjs";
import { inspectWorkspaceUnlocked as inspectWorkspace, VALIDATION_POLICY } from "./validate.mjs";
import {
  requireInitializedWorkspace,
  resolveWorkspace,
  samePath,
} from "./workspace.mjs";
import { withCanonicalReadInterlock } from "./writer-interlock.mjs";

export const TASK_CONTEXT_POLICY = Object.freeze({
  specification: "syncora-task-context-v1",
  reportSchemaVersion: 1,
  modes: Object.freeze(["orient", "implement", "review", "handoff", "history"]),
  defaultMode: "orient",
  defaultBudget: "standard",
  characterBudgets: Object.freeze({
    lean: 4_800,
    standard: 12_000,
    deep: 32_000,
  }),
  minimumBudgetCharacters: 1_000,
  maximumBudgetCharacters: 64_000,
  maximumSelectedItems: 100,
  maximumMandatoryItems: 100,
  maximumWorkingCandidates: 100,
  maximumEvidenceCandidates: 50,
  maximumLexicalCandidates: 50,
  maximumGraphNeighbors: 64,
  maximumBindingEvaluations: 1_000_000,
  maximumBindingWorkCharacters: 16_000_000,
  maximumBindingMatches: 4_096,
  maximumSourceMapOmissions: 32,
  maximumConflicts: 32,
  evidenceBudgetFraction: 0.25,
  maximumMetadataSourceRefs: 4,
  maximumMetadataTargetMatches: 8,
  maximumMetadataValueCharacters: 256,
  maximumErrorExamples: 16,
  minimumOutputCharacters: 20_000,
  maximumOutputCharacters: 128_000,
  outputBudgetMultiplier: 2,
});

const MODE_SET = new Set(TASK_CONTEXT_POLICY.modes);
const CURRENT_STATES = new Set(["active", "accepted", "complete"]);
const CONFLICT_CODES = /^(AUTH|HUB|ID)/u;

function contextError(code, message, details = undefined) {
  return new SyncoraError(code, message, details);
}

function portableCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeIdentity(value) {
  return value.normalize("NFC").toLowerCase();
}

function targetIdentity(kind, ref) {
  return `${kind}\0${ref.normalize("NFC")}`;
}

function characterLength(value) {
  return [...value].length;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function taggedDigest(namespace, value) {
  const hash = createHash("sha256");
  hash.update(`${namespace}\n`, "utf8");
  hash.update(typeof value === "string" ? value : canonicalJson(value), "utf8");
  return `sha256:${hash.digest("hex")}`;
}

function compactMetadataValue(value) {
  const characters = characterLength(value);
  if (characters <= TASK_CONTEXT_POLICY.maximumMetadataValueCharacters) {
    return { value, characters, truncated: false };
  }
  return {
    value: taggedDigest("syncora-context-metadata-value-v1", value),
    characters,
    truncated: true,
  };
}

function compactStringList(values, maximumItems) {
  const selected = values.slice(0, maximumItems).map(compactMetadataValue);
  return {
    values: selected.map((item) => item.value),
    total: values.length,
    truncated:
      values.length > selected.length || selected.some((item) => item.truncated),
  };
}

function boundedErrorList(key, values) {
  const compact = compactStringList(
    values,
    TASK_CONTEXT_POLICY.maximumErrorExamples,
  );
  return {
    [key]: compact.values,
    [`${key}Total`]: compact.total,
    [`${key}Truncated`]: compact.truncated,
  };
}

function compactTargetMatchList(matches) {
  const selected = matches.slice(0, TASK_CONTEXT_POLICY.maximumMetadataTargetMatches)
    .map((match) => {
      const binding = compactMetadataValue(match.bindingSource ?? match.binding);
      const targetRef = compactMetadataValue(match.targetOriginalRef ?? match.targetRef);
      const normalizedTargetRef = compactMetadataValue(match.normalizedTargetRef);
      return {
        binding: binding.value,
        bindingCharacters: match.bindingCharacters ?? binding.characters,
        bindingTruncated: match.bindingTruncated === true || binding.truncated,
        bindingKind: match.bindingKind,
        targetKind: match.targetKind,
        targetRef: targetRef.value,
        targetCharacters: match.targetCharacters ?? targetRef.characters,
        targetTruncated: match.targetTruncated === true || targetRef.truncated,
        normalizedTargetRef: normalizedTargetRef.value,
        normalizedTargetCharacters: normalizedTargetRef.characters,
        normalizedTargetTruncated: normalizedTargetRef.truncated,
        reason: match.reason,
      };
    });
  return {
    values: selected,
    total: matches.length,
    truncated:
      matches.length > selected.length ||
      selected.some(
        (item) =>
          item.bindingTruncated ||
          item.targetTruncated ||
          item.normalizedTargetTruncated,
      ),
  };
}

function compactRequestTarget(target) {
  const original = compactMetadataValue(target.originalRef);
  const normalized = compactMetadataValue(target.ref);
  return {
    kind: target.kind,
    ref: original.value,
    normalizedRef: normalized.value,
    ...(original.truncated
      ? { refCharacters: original.characters, refTruncated: true }
      : {}),
    ...(normalized.truncated
      ? {
          normalizedRefCharacters: normalized.characters,
          normalizedRefTruncated: true,
        }
      : {}),
  };
}

function compactUnboundTarget(target) {
  const original = compactMetadataValue(target.originalRef);
  return {
    kind: target.kind,
    ref: original.value,
    ...(original.truncated
      ? { refCharacters: original.characters, refTruncated: true }
      : {}),
  };
}

function outputCharacterLimit(contextCharacters) {
  return Math.min(
    TASK_CONTEXT_POLICY.maximumOutputCharacters,
    Math.max(
      TASK_CONTEXT_POLICY.minimumOutputCharacters,
      contextCharacters * TASK_CONTEXT_POLICY.outputBudgetMultiplier,
    ),
  );
}

function finalizeOutputBudget(report, contextCharacters) {
  const maximumCharacters = outputCharacterLimit(contextCharacters);
  report.outputBudget = {
    maximumCharacters,
    serializedCharacters: 0,
    counting: "unicode-code-points-in-pretty-json-plus-final-newline",
    overflow: false,
  };
  for (let iteration = 0; iteration < 8; iteration += 1) {
    const next = characterLength(stringifyJson(report)) + 1;
    if (next === report.outputBudget.serializedCharacters) break;
    report.outputBudget.serializedCharacters = next;
  }
  const serializedCharacters = characterLength(stringifyJson(report)) + 1;
  report.outputBudget.serializedCharacters = serializedCharacters;
  if (serializedCharacters > maximumCharacters) {
    throw contextError(
      "CONTEXT_OUTPUT_EXCEEDED",
      "The bounded context report exceeds its total serialized output ceiling.",
      {
        maximumCharacters,
        serializedCharacters,
        renderedContextCharacters: report.budget.usedCharacters,
        selectedItems:
          report.lanes.mandatory.length +
          report.lanes.working.length +
          report.lanes.evidence.length,
        sourceMapItems:
          report.sourceMap.included.length +
          report.sourceMap.omitted.length +
          report.sourceMap.conflicting.length,
      },
    );
  }
  return report;
}

function boundedDiscoveryQuery(request) {
  const text = [
    request.intent,
    ...request.targets.map((target) => target.originalRef),
  ].join(" ").normalize("NFKC").toLowerCase();
  const terms = [];
  const seen = new Set();
  let queryCharacters = 0;
  for (const term of text.match(/[\p{L}\p{N}]+/gu) ?? []) {
    const termCharacters = characterLength(term);
    if (
      seen.has(term) ||
      termCharacters > LEXICAL_POLICY.maxTokenCharacters
    ) continue;
    const separatorCharacters = terms.length === 0 ? 0 : 1;
    if (
      queryCharacters + separatorCharacters + termCharacters >
      LEXICAL_POLICY.maxQueryCharacters
    ) continue;
    seen.add(term);
    terms.push(term);
    queryCharacters += separatorCharacters + termCharacters;
    if (terms.length >= LEXICAL_POLICY.maxQueryTerms) break;
  }
  // Exact target bindings still work for punctuation-only intent. The fallback
  // keeps lexical discovery valid without granting it selection authority.
  return terms.length === 0 ? "context" : terms.join(" ");
}

function normalizeContextConfig(config) {
  const supplied = config?.context;
  if (supplied === undefined) {
    return {
      defaultBudget: TASK_CONTEXT_POLICY.defaultBudget,
      characterBudgets: { ...TASK_CONTEXT_POLICY.characterBudgets },
    };
  }
  if (!supplied || typeof supplied !== "object" || Array.isArray(supplied)) {
    throw contextError("CONFIG001", "Syncora context configuration must be an object.");
  }
  const allowed = new Set(["defaultBudget", "characterBudgets"]);
  const unknown = Object.keys(supplied).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw contextError("CONFIG001", `Unknown context configuration field: ${unknown.sort()[0]}`);
  }
  const budgets = supplied.characterBudgets;
  if (!budgets || typeof budgets !== "object" || Array.isArray(budgets)) {
    throw contextError("CONFIG001", "context.characterBudgets must define lean, standard, and deep.");
  }
  const keys = Object.keys(budgets).sort();
  if (canonicalJson(keys) !== canonicalJson(["deep", "lean", "standard"])) {
    throw contextError("CONFIG001", "context.characterBudgets has missing or unknown presets.");
  }
  const normalized = Object.create(null);
  for (const key of ["lean", "standard", "deep"]) {
    const value = budgets[key];
    if (
      !Number.isSafeInteger(value) ||
      value < TASK_CONTEXT_POLICY.minimumBudgetCharacters ||
      value > TASK_CONTEXT_POLICY.maximumBudgetCharacters
    ) {
      throw contextError("CONFIG001", `Context budget ${key} is outside the supported range.`);
    }
    normalized[key] = value;
  }
  if (!Object.hasOwn(normalized, supplied.defaultBudget)) {
    throw contextError("CONFIG001", "context.defaultBudget must name lean, standard, or deep.");
  }
  return {
    defaultBudget: supplied.defaultBudget,
    characterBudgets: normalized,
  };
}

function resolveBudget(options, config) {
  if (options.maxCharacters !== undefined) {
    if (
      !Number.isSafeInteger(options.maxCharacters) ||
      options.maxCharacters < TASK_CONTEXT_POLICY.minimumBudgetCharacters ||
      options.maxCharacters > TASK_CONTEXT_POLICY.maximumBudgetCharacters
    ) {
      throw contextError(
        "CONTEXT_BUDGET_INVALID",
        `--max-characters must be an integer from ${TASK_CONTEXT_POLICY.minimumBudgetCharacters} through ${TASK_CONTEXT_POLICY.maximumBudgetCharacters}.`,
      );
    }
    return { preset: null, maximumCharacters: options.maxCharacters };
  }
  const preset = options.budget ?? config.defaultBudget;
  if (!Object.hasOwn(config.characterBudgets, preset)) {
    throw contextError(
      "CONTEXT_BUDGET_INVALID",
      "--budget must name lean, standard, or deep.",
    );
  }
  return { preset, maximumCharacters: config.characterBudgets[preset] };
}

function validateRequest(options, config) {
  const intent = typeof options.intent === "string" ? options.intent.trim() : "";
  if (intent.length === 0 || characterLength(intent) > 2_048) {
    throw contextError(
      "CONTEXT_REQUEST_INVALID",
      "Context intent must contain 1 through 2048 characters.",
    );
  }
  const requestedScope = options.scope === undefined
    ? null
    : typeof options.scope === "string"
      ? options.scope.trim()
      : "";
  if (
    requestedScope !== null &&
    (
      requestedScope.length === 0 ||
      characterLength(requestedScope) > 200 ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(requestedScope)
    )
  ) {
    throw contextError("CONTEXT_REQUEST_INVALID", "Context scope is not a bounded portable identifier.");
  }
  const mode = options.mode ?? TASK_CONTEXT_POLICY.defaultMode;
  if (!MODE_SET.has(mode)) {
    throw contextError(
      "CONTEXT_REQUEST_INVALID",
      `Context mode must be one of: ${TASK_CONTEXT_POLICY.modes.join(", ")}.`,
    );
  }
  const targets = normalizeTargetSpecifiers(options.targets ?? []);
  return {
    intent,
    requestedScope,
    scope: null,
    normalizedScope: null,
    scopeResolution: null,
    mode,
    targets,
    budget: resolveBudget(options, config),
  };
}

function resolveRequestScope(request, inspection, allTargetMatches, byPath) {
  if (request.requestedScope !== null) {
    return {
      ...request,
      scope: request.requestedScope,
      normalizedScope: normalizeIdentity(request.requestedScope),
      scopeResolution: "explicit",
    };
  }

  const targetScopes = new Map();
  for (const [path] of allTargetMatches) {
    const note = byPath.get(path);
    if (!note || !isCurrentUsable(note) || typeof note.frontmatter.scope !== "string") continue;
    targetScopes.set(normalizeIdentity(note.frontmatter.scope), note.frontmatter.scope);
  }
  if (targetScopes.size === 1) {
    const scope = [...targetScopes.values()][0];
    return {
      ...request,
      scope,
      normalizedScope: normalizeIdentity(scope),
      scopeResolution: "unique_target_binding",
    };
  }
  if (targetScopes.size > 1) {
    const scopes = [...targetScopes.values()].sort(portableCompare);
    throw contextError(
      "CONTEXT_SCOPE_AMBIGUOUS",
      "Target bindings span multiple scopes; pass --scope explicitly.",
      boundedErrorList("scopes", scopes),
    );
  }

  const hubScopes = new Map(
    inspection.notes
      .filter(
        (note) =>
          note.currentSchema &&
          note.frontmatter.kind === "project" &&
          note.frontmatter.state === "active" &&
          note.authorityClass === "canonical",
      )
      .map((note) => [normalizeIdentity(note.frontmatter.scope), note.frontmatter.scope]),
  );
  if (hubScopes.size !== 1) {
    const scopes = [...hubScopes.values()].sort(portableCompare);
    throw contextError(
      hubScopes.size === 0 ? "CONTEXT_SCOPE_MISSING" : "CONTEXT_SCOPE_AMBIGUOUS",
      hubScopes.size === 0
        ? "No active canonical project hub can resolve context scope."
        : "Multiple active project scopes exist; pass --scope explicitly.",
      boundedErrorList("scopes", scopes),
    );
  }
  const scope = [...hubScopes.values()][0];
  return {
    ...request,
    scope,
    normalizedScope: normalizeIdentity(scope),
    scopeResolution: "single_active_hub",
  };
}

function sourceRefs(note) {
  return Array.isArray(note.frontmatter.source_refs)
    ? note.frontmatter.source_refs.filter((item) => typeof item === "string")
    : [];
}

function isCurrentUsable(note) {
  return (
    note.currentSchema &&
    note.authorityClass !== "quarantined" &&
    typeof note.rawSha256 === "string"
  );
}

function stateEligible(note, mode) {
  if (note.frontmatter.kind === "decision") return note.frontmatter.state === "accepted";
  if (note.frontmatter.kind === "project") return note.frontmatter.state === "active";
  if (note.frontmatter.kind === "concept") return note.frontmatter.state === "active";
  if (note.frontmatter.kind === "reference") return note.frontmatter.state === "active";
  if (note.frontmatter.kind === "session") {
    return ["handoff", "history"].includes(mode) && note.frontmatter.state === "complete";
  }
  return CURRENT_STATES.has(note.frontmatter.state);
}

function targetBindingEligible(note, mode) {
  if (!isCurrentUsable(note) || !stateEligible(note, mode)) return false;
  return ["project", "decision", "concept", "reference", "session"]
    .includes(note.frontmatter.kind);
}

function bindingWorkCharacters(bindings, targetCount, targetCharacters) {
  const bindingCharacters = bindings.reduce(
    (total, value) => total + Math.max(1, characterLength(String(value))),
    0,
  );
  return (
    targetCount * bindingCharacters +
    bindings.length * targetCharacters
  );
}

function noteInScope(note, request) {
  return typeof note.frontmatter.scope === "string" &&
    normalizeIdentity(note.frontmatter.scope) === request.normalizedScope;
}

function normalizedHeadingTitle(value) {
  return normalizeIdentity(value).replace(/\s+/gu, " ").trim();
}

function h2Sections(body) {
  const matches = [];
  let fence = null;
  for (const match of body.matchAll(/[^\r\n]*(?:\r\n|\n|\r|$)/gu)) {
    if (match[0] === "" && match.index === body.length) break;
    const line = match[0].replace(/(?:\r\n|\n|\r)$/u, "");
    const fenceCandidate = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
    if (fence !== null) {
      if (
        fenceCandidate &&
        fenceCandidate[1][0] === fence.character &&
        fenceCandidate[1].length >= fence.length &&
        fenceCandidate[2].trim() === ""
      ) {
        fence = null;
      }
      continue;
    }
    if (fenceCandidate) {
      fence = {
        character: fenceCandidate[1][0],
        length: fenceCandidate[1].length,
      };
      continue;
    }
    const heading = line.match(/^ {0,3}##(?!#)(?:[ \t]+(.*?))?[ \t]*$/u);
    if (!heading) continue;
    const title = (heading[1] ?? "")
      .replace(/[ \t]+#+[ \t]*$/u, "")
      .trim();
    if (title === "") continue;
    matches.push({ index: match.index, title });
  }
  const prefixEnd = matches[0]?.index ?? body.length;
  const prefix = body.slice(0, prefixEnd);
  const sections = matches.map((match, index) => ({
    title: match.title,
    normalizedTitle: normalizedHeadingTitle(match.title),
    content: body.slice(
      match.index,
      matches[index + 1]?.index ?? body.length,
    ),
  }));
  return { prefix, sections };
}

function sectionSlug(value) {
  return normalizeIdentity(value)
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80) || "section";
}

const MODE_HUB_SECTIONS = Object.freeze({
  orient: null,
  implement: new Set([
    "objective",
    "current state",
    "active accepted decisions",
    "work now",
    "blockers",
    "open questions",
    "next actions",
  ]),
  review: new Set([
    "objective",
    "current state",
    "active accepted decisions",
    "blockers",
    "open questions",
  ]),
  handoff: null,
  history: new Set(["objective", "current state", "active accepted decisions"]),
});

const KNOWN_HUB_SECTIONS = new Set([
  "objective",
  "current state",
  "hard constraints",
  "active accepted decisions",
  "work now",
  "blockers",
  "open questions",
  "next actions",
  "expansion links",
]);

function hubFragments(note, body, mode) {
  const parsed = h2Sections(body);
  const mandatory = [];
  const working = [];
  const omitted = [];
  const fragmentCounts = new Map([["header", 1], ["body", 1]]);
  const uniqueFragment = (title) => {
    const base = sectionSlug(title);
    const count = (fragmentCounts.get(base) ?? 0) + 1;
    fragmentCounts.set(base, count);
    return count === 1 ? base : `${base}-${count}`;
  };
  for (const section of parsed.sections) {
    const fragment = uniqueFragment(section.title);
    if (section.normalizedTitle === "hard constraints") {
      mandatory.push({
        fragment,
        content: section.content,
        reason: "scope_hard_constraints",
      });
      continue;
    }
    const selected = MODE_HUB_SECTIONS[mode];
    if (
      selected === null ||
      selected.has(section.normalizedTitle) ||
      !KNOWN_HUB_SECTIONS.has(section.normalizedTitle)
    ) {
      working.push({
        fragment,
        content: section.content,
        reason: `scope_hub_section:${section.normalizedTitle.replaceAll(" ", "_")}`,
      });
    } else {
      omitted.push({
        fragment,
        content: "",
        reason: "mode_filter",
      });
    }
  }
  if (parsed.sections.length === 0 && parsed.prefix.trim() !== "") {
    working.push({ fragment: "body", content: parsed.prefix, reason: "scope_hub" });
  } else if (parsed.prefix.trim() !== "") {
    working.unshift({ fragment: "header", content: parsed.prefix, reason: "scope_hub_header" });
  }
  return { mandatory, working, omitted, note };
}

function controlledConflictItem(note, diagnostic, index) {
  const refs = compactStringList(
    sourceRefs(note),
    TASK_CONTEXT_POLICY.maximumMetadataSourceRefs,
  );
  const serializedDetails = diagnostic.details === undefined
    ? null
    : compactMetadataValue(canonicalJson(diagnostic.details));
  const content = [
    `Conflict code: ${diagnostic.code}`,
    `Source: ${note.path}`,
    `Finding: ${diagnostic.message}`,
    serializedDetails === null
      ? null
      : serializedDetails.truncated
        ? `Details: ${canonicalJson({
            digest: serializedDetails.value,
            characters: serializedDetails.characters,
            truncated: true,
          })}`
        : `Details: ${serializedDetails.value}`,
  ].filter(Boolean).join("\n");
  return {
    key: `conflict:${note.path}:${diagnostic.code}:${index}`,
    sourceId: typeof note.frontmatter.id === "string" ? note.frontmatter.id : null,
    id: `conflict-${index + 1}`,
    kind: "conflict",
    scope: note.frontmatter.scope ?? null,
    authorityClass: "conflicting",
    path: note.path,
    sourceSha256: note.rawSha256 ? `sha256:${note.rawSha256}` : null,
    sourceRefs: refs.values,
    sourceRefsTotal: refs.total,
    sourceRefsTruncated: refs.truncated,
    fragment: diagnostic.code,
    content,
    reasons: ["unresolved_authority_conflict"],
    targetMatches: [],
    score: null,
  };
}

function noteItem(note, content, {
  fragment = null,
  reasons = [],
  targetMatches = [],
  score = null,
} = {}) {
  const refs = compactStringList(
    sourceRefs(note),
    TASK_CONTEXT_POLICY.maximumMetadataSourceRefs,
  );
  const matches = compactTargetMatchList(targetMatches);
  const sourceId = typeof note.frontmatter.id === "string" && note.frontmatter.id !== ""
    ? note.frontmatter.id
    : `legacy:${note.path}`;
  return {
    key: `${note.path}#${fragment ?? "body"}`,
    sourceId,
    id: fragment ? `${sourceId}#${fragment}` : sourceId,
    kind: note.frontmatter.kind ?? "legacy",
    scope: note.frontmatter.scope ?? null,
    authorityClass: note.authorityClass,
    path: note.path,
    sourceSha256: `sha256:${note.rawSha256}`,
    sourceRefs: refs.values,
    sourceRefsTotal: refs.total,
    sourceRefsTruncated: refs.truncated,
    fragment,
    content,
    reasons: [...new Set(reasons)].sort(portableCompare),
    targetMatches: matches.values,
    targetMatchesTotal: matches.total,
    targetMatchesTruncated: matches.truncated,
    score,
  };
}

function renderedItem(item, lane) {
  const boundary = (item.sourceSha256 ?? taggedDigest("syncora-context-boundary-v1", item.key))
    .replace(/^sha256:/u, "")
    .slice(0, 24);
  const header = canonicalJson({
    lane,
    id: item.id,
    kind: item.kind,
    path: item.path,
    reasons: item.reasons,
    sourceSha256: item.sourceSha256,
  });
  const boundarySeparator = item.content.endsWith("\n") ? "" : "\n";
  return `<<<SYNCORA_PROJECT_DATA:${boundary} ${header}>>>\n${item.content}${boundarySeparator}<<<END_SYNCORA_PROJECT_DATA:${boundary}>>>\n`;
}

function compactLaneItem(item, renderedCharacters, startCharacter, endCharacter) {
  return {
    id: item.id,
    sourceId: item.sourceId,
    kind: item.kind,
    scope: item.scope,
    authorityClass: item.authorityClass,
    path: item.path,
    sourceSha256: item.sourceSha256,
    ...(item.sourceRefs?.length > 0
      ? {
          sourceRefs: item.sourceRefs,
          sourceRefsTotal: item.sourceRefsTotal,
          sourceRefsTruncated: item.sourceRefsTruncated,
        }
      : {}),
    fragment: item.fragment,
    reasons: item.reasons,
    ...(item.targetMatches?.length > 0
      ? {
          targetMatches: item.targetMatches,
          targetMatchesTotal: item.targetMatchesTotal,
          targetMatchesTruncated: item.targetMatchesTruncated,
        }
      : {}),
    ...(item.score === null ? {} : { score: item.score }),
    renderedCharacters,
    startCharacter,
    endCharacter,
  };
}

function sourceMapItem(item, status, reason, requestDigest, graphRevision) {
  if (status !== "omitted") {
    return {
      id: item.id,
      path: item.path,
      status,
      reason,
    };
  }
  const compact = {
    id: item.id,
    sourceId: item.sourceId,
    path: item.path,
    kind: item.kind,
    status,
    reason,
    sourceSha256: item.sourceSha256,
  };
  if (status === "omitted") {
    compact.expansionHandle = taggedDigest("syncora-context-expansion-v1", {
      graphRevision,
      id: item.id,
      path: item.path,
      requestDigest,
      sourceSha256: item.sourceSha256,
    });
  }
  return compact;
}

function addCandidate(map, note, priority, reason, targetMatches = [], score = null) {
  const existing = map.get(note.path);
  if (existing) {
    existing.priority = Math.min(existing.priority, priority);
    existing.reasons.add(reason);
    for (const match of targetMatches) {
      existing.targetMatches.set(canonicalJson(match), match);
    }
    if (score !== null) existing.score = Math.max(existing.score ?? -Infinity, score);
    return;
  }
  map.set(note.path, {
    note,
    priority,
    reasons: new Set([reason]),
    targetMatches: new Map(targetMatches.map((match) => [canonicalJson(match), match])),
    score,
  });
}

function sortedCandidates(map) {
  return [...map.values()].sort(
    (left, right) =>
      left.priority - right.priority ||
      ((right.score ?? 0) - (left.score ?? 0)) ||
      portableCompare(left.note.path, right.note.path),
  );
}

async function materializeNotes(inspection, paths, hooks = {}) {
  const files = new Map(inspection.scan.files.map((file) => [file.path, file]));
  const originals = new Map(inspection.notes.map((note) => [note.path, note]));
  const result = new Map();
  let index = 0;
  for (const path of [...new Set(paths)].sort(portableCompare)) {
    const file = files.get(path);
    const original = originals.get(path);
    if (!file || !original) {
      throw contextError("READ001", `Selected context source disappeared: ${path}`);
    }
    await hooks.beforeMaterialize?.({ path, index });
    const parsed = await parseNote(
      file,
      inspection.graph.resolvedGraphPath,
      VALIDATION_POLICY,
      { includeLexicalSource: true },
    );
    if (
      parsed.rawSha256 !== original.rawSha256 ||
      !parsed.lexicalSource ||
      parsed.diagnostics.some((item) => item.code === "READ001")
    ) {
      throw contextError("READ001", `Context source changed while being materialized: ${path}`);
    }
    result.set(path, parsed.lexicalSource.body);
    index += 1;
  }
  return result;
}

async function verifyFinalSnapshot(options, inspection, hooks = {}) {
  await hooks.beforeFinalVerify?.({ inspection });
  const verified = await inspectWorkspace(options);
  if (
    !samePath(verified.graph.resolvedGraphPath, inspection.graph.resolvedGraphPath) ||
    verified.report.graph.revision !== inspection.report.graph.revision
  ) {
    throw contextError("READ001", "Graph changed while task context was being compiled.");
  }
}

function linkedPaths(linkGraph, seeds, eligible) {
  const paths = new Set();
  for (const seed of seeds) {
    for (const [edges, field] of [
      [linkGraph.outgoing.get(seed) ?? [], "targetPath"],
      [linkGraph.backlinks.get(seed) ?? [], "sourcePath"],
    ]) {
      for (const edge of edges) {
        const candidate = edge[field];
        if (
          seeds.has(candidate) ||
          paths.has(candidate) ||
          !eligible(candidate)
        ) continue;
        paths.add(candidate);
        if (paths.size >= TASK_CONTEXT_POLICY.maximumGraphNeighbors) return paths;
      }
    }
  }
  return paths;
}

function itemForCandidate(candidate, bodies) {
  return noteItem(candidate.note, bodies.get(candidate.note.path), {
    reasons: [...candidate.reasons],
    targetMatches: [...candidate.targetMatches.values()],
    score: candidate.score,
  });
}

function metadataItemForCandidate(candidate) {
  return noteItem(candidate.note, "", {
    reasons: [...candidate.reasons],
    targetMatches: [...candidate.targetMatches.values()],
    score: candidate.score,
  });
}

function appendLane({ item, lane, selected, renderedParts, budget, sourceMap, requestDigest, graphRevision }) {
  const rendered = renderedItem(item, lane);
  const cost = characterLength(rendered);
  const used = renderedParts.reduce((total, part) => total + part.characters, 0);
  if (used + cost > budget.maximumCharacters) return false;
  const startCharacter = used;
  renderedParts.push({ value: rendered, characters: cost });
  selected.push(compactLaneItem(item, cost, startCharacter, startCharacter + cost));
  sourceMap.included.push(
    sourceMapItem(item, "included", item.reasons.join(","), requestDigest, graphRevision),
  );
  return true;
}

function reserveOptionalItems(items, lane, maximumCharacters, maximumItems) {
  const selected = [];
  const omitted = [];
  let usedCharacters = 0;
  for (const item of items) {
    const characters = characterLength(renderedItem(item, lane));
    if (selected.length >= maximumItems) {
      omitted.push({ item, reason: "selected_item_limit" });
    } else if (usedCharacters + characters > maximumCharacters) {
      omitted.push({ item, reason: "character_budget" });
    } else {
      selected.push(item);
      usedCharacters += characters;
    }
  }
  return { selected, omitted, usedCharacters };
}

async function compileTaskContextUnlocked(options, hooks = {}, readInterlockCapability) {
  const workspace = await resolveWorkspace(options.workspace);
  const loadedConfig = await requireInitializedWorkspace(workspace.realPath);
  const contextConfig = normalizeContextConfig(loadedConfig);
  let request = validateRequest(options, contextConfig);
  const query = boundedDiscoveryQuery(request);
  const includeHistory = ["handoff", "history"].includes(request.mode);

  const discovery = await searchWorkspace({
    workspace: workspace.realPath,
    query,
    limit: TASK_CONTEXT_POLICY.maximumLexicalCandidates,
    includeHistory,
    noCache: options.noCache === true,
    allowExternalGraphRoot: options.allowExternalGraphRoot,
  }, hooks.searchHooks ?? {}, {
    withValidatedSnapshot: true,
    readInterlockCapability,
  });
  const search = discovery.report;
  const inspection = discovery.inspection;

  const byPath = new Map(inspection.notes.map((note) => [note.path, note]));
  const allTargetMatches = new Map();
  let bindingEvaluations = 0;
  let bindingMatches = 0;
  const targetCharacters = request.targets.reduce(
    (total, target) => total + Math.max(1, characterLength(target.ref)),
    0,
  );
  let bindingWork = targetCharacters;
  const preparedTargets = prepareTargetSpecifiers(request.targets);
  const requestedScopeIdentity = request.requestedScope === null
    ? null
    : normalizeIdentity(request.requestedScope);
  for (const note of inspection.notes) {
    if (!targetBindingEligible(note, request.mode)) continue;
    if (
      requestedScopeIdentity !== null &&
      (
        typeof note.frontmatter.scope !== "string" ||
        normalizeIdentity(note.frontmatter.scope) !== requestedScopeIdentity
      )
    ) continue;
    const bindings = Array.isArray(note.frontmatter.applies_to)
      ? note.frontmatter.applies_to
      : [];
    if (bindings.length === 0 || request.targets.length === 0) continue;
    bindingEvaluations +=
      bindings.length * request.targets.length;
    if (bindingEvaluations > TASK_CONTEXT_POLICY.maximumBindingEvaluations) {
      throw contextError(
        "CONTEXT_LIMIT_EXCEEDED",
        "Typed target binding evaluation exceeds the context safety ceiling.",
        {
          evaluations: bindingEvaluations,
          limit: TASK_CONTEXT_POLICY.maximumBindingEvaluations,
        },
      );
    }
    bindingWork += bindingWorkCharacters(
      bindings,
      request.targets.length,
      targetCharacters,
    );
    if (bindingWork > TASK_CONTEXT_POLICY.maximumBindingWorkCharacters) {
      throw contextError(
        "CONTEXT_LIMIT_EXCEEDED",
        "Typed target binding character work exceeds the context safety ceiling.",
        {
          workCharacters: bindingWork,
          limit: TASK_CONTEXT_POLICY.maximumBindingWorkCharacters,
        },
      );
    }
    const matches = resolveNoteTargetBindings(note, request.targets, preparedTargets);
    bindingMatches += matches.length;
    if (bindingMatches > TASK_CONTEXT_POLICY.maximumBindingMatches) {
      throw contextError(
        "CONTEXT_LIMIT_EXCEEDED",
        "Typed target binding matches exceed the context safety ceiling.",
        {
          matches: bindingMatches,
          limit: TASK_CONTEXT_POLICY.maximumBindingMatches,
        },
      );
    }
    if (matches.length > 0) allTargetMatches.set(note.path, matches);
  }
  request = resolveRequestScope(request, inspection, allTargetMatches, byPath);
  const scopeHubs = inspection.notes.filter(
    (note) =>
      note.currentSchema &&
      note.frontmatter.kind === "project" &&
      note.frontmatter.state === "active" &&
      noteInScope(note, request),
  );
  if (scopeHubs.length !== 1 || scopeHubs[0].authorityClass !== "canonical") {
    const paths = scopeHubs.map((note) => note.path).sort(portableCompare);
    throw contextError(
      scopeHubs.length === 0 ? "CONTEXT_SCOPE_MISSING" : "CONTEXT_SCOPE_AMBIGUOUS",
      scopeHubs.length === 0
        ? `No active canonical project hub exists for scope ${request.scope}.`
        : `Scope ${request.scope} does not resolve to exactly one active canonical project hub.`,
      boundedErrorList("paths", paths),
    );
  }
  const hub = scopeHubs[0];
  request = {
    ...request,
    scope: hub.frontmatter.scope,
    normalizedScope: normalizeIdentity(hub.frontmatter.scope),
  };

  const targetMatches = new Map();
  const boundTargetIdentities = new Set();
  const untypedBindings = [];
  const invalidBindings = [];
  for (const note of inspection.notes) {
    if (!targetBindingEligible(note, request.mode) || !noteInScope(note, request)) continue;
    const matches = allTargetMatches.get(note.path) ?? [];
    if (matches.length > 0) {
      targetMatches.set(note.path, matches);
      for (const match of matches) {
        boundTargetIdentities.add(
          targetIdentity(match.targetKind, match.normalizedTargetRef),
        );
      }
    }
  }

  let untypedBindingNotes = 0;
  let untypedBindingValues = 0;
  let invalidBindingNotes = 0;
  let invalidBindingValues = 0;
  if (request.targets.length > 0) {
    for (const note of inspection.notes) {
      if (!targetBindingEligible(note, request.mode) || !noteInScope(note, request)) continue;
      const bindings = Array.isArray(note.frontmatter.applies_to)
        ? note.frontmatter.applies_to
        : [];
      if (bindings.length === 0) continue;
      const classified = classifyNoteTargetBindings(note);
      if (classified.untyped.length > 0) {
        untypedBindingNotes += 1;
        untypedBindingValues += classified.untyped.length;
        if (untypedBindings.length < 20) {
          untypedBindings.push({
            path: note.path,
            bindings: compactStringList(classified.untyped, 10),
          });
        }
      }
      if (classified.invalid.length > 0) {
        invalidBindingNotes += 1;
        invalidBindingValues += classified.invalid.length;
        if (invalidBindings.length < 20) {
          invalidBindings.push({
            path: note.path,
            bindings: compactStringList(classified.invalid, 10),
          });
        }
      }
    }
  }

  const hubLinked = new Set(
    (inspection.linkGraph.outgoing.get(hub.path) ?? [])
      .map((edge) => edge.targetPath),
  );
  const mandatoryNotes = inspection.notes.filter(
    (note) =>
      isCurrentUsable(note) &&
      noteInScope(note, request) &&
      note.frontmatter.kind === "decision" &&
      note.frontmatter.state === "accepted" &&
      (
        (note.frontmatter.applies_to?.length ?? 0) === 0 ||
        hubLinked.has(note.path) ||
        targetMatches.has(note.path)
      ),
  ).sort((left, right) =>
    portableCompare(left.frontmatter.decision_key, right.frontmatter.decision_key) ||
    portableCompare(left.path, right.path));

  const conflictDiagnostics = [];
  for (const note of inspection.notes.filter((item) => noteInScope(item, request))) {
    for (const diagnostic of note.diagnostics) {
      if (
        diagnostic.severity === "error" &&
        CONFLICT_CODES.test(diagnostic.code)
      ) {
        conflictDiagnostics.push({ note, diagnostic });
        if (conflictDiagnostics.length > TASK_CONTEXT_POLICY.maximumConflicts) break;
      }
    }
    if (conflictDiagnostics.length > TASK_CONTEXT_POLICY.maximumConflicts) break;
  }
  if (conflictDiagnostics.length > TASK_CONTEXT_POLICY.maximumConflicts) {
    throw contextError(
      "CONTEXT_LIMIT_EXCEEDED",
      "Unresolved authority conflicts exceed the mandatory context safety ceiling.",
      {
        conflicts: conflictDiagnostics.length,
        conflictsAtLeast: conflictDiagnostics.length,
        countTruncated: true,
        limit: TASK_CONTEXT_POLICY.maximumConflicts,
      },
    );
  }
  const conflictItems = conflictDiagnostics.map(({ note, diagnostic }, index) =>
    controlledConflictItem(note, diagnostic, index));

  if (mandatoryNotes.length + conflictItems.length > TASK_CONTEXT_POLICY.maximumMandatoryItems) {
    throw contextError(
      "CONTEXT_LIMIT_EXCEEDED",
      "Mandatory context exceeds the selected-item safety ceiling.",
      {
        items: mandatoryNotes.length + conflictItems.length,
        limit: TASK_CONTEXT_POLICY.maximumMandatoryItems,
      },
    );
  }

  const working = new Map();
  const evidence = new Map();
  for (const [path, matches] of targetMatches) {
    const note = byPath.get(path);
    if (!note || !stateEligible(note, request.mode)) continue;
    if (note.frontmatter.kind === "concept") {
      addCandidate(working, note, 10, "target_binding", matches);
    } else if (note.frontmatter.kind === "reference") {
      addCandidate(evidence, note, 10, "target_binding", matches);
    } else if (note.frontmatter.kind === "session" && includeHistory) {
      addCandidate(evidence, note, 15, "target_binding", matches);
    }
  }

  const seedPaths = new Set([hub.path, ...mandatoryNotes.map((note) => note.path)]);
  const graphNeighborEligible = (path) => {
    const note = byPath.get(path);
    return Boolean(
      note &&
      isCurrentUsable(note) &&
      noteInScope(note, request) &&
      stateEligible(note, request.mode) &&
      (
        note.frontmatter.kind === "concept" ||
        note.frontmatter.kind === "reference" ||
        (note.frontmatter.kind === "session" && includeHistory)
      ),
    );
  };
  for (const path of linkedPaths(inspection.linkGraph, seedPaths, graphNeighborEligible)) {
    const note = byPath.get(path);
    if (
      !note ||
      !isCurrentUsable(note) ||
      !noteInScope(note, request) ||
      !stateEligible(note, request.mode)
    ) continue;
    if (note.frontmatter.kind === "concept") {
      addCandidate(working, note, 20, "bounded_graph_neighbor");
    } else if (note.frontmatter.kind === "reference") {
      addCandidate(evidence, note, 20, "bounded_graph_neighbor");
    } else if (note.frontmatter.kind === "session" && includeHistory) {
      addCandidate(evidence, note, 25, "bounded_graph_neighbor");
    }
  }

  for (const [rank, result] of search.results.entries()) {
    const note = byPath.get(result.path);
    const unpromotedHistory =
      request.mode === "history" &&
      note?.authorityClass === "unpromoted" &&
      typeof note.rawSha256 === "string" &&
      noteInScope(note, request);
    if (unpromotedHistory) {
      addCandidate(
        evidence,
        note,
        60 + rank,
        "explicit_history_unpromoted",
        [],
        result.score,
      );
      continue;
    }
    if (
      !note ||
      !isCurrentUsable(note) ||
      !noteInScope(note, request) ||
      !stateEligible(note, request.mode) ||
      mandatoryNotes.some((item) => item.path === note.path)
    ) continue;
    if (note.frontmatter.kind === "concept") {
      addCandidate(working, note, 30 + rank, "lexical_intent_match", [], result.score);
    } else if (note.frontmatter.kind === "reference") {
      addCandidate(evidence, note, 30 + rank, "lexical_intent_match", [], result.score);
    } else if (note.frontmatter.kind === "session" && includeHistory) {
      addCandidate(evidence, note, 40 + rank, "lexical_intent_match", [], result.score);
    }
  }

  const rankedWorkingCandidates = sortedCandidates(working);
  const rankedEvidenceCandidates = sortedCandidates(evidence);
  const workingCandidates = rankedWorkingCandidates.slice(
    0,
    TASK_CONTEXT_POLICY.maximumWorkingCandidates,
  );
  const evidenceCandidates = rankedEvidenceCandidates.slice(
    0,
    TASK_CONTEXT_POLICY.maximumEvidenceCandidates,
  );
  const prunedWorkingCandidates = rankedWorkingCandidates.slice(
    TASK_CONTEXT_POLICY.maximumWorkingCandidates,
  );
  const prunedEvidenceCandidates = rankedEvidenceCandidates.slice(
    TASK_CONTEXT_POLICY.maximumEvidenceCandidates,
  );

  const materializePaths = [
    hub.path,
    ...mandatoryNotes.map((note) => note.path),
    ...workingCandidates.map((candidate) => candidate.note.path),
    ...evidenceCandidates.map((candidate) => candidate.note.path),
  ];
  const bodies = await materializeNotes(inspection, materializePaths, hooks);
  const hubParts = hubFragments(hub, bodies.get(hub.path), request.mode);
  const hubModeOmittedItems = hubParts.omitted.map((fragment) =>
    noteItem(hub, "", {
      fragment: fragment.fragment,
      reasons: [fragment.reason],
    }));
  const mandatoryItems = [
    ...conflictItems,
    ...hubParts.mandatory.map((fragment) =>
      noteItem(hub, fragment.content, {
        fragment: fragment.fragment,
        reasons: [fragment.reason],
      })),
    ...mandatoryNotes.map((note) =>
      noteItem(note, bodies.get(note.path), {
        reasons: [
          ...((note.frontmatter.applies_to?.length ?? 0) === 0
            ? ["scope_wide_accepted_decision"]
            : []),
          ...(hubLinked.has(note.path) ? ["scope_hub_governing_decision"] : []),
          ...(targetMatches.has(note.path) ? ["target_binding"] : []),
        ],
        targetMatches: targetMatches.get(note.path) ?? [],
      })),
  ];
  if (mandatoryItems.length > TASK_CONTEXT_POLICY.maximumMandatoryItems) {
    throw contextError(
      "CONTEXT_LIMIT_EXCEEDED",
      "Mandatory context exceeds the selected-item safety ceiling.",
      { items: mandatoryItems.length, limit: TASK_CONTEXT_POLICY.maximumMandatoryItems },
    );
  }

  const requestForDigest = {
    intent: request.intent,
    scope: request.scope,
    mode: request.mode,
    targets: request.targets.map((target) => ({ kind: target.kind, ref: target.ref })),
    budget: request.budget,
  };
  const requestDigest = taggedDigest("syncora-context-request-v1", requestForDigest);
  const sourceMap = { included: [], omitted: [], conflicting: [] };
  const renderedParts = [];
  const lanes = { mandatory: [], working: [], evidence: [] };

  for (const item of hubModeOmittedItems) {
    if (sourceMap.omitted.length >= TASK_CONTEXT_POLICY.maximumSourceMapOmissions) break;
    sourceMap.omitted.push(
      sourceMapItem(
        item,
        "omitted",
        "mode_filter",
        requestDigest,
        inspection.report.graph.revision,
      ),
    );
  }

  for (const item of mandatoryItems) {
    if (!appendLane({
      item,
      lane: "mandatory",
      selected: lanes.mandatory,
      renderedParts,
      budget: request.budget,
      sourceMap,
      requestDigest,
      graphRevision: inspection.report.graph.revision,
    })) {
      const requiredCharacters = renderedParts.reduce((sum, part) => sum + part.characters, 0) +
        characterLength(renderedItem(item, "mandatory"));
      throw contextError(
        "CONTEXT_BUDGET_EXCEEDED",
        "Mandatory context exceeds the selected character budget and was not truncated.",
        {
          maximumCharacters: request.budget.maximumCharacters,
          requiredCharacters,
          ...boundedErrorList(
            "mandatoryIds",
            mandatoryItems.map((entry) => entry.id),
          ),
        },
      );
    }
  }

  const hubWorkingItems = hubParts.working.map((fragment) =>
    noteItem(hub, fragment.content, {
      fragment: fragment.fragment,
      reasons: [fragment.reason],
    }));
  const explicitRequiredHubItems = hubWorkingItems.filter((item) =>
    item.fragment === "header" || item.fragment === "current-state");
  const requiredHubItems = explicitRequiredHubItems.length > 0
    ? explicitRequiredHubItems
    : hubWorkingItems.slice(0, 1);
  if (requiredHubItems.length === 0) {
    throw contextError(
      "CONTEXT_SCOPE_INVALID",
      "The authoritative scope hub contains no usable Markdown context.",
      { path: hub.path },
    );
  }
  if (
    mandatoryItems.length + requiredHubItems.length >
    TASK_CONTEXT_POLICY.maximumSelectedItems
  ) {
    throw contextError(
      "CONTEXT_LIMIT_EXCEEDED",
      "Required context exceeds the selected-item safety ceiling.",
      {
        items: mandatoryItems.length + requiredHubItems.length,
        limit: TASK_CONTEXT_POLICY.maximumSelectedItems,
      },
    );
  }
  const workingItems = [
    ...hubWorkingItems.filter((item) => !requiredHubItems.includes(item)),
    ...workingCandidates.map((candidate) => itemForCandidate(candidate, bodies)),
  ];
  const evidenceItems = evidenceCandidates
    .map((candidate) => itemForCandidate(candidate, bodies));

  for (const item of requiredHubItems) {
    if (!appendLane({
      item,
      lane: "working",
      selected: lanes.working,
      renderedParts,
      budget: request.budget,
      sourceMap,
      requestDigest,
      graphRevision: inspection.report.graph.revision,
    })) {
      const requiredCharacters = renderedParts.reduce((sum, part) => sum + part.characters, 0) +
        characterLength(renderedItem(item, "working"));
      throw contextError(
        "CONTEXT_BUDGET_EXCEEDED",
        "The authoritative scope hub cannot fit the selected character budget and was not truncated.",
        {
          maximumCharacters: request.budget.maximumCharacters,
          requiredCharacters,
          ...boundedErrorList(
            "requiredIds",
            [...mandatoryItems, ...requiredHubItems].map((entry) => entry.id),
          ),
        },
      );
    }
  }

  // Reserve evidence capacity before optional working material, then publish
  // the conventional mandatory -> working -> evidence order.
  const requiredCharacters = renderedParts.reduce(
    (sum, part) => sum + part.characters,
    0,
  );
  const optionalCharacters = request.budget.maximumCharacters - requiredCharacters;
  const optionalSlots =
    TASK_CONTEXT_POLICY.maximumSelectedItems - lanes.mandatory.length - lanes.working.length;
  const evidenceReservationCharacters = Math.min(
    optionalCharacters,
    Math.floor(request.budget.maximumCharacters * TASK_CONTEXT_POLICY.evidenceBudgetFraction),
  );
  const reservedEvidence = reserveOptionalItems(
    evidenceItems,
    "evidence",
    evidenceReservationCharacters,
    optionalSlots,
  );
  const reservedWorking = reserveOptionalItems(
    workingItems,
    "working",
    optionalCharacters - reservedEvidence.usedCharacters,
    optionalSlots - reservedEvidence.selected.length,
  );

  for (const item of reservedWorking.selected) {
    appendLane({
      item,
      lane: "working",
      selected: lanes.working,
      renderedParts,
      budget: request.budget,
      sourceMap,
      requestDigest,
      graphRevision: inspection.report.graph.revision,
    });
  }
  for (const item of reservedEvidence.selected) {
    appendLane({
      item,
      lane: "evidence",
      selected: lanes.evidence,
      renderedParts,
      budget: request.budget,
      sourceMap,
      requestDigest,
      graphRevision: inspection.report.graph.revision,
    });
  }
  for (const { item, reason } of [
    ...reservedWorking.omitted,
    ...reservedEvidence.omitted,
  ]) {
    if (sourceMap.omitted.length >= TASK_CONTEXT_POLICY.maximumSourceMapOmissions) break;
    sourceMap.omitted.push(
      sourceMapItem(item, "omitted", reason, requestDigest, inspection.report.graph.revision),
    );
  }
  for (const candidate of [
    ...prunedWorkingCandidates,
    ...prunedEvidenceCandidates,
  ]) {
    if (sourceMap.omitted.length >= TASK_CONTEXT_POLICY.maximumSourceMapOmissions) break;
    sourceMap.omitted.push(
      sourceMapItem(
        metadataItemForCandidate(candidate),
        "omitted",
        "candidate_limit",
        requestDigest,
        inspection.report.graph.revision,
      ),
    );
  }

  for (const item of conflictItems) {
    sourceMap.conflicting.push(
      sourceMapItem(item, "conflicting", "unresolved_authority_conflict", requestDigest, inspection.report.graph.revision),
    );
  }

  await verifyFinalSnapshot(options, inspection, hooks);
  const finalConfig = await requireInitializedWorkspace(workspace.realPath);
  if (canonicalJson(finalConfig) !== canonicalJson(loadedConfig)) {
    throw contextError("READ001", "Syncora configuration changed while task context was being compiled.");
  }
  const renderedContext = renderedParts.map((part) => part.value).join("");
  const usedCharacters = characterLength(renderedContext);
  const packId = taggedDigest("syncora-context-pack-v1", {
    graphRevision: inspection.report.graph.revision,
    requestDigest,
    renderedContext,
  });

  const report = {
    reportSchemaVersion: TASK_CONTEXT_POLICY.reportSchemaVersion,
    ok: true,
    command: "context",
    mode: "canonical-read-only",
    compiler: {
      specification: TASK_CONTEXT_POLICY.specification,
      targetBindingSpecification: TARGET_BINDING_POLICY.specification,
    },
    workspace: inspection.workspace.realPath,
    graph: inspection.report.graph,
    contextPackId: packId,
    request: {
      intent: request.intent,
      requestedScope: request.requestedScope,
      scope: request.scope,
      scopeResolution: request.scopeResolution,
      mode: request.mode,
      targets: request.targets.map(compactRequestTarget),
      digest: requestDigest,
    },
    budget: {
      preset: request.budget.preset,
      maximumCharacters: request.budget.maximumCharacters,
      usedCharacters,
      remainingCharacters: request.budget.maximumCharacters - usedCharacters,
      counting: "unicode-code-points-in-renderedContext",
      overflow: false,
    },
    scopeHub: {
      id: hub.frontmatter.id,
      path: hub.path,
      sourceSha256: `sha256:${hub.rawSha256}`,
    },
    lanes,
    renderedContext,
    sourceMap: {
      included: sourceMap.included,
      omitted: sourceMap.omitted,
      conflicting: sourceMap.conflicting,
      stale: [],
      stalenessEvaluation: "unavailable_until_changed_file_drift_detection",
      unboundTargets: request.targets
        .filter((target) => !boundTargetIdentities.has(targetIdentity(target.kind, target.ref)))
        .map(compactUnboundTarget),
      omittedTotal:
        hubModeOmittedItems.length +
        reservedWorking.omitted.length +
        reservedEvidence.omitted.length +
        prunedWorkingCandidates.length +
        prunedEvidenceCandidates.length,
      omissionsTruncated:
        hubModeOmittedItems.length +
        reservedWorking.omitted.length +
          reservedEvidence.omitted.length +
          prunedWorkingCandidates.length +
          prunedEvidenceCandidates.length > sourceMap.omitted.length,
    },
    discovery: {
      lexicalQueryTerms: search.queryTerms,
      lexicalQuery: query,
      lexicalMatches: search.summary.matches,
      lexicalReturned: search.summary.returned,
      cache: search.cache,
      graphNeighborsBound: TASK_CONTEXT_POLICY.maximumGraphNeighbors,
      graphResolvedEdges: inspection.linkGraph.summary.resolvedEdges,
      graphResolvedEdgeBound: VALIDATION_POLICY.maxResolvedLinkEdges,
      graphUniqueReferences: inspection.linkGraph.summary.uniqueReferences,
      graphUniqueReferenceBound: VALIDATION_POLICY.maxUniqueLinkReferences,
      bindingEvaluations,
      bindingEvaluationBound: TASK_CONTEXT_POLICY.maximumBindingEvaluations,
      bindingWorkCharacters: bindingWork,
      bindingWorkCharacterBound: TASK_CONTEXT_POLICY.maximumBindingWorkCharacters,
      bindingMatches,
      bindingMatchBound: TASK_CONTEXT_POLICY.maximumBindingMatches,
    },
    warnings: [
      ...search.warnings,
      ...(untypedBindings.length === 0
        ? []
        : [{
            code: "CONTEXT_BINDING_UNTYPED",
            message: "Untyped applies_to values remained non-selecting review evidence.",
            details: {
              matchingNotes: untypedBindingNotes,
              matchingBindings: untypedBindingValues,
              examples: untypedBindings,
              examplesLimit: 20,
              examplesTruncated: untypedBindingNotes > untypedBindings.length,
            },
          }]),
      ...(invalidBindings.length === 0
        ? []
        : [{
            code: "CONTEXT_BINDING_INVALID",
            message: "Malformed typed applies_to values remained non-selecting review evidence.",
            details: {
              matchingNotes: invalidBindingNotes,
              matchingBindings: invalidBindingValues,
              examples: invalidBindings,
              examplesLimit: 20,
              examplesTruncated: invalidBindingNotes > invalidBindings.length,
            },
          }]),
    ],
  };
  return finalizeOutputBudget(report, request.budget.maximumCharacters);
}

export async function compileTaskContext(options, hooks = {}) {
  return withCanonicalReadInterlock(
    options,
    (readInterlockCapability) =>
      compileTaskContextUnlocked(options, hooks, readInterlockCapability),
  );
}
