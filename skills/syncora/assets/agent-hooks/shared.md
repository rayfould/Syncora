<!-- syncora-agent-hook:begin v3 -->
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
the user the local review-artifact path plus the exact digest bindings, require
inspection of its exact before/after records, record approval only after the
user authorizes that artifact-bound proposal digest, then apply it transactionally.
Never imply background or after-final work, and never bypass the bounded
context compiler or the proposal approval boundary.
<!-- syncora-agent-hook:end v3 -->
