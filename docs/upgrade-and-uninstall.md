# Upgrade and uninstall

## Upgrade

Update a globally installed skill:

```bash
npx skills update syncora --global
```

Before an upgrade, inspect `migrate --phase status` for any active legacy
migration and retain its graph-local recovery directory. Do not switch runtime
versions midway through an unresolved cutover or rollback transaction.

After an upgrade, ask Syncora to run `doctor` and `validate` in each active
workspace, then run one foreground `check --changed`. A compatible retained
baseline may continue; future, corrupt, oversized, identity-mismatched, or
policy-incompatible drift state fails closed. Compatible retained state
proceeds through the ordinary check and must not be rebaselined merely because
the runtime was upgraded.

Only when the check or doctor reports `DRIFT_POLICY_MISMATCH`, review the
retained baseline and every active finding, then run this explicit foreground
recovery command:

```bash
node <installed-syncora-skill>/scripts/syncora.mjs check --changed --rebaseline --reason "Reviewed drift-policy upgrade" --workspace /absolute/path/to/project
```

That command publishes an immutable rebaseline record and exact dispositions
for active findings before atomically replacing this workspace's state shard.
It cannot override corrupt, future-schema, or identity-mismatched state. An
upgrade never silently resets the baseline or rewrites canonical Markdown.

Do not run `setup` or its `init` compatibility alias as an upgrade path for a
workspace with existing knowledge. Use the
[legacy adoption workflow](legacy-kg-adoption.md) when converting a predecessor
graph. A marker-only workspace with no graph remains the documented `setup`
case. A custom or unmarked predecessor with no graph must be removed after
review, then followed by `setup --confirm-predecessor-reviewed`; do not create
an empty adoption bundle.

## Unpatch a workspace

Before uninstalling, remove Syncora-owned project instruction markers:

```bash
node <installed-syncora-skill>/scripts/syncora.mjs unpatch-agents --workspace /absolute/path/to/project --dry-run
node <installed-syncora-skill>/scripts/syncora.mjs unpatch-agents --workspace /absolute/path/to/project
```

The first command previews the change. The second removes or restores only
content owned by Syncora's patch transaction.

## Remove the installed skill

```bash
npx skills remove syncora --global --agent '*' --yes
```

If installed project-locally, omit `--global` and run the command from that
project.

## Data retained by design

Uninstalling does not delete:

- `local/` canonical Markdown;
- user-authored agent instructions;
- version-control history.

It also does not automatically delete graph-local proposals, transactions,
migration evidence, or workspace-sharded drift observations and findings.

Derived `.syncora/` runtime state is noncanonical. It may be removed only after
you have unpatched agent files and confirmed that no foreground Syncora command
is running. Keep it when diagnosing a bug because it can contain useful state
and recovery metadata. Deleting
`<resolved-graph>/.syncora/drift/workspaces/<workspace-identity>/` discards that
workspace's comparison baseline, active findings, proposal bindings, and
acknowledgment audit trail. Do not treat that as routine cleanup while review
work remains unresolved; a later first observation can establish only a new
baseline, not reconstruct historical freshness.

Migration evidence under `local/.syncora/migrations/<migration-id>/` is also
operational rather than canonical, but it is not disposable while a migration
is active or rollback is expected. Before uninstalling an adopted workspace,
inspect `migrate --phase status`. Either keep the verified or retired adoption
and its intended rollback evidence, or explicitly run `rollback`; ordinary
`unpatch-agents` removes the current Syncora hook but does not reconstruct the
complete pre-cutover graph and runtime state.
