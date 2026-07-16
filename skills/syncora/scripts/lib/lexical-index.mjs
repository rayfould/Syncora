import { createHash } from "node:crypto";

import { SyncoraError } from "./cli.mjs";

const unicodeVersion = (process.versions.unicode ?? "unknown")
  .replaceAll(/[^0-9A-Za-z.-]/g, "-");

export const LEXICAL_POLICY = Object.freeze({
  cacheSchemaVersion: 1,
  indexSpecBaseId: `syncora-lexical-v1:nfkc-lower-alnum-unicode${unicodeVersion}:path8-id10-title8-summary4-body1`,
  maxQueryCharacters: 2_048,
  maxQueryTerms: 32,
  defaultLimit: 10,
  maxLimit: 50,
  maxTokenCharacters: 128,
  maxTokenOccurrencesPerNote: 32_768,
  maxUniqueTermsPerNote: 8_192,
  maxTermWeight: 327_680,
  maxDocuments: 50_000,
  maxTotalPostings: 500_000,
  maxCacheBytes: 16_777_216,
  materializationConcurrency: 8,
  maxCacheDirectoryEntries: 2_048,
  staleTemporaryAgeMs: 86_400_000,
});

export const LEXICAL_PROFILES = Object.freeze({
  DEFAULT: "default",
  HISTORY: "history",
});

const DEFAULT_SEARCH_AUTHORITIES = new Set(["canonical", "routing", "supporting"]);
const HISTORY_SEARCH_AUTHORITIES = new Set([
  "canonical",
  "routing",
  "supporting",
  "historical",
  "unpromoted",
]);

function portableCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function lexicalProfile(includeHistory) {
  return includeHistory ? LEXICAL_PROFILES.HISTORY : LEXICAL_PROFILES.DEFAULT;
}

export function lexicalIndexSpecId(profile) {
  if (!Object.values(LEXICAL_PROFILES).includes(profile)) {
    throw new SyncoraError("INDEX001", `Unsupported lexical index profile: ${profile}`);
  }
  return `${LEXICAL_POLICY.indexSpecBaseId}:profile-${profile}`;
}

export function isLexicalAuthority(authorityClass, profile) {
  const authorities = profile === LEXICAL_PROFILES.HISTORY
    ? HISTORY_SEARCH_AUTHORITIES
    : DEFAULT_SEARCH_AUTHORITIES;
  return authorities.has(authorityClass);
}

function normalizedTokens(text) {
  const normalized = text.normalize("NFKC").toLowerCase();
  return normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
}

function addWeightedText(terms, text, weight, counters, notePath) {
  for (const term of normalizedTokens(text)) {
    counters.occurrences += 1;
    if (counters.occurrences > LEXICAL_POLICY.maxTokenOccurrencesPerNote) {
      throw new SyncoraError(
        "INDEX001",
        `Lexical token occurrence limit exceeded: ${notePath}`,
        { limit: LEXICAL_POLICY.maxTokenOccurrencesPerNote },
      );
    }
    if ([...term].length > LEXICAL_POLICY.maxTokenCharacters) continue;
    if (!terms.has(term) && terms.size >= LEXICAL_POLICY.maxUniqueTermsPerNote) {
      throw new SyncoraError(
        "INDEX001",
        `Lexical unique-term limit exceeded: ${notePath}`,
        { limit: LEXICAL_POLICY.maxUniqueTermsPerNote },
      );
    }
    terms.set(term, (terms.get(term) ?? 0) + weight);
  }
}

export function vectorizeNote(note) {
  const terms = new Map();
  const counters = { occurrences: 0 };
  const source = note.lexicalSource;
  if (!source) {
    throw new SyncoraError("INDEX001", `Lexical source is unavailable: ${note.path}`);
  }
  addWeightedText(terms, source.path, 8, counters, note.path);
  addWeightedText(terms, source.id, 10, counters, note.path);
  addWeightedText(terms, source.title, 8, counters, note.path);
  addWeightedText(terms, source.summary, 4, counters, note.path);
  addWeightedText(terms, source.body, 1, counters, note.path);

  return {
    path: note.path,
    sourceSha256: note.rawSha256,
    terms: [...terms.entries()].sort(([left], [right]) => portableCompare(left, right)),
  };
}

function indexRevision(graphRevision, indexSpecId) {
  const hash = createHash("sha256");
  hash.update("syncora-lexical-index-revision-v1\n");
  hash.update(graphRevision);
  hash.update("\n");
  hash.update(indexSpecId);
  return `sha256:${hash.digest("hex")}`;
}

function emptyEnvelopeBytes(payload) {
  return Buffer.byteLength(`${JSON.stringify({
    ...payload,
    documents: [],
    payloadSha256: "0".repeat(64),
  })}\n`);
}

export function estimateLexicalCacheBytes(payload) {
  let bytes = emptyEnvelopeBytes(payload);
  for (let index = 0; index < payload.documents.length; index += 1) {
    bytes += Buffer.byteLength(JSON.stringify(payload.documents[index]));
    if (index > 0) bytes += 1;
  }
  return bytes;
}

async function materializeBatch(batch, cacheByPath, loadLexicalSource) {
  return Promise.all(batch.map(async (note) => {
    const cached = cacheByPath.get(note.path);
    if (cached?.sourceSha256 === note.rawSha256) {
      return { document: cached, reused: true };
    }
    const sourceNote = note.lexicalSource
      ? note
      : await loadLexicalSource?.(note);
    if (!sourceNote) {
      throw new SyncoraError("INDEX001", `Lexical source loader failed: ${note.path}`);
    }
    return { document: vectorizeNote(sourceNote), reused: false };
  }));
}

export async function buildLexicalIndex({
  notes,
  cachedPayload,
  graphRevision,
  rootIdentity,
  profile = LEXICAL_PROFILES.DEFAULT,
  loadLexicalSource = undefined,
}) {
  const indexSpecId = lexicalIndexSpecId(profile);
  const cacheByPath = new Map(
    cachedPayload?.indexSpecId === indexSpecId
      ? cachedPayload.documents.map((document) => [document.path, document])
      : [],
  );
  const eligibleNotes = notes.filter((note) =>
    isLexicalAuthority(note.authorityClass, profile) &&
    typeof note.rawSha256 === "string"
  );
  if (eligibleNotes.length > LEXICAL_POLICY.maxDocuments) {
    throw new SyncoraError("INDEX001", "Lexical document limit exceeded.", {
      limit: LEXICAL_POLICY.maxDocuments,
    });
  }

  const header = {
    schemaVersion: LEXICAL_POLICY.cacheSchemaVersion,
    indexSpecId,
    rootIdentity,
    graphRevision,
    indexRevision: indexRevision(graphRevision, indexSpecId),
  };
  const documents = [];
  let reused = 0;
  let rebuilt = 0;
  let postings = 0;
  let projectedBytes = emptyEnvelopeBytes(header);

  for (
    let offset = 0;
    offset < eligibleNotes.length;
    offset += LEXICAL_POLICY.materializationConcurrency
  ) {
    const batch = eligibleNotes.slice(
      offset,
      offset + LEXICAL_POLICY.materializationConcurrency,
    );
    const materialized = await materializeBatch(batch, cacheByPath, loadLexicalSource);
    for (const item of materialized) {
      postings += item.document.terms.length;
      if (postings > LEXICAL_POLICY.maxTotalPostings) {
        throw new SyncoraError("INDEX001", "Lexical posting limit exceeded.", {
          limit: LEXICAL_POLICY.maxTotalPostings,
        });
      }
      projectedBytes += Buffer.byteLength(JSON.stringify(item.document));
      if (documents.length > 0) projectedBytes += 1;
      if (projectedBytes > LEXICAL_POLICY.maxCacheBytes) {
        throw new SyncoraError("INDEX001", "Lexical cache byte budget exceeded.", {
          bytes: projectedBytes,
          limit: LEXICAL_POLICY.maxCacheBytes,
        });
      }
      documents.push(item.document);
      if (item.reused) reused += 1;
      else rebuilt += 1;
    }
  }

  const currentPaths = new Set(documents.map((document) => document.path));
  const removed = [...cacheByPath.keys()].filter((path) => !currentPaths.has(path)).length;
  const payload = { ...header, documents };
  if (estimateLexicalCacheBytes(payload) !== projectedBytes) {
    throw new SyncoraError("INDEX001", "Lexical cache byte accounting diverged.");
  }

  return {
    payload,
    stats: { reused, rebuilt, removed, postings, projectedBytes },
  };
}

export function validateSearchQuery(query) {
  if (typeof query !== "string") {
    throw new SyncoraError("SEARCH001", "Search query must be text.");
  }
  if ([...query].length > LEXICAL_POLICY.maxQueryCharacters) {
    throw new SyncoraError("SEARCH001", "Search query exceeds the character limit.", {
      limit: LEXICAL_POLICY.maxQueryCharacters,
    });
  }
  const terms = [...new Set(normalizedTokens(query))];
  if (terms.length === 0) {
    throw new SyncoraError("SEARCH001", "Search query contains no indexable terms.");
  }
  if (terms.length > LEXICAL_POLICY.maxQueryTerms) {
    throw new SyncoraError("SEARCH001", "Search query exceeds the unique-term limit.", {
      limit: LEXICAL_POLICY.maxQueryTerms,
    });
  }
  return terms;
}

function roundedScore(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function boundedText(value, maxCharacters = 240) {
  if (typeof value !== "string") return null;
  return [...value].slice(0, maxCharacters).join("");
}

function resultOrder(left, right) {
  return (right.score - left.score) || portableCompare(left.path, right.path);
}

function retainTopResult(results, candidate, limit) {
  if (results.length < limit) {
    results.push(candidate);
    results.sort(resultOrder);
    return;
  }
  if (resultOrder(candidate, results.at(-1)) >= 0) return;
  results[results.length - 1] = candidate;
  results.sort(resultOrder);
}

export function searchLexicalIndex({ payload, notes, query, limit, includeHistory }) {
  const terms = validateSearchQuery(query);
  const querySet = new Set(terms);
  const profile = lexicalProfile(includeHistory);
  if (payload.indexSpecId !== lexicalIndexSpecId(profile)) {
    throw new SyncoraError("INDEX001", "Lexical payload profile does not match the query mode.");
  }
  const notesByPath = new Map(notes.map((note) => [note.path, note]));
  const eligible = payload.documents.filter((document) => {
    const note = notesByPath.get(document.path);
    return (
      note &&
      note.rawSha256 === document.sourceSha256 &&
      isLexicalAuthority(note.authorityClass, profile)
    );
  });

  const documentFrequency = new Map(terms.map((term) => [term, 0]));
  for (const document of eligible) {
    for (const [term] of document.terms) {
      if (querySet.has(term)) {
        documentFrequency.set(term, documentFrequency.get(term) + 1);
      }
    }
  }

  const results = [];
  let matches = 0;
  for (const document of eligible) {
    const matchedTerms = [];
    let score = 0;
    for (const [term, weight] of document.terms) {
      if (!querySet.has(term)) continue;
      matchedTerms.push(term);
      const frequency = documentFrequency.get(term);
      const inverseDocumentFrequency = 1 + Math.log((eligible.length + 1) / (frequency + 1));
      score += weight * inverseDocumentFrequency;
    }
    if (matchedTerms.length === 0) continue;
    matches += 1;
    const note = notesByPath.get(document.path);
    retainTopResult(results, {
      path: note.path,
      id: boundedText(note.frontmatter.id),
      title: boundedText(note.title),
      summary: boundedText(note.frontmatter.summary),
      authorityClass: note.authorityClass,
      selectionAuthority: "none",
      sourceSha256: note.rawSha256,
      score: roundedScore(score),
      matchedTerms,
    }, limit);
  }

  return {
    queryTerms: terms,
    totalIndexed: payload.documents.length,
    eligibleDocuments: eligible.length,
    matches,
    results,
  };
}
