# Legacy knowledge graph adoption

Use this workflow when a workspace already has a Markdown knowledge graph. If
no graph exists and only the exact supported predecessor marker is present, use
one ordinary `setup` command instead. For a custom or unmarked predecessor with
no graph, inspect all active agent files, remove the predecessor activation,
then use one `setup --confirm-predecessor-reviewed` command; do not invent an
empty adoption bundle. Do not run `setup` or `init` before existing-graph
adoption. Adoption remains foreground, resumable, and reversible.

## Default single adoption operation

Use one stable lowercase migration ID for the whole operation. Resolve the
workspace and any external graph root to exact absolute paths.

```text
node "<syncora-skill-root>/scripts/syncora.mjs" adopt --workspace <absolute-path> --migration-id <id> --manifest <absolute-review-manifest> --staged-content <absolute-staged-directory> --fixtures <absolute-shadow-fixtures> --dry-run
node "<syncora-skill-root>/scripts/syncora.mjs" adopt --workspace <absolute-path> --migration-id <id> --manifest <absolute-review-manifest> --staged-content <absolute-staged-directory> --fixtures <absolute-shadow-fixtures> --expected-bundle-digest <reviewed-sha256>
```

The user asks for adoption once. The agent inventories the old graph and
prepares the reviewed v2 manifest, staged Markdown, and shadow fixtures. The
first `adopt` invocation is a non-mutating preview that validates the complete
pack and returns a bounded `approvalSummary` plus its exact bundle digest.
Present only the summary in one approval request by default: purpose,
reviewed/promoted/evidence-only
counts, target count, affected areas, no more than eight representative paths,
explicit omissions, instruction cutover, preservation, and warnings. Offer the
review pack only when the user asks for full details. Never dump the complete
manifest or ask the user to copy the digest. After a plain Yes or Approved
response, the final `adopt` invocation must bind
`--expected-bundle-digest` to that exact value internally.

Final adoption revalidates the current graph and reviewed bytes, seals the
content-addressed descriptor atomically, and applies stage, shadow, cutover,
verify, and retire. Each gate fails closed, no canonical bytes change before
cutover, rollback evidence remains available, and rerunning the same final
command resumes from recorded state. The older standalone `bundle` plus
`adopt --bundle` form remains supported only for compatibility and expert
recovery. Pass
`--allow-external-graph-root <exact-absolute-path>` when the resolved graph root
is external.

A caught cutover or verification failure automatically attempts exact rollback
inside the same graph/workspace lock. If concurrent bytes prevent restoration,
Syncora preserves them, reports `MIGRATE017`, and leaves the journal available
for explicit recovery. A retirement failure leaves verified state and resumes
retirement on the next identical command.

If no exact predecessor marker exists, inspect all active agent files and
remove any custom predecessor activation. Then rerun the same command with
`--confirm-predecessor-reviewed`. This attests review; it does not delete
custom instructions.

Use `migrate --phase authority --dry-run` internally while preparing the
reviewed adoption pack.
Use the individual `migrate --phase ...` commands only for expert inspection,
targeted previews, recovery, or rollback. Do not turn those internal phases
into separate user approval prompts during normal adoption.

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
