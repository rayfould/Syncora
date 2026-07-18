# Initial graph schema

Canonical knowledge is Markdown under `local/`. Runtime configuration and
derived state live under `.syncora/`.

The initial bootstrap creates a small atlas and one workspace hub. It does not
create accumulating current-state logs.

Common frontmatter fields:

```yaml
id: project-workspace
kind: project
scope: workspace
state: active
authority: canonical
schema_version: 1
created: 2026-07-15
updated: 2026-07-15
summary: Central hub for the workspace.
```

Use typed `applies_to` bindings when a decision, concept, reference, or session
applies to a concrete task target:

```yaml
applies_to:
  - file:src/api/session.ts
  - module:src/auth
  - component:SessionPanel
  - path_glob:src/**/*.test.ts
  - symbol:createSession
```

The supported kinds are `file`, `module`, `component`, `path_glob`, and
`symbol`. Paths are workspace-relative and use `/`. A module or path-glob
binding may match a concrete `file:` task target. Untyped schema-v1 values are
retained as review evidence but cannot select task context; migrate them to a
typed form after semantic review.

Typed target references are trimmed and NFC-normalized; path kinds also
normalize `\` to `/`. Case is preserved, and exact code identities and target
matching are case-sensitive. For example, `symbol:createSession` and
`symbol:CreateSession` are distinct bindings. This target-binding rule is
separate from the wiki-link resolution rules below.

Glob bindings use a deliberately bounded grammar: `?`, at most one `*` per
ordinary segment, and at most one `**` that occupies a complete segment.
Classes, braces, embedded `**`, repeated `*`, non-portable path characters,
Windows device names, and trailing dots or spaces are invalid. A binding only
routes context while its note is otherwise eligible by authority, state, mode,
and scope.

Supported note kinds are `atlas`, `project`, `decision`, `concept`, `reference`,
`session`, and `inbox`.

- An atlas routes and does not own project state.
- A project hub owns current status for one scope.
- A decision owns one choice identified by `scope + decision_key`.
- A concept owns one stable technical truth.
- A reference is supporting evidence.
- A session is historical chronology and cannot override canonical notes.
- Inbox material is transient until classified.

The runtime enforces the supported schema-v1 authority invariants; it does not
infer authority for legacy notes. Every missing-schema note remains unpromoted
until it enters canonical authority through the reviewed v2 adoption workflow.

Wiki links resolve by graph-relative path first, then by a unique filename stem
or frontmatter `id`. Exact paths are portable-case and Unicode normalized and
always beat aliases. H1 titles, summaries, backlink counts, and lexical search
are not identity and cannot resolve an ambiguous link.
