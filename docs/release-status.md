# Release status

Current version: **0.1.0-preview.1**

Status: **development preview**

The public preview establishes the portable and safety-critical foundation. It
is intended for collaborators who are comfortable testing pre-stable software
in version-controlled workspaces.

## Implemented

- dependency-free Node runtime;
- hub-first graph bootstrap;
- workspace and resolved-path containment;
- Codex, Cursor, and Claude project instruction patching;
- ownership-aware unpatch and rollback;
- bounded doctor, validate, search, and backlinks commands;
- foreground checkpoint policy and state;
- zero-authority, dry-run migration inventory;
- cross-platform Node 22 and 24 test suite.

## Not implemented

- budgeted task context compilation;
- governed capture and proposal lifecycle;
- promotion-manifest acceptance and application;
- changed-file and symbol drift detection;
- clean-room activation proof across current agent releases;
- ten-thousand-note performance acceptance;
- stable compatibility and support guarantees.

These missing capabilities are part of Syncora's accepted architecture, not
hidden preview behavior. The stable release is blocked until the full
[architecture acceptance gate](skill/architecture.md#20-release-acceptance)
passes.

## Preview safety expectations

- Test in a Git repository or another recoverable workspace.
- Review dry-run output before mutation.
- Keep canonical `local/` Markdown under your own backup or version control.
- Report containment, rollback, or marker-ownership failures privately.
- Do not treat generated `.syncora/` state as canonical knowledge.
