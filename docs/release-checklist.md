# Release checklist

## Every preview

- [ ] Package version matches the runtime version.
- [ ] `CHANGELOG.md` and `docs/release-status.md` describe the same capability
      boundary.
- [ ] The installed skill contains only `SKILL.md`, `agents/`, `assets/`,
      `references/`, and `scripts/`.
- [ ] No symlink, junction, secret, private path, generated graph, cache, or
      large binary is present.
- [ ] `npm ci` completes without lifecycle scripts.
- [ ] `npm run check` passes on Node 22 and 24 across Linux, Windows, and macOS.
- [ ] `npm run smoke:install` installs through the pinned Skills CLI into a
      disposable workspace and validates initialization and unpatching.
- [ ] `npm run smoke:adoption` exercises the installed-copy stage, shadow,
      cutover, verify, retire, and post-retirement rollback lifecycle.
- [ ] Install remains inert until the user explicitly initializes a greenfield
      workspace or starts legacy adoption.
- [ ] Greenfield initialization refuses existing knowledge and routes it to the
      adoption workflow.
- [ ] Adoption documentation and runtime help agree on every phase, required
      artifact, dry-run rule, reviewed-attestation option, and rollback state.
- [ ] Cutover and retirement retain legacy source notes, and recovery evidence
      restores exact pre-cutover graph, runtime, and agent bytes.
- [ ] README and skill text label missing capabilities honestly.
- [ ] The release tag is annotated and the GitHub release is marked prerelease.
- [ ] A public-repository install with telemetry enabled has seeded skills.sh.

## Additional stable gate

- [ ] Budgeted context compilation preserves mandatory truth or fails visibly.
- [ ] Governed proposals and canonical writes enforce optimistic concurrency,
      provenance, and recovery.
- [ ] Reviewed v2 promotion staging and application reject incomplete,
      semantically conflicting, stale, and concurrently changed artifacts.
- [ ] Drift detection produces source-grounded stale findings without directly
      rewriting canonical knowledge.
- [ ] Duplicate hubs, accepted decisions, and supersession cycles fail
      validation.
- [ ] Malicious notes cannot trigger commands, network requests, or writes.
- [ ] Ten-thousand-note performance and output-budget acceptance passes.
- [ ] Clean-room Codex, Cursor, and Claude install, activation, upgrade, and
      uninstall flows pass.
- [ ] Every item in the architecture's stable release acceptance section has
      objective evidence.
