# Releasing Syncora

Syncora uses semantic versions. Preview tags use the form
`vMAJOR.MINOR.PATCH-preview.N` and must be published as GitHub prereleases.

## Preview release

1. Update the version in `package.json` and
   `skills/syncora/scripts/lib/cli.mjs`.
2. Update `CHANGELOG.md` and `docs/release-status.md`.
3. Run `npm ci` and `npm run check` on a clean tree.
4. Run `npm run smoke:install` with network access.
5. Confirm the package contains no symlinks, private paths, secrets, generated
   graph state, or files outside the documented surface.
6. Commit the release, create an annotated tag, and push the branch and tag.
7. Create a GitHub prerelease using the matching changelog entry.
8. Install once from the public GitHub URL with telemetry enabled so skills.sh
   can index the skill.

## Stable release

A stable tag additionally requires every gate in
[`docs/skill/architecture.md`](docs/skill/architecture.md#20-release-acceptance)
and [`docs/release-checklist.md`](docs/release-checklist.md) to pass. Do not
remove the preview label merely because packaging and CI are green.
