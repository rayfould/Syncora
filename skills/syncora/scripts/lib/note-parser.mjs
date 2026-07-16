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

  for (const relationField of ["supersedes", "superseded_by", "source_refs", "applies_to"]) {
    const value = frontmatter.data[relationField];
    if (value !== undefined && (!Array.isArray(value) || value.some((item) => typeof item !== "string"))) {
      diagnostics.push(
        finding(
          "SCHEMA003",
          "error",
          `${relationField} must be a one-level list of strings.`,
          path,
        ),
      );
      return { status: "invalid", current: false };
    }
  }

  return { status: "current", current: true };
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
    buffer = await readFile(file.absolutePath);
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
    characterLength: text.length,
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
