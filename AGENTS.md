# Repository instructions

This is the canonical public repository for the portable Syncora Agent Skill.

## Architecture invariants

- Keep the installed skill self-contained under `skills/syncora/`.
- Keep `SKILL.md` frontmatter limited to `name` and `description`.
- Keep `skills/syncora/agents/openai.yaml` aligned with the public skill name
  and an explicit `$syncora` invocation.
- Resolve bundled files from the skill root, never the caller's current working
  directory.
- Keep installation inert. Workspace mutation requires an explicit user action.
- Keep all work foreground-only; the skill has no daemon or background worker.
- Require absolute workspace roots for mutation and resolve real paths before
  writes.
- Preserve bounded I/O, fail-closed containment, marker ownership, and
  reversible agent patching.
- Treat setup and reviewed bundle/adoption as outcome-scoped operations. Keep
  migration phases as internal recovery boundaries; do not turn them into
  separate user approval prompts.
- Keep context-compilation claims aligned with its canonical-Markdown-read-only
  tested contract and disclose its optional disposable cache write. Do not claim
  governed capture or drift detection until those capabilities and their
  acceptance tests exist.
- Keep human-facing repository documentation outside the installed skill.

## Validation

Run before committing:

```text
npm run check
git diff --check
```

Run the networked installer smoke test when changing distribution layout,
metadata, or installation documentation:

```text
npm run smoke:install
```

Run `npm run smoke:adoption` when changing the installed bundle/adoption path.

Use only disposable temporary workspaces in tests. Never initialize or mutate a
real user workspace as a fixture.
