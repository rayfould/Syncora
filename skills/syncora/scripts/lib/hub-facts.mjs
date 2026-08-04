import { createHash } from "node:crypto";

const FACTS_OPEN = "<!-- syncora:facts -->";
const FACTS_CLOSE = "<!-- /syncora:facts -->";
const FACT_OPEN_PREFIX = "<!-- syncora:fact key=\"";
const FACT_OPEN_SUFFIX = "\" -->";
const FACT_CLOSE = "<!-- /syncora:fact -->";
const FACT_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u;
const MAXIMUM_FACT_CHARACTERS = 32_000;

export const HUB_FACT_FORMAT = "syncora-hub-facts-v1";

export class HubFactError extends Error {
  constructor(message) {
    super(message);
    this.name = "HubFactError";
  }
}

function countOccurrences(text, marker) {
  let count = 0;
  let from = 0;
  while (true) {
    const index = text.indexOf(marker, from);
    if (index < 0) return count;
    count += 1;
    from = index + marker.length;
  }
}

function assertFactKey(key) {
  if (typeof key !== "string" || !FACT_KEY_PATTERN.test(key)) {
    throw new HubFactError("Hub fact key is invalid.");
  }
  return key;
}

export function normalizeHubFactText(value) {
  if (
    typeof value !== "string" ||
    [...value].length < 1 ||
    [...value].length > MAXIMUM_FACT_CHARACTERS ||
    value.includes("\0") ||
    Buffer.from(value, "utf8").toString("utf8") !== value ||
    !value.endsWith("\n")
  ) {
    throw new HubFactError(
      "Hub fact text must be non-empty, bounded, NUL-free, and LF-terminated.",
    );
  }
  return value;
}

export function taggedHubFactSha256(text) {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function parseContainer(text) {
  const openings = countOccurrences(text, FACTS_OPEN);
  const closings = countOccurrences(text, FACTS_CLOSE);
  if (openings === 0 && closings === 0) return null;
  if (openings !== 1 || closings !== 1) {
    throw new HubFactError("Hub facts container must occur exactly once.");
  }
  const openIndex = text.indexOf(FACTS_OPEN);
  const contentStart = openIndex + FACTS_OPEN.length;
  const closeIndex = text.indexOf(FACTS_CLOSE);
  if (closeIndex < contentStart) {
    throw new HubFactError("Hub facts container closing marker precedes its opening marker.");
  }

  const inner = text.slice(contentStart, closeIndex);
  const factPattern = /<!-- syncora:fact key="([A-Za-z0-9][A-Za-z0-9._:/-]{0,199})" -->\n([\s\S]*?)<!-- \/syncora:fact -->/gu;
  const facts = new Map();
  let cursor = 0;
  let match;
  while ((match = factPattern.exec(inner)) !== null) {
    if (inner.slice(cursor, match.index).trim() !== "") {
      throw new HubFactError("Hub facts container contains unkeyed content.");
    }
    const key = match[1];
    if (facts.has(key)) {
      throw new HubFactError(`Hub fact key is duplicated: ${key}.`);
    }
    normalizeHubFactText(match[2]);
    facts.set(key, {
      key,
      text: match[2],
      start: contentStart + match.index,
      end: contentStart + match.index + match[0].length,
    });
    cursor = match.index + match[0].length;
  }
  if (inner.slice(cursor).trim() !== "") {
    throw new HubFactError("Hub facts container contains an incomplete fact marker.");
  }
  return { contentStart, closeIndex, facts };
}

function renderFact(key, text) {
  return `${FACT_OPEN_PREFIX}${key}${FACT_OPEN_SUFFIX}\n${text}${FACT_CLOSE}`;
}

function appendContainer(text, renderedFact) {
  const base = text.endsWith("\n") ? text : `${text}\n`;
  return `${base}\n## Syncora facts\n\n${FACTS_OPEN}\n${renderedFact}\n${FACTS_CLOSE}\n`;
}

/**
 * Apply one declared fact to a project hub without changing any other hub
 * prose. A missing container is created append-only for an additive fact.
 */
export function upsertHubFact(noteText, fact) {
  if (typeof noteText !== "string" || noteText.includes("\0")) {
    throw new HubFactError("Hub text is invalid.");
  }
  if (fact === null || typeof fact !== "object" || Array.isArray(fact)) {
    throw new HubFactError("Hub fact is invalid.");
  }
  const key = assertFactKey(fact.key);
  const afterText = normalizeHubFactText(fact.afterText);
  const expectedSha256 = fact.expectedSha256;
  if (
    expectedSha256 !== null &&
    (typeof expectedSha256 !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(expectedSha256))
  ) {
    throw new HubFactError("Hub fact expected hash is invalid.");
  }

  const rendered = renderFact(key, afterText);
  const container = parseContainer(noteText);
  if (container === null) {
    if (expectedSha256 !== null) {
      throw new HubFactError("The expected hub fact does not exist in this hub.");
    }
    return appendContainer(noteText, rendered);
  }

  const existing = container.facts.get(key) ?? null;
  if (existing === null) {
    if (expectedSha256 !== null) {
      throw new HubFactError("The expected hub fact does not exist in this hub.");
    }
    return `${noteText.slice(0, container.closeIndex)}${
      noteText.slice(container.contentStart, container.closeIndex).endsWith("\n") ? "" : "\n"
    }${rendered}\n${noteText.slice(container.closeIndex)}`;
  }
  const currentSha256 = taggedHubFactSha256(existing.text);
  if (expectedSha256 !== currentSha256) {
    throw new HubFactError("The targeted hub fact changed concurrently.");
  }
  return `${noteText.slice(0, existing.start)}${rendered}${noteText.slice(existing.end)}`;
}
