# Link resolution and backlinks

Run:

```text
node "<syncora-skill-root>/scripts/syncora.mjs" backlinks --workspace <absolute-path> --note <path-or-alias>
```

Use `--limit <1-100>` to bound results and `--format json` for the stable result
envelope. Supply the exact external graph root when the workspace graph resolves
outside the workspace.

Resolution is deterministic and filesystem-free after graph discovery:

1. normalize separators, one terminal `.md`, Unicode NFC, and case;
2. resolve the complete graph-relative path;
3. only when no exact path exists, resolve a unique filename stem or note ID.

Exact paths always beat aliases. `README` is not a filename alias. Titles,
summaries, headings, backlink counts, authority, and lexical similarity never
choose a target. Heading fragments and display labels do not affect note
identity, and heading-only links create no backlink.

`LINK003` reports unresolved targets. `LINK004` reports ambiguous targets.
Canonical or routing sources make these errors; other safe authority classes
make them warnings. Referential findings never quarantine their source.

Backlinks are deduplicated source-to-target edges. They expose topology only:
they do not promote legacy notes, increase authority, or make quarantined
targets eligible for context retrieval.
