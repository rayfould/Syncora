# Releasing Syncora

Syncora uses semantic versions. Preview tags use the form
`vMAJOR.MINOR.PATCH-preview.N` and must be published as GitHub prereleases.

## Preview release

1. Update the version in `package.json` and
   `skills/syncora/scripts/lib/cli.mjs`.
2. Update `CHANGELOG.md` and `docs/release-status.md`.
3. Run `npm ci` and `npm run check` on a clean tree.
4. Run `npm run smoke:install` with network access. Confirm it uses an isolated
   home, installs globally through the pinned Skills CLI, proves the shared
   canonical target for Codex and Cursor, and resolves the Claude Code
   destination.
5. Run `npm run smoke:adoption` and retain its successful installed-copy output
   with the release evidence.
6. Confirm the package contains no symlinks, private paths, secrets, generated
   graph state, or files outside the documented surface.
7. Confirm the README, release status, skill reference, and CLI help agree that
   `setup` is the one-command greenfield and exact predecessor-marker-only
   surface, `bundle` then `adopt --bundle` is the two-command reviewed
   legacy-graph surface,
   lifecycle phases are advanced recovery boundaries, and post-retirement
   `rollback` remains available. Also confirm they agree that `check --changed`
   is foreground-only, first use establishes a baseline rather than freshness,
   exact fingerprints outrank Git hints, only `file`/`module`/`path_glob` are
   automatic, every repair uses exact-bound `propose`/`review`/`apply`, later
   source evolution leaves one cumulative active finding, and policy mismatch
   uses the explicit reasoned rebaseline command.
8. Commit the release, create an annotated tag, and push the branch and tag.
9. Create a GitHub prerelease using the matching changelog entry.
10. Install once from the public GitHub URL with telemetry enabled so skills.sh
   can index the skill.

## Stable release

A stable tag additionally requires every gate in
[`docs/skill/architecture.md`](docs/skill/architecture.md#20-release-acceptance)
and [`docs/release-checklist.md`](docs/release-checklist.md) to pass. Do not
remove the preview label merely because packaging and CI are green.
