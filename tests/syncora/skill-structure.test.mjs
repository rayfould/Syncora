import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(testDirectory, "..", "..");
const skillRoot = join(testDirectory, "..", "..", "skills", "syncora");

test("skill frontmatter and progressive references are self-contained", async () => {
  const skill = await readFile(join(skillRoot, "SKILL.md"), "utf8");
  const frontmatter = skill.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(frontmatter, "SKILL.md must start with YAML frontmatter");

  const topLevelKeys = frontmatter[1]
    .split(/\r?\n/)
    .filter((line) => /^[a-z_]+:/.test(line))
    .map((line) => line.slice(0, line.indexOf(":")))
    .sort();
  assert.deepEqual(topLevelKeys, ["description", "name"]);

  const references = [
    ...skill.matchAll(/\]\((references\/[^)]+\.md)\)/g),
  ].map((match) => match[1]);
  assert.ok(references.length >= 3);
  assert.ok(references.includes("references/legacy-adoption.md"));
  for (const reference of references) {
    await access(join(skillRoot, ...reference.split("/")));
  }

  await access(join(skillRoot, "scripts", "syncora.mjs"));
  await access(join(skillRoot, "assets", "agent-hooks", "shared.md"));
  assert.match(skill, /absolute directory containing this\s+loaded `SKILL\.md`/);
  assert.match(skill, /never\s+assume the active project's working directory contains Syncora's `scripts\/`/);

  const commandDocuments = [
    skill,
    ...(await Promise.all(
      references.map((reference) =>
        readFile(join(skillRoot, ...reference.split("/")), "utf8"),
      ),
    )),
  ];
  for (const document of commandDocuments) {
    assert.doesNotMatch(document, /node scripts\/syncora\.mjs/);
  }
  assert.match(skill, /node "<syncora-skill-root>\/scripts\/syncora\.mjs"/);
});

test("activation is relevance-gated and exposes all five profiles", async () => {
  const skill = await readFile(join(skillRoot, "SKILL.md"), "utf8");
  const policy = await readFile(
    join(skillRoot, "references", "activation-policy.md"),
    "utf8",
  );
  const checkpoint = await readFile(
    join(skillRoot, "references", "checkpoint.md"),
    "utf8",
  );
  const hook = await readFile(
    join(skillRoot, "assets", "agent-hooks", "shared.md"),
    "utf8",
  );

  assert.match(skill, /Do not invoke merely because `\.syncora\/config\.json` exists/);
  assert.match(skill, /ordinary work in an uninitialized workspace/);
  assert.match(skill, /Every implicit project route requires/);
  assert.match(skill, /date\/time, arithmetic, translation, casual conversation/);
  for (const profile of [
    "none",
    "checkpoint",
    "context",
    "capture",
    "maintenance",
  ]) {
    assert.match(policy, new RegExp("\\| `" + profile + "` \\|"));
  }
  assert.match(policy, /uncertain, select `checkpoint`/);
  assert.match(policy, /global\s+skills\.sh installation must remain inert/);
  assert.match(policy, /If it does not, select `none`/);
  assert.match(policy, /explicit user request to skip Syncora selects `none`/i);
  assert.match(policy, /pre-work mode/);
  assert.match(policy, /independent post-work change disposition/);
  assert.match(policy, /selecting `capture` never grants/);
  assert.match(policy, /Project-local code-only tasks/);
  assert.match(policy, /Reuse the existing checkpoint ID/);
  assert.match(checkpoint, /50 completed pre-work activations/);
  assert.match(checkpoint, /168 hours/);
  assert.match(checkpoint, /before the final response, never after it/);
  assert.match(checkpoint, /completed-degraded/);
  assert.match(checkpoint, /post requires that ID and is idempotent/);
  assert.match(checkpoint, /changeFingerprint/);
  assert.match(checkpoint, /metadata tier is not content authority/);
  assert.match(checkpoint, /reports `no-change`/);
  assert.match(checkpoint, /`unattributed-change`/);
  assert.match(checkpoint, /normal\s+code edit, discussion, proposal/);
  assert.match(checkpoint, /never run a second\s+preflight/);
  assert.match(hook, /syncora-agent-hook:begin v2/);
  assert.match(hook, /installed does not make every request a Syncora task/);
  assert.match(hook, /Without initialization, ordinary work stays inactive/);
  assert.doesNotMatch(hook, /When `\.syncora\/config\.json` exists, use/);
});

test("optional OpenAI metadata stays presentation-only", async () => {
  const metadata = await readFile(
    join(skillRoot, "agents", "openai.yaml"),
    "utf8",
  );
  assert.match(metadata, /display_name: "Syncora"/);
  assert.match(metadata, /default_prompt: "Use \$syncora/);
  assert.doesNotMatch(metadata, /dependencies:/);
});

test("legacy adoption documentation and release gates stay bundled", async () => {
  await access(join(repositoryRoot, "docs", "legacy-kg-adoption.md"));
  await access(
    join(skillRoot, "assets", "schemas", "authority-promotion-manifest-v2.schema.json"),
  );
  await access(join(skillRoot, "references", "legacy-adoption.md"));
  await access(join(repositoryRoot, "scripts", "smoke-legacy-adoption.mjs"));

  const packageJson = JSON.parse(
    await readFile(join(repositoryRoot, "package.json"), "utf8"),
  );
  assert.equal(
    packageJson.scripts["test:adoption"],
    "node --test --test-concurrency=1 tests/syncora/adoption.test.mjs",
  );
  assert.equal(
    packageJson.scripts["smoke:adoption"],
    "node scripts/smoke-legacy-adoption.mjs",
  );
  assert.match(packageJson.scripts.check, /npm run test:skill/);
  assert.doesNotMatch(packageJson.scripts.check, /npm run test:adoption/);

  const workflow = await readFile(
    join(repositoryRoot, ".github", "workflows", "syncora-skill.yml"),
    "utf8",
  );
  assert.equal(workflow.match(/npm run check/g)?.length, 1);
  assert.equal(workflow.match(/npm run smoke:adoption/g)?.length, 1);
  assert.doesNotMatch(workflow, /npm run test:adoption/);
});
