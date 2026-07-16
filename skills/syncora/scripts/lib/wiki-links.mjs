function portableCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function isUnsafeWikiTarget(target) {
  if (/^(?:[A-Za-z]:[\\/]|[\\/]{1,2}|[A-Za-z][A-Za-z0-9+.-]*:)/.test(target)) {
    return true;
  }
  return target
    .replaceAll("\\", "/")
    .split("/")
    .some((segment) => segment === "..");
}

function stripIgnoredMarkdown(text) {
  const lines = text.split("\n");
  const output = [];
  let fence = null;
  let inComment = false;

  for (const sourceLine of lines) {
    const fenceMatch = sourceLine.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (fence === null) fence = marker[0];
      else if (marker[0] === fence) fence = null;
      output.push("");
      continue;
    }
    if (fence !== null) {
      output.push("");
      continue;
    }

    let line = "";
    for (let index = 0; index < sourceLine.length; index += 1) {
      if (inComment) {
        const end = sourceLine.indexOf("-->", index);
        if (end < 0) {
          index = sourceLine.length;
          break;
        }
        inComment = false;
        index = end + 2;
        continue;
      }
      if (sourceLine.startsWith("<!--", index)) {
        inComment = true;
        index += 3;
        continue;
      }
      line += sourceLine[index];
    }

    output.push(line.replace(/`+[^`]*`+/g, ""));
  }

  return output.join("\n");
}

export function extractWikiLinks(text, maxLinks) {
  const searchable = stripIgnoredMarkdown(text);
  const targets = new Set();
  const unsafe = new Set();
  const references = new Map();
  let occurrences = 0;
  let cursor = 0;

  while (cursor < searchable.length) {
    const start = searchable.indexOf("[[", cursor);
    if (start < 0) break;
    const end = searchable.indexOf("]]", start + 2);
    if (end < 0) break;

    occurrences += 1;
    const raw = searchable.slice(start + 2, end);
    const withoutAlias = raw.split("|", 1)[0].trim();
    const headingIndex = withoutAlias.indexOf("#");
    const target = (headingIndex < 0 ? withoutAlias : withoutAlias.slice(0, headingIndex))
      .trim()
      .replaceAll("\\", "/");
    const heading = headingIndex < 0
      ? null
      : withoutAlias.slice(headingIndex + 1).trim() || null;
    if (target !== "") {
      targets.add(target);
      const key = `${target}\0${heading ?? ""}`;
      const reference = references.get(key) ?? {
        target,
        heading,
        occurrences: 0,
        unsafe: isUnsafeWikiTarget(target),
      };
      reference.occurrences += 1;
      references.set(key, reference);
      if (reference.unsafe) unsafe.add(target);
    }
    cursor = end + 2;

    if (occurrences > maxLinks || targets.size > maxLinks) break;
  }

  return {
    occurrences,
    targets: [...targets].sort(portableCompare),
    references: [...references.values()].sort((left, right) =>
      portableCompare(left.target, right.target) ||
      portableCompare(left.heading ?? "", right.heading ?? ""),
    ),
    unsafeTargets: [...unsafe].sort(portableCompare),
    overflow: occurrences > maxLinks || targets.size > maxLinks,
  };
}
