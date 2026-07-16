# Legacy knowledge graph adoption

Use this workflow when a workspace already has Markdown knowledge, a broad
predecessor agent workflow, or both. Do not run `init` first. Adoption runs
entirely in foreground commands and remains resumable and reversible; it never
depends on a timer, daemon, or background worker.

## Required sequence

Use one stable lowercase migration ID for the whole operation. Resolve the
workspace and any external graph root to exact absolute paths.

```text
node "<syncora-skill-root>/scripts/syncora.mjs" migrate --phase authority --dry-run --workspace <absolute-path>
node "<syncora-skill-root>/scripts/syncora.mjs" migrate --phase stage --migration-id <id> --manifest <absolute-v2-manifest> --staged-content <absolute-directory> --workspace <absolute-path> --dry-run
node "<syncora-skill-root>/scripts/syncora.mjs" migrate --phase stage --migration-id <id> --manifest <absolute-v2-manifest> --staged-content <absolute-directory> --workspace <absolute-path>
node "<syncora-skill-root>/scripts/syncora.mjs" migrate --phase shadow --migration-id <id> --fixtures <absolute-fixtures-json> --workspace <absolute-path> --dry-run
node "<syncora-skill-root>/scripts/syncora.mjs" migrate --phase shadow --migration-id <id> --fixtures <absolute-fixtures-json> --workspace <absolute-path>
node "<syncora-skill-root>/scripts/syncora.mjs" migrate --phase cutover --migration-id <id> --workspace <absolute-path> [--confirm-predecessor-reviewed] --dry-run
node "<syncora-skill-root>/scripts/syncora.mjs" migrate --phase cutover --migration-id <id> --workspace <absolute-path> [--confirm-predecessor-reviewed]
node "<syncora-skill-root>/scripts/syncora.mjs" migrate --phase verify --migration-id <id> --workspace <absolute-path>
node "<syncora-skill-root>/scripts/syncora.mjs" migrate --phase retire --migration-id <id> --workspace <absolute-path> --dry-run
node "<syncora-skill-root>/scripts/syncora.mjs" migrate --phase retire --migration-id <id> --workspace <absolute-path>
```

Ask for explicit user approval before each non-dry-run mutation. Pass
`--allow-external-graph-root <exact-absolute-path>` on every phase when the
resolved graph root is external.

## Phase gates

1. `authority` emits a paginated, metadata-only inventory. It cannot approve
   or mutate anything. Prepare a human-reviewed actionable v2 promotion
   manifest and exact staged target Markdown from that snapshot. See
   [migrate.md](migrate.md).
2. `stage` revalidates the source graph, manifest, prior target hashes, target
   frontmatter, body hashes, provenance, and resulting authority graph. It
   copies reviewed artifacts into graph-local migration storage but does not
   change canonical notes or agent files.
3. `shadow` compiles the virtual post-migration graph against bounded fixtures.
   Every required and evidence identity must fit its case budget, forbidden
   identities must stay out, and all cases must pass before cutover.
4. `cutover` rechecks every binding, then publishes only declared targets,
   initializes the workspace runtime, and replaces the exact predecessor agent
   marker in one recovery-journaled transaction. It never deletes legacy source
   bytes: replaced Markdown is copied byte-for-byte to
   `archive/migrations/<migration-id>/<original-path>`, which is excluded from
   active graph authority and context. A custom or unmarked predecessor
   workflow fails closed by default.
   Only after the active Codex, Cursor, and Claude instruction surfaces have
   been inspected and any custom predecessor activation has been removed may
   the user attest that review with `--confirm-predecessor-reviewed` on
   `cutover`; the attestation never removes custom instructions itself.
5. `verify` proves the active graph, declared target bytes, runtime, and agent
   hook still match the cutover receipt.
6. `retire` reruns verification and proves every legacy source still exists
   live, or in both the inactive Markdown archive and exact recovery evidence.
   Retirement records that predecessor activation and default authority are no
   longer active; it does not delete Markdown or discard rollback evidence.

Use `migrate --phase status --migration-id <id>` at any point after staging.
Status is read-only and does not accept `--dry-run`.

## Rollback

Rollback remains available after an interrupted or applied cutover,
verification, or retirement:

```text
node "<syncora-skill-root>/scripts/syncora.mjs" migrate --phase rollback --migration-id <id> --workspace <absolute-path> --dry-run
node "<syncora-skill-root>/scripts/syncora.mjs" migrate --phase rollback --migration-id <id> --workspace <absolute-path>
```

The applied rollback restores exact pre-cutover graph, runtime, and agent bytes
and removes files that cutover created. Migration evidence remains available so
the rollback is auditable. A stale hash, changed identity, missing receipt, or
invalid state transition fails closed; never bypass the gate with manual file
replacement.

## Durable artifacts

Lifecycle state, reviewed artifacts, shadow evidence, recovery bytes, receipts,
and verification reports live below the resolved graph root at
`local/.syncora/migrations/<migration-id>/` (or the equivalent path beneath an
external graph root). This directory is operational evidence, not canonical
project knowledge. Keep it until adoption is accepted and the rollback horizon
has been intentionally closed.
