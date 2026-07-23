# User decision boundaries

Read this reference whenever the agent is about to pause for a proposal,
confirmation, approval, or clarifying question. Optimize for forward progress.
An internal Syncora proposal is an integrity artifact, not a request for user
permission.

## Continue without asking

Proceed when the user has already requested the outcome and the next action is
within that scope, including:

- ordinary implementation, editing, testing, diagnosis, repair, setup, update,
  removal, or adoption that the user requested;
- reversible local work and routine project-file changes;
- validated Syncora capture, drift repair after the project truth is known, and
  other Syncora-owned maintenance;
- a large diff or many touched files when that size is a natural consequence of
  the authorized work and a reliable rollback path exists.

Do not ask merely because a change is durable, a note is important, a diff is
long, many files are involved, validation takes time, or Syncora created an
internal proposal. Conversational instructions such as "implement", "fix",
"update", "proceed", and "finish" authorize the ordinary in-scope work needed
to reach that outcome. The agent may use an internal plan without asking the
user to approve it.

## Pause only for a real user decision

Ask one focused question only when progress requires a choice the user has not
already made:

1. The user asked only for a plan, proposal, design, review, or audit, so
   implementation was not authorized. Deliver the requested artifact; do not
   silently implement it.
2. The request is materially ambiguous, contradictory, or appears not to make
   sense, and reasonable interpretations would produce meaningfully different
   outcomes.
3. Multiple viable options would materially change product behavior, scope,
   cost, ownership, or another outcome the user should choose.
4. The next action is destructive or difficult to reverse, affects an unusually
   large share of user or business data, and the exact scope was not clearly
   authorized. Size alone is not enough; the combination of blast radius,
   weak rollback, and missing authorization creates the boundary.
5. The next action would create an external effect the user did not authorize,
   such as publishing, deploying to production, sending to other people,
   spending money, or deleting remote data.
6. The agent host or operating environment requires permission that the skill
   cannot grant.

Explicit authorization for the exact high-impact action normally resolves the
boundary. Do not ask twice simply because the implementation is large.

## Make long artifacts decision-ready

When a plan, specification, design, review, or audit is long enough that reading
the complete artifact would burden the user, never make the full document the
only basis for approval. Keep it available as optional detail, but place a
`Decision brief` of no more than 200 words in the conversational response before
asking whether to implement.

Use this compact structure:

- **Recommendation:** one sentence naming the preferred approach.
- **Outcome:** two to four bullets describing what materially changes.
- **Tradeoffs:** the main upside and downside. If the user must choose among
  viable approaches, show at most three options with one-line pros and cons and
  still recommend one.
- **Risks and rollback:** the material failure mode, blast radius, and whether
  the change is reversible.
- **Open decisions:** only choices that genuinely require the user; write
  `None` when the spec contains no unresolved choice.

End with one precise approval question such as `Proceed with the recommended
approach?` Do not make `Please review the full spec and say proceed` the only
approval surface. Do not repeat file inventories, step-by-step implementation
details, or the complete test plan in the brief; link the detailed artifact for
optional inspection.

## How to ask

- Ask about the underlying project choice, risk, or external action. Never ask
  whether Syncora should save or update its memory.
- State the concrete uncertainty or consequence in one to three sentences, then
  ask one short question. Offer two or three choices only when they make the
  decision easier.
- Continue any safe, reversible work that does not depend on the answer before
  asking about the remaining blocker.
- After the user decides, resume the authorized work and capture resulting
  durable knowledge automatically. Do not add a second memory confirmation.
