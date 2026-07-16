# Agent patching

Syncora patches only project-local instruction files.

## Targets

- Ensure the shared hook exists in root `AGENTS.md` for Cursor and Codex.
- If `AGENTS.override.md` exists, patch it too.
- Do not create `.cursor/rules` by default.
- For Claude, patch existing root `CLAUDE.md`; otherwise existing
  `.claude/CLAUDE.md`; otherwise create `.claude/CLAUDE.md`.
- If the effective Claude file already imports the patched `AGENTS.md`, avoid a
  duplicate hook.

## Safety contract

- Validate every target before writing any target.
- Refuse duplicate, malformed, reversed, or nested Syncora markers.
- Preserve BOM, newline style, and unrelated text.
- Read agent targets and restoration snapshots through identity-stable bounded
  readers with a 1 MiB per-file limit.
- Bind the workspace and every existing ancestor directory through planning,
  temporary-file creation, and final publication; fail closed on replacement.
- Recheck each target before temporary creation and again before rename. Roll
  back partial failure only while the current bytes still exactly equal what
  Syncora published, so rollback cannot erase a concurrent user edit.
- Repeating the same patch must not change bytes.
- Serialize patch, unpatch, and initialization patching with one bounded
  workspace lock; dry-run remains non-mutating. Serialize acquisition, stale
  recovery, and release with a separate fail-closed recovery guard, and bind
  both to the captured runtime and lock-directory identities. Measure wait
  budgets with a monotonic clock; wall time is used only in owner records and
  stale-age checks.
- Verify every retained restoration snapshot before upgrading or reporting
  success.
- Observe every supported target in the transaction so root/nested Claude and
  override topology changes fail preflight instead of publishing stale plans.
- Unpatch only Syncora-owned marker content.
- Delete a Syncora-created file only when the recorded complete hash still
  proves exclusive ownership; otherwise preserve the file.

Commands:

```text
node "<syncora-skill-root>/scripts/syncora.mjs" patch-agents --workspace <absolute-path>
node "<syncora-skill-root>/scripts/syncora.mjs" unpatch-agents --workspace <absolute-path>
```

Both support `--dry-run` and `--format json`.

Hook v2 adds relevance-gated activation. An exact tracked v1 hook retains its
original pre-Syncora snapshot. A diverged or untracked v1 hook refreshes its
baseline from current user-owned bytes with only the old marker removed, so a
later unpatch cannot erase intervening edits.

## Legacy-workflow cutover

`patch-agents` adds or upgrades Syncora-owned markers; it is not authority to
remove an unrelated broad knowledge-graph workflow. Existing-graph adoption
uses `migrate --phase cutover` after manifest staging and a passing shadow
comparison. By default that phase requires the exact delimited predecessor
workflow, replaces it with hook v2, and records a predecessor-free restoration
baseline in the migration recovery journal. It preserves unrelated bytes, BOM,
and newline style.

A custom, unmarked, malformed, or concurrently changed predecessor workflow
fails the cutover gate by default. Inspect all active Codex, Cursor, and Claude
instruction surfaces and remove any custom predecessor activation explicitly.
Only then may the user pass `--confirm-predecessor-reviewed` to attest that no
exact marker remains. The flag does not find or delete custom instructions.
Later `unpatch-agents` cannot reactivate the retired predecessor block.

Migration rollback is broader than ordinary unpatching: it restores the exact
pre-cutover agent bytes together with graph and runtime bytes. See
[legacy-adoption.md](legacy-adoption.md).
