# Authority migration inventory

Run the only implemented migration phase in explicit preview mode:

```text
node "<syncora-skill-root>/scripts/syncora.mjs" migrate --phase authority --dry-run --workspace <absolute-path>
```

If `local/` resolves outside the workspace, also pass the exact resolved path
with `--allow-external-graph-root`. This phase works before initialization and
does not create `.syncora/`, write a report, cache data, persist an allowlist,
or change source Markdown.

## Inventory is not approval

The command returns `syncora-authority-inventory-v1`, a zero-authority source
inventory. It is deliberately separate from a reviewed promotion manifest.
Generated output contains no promotion operations, proposed target values,
titles, bodies, summaries, legacy statuses, backlinks, timestamps, or lexical
scores. Never treat an inventory row as permission to promote a note.

Each discovered Markdown path appears exactly once in the complete paginated
inventory:

- `current-schema`: the current validator accepts the note's schema and it is
  not quarantined;
- `review-required`: the source is safe to inspect but remains unpromoted;
- `blocked`: the source is quarantined, invalid, future-schema, or otherwise
  unsafe but still has a complete raw-byte hash. Blocked classification wins
  over schema status. An unreadable or unhashable source aborts inventory with
  `READ001` instead of producing a row.

Classification is structural. Accepted wording, recency, directory, filename,
link count, backlink count, and search rank never change it.

## Bounded pages and snapshot identity

The default page contains at most 20 rows; `--limit` accepts 1 through 100. The
pretty-printed JSON envelope is also capped at 65,536 bytes, so unusually long
paths can shorten a page. Rows are ordered only by portable graph-relative
path.

Process the full inventory as an external batch artifact. Do not concatenate
every page or paste the complete inventory into one agent chat; page bounds
prevent one-response bloat but do not make an entire large graph cheap context.

When `page.nextCursor` is non-null, pass it unchanged:

```text
node "<syncora-skill-root>/scripts/syncora.mjs" migrate --phase authority --dry-run \
  --workspace <absolute-path> --cursor <opaque-token>
```

The cursor binds the inventory specification, validation policy, resolved graph
identity, full graph revision, and last returned path. A graph change, root
change, policy change, malformed cursor, or cursor from another graph fails
with `MIGRATE002`; restart from the first page. Do not decode or edit cursors.
The opaque token also checksums its last-row position, path, and raw source hash
so an edited seek position is rejected rather than silently skipping rows.
The policy digest includes an explicit validation rule-set identifier; any
classification-semantic change must bump that identifier so older cursors and
review artifacts fail closed.

The runtime performs a second full inspection immediately before publishing a
successful page. Incomplete reads or snapshot drift fail with `READ001` instead
of returning a mixed-revision inventory.

`summary.inventoryComplete` means the full graph scan succeeded. It does not
mean the current response contains every row. `page.complete` is true only when
one response contains the entire inventory; `page.endReached` marks the final
page of a multi-page traversal.

Cursor checks prevent accidental or naive token editing; they are not a secret
or an authentication boundary. A future manifest validator must independently
enumerate the bound graph and prove complete dispositions rather than trusting
which inventory pages a caller claims to have reviewed.

## Reviewed promotion manifest

The separate reviewed artifact is defined by
`assets/schemas/authority-promotion-manifest-v1.schema.json`. It binds:

- inventory specification, validation rule set, report schema, policy revision,
  graph-root identity, and graph revision;
- reviewer, review date, and reason;
- one explicit disposition for every `review-required` source;
- exact source paths and raw SHA-256 hashes;
- explicit target path, prior target hash or `null`, identity, kind, scope,
  state, authority, dates, summary, decision key, and semantic relations.

Allowed dispositions are `promote-via-targets`, `evidence-only`, and `defer`.
No missing target field may be copied or inferred from legacy metadata.

Promotion operations normalize to one or more sources and exactly one target.
Several sources in one operation represent a merge. Repeating one source
across several one-target operations represents a split. A target path may
appear in only one operation; a source may appear in several. A future manifest
validator must also prove that:

- each review-required source has exactly one disposition;
- the disposition set equals the review-required set exactly; current-schema
  and blocked rows cannot add extra dispositions;
- `promote-via-targets` sources participate in at least one operation;
- `evidence-only` and `defer` sources do not participate in operations;
- every operation source is review-required and has the
  `promote-via-targets` disposition; current-schema and blocked rows may only
  appear as pre-existing target paths through an exact prior hash;
- target paths, IDs, hubs, decision identities, and relations do not conflict;
- source hashes and expected prior target hashes still match.

The JSON Schema checks the local field shape. Cross-row completeness,
cardinality, graph semantics, and concurrency checks require the future
deterministic manifest validator. A reviewed manifest is a semantic review
artifact, not a write transaction; applying it remains unimplemented.

The schema bounds a merge to 256 sources, dispositions to 50,000, and
operations to 10,000. A future validator must reject a raw manifest larger than
33,554,432 bytes before text decoding or JSON parsing. This limit supports a
complete minimal disposition set at the maximum graph size while rejecting
unbounded relation or summary payloads.

Target bodies are intentionally absent. For merge and split, a later proposal
must provide exact reviewed target bytes, or a staged content artifact plus its
SHA-256, before any write transaction can be authorized. Canonical
`source_refs` are derived exactly from structured operation source path/hash
pairs; targets cannot supply a contradictory provenance list.

`promotionReady` therefore remains `false` in this runtime even when
`reviewQueueEmpty` is true. No generated or hand-authored file can activate an
unimplemented authority write path.

## Current boundary

This phase inventories compatibility state only. Before manifest acceptance is
implemented, schema validation still needs bounded identifier, scope, state,
date, and scalar rules plus scoped, reciprocal supersession checks. Source
bytes remain unchanged until a later dry-run transaction passes those checks
and the user explicitly authorizes application.
