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

Supported note kinds are `atlas`, `project`, `decision`, `concept`, `reference`,
`session`, and `inbox`.

- An atlas routes and does not own project state.
- A project hub owns current status for one scope.
- A decision owns one choice identified by `scope + decision_key`.
- A concept owns one stable technical truth.
- A reference is supporting evidence.
- A session is historical chronology and cannot override canonical notes.
- Inbox material is transient until classified.

The bootstrap runtime does not yet enforce the complete authority model. Do not
claim that legacy notes have effective authority. Read-only validation enforces
the current schema-v1 subset, while every missing-schema note remains
unpromoted until a later reviewed migration.

Wiki links resolve by graph-relative path first, then by a unique filename stem
or frontmatter `id`. Exact paths are portable-case and Unicode normalized and
always beat aliases. H1 titles, summaries, backlink counts, and lexical search
are not identity and cannot resolve an ambiguous link.
