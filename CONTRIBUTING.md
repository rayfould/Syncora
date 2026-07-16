# Contributing to Syncora

Syncora is a portable, local-first Agent Skill. Start with the
[accepted architecture](docs/skill/architecture.md), the
[implementation plan](docs/skill/implementation-plan.md), and the current
[release boundary](docs/release-status.md).

## Development rules

- Keep the installed skill self-contained under `skills/syncora/`.
- Use Node standard-library modules in the portable runtime.
- Do not couple the skill to a hosted service, database, editor extension, or
  one coding agent.
- Resolve bundled assets from `import.meta.url`, never from the current working
  directory.
- Require absolute workspace paths for mutation.
- Keep installation inert and initialization explicit.
- Preserve existing bytes, encodings, line endings, and unrelated content.
- Add tests for every mutation, rollback, containment, or schema change.
- Do not use live user workspaces as test fixtures.

## Validation

Run:

```text
npm ci
npm run check
git diff --check
```

Changes to distribution layout or installation behavior must also pass:

```text
npm run smoke:install
```

The smoke test downloads the pinned Skills CLI and installs Syncora into a
disposable temporary workspace.

## Pull requests

Keep each pull request within one independently testable workstream. Explain:

- the invariant being added or changed;
- failure and rollback behavior;
- compatibility impact;
- tests added;
- whether canonical graph semantics changed;
- whether the public capability boundary changed.

Do not present planned capabilities as implemented.
