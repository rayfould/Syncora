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
workspace. Future schema migrations must remain explicit, previewable, and
reversible; installing a newer skill must never silently rewrite canonical
Markdown.

Do not run `init` as an upgrade path for a workspace with existing knowledge.
Use the [legacy adoption workflow](legacy-kg-adoption.md) when converting a
predecessor graph or instruction block.

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

Derived `.syncora/` runtime state is noncanonical. It may be removed only after
you have unpatched agent files and confirmed that no foreground Syncora command
is running. Keep it when diagnosing a bug because it can contain useful state
and recovery metadata.

Migration evidence under `local/.syncora/migrations/<migration-id>/` is also
operational rather than canonical, but it is not disposable while a migration
is active or rollback is expected. Before uninstalling an adopted workspace,
inspect `migrate --phase status`. Either keep the verified or retired adoption
and its intended rollback evidence, or explicitly run `rollback`; ordinary
`unpatch-agents` removes the current Syncora hook but does not reconstruct the
complete pre-cutover graph and runtime state.
