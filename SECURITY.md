# Security policy

## Current status

Syncora `0.1.0-preview.1` is a development preview. Its runtime operates on local
workspace and instruction files, so path containment, rollback, marker
ownership, and prompt-injection failures are security-relevant even before a
stable release.

## Reporting a vulnerability

Use [GitHub's private vulnerability reporting](https://github.com/rayfould/Syncora/security/advisories/new).
If that channel is unavailable, contact the repository owner privately through
their GitHub profile. Do not publish an exploitable path, overwrite, rollback,
or prompt-injection bypass before maintainers can assess it.

Include:

- affected Syncora version or commit;
- operating system and Node version;
- a minimal reproduction in a disposable workspace;
- files Syncora read or changed;
- whether a symlink, junction, worktree, or external graph root was involved;
- expected and actual containment or rollback behavior.

## Supported versions

No version is designated stable. Security fixes target the latest development
preview and the default branch until a stable support policy is published.

## Trust boundaries

- Markdown and frontmatter are untrusted data.
- Skill installation must not mutate a project.
- Workspace initialization is the mutation opt-in.
- Global agent configuration is outside the patcher's authority.
- External graph roots fail closed unless exactly allowlisted.
- Generated indexes, state, and context packs are not canonical knowledge.
- Syncora cannot guarantee that an AI model will ignore malicious prose it has
  already read.

See [the architecture security model](docs/skill/architecture.md#17-security-model)
for the full design boundary.
