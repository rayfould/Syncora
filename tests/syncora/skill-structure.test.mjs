import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(testDirectory, "..", "..");
const skillRoot = join(testDirectory, "..", "..", "skills", "syncora");
const normalizeWhitespace = (value) => value.replace(/\s+/gu, " ").trim();

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

  const description = frontmatter[1].match(/^description:\s*(.+)$/m)?.[1];
  assert.ok(description, "SKILL.md must include a public description");
  assert.ok(
    description.length <= 600,
    "public description should stay concise and scannable",
  );
  assert.match(description, /durable,?\s+local project memory/i);
  assert.match(description, /development preview/i);

  const quickStartIndex = skill.indexOf("## Quick start");
  const agentInstructionsIndex = skill.indexOf("## Agent instructions");
  assert.ok(quickStartIndex >= 0, "SKILL.md must include a public quick start");
  assert.ok(
    agentInstructionsIndex > quickStartIndex,
    "human-facing guidance must precede internal agent instructions",
  );
  const intro = skill.slice(
    skill.indexOf("# Syncora") + "# Syncora".length,
    quickStartIndex,
  );
  assert.match(intro, /durable[\s\S]{0,60}project knowledge/i);
  assert.doesNotMatch(
    intro,
    /<syncora-skill-root>|--workspace|checkpoint --phase/i,
  );
  const quickStart = skill.slice(quickStartIndex, agentInstructionsIndex);
  const prompts = [...quickStart.matchAll(/```text\r?\n([\s\S]*?)\r?\n```/gu)].map(
    (match) => match[1].trim(),
  );
  assert.ok(
    prompts.some((prompt) => /^Use \$syncora to set up\b/iu.test(prompt)),
  );
  assert.ok(
    prompts.some((prompt) => /^Use \$syncora to adopt\b/iu.test(prompt)),
  );
  assert.match(quickStart, /new workspace/iu);
  assert.match(quickStart, /existing knowledge graph|agent-memory workflow/iu);
  assert.match(
    quickStart,
    /README and documentation files[\s\S]{0,80}not[\s\S]{0,40}reason to use adoption/iu,
  );

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
  const normalizedSkill = normalizeWhitespace(skill);
  assert.match(
    normalizedSkill,
    /absolute directory containing this loaded `SKILL\.md`/,
  );
  assert.match(
    normalizedSkill,
    /never assume the active project's working directory contains Syncora's `scripts\/`/,
  );

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
  const normalizedSkill = normalizeWhitespace(skill);
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
  assert.match(normalizedSkill, /Every implicit project route requires/);
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
  const shortDescription = metadata.match(
    /short_description: "([^"]+)"/,
  )?.[1];
  assert.ok(shortDescription, "OpenAI metadata needs a short description");
  assert.ok(shortDescription.length >= 25 && shortDescription.length <= 64);
  assert.match(shortDescription, /project|workspace/i);
  assert.match(shortDescription, /memory|context|knowledge/i);
  const defaultPrompt = metadata.match(/default_prompt: "([^"]+)"/)?.[1];
  assert.ok(defaultPrompt, "OpenAI metadata needs a default prompt");
  assert.match(defaultPrompt, /\$syncora/);
  assert.match(defaultPrompt, /set up/i);
  assert.match(defaultPrompt, /adopt/i);
  assert.match(defaultPrompt, /project|workspace/i);
  assert.doesNotMatch(metadata, /dependencies:/);
});

test("legacy adoption documentation and release gates stay bundled", async () => {
  await access(join(repositoryRoot, "docs", "legacy-kg-adoption.md"));
  await access(
    join(skillRoot, "assets", "schemas", "authority-promotion-manifest-v2.schema.json"),
  );
  await access(
    join(skillRoot, "assets", "schemas", "adoption-bundle-v1.schema.json"),
  );
  await access(join(skillRoot, "references", "legacy-adoption.md"));
  await access(join(repositoryRoot, "scripts", "smoke-legacy-adoption.mjs"));

  const skill = await readFile(join(skillRoot, "SKILL.md"), "utf8");
  const normalizedSkill = normalizeWhitespace(skill);
  const adoption = await readFile(
    join(skillRoot, "references", "legacy-adoption.md"),
    "utf8",
  );
  assert.match(skill, /explicit request to set up Syncora/);
  assert.match(normalizedSkill, /one `adopt --bundle`/);
  assert.match(adoption, /One explicit authorization/);
  assert.match(adoption, /internal phases/);
  assert.doesNotMatch(adoption, /approval before each non-dry-run/i);

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
