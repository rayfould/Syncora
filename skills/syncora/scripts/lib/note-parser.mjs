import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";

import { parseFrontmatter } from "./frontmatter.mjs";
import { isWithin, samePath } from "./workspace.mjs";
import { extractWikiLinks } from "./wiki-links.mjs";

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const REQUIRED_FIELDS = [
  "id",
  "kind",
  "scope",
  "state",
  "authority",
  "schema_version",
  "created",
  "updated",
  "summary",
];
const KINDS = new Set([
  "atlas",
  "project",
  "decision",
  "concept",
  "reference",
  "session",
  "inbox",
]);
const AUTHORITIES = new Set([
  "canonical",
  "supporting",
  "historical",
  "transient",
]);
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const UNSAFE_SCALAR_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/;
const RELATION_FIELDS = [
  "supersedes",
  "superseded_by",
  "source_refs",
  "applies_to",
];

export const NOTE_SCHEMA_SEMANTICS = Object.freeze({
  specification: "syncora-note-schema-semantics-v1.1",
  maxIdentifierCharacters: 200,
  maxStateCharacters: 64,
  maxSummaryCharacters: 1_000,
  maxRelationItems: 256,
  maxRelationCharacters: 4_096,
});

function finding(code, severity, message, path, options = {}) {
  return {
    code,
    severity,
    message,
    path,
    quarantined: options.quarantined ?? severity === "error",
    ...(options.location ? { location: options.location } : {}),
    ...(options.details ? { details: options.details } : {}),
  };
}

async function hashFile(path) {
  const hash = createHash("sha256");
  let offset = 0;
  let nulCount = 0;
  let firstNul = -1;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    for (let index = 0; index < chunk.length; index += 1) {
      if (chunk[index] !== 0) continue;
      if (firstNul < 0) firstNul = offset + index;
      nulCount += 1;
    }
    offset += chunk.length;
  }
  return { sha256: hash.digest("hex"), nulCount, firstNul };
}

function newlineMetadata(text) {
  const withoutCrLf = text.replaceAll("\r\n", "");
  const hasCrLf = text.includes("\r\n");
  const hasLf = withoutCrLf.includes("\n");
  const hasCr = withoutCrLf.includes("\r");
  const varieties = Number(hasCrLf) + Number(hasLf) + Number(hasCr);
  return {
    newline: varieties > 1 ? "mixed" : hasCrLf ? "crlf" : hasLf ? "lf" : hasCr ? "cr" : "none",
    finalNewline: text.endsWith("\n") || text.endsWith("\r"),
  };
}

function firstHeading(body) {
  const match = body.match(/^#\s+(.+)$/m);
  return match ? match[1].trim().slice(0, 240) : null;
}

function valueIsString(data, key) {
  return typeof data[key] === "string" && data[key].trim() !== "";
}

function characterLength(value) {
  return [...value].length;
}

function validBoundedIdentifier(value, maximumCharacters) {
  return (
    typeof value === "string" &&
    characterLength(value) >= 1 &&
    characterLength(value) <= maximumCharacters &&
    IDENTIFIER_PATTERN.test(value)
  );
}

function validDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1];
}

function addSchemaFinding(diagnostics, path, message, details = undefined) {
  diagnostics.push(
    finding("SCHEMA003", "error", message, path, {
      ...(details === undefined ? {} : { details }),
    }),
  );
}

function validateRelationField(data, relationField, path, diagnostics) {
  const value = data[relationField];
  if (value === undefined) return true;
  if (!Array.isArray(value)) {
    addSchemaFinding(
      diagnostics,
      path,
      `${relationField} must be a one-level list of strings.`,
    );
    return false;
  }
  if (value.length > NOTE_SCHEMA_SEMANTICS.maxRelationItems) {
    addSchemaFinding(
      diagnostics,
      path,
      `${relationField} exceeds the relation item limit.`,
      {
        items: value.length,
        limit: NOTE_SCHEMA_SEMANTICS.maxRelationItems,
      },
    );
    return false;
  }

  const seen = new Set();
  for (const item of value) {
    if (
      typeof item !== "string" ||
      item.trim() === "" ||
      characterLength(item) > NOTE_SCHEMA_SEMANTICS.maxRelationCharacters ||
      UNSAFE_SCALAR_PATTERN.test(item)
    ) {
      addSchemaFinding(
        diagnostics,
        path,
        `${relationField} contains an invalid or excessive relation value.`,
      );
      return false;
    }
    const identity = item.normalize("NFC");
    if (seen.has(identity)) {
      addSchemaFinding(
        diagnostics,
        path,
        `${relationField} contains a duplicate relation value.`,
      );
      return false;
    }
    seen.add(identity);
  }
  return true;
}

function classifySchema(frontmatter, path, diagnostics) {
  if (!frontmatter.present || frontmatter.data.schema_version === undefined) {
    diagnostics.push(
      finding(
        "SCHEMA002",
        "warning",
        "Missing schema_version keeps this legacy note unpromoted.",
        path,
        { quarantined: false },
      ),
    );
    return { status: "legacy", current: false };
  }

  const version = frontmatter.data.schema_version;
  if (!Number.isInteger(version) || version < 1) {
    diagnostics.push(
      finding(
        "SCHEMA003",
        "error",
        "schema_version must be an unquoted positive integer.",
        path,
      ),
    );
    return { status: "invalid", current: false };
  }
  if (version > 1) {
    diagnostics.push(
      finding(
        "SCHEMA001",
        "error",
        `Note schema ${version} is newer than supported schema 1 and is quarantined read-only.`,
        path,
      ),
    );
    return { status: "future", current: false };
  }

  const missing = REQUIRED_FIELDS.filter((key) => {
    if (key === "schema_version") return false;
    return !valueIsString(frontmatter.data, key);
  });
  if (frontmatter.data.kind === "decision" && !valueIsString(frontmatter.data, "decision_key")) {
    missing.push("decision_key");
  }
  if (missing.length > 0) {
    diagnostics.push(
      finding(
        "SCHEMA003",
        "error",
        "Current-schema note is missing required string fields.",
        path,
        { details: { missingFields: missing.sort() } },
      ),
    );
    return { status: "invalid", current: false };
  }
  if (!KINDS.has(frontmatter.data.kind) || !AUTHORITIES.has(frontmatter.data.authority)) {
    diagnostics.push(
      finding(
        "SCHEMA003",
        "error",
        "Current-schema note declares an unsupported kind or authority.",
        path,
      ),
    );
    return { status: "invalid", current: false };
  }

  for (const key of ["id", "scope"]) {
    if (
      !validBoundedIdentifier(
        frontmatter.data[key],
        NOTE_SCHEMA_SEMANTICS.maxIdentifierCharacters,
      )
    ) {
      addSchemaFinding(
        diagnostics,
        path,
        `${key} must be a bounded portable identifier.`,
      );
    }
  }
  if (
    !validBoundedIdentifier(
      frontmatter.data.state,
      NOTE_SCHEMA_SEMANTICS.maxStateCharacters,
    )
  ) {
    addSchemaFinding(
      diagnostics,
      path,
      "state must be a bounded portable identifier.",
    );
  }
  if (
    characterLength(frontmatter.data.summary) >
      NOTE_SCHEMA_SEMANTICS.maxSummaryCharacters ||
    UNSAFE_SCALAR_PATTERN.test(frontmatter.data.summary)
  ) {
    addSchemaFinding(
      diagnostics,
      path,
      "summary contains unsafe characters or exceeds its character limit.",
      { limit: NOTE_SCHEMA_SEMANTICS.maxSummaryCharacters },
    );
  }
  if (!validDate(frontmatter.data.created) || !validDate(frontmatter.data.updated)) {
    addSchemaFinding(
      diagnostics,
      path,
      "created and updated must be real YYYY-MM-DD calendar dates.",
    );
  } else if (frontmatter.data.created > frontmatter.data.updated) {
    addSchemaFinding(
      diagnostics,
      path,
      "updated cannot be earlier than created.",
    );
  }

  if (frontmatter.data.kind === "decision") {
    if (
      !validBoundedIdentifier(
        frontmatter.data.decision_key,
        NOTE_SCHEMA_SEMANTICS.maxIdentifierCharacters,
      )
    ) {
      addSchemaFinding(
        diagnostics,
        path,
        "decision_key must be a bounded portable identifier.",
      );
    }
  } else if (frontmatter.data.decision_key !== undefined) {
    addSchemaFinding(
      diagnostics,
      path,
      "decision_key is only valid on decision notes.",
    );
  }

  let relationsValid = true;
  for (const relationField of RELATION_FIELDS) {
    relationsValid =
      validateRelationField(
        frontmatter.data,
        relationField,
        path,
        diagnostics,
      ) && relationsValid;
  }
  if (
    frontmatter.data.kind !== "decision" &&
    ["supersedes", "superseded_by"].some(
      (key) => (frontmatter.data[key]?.length ?? 0) > 0,
    )
  ) {
    addSchemaFinding(
      diagnostics,
      path,
      "Only decision notes may declare supersession relations.",
    );
  }

  return {
    status: diagnostics.some((item) => item.code === "SCHEMA003")
      ? "invalid"
      : "current",
    current:
      relationsValid &&
      !diagnostics.some((item) => item.code === "SCHEMA003"),
  };
}

function countNuls(buffer) {
  let count = 0;
  let first = -1;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0) continue;
    if (first < 0) first = index;
    count += 1;
  }
  return { count, first };
}

export async function parseNote(file, graphRoot, policy, options = {}) {
  const diagnostics = [];
  let before;
  let resolved;
  try {
    before = await lstat(file.absolutePath);
    resolved = await realpath(file.absolutePath);
  } catch (error) {
    return unreadableNote(file, diagnostics, error);
  }

  if (!before.isFile() || !isWithin(graphRoot, resolved) || !samePath(resolved, file.realPath)) {
    diagnostics.push(
      finding("PATH002", "error", "Note path changed or escaped after discovery.", file.path),
    );
    return baseNote(file, diagnostics);
  }

  if (before.size > policy.maxNoteBytes) {
    let rawSha256 = null;
    try {
      const hashed = await hashFile(file.absolutePath);
      rawSha256 = hashed.sha256;
      if (hashed.nulCount > 0) {
        diagnostics.push(
          finding(
            "ENC002",
            "error",
            "Embedded NUL bytes quarantine this note.",
            file.path,
            {
              location: { line: null, column: null, byteOffset: hashed.firstNul },
              details: { occurrences: hashed.nulCount },
            },
          ),
        );
      }
      const after = await lstat(file.absolutePath);
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
        diagnostics.push(
          finding("READ001", "error", "Note changed while it was being hashed.", file.path),
        );
      }
    } catch (error) {
      diagnostics.push(
        finding("READ001", "error", "Oversized note could not be hashed completely.", file.path, {
          details: { cause: error.message },
        }),
      );
    }
    diagnostics.push(
      finding(
        "NOTE001",
        "error",
        "Note exceeds the configured byte limit and is quarantined.",
        file.path,
        { details: { bytes: before.size, limit: policy.maxNoteBytes } },
      ),
    );
    return {
      ...baseNote(file, diagnostics),
      rawSha256,
      byteLength: before.size,
    };
  }

  let buffer;
  try {
    if (
      options.preloadedBuffer !== undefined &&
      !Buffer.isBuffer(options.preloadedBuffer)
    ) {
      throw new TypeError("Preloaded note bytes must be a Buffer.");
    }
    buffer = options.preloadedBuffer ?? await readFile(file.absolutePath);
    const after = await lstat(file.absolutePath);
    if (
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      buffer.length !== before.size
    ) {
      diagnostics.push(
        finding("READ001", "error", "Note changed while it was being read.", file.path),
      );
    }
  } catch (error) {
    return unreadableNote(file, diagnostics, error);
  }

  const rawSha256 = createHash("sha256").update(buffer).digest("hex");
  const hasBom = buffer.length >= 3 && buffer.subarray(0, 3).equals(UTF8_BOM);
  const content = hasBom ? buffer.subarray(3) : buffer;
  const nuls = countNuls(content);
  if (nuls.count > 0) {
    diagnostics.push(
      finding(
        "ENC002",
        "error",
        "Embedded NUL bytes quarantine this note.",
        file.path,
        {
          location: { line: null, column: null, byteOffset: nuls.first + (hasBom ? 3 : 0) },
          details: { occurrences: nuls.count },
        },
      ),
    );
    return {
      ...baseNote(file, diagnostics),
      rawSha256,
      byteLength: buffer.length,
      encoding: { utf8: true, bom: hasBom, newline: "unknown", finalNewline: false },
    };
  }

  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    diagnostics.push(
      finding("ENC001", "error", "Invalid UTF-8 quarantines this note.", file.path),
    );
    return {
      ...baseNote(file, diagnostics),
      rawSha256,
      byteLength: buffer.length,
      encoding: { utf8: false, bom: hasBom, newline: "unknown", finalNewline: false },
    };
  }

  const frontmatter = parseFrontmatter(text, policy);
  for (const item of frontmatter.diagnostics) {
    diagnostics.push({ ...item, path: file.path });
  }
  const links = extractWikiLinks(frontmatter.body, policy.maxLinksPerNote);
  if (links.overflow) {
    diagnostics.push(
      finding(
        "LINK001",
        "error",
        "Wiki-link fanout exceeds the configured limit.",
        file.path,
        {
          details: {
            occurrences: links.occurrences,
            uniqueTargets: links.targets.length,
            limit: policy.maxLinksPerNote,
          },
        },
      ),
    );
  }
  if (links.unsafeTargets.length > 0) {
    diagnostics.push(
      finding(
        "LINK002",
        "error",
        "Unsafe wiki-link targets quarantine this note.",
        file.path,
        { details: { targets: links.unsafeTargets.slice(0, 10) } },
      ),
    );
  }

  const schema = frontmatter.diagnostics.length > 0
    ? { status: "invalid", current: false }
    : classifySchema(frontmatter, file.path, diagnostics);
  if (file.caseCollision) {
    diagnostics.push(
      finding("PATH001", "error", "Path participates in a cross-platform canonical collision.", file.path, {
        details: { paths: file.caseCollisionPaths },
      }),
    );
  }
  if (file.nonPortablePath) {
    diagnostics.push(
      finding("PATH003", "error", "Path is not portable across supported filesystems.", file.path),
    );
  }

  const newline = newlineMetadata(text);
  const title = firstHeading(frontmatter.body);
  return {
    path: file.path,
    byteLength: buffer.length,
    rawSha256,
    encoding: { utf8: true, bom: hasBom, ...newline },
    title,
    characterLength: characterLength(text),
    frontmatter: frontmatter.data,
    schemaStatus: schema.status,
    currentSchema: schema.current,
    authorityClass: diagnostics.some((item) => item.quarantined)
      ? "quarantined"
      : schema.current
        ? "pending"
        : "unpromoted",
    links: links.targets,
    linkReferences: links.references,
    linkOccurrences: links.occurrences,
    diagnostics,
    ...(options.includeLexicalSource
      ? {
          lexicalSource: {
            path: file.path,
            id: typeof frontmatter.data.id === "string" ? frontmatter.data.id : "",
            title: title ?? "",
            summary: typeof frontmatter.data.summary === "string"
              ? frontmatter.data.summary
              : "",
            body: frontmatter.body,
          },
        }
      : {}),
  };
}

function baseNote(file, diagnostics) {
  return {
    path: file.path,
    byteLength: file.size,
    rawSha256: null,
    encoding: { utf8: false, bom: false, newline: "unknown", finalNewline: false },
    title: null,
    characterLength: 0,
    frontmatter: Object.create(null),
    schemaStatus: "invalid",
    currentSchema: false,
    authorityClass: "quarantined",
    links: [],
    linkReferences: [],
    linkOccurrences: 0,
    diagnostics,
  };
}

function unreadableNote(file, diagnostics, error) {
  diagnostics.push(
    finding("READ001", "error", "Discovered note could not be read completely.", file.path, {
      details: { cause: error.message },
    }),
  );
  return baseNote(file, diagnostics);
}
