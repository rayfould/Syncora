<!-- syncora-agent-hook:begin v5 -->
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
change, use Syncora's governed capture flow: prepare an immutable proposal, give
the user its bounded plain-language approval summary, and ask only whether to
save it. Keep exact proposal and artifact digests internal. Offer the full local
review artifact only when the user asks for details. After a plain Yes,
Approved, or No response, bind that decision to the exact sealed proposal
internally; apply it transactionally only after approval.
After substantive project-source mutation, run the foreground
`check --changed` operation before deciding whether durable knowledge capture
is needed. A drift finding proves only potential staleness: inspect its local
evidence, author complete replacement note text when repair is warranted, and
route that exact repair through `propose`, artifact review, `review`, and
`apply`. Present the bounded repair summary for approval; keep exact digest
bindings internal. An exact-digest acknowledgment may close a harmless finding without a
Markdown edit. Do not run drift checks for `none` routes, on every turn, or as
background work; component and symbol bindings remain unevaluated unless a
versioned symbol index exists.
Never imply background or after-final work, and never bypass the bounded
context compiler or the proposal approval boundary.
<!-- syncora-agent-hook:end v5 -->
