# Design workflow

Use this Syncora-owned workflow to turn an accepted direction into a reviewable
product or technical design. Do not implement it.

## Execution

1. Identify the audience and artifact type: product requirements, technical
   design, or a combined feature specification.
2. Establish the problem, user outcome, evidence, constraints, goals,
   non-goals, and measurable success criteria. Ask one blocking question at a
   time only when project evidence cannot resolve it.
3. Describe the current system and the smallest viable change.
4. Compare at least two credible approaches. State when each wins, what it
   sacrifices, and why one is recommended.
5. Specify the relevant design details: user flow, architecture, data flow,
   interfaces, contracts, failure behavior, security, migration,
   observability, testing, rollout, and rollback. Omit irrelevant sections.
6. Self-review for placeholders, contradictions, ambiguity, untestable
   requirements, and excessive scope.

## Output

Put a decision brief of no more than 200 words first. It must contain the
recommendation, material outcome, primary tradeoffs, risks and rollback, and
only genuine open decisions. Follow it with the full optional design artifact.
Never make reading the full artifact the only approval surface.
