import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const skillRoot = join(testDirectory, "..", "..", "skills", "syncora");
const normalizeWhitespace = (value) => value.replace(/\s+/gu, " ").trim();

test("long approval artifacts provide a bounded decision brief", async () => {
  const boundaries = normalizeWhitespace(
    await readFile(
      join(skillRoot, "references", "decision-boundaries.md"),
      "utf8",
    ),
  );
  const hook = normalizeWhitespace(
    await readFile(
      join(skillRoot, "assets", "agent-hooks", "shared.md"),
      "utf8",
    ),
  );

  for (const source of [boundaries, hook]) {
    assert.match(source, /`Decision brief` of no more than 200 words/i);
    assert.match(source, /recommendation/i);
    assert.match(source, /tradeoffs/i);
    assert.match(source, /risks and rollback/i);
    assert.match(source, /open decisions/i);
    assert.match(
      source,
      /(?:Do not|Never) make `Please review the full spec and say proceed` the only approval surface/i,
    );
  }

  assert.match(boundaries, /Proceed with the recommended approach\?/i);
  assert.match(boundaries, /at most three options with one-line pros and cons/i);
  assert.match(boundaries, /link the detailed artifact for\s+optional inspection/i);
});
