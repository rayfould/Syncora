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

Hook v7 is current. It keeps relevance-gated activation, autonomous capture,
and foreground drift routing from v6, and adds one explicit minimal-interruption
policy. Internal proposals are not user approval surfaces. The agent proceeds
with already-authorized, reversible work and pauses only for a material project
choice, unresolved ambiguity, unapproved external effect, host permission, or
destructive weakly reversible action over unusually broad data whose exact
scope was not authorized. It still routes substantive source mutation to the
foreground `check --changed` operation while forbidding checks on every turn,
background work, and after-final work. Exact proposal, artifact,
authorization, and receipt details remain internal audit evidence.

An exact tracked v1, v2, v3, v4, v5, or v6 hook retains its original
pre-Syncora restoration snapshot while its owned marker is upgraded to v7. A
diverged or untracked v1, v2, v3, v4, v5, or v6 hook instead refreshes the
restoration baseline from current user-owned bytes with only the old marker
removed, so a later unpatch cannot erase intervening edits. A hook newer than
v7 fails closed before target writes.

## Legacy-workflow cutover

`patch-agents` adds or upgrades Syncora-owned markers; it is not authority to
remove an unrelated broad knowledge-graph workflow. One explicit existing-graph
adoption request authorizes its full lifecycle: `adopt --dry-run` validates the
pack internally, then the digest-bound final `adopt` seals and applies it
without another approval prompt. Its internal cutover gate
runs only after staging and a passing shadow comparison; the equivalent
`migrate --phase cutover` command remains available for expert recovery. By
default, cutover requires the exact delimited predecessor workflow, replaces it
with hook v7, and records a predecessor-free restoration baseline in the
migration recovery journal. It preserves unrelated bytes, BOM, and newline
style.

The patch planner fails closed if an exact predecessor block or possible custom
predecessor activation remains outside Syncora-owned markers, including after
`setup --no-patch-agents`. `--confirm-predecessor-reviewed` is accepted only
after the old activation has actually been removed and never bypasses this
gate.

A custom, unmarked, malformed, or concurrently changed predecessor workflow
fails the cutover gate by default. Inspect all active Codex, Cursor, and Claude
instruction surfaces and remove any custom predecessor activation explicitly.
Only then may the skill pass `--confirm-predecessor-reviewed` to record that no
exact marker remains. The flag does not find or delete custom instructions.
Later `unpatch-agents` cannot reactivate the retired predecessor block.

Migration rollback is broader than ordinary unpatching: it restores the exact
pre-cutover agent bytes together with graph and runtime bytes. See
[legacy-adoption.md](legacy-adoption.md).
