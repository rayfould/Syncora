import { SyncoraError } from "./cli.mjs";

export const TARGET_BINDING_POLICY = Object.freeze({
  specification: "syncora-target-bindings-v1",
  maximumTargets: 64,
  maximumReferenceCharacters: 4_096,
  maximumIdentifierCharacters: 512,
  maximumSegments: 128,
  maximumSegmentCharacters: 240,
  maximumReportedReferenceCharacters: 512,
  maximumErrorReferenceCharacters: 160,
});

export const TARGET_KINDS = Object.freeze([
  "file",
  "module",
  "component",
  "path_glob",
  "symbol",
]);

const TARGET_KIND_SET = new Set(TARGET_KINDS);
const UNSAFE_SCALAR_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u;

function targetError(message, details = undefined) {
  return new SyncoraError("CONTEXT_TARGET_INVALID", message, details);
}

function characterLength(value) {
  return [...value].length;
}

function portableCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function boundedErrorValue(value) {
  const text = typeof value === "string" ? value : String(value);
  const maximum = TARGET_BINDING_POLICY.maximumErrorReferenceCharacters;
  return {
    value: text.length > maximum ? text.slice(0, maximum) : text,
    codeUnits: text.length,
    truncated: text.length > maximum,
  };
}

function targetReferenceDetails(value) {
  const bounded = boundedErrorValue(value);
  return {
    targetRef: bounded.value,
    targetRefCodeUnits: bounded.codeUnits,
    targetRefTruncated: bounded.truncated,
  };
}

function isReservedWindowsDeviceName(segment) {
  if (segment.includes("*") || segment.includes("?")) return false;
  const basename = segment.split(".", 1)[0].toUpperCase();
  return (
    basename === "CON" ||
    basename === "PRN" ||
    basename === "AUX" ||
    basename === "NUL" ||
    basename === "CONIN$" ||
    basename === "CONOUT$" ||
    /^COM(?:[1-9]|[\u00b9\u00b2\u00b3])$/u.test(basename) ||
    /^LPT(?:[1-9]|[\u00b9\u00b2\u00b3])$/u.test(basename)
  );
}

function validateGlobGrammar(segments, value) {
  let recursiveSegments = 0;
  for (const segment of segments) {
    if (segment === "**") {
      recursiveSegments += 1;
      if (recursiveSegments > 1) {
        throw targetError("Target glob may contain at most one recursive ** segment.", {
          ...targetReferenceDetails(value),
        });
      }
      continue;
    }

    const firstStar = segment.indexOf("*");
    if (
      segment.includes("**") ||
      (firstStar >= 0 && segment.indexOf("*", firstStar + 1) >= 0)
    ) {
      throw targetError(
        "Target glob permits ** only as one full segment and at most one * per other segment.",
        { ...targetReferenceDetails(value) },
      );
    }
  }
}

function normalizePathReference(value, { glob = false } = {}) {
  if (value.length > TARGET_BINDING_POLICY.maximumReferenceCharacters * 2) {
    throw targetError("Target path must be a bounded workspace-relative portable path.", {
      ...targetReferenceDetails(value),
    });
  }
  const normalized = value.trim().replaceAll("\\", "/").normalize("NFC");
  if (
    normalized.length === 0 ||
    characterLength(normalized) > TARGET_BINDING_POLICY.maximumReferenceCharacters ||
    UNSAFE_SCALAR_PATTERN.test(normalized) ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//u.test(normalized) ||
    normalized.endsWith("/")
  ) {
    throw targetError("Target path must be a bounded workspace-relative portable path.", {
      ...targetReferenceDetails(value),
    });
  }
  const segments = normalized.split("/");
  if (
    segments.length > TARGET_BINDING_POLICY.maximumSegments ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        characterLength(segment) > TARGET_BINDING_POLICY.maximumSegmentCharacters ||
        /[<>:"|]/u.test(segment) ||
        segment.endsWith(".") ||
        segment.endsWith(" ") ||
        isReservedWindowsDeviceName(segment) ||
        (!glob && /[*?\[\]{}]/u.test(segment)) ||
        (glob && /[\[\]{}]/u.test(segment)),
    )
  ) {
    throw targetError("Target path contains an unsafe, excessive, or unsupported segment.", {
      ...targetReferenceDetails(value),
    });
  }
  if (glob) validateGlobGrammar(segments, value);
  return normalized;
}

function normalizeIdentifierReference(value) {
  if (value.length > TARGET_BINDING_POLICY.maximumIdentifierCharacters * 2) {
    throw targetError("Target identifier must be bounded, portable, and whitespace-free.", {
      ...targetReferenceDetails(value),
    });
  }
  const normalized = value.trim().normalize("NFC");
  if (
    normalized.length === 0 ||
    characterLength(normalized) > TARGET_BINDING_POLICY.maximumIdentifierCharacters ||
    UNSAFE_SCALAR_PATTERN.test(normalized) ||
    /\s/u.test(normalized)
  ) {
    throw targetError("Target identifier must be bounded, portable, and whitespace-free.", {
      ...targetReferenceDetails(value),
    });
  }
  return normalized;
}

export function normalizeTargetRef(kind, value) {
  if (!TARGET_KIND_SET.has(kind)) {
    throw targetError("Unsupported target kind.", {
      kind: boundedErrorValue(kind),
      supported: TARGET_KINDS,
    });
  }
  if (typeof value !== "string") {
    throw targetError("Target reference must be text.");
  }
  if (kind === "file" || kind === "module") return normalizePathReference(value);
  if (kind === "path_glob") return normalizePathReference(value, { glob: true });
  return normalizeIdentifierReference(value);
}

export function parseTargetSpecifier(value, label = "--target") {
  if (typeof value !== "string") {
    throw targetError(`${label} must use <kind>:<reference>.`);
  }
  const separator = value.indexOf(":");
  if (separator < 1) {
    throw targetError(`${label} must use <kind>:<reference>.`, {
      supportedKinds: TARGET_KINDS,
    });
  }
  const kind = value.slice(0, separator);
  const originalRef = value.slice(separator + 1);
  const ref = normalizeTargetRef(kind, originalRef);
  return { kind, ref, originalRef };
}

export function normalizeTargetSpecifiers(values) {
  if (!Array.isArray(values) || values.length > TARGET_BINDING_POLICY.maximumTargets) {
    throw targetError(
      `Context targets must contain no more than ${TARGET_BINDING_POLICY.maximumTargets} entries.`,
    );
  }
  const targets = [];
  const seen = new Set();
  for (const value of values) {
    const parsed = parseTargetSpecifier(value);
    const identity = `${parsed.kind}\0${parsed.ref}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    targets.push(parsed);
  }
  return targets;
}

function parseBinding(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const separator = value.indexOf(":");
  if (separator > 0 && TARGET_KIND_SET.has(value.slice(0, separator))) {
    try {
      const parsed = parseTargetSpecifier(value, "applies_to binding");
      return { ...parsed, source: value, legacy: false };
    } catch {
      return null;
    }
  }

  // Schema-v1 allowed opaque applies_to values before typed target bindings
  // existed. Retain exact-ref compatibility without granting kind projection.
  try {
    const ref = normalizePathReference(value);
    return { kind: "legacy", ref, originalRef: value, source: value, legacy: true };
  } catch {
    try {
      const ref = normalizeIdentifierReference(value);
      return { kind: "legacy", ref, originalRef: value, source: value, legacy: true };
    } catch {
      return null;
    }
  }
}

function compileGlobSegment(segment) {
  const star = segment.indexOf("*");
  if (star < 0) {
    return { prefix: [...segment], suffix: [], star: false };
  }
  return {
    prefix: [...segment.slice(0, star)],
    suffix: [...segment.slice(star + 1)],
    star: true,
  };
}

function compilePathGlob(pattern) {
  const segments = pattern.split("/");
  const recursiveIndex = segments.indexOf("**");
  if (recursiveIndex < 0) {
    return {
      prefix: segments.map(compileGlobSegment),
      suffix: [],
      recursive: false,
    };
  }
  return {
    prefix: segments.slice(0, recursiveIndex).map(compileGlobSegment),
    suffix: segments.slice(recursiveIndex + 1).map(compileGlobSegment),
    recursive: true,
  };
}

function compileFileTarget(target) {
  if (target.kind !== "file") return target;
  return {
    ...target,
    pathSegments: target.ref.split("/").map((segment) => [...segment]),
  };
}

export function prepareTargetSpecifiers(targets) {
  return targets.map(compileFileTarget);
}

function matchesGlobCharacter(patternCharacter, targetCharacter) {
  return patternCharacter === "?" || patternCharacter === targetCharacter;
}

function matchGlobSegment(pattern, target) {
  const requiredCharacters = pattern.prefix.length + pattern.suffix.length;
  if (
    (!pattern.star && target.length !== requiredCharacters) ||
    target.length < requiredCharacters
  ) {
    return false;
  }
  for (let index = 0; index < pattern.prefix.length; index += 1) {
    if (!matchesGlobCharacter(pattern.prefix[index], target[index])) return false;
  }
  const suffixStart = target.length - pattern.suffix.length;
  for (let index = 0; index < pattern.suffix.length; index += 1) {
    if (!matchesGlobCharacter(pattern.suffix[index], target[suffixStart + index])) return false;
  }
  return true;
}

function matchPathGlob(pattern, targetSegments) {
  const requiredSegments = pattern.prefix.length + pattern.suffix.length;
  if (
    (!pattern.recursive && targetSegments.length !== requiredSegments) ||
    targetSegments.length < requiredSegments
  ) {
    return false;
  }
  for (let index = 0; index < pattern.prefix.length; index += 1) {
    if (!matchGlobSegment(pattern.prefix[index], targetSegments[index])) return false;
  }
  const suffixStart = targetSegments.length - pattern.suffix.length;
  for (let index = 0; index < pattern.suffix.length; index += 1) {
    if (!matchGlobSegment(pattern.suffix[index], targetSegments[suffixStart + index])) return false;
  }
  return true;
}

function matchBinding(binding, target) {
  // Untyped schema-v1 values remain review evidence. Kind inference would let
  // legacy prose silently acquire task-selection authority.
  if (binding.kind === "legacy") return null;
  if (binding.kind === target.kind && binding.ref === target.ref) {
    return "exact_binding";
  }
  if (
    binding.kind === "module" &&
    target.kind === "file" &&
    (target.ref === binding.ref || target.ref.startsWith(`${binding.ref}/`))
  ) {
    return "module_parent";
  }
  if (
    binding.kind === "path_glob" &&
    target.kind === "file" &&
    matchPathGlob(binding.compiledGlob, target.pathSegments)
  ) {
    return "path_glob_match";
  }
  return null;
}

/**
 * Compile one normalized file/module/path_glob binding into the exact matcher
 * used by task-context selection. Drift observation calls this in a bounded
 * loop so source coverage cannot quietly acquire a second glob dialect.
 */
export function createNormalizedFileBindingMatcher(binding) {
  if (
    binding === null ||
    typeof binding !== "object" ||
    !["file", "module", "path_glob"].includes(binding.kind) ||
    typeof binding.ref !== "string"
  ) {
    throw targetError("File binding matcher requires a file, module, or path_glob binding.");
  }
  const ref = normalizeTargetRef(binding.kind, binding.ref);
  if (ref !== binding.ref) {
    throw targetError("File binding matcher requires an already-normalized reference.", {
      ...targetReferenceDetails(binding.ref),
    });
  }
  const prepared = binding.kind === "path_glob"
    ? { kind: binding.kind, ref, compiledGlob: compilePathGlob(ref) }
    : { kind: binding.kind, ref };

  return (fileRef) => {
    if (typeof fileRef !== "string") return false;
    return Boolean(matchBinding(prepared, {
      kind: "file",
      ref: fileRef,
      pathSegments: fileRef.split("/").map((segment) => [...segment]),
    }));
  };
}

function matchRank(reason) {
  if (reason === "exact_binding") return 0;
  if (reason === "module_parent") return 1;
  return 2;
}

function boundedReference(value) {
  const characters = [...value];
  const truncated = characters.length > TARGET_BINDING_POLICY.maximumReportedReferenceCharacters;
  return {
    value: truncated
      ? characters.slice(0, TARGET_BINDING_POLICY.maximumReportedReferenceCharacters).join("")
      : value,
    characters: characters.length,
    truncated,
  };
}

export function resolveNoteTargetBindings(note, targets, preparedTargets = undefined) {
  if (targets.length === 0) return [];
  const rawBindings = note.frontmatter.applies_to ?? [];
  if (rawBindings.length === 0) return [];
  const bindings = rawBindings
    .map(parseBinding)
    .filter(Boolean)
    .map((binding) => binding.kind === "path_glob"
      ? { ...binding, compiledGlob: compilePathGlob(binding.ref) }
      : binding);
  const compiledTargets = preparedTargets ?? prepareTargetSpecifiers(targets);
  const matches = [];
  for (const target of compiledTargets) {
    let selected = null;
    for (const binding of bindings) {
      const reason = matchBinding(binding, target);
      if (!reason) continue;
      if (
        selected === null ||
        matchRank(reason) < matchRank(selected.reason) ||
        (
          matchRank(reason) === matchRank(selected.reason) &&
          portableCompare(binding.source, selected.binding.source) < 0
        )
      ) {
        selected = { binding, reason };
      }
    }
    if (selected) {
      const bindingRef = boundedReference(selected.binding.source);
      const targetRef = boundedReference(target.originalRef);
      matches.push({
        binding: bindingRef.value,
        bindingSource: selected.binding.source,
        bindingCharacters: bindingRef.characters,
        bindingTruncated: bindingRef.truncated,
        bindingKind: selected.binding.kind,
        target: `${target.kind}:${targetRef.value}`,
        targetCharacters: targetRef.characters,
        targetTruncated: targetRef.truncated,
        targetKind: target.kind,
        targetRef: targetRef.value,
        targetOriginalRef: target.originalRef,
        normalizedTargetRef: target.ref,
        reason: selected.reason,
      });
    }
  }
  return matches.sort(
    (left, right) =>
      portableCompare(left.bindingSource, right.bindingSource) ||
      portableCompare(left.normalizedTargetRef, right.normalizedTargetRef) ||
      portableCompare(left.reason, right.reason),
  );
}

export function classifyNoteTargetBindings(note) {
  const untyped = [];
  const invalid = [];
  for (const value of note.frontmatter.applies_to ?? []) {
    if (typeof value !== "string" || value.trim() === "") {
      invalid.push(typeof value === "string" ? value : String(value));
      continue;
    }
    const separator = value.indexOf(":");
    const typed = separator > 0 && TARGET_KIND_SET.has(value.slice(0, separator));
    const parsed = parseBinding(value);
    if (typed && parsed === null) invalid.push(value);
    else if (parsed?.legacy) untyped.push(parsed.source);
  }
  return {
    untyped: untyped.sort(portableCompare),
    invalid: invalid.sort(portableCompare),
  };
}

export function untypedNoteTargetBindings(note) {
  return classifyNoteTargetBindings(note).untyped;
}

export function invalidNoteTargetBindings(note) {
  return classifyNoteTargetBindings(note).invalid;
}
