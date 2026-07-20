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
- [ ] `npm run smoke:install` installs globally through the pinned Skills CLI
      into an isolated home, proves the shared canonical target for Codex and
       Cursor, verifies the Claude Code destination, and validates one-command
       setup, context-profile preflight, bounded context compilation, and
       unpatching. Setup output must include the foreground drift-baseline
       disposition.
- [ ] `npm run smoke:adoption` exercises one installed-copy adoption operation:
      bounded summary preview, internally digest-bound final `adopt`, internal stage through
      retirement, and post-retirement rollback.
- [ ] Install remains inert until the user explicitly runs setup (including the
      exact predecessor-marker-only case) or starts legacy graph adoption.
- [ ] Greenfield initialization refuses existing knowledge and routes it to the
      adoption workflow.
- [ ] A workspace with no graph and only the exact supported predecessor marker
      completes through one `setup` command without an empty adoption bundle.
- [ ] A custom or unmarked predecessor with no graph is explicitly removed and
      reviewed before one `setup --confirm-predecessor-reviewed` command.
- [ ] Mixed exact-marker and residual custom predecessor instructions fail
      closed, and `setup --no-patch-agents` cannot bypass review through a later
      `patch-agents` call.
- [ ] Adoption documentation and runtime help agree on bounded reviewed-pack
      summary, the internally digest-bound no-clobber builder, consolidated authorization,
      reviewed-attestation option, resumability, expert phase surface, and
      rollback state.
- [ ] Cutover and retirement retain legacy source notes, and recovery evidence
      restores exact pre-cutover graph, runtime, and agent bytes.
- [ ] Capture documentation, skill routing, runtime help, and release status
      agree that normal `capture` validates, authorizes internally, applies
      transactionally, and never asks whether to save; the full artifact remains
      optional audit detail.
- [ ] Proposal fixtures enforce mandatory prior-state bindings, exact hashes for
      local file/note sources, 256 source references per operation, 512 per
      proposal, and 64 MiB of verified local source bytes.
- [ ] Proposal creation leaves canonical Markdown byte-identical, and apply
      rejects missing, rejected, wrong-digest, stale, or semantically changed
      proposals.
- [ ] Interrupted governed apply resumes the same transaction or restores exact
      prior bytes before irreversible commit; after commit it publishes the
      bound receipt and reaches `finalized` without rolling back canonical
      bytes. Unsafe pre-commit rollback preserves external edits and reports
      recovery required.
- [ ] Documentation and tests distinguish foreground process-interruption
      recovery from unsupported background recovery and from the missing
      Windows power-loss durability guarantee.
- [ ] Concurrent apply tests prove one transient graph-level lifecycle lock
      covers preflight through release, uses a bounded monotonic timeout, and
      supports a later foreground retry after lock contention.
- [ ] Concurrency claims cover Syncora/cooperating writers and byte rechecks,
      without claiming portable compare-and-swap against a noncooperating
      external writer in the final check-and-rename window.
- [ ] README, skill text, CLI help, and drift reference agree that
      `check --changed` is foreground-only; the first observation establishes a
      baseline rather than freshness; exact fingerprints are authoritative;
      and Git supplies advisory hints only.
- [ ] Git and non-Git fixtures prove automatic `file`, `module`, and
      `path_glob` coverage, while untyped, malformed, `symbol`, and `component`
      bindings remain visibly unevaluated and never gain inferred authority.
- [ ] Drift findings remain immutable and zero-authority, contain no note body
      or diff hunk in CLI output, and cannot change canonical Markdown.
- [ ] Drift repairs require a matching active finding, complete resulting note
      text, a matching canonical note snapshot, complete live binding
      fingerprints, internal digest binding, and transactional apply through
      autonomous `capture`.
- [ ] Exact-digest still-current acknowledgment, exact source reversion,
      cumulative finding supersession, explicit reasoned policy rebaseline of
      incompatible retained state, and a matching applied proposal are the only
      finding dispositions; direct note edits and later checks do not silently
      clear active evidence.
- [ ] Policy mismatch reports one exact foreground rebaseline command; the
      command publishes immutable migration evidence and exact active-finding
      dispositions before atomically replacing one workspace shard. Absent or
      already policy-compatible state refuses rebaseline without publishing or
      clearing findings.
- [ ] External-graph tests prove drift state is stored beside the resolved
      graph and sharded by exact workspace identity, with corrupt, future,
      oversized, and identity-mismatched state failing closed.
- [ ] The release tag is annotated and the GitHub release is marked prerelease.
- [ ] A public-repository install with telemetry enabled has seeded skills.sh.

## Additional stable gate

- [ ] Budgeted context compilation preserves mandatory truth or fails visibly.
- [ ] Governed proposals and canonical writes enforce optimistic concurrency,
      provenance, exact review, and recovery.
- [ ] Reviewed v2 promotion staging and application reject incomplete,
      semantically conflicting, stale, and concurrently changed artifacts.
- [ ] Drift detection produces bounded, source-grounded, zero-authority stale
      findings without directly rewriting canonical knowledge, and adversarial
      race, symlink/junction, rename, deletion, output-limit, and state-recovery
      fixtures pass on the supported platform matrix.
- [ ] Duplicate hubs, accepted decisions, and supersession cycles fail
      validation.
- [ ] Malicious notes cannot trigger commands, network requests, or writes.
- [ ] Ten-thousand-note performance and output-budget acceptance passes.
- [ ] Clean-room Codex, Cursor, and Claude install, activation, upgrade, and
      uninstall flows pass.
- [ ] A representative existing graph completes reviewed adoption, live
      instruction cutover, retirement, and exact rollback evidence without note
      loss.
- [ ] External and hosted predecessor sources are reconciled before any
      database or predecessor system is declared retired.
- [ ] Every item in the architecture's stable release acceptance section has
      objective evidence.
