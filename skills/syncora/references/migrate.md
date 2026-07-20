# Authority inventory and promotion artifacts

This reference defines the semantic inputs and the expert phase surface. The
normal path is one user-level adoption operation: preview the complete reviewed
pack with `adopt --dry-run`, obtain one digest-bound approval, then rerun
`adopt` with `--expected-bundle-digest`. Do not expose a series of user-driven
phase approvals. The internal content-addressed bundle uses
`assets/schemas/adoption-bundle-v1.schema.json` and binds its migration ID,
reviewed manifest, fixtures, and every staged target byte.

Begin every existing-graph adoption with the read-only authority inventory:

```text
node "<syncora-skill-root>/scripts/syncora.mjs" migrate --phase authority --dry-run --workspace <absolute-path>
```

If `local/` resolves outside the workspace, also pass the exact resolved path
with `--allow-external-graph-root`. This phase works before initialization and
does not create `.syncora/`, write a report, cache data, persist an allowlist,
or change source Markdown.

After review, the supported lifecycle is `stage`, `shadow`, `cutover`,
`verify`, and `retire`, with `status` and `rollback` available as control
operations. Follow [legacy-adoption.md](legacy-adoption.md); do not run `init`
or `setup` against a legacy graph.

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
or an authentication boundary. The stage validator independently enumerates
the bound graph and proves complete dispositions rather than trusting which
inventory pages a caller claims to have reviewed.

## Reviewed promotion manifest

Schema v1 remains a valid non-actionable review artifact. Only a reviewed v2
artifact defined by
`assets/schemas/authority-promotion-manifest-v2.schema.json` can be staged. It
binds:

- inventory specification, validation rule set, report schema, policy revision,
  graph-root identity, and graph revision;
- reviewer, review date, and reason;
- one explicit disposition for every `review-required` source;
- exact source paths and raw SHA-256 hashes;
- explicit target path, prior target hash or `null`, identity, kind, scope,
  state, authority, dates, summary, decision key, and semantic relations;
- exact target-body SHA-256 and structured source provenance.

Allowed dispositions are `promote-via-targets`, `evidence-only`, and `defer`.
No missing target field may be copied or inferred from legacy metadata.

Promotion operations normalize to one or more sources and exactly one target.
Several sources in one operation represent a merge. Repeating one source
across several one-target operations represents a split. A target path may
appear in only one operation; a source may appear in several. The deterministic
validator proves that:

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

JSON Schema checks local field shape. Deterministic validation also checks
cross-row completeness, cardinality, graph semantics, exact graph and source
bindings, prior target bytes, portable identities, hub uniqueness, decision
authority, and reciprocal supersession. A stale or semantically invalid
manifest fails before staging.

The schema bounds a merge to 256 sources, dispositions to 50,000, and
operations to 10,000. The runtime rejects a raw manifest larger than 33,554,432
bytes before JSON use.

Target bodies stay outside the manifest. Supply exact reviewed Markdown below
an absolute staged-content directory at each declared target path. Stage checks
that frontmatter equals the manifest, body bytes match `contentSha256`, and
canonical `source_refs` equal the structured operation source path/hash pairs.
The staged bundle is bounded to 10,000 targets and 64 MiB total.

No inventory field grants promotion authority. The actionable gate is an exact
reviewed v2 manifest plus staged target content that passes `migrate --phase
stage`; cutover additionally requires a recorded passing shadow comparison and
explicit user authorization.

## Shadow fixture contract

`migrate --phase shadow` accepts strict JSON with
`schemaVersion: 1`, `kind: "syncora-shadow-fixtures-v1"`, and 1 through 100
cases. Each case declares a unique `caseId`, `scope`, `query`, a 1,000 through
64,000 character budget, plus exact `requiredIds`, `evidenceIds`, and
`forbiddenIds` arrays. The runtime compiles the virtual graph with staged
targets before canonical mutation. Every case must pass the authority,
provenance, identity, and budget checks before cutover is eligible.

Source notes remain unchanged through inventory, stage, and shadow. Cutover
writes only declared targets and runtime/agent activation files, retaining
legacy sources and exact recovery bytes. Retirement never deletes notes.
