<!-- syncora-agent-hook:begin v6 -->
## Syncora

Syncora being installed does not make every request a Syncora task. Skip it for
self-contained work unrelated to project state. When this project is
initialized with `.syncora/config.json`, use the installed `syncora` skill for
project-dependent or plausibly project-relevant work and run its pre-work
checkpoint unless the selected maintenance command supplies the equivalent
lifecycle. Without initialization, ordinary work stays inactive; only an
explicit initialization, adoption, or diagnostic request may enter Syncora.
Run the paired post-work checkpoint only before the final response and only
when canonical Syncora knowledge changed or an
authority-changing operation completed. Outside setup and adoption, never edit
canonical graph Markdown directly. When durable project knowledge should
change, use non-dry Syncora `capture`; it validates, internally authorizes, and
applies the exact transaction automatically. Never ask whether to save Syncora
memory, and never expose its proposal or artifact digests. Mention the saved
result only when useful.
After substantive project-source mutation, run the foreground
`check --changed` operation before deciding whether durable knowledge capture
is needed. A drift finding proves only potential staleness: inspect its local
evidence, author complete replacement note text when repair is warranted, and
route that exact repair through autonomous `capture` with drift provenance. If
the correct project truth is unclear, ask about that truth rather than asking
whether to save. An exact-digest acknowledgment may close a harmless finding without a
Markdown edit. Do not run drift checks for `none` routes, on every turn, or as
background work; component and symbol bindings remain unevaluated unless a
versioned symbol index exists.
Syncora runs quietly during the active request; never imply a separate daemon
or after-final work, and never bypass the bounded context compiler or
transactional capture boundary.
<!-- syncora-agent-hook:end v6 -->
