# Read-only graph validation

Run:

```text
node "<syncora-skill-root>/scripts/syncora.mjs" validate --workspace <absolute-path>
```

Use `--format json` for the stable report envelope. If `local/` resolves outside
the workspace, also pass `--allow-external-graph-root <exact-absolute-path>`.
The supplied allowlist is not persisted by validation.

Validation works before initialization and never writes notes, configuration,
caches, reports, or allowlists. It recursively reads Markdown as raw bytes,
uses fatal UTF-8 decoding, hashes original bytes, parses constrained
frontmatter, resolves bounded wiki links, builds in-memory backlinks, and
returns a deterministic graph revision.

The report includes `validationSpecification`. Any change to classification or
validation semantics must bump this rule-set identifier even when numeric
limits remain unchanged.

The default report is deliberately aggregate. It includes counts, bounded
examples, diagnostics, policy limits, and no complete note-content array.
`files.parsed` and `files.quarantined` are mutually exclusive. Schema counts
describe structural schema status, so a current-schema note can still appear in
the quarantined authority count when its bytes, links, path, or authority are
unsafe.

## Classification

- Structurally valid schema-v1 notes use their declared project-data authority.
- Notes without `schema_version` remain `unpromoted`, even when legacy status or
  prose says accepted, active, canonical, or current.
- Invalid UTF-8, NUL bytes, malformed frontmatter, oversized notes, excessive
  link fanout, unsafe links, future schemas, and nonportable paths are
  quarantined without editing or deleting them.
- Note authority never becomes system, user, or operational instruction
  authority.

## Exit behavior

- Exit `0`: scan completed with warnings but no error diagnostics.
- Exit `1` with a report on stdout: scan completed and found validation errors.
- Exit `1` with an error envelope on stderr: graph discovery or command
  execution could not complete safely.

Important diagnostic families include `ENC`, `FM`, `SCHEMA`, `NOTE`, `LINK`,
`PATH`, `ID`, `HUB`, `AUTH`, and `READ`. Codes and report fields are stable
within report schema version 1.

`LINK003` identifies unresolved targets and `LINK004` identifies ambiguous
targets. Exact paths resolve before unique filename or ID aliases. Their
severity follows source authority, but neither code quarantines the source.
The aggregate report exposes resolution and backlink-edge counts without a
complete notes or edges array.

`LINK005` fails validation before graph-wide unique references or resolved
edges exceed their hard materialization ceilings. Backlinks and task context
consume the resulting bounded adjacency maps.

Validation never reads or writes the lexical cache. Cache presence, corruption,
or deletion cannot change validation output or graph revision.

The current authority validator checks schema-v1 IDs, authority ceilings,
active-hub uniqueness, accepted-decision uniqueness, and missing, self, or
cyclic `supersedes` targets. Full reciprocal supersession enforcement waits for
the note schema to define the reverse relationship explicitly.
