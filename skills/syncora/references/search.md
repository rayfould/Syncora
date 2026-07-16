# Authority-aware lexical search

Search requires an initialized workspace:

```text
node "<syncora-skill-root>/scripts/syncora.mjs" search --workspace <absolute-path> --query <text>
```

Use `--limit <1-50>` to bound results, `--format json` for the stable result
envelope, and `--no-cache` for a source-derived in-memory run. Use
`--include-history` only when historical and unpromoted evidence is explicitly
needed.

Default search materializes only routing, canonical, and supporting notes.
`--include-history` uses a separate cache profile that also admits historical
and unpromoted notes. This prevents excluded history from consuming the
default posting or byte budget. Transient and quarantined notes are never
vectorized or returned by either profile.

The cache lives under `.syncora/cache/lexical-v1/`, keyed by the resolved graph
root and search profile. Its specification also includes the Node Unicode
runtime used by normalization. It stores only source hashes and bounded term
vectors. It stores no body, summary, authority classification, hub selection,
decision state, alias resolution, or supersession result.

Every run rescans and rehashes Markdown. Unchanged path-and-hash vectors are
reused without retaining their bodies; changed eligible notes are loaded in
bounded batches and rebuilt; deleted notes are removed. Before any result or
cache publication, Syncora rechecks the graph root and raw-hash revision. A
same-size edit with a restored modification time therefore fails with
`READ001` instead of publishing a stale snapshot.

Cache payloads are capped at 16 MiB and 500,000 postings, with exact byte
preflight before whole-envelope serialization. Corrupt, oversized,
incompatible, or incomplete caches become misses and emit `CACHE001`. Cache
reads and writes recheck the validated cache-directory identity. Publication
uses a same-directory temporary file and atomic rename; stale owned temporary
files are removed conservatively. A publication failure returns the correct
in-memory results with a warning.

`.syncora/` is ignored machine-local runtime state. Checksums, grammar bounds,
and fresh source hashes detect accidental damage and stale vectors. Defending
against an actor who already has same-user write access and intentionally
rewrites both a cache and its checksum is outside the local-process threat
boundary; use `--no-cache` or delete `.syncora/cache/` when runtime state is not
trusted. Cached ranking still has zero selection authority.

`INDEX001` reports bounded index-construction failures. `SEARCH001` reports
empty or oversized query terms. Lexical scores have `selectionAuthority: none`
and must never resolve aliases, choose between conflicts, promote legacy notes,
or replace exact bindings and mandatory context.
