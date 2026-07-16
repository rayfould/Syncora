const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function issue(code, message, details = undefined) {
  return {
    code,
    severity: "error",
    message,
    quarantined: true,
    ...(details === undefined ? {} : { details }),
  };
}

function parseScalar(raw, lineNumber) {
  const value = raw.trim();

  if (value === "[]") return { value: [] };
  if (value === "true") return { value: true };
  if (value === "false") return { value: false };
  if (value === "null") return { value: null };
  if (/^-?(?:0|[1-9][0-9]*)$/.test(value)) {
    return { value: Number(value) };
  }

  if (value.startsWith('"')) {
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed !== "string") throw new Error("not a string");
      return { value: parsed };
    } catch {
      return {
        error: issue(
          "FM002",
          "Frontmatter contains an invalid JSON-quoted scalar.",
          { line: lineNumber },
        ),
      };
    }
  }

  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) {
      return {
        error: issue("FM002", "Frontmatter contains an unclosed quoted scalar.", {
          line: lineNumber,
        }),
      };
    }
    return { value: value.slice(1, -1).replaceAll("''", "'") };
  }

  if (
    value === "|" ||
    value === ">" ||
    /^[!&*{[]/.test(value) ||
    value.includes("\t")
  ) {
    return {
      error: issue(
        "FM002",
        "Frontmatter uses a construct outside Syncora's constrained YAML subset.",
        { line: lineNumber },
      ),
    };
  }

  return { value };
}

export function parseFrontmatter(text, { maxFrontmatterBytes }) {
  const normalized = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  if (!normalized.startsWith("---\n")) {
    const malformedLeadingBoundary = /^\s+---\n/.test(normalized);
    return {
      present: malformedLeadingBoundary,
      data: Object.create(null),
      body: normalized,
      diagnostics: malformedLeadingBoundary
        ? [issue("FM001", "Frontmatter opening delimiter must be the first bytes after an optional UTF-8 BOM.")]
        : [],
    };
  }

  const lines = normalized.split("\n");
  let closingLine = -1;
  let measuredBytes = 4;
  for (let index = 1; index < lines.length; index += 1) {
    measuredBytes += Buffer.byteLength(lines[index], "utf8") + 1;
    if (measuredBytes > maxFrontmatterBytes) {
      return {
        present: true,
        data: Object.create(null),
        body: "",
        diagnostics: [
          issue("FM001", "Frontmatter exceeds the configured byte limit."),
        ],
      };
    }
    if (lines[index] === "---") {
      closingLine = index;
      break;
    }
  }

  if (closingLine < 0) {
    return {
      present: true,
      data: Object.create(null),
      body: "",
      diagnostics: [issue("FM001", "Frontmatter has no exact closing delimiter.")],
    };
  }

  const data = Object.create(null);
  const diagnostics = [];
  let currentListKey = null;
  const duplicateKeys = new Set();
  const seenKeys = new Map();

  for (let index = 1; index < closingLine; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;

    const listMatch = line.match(/^ {2,}-\s+(.*)$/);
    if (listMatch) {
      if (currentListKey === null || !Array.isArray(data[currentListKey])) {
        diagnostics.push(
          issue("FM002", "Frontmatter list item has no empty top-level list key.", {
            line: lineNumber,
          }),
        );
        continue;
      }
      const parsed = parseScalar(listMatch[1], lineNumber);
      if (parsed.error) diagnostics.push(parsed.error);
      else if (Array.isArray(parsed.value)) {
        diagnostics.push(
          issue("FM002", "Nested frontmatter lists are not supported.", {
            line: lineNumber,
          }),
        );
      } else data[currentListKey].push(parsed.value);
      continue;
    }

    if (/^\s/.test(line) || line.includes("\t")) {
      diagnostics.push(
        issue("FM002", "Nested or tab-indented frontmatter is not supported.", {
          line: lineNumber,
        }),
      );
      currentListKey = null;
      continue;
    }

    const fieldMatch = line.match(/^([^:]+):(?:\s*(.*))?$/);
    if (!fieldMatch) {
      diagnostics.push(
        issue("FM002", "Frontmatter contains an unsupported line.", {
          line: lineNumber,
        }),
      );
      currentListKey = null;
      continue;
    }

    const key = fieldMatch[1];
    const rawValue = fieldMatch[2] ?? "";
    if (!KEY_PATTERN.test(key) || RESERVED_KEYS.has(key.toLowerCase())) {
      diagnostics.push(
        issue("FM002", "Frontmatter contains an invalid or reserved key.", {
          line: lineNumber,
          key,
        }),
      );
      currentListKey = null;
      continue;
    }

    const normalizedKey = key.toLowerCase();
    if (seenKeys.has(normalizedKey)) {
      duplicateKeys.add(seenKeys.get(normalizedKey));
      duplicateKeys.add(key);
      currentListKey = null;
      continue;
    }
    seenKeys.set(normalizedKey, key);

    if (rawValue === "") {
      data[key] = [];
      currentListKey = key;
      continue;
    }

    const parsed = parseScalar(rawValue, lineNumber);
    if (parsed.error) diagnostics.push(parsed.error);
    else data[key] = parsed.value;
    currentListKey = null;
  }

  if (duplicateKeys.size > 0) {
    diagnostics.push(
      issue("FM001", "Frontmatter contains duplicate top-level keys.", {
        keys: [...duplicateKeys].sort(),
      }),
    );
  }

  return {
    present: true,
    data,
    body: lines.slice(closingLine + 1).join("\n").replace(/^\n/, ""),
    diagnostics,
  };
}
