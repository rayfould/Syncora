# Security policy

## Current status

Syncora remains a development preview. The latest public tag is
`0.1.0-preview.1`; the default branch is the unpublished
`0.1.0-preview.2` candidate. Its runtime operates on local workspace,
instruction, graph, governance, and drift-state files, so path containment,
rollback, marker ownership, evidence integrity, and prompt-injection failures
are security-relevant even before a stable release.

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
- A drift finding proves only that exact bound source bytes changed after a
  baseline. It has zero authority, contains no replacement truth, and cannot
  authorize a canonical write.
- Exact raw-byte fingerprints are the drift authority. Git output is bounded
  advisory evidence and cannot suppress or validate a fingerprint result.
- Drift observations and findings live beneath the resolved graph and are
  sharded by workspace identity. Unsafe, corrupt, future-version, oversized,
  or mismatched state must fail closed rather than reset a baseline.
- Proposal, apply, and acknowledgment recheck active finding membership, the
  exact canonical note hash, and complete live binding fingerprints. Focused
  file references are not treated as complete module/glob provenance.
- Policy changes require a reasoned foreground rebaseline that publishes
  immutable migration and active-finding disposition evidence before replacing
  one workspace shard.
- Automatic drift selection covers `file`, `module`, and `path_glob` only.
  Symbol or component inference from prose, grep, or name similarity is outside
  the trust boundary.
- No daemon, watcher, timer, or after-response worker monitors the workspace;
  all drift detection and transaction recovery is foreground-only.
- Syncora cannot guarantee that an AI model will ignore malicious prose it has
  already read.

See [the architecture security model](docs/skill/architecture.md#17-security-model)
for the full design boundary.
